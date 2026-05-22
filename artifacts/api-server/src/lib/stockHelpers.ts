import { db } from "@workspace/db";
import { stockBalanceTable, stockLedgerTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";

// ─── PHASE E — FIFO/FEFO BATCH PICKING ───────────────────────────────────────
// `BatchPick` represents one allocation against a single batch on an outbound
// movement (production issue, sales delivery, etc.). The caller writes one
// `stock_ledger` row per pick and the total `qty`/`costPrice * qty` aggregates
// must match the requested issue quantity & cost. Callers that don't need
// batch granularity (legacy items with `batch_tracking_mode='none'`) keep
// using `getBalance`/`upsertBalance` + a single ledger row as before.
export interface BatchPick {
  batchNumber: string | null; // NULL = the "unbatched bucket" (legacy inbound rows w/o batch)
  expiryDate: string | null;
  remaining: number;          // available before this pick
  takeQty: number;            // qty pulled by this pick (positive)
  costPrice: number;          // weighted-avg of the original receipts for this batch
}

// Build a per-batch remaining-qty + cost map for a given (company, item,
// warehouse) by aggregating stock_ledger. Returns rows where remaining > 0.
// Each "batch" is keyed by batch_number (NULL is a valid bucket — it groups
// every historical movement that wasn't stamped with a batch, so we can
// gracefully consume legacy inventory before the tracked batches).
//
// Ordering inside SQL is intentional:
//   - fefo: NULLS LAST on expiry, then earliest tx_date (oldest first)
//   - fifo: earliest tx_date first (NULLS LAST so unbatched is last resort)
// Tie-breaker: batch_number ASC so the order is deterministic across calls.
export async function readBatchRemaining(
  companyId: number,
  itemId: number,
  warehouseId: number,
  mode: "fifo" | "fefo",
): Promise<Array<{
  batchNumber: string | null;
  expiryDate: string | null;
  remaining: number;
  inboundQty: number;
  inboundCost: number;
  earliestInDate: string | null;
}>> {
  // Aggregate per batch_number: SUM(qty) and SUM(positive*cost) so we can
  // derive an avg cost for what's left in that batch. Earliest inbound
  // tx_date is used to break FEFO ties (and is FIFO's primary key).
  // Group by (batch_number, expiry_date) so the same code received with two
  // different expiries forms two independent lots — required for FEFO
  // correctness when messy real-world data has mismatched expiries on the
  // same batch label.
  const rows = await db.execute(sql`
    SELECT
      batch_number                                                    AS "batchNumber",
      expiry_date                                                     AS "expiryDate",
      SUM(qty)::numeric                                               AS "remaining",
      SUM(CASE WHEN qty > 0 THEN qty ELSE 0 END)::numeric             AS "inboundQty",
      SUM(CASE WHEN qty > 0 THEN qty * cost_price ELSE 0 END)::numeric AS "inboundCost",
      MIN(CASE WHEN qty > 0 THEN tx_date END)                         AS "earliestInDate"
    FROM stock_ledger
    WHERE company_id = ${companyId}
      AND item_id    = ${itemId}
      AND warehouse_id = ${warehouseId}
    GROUP BY batch_number, expiry_date
    HAVING SUM(qty) > 0.0001
    ORDER BY
      ${mode === "fefo" ? sql`expiry_date ASC NULLS LAST,` : sql``}
      MIN(CASE WHEN qty > 0 THEN tx_date END) ASC NULLS LAST,
      batch_number ASC NULLS LAST
  `);
  // drizzle's db.execute returns { rows: [...] } for pg
  const list = (rows as any).rows ?? (rows as any);
  return (list as any[]).map((r) => ({
    batchNumber: r.batchNumber ?? null,
    expiryDate: r.expiryDate ?? null,
    remaining: Number(r.remaining),
    inboundQty: Number(r.inboundQty),
    inboundCost: Number(r.inboundCost),
    earliestInDate: r.earliestInDate ?? null,
  }));
}

// Allocate `requestedQty` across available batches in the requested mode.
// Returns the per-batch picks; total of picks[].takeQty equals requestedQty
// when there's enough stock. Throws when there isn't (caller validates
// up-front via getBalance, but we double-check here for safety).
export async function pickBatches(
  companyId: number,
  itemId: number,
  warehouseId: number,
  requestedQty: number,
  mode: "fifo" | "fefo",
): Promise<BatchPick[]> {
  if (requestedQty <= 0) return [];
  const batches = await readBatchRemaining(companyId, itemId, warehouseId, mode);
  const picks: BatchPick[] = [];
  let remaining = requestedQty;
  for (const b of batches) {
    if (remaining <= 0.0001) break;
    const take = Math.min(b.remaining, remaining);
    // Weighted-average inbound cost for the batch (falls back to 0 when
    // every inbound row was zero — e.g. opening balance with no cost).
    const cost = b.inboundQty > 0 ? b.inboundCost / b.inboundQty : 0;
    picks.push({
      batchNumber: b.batchNumber,
      expiryDate: b.expiryDate,
      remaining: b.remaining,
      takeQty: take,
      costPrice: cost,
    });
    remaining -= take;
  }
  if (remaining > 0.0001) {
    throw new Error(
      `الكمية المتاحة عبر التشغيلات لا تكفي. مطلوب ${requestedQty}، متاح ${requestedQty - remaining}.`,
    );
  }
  return picks;
}

export async function getBalance(companyId: number, itemId: number, warehouseId: number): Promise<number> {
  const [bal] = await db.select().from(stockBalanceTable).where(
    and(
      eq(stockBalanceTable.companyId, companyId),
      eq(stockBalanceTable.itemId, itemId),
      eq(stockBalanceTable.warehouseId, warehouseId)
    )
  );
  return Number(bal?.qty ?? 0);
}

export async function upsertBalance(
  companyId: number,
  itemId: number,
  warehouseId: number,
  deltaQty: number,
  costPrice: number
) {
  const [existing] = await db.select().from(stockBalanceTable).where(
    and(
      eq(stockBalanceTable.companyId, companyId),
      eq(stockBalanceTable.itemId, itemId),
      eq(stockBalanceTable.warehouseId, warehouseId)
    )
  );
  if (!existing) {
    await db.insert(stockBalanceTable).values({
      companyId, itemId, warehouseId,
      qty: String(deltaQty),
      avgCost: String(costPrice),
    });
  } else {
    const oldQty  = Number(existing.qty);
    const oldCost = Number(existing.avgCost);
    let newQty: number, newAvg: number;
    if (deltaQty > 0) {
      newQty = oldQty + deltaQty;
      newAvg = newQty === 0 ? costPrice : (oldQty * oldCost + deltaQty * costPrice) / newQty;
    } else {
      newQty = oldQty + deltaQty;
      newAvg = oldCost;
    }
    await db.update(stockBalanceTable)
      .set({ qty: String(newQty), avgCost: String(newAvg), updatedAt: new Date() })
      .where(eq(stockBalanceTable.id, existing.id));
  }
}

export async function addStockLedgerEntry(entry: {
  companyId: number;
  itemId: number;
  warehouseId: number;
  txDate: string;
  txType: typeof stockLedgerTable.$inferInsert.txType;
  qty: string;
  costPrice: string;
  totalCost: string;
  balanceQty: string;
  refId: number;
  refType: string;
  batchNumber?: string | null;
  expiryDate?: string | null;
  notes?: string;
}) {
  await db.insert(stockLedgerTable).values(entry);
}
