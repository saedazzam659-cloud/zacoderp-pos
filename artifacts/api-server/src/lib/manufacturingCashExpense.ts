import { and, eq, sql } from "drizzle-orm";
import { accountsTable, productionCostAllocationsTable, productionOrdersTable, productionOverheadClosuresTable } from "@workspace/db";

/** Only standalone direct expenses may be additional manufacturing sources. */
export async function manufacturingCashExpenseFields(q: any, companyId: number, body: any) {
  const eligible = body.manufacturingEligible === true;
  const method = body.manufacturingAllocationMethod ?? "labor_hours";
  if (!["labor_hours", "production_quantity"].includes(method))
    throw Object.assign(new Error("أساس توزيع مصروف التصنيع غير صحيح"), { status: 400 });
  const hours = Number(body.approvedManufacturingHours);
  const quantity = Number(body.approvedProductionQuantity);
  if (eligible) {
    if (body.entityId || body.purchaseInvoiceId || body.lines?.length || body.invoiceAllocations?.length || !body.accountId)
      throw Object.assign(new Error("تأهيل التصنيع متاح لسند مصروف مباشر على حساب مصروف فقط، وليس لسداد الفواتير أو السندات متعددة البنود"), { status: 400 });
    const [account] = await q.select({ id: accountsTable.id }).from(accountsTable).where(and(
      eq(accountsTable.id, Number(body.accountId)), eq(accountsTable.companyId, companyId),
      eq(accountsTable.accountType, "expense"), eq(accountsTable.isPosting, true), eq(accountsTable.isActive, true),
    ));
    if (!account) throw Object.assign(new Error("اختر حساب مصروف نشطاً وقابلاً للترحيل لتأهيل التصنيع"), { status: 400 });
    const driver = method === "labor_hours" ? hours : quantity;
    if (!Number.isFinite(driver) || driver <= 0)
      throw Object.assign(new Error("أدخل إجمالي محرك توزيع التصنيع المعتمد للشهر"), { status: 400 });
  }
  return {
    manufacturingEligible: eligible,
    manufacturingAllocationMethod: method,
    approvedManufacturingHours: eligible && method === "labor_hours" ? String(hours) : null,
    approvedProductionQuantity: eligible && method === "production_quantity" ? String(quantity) : null,
  };
}

/** Same lock order as allocation and period closure; zero baselines count as use. */
export async function assertManufacturingCashExpenseReversible(tx: any, companyId: number, voucherId: number) {
  await tx.execute(sql`select pg_advisory_xact_lock(${companyId}, hashtext('production_overhead_closure_mutation'))`);
  await tx.execute(sql`select pg_advisory_xact_lock(${companyId}, hashtext(${`cash_expense:${voucherId}`}))`);
  const [used] = await tx.select({ id: productionCostAllocationsTable.id })
    .from(productionCostAllocationsTable).innerJoin(productionOrdersTable, and(
      eq(productionOrdersTable.id, productionCostAllocationsTable.orderId),
      eq(productionOrdersTable.companyId, companyId),
    )).where(and(
      eq(productionCostAllocationsTable.companyId, companyId),
      eq(productionCostAllocationsTable.sourceType, "cash_expense"),
      eq(productionCostAllocationsTable.sourceRecordId, voucherId),
      sql`${productionOrdersTable.status} NOT IN ('cancelled', 'reversed')`,
    )).limit(1);
  const closures = await tx.select({ snapshot: productionOverheadClosuresTable.sourceSnapshot })
    .from(productionOverheadClosuresTable).where(eq(productionOverheadClosuresTable.companyId, companyId));
  const frozen = closures.some((row: any) => Array.isArray(row.snapshot) &&
    row.snapshot.some((source: any) => source.sourceType === "cash_expense" && Number(source.sourceRecordId) === voucherId));
  if (used || frozen)
    throw Object.assign(new Error("لا يمكن إلغاء سند المصروف أو فك ترحيله بعد تخصيصه للتصنيع أو إغلاق فترته؛ اعكس استخدامه أولاً"), { status: 409 });
}
