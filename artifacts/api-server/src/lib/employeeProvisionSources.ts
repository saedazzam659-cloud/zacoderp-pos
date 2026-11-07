import { and, eq, sql } from "drizzle-orm";
import type { RequestHandler } from "express";
import {
  db,
  employeeProvisionSettlementsTable, journalEntriesTable, journalEntryLinesTable,
  paymentVouchersTable, purchaseInvoicesTable, purchaseReturnsTable,
  payrollRunsTable, payrollLinesTable, payrollAllocationSnapshotsTable,
} from "@workspace/db";
import { splitProvisionMoney } from "./hrProvisionMath.js";
import type { ProvisionExpenseSnapshot } from "./employeeProvisionManufacturing.js";
import { getPostedIndustrialPurchaseCosts } from "./industrialPurchaseCosts.js";
import { resolveCompanyId } from "../middleware/auth.js";
import { withDocumentMutationLock } from "./document-mutation-lock.js";

export type TicketProvisionSource = "payment_voucher" | "purchase_invoice";

/** Returns and settlements must share the original invoice's lifecycle lock. */
export function provisionPurchaseReturnLock(handler: RequestHandler): RequestHandler {
  return async (req, res, next) => {
    try {
      const cid = resolveCompanyId(req);
      const id = Number(req.params.id);
      if (!cid || !Number.isSafeInteger(id) || id <= 0) return handler(req, res, next);
      const [document] = await db.select({ invoiceId: purchaseReturnsTable.invoiceId }).from(purchaseReturnsTable)
        .where(and(eq(purchaseReturnsTable.id, id), eq(purchaseReturnsTable.companyId, cid)));
      if (!document?.invoiceId) return handler(req, res, next);
      return await withDocumentMutationLock("purchase_invoice", cid, document.invoiceId, async () => {
        await assertProvisionSourceReversible(db, cid, "purchase_invoice", document.invoiceId!);
        return handler(req, res, next);
      });
    } catch (error: any) {
      res.status(error?.status ?? 409).json({ error: error?.message ?? "تعذر التحقق من تسويات الفاتورة" });
    }
  };
}

/** Call while holding the source document's lifecycle lock. */
export async function assertProvisionSourceReversible(q: any, companyId: number, sourceType: string, sourceId: number) {
  const [claim] = await q.select({ id: employeeProvisionSettlementsTable.id })
    .from(employeeProvisionSettlementsTable).where(and(
      eq(employeeProvisionSettlementsTable.companyId, companyId),
      eq(employeeProvisionSettlementsTable.sourceType, sourceType),
      eq(employeeProvisionSettlementsTable.sourceRecordId, sourceId),
      eq(employeeProvisionSettlementsTable.status, "posted"),
    )).limit(1);
  if (claim) throw Object.assign(new Error("اعكس تسوية مخصص الموظف أولاً قبل تعديل المصدر أو إلغائه أو فك ترحيله"), { status: 409 });
}

/** Consume only real, posted ticket expense, not VAT, inventory or invoice payments. */
export async function availableTicketExpense(
  q: any, companyId: number, sourceType: TicketProvisionSource, sourceId: number, expenseAccountId: number,
  settlementDate: string,
) {
  const table = sourceType === "purchase_invoice" ? purchaseInvoicesTable : paymentVouchersTable;
  const [source] = await q.select({
    journalEntryId: table.journalEntryId,
  }).from(table).where(and(eq(table.id, sourceId), eq(table.companyId, companyId),
    eq(table.status, "posted"))).for("update");
  if (!source?.journalEntryId)
    throw Object.assign(new Error("مصدر مصروف التذكرة غير موجود أو غير مرحّل"), { status: 409 });
  const [entry] = await q.select().from(journalEntriesTable).where(and(
    eq(journalEntriesTable.id, source.journalEntryId), eq(journalEntriesTable.companyId, companyId),
    eq(journalEntriesTable.status, "posted"),
  )).for("update");
  if (!entry) throw Object.assign(new Error("قيد مصدر التذكرة غير مرحّل"), { status: 409 });
  if (String(entry.entryDate).slice(0, 10) > settlementDate)
    throw Object.assign(new Error("تاريخ التسوية يسبق تاريخ قيد مصروف التذكرة"), { status: 409 });
  if (entry.currency !== "SAR" || Number(entry.exchangeRate) !== 1)
    throw Object.assign(new Error("تسويات التذاكر تتطلب مصروفاً مرحّلاً بالريال السعودي دون تحويل عملة"), { status: 400 });
  if (sourceType === "purchase_invoice") {
    const [returned] = await q.select({ id: purchaseReturnsTable.id }).from(purchaseReturnsTable).where(and(
      eq(purchaseReturnsTable.companyId, companyId), eq(purchaseReturnsTable.invoiceId, sourceId),
      eq(purchaseReturnsTable.status, "posted"),
    )).limit(1);
    if (returned) throw Object.assign(new Error("لا يمكن تسوية تذكرة من فاتورة لها مرتجع مرحّل؛ عالج المرتجع أولاً"), { status: 409 });
  }
  const [expense] = await q.select({
    amount: sql<string>`coalesce(sum(${journalEntryLinesTable.debit} - ${journalEntryLinesTable.credit}), 0)`,
  }).from(journalEntryLinesTable).where(and(
    eq(journalEntryLinesTable.entryId, source.journalEntryId),
    eq(journalEntryLinesTable.accountId, expenseAccountId),
  ));
  const [used] = await q.select({
    amount: sql<string>`coalesce(sum(${employeeProvisionSettlementsTable.amount}), 0)`,
  }).from(employeeProvisionSettlementsTable).where(and(
    eq(employeeProvisionSettlementsTable.companyId, companyId),
    eq(employeeProvisionSettlementsTable.sourceType, sourceType),
    eq(employeeProvisionSettlementsTable.sourceRecordId, sourceId),
    eq(employeeProvisionSettlementsTable.status, "posted"),
  ));
  return Math.max(0, Number(expense?.amount ?? 0) - Number(used?.amount ?? 0));
}

async function captureExpenseParts(q: any, companyId: number, journalId: number, accountId: number, amount: number) {
  const originals = await q.select({
    costCenter: journalEntryLinesTable.costCenter,
    amount: sql<string>`coalesce(sum(${journalEntryLinesTable.debit} - ${journalEntryLinesTable.credit}), 0)`,
  }).from(journalEntryLinesTable).where(and(
    eq(journalEntryLinesTable.entryId, journalId), eq(journalEntryLinesTable.accountId, accountId),
  )).groupBy(journalEntryLinesTable.costCenter);
  const used = await q.select({ snapshot: employeeProvisionSettlementsTable.sourceSnapshot })
    .from(employeeProvisionSettlementsTable).where(and(
      eq(employeeProvisionSettlementsTable.companyId, companyId), eq(employeeProvisionSettlementsTable.status, "posted"),
      sql`${employeeProvisionSettlementsTable.sourceSnapshot}->>'sourceJournalId' = ${String(journalId)}`,
      sql`${employeeProvisionSettlementsTable.sourceSnapshot}->>'expenseAccountId' = ${String(accountId)}`,
    ));
  const remaining = originals.map((line: any) => {
    const taken = used.reduce((sum: number, row: any) => sum + (row.snapshot?.expenseParts ?? [])
      .filter((part: any) => part.costCenter === line.costCenter)
      .reduce((total: number, part: any) => total + Number(part.amount), 0), 0);
    return { costCenter: line.costCenter as string | null, amount: Math.round((Number(line.amount) - taken) * 100) / 100 };
  });
  if (remaining.some((part: any) => part.amount < -0.005))
    throw Object.assign(new Error("رصيد مصروف المصدر أو مركز تكلفته لا يتطابق مع التسويات السابقة"), { status: 409 });
  const positive = remaining.filter((part: any) => part.amount > 0);
  const total = positive.reduce((sum: number, part: any) => sum + part.amount, 0);
  if (amount > total + 0.005 || !positive.length)
    throw Object.assign(new Error("المبلغ يتجاوز المصروف الفعلي المتبقي على المصدر"), { status: 409 });
  const shares = splitProvisionMoney(amount, positive.map((part: any) => part.amount));
  const expenseParts = positive.map((part: any, index: number) => {
    if (shares[index] > part.amount + 0.005)
      throw Object.assign(new Error("توزيع التسوية يتجاوز مصروف مركز التكلفة"), { status: 409 });
    return { costCenter: part.costCenter, amount: shares[index] };
  }).filter((part: any) => part.amount > 0);
  return {
    sourceExpenseAmount: originals.reduce((sum: number, part: any) => sum + Number(part.amount), 0),
    expenseParts,
    remaining,
  };
}

export async function captureTicketExpense(
  q: any, companyId: number, sourceType: TicketProvisionSource, sourceId: number,
  expenseAccountId: number, amount: number,
): Promise<ProvisionExpenseSnapshot> {
  const table = sourceType === "purchase_invoice" ? purchaseInvoicesTable : paymentVouchersTable;
  const [source] = await q.select({ journalEntryId: table.journalEntryId, branchId: table.branchId,
    sourceDate: sourceType === "purchase_invoice" ? purchaseInvoicesTable.invoiceDate : sql<string>`''`,
  }).from(table)
    .where(and(eq(table.id, sourceId), eq(table.companyId, companyId))).for("update");
  if (!source?.journalEntryId) throw Object.assign(new Error("قيد مصدر التذكرة غير موجود"), { status: 409 });
  const parts = await captureExpenseParts(q, companyId, source.journalEntryId, expenseAccountId, amount);
  let purchaseLineOffsets: Array<{ lineId: number; amount: number }> | undefined;
  if (sourceType === "purchase_invoice") {
    const industrial = (await getPostedIndustrialPurchaseCosts(q, companyId, { period: String(source.sourceDate).slice(0, 7) }))
      .filter(line => line.sourceType === "purchase_invoice" && line.sourceDocumentId === sourceId &&
        Number(line.sourceAccountId) === expenseAccountId);
    const previous = await q.select({ amount: employeeProvisionSettlementsTable.amount,
      snapshot: employeeProvisionSettlementsTable.sourceSnapshot }).from(employeeProvisionSettlementsTable).where(and(
        eq(employeeProvisionSettlementsTable.companyId, companyId),
        eq(employeeProvisionSettlementsTable.sourceType, sourceType),
        eq(employeeProvisionSettlementsTable.sourceRecordId, sourceId),
        eq(employeeProvisionSettlementsTable.status, "posted"),
      ));
    const remaining = industrial.map(line => {
      const used = previous.reduce((sum: number, row: any) => sum + (row.snapshot?.purchaseLineOffsets ?? [])
        .filter((part: any) => Number(part.lineId) === Number(line.sourceLineId))
        .reduce((total: number, part: any) => total + Number(part.amount), 0), 0);
      return Math.round((Number(line.amount) - used) * 100) / 100;
    });
    const totalRemaining = parts.sourceExpenseAmount - previous.reduce((sum: number, row: any) => sum + Number(row.amount), 0);
    const nonIndustrial = totalRemaining - remaining.reduce((sum, value) => sum + value, 0);
    if (remaining.some(value => value < -0.005) || nonIndustrial < -0.005)
      throw Object.assign(new Error("تكلفة سطور الفاتورة الصناعية لا تتطابق مع مصروف التذكرة المتبقي"), { status: 409 });
    const shares = splitProvisionMoney(amount, [...remaining.map(value => Math.max(0, value)), Math.max(0, nonIndustrial)]);
    purchaseLineOffsets = industrial.map((line, index) => ({ lineId: Number(line.sourceLineId), amount: shares[index] }));
  }
  return { sourceJournalId: source.journalEntryId, branchId: source.branchId ?? null, expenseAccountId,
    sourceExpenseAmount: parts.sourceExpenseAmount, manufacturingOffsetAmount: amount, expenseParts: parts.expenseParts,
    ...(purchaseLineOffsets ? { purchaseLineOffsets } : {}) };
}

/** Paid leave consumes basic salary actually expensed in the settlement month. */
export async function captureLeaveExpense(
  q: any, companyId: number, employeeId: number, leaveId: number, approvedDays: number,
  settlementDate: string, expenseAccountId: number, amount: number,
): Promise<ProvisionExpenseSnapshot> {
  const [source] = await q.select({
    runId: payrollRunsTable.id, journalId: payrollRunsTable.postedJournalId,
    manufacturingEligible: payrollRunsTable.manufacturingEligible,
    branchId: payrollRunsTable.branchId,
    basic: payrollLinesTable.basicSalary, absence: payrollLinesTable.absenceDeduction,
    lineId: payrollLinesTable.id,
  }).from(payrollRunsTable).innerJoin(payrollLinesTable, and(
    eq(payrollLinesTable.payrollRunId, payrollRunsTable.id), eq(payrollLinesTable.employeeId, employeeId),
  )).innerJoin(journalEntriesTable, and(
    eq(journalEntriesTable.id, payrollRunsTable.postedJournalId), eq(journalEntriesTable.companyId, companyId),
    eq(journalEntriesTable.status, "posted"), eq(journalEntriesTable.currency, "SAR"),
    sql`${journalEntriesTable.exchangeRate} = 1`,
  )).where(and(
    eq(payrollRunsTable.companyId, companyId), eq(payrollRunsTable.year, Number(settlementDate.slice(0, 4))),
    eq(payrollRunsTable.month, Number(settlementDate.slice(5, 7))),
    sql`${payrollRunsTable.status} IN ('posted', 'paid')`,
    sql`${journalEntriesTable.entryDate} <= ${settlementDate}`,
  )).for("update");
  if (!source?.journalId)
    throw Object.assign(new Error("رحّل راتب شهر استخدام الإجازة أولاً قبل تسوية مخصصها"), { status: 409 });
  const [used] = await q.select({
    amount: sql<string>`coalesce(sum(${employeeProvisionSettlementsTable.amount}), 0)`,
  }).from(employeeProvisionSettlementsTable).where(and(
    eq(employeeProvisionSettlementsTable.companyId, companyId),
    eq(employeeProvisionSettlementsTable.employeeId, employeeId),
    eq(employeeProvisionSettlementsTable.provisionType, "annual_leave"),
    eq(employeeProvisionSettlementsTable.status, "posted"),
    sql`${employeeProvisionSettlementsTable.sourceSnapshot}->>'expensePayrollRunId' = ${String(source.runId)}`,
  ));
  const [leaveUse] = await q.select({
    amount: sql<string>`coalesce(sum(${employeeProvisionSettlementsTable.amount}), 0)`,
  }).from(employeeProvisionSettlementsTable).where(and(
    eq(employeeProvisionSettlementsTable.companyId, companyId),
    eq(employeeProvisionSettlementsTable.sourceType, "employee_leave"),
    eq(employeeProvisionSettlementsTable.sourceRecordId, leaveId),
    eq(employeeProvisionSettlementsTable.status, "posted"),
  ));
  const basicLimit = Math.max(0, Number(source.basic) - Number(source.absence)) - Number(used?.amount ?? 0);
  const leaveLimit = Number(source.basic) * Math.max(0, approvedDays) / 30 - Number(leaveUse?.amount ?? 0);
  if (amount > Math.min(basicLimit, leaveLimit) + 0.005)
    throw Object.assign(new Error("التسوية تتجاوز الأساسي الفعلي المتبقي أو قيمة أيام الإجازة على الأساسي فقط"), { status: 409 });
  const snapshots = await q.select().from(payrollAllocationSnapshotsTable).where(and(
    eq(payrollAllocationSnapshotsTable.companyId, companyId), eq(payrollAllocationSnapshotsTable.payrollLineId, source.lineId),
  ));
  const sourceBasis = snapshots.reduce((sum: number, row: any) => sum + Number(row.allocatedAmount), 0);
  if (source.manufacturingEligible && (snapshots.length === 0 || amount + Number(used?.amount ?? 0) > sourceBasis + 0.005))
    throw Object.assign(new Error("لقطة تكلفة راتب التصنيع لا تكفي لهذه التسوية؛ راجع المسير أولاً"), { status: 409 });
  const original = await captureExpenseParts(q, companyId, source.journalId, expenseAccountId, amount);
  const shares = snapshots.length ? splitProvisionMoney(amount,
    snapshots.map((snapshot: any) => Number(snapshot.days) * Number(snapshot.salaryAllocationPct ?? 100))) : [];
  const split: Array<{ costCenterId: number | null; amount: number }> = snapshots.length ? snapshots.map((snapshot: any, index: number) => ({
    costCenterId: snapshot.costCenterId, amount: shares[index],
  })) : [{ costCenterId: null, amount }];
  const expenseParts = split.filter(part => part.amount > 0)
    .map(part => ({ costCenter: part.costCenterId == null ? null : String(part.costCenterId), amount: part.amount }));
  const requiredByCenter = new Map<string | null, number>();
  for (const part of expenseParts) requiredByCenter.set(part.costCenter,
    (requiredByCenter.get(part.costCenter) ?? 0) + part.amount);
  for (const [costCenter, required] of requiredByCenter) {
    const available = original.remaining.find((part: any) => part.costCenter === costCenter)?.amount ?? 0;
    if (required > available + 0.005)
      throw Object.assign(new Error("مركز تكلفة الراتب أو ربط حساب الأساسي تغير بعد الترحيل؛ تعذرت التسوية الآمنة"), { status: 409 });
  }
  return { sourceJournalId: source.journalId, branchId: source.branchId ?? null, expenseAccountId, sourceExpenseAmount: original.sourceExpenseAmount,
    expensePayrollRunId: source.runId, manufacturingOffsetAmount: sourceBasis > 0 ? amount : 0, expenseParts };
}
