import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  productionCostAllocationsTable, productionOrdersTable, productionOverheadClosuresTable,
  purchaseInvoiceLinesTable, employeeProvisionSettlementsTable, journalEntriesTable,
} from "@workspace/db";
export { netProvisionSourceAmount } from "./hrProvisionMath.js";

export type ProvisionExpenseSnapshot = {
  sourceJournalId: number;
  expenseAccountId: number;
  liabilityAccountId?: number;
  branchId?: number | null;
  sourceExpenseAmount: number;
  expensePayrollRunId?: number;
  manufacturingOffsetAmount: number;
  expenseParts: Array<{ costCenter: string | null; amount: number }>;
  purchaseLineOffsets?: Array<{ lineId: number; amount: number }>;
};

/** Never change a capacity snapshot already consumed by manufacturing. */
export async function assertProvisionManufacturingWritable(
  q: any, companyId: number, sourceType: string, sourceId: number,
) {
  let type = sourceType === "payment_voucher" ? "cash_expense" : sourceType;
  let ids = [sourceId];
  if (sourceType === "purchase_invoice") {
    const lines = await q.select({ id: purchaseInvoiceLinesTable.id }).from(purchaseInvoiceLinesTable)
      .where(eq(purchaseInvoiceLinesTable.invoiceId, sourceId));
    ids = lines.map((line: any) => Number(line.id));
  }
  if (!ids.length) return;
  const [use] = await q.select({ id: productionCostAllocationsTable.id })
    .from(productionCostAllocationsTable).innerJoin(productionOrdersTable, and(
      eq(productionOrdersTable.id, productionCostAllocationsTable.orderId),
      eq(productionOrdersTable.companyId, companyId),
    )).where(and(
      eq(productionCostAllocationsTable.companyId, companyId),
      eq(productionCostAllocationsTable.sourceType, type),
      inArray(productionCostAllocationsTable.sourceRecordId, ids),
      sql`${productionOrdersTable.status} NOT IN ('cancelled', 'reversed')`,
    )).limit(1);
  const closures = await q.select({ snapshot: productionOverheadClosuresTable.sourceSnapshot })
    .from(productionOverheadClosuresTable).where(eq(productionOverheadClosuresTable.companyId, companyId));
  const frozen = closures.some((row: any) => Array.isArray(row.snapshot) && row.snapshot.some((source: any) =>
    source.sourceType === type && ids.includes(Number(source.sourceRecordId))));
  if (use || frozen)
    throw Object.assign(new Error("اعكس تخصيص تكلفة التصنيع أو عالج إغلاق الفترة أولاً قبل إنشاء تسوية المخصص أو عكسها"), { status: 409 });
}

/** A missing snapshot is not evidence that a historical cost is zero. */
export async function postedProvisionOffsets(q: any, companyId: number, sourceJournalIds: number[]) {
  if (!sourceJournalIds.length) return [];
  const rows = await q.select({
    id: employeeProvisionSettlementsTable.id,
    sourceType: employeeProvisionSettlementsTable.sourceType,
    sourceRecordId: employeeProvisionSettlementsTable.sourceRecordId,
    amount: employeeProvisionSettlementsTable.amount,
    snapshot: employeeProvisionSettlementsTable.sourceSnapshot,
  }).from(employeeProvisionSettlementsTable).innerJoin(journalEntriesTable, and(
    eq(journalEntriesTable.id, employeeProvisionSettlementsTable.journalEntryId),
    eq(journalEntriesTable.companyId, companyId), eq(journalEntriesTable.status, "posted"),
  )).where(and(eq(employeeProvisionSettlementsTable.companyId, companyId),
    eq(employeeProvisionSettlementsTable.status, "posted"),
    or(sql`${employeeProvisionSettlementsTable.sourceSnapshot}->>'sourceJournalId' IS NULL`,
      inArray(sql<string>`${employeeProvisionSettlementsTable.sourceSnapshot}->>'sourceJournalId'`,
        sourceJournalIds.map(String)))));
  return rows.map((row: any) => {
    const snapshot = row.snapshot as ProvisionExpenseSnapshot | null;
    if (!snapshot || !Number.isInteger(snapshot.sourceJournalId) || snapshot.sourceJournalId <= 0 ||
        !Number.isInteger(snapshot.expenseAccountId) || snapshot.expenseAccountId <= 0 ||
        !Number.isFinite(snapshot.sourceExpenseAmount) || snapshot.sourceExpenseAmount <= 0 ||
        !Number.isFinite(snapshot.manufacturingOffsetAmount) || snapshot.manufacturingOffsetAmount < 0 ||
        snapshot.manufacturingOffsetAmount > Number(row.amount) + 0.005 ||
        (row.sourceType === "employee_leave" && (!Number.isInteger(snapshot.expensePayrollRunId) || Number(snapshot.expensePayrollRunId) <= 0)) ||
        (row.sourceType === "purchase_invoice" && (!Array.isArray(snapshot.purchaseLineOffsets) ||
          snapshot.purchaseLineOffsets.some(part => !Number.isInteger(part.lineId) || part.lineId <= 0 ||
            !Number.isFinite(part.amount) || part.amount < 0) ||
          snapshot.purchaseLineOffsets.reduce((sum, part) => sum + part.amount, 0) > Number(row.amount) + 0.005)))
      throw Object.assign(new Error(`تسوية المخصص ${row.id} لا تحتوي على لقطة مصدر تكلفة كاملة؛ تعذّر احتساب صافي التصنيع`), { status: 409 });
    return { ...row, snapshot };
  });
}

