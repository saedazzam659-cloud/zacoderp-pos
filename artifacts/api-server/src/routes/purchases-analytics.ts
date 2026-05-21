import { Router } from "express";
import { db } from "@workspace/db";
import {
  suppliersTable,
  purchaseInvoicesTable, purchaseInvoiceLinesTable,
  purchaseReturnsTable,  purchaseReturnLinesTable,
  paymentVouchersTable,
  cashBoxesTable,
  bankAccountsTable,
  journalEntriesTable, journalEntryLinesTable,
} from "@workspace/db";
import { and, eq, sql, gte, lte, lt, asc, inArray, notInArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId, pushBranchScope, branchScopeSpread } from "../middleware/auth.js";

// Entry types already aggregated via dedicated document tables — exclude when
// reading direct JE postings to a supplier's AP account, otherwise we would
// double-count purchase invoices / returns / payment vouchers.
const SUPPLIER_DOC_ENTRY_TYPES = [
  "purchase_invoice", "purchase_return", "payment",
  "supplier_settlement",
  "contracting_outgoing_bill", "contracting_incoming_bill",
] as const;

/** Returns posted JE lines on the supplier's AP account that come from
 *  sources OTHER than the supplier-document tables (e.g. fixed-asset credit
 *  acquisition, manual JEs, opening balances). Each row carries the JE date,
 *  doc number, description, and signed debit/credit amount. */
async function fetchSupplierDirectJeLines(
  cid: number,
  supplierAccountId: number | null | undefined,
  fromDate?: string,
  toDate?: string,
  branchScope: any[] = [],
): Promise<{ id: number; date: string; docNumber: string | null; description: string | null;
              debit: number; credit: number; entryType: string }[]> {
  if (!supplierAccountId) return [];
  const conds: any[] = [
    eq(journalEntriesTable.companyId, cid),
    eq(journalEntriesTable.status, "posted"),
    eq(journalEntryLinesTable.accountId, supplierAccountId),
    notInArray(journalEntriesTable.entryType, [...SUPPLIER_DOC_ENTRY_TYPES]),
    ...branchScope,
  ];
  if (fromDate) conds.push(gte(journalEntriesTable.entryDate, fromDate));
  if (toDate)   conds.push(lte(journalEntriesTable.entryDate, toDate));
  const rows = await db
    .select({
      id: journalEntriesTable.id,
      date: journalEntriesTable.entryDate,
      docNumber: journalEntriesTable.docNumber,
      description: journalEntriesTable.description,
      debit:  journalEntryLinesTable.debit,
      credit: journalEntryLinesTable.credit,
      entryType: journalEntriesTable.entryType,
    })
    .from(journalEntryLinesTable)
    .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
    .where(and(...conds));
  return rows.map(r => ({
    id: r.id, date: r.date, docNumber: r.docNumber, description: r.description,
    debit:  Number(r.debit  || 0),
    credit: Number(r.credit || 0),
    entryType: r.entryType,
  }));
}

function jeLineLabel(entryType: string, fallback: string | null): string {
  if (entryType === "fa_acquisition") return "اقتناء أصل ثابت — آجل";
  if (entryType === "trial_balance_adjustment") return "تسوية رصيد افتتاحي";
  if (entryType === "opening") return "رصيد افتتاحي";
  if (entryType === "general") return "قيد يومية يدوي";
  return fallback || "قيد يومية";
}

const router = Router();
router.use(extractAuth);

// Block any unauthenticated access to analytics endpoints.
router.use((req: any, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

function getCid(req: any): number | undefined {
  return resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
}

function getBid(req: any): number | undefined {
  const v = req.query.branchId;
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Purchase totals grouped by supplier (posted invoices and returns within a date range).
 * Includes total payments paid to each supplier in the same range.
 */
router.get("/by-supplier", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const bid = getBid(req);
    const { from, to } = req.query as Record<string, string>;

    const invConds = [eq(purchaseInvoicesTable.companyId, cid), eq(purchaseInvoicesTable.status, "posted")];
    pushBranchScope(req, invConds, purchaseInvoicesTable.branchId, bid);
    if (from) invConds.push(gte(purchaseInvoicesTable.invoiceDate, from));
    if (to)   invConds.push(lte(purchaseInvoicesTable.invoiceDate, to));

    const invAgg = await db
      .select({
        supplierId:   purchaseInvoicesTable.supplierId,
        invoiceCount: sql<number>`count(*)::int`,
        totalPurchases: sql<string>`coalesce(sum(${purchaseInvoicesTable.totalAmount}), 0)`,
        subtotal:     sql<string>`coalesce(sum(${purchaseInvoicesTable.subtotal}), 0)`,
        vatAmount:    sql<string>`coalesce(sum(${purchaseInvoicesTable.vatAmount}), 0)`,
      })
      .from(purchaseInvoicesTable)
      .where(and(...invConds))
      .groupBy(purchaseInvoicesTable.supplierId);

    const retConds = [eq(purchaseReturnsTable.companyId, cid), eq(purchaseReturnsTable.status, "posted")];
    pushBranchScope(req, retConds, purchaseReturnsTable.branchId, bid);
    if (from) retConds.push(gte(purchaseReturnsTable.returnDate, from));
    if (to)   retConds.push(lte(purchaseReturnsTable.returnDate, to));

    const retAgg = await db
      .select({
        supplierId:   purchaseReturnsTable.supplierId,
        totalReturns: sql<string>`coalesce(sum(${purchaseReturnsTable.totalAmount}), 0)`,
      })
      .from(purchaseReturnsTable)
      .where(and(...retConds))
      .groupBy(purchaseReturnsTable.supplierId);

    const payConds = [
      eq(paymentVouchersTable.companyId, cid),
      eq(paymentVouchersTable.status, "posted"),
      eq(paymentVouchersTable.entityType, "supplier"),
    ];
    pushBranchScope(req, payConds, paymentVouchersTable.branchId, bid);
    if (from) payConds.push(gte(paymentVouchersTable.date, from));
    if (to)   payConds.push(lte(paymentVouchersTable.date, to));
    const payAgg = await db
      .select({
        supplierId: paymentVouchersTable.entityId,
        totalPaid:  sql<string>`coalesce(sum(${paymentVouchersTable.amount}), 0)`,
      })
      .from(paymentVouchersTable)
      .where(and(...payConds))
      .groupBy(paymentVouchersTable.entityId);

    const suppliers = await db.select().from(suppliersTable).where(eq(suppliersTable.companyId, cid));
    const smap = new Map(suppliers.map(s => [s.id, s]));

    type Row = {
      supplierId: number | null;
      supplierNameAr: string;
      supplierNameEn: string | null;
      invoiceCount: number;
      totalPurchases: number;
      subtotal: number;
      vatAmount: number;
      totalReturns: number;
      netPurchases: number;
      totalPaid: number;
    };
    const rows = new Map<number | string, Row>();
    const keyOf = (id: number | null) => id ?? "__no_supplier__";
    const ensure = (id: number | null): Row => {
      const k = keyOf(id);
      let r = rows.get(k);
      if (!r) {
        const s = id ? smap.get(id) : null;
        r = {
          supplierId: id,
          supplierNameAr: s?.nameAr ?? "بدون مورد",
          supplierNameEn: s?.nameEn ?? null,
          invoiceCount: 0, totalPurchases: 0, subtotal: 0, vatAmount: 0,
          totalReturns: 0, netPurchases: 0, totalPaid: 0,
        };
        rows.set(k, r);
      }
      return r;
    };

    for (const r of invAgg) {
      const row = ensure(r.supplierId ?? null);
      row.invoiceCount   += r.invoiceCount;
      row.totalPurchases += Number(r.totalPurchases);
      row.subtotal       += Number(r.subtotal);
      row.vatAmount      += Number(r.vatAmount);
    }
    for (const r of retAgg) {
      const row = ensure(r.supplierId ?? null);
      row.totalReturns += Number(r.totalReturns);
    }
    for (const r of payAgg) {
      const row = ensure(r.supplierId ?? null);
      row.totalPaid += Number(r.totalPaid);
    }
    rows.forEach(r => { r.netPurchases = r.totalPurchases - r.totalReturns; });
    res.json(Array.from(rows.values()).sort((a, b) => b.netPurchases - a.netPurchases));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/**
 * Purchase totals grouped by item (line-level aggregation across posted invoices).
 */
router.get("/by-item", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const bid = getBid(req);
    const { from, to } = req.query as Record<string, string>;
    const conds = [eq(purchaseInvoicesTable.companyId, cid), eq(purchaseInvoicesTable.status, "posted")];
    pushBranchScope(req, conds, purchaseInvoicesTable.branchId, bid);
    if (from) conds.push(gte(purchaseInvoicesTable.invoiceDate, from));
    if (to)   conds.push(lte(purchaseInvoicesTable.invoiceDate, to));

    const rows = await db
      .select({
        itemId:           purchaseInvoiceLinesTable.itemId,
        itemCode:         purchaseInvoiceLinesTable.itemCode,
        itemName:         purchaseInvoiceLinesTable.itemName,
        unit:             purchaseInvoiceLinesTable.unit,
        qty:              sql<string>`coalesce(sum(${purchaseInvoiceLinesTable.qty}), 0)`,
        totalPurchases:   sql<string>`coalesce(sum(${purchaseInvoiceLinesTable.lineTotal}), 0)`,
        invoiceCount:     sql<number>`count(distinct ${purchaseInvoiceLinesTable.invoiceId})::int`,
      })
      .from(purchaseInvoiceLinesTable)
      .innerJoin(purchaseInvoicesTable, eq(purchaseInvoiceLinesTable.invoiceId, purchaseInvoicesTable.id))
      .where(and(...conds))
      .groupBy(purchaseInvoiceLinesTable.itemId, purchaseInvoiceLinesTable.itemCode, purchaseInvoiceLinesTable.itemName, purchaseInvoiceLinesTable.unit);

    res.json(rows.map(r => ({
      itemId:         r.itemId,
      itemCode:       r.itemCode,
      itemName:       r.itemName,
      unit:           r.unit,
      qty:            Number(r.qty),
      totalPurchases: Number(r.totalPurchases),
      invoiceCount:   r.invoiceCount,
    })).sort((a, b) => b.totalPurchases - a.totalPurchases));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/**
 * Purchase totals grouped by period (day or month) — from posted invoices.
 */
router.get("/by-period", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const bid = getBid(req);
    const { from, to, groupBy } = req.query as Record<string, string>;
    const conds = [eq(purchaseInvoicesTable.companyId, cid), eq(purchaseInvoicesTable.status, "posted")];
    pushBranchScope(req, conds, purchaseInvoicesTable.branchId, bid);
    if (from) conds.push(gte(purchaseInvoicesTable.invoiceDate, from));
    if (to)   conds.push(lte(purchaseInvoicesTable.invoiceDate, to));

    const periodExpr = groupBy === "month"
      ? sql<string>`substring(${purchaseInvoicesTable.invoiceDate}, 1, 7)`
      : sql<string>`${purchaseInvoicesTable.invoiceDate}`;

    const rows = await db
      .select({
        period:       periodExpr,
        invoiceCount: sql<number>`count(*)::int`,
        subtotal:     sql<string>`coalesce(sum(${purchaseInvoicesTable.subtotal}), 0)`,
        vatAmount:    sql<string>`coalesce(sum(${purchaseInvoicesTable.vatAmount}), 0)`,
        totalAmount:  sql<string>`coalesce(sum(${purchaseInvoicesTable.totalAmount}), 0)`,
      })
      .from(purchaseInvoicesTable)
      .where(and(...conds))
      .groupBy(periodExpr)
      .orderBy(asc(periodExpr));

    res.json(rows.map(r => ({
      period: r.period,
      invoiceCount: r.invoiceCount,
      subtotal: Number(r.subtotal),
      vatAmount: Number(r.vatAmount),
      totalAmount: Number(r.totalAmount),
    })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/**
 * Supplier ledger: invoices (credit), returns (debit), payments (debit) with running balance.
 * Optional opening-balance carry from before "from" date.
 * NOTE: Supplier balance is a *liability* (payable) — invoices increase what we owe (credit),
 *       returns and payments decrease what we owe (debit).
 */
router.get("/supplier-statement", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json({ opening: 0, lines: [] }); return; }
    const bid = getBid(req);
    const { supplierId, from, to } = req.query as Record<string, string>;
    const sid = Number(supplierId);
    if (!supplierId || !Number.isFinite(sid)) { res.status(400).json({ error: "supplierId مطلوب ويجب أن يكون رقماً صحيحاً" }); return; }

    // Display-only suppliers — hide their balance from statement view.
    const [supMeta] = await db.select({ includeInStatements: suppliersTable.includeInStatements })
      .from(suppliersTable)
      .where(and(eq(suppliersTable.id, sid), eq(suppliersTable.companyId, cid)));
    if (supMeta && supMeta.includeInStatements === false) {
      res.json({ opening: 0, lines: [], excluded: true, reason: "display_only",
        message: "هذا المورد مُعلَّم «للعرض فقط» — أرصدته لا تظهر في كشوفات الحسابات." });
      return;
    }

    // Resolve the supplier's AP sub-account so we can pull direct JE postings
    // (fixed-asset credit acquisitions, manual JEs, opening balances, …) and
    // include them in the ledger.
    const [supRow] = await db.select({
        accountId: suppliersTable.accountId,
        includeInStatements: suppliersTable.includeInStatements,
      })
      .from(suppliersTable)
      .where(and(eq(suppliersTable.id, sid), eq(suppliersTable.companyId, cid)));
    if (supRow && supRow.includeInStatements === false) {
      res.json({ opening: 0, lines: [], excluded: true, reason: "display_only",
        message: "هذا المورد مُعلَّم «للعرض فقط» — أرصدته لا تظهر في كشوفات الحسابات." });
      return;
    }
    const supAccountId = supRow?.accountId ?? null;

    async function sumPriorTo(date: string | undefined) {
      if (!date) return 0;
      const [inv] = await db.select({ s: sql<string>`coalesce(sum(${purchaseInvoicesTable.totalAmount}), 0)` })
        .from(purchaseInvoicesTable)
        .where(and(
          eq(purchaseInvoicesTable.companyId, cid as number),
          eq(purchaseInvoicesTable.supplierId, sid),
          eq(purchaseInvoicesTable.status, "posted"),
          eq(purchaseInvoicesTable.paymentType, "credit"),
          // LC-linked invoices were paid by the Letter of Credit — exclude.
          sql`${purchaseInvoicesTable.lcId} IS NULL`,
          sql`${purchaseInvoicesTable.invoiceDate} < ${date}`,
          ...branchScopeSpread(req, purchaseInvoicesTable.branchId, bid),
        ));
      const [ret] = await db.select({ s: sql<string>`coalesce(sum(${purchaseReturnsTable.totalAmount}), 0)` })
        .from(purchaseReturnsTable)
        .where(and(
          eq(purchaseReturnsTable.companyId, cid as number),
          eq(purchaseReturnsTable.supplierId, sid),
          eq(purchaseReturnsTable.status, "posted"),
          eq(purchaseReturnsTable.paymentType, "credit"),
          sql`${purchaseReturnsTable.returnDate} < ${date}`,
          ...branchScopeSpread(req, purchaseReturnsTable.branchId, bid),
        ));
      const [pay] = await db.select({ s: sql<string>`coalesce(sum(${paymentVouchersTable.amount}), 0)` })
        .from(paymentVouchersTable)
        .where(and(
          eq(paymentVouchersTable.companyId, cid as number),
          eq(paymentVouchersTable.entityType, "supplier"),
          eq(paymentVouchersTable.entityId, sid),
          eq(paymentVouchersTable.status, "posted"),
          sql`${paymentVouchersTable.date} < ${date}`,
          ...branchScopeSpread(req, paymentVouchersTable.branchId, bid),
        ));
      // Direct JE net (credit - debit) before the from date.
      let jeNet = 0;
      if (supAccountId) {
        const [je] = await db
          .select({ s: sql<string>`coalesce(sum(${journalEntryLinesTable.credit} - ${journalEntryLinesTable.debit}), 0)` })
          .from(journalEntryLinesTable)
          .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
          .where(and(
            eq(journalEntriesTable.companyId, cid as number),
            eq(journalEntriesTable.status, "posted"),
            eq(journalEntryLinesTable.accountId, supAccountId),
            notInArray(journalEntriesTable.entryType, [...SUPPLIER_DOC_ENTRY_TYPES]),
            lt(journalEntriesTable.entryDate, date),
            ...branchScopeSpread(req, journalEntriesTable.branchId, bid),
          ));
        jeNet = Number(je.s);
      }
      return Number(inv.s) - Number(ret.s) - Number(pay.s) + jeNet;
    }

    const opening = await sumPriorTo(from);

    const invConds: any[] = [
      eq(purchaseInvoicesTable.companyId, cid),
      eq(purchaseInvoicesTable.supplierId, sid),
      eq(purchaseInvoicesTable.status, "posted"),
      eq(purchaseInvoicesTable.paymentType, "credit"),
      // LC-linked invoices excluded from supplier statement (paid via LC).
      sql`${purchaseInvoicesTable.lcId} IS NULL`,
    ];
    pushBranchScope(req, invConds, purchaseInvoicesTable.branchId, bid);
    if (from) invConds.push(gte(purchaseInvoicesTable.invoiceDate, from));
    if (to)   invConds.push(lte(purchaseInvoicesTable.invoiceDate, to));
    // "الرقم" = source-document number; "رقم القيد" = posted JE number.
    // Returned as separate fields so the UI can render them in two columns.
    const invs = await db.select({
      id: purchaseInvoicesTable.id, date: purchaseInvoicesTable.invoiceDate,
      docNumber: purchaseInvoicesTable.docNumber,
      journalEntryId: purchaseInvoicesTable.journalEntryId,
      journalEntryNumber: journalEntriesTable.docNumber,
      total: purchaseInvoicesTable.totalAmount,
      notes: purchaseInvoicesTable.notes,
    }).from(purchaseInvoicesTable)
      .leftJoin(journalEntriesTable, eq(journalEntriesTable.id, purchaseInvoicesTable.journalEntryId))
      .where(and(...invConds));

    const retConds: any[] = [
      eq(purchaseReturnsTable.companyId, cid),
      eq(purchaseReturnsTable.supplierId, sid),
      eq(purchaseReturnsTable.status, "posted"),
      eq(purchaseReturnsTable.paymentType, "credit"),
    ];
    pushBranchScope(req, retConds, purchaseReturnsTable.branchId, bid);
    if (from) retConds.push(gte(purchaseReturnsTable.returnDate, from));
    if (to)   retConds.push(lte(purchaseReturnsTable.returnDate, to));
    const rets = await db.select({
      id: purchaseReturnsTable.id, date: purchaseReturnsTable.returnDate,
      docNumber: purchaseReturnsTable.docNumber,
      journalEntryId: purchaseReturnsTable.journalEntryId,
      journalEntryNumber: journalEntriesTable.docNumber,
      total: purchaseReturnsTable.totalAmount,
      notes: purchaseReturnsTable.notes,
    }).from(purchaseReturnsTable)
      .leftJoin(journalEntriesTable, eq(journalEntriesTable.id, purchaseReturnsTable.journalEntryId))
      .where(and(...retConds));

    const payConds: any[] = [
      eq(paymentVouchersTable.companyId, cid),
      eq(paymentVouchersTable.entityType, "supplier"),
      eq(paymentVouchersTable.entityId, sid),
      eq(paymentVouchersTable.status, "posted"),
    ];
    pushBranchScope(req, payConds, paymentVouchersTable.branchId, bid);
    if (from) payConds.push(gte(paymentVouchersTable.date, from));
    if (to)   payConds.push(lte(paymentVouchersTable.date, to));
    const pays = await db.select({
      id: paymentVouchersTable.id, date: paymentVouchersTable.date,
      docNumber: paymentVouchersTable.code,
      journalEntryId: paymentVouchersTable.journalEntryId,
      journalEntryNumber: journalEntriesTable.docNumber,
      amount: paymentVouchersTable.amount,
      notes: paymentVouchersTable.notes,
    }).from(paymentVouchersTable)
      .leftJoin(journalEntriesTable, eq(journalEntriesTable.id, paymentVouchersTable.journalEntryId))
      .where(and(...payConds));

    // Direct JE rows (fixed-asset credit, manual JEs, …) within range.
    const jeLines = await fetchSupplierDirectJeLines(
      cid, supAccountId, from, to,
      branchScopeSpread(req, journalEntriesTable.branchId, bid),
    );

    // Compose the "البيان"/"الشرح" description: start with the generic label
    // and append the user-typed note from the source document when present
    // so the statement reflects whatever was written on the originating
    // purchase invoice / return / payment voucher.
    // Show ONLY the user-typed note in "الشرح" (the generic label was
    // dropped per user request — it duplicated "نوع الوثيقة"). Falls back
    // to em-dash when the source document has no note.
    const withNote = (_base: string, n?: string | null) =>
      n && String(n).trim() ? String(n).trim() : "—";

    // For supplier statements, invoices increase the payable (credit column),
    // returns and payments decrease it (debit column). Direct JE lines carry
    // their own debit/credit as posted.
    type Line = { id: number | null; date: string; type: string; docNumber: string | null; journalEntryId: number | null; journalEntryNumber: string | null; debit: number; credit: number; description: string };
    const lines: Line[] = [
      ...invs.map(i => ({ id: i.id, date: i.date, type: "invoice", docNumber: i.docNumber, journalEntryId: i.journalEntryId, journalEntryNumber: i.journalEntryNumber, debit: 0, credit: Number(i.total), description: withNote("فاتورة مشتريات آجلة", i.notes) })),
      ...rets.map(r => ({ id: r.id, date: r.date, type: "return",  docNumber: r.docNumber, journalEntryId: r.journalEntryId, journalEntryNumber: r.journalEntryNumber, debit: Number(r.total), credit: 0, description: withNote("مرتجع مشتريات", r.notes) })),
      ...pays.map(p => ({ id: p.id, date: p.date, type: "payment", docNumber: p.docNumber, journalEntryId: p.journalEntryId, journalEntryNumber: p.journalEntryNumber, debit: Number(p.amount), credit: 0, description: withNote("سند صرف", p.notes) })),
      ...jeLines.map(j => ({
        id: null, date: j.date, type: "journal", docNumber: null,
        journalEntryId: j.id, journalEntryNumber: j.docNumber,
        debit: j.debit, credit: j.credit,
        description: jeLineLabel(j.entryType, j.description),
      })),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));

    res.json({ opening, lines });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/**
 * Detailed supplier ledger — same chronological transactions as /supplier-statement,
 * but each invoice/return entry carries an embedded `lines[]` of item-level rows
 * (item code, qty, unit price, discount, vatAmount, line total). Payment vouchers
 * (سند صرف) carry a `meta` block (payment method, cash box / bank, reference).
 * Used by the "كشف حساب مورد تفصيلي" report.
 */
router.get("/supplier-statement-detailed", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json({ opening: 0, lines: [] }); return; }
    const bid = getBid(req);
    const { supplierId, from, to } = req.query as Record<string, string>;
    const sid = Number(supplierId);
    if (!supplierId || !Number.isFinite(sid)) {
      res.status(400).json({ error: "supplierId مطلوب ويجب أن يكون رقماً صحيحاً" });
      return;
    }

    const [supRow] = await db.select({
        accountId: suppliersTable.accountId,
        includeInStatements: suppliersTable.includeInStatements,
      })
      .from(suppliersTable)
      .where(and(eq(suppliersTable.id, sid), eq(suppliersTable.companyId, cid)));
    if (supRow && supRow.includeInStatements === false) {
      res.json({ opening: 0, lines: [], excluded: true, reason: "display_only",
        message: "هذا المورد مُعلَّم «للعرض فقط» — أرصدته لا تظهر في كشوفات الحسابات." });
      return;
    }
    const supAccountId = supRow?.accountId ?? null;

    async function sumPriorTo(date: string | undefined) {
      if (!date) return 0;
      const [inv] = await db.select({ s: sql<string>`coalesce(sum(${purchaseInvoicesTable.totalAmount}), 0)` })
        .from(purchaseInvoicesTable)
        .where(and(
          eq(purchaseInvoicesTable.companyId, cid as number),
          eq(purchaseInvoicesTable.supplierId, sid),
          eq(purchaseInvoicesTable.status, "posted"),
          eq(purchaseInvoicesTable.paymentType, "credit"),
          // LC-linked invoices excluded — supplier was paid via the LC.
          sql`${purchaseInvoicesTable.lcId} IS NULL`,
          sql`${purchaseInvoicesTable.invoiceDate} < ${date}`,
          ...branchScopeSpread(req, purchaseInvoicesTable.branchId, bid),
        ));
      const [ret] = await db.select({ s: sql<string>`coalesce(sum(${purchaseReturnsTable.totalAmount}), 0)` })
        .from(purchaseReturnsTable)
        .where(and(
          eq(purchaseReturnsTable.companyId, cid as number),
          eq(purchaseReturnsTable.supplierId, sid),
          eq(purchaseReturnsTable.status, "posted"),
          eq(purchaseReturnsTable.paymentType, "credit"),
          sql`${purchaseReturnsTable.returnDate} < ${date}`,
          ...branchScopeSpread(req, purchaseReturnsTable.branchId, bid),
        ));
      const [pay] = await db.select({ s: sql<string>`coalesce(sum(${paymentVouchersTable.amount}), 0)` })
        .from(paymentVouchersTable)
        .where(and(
          eq(paymentVouchersTable.companyId, cid as number),
          eq(paymentVouchersTable.entityType, "supplier"),
          eq(paymentVouchersTable.entityId, sid),
          eq(paymentVouchersTable.status, "posted"),
          sql`${paymentVouchersTable.date} < ${date}`,
          ...branchScopeSpread(req, paymentVouchersTable.branchId, bid),
        ));
      let jeNet = 0;
      if (supAccountId) {
        const [je] = await db
          .select({ s: sql<string>`coalesce(sum(${journalEntryLinesTable.credit} - ${journalEntryLinesTable.debit}), 0)` })
          .from(journalEntryLinesTable)
          .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
          .where(and(
            eq(journalEntriesTable.companyId, cid as number),
            eq(journalEntriesTable.status, "posted"),
            eq(journalEntryLinesTable.accountId, supAccountId),
            notInArray(journalEntriesTable.entryType, [...SUPPLIER_DOC_ENTRY_TYPES]),
            lt(journalEntriesTable.entryDate, date),
            ...branchScopeSpread(req, journalEntriesTable.branchId, bid),
          ));
        jeNet = Number(je.s);
      }
      return Number(inv.s) - Number(ret.s) - Number(pay.s) + jeNet;
    }
    const opening = await sumPriorTo(from);

    // DETAILED report shows EVERY posted purchase invoice/return — cash, bank
    // and credit — not just open A/P. Cash/bank docs render with debit = credit
    // so the running A/P balance stays accurate (they self-settle at point of
    // purchase) while still letting users drill into line items.
    const invConds: any[] = [
      eq(purchaseInvoicesTable.companyId, cid),
      eq(purchaseInvoicesTable.supplierId, sid),
      eq(purchaseInvoicesTable.status, "posted"),
      // LC-linked invoices excluded — supplier was paid via the LC, so they
      // must not appear in the supplier ledger.
      sql`${purchaseInvoicesTable.lcId} IS NULL`,
    ];
    pushBranchScope(req, invConds, purchaseInvoicesTable.branchId, bid);
    if (from) invConds.push(gte(purchaseInvoicesTable.invoiceDate, from));
    if (to)   invConds.push(lte(purchaseInvoicesTable.invoiceDate, to));
    const invs = await db.select({
      id: purchaseInvoicesTable.id, date: purchaseInvoicesTable.invoiceDate,
      docNumber: purchaseInvoicesTable.docNumber, total: purchaseInvoicesTable.totalAmount,
      subtotal: purchaseInvoicesTable.subtotal, vatAmount: purchaseInvoicesTable.vatAmount,
      discountAmount: purchaseInvoicesTable.discountAmount,
      priceIncludesVat: purchaseInvoicesTable.priceIncludesVat,
      paymentType: purchaseInvoicesTable.paymentType,
    }).from(purchaseInvoicesTable).where(and(...invConds));

    const retConds: any[] = [
      eq(purchaseReturnsTable.companyId, cid),
      eq(purchaseReturnsTable.supplierId, sid),
      eq(purchaseReturnsTable.status, "posted"),
    ];
    pushBranchScope(req, retConds, purchaseReturnsTable.branchId, bid);
    if (from) retConds.push(gte(purchaseReturnsTable.returnDate, from));
    if (to)   retConds.push(lte(purchaseReturnsTable.returnDate, to));
    const rets = await db.select({
      id: purchaseReturnsTable.id, date: purchaseReturnsTable.returnDate,
      docNumber: purchaseReturnsTable.docNumber, total: purchaseReturnsTable.totalAmount,
      vatAmount: purchaseReturnsTable.vatAmount, discountAmount: purchaseReturnsTable.discountAmount,
      priceIncludesVat: purchaseReturnsTable.priceIncludesVat,
      paymentType: purchaseReturnsTable.paymentType,
    }).from(purchaseReturnsTable).where(and(...retConds));

    const payConds: any[] = [
      eq(paymentVouchersTable.companyId, cid),
      eq(paymentVouchersTable.entityType, "supplier"),
      eq(paymentVouchersTable.entityId, sid),
      eq(paymentVouchersTable.status, "posted"),
    ];
    pushBranchScope(req, payConds, paymentVouchersTable.branchId, bid);
    if (from) payConds.push(gte(paymentVouchersTable.date, from));
    if (to)   payConds.push(lte(paymentVouchersTable.date, to));
    const pays = await db.select({
      id: paymentVouchersTable.id, date: paymentVouchersTable.date,
      docNumber: paymentVouchersTable.code, amount: paymentVouchersTable.amount,
      paymentType: paymentVouchersTable.paymentType,
      cashBoxId: paymentVouchersTable.cashBoxId,
      bankAccountId: paymentVouchersTable.bankAccountId,
      refNumber: paymentVouchersTable.refNumber,
      description: paymentVouchersTable.description,
    }).from(paymentVouchersTable).where(and(...payConds));

    const invIds = invs.map(i => i.id);
    const retIds = rets.map(r => r.id);

    const invLines = invIds.length
      ? await db.select({
          invoiceId: purchaseInvoiceLinesTable.invoiceId,
          itemCode:  purchaseInvoiceLinesTable.itemCode,
          itemName:  purchaseInvoiceLinesTable.itemName,
          unit:      purchaseInvoiceLinesTable.unit,
          qty:       purchaseInvoiceLinesTable.qty,
          unitPrice: purchaseInvoiceLinesTable.unitPrice,
          discount:  purchaseInvoiceLinesTable.discount,
          vatRate:   purchaseInvoiceLinesTable.vatRate,
          lineTotal: purchaseInvoiceLinesTable.lineTotal,
        }).from(purchaseInvoiceLinesTable)
        .where(inArray(purchaseInvoiceLinesTable.invoiceId, invIds))
      : [];

    const retLines = retIds.length
      ? await db.select({
          returnId:  purchaseReturnLinesTable.returnId,
          itemCode:  purchaseReturnLinesTable.itemCode,
          itemName:  purchaseReturnLinesTable.itemName,
          unit:      purchaseReturnLinesTable.unit,
          qty:       purchaseReturnLinesTable.qty,
          unitPrice: purchaseReturnLinesTable.unitPrice,
          discount:  purchaseReturnLinesTable.discount,
          vatRate:   purchaseReturnLinesTable.vatRate,
          lineTotal: purchaseReturnLinesTable.lineTotal,
        }).from(purchaseReturnLinesTable)
        .where(inArray(purchaseReturnLinesTable.returnId, retIds))
      : [];

    const cbIds  = Array.from(new Set(pays.map(p => p.cashBoxId).filter((x): x is number => !!x)));
    const baIds  = Array.from(new Set(pays.map(p => p.bankAccountId).filter((x): x is number => !!x)));
    // cash_boxes / bank_accounts store names in name_ar / name_en (no plain `name`).
    // Prefer Arabic, fall back to English so legacy rows always render.
    const cbRows = cbIds.length
      ? await db.select({ id: cashBoxesTable.id, nameAr: cashBoxesTable.nameAr, nameEn: cashBoxesTable.nameEn })
          .from(cashBoxesTable).where(inArray(cashBoxesTable.id, cbIds))
      : [];
    const baRows = baIds.length
      ? await db.select({ id: bankAccountsTable.id, nameAr: bankAccountsTable.nameAr, nameEn: bankAccountsTable.nameEn })
          .from(bankAccountsTable).where(inArray(bankAccountsTable.id, baIds))
      : [];
    const cbName = new Map(cbRows.map(r => [r.id, r.nameAr || r.nameEn || ""]));
    const baName = new Map(baRows.map(r => [r.id, r.nameAr || r.nameEn || ""]));

    function groupLines(rows: any[], parentKey: string, parents: Map<number, { priceIncludesVat: boolean | null }>) {
      const map = new Map<number, any[]>();
      for (const row of rows) {
        const parentId = row[parentKey] as number;
        const piv = !!parents.get(parentId)?.priceIncludesVat;
        const qty   = Number(row.qty || 0);
        const price = Number(row.unitPrice || 0);
        const disc  = Number(row.discount || 0);
        const rate  = Number(row.vatRate || 0);
        const gross = qty * price;
        const afterDisc = gross - disc;
        let net: number, vat: number;
        if (piv) { net = rate ? afterDisc / (1 + rate / 100) : afterDisc; vat = afterDisc - net; }
        else     { net = afterDisc; vat = net * rate / 100; }
        const arr = map.get(parentId) ?? [];
        arr.push({
          itemCode: row.itemCode ?? null,
          itemName: row.itemName,
          unit:     row.unit ?? null,
          qty,
          unitPrice: price,
          discount:  disc,
          vatRate:   rate,
          vatAmount: Number(vat.toFixed(2)),
          netAmount: Number(net.toFixed(2)),
          lineTotal: Number(row.lineTotal || 0),
        });
        map.set(parentId, arr);
      }
      return map;
    }
    const invParents = new Map(invs.map(i => [i.id, { priceIncludesVat: i.priceIncludesVat }]));
    const retParents = new Map(rets.map(r => [r.id, { priceIncludesVat: r.priceIncludesVat }]));
    const invLineMap = groupLines(invLines, "invoiceId", invParents);
    const retLineMap = groupLines(retLines, "returnId", retParents);

    // Supplier ledger sign convention: invoice = credit (we owe more), return /
    // payment = debit (we owe less). Cash/bank invoices and returns set debit =
    // credit = total so the running A/P balance is unchanged (they self-settle),
    // while the user still sees the full transaction with line drilldown.
    type DetailedLine = {
      id: number; date: string; type: string; docNumber: string | null;
      debit: number; credit: number; description: string;
      paymentType?: string | null;
      lines?: any[]; meta?: any;
      vatAmount?: number; discountAmount?: number;
    };
    const invDesc = (pt: string | null) =>
      pt === "credit" ? "فاتورة مشتريات آجلة"
      : pt === "bank" ? "فاتورة مشتريات (تحويل بنكي)"
      : "فاتورة مشتريات نقدية";
    const retDesc = (pt: string | null) =>
      pt === "credit" ? "مرتجع مشتريات آجل"
      : pt === "bank" ? "مرتجع مشتريات (مرتجع بنكياً)"
      : "مرتجع مشتريات نقدي";
    const lines: DetailedLine[] = [
      ...invs.map(i => {
        const total = Number(i.total);
        const isCredit = i.paymentType === "credit";
        return {
          id: i.id, date: i.date, type: "invoice", docNumber: i.docNumber,
          debit: isCredit ? 0 : total,
          credit: total,
          description: invDesc(i.paymentType),
          paymentType: i.paymentType,
          vatAmount: Number(i.vatAmount || 0),
          discountAmount: Number(i.discountAmount || 0),
          lines: invLineMap.get(i.id) ?? [],
        };
      }),
      ...rets.map(r => {
        const total = Number(r.total);
        const isCredit = r.paymentType === "credit";
        return {
          id: r.id, date: r.date, type: "return", docNumber: r.docNumber,
          debit: total,
          credit: isCredit ? 0 : total,
          description: retDesc(r.paymentType),
          paymentType: r.paymentType,
          vatAmount: Number(r.vatAmount || 0),
          discountAmount: Number(r.discountAmount || 0),
          lines: retLineMap.get(r.id) ?? [],
        };
      }),
      ...pays.map(p => ({
        id: p.id, date: p.date, type: "payment", docNumber: p.docNumber,
        debit: Number(p.amount), credit: 0, description: "سند صرف",
        paymentType: p.paymentType,
        meta: {
          paymentType: p.paymentType,
          cashBoxName: p.cashBoxId ? (cbName.get(p.cashBoxId) ?? null) : null,
          bankAccountName: p.bankAccountId ? (baName.get(p.bankAccountId) ?? null) : null,
          refNumber: p.refNumber,
          description: p.description,
        },
      })),
      ...(await fetchSupplierDirectJeLines(
        cid, supAccountId, from, to,
        branchScopeSpread(req, journalEntriesTable.branchId, bid),
      )).map(j => ({
        id: j.id, date: j.date, type: "journal", docNumber: j.docNumber,
        debit: j.debit, credit: j.credit,
        description: jeLineLabel(j.entryType, j.description),
        paymentType: null,
        meta: { entryType: j.entryType, description: j.description },
      })),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));

    res.json({ opening, lines });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/**
 * Supplier aging: bucket the *outstanding* payable by invoice age using FIFO payment application.
 */
router.get("/aging", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const bid = getBid(req);
    const asOf = (req.query.asOf as string) || new Date().toISOString().slice(0, 10);

    const suppliers = await db.select().from(suppliersTable)
      .where(and(
        eq(suppliersTable.companyId, cid),
        // Display-only suppliers are intentionally excluded from aging.
        eq(suppliersTable.includeInStatements, true),
      ));

    const invs = await db
      .select({
        supplierId: purchaseInvoicesTable.supplierId,
        date:       purchaseInvoicesTable.invoiceDate,
        total:      purchaseInvoicesTable.totalAmount,
      })
      .from(purchaseInvoicesTable)
      .where(and(
        eq(purchaseInvoicesTable.companyId, cid),
        eq(purchaseInvoicesTable.status, "posted"),
        eq(purchaseInvoicesTable.paymentType, "credit"),
        // LC-linked invoices were paid by the Letter of Credit, not by the
        // supplier's A/P, so they must NOT appear in aging.
        sql`${purchaseInvoicesTable.lcId} IS NULL`,
        lte(purchaseInvoicesTable.invoiceDate, asOf),
        ...branchScopeSpread(req, purchaseInvoicesTable.branchId, bid),
      ))
      .orderBy(asc(purchaseInvoicesTable.invoiceDate), asc(purchaseInvoicesTable.id));

    const retAgg = await db
      .select({
        supplierId: purchaseReturnsTable.supplierId,
        total: sql<string>`coalesce(sum(${purchaseReturnsTable.totalAmount}), 0)`,
      })
      .from(purchaseReturnsTable)
      .where(and(
        eq(purchaseReturnsTable.companyId, cid),
        eq(purchaseReturnsTable.status, "posted"),
        eq(purchaseReturnsTable.paymentType, "credit"),
        lte(purchaseReturnsTable.returnDate, asOf),
        ...branchScopeSpread(req, purchaseReturnsTable.branchId, bid),
      ))
      .groupBy(purchaseReturnsTable.supplierId);

    const payAgg = await db
      .select({
        supplierId: paymentVouchersTable.entityId,
        total: sql<string>`coalesce(sum(${paymentVouchersTable.amount}), 0)`,
      })
      .from(paymentVouchersTable)
      .where(and(
        eq(paymentVouchersTable.companyId, cid),
        eq(paymentVouchersTable.entityType, "supplier"),
        eq(paymentVouchersTable.status, "posted"),
        lte(paymentVouchersTable.date, asOf),
        ...branchScopeSpread(req, paymentVouchersTable.branchId, bid),
      ))
      .groupBy(paymentVouchersTable.entityId);

    const debitBySupplier: Record<number, number> = {};
    for (const r of retAgg) if (r.supplierId) debitBySupplier[r.supplierId] = (debitBySupplier[r.supplierId] ?? 0) + Number(r.total);
    for (const r of payAgg) if (r.supplierId) debitBySupplier[r.supplierId] = (debitBySupplier[r.supplierId] ?? 0) + Number(r.total);

    const invBySupplier: Record<number, { date: string; total: number }[]> = {};
    for (const i of invs) {
      if (!i.supplierId) continue;
      (invBySupplier[i.supplierId] ??= []).push({ date: i.date, total: Number(i.total) });
    }

    const today = new Date(asOf);
    const dayDiff = (d: string) => Math.floor((today.getTime() - new Date(d).getTime()) / 86400000);

    const result = suppliers.map(s => {
      const invList = invBySupplier[s.id] ?? [];
      let credit = debitBySupplier[s.id] ?? 0;
      const remaining = invList.map(i => {
        if (credit <= 0) return i;
        if (credit >= i.total) { credit -= i.total; return { ...i, total: 0 }; }
        const t = i.total - credit; credit = 0; return { ...i, total: t };
      });
      let current = 0, d30 = 0, d60 = 0, d90 = 0, d90plus = 0;
      for (const i of remaining) {
        if (i.total <= 0) continue;
        const days = dayDiff(i.date);
        if (days <= 30) current += i.total;
        else if (days <= 60) d30 += i.total;
        else if (days <= 90) d60 += i.total;
        else if (days <= 120) d90 += i.total;
        else d90plus += i.total;
      }
      const total = current + d30 + d60 + d90 + d90plus;
      if (credit > 0 && remaining.every(r => r.total <= 0)) {
        return {
          supplierId: s.id, supplierNameAr: s.nameAr, supplierNameEn: s.nameEn ?? null,
          phone: s.phone ?? null,
          current: -credit, d30: 0, d60: 0, d90: 0, d90plus: 0, total: -credit,
        };
      }
      return {
        supplierId: s.id, supplierNameAr: s.nameAr, supplierNameEn: s.nameEn ?? null,
        phone: s.phone ?? null,
        current, d30, d60, d90, d90plus, total,
      };
    }).filter(r => Math.abs(r.total) > 0.005);

    res.json(result.sort((a, b) => Math.abs(b.total) - Math.abs(a.total)));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/**
 * Purchase returns aggregate per supplier within a date range.
 */
router.get("/returns-by-supplier", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const bid = getBid(req);
    const { from, to } = req.query as Record<string, string>;
    const conds = [eq(purchaseReturnsTable.companyId, cid), eq(purchaseReturnsTable.status, "posted")];
    pushBranchScope(req, conds, purchaseReturnsTable.branchId, bid);
    if (from) conds.push(gte(purchaseReturnsTable.returnDate, from));
    if (to)   conds.push(lte(purchaseReturnsTable.returnDate, to));
    const agg = await db
      .select({
        supplierId:  purchaseReturnsTable.supplierId,
        returnCount: sql<number>`count(*)::int`,
        totalAmount: sql<string>`coalesce(sum(${purchaseReturnsTable.totalAmount}), 0)`,
        totalVat:    sql<string>`coalesce(sum(${purchaseReturnsTable.vatAmount}), 0)`,
      })
      .from(purchaseReturnsTable)
      .where(and(...conds))
      .groupBy(purchaseReturnsTable.supplierId);

    const suppliers = await db.select().from(suppliersTable).where(eq(suppliersTable.companyId, cid));
    const smap = new Map(suppliers.map(s => [s.id, s]));
    res.json(agg.map(r => {
      const s = r.supplierId ? smap.get(r.supplierId) : null;
      return {
        supplierId: r.supplierId,
        supplierNameAr: s?.nameAr ?? "بدون مورد",
        supplierNameEn: s?.nameEn ?? null,
        returnCount: r.returnCount,
        totalAmount: Number(r.totalAmount),
        totalVat:    Number(r.totalVat),
      };
    }).sort((a, b) => b.totalAmount - a.totalAmount));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
