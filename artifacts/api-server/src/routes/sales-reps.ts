import { Router } from "express";
import { db } from "@workspace/db";
import {
  salesRepsTable,
  salesRepVisitsTable,
  customersTable,
  salesInvoicesTable,
  receiptVouchersTable, // used by delete guard so we don't orphan collection-commission history
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { ensureLeafAccounts } from "../lib/leafAccount.js";

const router = Router();
router.use(extractAuth);
// Require an authenticated user for every sales-reps endpoint — these contain
// PII (phone/email/address) and commission terms; never serve to anonymous callers.
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.body?.companyId ?? req.query.companyId);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
function requireCid(req: any, res: any): number | null {
  const raw = req.query.companyId ? Number(req.query.companyId) : undefined;
  const cid = resolveCompanyId(req, raw);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

async function nextRepCode(cid: number): Promise<string> {
  const rows = await db.select({ code: salesRepsTable.code }).from(salesRepsTable)
    .where(eq(salesRepsTable.companyId, cid));
  let max = 0;
  for (const r of rows) {
    const m = /^(?:SR|SREP|REP)?(\d+)$/.exec(String(r.code).trim());
    if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n) && n > max) max = n; }
  }
  return `SR${String(max + 1).padStart(4, "0")}`;
}

// ─── REPS LIST/CRUD ──────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(salesRepsTable)
      .where(eq(salesRepsTable.companyId, cid))
      .orderBy(desc(salesRepsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/active", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(salesRepsTable)
      .where(and(eq(salesRepsTable.companyId, cid), eq(salesRepsTable.isActive, true)))
      .orderBy(salesRepsTable.nameAr);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/:id", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.select().from(salesRepsTable)
      .where(and(eq(salesRepsTable.id, id), eq(salesRepsTable.companyId, cid)));
    if (!row) { res.status(404).json({ error: "المندوب غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const nameAr = String(b.nameAr ?? "").trim();
    if (!nameAr) { res.status(400).json({ error: "اسم المندوب مطلوب" }); return; }
    const code = String(b.code ?? "").trim() || await nextRepCode(cid);

    if (b.accountId) {
      try { await ensureLeafAccounts(cid, [b.accountId]); }
      catch (err: any) { res.status(400).json({ error: err?.message ?? "حساب غير صالح" }); return; }
    }

    const [row] = await db.insert(salesRepsTable).values({
      companyId:      cid,
      code,
      nameAr,
      nameEn:         b.nameEn || null,
      phone:          b.phone || null,
      email:          b.email || null,
      address:        b.address || null,
      branchId:       b.branchId ? Number(b.branchId) : null,
      region:         b.region || null,
      isActive:       b.isActive !== false,
      commissionPct:  b.commissionPct != null ? String(b.commissionPct) : "0",
      commissionType: b.commissionType === "collection" ? "collection" : "invoice",
      monthlyTarget:  b.monthlyTarget != null ? String(b.monthlyTarget) : "0",
      accountId:      b.accountId ? Number(b.accountId) : null,
      notes:          b.notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) {
    if (String(e?.message).includes("duplicate") || e?.code === "23505")
      return res.status(409).json({ error: "كود المندوب مستخدم مسبقاً" });
    res.status(500).json({ error: e.message });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body ?? {};

    if (b.accountId) {
      try { await ensureLeafAccounts(cid, [b.accountId]); }
      catch (err: any) { res.status(400).json({ error: err?.message ?? "حساب غير صالح" }); return; }
    }

    const [row] = await db.update(salesRepsTable).set({
      code:           b.code != null ? String(b.code).trim() : undefined,
      nameAr:         b.nameAr != null ? String(b.nameAr).trim() : undefined,
      nameEn:         b.nameEn ?? null,
      phone:          b.phone ?? null,
      email:          b.email ?? null,
      address:        b.address ?? null,
      branchId:       b.branchId ? Number(b.branchId) : null,
      region:         b.region ?? null,
      isActive:       b.isActive !== undefined ? !!b.isActive : undefined,
      commissionPct:  b.commissionPct != null ? String(b.commissionPct) : undefined,
      commissionType: b.commissionType === "collection" ? "collection"
                      : b.commissionType === "invoice" ? "invoice" : undefined,
      monthlyTarget:  b.monthlyTarget != null ? String(b.monthlyTarget) : undefined,
      accountId:      b.accountId ? Number(b.accountId) : null,
      notes:          b.notes ?? null,
      updatedAt:      new Date(),
    }).where(and(eq(salesRepsTable.id, id), eq(salesRepsTable.companyId, cid))).returning();

    if (!row) { res.status(404).json({ error: "المندوب غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    // Refuse delete when the rep is referenced from invoices, customers, or
    // receipt vouchers — the user should deactivate instead so historical
    // commission history (incl. collection-based commissions) stays intact.
    const [{ n: invN }] = await db.select({ n: sql<number>`count(*)::int` })
      .from(salesInvoicesTable)
      .where(and(eq(salesInvoicesTable.companyId, cid), eq(salesInvoicesTable.salesRepId, id)));
    const [{ n: custN }] = await db.select({ n: sql<number>`count(*)::int` })
      .from(customersTable)
      .where(and(eq(customersTable.companyId, cid), eq(customersTable.salesRepId, id)));
    const [{ n: rcvN }] = await db.select({ n: sql<number>`count(*)::int` })
      .from(receiptVouchersTable)
      .where(and(eq(receiptVouchersTable.companyId, cid), eq(receiptVouchersTable.salesRepId, id)));
    if (invN > 0 || custN > 0 || rcvN > 0) {
      res.status(409).json({
        error: `لا يمكن حذف المندوب — مرتبط بـ ${invN} فاتورة و ${custN} عميل و ${rcvN} سند قبض. يمكنك تعطيله بدلاً من ذلك.`,
      });
      return;
    }

    await db.delete(salesRepsTable)
      .where(and(eq(salesRepsTable.id, id), eq(salesRepsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── VISITS ─────────────────────────────────────────────────────────────────
router.get("/:id/visits", async (req, res) => {
  try {
    const cid = getCid(req);
    const repId = Number(req.params.id);
    if (!cid) { res.json([]); return; }
    const rows = await db.select().from(salesRepVisitsTable)
      .where(and(eq(salesRepVisitsTable.companyId, cid), eq(salesRepVisitsTable.salesRepId, repId)))
      .orderBy(desc(salesRepVisitsTable.visitDate), desc(salesRepVisitsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/:id/visits", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const repId = Number(req.params.id);
    const b = req.body ?? {};
    if (!b.visitDate) { res.status(400).json({ error: "تاريخ الزيارة مطلوب" }); return; }

    const [row] = await db.insert(salesRepVisitsTable).values({
      companyId:    cid,
      salesRepId:   repId,
      customerId:   b.customerId ? Number(b.customerId) : null,
      visitDate:    String(b.visitDate),
      status:       ["planned","completed","cancelled"].includes(b.status) ? b.status : "completed",
      outcome:      ["none","interested","quotation_sent","deal_closed","no_interest","follow_up"].includes(b.outcome) ? b.outcome : "none",
      notes:        b.notes || null,
      followUpDate: b.followUpDate || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/visits/:vid", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const vid = Number(req.params.vid);
    const b = req.body ?? {};
    const [row] = await db.update(salesRepVisitsTable).set({
      customerId:   b.customerId ? Number(b.customerId) : null,
      visitDate:    b.visitDate ? String(b.visitDate) : undefined,
      status:       ["planned","completed","cancelled"].includes(b.status) ? b.status : undefined,
      outcome:      ["none","interested","quotation_sent","deal_closed","no_interest","follow_up"].includes(b.outcome) ? b.outcome : undefined,
      notes:        b.notes ?? null,
      followUpDate: b.followUpDate ?? null,
      updatedAt:    new Date(),
    }).where(and(eq(salesRepVisitsTable.id, vid), eq(salesRepVisitsTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "الزيارة غير موجودة" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/visits/:vid", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const vid = Number(req.params.vid);
    await db.delete(salesRepVisitsTable)
      .where(and(eq(salesRepVisitsTable.id, vid), eq(salesRepVisitsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── REPORTS ────────────────────────────────────────────────────────────────
// Sales + commissions per rep, optionally filtered by date range.
router.get("/reports/sales", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const from = req.query.from ? String(req.query.from) : null;
    const to   = req.query.to   ? String(req.query.to)   : null;

    const reps = await db.select().from(salesRepsTable)
      .where(eq(salesRepsTable.companyId, cid));

    // Sum posted invoices grouped by salesRepId in the given date range.
    const conds = [
      eq(salesInvoicesTable.companyId, cid),
      eq(salesInvoicesTable.status, "posted"),
    ];
    if (from) conds.push(sql`${salesInvoicesTable.invoiceDate} >= ${from}`);
    if (to)   conds.push(sql`${salesInvoicesTable.invoiceDate} <= ${to}`);

    const sums = await db
      .select({
        salesRepId:       salesInvoicesTable.salesRepId,
        invoiceCount:     sql<number>`count(*)::int`,
        totalSales:       sql<string>`COALESCE(SUM(${salesInvoicesTable.totalAmount}), 0)`,
        totalCommission:  sql<string>`COALESCE(SUM(${salesInvoicesTable.commissionAmount}), 0)`,
      })
      .from(salesInvoicesTable)
      .where(and(...conds))
      .groupBy(salesInvoicesTable.salesRepId);

    // Posted receipts collected by each rep (only meaningful when commissionType=collection)
    const recvConds = [
      eq(receiptVouchersTable.companyId, cid),
      eq(receiptVouchersTable.status, "posted"),
    ];
    if (from) recvConds.push(sql`${receiptVouchersTable.date} >= ${from}`);
    if (to)   recvConds.push(sql`${receiptVouchersTable.date} <= ${to}`);
    const collections = await db
      .select({
        salesRepId: receiptVouchersTable.salesRepId,
        collected:  sql<string>`COALESCE(SUM(${receiptVouchersTable.amount}), 0)`,
      })
      .from(receiptVouchersTable)
      .where(and(...recvConds))
      .groupBy(receiptVouchersTable.salesRepId);

    const sumMap = new Map(sums.map(s => [s.salesRepId, s]));
    const colMap = new Map(collections.map(c => [c.salesRepId, c]));

    const out = reps.map(r => {
      const s = sumMap.get(r.id);
      const c = colMap.get(r.id);
      const totalSales      = Number(s?.totalSales      ?? 0);
      const totalCommission = Number(s?.totalCommission ?? 0);
      const collected       = Number(c?.collected       ?? 0);
      const target          = Number(r.monthlyTarget    ?? 0);
      // For collection-type reps, recompute commission from collections × pct
      const effectiveCommission = r.commissionType === "collection"
        ? collected * (Number(r.commissionPct) / 100)
        : totalCommission;
      return {
        salesRepId:       r.id,
        code:             r.code,
        nameAr:           r.nameAr,
        commissionPct:    Number(r.commissionPct),
        commissionType:   r.commissionType,
        monthlyTarget:    target,
        invoiceCount:     s?.invoiceCount ?? 0,
        totalSales,
        collected,
        commission:       effectiveCommission,
        targetAchievedPct: target > 0 ? Math.round((totalSales / target) * 100) : null,
      };
    });
    res.json(out);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
