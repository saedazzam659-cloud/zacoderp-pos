import { db } from "@workspace/db";
import { journalEntriesTable, settlementLinksTable } from "@workspace/db";
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
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";

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

export type SettlementSourceType = "je" | "receipt_voucher" | "payment_voucher";

/** روابط السداد الجزئي — sum of PARTIAL settlement links from the given
 *  source doc types against the invoice, in BASE currency (link amount is in
 *  the source's currency × the source's exchange rate). Additive to the
 *  legacy header links. */
export async function sumPartialLinksForInvoice(
  cid: number,
  kind: SettlementKind,
  invoiceId: number,
  sourceType: SettlementSourceType,
): Promise<number> {
  const invCol = kind === "sales"
    ? settlementLinksTable.salesInvoiceId
    : settlementLinksTable.purchaseInvoiceId;
  if (sourceType === "je") {
    const rows = await db.select({
      amount: settlementLinksTable.amount,
      rate:   journalEntriesTable.exchangeRate,
    }).from(settlementLinksTable)
      .innerJoin(journalEntriesTable, eq(settlementLinksTable.sourceId, journalEntriesTable.id))
      .where(and(
        eq(settlementLinksTable.companyId, cid),
        eq(settlementLinksTable.sourceType, "je"),
        eq(invCol, invoiceId),
      ));
    return rows.reduce((s, r) => s + (parseFloat(String(r.amount)) || 0) * (parseFloat(String(r.rate)) || 1), 0);
  }
  const vTable = sourceType === "receipt_voucher" ? receiptVouchersTable : paymentVouchersTable;
  const rows = await db.select({
    amount: settlementLinksTable.amount,
    rate:   (vTable as any).exchangeRate,
  }).from(settlementLinksTable)
    .innerJoin(vTable as any, eq(settlementLinksTable.sourceId, (vTable as any).id))
    .where(and(
      eq(settlementLinksTable.companyId, cid),
      eq(settlementLinksTable.sourceType, sourceType),
      eq(invCol, invoiceId),
    ));
  return rows.reduce((s, r: any) => s + (parseFloat(String(r.amount)) || 0) * (parseFloat(String(r.rate)) || 1), 0);
}

/** Total already CONSUMED from a source document across ALL its partial
 *  links (both invoice kinds), in the SOURCE document's currency. */
export async function sumConsumedFromSource(
  cid: number,
  sourceType: SettlementSourceType,
  sourceId: number,
  dbx: any = db,
): Promise<number> {
  const rows = await dbx.select({ amount: settlementLinksTable.amount })
    .from(settlementLinksTable)
    .where(and(
      eq(settlementLinksTable.companyId, cid),
      eq(settlementLinksTable.sourceType, sourceType),
      eq(settlementLinksTable.sourceId, sourceId),
    ));
  return rows.reduce((s: number, r: any) => s + (parseFloat(String(r.amount)) || 0), 0);
}

/** Serialize concurrent consumption of the SAME source document (a JE or
 *  voucher being applied to two invoices at once). Negative source id keys
 *  keep this namespace disjoint from the invoice locks above. MUST be called
 *  inside a transaction, AFTER acquireSettlementLock (consistent order). */
export async function acquireSourceLock(
  tx: any,
  cid: number,
  sourceType: SettlementSourceType,
  sourceId: number,
): Promise<void> {
  const t = sourceType === "je" ? 0 : sourceType === "receipt_voucher" ? 1 : 2;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${cid * 4 + 3}, ${-(sourceId * 4 + t)})`);
}

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
  const legacy = rows.reduce(
    (s, r) => s + (parseFloat(String(r.amount)) || 0) * (parseFloat(String(r.rate)) || 1),
    0,
  );
  // Partial links are NEVER excluded — they are prior, committed consumption
  // of the invoice even when they come from the same JE being re-applied.
  return legacy + await sumPartialLinksForInvoice(cid, kind, invoiceId, "je");
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
    // سطور سند الصرف تحمل ضريبة منفصلة تدخل ضمن السداد (تطابق حارس
    // السداد الزائد في مسار سندات الصرف الذي يجمع amount + tax_amount).
    taxAmount: kind === "purchase" ? (lTable as any).taxAmount : sql`0`,
    vRate:     (vTable as any).exchangeRate,
  }).from(lTable as any)
    .innerJoin(vTable as any, eq((lTable as any).voucherId, (vTable as any).id))
    .where(and(eq((vTable as any).companyId, cid), eq(lLinkCol as any, invoiceId)));
  const lineLinked = new Set(lineRows.map((r: any) => r.voucherId));
  let existing = 0;
  for (const r of lineRows as any[]) {
    existing += ((parseFloat(String(r.amount)) || 0) + (parseFloat(String((r as any).taxAmount)) || 0))
      * (parseFloat(String(r.vRate)) || 1);
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
  // Plus partial settlement links (سداد جزئي من سند موجود).
  existing += await sumPartialLinksForInvoice(
    cid, kind, invoiceId, kind === "sales" ? "receipt_voucher" : "payment_voucher");
  return existing;
}

export type InvoicePayStatus = "paid" | "partial" | "unpaid";

/** حالة السداد لقائمة الفواتير — batch version of the settlement formula
 *  (vouchers header+lines+partial links + settlement JEs legacy+links, all
 *  in BASE currency, draft+posted both count — same policy as the
 *  overpayment guards) computed for MANY invoices with a fixed number of
 *  queries. Used by the purchase/sales invoice LIST endpoints so the grid's
 *  «حالة السداد» column and the voucher invoice pickers reflect JE
 *  settlements too, not just the latest linked voucher. */
export async function batchInvoiceSettlementStatus(
  cid: number,
  kind: SettlementKind,
  invoices: Array<{ id: number; totalAmount: any; exchangeRate: any; paymentType?: any; status?: any }>,
): Promise<Map<number, { netDueBase: number; paidBase: number; remainingBase: number; paymentStatus: InvoicePayStatus }>> {
  const out = new Map<number, { netDueBase: number; paidBase: number; remainingBase: number; paymentStatus: InvoicePayStatus }>();
  const ids = invoices.map(i => i.id);
  if (ids.length === 0) return out;

  const num = (x: any, d = 0) => { const n = parseFloat(String(x)); return Number.isFinite(n) ? n : d; };
  const rate1 = (x: any) => { const n = parseFloat(String(x)); return Number.isFinite(n) && n > 0 ? n : 1; };

  const rTable   = kind === "sales" ? salesReturnsTable        : purchaseReturnsTable;
  const vTable   = kind === "sales" ? receiptVouchersTable     : paymentVouchersTable;
  const lTable   = kind === "sales" ? receiptVoucherLinesTable : paymentVoucherLinesTable;
  const lLinkCol = kind === "sales"
    ? receiptVoucherLinesTable.salesInvoiceId
    : paymentVoucherLinesTable.purchaseInvoiceId;
  const hLinkCol = kind === "sales"
    ? receiptVouchersTable.salesInvoiceId
    : paymentVouchersTable.purchaseInvoiceId;
  const jeLinkCol = kind === "sales"
    ? journalEntriesTable.salesInvoiceId
    : journalEntriesTable.purchaseInvoiceId;
  const linkInvCol = kind === "sales"
    ? settlementLinksTable.salesInvoiceId
    : settlementLinksTable.purchaseInvoiceId;
  const voucherLinkType: SettlementSourceType =
    kind === "sales" ? "receipt_voucher" : "payment_voucher";

  const [retRows, lineRows, headerRows, legacyJes, jeLinks, voucherLinks] = await Promise.all([
    db.select({
      invoiceId: (rTable as any).invoiceId,
      total:     (rTable as any).totalAmount,
      rate:      (rTable as any).exchangeRate,
    }).from(rTable as any)
      .where(and(eq((rTable as any).companyId, cid), inArray((rTable as any).invoiceId, ids))),
    db.select({
      invoiceId: lLinkCol,
      voucherId: (lTable as any).voucherId,
      amount:    (lTable as any).amount,
      // سطور سند الصرف تحمل ضريبة منفصلة تُحتسب ضمن السداد (النقد المدفوع
      // شامل الضريبة) — سطور سند القبض لا تملك عمود ضريبة.
      taxAmount: kind === "purchase" ? (lTable as any).taxAmount : sql`0`,
      vRate:     (vTable as any).exchangeRate,
    }).from(lTable as any)
      .innerJoin(vTable as any, eq((lTable as any).voucherId, (vTable as any).id))
      .where(and(eq((vTable as any).companyId, cid), inArray(lLinkCol as any, ids))),
    db.select({
      id:        (vTable as any).id,
      invoiceId: hLinkCol,
      amount:    (vTable as any).amount,
      vRate:     (vTable as any).exchangeRate,
    }).from(vTable as any)
      .where(and(eq((vTable as any).companyId, cid), inArray(hLinkCol as any, ids))),
    db.select({
      invoiceId: jeLinkCol,
      amount:    journalEntriesTable.settlementAmount,
      rate:      journalEntriesTable.exchangeRate,
    }).from(journalEntriesTable)
      .where(and(
        eq(journalEntriesTable.companyId, cid),
        inArray(jeLinkCol as any, ids),
        isNotNull(journalEntriesTable.settlementAmount),
      )),
    db.select({
      invoiceId: linkInvCol,
      amount:    settlementLinksTable.amount,
      rate:      journalEntriesTable.exchangeRate,
    }).from(settlementLinksTable)
      .innerJoin(journalEntriesTable, eq(settlementLinksTable.sourceId, journalEntriesTable.id))
      .where(and(
        eq(settlementLinksTable.companyId, cid),
        eq(settlementLinksTable.sourceType, "je"),
        inArray(linkInvCol as any, ids),
      )),
    db.select({
      invoiceId: linkInvCol,
      amount:    settlementLinksTable.amount,
      rate:      (vTable as any).exchangeRate,
    }).from(settlementLinksTable)
      .innerJoin(vTable as any, eq(settlementLinksTable.sourceId, (vTable as any).id))
      .where(and(
        eq(settlementLinksTable.companyId, cid),
        eq(settlementLinksTable.sourceType, voucherLinkType),
        inArray(linkInvCol as any, ids),
      )),
  ]);

  const retByInv  = new Map<number, number>();
  for (const r of retRows as any[]) {
    if (r.invoiceId == null) continue;
    retByInv.set(r.invoiceId, (retByInv.get(r.invoiceId) ?? 0) + num(r.total) * rate1(r.rate));
  }
  const paidByInv = new Map<number, number>();
  const addPaid = (invoiceId: any, v: number) => {
    if (invoiceId == null) return;
    paidByInv.set(invoiceId, (paidByInv.get(invoiceId) ?? 0) + v);
  };
  // Line rows are authoritative; a header-linked voucher with NO line rows
  // for the same invoice counts with its full header amount (mirrors
  // sumVouchersForInvoice above).
  const lineLinked = new Map<number, Set<number>>();
  for (const r of lineRows as any[]) {
    addPaid(r.invoiceId, (num(r.amount) + num(r.taxAmount)) * rate1(r.vRate));
    const s = lineLinked.get(r.invoiceId) ?? new Set<number>();
    s.add(r.voucherId);
    lineLinked.set(r.invoiceId, s);
  }
  for (const v of headerRows as any[]) {
    if (v.invoiceId == null) continue;
    if (lineLinked.get(v.invoiceId)?.has(v.id)) continue;
    addPaid(v.invoiceId, num(v.amount) * rate1(v.vRate));
  }
  for (const r of legacyJes as any[])    addPaid(r.invoiceId, num(r.amount) * rate1(r.rate));
  for (const r of jeLinks as any[])      addPaid(r.invoiceId, num(r.amount) * rate1(r.rate));
  for (const r of voucherLinks as any[]) addPaid(r.invoiceId, num(r.amount) * rate1(r.rate));

  for (const inv of invoices) {
    const netDue = Math.max(0, num(inv.totalAmount) * rate1(inv.exchangeRate) - (retByInv.get(inv.id) ?? 0));
    let paid = paidByInv.get(inv.id) ?? 0;
    // الفواتير النقدية/البنكية تُسدَّد تلقائياً عند الترحيل (نفس قاعدة
    // assertJeSettlementAllowed التي ترفض ربط سداد بغير الآجلة).
    const pt = String(inv.paymentType ?? "credit");
    if (pt !== "credit" && String(inv.status ?? "") === "posted") paid = Math.max(paid, netDue);
    const remaining = Math.max(0, netDue - paid);
    const paymentStatus: InvoicePayStatus =
      netDue > 0 && remaining <= 0.01 ? "paid" : paid > 0.005 ? "partial" : "unpaid";
    out.set(inv.id, {
      netDueBase:    +netDue.toFixed(2),
      paidBase:      +paid.toFixed(2),
      remainingBase: +remaining.toFixed(2),
      paymentStatus,
    });
  }
  return out;
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

/** حارس تعديل الفاتورة بعد السداد: يمنع حفظ تعديل يجعل صافي المستحق
 *  (الإجمالي الجديد − المرتجعات) أقل من مجموع ما سُدِّد فعلاً
 *  (سندات + قيود سداد، بالعملة الأساسية). يُستدعى من PUT الفواتير قبل
 *  الكتابة — الحماية من الخادم وليست واجهة فقط. */
export async function assertInvoiceEditKeepsSettlementsCovered(
  cid: number,
  kind: SettlementKind,
  invoiceId: number,
  newTotalBase: number,
): Promise<void> {
  const [vouchers, jes] = await Promise.all([
    sumVouchersForInvoice(cid, kind, invoiceId),
    sumSettlementJEs(cid, kind, invoiceId),
  ]);
  const settled = vouchers + jes;
  if (settled <= 0.005) return; // لا مدفوعات — التعديل حر
  // مرتجعات الفاتورة بالعملة الأساسية (نفس منطق invoiceNetDueBase).
  const rTable = kind === "sales" ? salesReturnsTable : purchaseReturnsTable;
  const rets = await db.select({
    total: (rTable as any).totalAmount,
    rate:  (rTable as any).exchangeRate,
  }).from(rTable as any)
    .where(and(eq((rTable as any).companyId, cid), eq((rTable as any).invoiceId, invoiceId)));
  const retBase = (rets as any[]).reduce(
    (s, r) => s + (parseFloat(String(r.total)) || 0) * (parseFloat(String(r.rate)) || 1), 0);
  const newNetDue = Math.max(0, newTotalBase - retBase);
  if (newNetDue + 0.01 < settled) {
    const err: any = new Error(
      `لا يمكن حفظ التعديل: قيمة الفاتورة بعد التعديل (${newNetDue.toFixed(2)}) أصبحت أقل من المبلغ المسدَّد عليها (${settled.toFixed(2)} — سندات وقيود سداد مرتبطة، تشمل المسودات). ` +
      `عدّل أو ألغِ سندات السداد المرتبطة أولاً، أو سجّل مرتجعاً بدلاً من تخفيض الفاتورة.`,
    );
    err.status = 400;
    throw err;
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
