import { and, eq, sql } from "drizzle-orm";
import type { RequestHandler } from "express";
import {
  db,
  employeeProvisionSettlementsTable, journalEntriesTable, journalEntryLinesTable,
  paymentVouchersTable, purchaseInvoicesTable, purchaseReturnsTable,
} from "@workspace/db";
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
