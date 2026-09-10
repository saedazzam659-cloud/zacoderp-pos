import { db } from "@workspace/db";
import { stockBalanceTable, stockLedgerTable, itemsTable } from "@workspace/db";
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

export interface BatchRemaining {
  batchNumber: string | null;
  expiryDate: string | null;
  remaining: number;
  inboundQty: number;
  inboundCost: number;
  earliestInDate: string | null;
}

export interface BatchReadRequest {
  itemId: number;
  warehouseId: number;
  mode: "fifo" | "fefo";
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
// `executor` defaults to the top-level `db`. Pass a drizzle `PgTransaction`
// (from `db.transaction(async (tx) => …)`) when batch picking must be
// transactional with surrounding writes — required so that pre-pick reads
// see the same snapshot as the subsequent ledger/balance writes inside the
// same tx, and so the read is logically inside the same SQL transaction.
export async function readBatchRemaining(
  companyId: number,
  itemId: number,
  warehouseId: number,
  mode: "fifo" | "fefo",
  executor: any = db,
): Promise<BatchRemaining[]> {
  // Aggregate per batch_number: SUM(qty) and SUM(positive*cost) so we can
  // derive an avg cost for what's left in that batch. Earliest inbound
  // tx_date is used to break FEFO ties (and is FIFO's primary key).
  // Group by (batch_number, expiry_date) so the same code received with two
  // different expiries forms two independent lots — required for FEFO
  // correctness when messy real-world data has mismatched expiries on the
  // same batch label.
  const rows = await executor.execute(sql`
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

// Read every requested item/warehouse batch plan in ONE query. Remote agent
// databases magnify each round trip, so calling readBatchRemaining once per
// invoice line makes posting latency grow linearly with the number of tracked
// items. The result retains an independently ordered list per pair: FEFO sorts
// expiry first, FIFO sorts receipt date first.
export async function readBatchRemainingBulk(
  companyId: number,
  requests: BatchReadRequest[],
  executor: any = db,
): Promise<Map<string, BatchRemaining[]>> {
  const unique = new Map<string, BatchReadRequest>();
  for (const request of requests) {
    if (!Number.isInteger(request.itemId) || !Number.isInteger(request.warehouseId)) continue;
    unique.set(`${request.itemId}:${request.warehouseId}`, request);
  }
  const out = new Map<string, BatchRemaining[]>();
  if (!unique.size) return out;

  const tuples = [...unique.values()].map((request) => sql`
    (${request.itemId}::integer, ${request.warehouseId}::integer, ${request.mode}::text)
  `);
  const result = await executor.execute(sql`
    WITH requested(item_id, warehouse_id, mode) AS (
      VALUES ${sql.join(tuples, sql`, `)}
    )
    SELECT
      requested.item_id                                               AS "itemId",
      requested.warehouse_id                                          AS "warehouseId",
      stock_ledger.batch_number                                       AS "batchNumber",
      stock_ledger.expiry_date                                        AS "expiryDate",
      SUM(stock_ledger.qty)::numeric                                  AS "remaining",
      SUM(CASE WHEN stock_ledger.qty > 0 THEN stock_ledger.qty ELSE 0 END)::numeric
                                                                        AS "inboundQty",
      SUM(CASE WHEN stock_ledger.qty > 0
               THEN stock_ledger.qty * stock_ledger.cost_price ELSE 0 END)::numeric
                                                                        AS "inboundCost",
      MIN(CASE WHEN stock_ledger.qty > 0 THEN stock_ledger.tx_date END) AS "earliestInDate",
      requested.mode                                                   AS "mode"
    FROM requested
    JOIN stock_ledger
      ON stock_ledger.company_id = ${companyId}
     AND stock_ledger.item_id = requested.item_id
     AND stock_ledger.warehouse_id = requested.warehouse_id
    GROUP BY
      requested.item_id,
      requested.warehouse_id,
      requested.mode,
      stock_ledger.batch_number,
      stock_ledger.expiry_date
    HAVING SUM(stock_ledger.qty) > 0.0001
    ORDER BY
      requested.item_id,
      requested.warehouse_id,
      CASE WHEN requested.mode = 'fefo' THEN stock_ledger.expiry_date END ASC NULLS LAST,
      MIN(CASE WHEN stock_ledger.qty > 0 THEN stock_ledger.tx_date END) ASC NULLS LAST,
      stock_ledger.batch_number ASC NULLS LAST
  `);
  const rows = (result as any).rows ?? (result as any);
  for (const row of rows as any[]) {
    const key = `${Number(row.itemId)}:${Number(row.warehouseId)}`;
    const bucket: BatchRemaining = {
      batchNumber: row.batchNumber ?? null,
      expiryDate: row.expiryDate ?? null,
      remaining: Number(row.remaining),
      inboundQty: Number(row.inboundQty),
      inboundCost: Number(row.inboundCost),
      earliestInDate: row.earliestInDate ?? null,
    };
    const list = out.get(key);
    if (list) list.push(bucket);
    else out.set(key, [bucket]);
  }
  return out;
}

// Allocates from (and mutates) a preloaded pair plan. Mutating remaining is
// deliberate: multiple invoice lines for the same item/warehouse must consume
// each lot only once instead of repeatedly selecting the same database rows.
export function allocateBatchPicks(
  batches: BatchRemaining[],
  requestedQty: number,
): BatchPick[] {
  if (requestedQty <= 0) return [];
  const picks: BatchPick[] = [];
  let remaining = requestedQty;
  for (const batch of batches) {
    if (remaining <= 0.0001) break;
    if (batch.remaining <= 0.0001) continue;
    const take = Math.min(batch.remaining, remaining);
    const cost = batch.inboundQty > 0 ? batch.inboundCost / batch.inboundQty : 0;
    picks.push({
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      remaining: batch.remaining,
      takeQty: take,
      costPrice: cost,
    });
    batch.remaining -= take;
    remaining -= take;
  }
  if (remaining > 0.0001) {
    throw new Error(
      `الكمية المتاحة عبر التشغيلات لا تكفي. مطلوب ${requestedQty}، متاح ${requestedQty - remaining}.`,
    );
  }
  return picks;
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
  executor: any = db,
): Promise<BatchPick[]> {
  if (requestedQty <= 0) return [];
  const batches = await readBatchRemaining(companyId, itemId, warehouseId, mode, executor);
  return allocateBatchPicks(batches, requestedQty);
}

export async function getBalance(
  companyId: number,
  itemId: number,
  warehouseId: number,
  executor: any = db,
): Promise<number> {
  const [bal] = await executor.select().from(stockBalanceTable).where(
    and(
      eq(stockBalanceTable.companyId, companyId),
      eq(stockBalanceTable.itemId, itemId),
      eq(stockBalanceTable.warehouseId, warehouseId)
    )
  );
  return Number(bal?.qty ?? 0);
}

export async function lockStockBalance(
  companyId: number,
  itemId: number,
  warehouseId: number,
  executor: any,
): Promise<void> {
  await executor.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${`stock:${companyId}:${itemId}:${warehouseId}`})
    )
  `);
}

export async function lockStockBalances(
  keys: Array<{ companyId: number; itemId: number; warehouseId: number }>,
  executor: any,
): Promise<void> {
  const unique = new Map<string, { companyId: number; itemId: number; warehouseId: number }>();
  for (const key of keys) unique.set(`${key.companyId}:${key.itemId}:${key.warehouseId}`, key);
  const ordered = Array.from(unique.values()).sort(
    (a, b) => a.companyId - b.companyId || a.itemId - b.itemId || a.warehouseId - b.warehouseId,
  );
  for (const key of ordered) {
    await lockStockBalance(key.companyId, key.itemId, key.warehouseId, executor);
  }
}

export async function upsertBalance(
  companyId: number,
  itemId: number,
  warehouseId: number,
  deltaQty: number,
  costPrice: number,
  executor: any = db,
): Promise<number> {
  // Legacy callers that do not already own a transaction still need the
  // advisory lock to span the complete read-modify-write operation.
  if (executor === db) {
    return db.transaction((tx: any) =>
      upsertBalance(companyId, itemId, warehouseId, deltaQty, costPrice, tx),
    );
  }
  // Serialize every mutation of one (tenant,item,warehouse) bucket.  All
  // document-posting callers pass their transaction here, so the lock lives
  // until the whole ledger/balance/JE/status operation commits.
  await lockStockBalance(companyId, itemId, warehouseId, executor);
  const [existing] = await executor.select().from(stockBalanceTable).where(
    and(
      eq(stockBalanceTable.companyId, companyId),
      eq(stockBalanceTable.itemId, itemId),
      eq(stockBalanceTable.warehouseId, warehouseId)
    )
  );
  if (!existing) {
    await executor.insert(stockBalanceTable).values({
      companyId, itemId, warehouseId,
      qty: String(deltaQty),
      avgCost: String(costPrice),
    });
    return deltaQty;
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
    await executor.update(stockBalanceTable)
      .set({ qty: String(newQty), avgCost: String(newAvg), updatedAt: new Date() })
      .where(eq(stockBalanceTable.id, existing.id));
    return newQty;
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
}, executor: any = db) {
  await executor.insert(stockLedgerTable).values(entry);
}

// ─── ITEM-MASTER COST WRITE-BACK ─────────────────────────────────────────────
// `stock_balance` holds the per-warehouse weighted-average cost, but the الأصناف
// (items) grid displays a single `items.cost_price` that nothing updated after a
// purchase/GRN. This recomputes the COMPANY-WIDE weighted-average cost across all
// warehouses for one item and writes it back to `items.cost_price`, so the item
// master reflects the latest landed cost after every inflow.
//
// • Company-wide WAC = SUM(qty * avg_cost) / SUM(qty) over every warehouse row.
// • When total qty is ≤ 0 (everything out of stock) we keep the last known cost
//   rather than zeroing it, so costing/reports don't lose the figure.
// Pass the surrounding transaction as `executor` when called inside `/post`.
export async function refreshItemCost(
  companyId: number,
  itemId: number,
  executor: any = db,
): Promise<void> {
  const [agg] = await executor
    .select({
      totalQty: sql<string>`COALESCE(SUM(${stockBalanceTable.qty}), 0)`,
      totalVal: sql<string>`COALESCE(SUM(${stockBalanceTable.qty} * ${stockBalanceTable.avgCost}), 0)`,
    })
    .from(stockBalanceTable)
    .where(and(
      eq(stockBalanceTable.companyId, companyId),
      eq(stockBalanceTable.itemId, itemId),
    ));
  const totalQty = Number(agg?.totalQty ?? 0);
  const totalVal = Number(agg?.totalVal ?? 0);
  if (totalQty <= 0) return;
  const wac = totalVal / totalQty;
  await executor
    .update(itemsTable)
    .set({ costPrice: String(wac.toFixed(4)), updatedAt: new Date() })
    .where(and(
      eq(itemsTable.id, itemId),
      eq(itemsTable.companyId, companyId),
    ));
}
