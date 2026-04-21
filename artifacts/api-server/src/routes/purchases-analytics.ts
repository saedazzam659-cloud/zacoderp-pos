import { Router } from "express";
import { db } from "@workspace/db";
import {
  suppliersTable,
  purchaseInvoicesTable, purchaseInvoiceLinesTable,
  purchaseReturnsTable,
  paymentVouchersTable,
} from "@workspace/db";
import { and, eq, sql, gte, lte, asc } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";

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

/**
 * Purchase totals grouped by supplier (posted invoices and returns within a date range).
 * Includes total payments paid to each supplier in the same range.
 */
router.get("/by-supplier", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const { from, to } = req.query as Record<string, string>;

    const invConds = [eq(purchaseInvoicesTable.companyId, cid), eq(purchaseInvoicesTable.status, "posted")];
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
    const { from, to } = req.query as Record<string, string>;
    const conds = [eq(purchaseInvoicesTable.companyId, cid), eq(purchaseInvoicesTable.status, "posted")];
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
    const { from, to, groupBy } = req.query as Record<string, string>;
    const conds = [eq(purchaseInvoicesTable.companyId, cid), eq(purchaseInvoicesTable.status, "posted")];
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
    const { supplierId, from, to } = req.query as Record<string, string>;
    const sid = Number(supplierId);
    if (!supplierId || !Number.isFinite(sid)) { res.status(400).json({ error: "supplierId مطلوب ويجب أن يكون رقماً صحيحاً" }); return; }

    async function sumPriorTo(date: string | undefined) {
      if (!date) return 0;
      const [inv] = await db.select({ s: sql<string>`coalesce(sum(${purchaseInvoicesTable.totalAmount}), 0)` })
        .from(purchaseInvoicesTable)
        .where(and(
          eq(purchaseInvoicesTable.companyId, cid as number),
          eq(purchaseInvoicesTable.supplierId, sid),
          eq(purchaseInvoicesTable.status, "posted"),
          eq(purchaseInvoicesTable.paymentType, "credit"),
          sql`${purchaseInvoicesTable.invoiceDate} < ${date}`,
        ));
      const [ret] = await db.select({ s: sql<string>`coalesce(sum(${purchaseReturnsTable.totalAmount}), 0)` })
        .from(purchaseReturnsTable)
        .where(and(
          eq(purchaseReturnsTable.companyId, cid as number),
          eq(purchaseReturnsTable.supplierId, sid),
          eq(purchaseReturnsTable.status, "posted"),
          eq(purchaseReturnsTable.paymentType, "credit"),
          sql`${purchaseReturnsTable.returnDate} < ${date}`,
        ));
      const [pay] = await db.select({ s: sql<string>`coalesce(sum(${paymentVouchersTable.amount}), 0)` })
        .from(paymentVouchersTable)
        .where(and(
          eq(paymentVouchersTable.companyId, cid as number),
          eq(paymentVouchersTable.entityType, "supplier"),
          eq(paymentVouchersTable.entityId, sid),
          eq(paymentVouchersTable.status, "posted"),
          sql`${paymentVouchersTable.date} < ${date}`,
        ));
      return Number(inv.s) - Number(ret.s) - Number(pay.s);
    }

    const opening = await sumPriorTo(from);

    const invConds: any[] = [
      eq(purchaseInvoicesTable.companyId, cid),
      eq(purchaseInvoicesTable.supplierId, sid),
      eq(purchaseInvoicesTable.status, "posted"),
      eq(purchaseInvoicesTable.paymentType, "credit"),
    ];
    if (from) invConds.push(gte(purchaseInvoicesTable.invoiceDate, from));
    if (to)   invConds.push(lte(purchaseInvoicesTable.invoiceDate, to));
    const invs = await db.select({
      id: purchaseInvoicesTable.id, date: purchaseInvoicesTable.invoiceDate,
      docNumber: purchaseInvoicesTable.docNumber, total: purchaseInvoicesTable.totalAmount,
    }).from(purchaseInvoicesTable).where(and(...invConds));

    const retConds: any[] = [
      eq(purchaseReturnsTable.companyId, cid),
      eq(purchaseReturnsTable.supplierId, sid),
      eq(purchaseReturnsTable.status, "posted"),
      eq(purchaseReturnsTable.paymentType, "credit"),
    ];
    if (from) retConds.push(gte(purchaseReturnsTable.returnDate, from));
    if (to)   retConds.push(lte(purchaseReturnsTable.returnDate, to));
    const rets = await db.select({
      id: purchaseReturnsTable.id, date: purchaseReturnsTable.returnDate,
      docNumber: purchaseReturnsTable.docNumber, total: purchaseReturnsTable.totalAmount,
    }).from(purchaseReturnsTable).where(and(...retConds));

    const payConds: any[] = [
      eq(paymentVouchersTable.companyId, cid),
      eq(paymentVouchersTable.entityType, "supplier"),
      eq(paymentVouchersTable.entityId, sid),
      eq(paymentVouchersTable.status, "posted"),
    ];
    if (from) payConds.push(gte(paymentVouchersTable.date, from));
    if (to)   payConds.push(lte(paymentVouchersTable.date, to));
    const pays = await db.select({
      id: paymentVouchersTable.id, date: paymentVouchersTable.date,
      docNumber: paymentVouchersTable.code, amount: paymentVouchersTable.amount,
    }).from(paymentVouchersTable).where(and(...payConds));

    // For supplier statements, invoices increase the payable (credit column),
    // returns and payments decrease it (debit column).
    type Line = { date: string; type: string; docNumber: string | null; debit: number; credit: number; description: string };
    const lines: Line[] = [
      ...invs.map(i => ({ date: i.date, type: "invoice", docNumber: i.docNumber, debit: 0, credit: Number(i.total), description: "فاتورة مشتريات آجلة" })),
      ...rets.map(r => ({ date: r.date, type: "return",  docNumber: r.docNumber, debit: Number(r.total), credit: 0, description: "مرتجع مشتريات" })),
      ...pays.map(p => ({ date: p.date, type: "payment", docNumber: p.docNumber, debit: Number(p.amount), credit: 0, description: "سند صرف" })),
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
    const asOf = (req.query.asOf as string) || new Date().toISOString().slice(0, 10);

    const suppliers = await db.select().from(suppliersTable).where(eq(suppliersTable.companyId, cid));

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
        lte(purchaseInvoicesTable.invoiceDate, asOf),
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
    const { from, to } = req.query as Record<string, string>;
    const conds = [eq(purchaseReturnsTable.companyId, cid), eq(purchaseReturnsTable.status, "posted")];
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
