import { Router } from "express";
import { db } from "@workspace/db";
import {
  customersTable,
  salesInvoicesTable, salesInvoiceLinesTable,
  salesReturnsTable,  salesReturnLinesTable,
  receiptVouchersTable,
  salesRepsTable,
  branchesTable,
  cashBoxesTable,
  bankAccountsTable,
} from "@workspace/db";
import { and, eq, sql, gte, lte, asc, desc, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId, pushBranchScope, branchScopeSpread } from "../middleware/auth.js";

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
 * Sales totals grouped by customer (posted invoices and returns within a date range).
 * Includes total receipts collected from each customer in the same range.
 */
router.get("/by-customer", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const bid = getBid(req);
    const { from, to } = req.query as Record<string, string>;

    const invConds = [eq(salesInvoicesTable.companyId, cid), eq(salesInvoicesTable.status, "posted")];
    pushBranchScope(req, invConds, salesInvoicesTable.branchId, bid);
    if (from) invConds.push(gte(salesInvoicesTable.invoiceDate, from));
    if (to)   invConds.push(lte(salesInvoicesTable.invoiceDate, to));

    const invAgg = await db
      .select({
        customerId: salesInvoicesTable.customerId,
        invoiceCount: sql<number>`count(*)::int`,
        totalSales:   sql<string>`coalesce(sum(${salesInvoicesTable.totalAmount}), 0)`,
        subtotal:     sql<string>`coalesce(sum(${salesInvoicesTable.subtotal}), 0)`,
        vatAmount:    sql<string>`coalesce(sum(${salesInvoicesTable.vatAmount}), 0)`,
      })
      .from(salesInvoicesTable)
      .where(and(...invConds))
      .groupBy(salesInvoicesTable.customerId);

    const retConds = [eq(salesReturnsTable.companyId, cid), eq(salesReturnsTable.status, "posted")];
    pushBranchScope(req, retConds, salesReturnsTable.branchId, bid);
    if (from) retConds.push(gte(salesReturnsTable.returnDate, from));
    if (to)   retConds.push(lte(salesReturnsTable.returnDate, to));

    const retAgg = await db
      .select({
        customerId: salesReturnsTable.customerId,
        totalReturns: sql<string>`coalesce(sum(${salesReturnsTable.totalAmount}), 0)`,
      })
      .from(salesReturnsTable)
      .where(and(...retConds))
      .groupBy(salesReturnsTable.customerId);

    const recConds = [
      eq(receiptVouchersTable.companyId, cid),
      eq(receiptVouchersTable.status, "posted"),
      eq(receiptVouchersTable.entityType, "customer"),
    ];
    pushBranchScope(req, recConds, receiptVouchersTable.branchId, bid);
    if (from) recConds.push(gte(receiptVouchersTable.date, from));
    if (to)   recConds.push(lte(receiptVouchersTable.date, to));
    const recAgg = await db
      .select({
        customerId: receiptVouchersTable.entityId,
        totalPaid: sql<string>`coalesce(sum(${receiptVouchersTable.amount}), 0)`,
      })
      .from(receiptVouchersTable)
      .where(and(...recConds))
      .groupBy(receiptVouchersTable.entityId);

    const customers = await db.select().from(customersTable).where(eq(customersTable.companyId, cid));
    const cmap = new Map(customers.map(c => [c.id, c]));

    type Row = {
      customerId: number | null;
      customerNameAr: string;
      customerNameEn: string | null;
      invoiceCount: number;
      totalSales: number;
      subtotal: number;
      vatAmount: number;
      totalReturns: number;
      netSales: number;
      totalPaid: number;
    };
    const rows = new Map<number | string, Row>();
    const keyOf = (id: number | null) => id ?? "__no_customer__";
    const ensure = (id: number | null): Row => {
      const k = keyOf(id);
      let r = rows.get(k);
      if (!r) {
        const c = id ? cmap.get(id) : null;
        r = {
          customerId: id,
          customerNameAr: c?.nameAr ?? "بدون عميل",
          customerNameEn: c?.nameEn ?? null,
          invoiceCount: 0, totalSales: 0, subtotal: 0, vatAmount: 0,
          totalReturns: 0, netSales: 0, totalPaid: 0,
        };
        rows.set(k, r);
      }
      return r;
    };

    for (const r of invAgg) {
      const row = ensure(r.customerId ?? null);
      row.invoiceCount += r.invoiceCount;
      row.totalSales   += Number(r.totalSales);
      row.subtotal     += Number(r.subtotal);
      row.vatAmount    += Number(r.vatAmount);
    }
    for (const r of retAgg) {
      const row = ensure(r.customerId ?? null);
      row.totalReturns += Number(r.totalReturns);
    }
    for (const r of recAgg) {
      const row = ensure(r.customerId ?? null);
      row.totalPaid += Number(r.totalPaid);
    }
    rows.forEach(r => { r.netSales = r.totalSales - r.totalReturns; });
    res.json(Array.from(rows.values()).sort((a, b) => b.netSales - a.netSales));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/**
 * Sales totals grouped by item (line-level aggregation across posted invoices).
 */
router.get("/by-item", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const bid = getBid(req);
    const { from, to } = req.query as Record<string, string>;
    const conds = [eq(salesInvoicesTable.companyId, cid), eq(salesInvoicesTable.status, "posted")];
    pushBranchScope(req, conds, salesInvoicesTable.branchId, bid);
    if (from) conds.push(gte(salesInvoicesTable.invoiceDate, from));
    if (to)   conds.push(lte(salesInvoicesTable.invoiceDate, to));

    const rows = await db
      .select({
        itemId:       salesInvoiceLinesTable.itemId,
        itemCode:     salesInvoiceLinesTable.itemCode,
        itemName:     salesInvoiceLinesTable.itemName,
        unit:         salesInvoiceLinesTable.unit,
        qty:          sql<string>`coalesce(sum(${salesInvoiceLinesTable.qty}), 0)`,
        totalSales:   sql<string>`coalesce(sum(${salesInvoiceLinesTable.lineTotal}), 0)`,
        invoiceCount: sql<number>`count(distinct ${salesInvoiceLinesTable.invoiceId})::int`,
      })
      .from(salesInvoiceLinesTable)
      .innerJoin(salesInvoicesTable, eq(salesInvoiceLinesTable.invoiceId, salesInvoicesTable.id))
      .where(and(...conds))
      .groupBy(salesInvoiceLinesTable.itemId, salesInvoiceLinesTable.itemCode, salesInvoiceLinesTable.itemName, salesInvoiceLinesTable.unit);

    res.json(rows.map(r => ({
      itemId:       r.itemId,
      itemCode:     r.itemCode,
      itemName:     r.itemName,
      unit:         r.unit,
      qty:          Number(r.qty),
      totalSales:   Number(r.totalSales),
      invoiceCount: r.invoiceCount,
    })).sort((a, b) => b.totalSales - a.totalSales));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/**
 * Sales totals grouped by period (day or month) — from posted invoices.
 */
router.get("/by-period", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const bid = getBid(req);
    const { from, to, groupBy } = req.query as Record<string, string>;
    const conds = [eq(salesInvoicesTable.companyId, cid), eq(salesInvoicesTable.status, "posted")];
    pushBranchScope(req, conds, salesInvoicesTable.branchId, bid);
    if (from) conds.push(gte(salesInvoicesTable.invoiceDate, from));
    if (to)   conds.push(lte(salesInvoicesTable.invoiceDate, to));

    // Use a SQL substring expression for month grouping; default to day.
    const periodExpr = groupBy === "month"
      ? sql<string>`substring(${salesInvoicesTable.invoiceDate}, 1, 7)`  // YYYY-MM
      : sql<string>`${salesInvoicesTable.invoiceDate}`;                  // YYYY-MM-DD

    const rows = await db
      .select({
        period:       periodExpr,
        invoiceCount: sql<number>`count(*)::int`,
        subtotal:     sql<string>`coalesce(sum(${salesInvoicesTable.subtotal}), 0)`,
        vatAmount:    sql<string>`coalesce(sum(${salesInvoicesTable.vatAmount}), 0)`,
        totalAmount:  sql<string>`coalesce(sum(${salesInvoicesTable.totalAmount}), 0)`,
      })
      .from(salesInvoicesTable)
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
 * Customer ledger: invoices (debit), returns (credit), receipts (credit) with running balance.
 * Optional opening-balance carry from before "from" date.
 */
router.get("/customer-statement", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json({ opening: 0, lines: [] }); return; }
    const bid = getBid(req);
    const { customerId, from, to } = req.query as Record<string, string>;
    const ccid = Number(customerId);
    if (!customerId || !Number.isFinite(ccid)) { res.status(400).json({ error: "customerId مطلوب ويجب أن يكون رقماً صحيحاً" }); return; }

    async function sumPriorTo(date: string | undefined) {
      if (!date) return 0;
      const [inv] = await db.select({ s: sql<string>`coalesce(sum(${salesInvoicesTable.totalAmount}), 0)` })
        .from(salesInvoicesTable)
        .where(and(
          eq(salesInvoicesTable.companyId, cid as number),
          eq(salesInvoicesTable.customerId, ccid),
          eq(salesInvoicesTable.status, "posted"),
          eq(salesInvoicesTable.paymentType, "credit"),
          sql`${salesInvoicesTable.invoiceDate} < ${date}`,
          ...branchScopeSpread(req, salesInvoicesTable.branchId, bid),
        ));
      const [ret] = await db.select({ s: sql<string>`coalesce(sum(${salesReturnsTable.totalAmount}), 0)` })
        .from(salesReturnsTable)
        .where(and(
          eq(salesReturnsTable.companyId, cid as number),
          eq(salesReturnsTable.customerId, ccid),
          eq(salesReturnsTable.status, "posted"),
          eq(salesReturnsTable.paymentType, "credit"),
          sql`${salesReturnsTable.returnDate} < ${date}`,
          ...branchScopeSpread(req, salesReturnsTable.branchId, bid),
        ));
      const [rec] = await db.select({ s: sql<string>`coalesce(sum(${receiptVouchersTable.amount}), 0)` })
        .from(receiptVouchersTable)
        .where(and(
          eq(receiptVouchersTable.companyId, cid as number),
          eq(receiptVouchersTable.entityType, "customer"),
          eq(receiptVouchersTable.entityId, ccid),
          eq(receiptVouchersTable.status, "posted"),
          sql`${receiptVouchersTable.date} < ${date}`,
          ...branchScopeSpread(req, receiptVouchersTable.branchId, bid),
        ));
      return Number(inv.s) - Number(ret.s) - Number(rec.s);
    }

    const opening = await sumPriorTo(from);

    const invConds: any[] = [
      eq(salesInvoicesTable.companyId, cid),
      eq(salesInvoicesTable.customerId, ccid),
      eq(salesInvoicesTable.status, "posted"),
      eq(salesInvoicesTable.paymentType, "credit"),
    ];
    pushBranchScope(req, invConds, salesInvoicesTable.branchId, bid);
    if (from) invConds.push(gte(salesInvoicesTable.invoiceDate, from));
    if (to)   invConds.push(lte(salesInvoicesTable.invoiceDate, to));
    const invs = await db.select({
      id: salesInvoicesTable.id, date: salesInvoicesTable.invoiceDate,
      docNumber: salesInvoicesTable.docNumber, total: salesInvoicesTable.totalAmount,
    }).from(salesInvoicesTable).where(and(...invConds));

    const retConds: any[] = [
      eq(salesReturnsTable.companyId, cid),
      eq(salesReturnsTable.customerId, ccid),
      eq(salesReturnsTable.status, "posted"),
      eq(salesReturnsTable.paymentType, "credit"),
    ];
    pushBranchScope(req, retConds, salesReturnsTable.branchId, bid);
    if (from) retConds.push(gte(salesReturnsTable.returnDate, from));
    if (to)   retConds.push(lte(salesReturnsTable.returnDate, to));
    const rets = await db.select({
      id: salesReturnsTable.id, date: salesReturnsTable.returnDate,
      docNumber: salesReturnsTable.docNumber, total: salesReturnsTable.totalAmount,
    }).from(salesReturnsTable).where(and(...retConds));

    const recConds: any[] = [
      eq(receiptVouchersTable.companyId, cid),
      eq(receiptVouchersTable.entityType, "customer"),
      eq(receiptVouchersTable.entityId, ccid),
      eq(receiptVouchersTable.status, "posted"),
    ];
    pushBranchScope(req, recConds, receiptVouchersTable.branchId, bid);
    if (from) recConds.push(gte(receiptVouchersTable.date, from));
    if (to)   recConds.push(lte(receiptVouchersTable.date, to));
    const recs = await db.select({
      id: receiptVouchersTable.id, date: receiptVouchersTable.date,
      docNumber: receiptVouchersTable.code, amount: receiptVouchersTable.amount,
    }).from(receiptVouchersTable).where(and(...recConds));

    type Line = { date: string; type: string; docNumber: string | null; debit: number; credit: number; description: string };
    const lines: Line[] = [
      ...invs.map(i => ({ date: i.date, type: "invoice", docNumber: i.docNumber, debit: Number(i.total), credit: 0, description: "فاتورة مبيعات آجلة" })),
      ...rets.map(r => ({ date: r.date, type: "return",  docNumber: r.docNumber, debit: 0, credit: Number(r.total), description: "مرتجع مبيعات" })),
      ...recs.map(r => ({ date: r.date, type: "receipt", docNumber: r.docNumber, debit: 0, credit: Number(r.amount), description: "سند قبض" })),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));

    res.json({ opening, lines });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/**
 * Detailed customer ledger — same chronological transactions as /customer-statement,
 * but each invoice/return entry carries an embedded `lines[]` of item-level rows
 * (item code, qty, unit price, discount, vatAmount, line total). Receipts carry
 * a `meta` block (payment method, cash box / bank, reference). Used by the
 * "كشف حساب عميل تفصيلي" report so users can audit *what* was sold/returned in
 * each transaction without leaving the ledger.
 */
router.get("/customer-statement-detailed", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json({ opening: 0, lines: [] }); return; }
    const bid = getBid(req);
    const { customerId, from, to } = req.query as Record<string, string>;
    const ccid = Number(customerId);
    if (!customerId || !Number.isFinite(ccid)) {
      res.status(400).json({ error: "customerId مطلوب ويجب أن يكون رقماً صحيحاً" });
      return;
    }

    // Opening balance carry — identical to /customer-statement.
    async function sumPriorTo(date: string | undefined) {
      if (!date) return 0;
      const [inv] = await db.select({ s: sql<string>`coalesce(sum(${salesInvoicesTable.totalAmount}), 0)` })
        .from(salesInvoicesTable)
        .where(and(
          eq(salesInvoicesTable.companyId, cid as number),
          eq(salesInvoicesTable.customerId, ccid),
          eq(salesInvoicesTable.status, "posted"),
          eq(salesInvoicesTable.paymentType, "credit"),
          sql`${salesInvoicesTable.invoiceDate} < ${date}`,
          ...branchScopeSpread(req, salesInvoicesTable.branchId, bid),
        ));
      const [ret] = await db.select({ s: sql<string>`coalesce(sum(${salesReturnsTable.totalAmount}), 0)` })
        .from(salesReturnsTable)
        .where(and(
          eq(salesReturnsTable.companyId, cid as number),
          eq(salesReturnsTable.customerId, ccid),
          eq(salesReturnsTable.status, "posted"),
          eq(salesReturnsTable.paymentType, "credit"),
          sql`${salesReturnsTable.returnDate} < ${date}`,
          ...branchScopeSpread(req, salesReturnsTable.branchId, bid),
        ));
      const [rec] = await db.select({ s: sql<string>`coalesce(sum(${receiptVouchersTable.amount}), 0)` })
        .from(receiptVouchersTable)
        .where(and(
          eq(receiptVouchersTable.companyId, cid as number),
          eq(receiptVouchersTable.entityType, "customer"),
          eq(receiptVouchersTable.entityId, ccid),
          eq(receiptVouchersTable.status, "posted"),
          sql`${receiptVouchersTable.date} < ${date}`,
          ...branchScopeSpread(req, receiptVouchersTable.branchId, bid),
        ));
      return Number(inv.s) - Number(ret.s) - Number(rec.s);
    }
    const opening = await sumPriorTo(from);

    // Header rows in date range. Unlike the simple /customer-statement (A/R-only),
    // the DETAILED report shows EVERY posted invoice/return — cash, bank and credit —
    // because users want to audit all movement for the customer, not just open A/R.
    // Cash/bank documents are rendered with equal debit & credit so the running
    // balance still tracks A/R correctly (they self-settle at point of sale).
    const invConds: any[] = [
      eq(salesInvoicesTable.companyId, cid),
      eq(salesInvoicesTable.customerId, ccid),
      eq(salesInvoicesTable.status, "posted"),
    ];
    pushBranchScope(req, invConds, salesInvoicesTable.branchId, bid);
    if (from) invConds.push(gte(salesInvoicesTable.invoiceDate, from));
    if (to)   invConds.push(lte(salesInvoicesTable.invoiceDate, to));
    const invs = await db.select({
      id: salesInvoicesTable.id, date: salesInvoicesTable.invoiceDate,
      docNumber: salesInvoicesTable.docNumber, total: salesInvoicesTable.totalAmount,
      subtotal: salesInvoicesTable.subtotal, vatAmount: salesInvoicesTable.vatAmount,
      discountAmount: salesInvoicesTable.discountAmount,
      priceIncludesVat: salesInvoicesTable.priceIncludesVat,
      paymentType: salesInvoicesTable.paymentType,
    }).from(salesInvoicesTable).where(and(...invConds));

    const retConds: any[] = [
      eq(salesReturnsTable.companyId, cid),
      eq(salesReturnsTable.customerId, ccid),
      eq(salesReturnsTable.status, "posted"),
    ];
    pushBranchScope(req, retConds, salesReturnsTable.branchId, bid);
    if (from) retConds.push(gte(salesReturnsTable.returnDate, from));
    if (to)   retConds.push(lte(salesReturnsTable.returnDate, to));
    const rets = await db.select({
      id: salesReturnsTable.id, date: salesReturnsTable.returnDate,
      docNumber: salesReturnsTable.docNumber, total: salesReturnsTable.totalAmount,
      vatAmount: salesReturnsTable.vatAmount, discountAmount: salesReturnsTable.discountAmount,
      priceIncludesVat: salesReturnsTable.priceIncludesVat,
      paymentType: salesReturnsTable.paymentType,
    }).from(salesReturnsTable).where(and(...retConds));

    const recConds: any[] = [
      eq(receiptVouchersTable.companyId, cid),
      eq(receiptVouchersTable.entityType, "customer"),
      eq(receiptVouchersTable.entityId, ccid),
      eq(receiptVouchersTable.status, "posted"),
    ];
    pushBranchScope(req, recConds, receiptVouchersTable.branchId, bid);
    if (from) recConds.push(gte(receiptVouchersTable.date, from));
    if (to)   recConds.push(lte(receiptVouchersTable.date, to));
    const recs = await db.select({
      id: receiptVouchersTable.id, date: receiptVouchersTable.date,
      docNumber: receiptVouchersTable.code, amount: receiptVouchersTable.amount,
      paymentType: receiptVouchersTable.paymentType,
      cashBoxId: receiptVouchersTable.cashBoxId,
      bankAccountId: receiptVouchersTable.bankAccountId,
      refNumber: receiptVouchersTable.refNumber,
      description: receiptVouchersTable.description,
    }).from(receiptVouchersTable).where(and(...recConds));

    // Batch-load child rows for invoices and returns.
    const invIds = invs.map(i => i.id);
    const retIds = rets.map(r => r.id);

    const invLines = invIds.length
      ? await db.select({
          invoiceId: salesInvoiceLinesTable.invoiceId,
          itemCode:  salesInvoiceLinesTable.itemCode,
          itemName:  salesInvoiceLinesTable.itemName,
          unit:      salesInvoiceLinesTable.unit,
          qty:       salesInvoiceLinesTable.qty,
          unitPrice: salesInvoiceLinesTable.unitPrice,
          discount:  salesInvoiceLinesTable.discount,
          vatRate:   salesInvoiceLinesTable.vatRate,
          lineTotal: salesInvoiceLinesTable.lineTotal,
        }).from(salesInvoiceLinesTable)
        .where(inArray(salesInvoiceLinesTable.invoiceId, invIds))
      : [];

    const retLines = retIds.length
      ? await db.select({
          returnId:  salesReturnLinesTable.returnId,
          itemCode:  salesReturnLinesTable.itemCode,
          itemName:  salesReturnLinesTable.itemName,
          unit:      salesReturnLinesTable.unit,
          qty:       salesReturnLinesTable.qty,
          unitPrice: salesReturnLinesTable.unitPrice,
          discount:  salesReturnLinesTable.discount,
          vatRate:   salesReturnLinesTable.vatRate,
          lineTotal: salesReturnLinesTable.lineTotal,
        }).from(salesReturnLinesTable)
        .where(inArray(salesReturnLinesTable.returnId, retIds))
      : [];

    // Cash boxes / bank accounts referenced by receipts (for friendly names).
    const cbIds  = Array.from(new Set(recs.map(r => r.cashBoxId).filter((x): x is number => !!x)));
    const baIds  = Array.from(new Set(recs.map(r => r.bankAccountId).filter((x): x is number => !!x)));
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

    // Group child lines by parent id and compute per-line VAT honouring
    // the parent's price_includes_vat flag.
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

    type DetailedLine = {
      id: number; date: string; type: string; docNumber: string | null;
      debit: number; credit: number; description: string;
      paymentType?: string | null;
      // Embedded drilldown payload (lines for invoice/return, meta for receipt).
      lines?: any[]; meta?: any;
      vatAmount?: number; discountAmount?: number;
    };
    // Customer ledger sign convention: invoice = debit, return/receipt = credit.
    // For cash/bank invoices and returns, we set debit = credit = total so the
    // running A/R balance is unchanged (these documents self-settle), but the
    // user still sees the full transaction with line-item drilldown.
    const invDesc = (pt: string | null) =>
      pt === "credit" ? "فاتورة مبيعات آجلة"
      : pt === "bank" ? "فاتورة مبيعات (تحويل بنكي)"
      : "فاتورة مبيعات نقدية";
    const retDesc = (pt: string | null) =>
      pt === "credit" ? "مرتجع مبيعات آجل"
      : pt === "bank" ? "مرتجع مبيعات (مرتجع بنكياً)"
      : "مرتجع مبيعات نقدي";
    const lines: DetailedLine[] = [
      ...invs.map(i => {
        const total = Number(i.total);
        const isCredit = i.paymentType === "credit";
        return {
          id: i.id, date: i.date, type: "invoice", docNumber: i.docNumber,
          debit: total,
          credit: isCredit ? 0 : total,
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
          debit: isCredit ? 0 : total,
          credit: total,
          description: retDesc(r.paymentType),
          paymentType: r.paymentType,
          vatAmount: Number(r.vatAmount || 0),
          discountAmount: Number(r.discountAmount || 0),
          lines: retLineMap.get(r.id) ?? [],
        };
      }),
      ...recs.map(r => ({
        id: r.id, date: r.date, type: "receipt", docNumber: r.docNumber,
        debit: 0, credit: Number(r.amount), description: "سند قبض",
        paymentType: r.paymentType,
        meta: {
          paymentType: r.paymentType,
          cashBoxName: r.cashBoxId ? (cbName.get(r.cashBoxId) ?? null) : null,
          bankAccountName: r.bankAccountId ? (baName.get(r.bankAccountId) ?? null) : null,
          refNumber: r.refNumber,
          description: r.description,
        },
      })),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));

    res.json({ opening, lines });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/**
 * Customer aging: bucket the *outstanding* balance by invoice age using FIFO payment application.
 * As-of date defaults to today.
 */
router.get("/aging", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const bid = getBid(req);
    const asOf = (req.query.asOf as string) || new Date().toISOString().slice(0, 10);

    const customers = await db.select().from(customersTable).where(eq(customersTable.companyId, cid));

    // Pull all posted credit invoices on or before asOf, ordered oldest first per customer
    const invs = await db
      .select({
        customerId: salesInvoicesTable.customerId,
        date:       salesInvoicesTable.invoiceDate,
        total:      salesInvoicesTable.totalAmount,
      })
      .from(salesInvoicesTable)
      .where(and(
        eq(salesInvoicesTable.companyId, cid),
        eq(salesInvoicesTable.status, "posted"),
        eq(salesInvoicesTable.paymentType, "credit"),
        lte(salesInvoicesTable.invoiceDate, asOf),
        ...branchScopeSpread(req, salesInvoicesTable.branchId, bid),
      ))
      .orderBy(asc(salesInvoicesTable.invoiceDate), asc(salesInvoicesTable.id));

    // Total credits per customer = posted returns + posted receipts on or before asOf
    const retAgg = await db
      .select({
        customerId: salesReturnsTable.customerId,
        total: sql<string>`coalesce(sum(${salesReturnsTable.totalAmount}), 0)`,
      })
      .from(salesReturnsTable)
      .where(and(
        eq(salesReturnsTable.companyId, cid),
        eq(salesReturnsTable.status, "posted"),
        eq(salesReturnsTable.paymentType, "credit"),
        lte(salesReturnsTable.returnDate, asOf),
        ...branchScopeSpread(req, salesReturnsTable.branchId, bid),
      ))
      .groupBy(salesReturnsTable.customerId);

    const recAgg = await db
      .select({
        customerId: receiptVouchersTable.entityId,
        total: sql<string>`coalesce(sum(${receiptVouchersTable.amount}), 0)`,
      })
      .from(receiptVouchersTable)
      .where(and(
        eq(receiptVouchersTable.companyId, cid),
        eq(receiptVouchersTable.entityType, "customer"),
        eq(receiptVouchersTable.status, "posted"),
        lte(receiptVouchersTable.date, asOf),
        ...branchScopeSpread(req, receiptVouchersTable.branchId, bid),
      ))
      .groupBy(receiptVouchersTable.entityId);

    const creditByCustomer: Record<number, number> = {};
    for (const r of retAgg) if (r.customerId) creditByCustomer[r.customerId] = (creditByCustomer[r.customerId] ?? 0) + Number(r.total);
    for (const r of recAgg) if (r.customerId) creditByCustomer[r.customerId] = (creditByCustomer[r.customerId] ?? 0) + Number(r.total);

    // Group invoices by customer
    const invByCustomer: Record<number, { date: string; total: number }[]> = {};
    for (const i of invs) {
      if (!i.customerId) continue;
      (invByCustomer[i.customerId] ??= []).push({ date: i.date, total: Number(i.total) });
    }

    const today = new Date(asOf);
    const dayDiff = (d: string) => Math.floor((today.getTime() - new Date(d).getTime()) / 86400000);

    const result = customers.map(c => {
      const invList = invByCustomer[c.id] ?? [];
      let credit = creditByCustomer[c.id] ?? 0;
      // FIFO-apply credits to oldest invoices
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
      // If credits exceed invoices (over-payment), surface as negative balance under "current"
      if (credit > 0 && remaining.every(r => r.total <= 0)) {
        return {
          customerId: c.id, customerNameAr: c.nameAr, customerNameEn: c.nameEn ?? null,
          phone: c.phone ?? null,
          current: -credit, d30: 0, d60: 0, d90: 0, d90plus: 0, total: -credit,
        };
      }
      return {
        customerId: c.id, customerNameAr: c.nameAr, customerNameEn: c.nameEn ?? null,
        phone: c.phone ?? null,
        current, d30, d60, d90, d90plus, total,
      };
    }).filter(r => Math.abs(r.total) > 0.005);

    res.json(result.sort((a, b) => Math.abs(b.total) - Math.abs(a.total)));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/**
 * Sales returns aggregate per customer within a date range.
 */
router.get("/returns-by-customer", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const bid = getBid(req);
    const { from, to } = req.query as Record<string, string>;
    const conds = [eq(salesReturnsTable.companyId, cid), eq(salesReturnsTable.status, "posted")];
    pushBranchScope(req, conds, salesReturnsTable.branchId, bid);
    if (from) conds.push(gte(salesReturnsTable.returnDate, from));
    if (to)   conds.push(lte(salesReturnsTable.returnDate, to));
    const agg = await db
      .select({
        customerId:  salesReturnsTable.customerId,
        returnCount: sql<number>`count(*)::int`,
        totalAmount: sql<string>`coalesce(sum(${salesReturnsTable.totalAmount}), 0)`,
        totalVat:    sql<string>`coalesce(sum(${salesReturnsTable.vatAmount}), 0)`,
      })
      .from(salesReturnsTable)
      .where(and(...conds))
      .groupBy(salesReturnsTable.customerId);

    const customers = await db.select().from(customersTable).where(eq(customersTable.companyId, cid));
    const cmap = new Map(customers.map(c => [c.id, c]));
    res.json(agg.map(r => {
      const c = r.customerId ? cmap.get(r.customerId) : null;
      return {
        customerId: r.customerId,
        customerNameAr: c?.nameAr ?? "بدون عميل",
        customerNameEn: c?.nameEn ?? null,
        returnCount: r.returnCount,
        totalAmount: Number(r.totalAmount),
        totalVat:    Number(r.totalVat),
      };
    }).sort((a, b) => b.totalAmount - a.totalAmount));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/**
 * Daily Sales Report — full detailed snapshot for a single day.
 *
 * Query: ?date=YYYY-MM-DD (default: today)  &branchId=N
 *
 * Returns:
 *   {
 *     date,
 *     summary: { invoiceCount, customerCount, subtotal, discount, vatAmount, totalAmount,
 *                cashCount, cashAmount, creditCount, creditAmount, bankCount, bankAmount,
 *                returnCount, returnAmount, returnVat, netSales,
 *                receiptsCount, receiptsAmount, avgInvoice, lineCount, totalQty },
 *     invoices:      [{ id, docNumber, time, customerId, customerNameAr, customerNameEn,
 *                       salesRepNameAr, salesRepNameEn, branchNameAr, branchNameEn,
 *                       lineCount, subtotal, discount, vatAmount, totalAmount,
 *                       paymentType, status, zatcaStatus }],
 *     topItems:      [{ itemId, itemCode, itemName, qty, totalSales, invoiceCount }],
 *     topCustomers:  [{ customerId, customerNameAr, customerNameEn, invoiceCount, totalSales }],
 *     byRep:         [{ salesRepId, salesRepNameAr, salesRepNameEn, invoiceCount, totalSales }],
 *     byBranch:      [{ branchId, branchNameAr, branchNameEn, invoiceCount, totalSales }],
 *     byHour:        [{ hour, invoiceCount, totalAmount }],   // 0..23, only hours with activity
 *     receipts:      [{ id, code, time, entityName, paymentType, amount }],
 *   }
 *
 * Notes:
 *   - "invoices" includes posted + cancelled (so the report shows everything that
 *     happened on the day). Aggregates (summary, top*, by*) only count posted.
 *   - "returns" come from sales_returns posted on the same day.
 *   - "receipts" are receipt_vouchers posted on the day with entity_type='customer'.
 */
router.get("/daily-report", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) {
      res.json({
        date: req.query.date || new Date().toISOString().slice(0, 10),
        summary: emptyDailySummary(),
        invoices: [], topItems: [], topCustomers: [],
        byRep: [], byBranch: [], byHour: [], receipts: [],
      });
      return;
    }
    const bid = getBid(req);
    const date = String(req.query.date || new Date().toISOString().slice(0, 10));

    // ── 1. Invoices on the day (any status — show what happened).
    // Time string is built in SQL with to_char so the bucket reflects the
    // timestamp's stored representation consistently (no UTC drift from JS Date.toISOString).
    const allInvoices = await db
      .select({
        id:            salesInvoicesTable.id,
        docNumber:     salesInvoicesTable.docNumber,
        invoiceDate:   salesInvoicesTable.invoiceDate,
        createdTime:   sql<string>`to_char(${salesInvoicesTable.createdAt}, 'HH24:MI')`,
        customerId:    salesInvoicesTable.customerId,
        salesRepId:    salesInvoicesTable.salesRepId,
        branchId:      salesInvoicesTable.branchId,
        subtotal:      salesInvoicesTable.subtotal,
        discountAmount: salesInvoicesTable.discountAmount,
        vatAmount:     salesInvoicesTable.vatAmount,
        totalAmount:   salesInvoicesTable.totalAmount,
        paymentType:   salesInvoicesTable.paymentType,
        status:        salesInvoicesTable.status,
        zatcaStatus:   salesInvoicesTable.zatcaStatus,
      })
      .from(salesInvoicesTable)
      .where(and(
        eq(salesInvoicesTable.companyId, cid),
        eq(salesInvoicesTable.invoiceDate, date),
        ...branchScopeSpread(req, salesInvoicesTable.branchId, bid),
      ));

    const invIds = allInvoices.map(i => i.id);
    const postedInvIds = allInvoices.filter(i => i.status === "posted").map(i => i.id);

    // ── 2. Resolve customer / sales-rep / branch names in batch
    const customerIds = Array.from(new Set(allInvoices.map(i => i.customerId).filter((x): x is number => !!x)));
    const repIds      = Array.from(new Set(allInvoices.map(i => i.salesRepId).filter((x): x is number => !!x)));
    const branchIds   = Array.from(new Set(allInvoices.map(i => i.branchId  ).filter((x): x is number => !!x)));

    // SECURITY: All metadata lookups are scoped to the current company so a
    // poisoned cross-company FK on an invoice row cannot leak another tenant's
    // customer / sales-rep / branch names. Rows that fail the tenant check
    // simply fall through to the "—" / "بدون مندوب" defaults below.
    const [customers, reps, branches] = await Promise.all([
      customerIds.length
        ? db.select({ id: customersTable.id, nameAr: customersTable.nameAr, nameEn: customersTable.nameEn })
            .from(customersTable)
            .where(and(eq(customersTable.companyId, cid), inArray(customersTable.id, customerIds)))
        : Promise.resolve([] as Array<{ id: number; nameAr: string; nameEn: string | null }>),
      repIds.length
        ? db.select({ id: salesRepsTable.id, nameAr: salesRepsTable.nameAr, nameEn: salesRepsTable.nameEn })
            .from(salesRepsTable)
            .where(and(eq(salesRepsTable.companyId, cid), inArray(salesRepsTable.id, repIds)))
        : Promise.resolve([] as Array<{ id: number; nameAr: string; nameEn: string | null }>),
      branchIds.length
        ? db.select({ id: branchesTable.id, nameAr: branchesTable.nameAr, nameEn: branchesTable.nameEn })
            .from(branchesTable)
            .where(and(eq(branchesTable.companyId, cid), inArray(branchesTable.id, branchIds)))
        : Promise.resolve([] as Array<{ id: number; nameAr: string; nameEn: string | null }>),
    ]);
    const cmap = new Map(customers.map(c => [c.id, c]));
    const rmap = new Map(reps.map(r => [r.id, r]));
    const bmap = new Map(branches.map(b => [b.id, b]));

    // ── 3. Line counts per invoice (one query)
    const lineCountRows = invIds.length
      ? await db
          .select({
            invoiceId: salesInvoiceLinesTable.invoiceId,
            lineCount: sql<number>`count(*)::int`,
            totalQty:  sql<string>`coalesce(sum(${salesInvoiceLinesTable.qty}), 0)`,
          })
          .from(salesInvoiceLinesTable)
          .where(inArray(salesInvoiceLinesTable.invoiceId, invIds))
          .groupBy(salesInvoiceLinesTable.invoiceId)
      : [];
    const lineCountMap = new Map<number, { lineCount: number; totalQty: number }>();
    for (const r of lineCountRows) {
      lineCountMap.set(r.invoiceId, { lineCount: r.lineCount, totalQty: Number(r.totalQty) });
    }

    // ── 4. Top items + per-line totals (posted only)
    const linesAgg = postedInvIds.length
      ? await db
          .select({
            itemId:       salesInvoiceLinesTable.itemId,
            itemCode:     salesInvoiceLinesTable.itemCode,
            itemName:     salesInvoiceLinesTable.itemName,
            qty:          sql<string>`coalesce(sum(${salesInvoiceLinesTable.qty}), 0)`,
            totalSales:   sql<string>`coalesce(sum(${salesInvoiceLinesTable.lineTotal}), 0)`,
            invoiceCount: sql<number>`count(distinct ${salesInvoiceLinesTable.invoiceId})::int`,
          })
          .from(salesInvoiceLinesTable)
          .where(inArray(salesInvoiceLinesTable.invoiceId, postedInvIds))
          .groupBy(salesInvoiceLinesTable.itemId, salesInvoiceLinesTable.itemCode, salesInvoiceLinesTable.itemName)
      : [];
    const topItems = linesAgg
      .map(r => ({
        itemId:       r.itemId,
        itemCode:     r.itemCode,
        itemName:     r.itemName,
        qty:          Number(r.qty),
        totalSales:   Number(r.totalSales),
        invoiceCount: r.invoiceCount,
      }))
      .sort((a, b) => b.totalSales - a.totalSales)
      .slice(0, 20);

    // ── 5. Returns on the day (posted only)
    const returnsAgg = await db
      .select({
        count:  sql<number>`count(*)::int`,
        amount: sql<string>`coalesce(sum(${salesReturnsTable.totalAmount}), 0)`,
        vat:    sql<string>`coalesce(sum(${salesReturnsTable.vatAmount}), 0)`,
      })
      .from(salesReturnsTable)
      .where(and(
        eq(salesReturnsTable.companyId, cid),
        eq(salesReturnsTable.returnDate, date),
        eq(salesReturnsTable.status, "posted"),
        ...branchScopeSpread(req, salesReturnsTable.branchId, bid),
      ));

    // ── 6. Customer cash receipts on the day (posted only, entity_type=customer)
    const receiptRows = await db
      .select({
        id:           receiptVouchersTable.id,
        code:         receiptVouchersTable.code,
        createdTime:  sql<string>`to_char(${receiptVouchersTable.createdAt}, 'HH24:MI')`,
        entityName:   receiptVouchersTable.entityName,
        paymentType:  receiptVouchersTable.paymentType,
        amount:       receiptVouchersTable.amount,
      })
      .from(receiptVouchersTable)
      .where(and(
        eq(receiptVouchersTable.companyId, cid),
        eq(receiptVouchersTable.date, date),
        eq(receiptVouchersTable.status, "posted"),
        eq(receiptVouchersTable.entityType, "customer"),
        ...branchScopeSpread(req, receiptVouchersTable.branchId, bid),
      ))
      .orderBy(asc(receiptVouchersTable.id));

    // ── 7. Build per-invoice rows (display)
    const invoiceRows = allInvoices
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map(i => {
        const c = i.customerId ? cmap.get(i.customerId) : null;
        const r = i.salesRepId ? rmap.get(i.salesRepId) : null;
        const b = i.branchId   ? bmap.get(i.branchId)   : null;
        const lc = lineCountMap.get(i.id) ?? { lineCount: 0, totalQty: 0 };
        return {
          id:             i.id,
          docNumber:      i.docNumber,
          time:           i.createdTime ?? "",
          customerId:     i.customerId,
          customerNameAr: c?.nameAr ?? "عميل نقدي",
          customerNameEn: c?.nameEn ?? "Cash Customer",
          salesRepId:     i.salesRepId,
          salesRepNameAr: r?.nameAr ?? null,
          salesRepNameEn: r?.nameEn ?? null,
          branchId:       i.branchId,
          branchNameAr:   b?.nameAr ?? null,
          branchNameEn:   b?.nameEn ?? null,
          lineCount:      lc.lineCount,
          totalQty:       lc.totalQty,
          subtotal:       Number(i.subtotal),
          discount:       Number(i.discountAmount),
          vatAmount:      Number(i.vatAmount),
          totalAmount:    Number(i.totalAmount),
          paymentType:    i.paymentType,
          status:         i.status,
          zatcaStatus:    i.zatcaStatus,
        };
      });

    // ── 8. Aggregate computations (posted only)
    const postedRows = invoiceRows.filter(i => i.status === "posted");
    const summary = {
      invoiceCount:   postedRows.length,
      customerCount:  new Set(postedRows.map(r => r.customerId).filter(Boolean)).size,
      lineCount:      postedRows.reduce((s, r) => s + r.lineCount, 0),
      totalQty:       postedRows.reduce((s, r) => s + r.totalQty,  0),
      subtotal:       postedRows.reduce((s, r) => s + r.subtotal,  0),
      discount:       postedRows.reduce((s, r) => s + r.discount,  0),
      vatAmount:      postedRows.reduce((s, r) => s + r.vatAmount, 0),
      totalAmount:    postedRows.reduce((s, r) => s + r.totalAmount, 0),
      avgInvoice:     postedRows.length > 0
                        ? postedRows.reduce((s, r) => s + r.totalAmount, 0) / postedRows.length
                        : 0,
      cashCount:      postedRows.filter(r => r.paymentType === "cash").length,
      cashAmount:     postedRows.filter(r => r.paymentType === "cash").reduce((s, r) => s + r.totalAmount, 0),
      bankCount:      postedRows.filter(r => r.paymentType === "bank").length,
      bankAmount:     postedRows.filter(r => r.paymentType === "bank").reduce((s, r) => s + r.totalAmount, 0),
      creditCount:    postedRows.filter(r => r.paymentType === "credit").length,
      creditAmount:   postedRows.filter(r => r.paymentType === "credit").reduce((s, r) => s + r.totalAmount, 0),
      returnCount:    Number(returnsAgg[0]?.count  ?? 0),
      returnAmount:   Number(returnsAgg[0]?.amount ?? 0),
      returnVat:      Number(returnsAgg[0]?.vat    ?? 0),
      netSales:       postedRows.reduce((s, r) => s + r.totalAmount, 0)
                        - Number(returnsAgg[0]?.amount ?? 0),
      receiptsCount:  receiptRows.length,
      receiptsAmount: receiptRows.reduce((s, r) => s + Number(r.amount), 0),
    };

    // ── 9. Top customers (posted only)
    const customerAggMap = new Map<string, { customerId: number | null; invoiceCount: number; totalSales: number }>();
    for (const r of postedRows) {
      const key = String(r.customerId ?? "_none");
      const cur = customerAggMap.get(key) ?? { customerId: r.customerId, invoiceCount: 0, totalSales: 0 };
      cur.invoiceCount += 1;
      cur.totalSales   += r.totalAmount;
      customerAggMap.set(key, cur);
    }
    const topCustomers = Array.from(customerAggMap.values())
      .map(v => {
        const c = v.customerId ? cmap.get(v.customerId) : null;
        return {
          customerId:     v.customerId,
          customerNameAr: c?.nameAr ?? "عميل نقدي",
          customerNameEn: c?.nameEn ?? "Cash Customer",
          invoiceCount:   v.invoiceCount,
          totalSales:     v.totalSales,
        };
      })
      .sort((a, b) => b.totalSales - a.totalSales)
      .slice(0, 20);

    // ── 10. By Sales Rep (posted only)
    const repAggMap = new Map<string, { salesRepId: number | null; invoiceCount: number; totalSales: number }>();
    for (const r of postedRows) {
      const key = String(r.salesRepId ?? "_none");
      const cur = repAggMap.get(key) ?? { salesRepId: r.salesRepId, invoiceCount: 0, totalSales: 0 };
      cur.invoiceCount += 1;
      cur.totalSales   += r.totalAmount;
      repAggMap.set(key, cur);
    }
    const byRep = Array.from(repAggMap.values())
      .map(v => {
        const r = v.salesRepId ? rmap.get(v.salesRepId) : null;
        return {
          salesRepId:     v.salesRepId,
          salesRepNameAr: r?.nameAr ?? "بدون مندوب",
          salesRepNameEn: r?.nameEn ?? "No Rep",
          invoiceCount:   v.invoiceCount,
          totalSales:     v.totalSales,
        };
      })
      .sort((a, b) => b.totalSales - a.totalSales);

    // ── 11. By Branch (posted only)
    const branchAggMap = new Map<string, { branchId: number | null; invoiceCount: number; totalSales: number }>();
    for (const r of postedRows) {
      const key = String(r.branchId ?? "_none");
      const cur = branchAggMap.get(key) ?? { branchId: r.branchId, invoiceCount: 0, totalSales: 0 };
      cur.invoiceCount += 1;
      cur.totalSales   += r.totalAmount;
      branchAggMap.set(key, cur);
    }
    const byBranch = Array.from(branchAggMap.values())
      .map(v => {
        const b = v.branchId ? bmap.get(v.branchId) : null;
        return {
          branchId:     v.branchId,
          branchNameAr: b?.nameAr ?? "—",
          branchNameEn: b?.nameEn ?? "—",
          invoiceCount: v.invoiceCount,
          totalSales:   v.totalSales,
        };
      })
      .sort((a, b) => b.totalSales - a.totalSales);

    // ── 12. By Hour (posted only). Hours derived from createdAt (server time).
    const hourAggMap = new Map<number, { invoiceCount: number; totalAmount: number }>();
    for (const r of postedRows) {
      const h = Number(r.time.slice(0, 2));
      if (!Number.isFinite(h)) continue;
      const cur = hourAggMap.get(h) ?? { invoiceCount: 0, totalAmount: 0 };
      cur.invoiceCount += 1;
      cur.totalAmount  += r.totalAmount;
      hourAggMap.set(h, cur);
    }
    const byHour = Array.from(hourAggMap.entries())
      .map(([hour, v]) => ({ hour, ...v }))
      .sort((a, b) => a.hour - b.hour);

    // ── 13. Receipts (display rows)
    const receipts = receiptRows.map(r => ({
      id:          r.id,
      code:        r.code,
      time:        r.createdTime ?? "",
      entityName:  r.entityName,
      paymentType: r.paymentType,
      amount:      Number(r.amount),
    }));

    res.json({
      date,
      summary,
      invoices: invoiceRows,
      topItems,
      topCustomers,
      byRep,
      byBranch,
      byHour,
      receipts,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

function emptyDailySummary() {
  return {
    invoiceCount: 0, customerCount: 0, lineCount: 0, totalQty: 0,
    subtotal: 0, discount: 0, vatAmount: 0, totalAmount: 0, avgInvoice: 0,
    cashCount: 0, cashAmount: 0, bankCount: 0, bankAmount: 0,
    creditCount: 0, creditAmount: 0,
    returnCount: 0, returnAmount: 0, returnVat: 0, netSales: 0,
    receiptsCount: 0, receiptsAmount: 0,
  };
}

export default router;
