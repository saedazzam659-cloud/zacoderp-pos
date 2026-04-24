import { Router } from "express";
import { db } from "@workspace/db";
import {
  customersTable,
  salesInvoicesTable, salesInvoiceLinesTable,
  salesReturnsTable,  salesReturnLinesTable,
  receiptVouchersTable,
} from "@workspace/db";
import { and, eq, sql, gte, lte, asc, desc } from "drizzle-orm";
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

export default router;
