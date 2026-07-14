import { db } from "@workspace/db";
import { journalEntriesTable } from "@workspace/db";
import {
  salesInvoicesTable,
  salesReturnsTable,
  purchaseInvoicesTable,
  purchaseReturnsTable,
  receiptVouchersTable,
  receiptVoucherLinesTable,
  paymentVouchersTable,
  paymentVoucherLinesTable,
} from "@workspace/db";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";

/** Serialize concurrent settlement writes against the SAME invoice.
 *  Postgres transaction-scoped advisory lock keyed on (companyId, kind,
 *  invoiceId) — MUST be called inside a transaction; the lock releases
 *  automatically on commit/rollback. Without it two concurrent saves can
 *  both read the same "remaining" and jointly exceed the invoice cap. */
export async function acquireSettlementLock(
  tx: any,
  cid: number,
  kind: SettlementKind,
  invoiceId: number,
): Promise<void> {
  // 2^20 slots per company per kind — collisions only serialize, never break.
  const key1 = cid * 2 + (kind === "sales" ? 0 : 1);
  const key2 = invoiceId;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${key1}, ${key2})`);
}

// سداد فاتورة عن طريق قيد محاسبي — منطق مشترك بين مسارات السندات والقيود.
//
// A MANUAL journal entry can settle a CREDIT invoice via the header link
// (journal_entries.sales_invoice_id / purchase_invoice_id + settlement_amount).
// Business rule mirrors the vouchers exactly: draft + posted entries both
// count, everything compared in BASE currency (amount × exchangeRate), and
// the sum of all settlements (vouchers + JEs) may never exceed the invoice's
// net due (total − returns).

export type SettlementKind = "sales" | "purchase";

/** Sum of settlement JEs linked to the given invoice, in BASE currency.
 *  Draft + posted both count (same policy as vouchers). */
export async function sumSettlementJEs(
  cid: number,
  kind: SettlementKind,
  invoiceId: number,
  excludeJeId: number | null = null,
): Promise<number> {
  const linkCol = kind === "sales"
    ? journalEntriesTable.salesInvoiceId
    : journalEntriesTable.purchaseInvoiceId;
  const conds = [
    eq(journalEntriesTable.companyId, cid),
    eq(linkCol, invoiceId),
    isNotNull(journalEntriesTable.settlementAmount),
  ];
  if (excludeJeId) conds.push(ne(journalEntriesTable.id, excludeJeId));
  const rows = await db.select({
    amount: journalEntriesTable.settlementAmount,
    rate:   journalEntriesTable.exchangeRate,
  }).from(journalEntriesTable).where(and(...conds));
  return rows.reduce(
    (s, r) => s + (parseFloat(String(r.amount)) || 0) * (parseFloat(String(r.rate)) || 1),
    0,
  );
}

/** Sum of receipt/payment vouchers (draft + posted, header-linked or
 *  line-linked) already settling the given invoice, in BASE currency.
 *  Mirrors the summing inside the voucher routes' overpayment guards:
 *  line rows are authoritative; a header-linked voucher with NO line rows
 *  for the invoice counts with its full header amount. */
export async function sumVouchersForInvoice(
  cid: number,
  kind: SettlementKind,
  invoiceId: number,
): Promise<number> {
  const vTable   = kind === "sales" ? receiptVouchersTable     : paymentVouchersTable;
  const lTable   = kind === "sales" ? receiptVoucherLinesTable : paymentVoucherLinesTable;
  const lLinkCol = kind === "sales"
    ? receiptVoucherLinesTable.salesInvoiceId
    : paymentVoucherLinesTable.purchaseInvoiceId;
  const hLinkCol = kind === "sales"
    ? receiptVouchersTable.salesInvoiceId
    : paymentVouchersTable.purchaseInvoiceId;

  const lineRows = await db.select({
    voucherId: (lTable as any).voucherId,
    amount:    (lTable as any).amount,
    vRate:     (vTable as any).exchangeRate,
  }).from(lTable as any)
    .innerJoin(vTable as any, eq((lTable as any).voucherId, (vTable as any).id))
    .where(and(eq((vTable as any).companyId, cid), eq(lLinkCol as any, invoiceId)));
  const lineLinked = new Set(lineRows.map((r: any) => r.voucherId));
  let existing = 0;
  for (const r of lineRows as any[]) {
    existing += (parseFloat(String(r.amount)) || 0) * (parseFloat(String(r.vRate)) || 1);
  }
  const headerRows = await db.select({
    id:     (vTable as any).id,
    amount: (vTable as any).amount,
    vRate:  (vTable as any).exchangeRate,
  }).from(vTable as any)
    .where(and(eq((vTable as any).companyId, cid), eq(hLinkCol as any, invoiceId)));
  for (const v of headerRows as any[]) {
    if (lineLinked.has(v.id)) continue;
    existing += (parseFloat(String(v.amount)) || 0) * (parseFloat(String(v.vRate)) || 1);
  }
  return existing;
}

/** Guard for a manual JE settling an invoice. Throws (Arabic) when the
 *  link is invalid or the amount would overpay the invoice. Amounts in
 *  BASE currency; tolerance +0.01 like the voucher guards. */
export async function assertJeSettlementAllowed(
  cid: number,
  kind: SettlementKind,
  invoiceId: number,
  amountBase: number,
  excludeJeId: number | null = null,
): Promise<void> {
  if (!(amountBase > 0)) throw new Error("مبلغ السداد المرتبط بالقيد يجب أن يكون أكبر من صفر");
  const { netDue, paymentType } = await invoiceNetDueBase(cid, kind, invoiceId);
  if (paymentType !== "credit") {
    throw new Error("لا يمكن ربط قيد سداد إلا بفاتورة آجلة — الفواتير النقدية/البنكية تُسدَّد تلقائياً عند الترحيل");
  }
  const vouchers = await sumVouchersForInvoice(cid, kind, invoiceId);
  const jes = await sumSettlementJEs(cid, kind, invoiceId, excludeJeId);
  const remaining = netDue - vouchers - jes;
  if (amountBase > remaining + 0.01) {
    throw new Error(
      `لا يمكن حفظ القيد: مبلغ السداد يتجاوز المتبقي من الفاتورة المرتبطة. المتبقي المسموح ${Math.max(0, remaining).toFixed(2)} فقط (تُحتسب السندات والقيود المسودة المرتبطة ضمن السداد)`
    );
  }
}

/** Net due (total − returns) of the invoice in BASE currency, plus its
 *  paymentType. Throws when the invoice doesn't exist in this tenant. */
export async function invoiceNetDueBase(
  cid: number,
  kind: SettlementKind,
  invoiceId: number,
): Promise<{ netDue: number; paymentType: string; docNumber: string | null }> {
  if (kind === "sales") {
    const [inv] = await db.select({
      total: salesInvoicesTable.totalAmount,
      rate:  salesInvoicesTable.exchangeRate,
      paymentType: salesInvoicesTable.paymentType,
      docNumber: salesInvoicesTable.docNumber,
    }).from(salesInvoicesTable)
      .where(and(eq(salesInvoicesTable.id, invoiceId), eq(salesInvoicesTable.companyId, cid)));
    if (!inv) throw new Error("الفاتورة المرتبطة غير موجودة");
    const invBase = (parseFloat(String(inv.total)) || 0) * (parseFloat(String(inv.rate)) || 1);
    const rets = await db.select({
      total: salesReturnsTable.totalAmount,
      rate:  salesReturnsTable.exchangeRate,
    }).from(salesReturnsTable)
      .where(and(eq(salesReturnsTable.companyId, cid), eq(salesReturnsTable.invoiceId, invoiceId)));
    const retBase = rets.reduce((s, r) => s + (parseFloat(String(r.total)) || 0) * (parseFloat(String(r.rate)) || 1), 0);
    return { netDue: Math.max(0, invBase - retBase), paymentType: String(inv.paymentType ?? "credit"), docNumber: (inv as any).docNumber ?? null };
  }
  const [inv] = await db.select({
    total: purchaseInvoicesTable.totalAmount,
    rate:  purchaseInvoicesTable.exchangeRate,
    paymentType: purchaseInvoicesTable.paymentType,
    docNumber: purchaseInvoicesTable.docNumber,
  }).from(purchaseInvoicesTable)
    .where(and(eq(purchaseInvoicesTable.id, invoiceId), eq(purchaseInvoicesTable.companyId, cid)));
  if (!inv) throw new Error("الفاتورة المرتبطة غير موجودة");
  const invBase = (parseFloat(String(inv.total)) || 0) * (parseFloat(String(inv.rate)) || 1);
  const rets = await db.select({
    total: purchaseReturnsTable.totalAmount,
    rate:  purchaseReturnsTable.exchangeRate,
  }).from(purchaseReturnsTable)
    .where(and(eq(purchaseReturnsTable.companyId, cid), eq(purchaseReturnsTable.invoiceId, invoiceId)));
  const retBase = rets.reduce((s, r) => s + (parseFloat(String(r.total)) || 0) * (parseFloat(String(r.rate)) || 1), 0);
  return { netDue: Math.max(0, invBase - retBase), paymentType: String(inv.paymentType ?? "credit"), docNumber: (inv as any).docNumber ?? null };
}
