import { db } from "@workspace/db";
import { stockBalanceTable, stockLedgerTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

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
  txType: string;
  qty: string;
  costPrice: string;
  totalCost: string;
  balanceQty: string;
  refId: number;
  refType: string;
  notes?: string;
}) {
  await db.insert(stockLedgerTable).values(entry);
}
