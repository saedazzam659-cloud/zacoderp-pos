// ─────────────────────────────────────────────────────────────────────────
// POS Operations — listing endpoints for POS-originated sales invoices and
// returns, enriched with cashier / branch / session info so the admin
// monitoring screen can render everything without N round-trips.
//
// View / Edit / Post / Unpost operations are NOT re-implemented here — they
// already exist on the canonical sales router (/sales-invoices/:id, /post,
// /unpost, etc.) and respect the same permission gates. This router only
// adds the *list* + *summary* endpoints scoped to documents that originated
// from a POS session.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { db } from "@workspace/db";
import {
  salesInvoicesTable, salesReturnsTable, posSessionsTable,
  branchesTable, usersTable,
} from "@workspace/db";
import { and, eq, desc, sql, inArray, gte, lte, isNotNull } from "drizzle-orm";
import { extractAuth, resolveCompanyId, branchScopeSpread, getAllowedBranchIds } from "../middleware/auth.js";
import { requireModulePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("pos"));

function getCid(req: any, res: any): number | null {
  const raw = req.query.companyId ?? req.body?.companyId;
  const cid = resolveCompanyId(req, raw ?? req.authUser?.companyId);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

type ListFilters = {
  status?: string | null;
  branchId?: number | null;
  cashierId?: number | null;
  sessionId?: number | null;
  fromDate?: string | null;
  toDate?: string | null;
};

function readFilters(req: any): ListFilters {
  return {
    status:    (req.query.status as string)    || null,
    branchId:   req.query.branchId   ? Number(req.query.branchId)   : null,
    cashierId:  req.query.cashierId  ? Number(req.query.cashierId)  : null,
    sessionId:  req.query.sessionId  ? Number(req.query.sessionId)  : null,
    fromDate:  (req.query.fromDate  as string) || null,
    toDate:    (req.query.toDate    as string) || null,
  };
}

// ─── GET /pos-operations/invoices ────────────────────────────────────────
// POS-originated sales invoices with cashier / branch / session enrichment.
router.get("/invoices", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const f = readFilters(req);

    const conds = [
      eq(salesInvoicesTable.companyId, cid),
      // POS origin: invoice carries a posSessionId (set by /pos-sessions/sale).
      isNotNull(salesInvoicesTable.posSessionId),
      ...branchScopeSpread(req, salesInvoicesTable.branchId, f.branchId ?? undefined),
    ];
    if (f.status)    conds.push(eq(salesInvoicesTable.status,    f.status as any));
    if (f.sessionId) conds.push(eq(salesInvoicesTable.posSessionId, f.sessionId));
    if (f.fromDate)  conds.push(gte(salesInvoicesTable.invoiceDate, f.fromDate));
    if (f.toDate)    conds.push(lte(salesInvoicesTable.invoiceDate, f.toDate));

    const rows = await db.select().from(salesInvoicesTable)
      .where(and(...conds))
      .orderBy(desc(salesInvoicesTable.invoiceDate), desc(salesInvoicesTable.id))
      .limit(500);

    if (!rows.length) { res.json([]); return; }

    // Enrich with session → cashier + terminal in one round-trip.
    const sessionIds = Array.from(new Set(rows.map(r => r.posSessionId).filter(Boolean) as number[]));
    const sessions = sessionIds.length ? await db.select({
      id:        posSessionsTable.id,
      userId:    posSessionsTable.userId,
      branchId:  posSessionsTable.branchId,
      terminalId: posSessionsTable.posTerminalId,
      openedAt:  posSessionsTable.openedAt,
      closedAt:  posSessionsTable.closedAt,
    }).from(posSessionsTable).where(inArray(posSessionsTable.id, sessionIds)) : [];
    const sessById = new Map(sessions.map(s => [s.id, s]));

    const userIds   = Array.from(new Set(sessions.map(s => s.userId).filter(Boolean) as number[]));
    const branchIds = Array.from(new Set(rows.map(r => r.branchId).filter(Boolean) as number[]));

    const [users, branches] = await Promise.all([
      userIds.length   ? db.select({ id: usersTable.id, username: usersTable.username, nameAr: usersTable.nameAr, nameEn: usersTable.nameEn }).from(usersTable).where(inArray(usersTable.id, userIds)) : Promise.resolve([]),
      branchIds.length ? db.select({ id: branchesTable.id, nameAr: branchesTable.nameAr, nameEn: branchesTable.nameEn }).from(branchesTable).where(inArray(branchesTable.id, branchIds)) : Promise.resolve([]),
    ]);
    const userById   = new Map(users.map(u => [u.id, u]));
    const branchById = new Map(branches.map(b => [b.id, b]));

    // Apply cashier filter post-enrichment (cashier lives on session, not invoice).
    const enriched = rows.map(r => {
      const s = r.posSessionId ? sessById.get(r.posSessionId) : null;
      const u = s?.userId ? userById.get(s.userId) : null;
      const b = r.branchId ? branchById.get(r.branchId) : null;
      return {
        id: r.id,
        docNumber: r.docNumber,
        invoiceDate: r.invoiceDate,
        status: r.status,
        totalAmount: r.totalAmount,
        vatAmount: r.vatAmount,
        discountAmount: r.discountAmount,
        paymentType: r.paymentType,
        customerId: r.customerId,
        branchId: r.branchId,
        posSessionId: r.posSessionId,
        zatcaStatus: (r as any).zatcaStatus ?? null,
        createdAt: r.createdAt,
        cashier: u ? { id: u.id, username: u.username, nameAr: u.nameAr, nameEn: u.nameEn } : null,
        branch:  b ? { id: b.id, nameAr: b.nameAr, nameEn: b.nameEn } : null,
        session: s ? { id: s.id, openedAt: s.openedAt, closedAt: s.closedAt } : null,
      };
    });
    const filtered = f.cashierId
      ? enriched.filter(r => r.cashier?.id === f.cashierId)
      : enriched;

    res.json(filtered);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /pos-operations/returns ─────────────────────────────────────────
// POS-originated returns. Returns are linked back to a POS-originated
// invoice via salesReturnsTable.invoiceId, so we filter by joining on the
// invoice's posSessionId.
router.get("/returns", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const f = readFilters(req);

    // Pull all POS-originated invoice ids first (cheap — capped at 5k).
    const posInvIds = (await db.select({ id: salesInvoicesTable.id })
      .from(salesInvoicesTable)
      .where(and(
        eq(salesInvoicesTable.companyId, cid),
        isNotNull(salesInvoicesTable.posSessionId),
      ))
      .limit(5000)).map(r => r.id);
    if (!posInvIds.length) { res.json([]); return; }

    const conds = [
      eq(salesReturnsTable.companyId, cid),
      inArray(salesReturnsTable.invoiceId, posInvIds),
      ...branchScopeSpread(req, salesReturnsTable.branchId, f.branchId ?? undefined),
    ];
    if (f.status)   conds.push(eq(salesReturnsTable.status, f.status as any));
    if (f.fromDate) conds.push(gte(salesReturnsTable.returnDate, f.fromDate));
    if (f.toDate)   conds.push(lte(salesReturnsTable.returnDate, f.toDate));

    const rows = await db.select().from(salesReturnsTable)
      .where(and(...conds))
      .orderBy(desc(salesReturnsTable.returnDate), desc(salesReturnsTable.id))
      .limit(500);
    if (!rows.length) { res.json([]); return; }

    // Enrich branches (cashier-on-return is best-effort: lookup the parent
    // invoice's session).
    const branchIds = Array.from(new Set(rows.map(r => r.branchId).filter(Boolean) as number[]));
    const invIds    = Array.from(new Set(rows.map(r => r.invoiceId).filter(Boolean) as number[]));
    const [branches, invs] = await Promise.all([
      branchIds.length ? db.select({ id: branchesTable.id, nameAr: branchesTable.nameAr, nameEn: branchesTable.nameEn }).from(branchesTable).where(inArray(branchesTable.id, branchIds)) : Promise.resolve([]),
      invIds.length    ? db.select({ id: salesInvoicesTable.id, docNumber: salesInvoicesTable.docNumber, posSessionId: salesInvoicesTable.posSessionId }).from(salesInvoicesTable).where(inArray(salesInvoicesTable.id, invIds)) : Promise.resolve([]),
    ]);
    const branchById = new Map(branches.map(b => [b.id, b]));
    const invById    = new Map(invs.map(i => [i.id, i]));
    const sessIds    = Array.from(new Set(invs.map(i => i.posSessionId).filter(Boolean) as number[]));
    const sessions   = sessIds.length ? await db.select({ id: posSessionsTable.id, userId: posSessionsTable.userId }).from(posSessionsTable).where(inArray(posSessionsTable.id, sessIds)) : [];
    const sessById   = new Map(sessions.map(s => [s.id, s]));
    const userIds    = Array.from(new Set(sessions.map(s => s.userId).filter(Boolean) as number[]));
    const users      = userIds.length ? await db.select({ id: usersTable.id, username: usersTable.username, nameAr: usersTable.nameAr, nameEn: usersTable.nameEn }).from(usersTable).where(inArray(usersTable.id, userIds)) : [];
    const userById   = new Map(users.map(u => [u.id, u]));

    const enriched = rows.map(r => {
      const inv  = r.invoiceId ? invById.get(r.invoiceId) : null;
      const sess = inv?.posSessionId ? sessById.get(inv.posSessionId) : null;
      const u    = sess?.userId ? userById.get(sess.userId) : null;
      const b    = r.branchId ? branchById.get(r.branchId) : null;
      return {
        id: r.id,
        docNumber: r.docNumber,
        returnDate: r.returnDate,
        status: r.status,
        totalAmount: r.totalAmount,
        vatAmount: r.vatAmount,
        paymentType: r.paymentType,
        invoiceId: r.invoiceId,
        invoiceDocNumber: inv?.docNumber ?? null,
        branchId: r.branchId,
        cashier: u ? { id: u.id, username: u.username, nameAr: u.nameAr, nameEn: u.nameEn } : null,
        branch:  b ? { id: b.id, nameAr: b.nameAr, nameEn: b.nameEn } : null,
      };
    });
    const filtered = f.cashierId
      ? enriched.filter(r => r.cashier?.id === f.cashierId)
      : enriched;
    res.json(filtered);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /pos-operations/summary ────────────────────────────────────────
// Quick counters for the header KPIs.
router.get("/summary", async (req, res) => {
  try {
    const cid = getCid(req, res); if (!cid) return;
    const f = readFilters(req);

    const dateFrom = f.fromDate ?? new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const dateTo   = f.toDate   ?? new Date().toISOString().slice(0, 10);

    // Enforce per-user branch scope on aggregates so branch-restricted users
    // can never see company-wide totals (matches list endpoints' behaviour).
    const allowed = getAllowedBranchIds(req);
    const branchSql = allowed === null
      ? sql`TRUE`
      : allowed.length === 0
        ? sql`FALSE`
        : sql`branch_id IN (${sql.join(allowed.map(b => sql`${b}`), sql`, `)})`;

    const [invStats] = await db.execute<any>(sql`
      SELECT
        COUNT(*)::int                                                AS total,
        COUNT(*) FILTER (WHERE status = 'draft')::int                AS drafts,
        COUNT(*) FILTER (WHERE status = 'posted')::int               AS posted,
        COALESCE(SUM(total_amount) FILTER (WHERE status = 'posted'), 0)::float AS posted_total,
        COALESCE(SUM(total_amount) FILTER (WHERE status = 'draft'),  0)::float AS drafts_total
      FROM sales_invoices
      WHERE company_id = ${cid}
        AND pos_session_id IS NOT NULL
        AND ${branchSql}
        AND invoice_date::date BETWEEN ${dateFrom}::date AND ${dateTo}::date
    `).then((r: any) => r.rows ?? []);

    const [retStats] = await db.execute<any>(sql`
      SELECT
        COUNT(*)::int                                                AS total,
        COUNT(*) FILTER (WHERE status = 'draft')::int                AS drafts,
        COUNT(*) FILTER (WHERE status = 'posted')::int               AS posted,
        COALESCE(SUM(total_amount) FILTER (WHERE status = 'posted'), 0)::float AS posted_total
      FROM sales_returns
      WHERE company_id = ${cid}
        AND ${branchSql}
        AND invoice_id IN (SELECT id FROM sales_invoices WHERE company_id = ${cid} AND pos_session_id IS NOT NULL)
        AND return_date::date BETWEEN ${dateFrom}::date AND ${dateTo}::date
    `).then((r: any) => r.rows ?? []);

    res.json({
      from: dateFrom, to: dateTo,
      invoices: invStats ?? { total: 0, drafts: 0, posted: 0, posted_total: 0, drafts_total: 0 },
      returns:  retStats ?? { total: 0, drafts: 0, posted: 0, posted_total: 0 },
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
