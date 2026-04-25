import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { companiesTable, usersTable, subscriptionsTable, planConfigsTable, invoicesTable, invoiceLineItemsTable, customersTable, suppliersTable, stockLedgerTable, stockBalanceTable, salesInvoicesTable, salesReturnsTable, purchaseInvoicesTable, purchaseReturnsTable, journalEntriesTable, journalEntryLinesTable, itemsTable, notificationsTable, branchesTable, warehousesTable, systemSettingsTable, autoBackupsTable, auditLogTable, sequencesTable, reportEmailSchedulesTable, reportEmailScheduleRunsTable, maintenanceRunsTable, maintenanceScheduleTable } from "@workspace/db";
import { AVAILABLE_REPORTS, REPORT_KEYS } from "../lib/reportDigest.js";
import { ensureScheduleRow, runReportDigest, REPORT_SCHEDULE_ID } from "../lib/reportScheduler.js";
import {
  checkJournalPending, checkBrokenRefs, checkUnlinkedAccounts,
  checkSequenceGaps, checkDormantUsers,
  // Toolbox expansion (F): inventory / accounting / logs categories.
  checkNegativeStock, checkStockBalanceDrift, checkUnbalancedEntries,
  checkOldAuditLogs, checkOldMaintenanceRuns,
  MAINTENANCE_TOOL_KEYS,
} from "../lib/maintenanceChecks.js";
import {
  ensureMaintenanceScheduleRow, getLatestResultsForCompany, getCriticalAlerts,
  runMaintenanceSweep, MAINTENANCE_SCHEDULE_ID, dispatchCriticalDigest,
} from "../lib/maintenanceScheduler.js";
import { emailConfigured } from "../lib/email.js";
import { eq, and, asc, count, inArray, notInArray, sql, desc, lt, isNull, gte, lte, type SQL } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { buildSystemTree, type SystemTree, type Scope } from "../lib/systemRegistry.js";
import { writeAudit } from "../middleware/permissions.js";
import { resolveBearerToken } from "../middleware/auth.js";
import { persistSnapshot, restoreFromSnapshotPayload } from "./backup.js";
import { randomBytes } from "crypto";

const router = Router();

// Middleware: superadmin only.
// We attach the resolved superadmin user to `req.adminUser` for downstream
// handlers via Express's request interface augmentation (see types/express.d.ts
// in this artifact, where `Request.adminUser?: User` is declared).
//
// Recognises both legacy single-session tokens (users.sessionToken) AND
// SuperAdmin multi-session tokens (sa_sessions.sessionToken) via
// resolveBearerToken().
async function requireSuperAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { res.status(401).json({ error: "غير مصرح" }); return; }
  const token = auth.slice(7);

  // Try legacy users.sessionToken first.
  let [user] = await db.select().from(usersTable).where(eq(usersTable.sessionToken, token));

  // Fall back to the SuperAdmin multi-session resolver.
  if (!user) {
    const resolved = await resolveBearerToken(token);
    if (resolved && resolved.origin === "superadmin") {
      const [full] = await db.select().from(usersTable).where(eq(usersTable.id, resolved.user.id));
      if (full) user = full;
    }
  }

  if (!user || !user.isActive || user.role !== "superadmin") {
    res.status(403).json({ error: "هذه الصفحة للمشرف العام فقط" });
    return;
  }
  req.adminUser = user;
  next();
}

// GET /api/admin/requests — all registration requests
router.get("/requests", requireSuperAdmin, async (req, res) => {
  const { status } = req.query as any;
  let query = db.select({
    company: companiesTable,
    user: {
      id: usersTable.id,
      username: usersTable.username,
      email: usersTable.email,
      isActive: usersTable.isActive,
      createdAt: usersTable.createdAt,
    },
    subscription: subscriptionsTable,
  })
  .from(companiesTable)
  .leftJoin(usersTable, eq(usersTable.companyId, companiesTable.id))
  .leftJoin(subscriptionsTable, eq(subscriptionsTable.companyId, companiesTable.id));

  const rows = await query;

  // Filter by status if provided
  const filtered = status
    ? rows.filter(r => r.company.status === status)
    : rows;

  // Group by company (in case of multiple users)
  const seen = new Set<number>();
  const result = filtered.filter(r => {
    if (seen.has(r.company.id)) return false;
    seen.add(r.company.id);
    return true;
  });

  res.json(result);
});

// POST /api/admin/requests/:id/approve
router.post("/requests/:id/approve", requireSuperAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const [company] = await db.update(companiesTable).set({
    status: "active",
    rejectionReason: null,
    updatedAt: new Date(),
  }).where(eq(companiesTable.id, id)).returning();
  if (!company) { res.status(404).json({ error: "الطلب غير موجود" }); return; }

  // Activate all users of this company
  await db.update(usersTable).set({ isActive: true, updatedAt: new Date() })
    .where(eq(usersTable.companyId, id));

  res.json({ ok: true, company });
});

// POST /api/admin/requests/:id/reject
router.post("/requests/:id/reject", requireSuperAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { reason } = req.body;
  const [company] = await db.update(companiesTable).set({
    status: "rejected",
    rejectionReason: reason ?? "تم رفض الطلب",
    updatedAt: new Date(),
  }).where(eq(companiesTable.id, id)).returning();
  if (!company) { res.status(404).json({ error: "الطلب غير موجود" }); return; }

  // Deactivate all users
  await db.update(usersTable).set({ isActive: false, updatedAt: new Date() })
    .where(eq(usersTable.companyId, id));

  res.json({ ok: true, company });
});

// Helper: cascade-delete a company and all its related records
async function deleteCompanyWithRelations(id: number) {
  // 1. Get all invoice IDs for this company
  const companyInvoices = await db.select({ id: invoicesTable.id }).from(invoicesTable).where(eq(invoicesTable.companyId, id));
  const invoiceIds = companyInvoices.map(i => i.id);

  // 2. Delete invoice line items
  for (const invId of invoiceIds) {
    await db.delete(invoiceLineItemsTable).where(eq(invoiceLineItemsTable.invoiceId, invId));
  }

  // 3. Delete invoices
  await db.delete(invoicesTable).where(eq(invoicesTable.companyId, id));

  // 4. Delete customers, suppliers, subscriptions, users
  await db.delete(customersTable).where(eq(customersTable.companyId, id));
  await db.delete(suppliersTable).where(eq(suppliersTable.companyId, id));
  await db.delete(subscriptionsTable).where(eq(subscriptionsTable.companyId, id));
  await db.delete(usersTable).where(eq(usersTable.companyId, id));

  // 5. Delete company
  await db.delete(companiesTable).where(eq(companiesTable.id, id));
}

// DELETE /api/admin/requests/:id — delete request + all relations
router.delete("/requests/:id", requireSuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await deleteCompanyWithRelations(id);
    res.status(204).send();
  } catch (err: any) {
    res.status(500).json({ error: "فشل الحذف: " + (err.message ?? "خطأ غير متوقع") });
  }
});

// GET /api/admin/subscriptions — all subscriptions with company info
router.get("/subscriptions", requireSuperAdmin, async (_req, res) => {
  const rows = await db.select({
    subscription: subscriptionsTable,
    company: {
      id: companiesTable.id,
      nameAr: companiesTable.nameAr,
      vatNumber: companiesTable.vatNumber,
      status: companiesTable.status,
    },
  })
  .from(subscriptionsTable)
  .leftJoin(companiesTable, eq(companiesTable.id, subscriptionsTable.companyId));
  res.json(rows);
});

// ─── Validation helpers ─────────────────────────────────────────────────
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_PLANS    = new Set(["starter", "professional", "enterprise", "custom"]);
const ALLOWED_CYCLES   = new Set(["monthly", "yearly"]);
const isValidISODate = (s: any): s is string =>
  typeof s === "string" && ISO_DATE.test(s) && !isNaN(new Date(s).getTime());
const toBoundedInt = (v: any, min: number, max: number): number | null => {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < min || n > max) return null;
  return n;
};

// PUT /api/admin/subscriptions/:id — update a subscription
router.put("/subscriptions/:id", requireSuperAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const { plan, maxUsers, maxBranches, maxWarehouses, maxInvoices, billingCycle, startDate, endDate, isActive, price } = req.body ?? {};

  const updates: Record<string, any> = {};
  if (plan != null) {
    if (!ALLOWED_PLANS.has(plan)) { res.status(400).json({ error: "باقة غير معروفة" }); return; }
    updates.plan = plan;
  }
  if (billingCycle != null) {
    // Accept legacy "annual" from older rows and normalize to "yearly".
    const bc = billingCycle === "annual" ? "yearly" : billingCycle;
    if (!ALLOWED_CYCLES.has(bc)) { res.status(400).json({ error: "دورة فوترة غير صالحة" }); return; }
    updates.billingCycle = bc;
  }
  for (const [key, val] of Object.entries({ maxUsers, maxBranches, maxWarehouses, maxInvoices })) {
    if (val == null) continue;
    const n = toBoundedInt(val, 0, 1_000_000);
    if (n == null) { res.status(400).json({ error: `قيمة غير صالحة لـ ${key}` }); return; }
    updates[key] = n;
  }
  if (startDate != null) {
    if (!isValidISODate(startDate)) { res.status(400).json({ error: "تاريخ البدء غير صالح" }); return; }
    updates.startDate = startDate;
  }
  if (endDate != null) {
    if (!isValidISODate(endDate)) { res.status(400).json({ error: "تاريخ الانتهاء غير صالح" }); return; }
    updates.endDate = endDate;
  }
  if (updates.startDate && updates.endDate && new Date(updates.endDate) <= new Date(updates.startDate)) {
    res.status(400).json({ error: "تاريخ الانتهاء يجب أن يكون بعد تاريخ البدء" }); return;
  }
  if (isActive != null) updates.isActive = !!isActive;
  if (price    != null) {
    const p = Number(price);
    if (!Number.isFinite(p) || p < 0) { res.status(400).json({ error: "سعر غير صالح" }); return; }
    updates.price = String(p);
  }

  const [updated] = await db.update(subscriptionsTable).set(updates).where(eq(subscriptionsTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "الاشتراك غير موجود" }); return; }
  await writeAudit({
    userId: req.adminUser?.id ?? null,
    username: req.adminUser?.username ?? null,
    role: "superadmin",
    companyId: updated.companyId,
    module: "subscriptions",
    action: "edit",
    entityType: "subscription",
    entityId: String(updated.id),
    metadata: { fields: Object.keys(updates) },
  });
  res.json({ ok: true, subscription: updated });
});

// ─── Subscription Lifecycle (extend / change-plan / bulk / usage) ──────────
const ALLOWED_EXTEND_MONTHS = new Set([1, 3, 6, 12]);

// Drizzle's `db.execute(sql\`...\`)` returns the underlying driver's QueryResult
// shape. The pg driver returns `{ rows: T[] }`; some drivers return the rows
// array directly. This helper normalizes both into a typed row array so we
// don't have to spread `any` through every call site.
type SqlExecuteResult<T> = { rows?: T[] } | T[];
function sqlRows<T>(result: SqlExecuteResult<T>): T[] {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

interface ExtendedRow      { id: number; company_id: number; end_date: string }
interface LatestSubRow {
  id: number; company_id: number; plan: string; billing_cycle: string;
  max_users: number; max_branches: number; max_warehouses: number;
  max_invoices: number; start_date: string; end_date: string; is_active: boolean;
}
interface InvoiceCountRow  { companyId: number; n: number }

function addMonthsISO(dateISO: string, months: number): string {
  // Anchor on the existing endDate (or today if invalid), then add N months.
  // Day-of-month is preserved; for shorter months it clamps to last valid day.
  const base = new Date(dateISO);
  const d = isNaN(base.getTime()) ? new Date() : base;
  const day = d.getUTCDate();
  const newMonth = d.getUTCMonth() + months;
  const candidate = new Date(Date.UTC(d.getUTCFullYear(), newMonth, 1));
  const lastDay = new Date(Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, 0)).getUTCDate();
  candidate.setUTCDate(Math.min(day, lastDay));
  return candidate.toISOString().slice(0, 10);
}

function todayISO(): string { return new Date().toISOString().slice(0, 10); }

// Treat both "annual" (legacy in DB) and "yearly" as the same yearly cycle.
function normalizeCycle(c: string): "monthly" | "yearly" | null {
  if (c === "monthly") return "monthly";
  if (c === "yearly" || c === "annual") return "yearly";
  return null;
}

// POST /api/admin/subscriptions/:id/extend — adds N months to endDate
// Atomic: the read+compute+write happens inside one UPDATE so two concurrent
// extends don't overwrite each other (the race was flagged in code review).
router.post("/subscriptions/:id/extend", requireSuperAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const months = Number(req.body?.months);
  if (!ALLOWED_EXTEND_MONTHS.has(months)) {
    res.status(400).json({ error: "عدد الأشهر يجب أن يكون 1 أو 3 أو 6 أو 12" }); return;
  }
  // Postgres serializes concurrent UPDATEs on the same row, so this single
  // statement is race-free vs. the previous read-then-write.
  const result = await db.execute<ExtendedRow>(sql`
    UPDATE subscriptions
       SET end_date = ((end_date::date + (${months} || ' months')::interval)::date)::text
     WHERE id = ${id}
     RETURNING id, company_id, end_date
  `);
  const row = sqlRows<ExtendedRow>(result as SqlExecuteResult<ExtendedRow>)[0];
  if (!row) { res.status(404).json({ error: "الاشتراك غير موجود" }); return; }
  const [updated] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, id));
  // Renewal restores access: if the company was auto-suspended for expiry
  // and the new endDate is in the future, reactivate it. Otherwise the
  // login block at /api/auth/login keeps blocking even after renewal.
  let reactivated = false;
  if (updated && updated.endDate >= todayISO()) {
    const reRes = await db.update(companiesTable)
      .set({ status: "active" })
      .where(and(eq(companiesTable.id, updated.companyId), eq(companiesTable.status, "suspended")))
      .returning({ id: companiesTable.id });
    reactivated = reRes.length > 0;
  }
  await writeAudit({
    userId: req.adminUser?.id ?? null,
    username: req.adminUser?.username ?? null,
    role: "superadmin",
    companyId: updated?.companyId ?? null,
    module: "subscriptions",
    action: "edit",
    entityType: "subscription",
    entityId: String(id),
    metadata: { op: "extend", months, newEnd: updated?.endDate ?? row.end_date, reactivated },
  });
  res.json({ ok: true, subscription: updated, reactivated });
});

// POST /api/admin/subscriptions/:id/change-plan — switch plan template
router.post("/subscriptions/:id/change-plan", requireSuperAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const planKey = String(req.body?.planKey ?? "");
  const cycleRaw = String(req.body?.billingCycle ?? "monthly");
  const cycle = normalizeCycle(cycleRaw);
  if (!cycle) { res.status(400).json({ error: "دورة فوترة غير صالحة" }); return; }
  if (!ALLOWED_PLANS.has(planKey)) { res.status(400).json({ error: "باقة غير معروفة" }); return; }

  const [existing] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, id));
  if (!existing) { res.status(404).json({ error: "الاشتراك غير موجود" }); return; }
  const [planConfig] = await db.select().from(planConfigsTable).where(eq(planConfigsTable.key, planKey));
  if (!planConfig) { res.status(404).json({ error: "قالب الباقة غير موجود" }); return; }

  const start = todayISO();
  const end   = addMonthsISO(start, cycle === "yearly" ? 12 : 1);
  const price = cycle === "yearly" ? planConfig.annualPrice : planConfig.monthlyPrice;

  // Plan template (plan_configs) is the canonical source of all caps.
  const [updated] = await db.update(subscriptionsTable).set({
    plan: planKey,
    billingCycle: cycle,
    maxUsers: planConfig.maxUsers,
    maxBranches: planConfig.maxBranches,
    maxWarehouses: planConfig.maxWarehouses,
    maxInvoices: planConfig.maxInvoices,
    price: String(price),
    startDate: start,
    endDate: end,
    isActive: true,
  }).where(eq(subscriptionsTable.id, id)).returning();

  // If the company was previously suspended for expiry, revive it.
  if (updated) {
    await db.update(companiesTable)
      .set({ status: "active" })
      .where(and(eq(companiesTable.id, updated.companyId), eq(companiesTable.status, "suspended")));
  }

  await writeAudit({
    userId: req.adminUser?.id ?? null,
    username: req.adminUser?.username ?? null,
    role: "superadmin",
    companyId: updated.companyId,
    module: "subscriptions",
    action: "edit",
    entityType: "subscription",
    entityId: String(id),
    metadata: {
      op: "change-plan",
      from: { plan: existing.plan, billingCycle: existing.billingCycle, price: existing.price, endDate: existing.endDate },
      to:   { plan: planKey,       billingCycle: cycle,                price,                  endDate: end },
    },
  });
  res.json({ ok: true, subscription: updated });
});

// POST /api/admin/subscriptions/bulk-extend — atomic per-row UPDATE
router.post("/subscriptions/bulk-extend", requireSuperAdmin, async (req, res) => {
  const requestedIds: number[] = Array.isArray(req.body?.ids)
    ? req.body.ids.map(Number).filter(Number.isFinite)
    : [];
  const months = Number(req.body?.months);
  if (requestedIds.length === 0)         { res.status(400).json({ error: "حدد اشتراكاً واحداً على الأقل" }); return; }
  if (!ALLOWED_EXTEND_MONTHS.has(months)) {
    res.status(400).json({ error: "عدد الأشهر يجب أن يكون 1 أو 3 أو 6 أو 12" }); return;
  }
  // Single race-free UPDATE — Postgres date arithmetic per row.
  // requestedIds were already validated as finite numbers above, so inlining
  // them as a literal array is injection-safe.
  const idList = sql.raw(requestedIds.join(","));
  const result = await db.execute<ExtendedRow>(sql`
    UPDATE subscriptions
       SET end_date = ((end_date::date + (${months} || ' months')::interval)::date)::text
     WHERE id IN (${idList})
     RETURNING id, company_id, end_date
  `);
  const rows = sqlRows<ExtendedRow>(result as SqlExecuteResult<ExtendedRow>);
  const updatedIds = rows.map(r => Number(r.id));
  const missingIds = requestedIds.filter(id => !updatedIds.includes(id));
  // Reactivate any companies that were auto-suspended for expiry now that
  // their subscription has a future endDate. Group rows by companyId since a
  // company could have multiple subscription rows in the bulk batch.
  const today = todayISO();
  const companyIdsToReactivate = Array.from(new Set(
    rows.filter(r => String(r.end_date) >= today).map(r => Number(r.company_id))
  ));
  let reactivatedCompanyIds: number[] = [];
  if (companyIdsToReactivate.length > 0) {
    const reRes = await db.update(companiesTable)
      .set({ status: "active" })
      .where(and(inArray(companiesTable.id, companyIdsToReactivate), eq(companiesTable.status, "suspended")))
      .returning({ id: companiesTable.id });
    reactivatedCompanyIds = reRes.map(r => r.id);
  }
  for (const r of rows) {
    const cid = Number(r.company_id);
    await writeAudit({
      userId: req.adminUser?.id ?? null,
      username: req.adminUser?.username ?? null,
      role: "superadmin",
      companyId: cid,
      module: "subscriptions",
      action: "edit",
      entityType: "subscription",
      entityId: String(r.id),
      metadata: { op: "bulk-extend", months, newEnd: r.end_date, reactivated: reactivatedCompanyIds.includes(cid) },
    });
  }
  res.json({
    ok: true,
    requestedIds, updatedIds, missingIds,
    processed: updatedIds.length,
    reactivatedCompanyIds,
    results: rows.map(r => ({
      id: Number(r.id),
      ok: true,
      newEnd: r.end_date,
      reactivated: reactivatedCompanyIds.includes(Number(r.company_id)),
    })),
  });
});

// POST /api/admin/subscriptions/bulk-freeze
router.post("/subscriptions/bulk-freeze", requireSuperAdmin, async (req, res) => {
  const requestedIds: number[] = Array.isArray(req.body?.ids)
    ? req.body.ids.map(Number).filter(Number.isFinite)
    : [];
  const isActive = !!req.body?.isActive;
  if (requestedIds.length === 0) { res.status(400).json({ error: "حدد اشتراكاً واحداً على الأقل" }); return; }
  // RETURNING gives us the actual updated rows so we can compute missingIds.
  const updated = await db.update(subscriptionsTable)
    .set({ isActive })
    .where(inArray(subscriptionsTable.id, requestedIds))
    .returning({ id: subscriptionsTable.id, companyId: subscriptionsTable.companyId });
  const updatedIds = updated.map(r => r.id);
  const missingIds = requestedIds.filter(id => !updatedIds.includes(id));
  for (const u of updated) {
    await writeAudit({
      userId: req.adminUser?.id ?? null,
      username: req.adminUser?.username ?? null,
      role: "superadmin",
      companyId: u.companyId,
      module: "subscriptions",
      action: "edit",
      entityType: "subscription",
      entityId: String(u.id),
      metadata: { op: isActive ? "bulk-activate" : "bulk-freeze" },
    });
  }
  res.json({
    ok: true,
    requestedIds, updatedIds, missingIds,
    processed: updatedIds.length,
    isActive,
  });
});

// GET /api/admin/subscriptions/usage — actual vs allowed per company
// Picks the LATEST subscription per company (in case multiple historical rows
// exist) so usage isn't multi-counted across superseded subscriptions.
// Default scope is active subscriptions belonging to non-suspended companies
// (the actionable set for over-limit alerts). Pass ?scope=all to include every
// company.
router.get("/subscriptions/usage", requireSuperAdmin, async (req, res) => {
  const scope = String(req.query?.scope ?? "active");
  const userCounts     = await db.select({ companyId: usersTable.companyId, n: count() })
    .from(usersTable).groupBy(usersTable.companyId);
  const branchCounts   = await db.select({ companyId: branchesTable.companyId, n: count() })
    .from(branchesTable).groupBy(branchesTable.companyId);
  const warehouseCounts = await db.select({ companyId: warehousesTable.companyId, n: count() })
    .from(warehousesTable).groupBy(warehousesTable.companyId);

  // Latest subscription per company via DISTINCT ON.
  const latestSubsResult = await db.execute<LatestSubRow>(sql`
    SELECT DISTINCT ON (company_id)
           id, company_id, plan, billing_cycle, max_users, max_branches,
           max_warehouses, max_invoices, start_date, end_date, is_active
      FROM subscriptions
     ORDER BY company_id, end_date DESC, id DESC
  `);
  const latestSubsRows = sqlRows<LatestSubRow>(latestSubsResult as SqlExecuteResult<LatestSubRow>);

  const companyIds = latestSubsRows.map(s => Number(s.company_id));
  const companies = companyIds.length === 0 ? [] : await db.select({
    id: companiesTable.id, nameAr: companiesTable.nameAr, status: companiesTable.status,
  }).from(companiesTable).where(inArray(companiesTable.id, companyIds));
  const companyMap = new Map(companies.map(c => [c.id, c]));

  // Invoices within current subscription period of the LATEST sub only.
  const invoiceResult = await db.execute<InvoiceCountRow>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (company_id) company_id, start_date
        FROM subscriptions
       ORDER BY company_id, end_date DESC, id DESC
    )
    SELECT l.company_id AS "companyId", COUNT(i.id)::int AS "n"
      FROM latest l
      LEFT JOIN sales_invoices i
        ON i.company_id = l.company_id
       AND i.created_at >= (l.start_date::date)::timestamp
     GROUP BY l.company_id
  `);
  const invoiceRows = sqlRows<InvoiceCountRow>(invoiceResult as SqlExecuteResult<InvoiceCountRow>);

  const userMap     = new Map(userCounts.map(r => [r.companyId, Number(r.n)]));
  const branchMap   = new Map(branchCounts.map(r => [r.companyId, Number(r.n)]));
  const warehouseMap = new Map(warehouseCounts.map(r => [r.companyId, Number(r.n)]));
  const invoiceMap  = new Map(invoiceRows.map(r => [r.companyId, Number(r.n)]));

  const filteredSubs = scope === "all"
    ? latestSubsRows
    : latestSubsRows.filter((sub) => {
        const c = companyMap.get(Number(sub.company_id));
        return !!sub.is_active && c?.status !== "suspended";
      });

  const out = filteredSubs.map((sub) => {
    const cid = Number(sub.company_id);
    const company = companyMap.get(cid);
    const allowed = {
      users:     Number(sub.max_users),
      branches:  Number(sub.max_branches),
      warehouses: Number(sub.max_warehouses),
      invoices:  Number(sub.max_invoices),
    };
    const actual = {
      users:     userMap.get(cid) ?? 0,
      branches:  branchMap.get(cid) ?? 0,
      warehouses: warehouseMap.get(cid) ?? 0,
      invoices:  invoiceMap.get(cid) ?? 0,
    };
    const overFields: string[] = [];
    (Object.keys(allowed) as Array<keyof typeof allowed>).forEach(k => {
      if (actual[k] > allowed[k]) overFields.push(k);
    });
    return {
      subscriptionId: Number(sub.id),
      companyId: cid,
      companyName: company?.nameAr ?? null,
      companyStatus: company?.status ?? null,
      plan: sub.plan,
      billingCycle: sub.billing_cycle,
      isActive: !!sub.is_active,
      startDate: sub.start_date,
      endDate: sub.end_date,
      allowed, actual,
      overLimit: overFields.length > 0,
      overFields,
    };
  });
  res.json(out);
});

// ─── System Settings (currently only auto-suspend flag) ────────────────────
const AUTO_SUSPEND_KEY = "auto_suspend_expired";

router.get("/system-settings/auto-suspend", requireSuperAdmin, async (_req, res) => {
  const [row] = await db.select().from(systemSettingsTable).where(eq(systemSettingsTable.key, AUTO_SUSPEND_KEY));
  res.json({ enabled: row?.value === "on", updatedAt: row?.updatedAt ?? null });
});

router.put("/system-settings/auto-suspend", requireSuperAdmin, async (req, res) => {
  const enabled = !!req.body?.enabled;
  const value = enabled ? "on" : "off";
  await db.execute(sql`
    INSERT INTO system_settings (key, value, updated_at) VALUES (${AUTO_SUSPEND_KEY}, ${value}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `);
  await writeAudit({
    userId: req.adminUser?.id ?? null,
    username: req.adminUser?.username ?? null,
    role: "superadmin",
    companyId: null,
    module: "subscriptions",
    action: "edit",
    entityType: "system_setting",
    entityId: AUTO_SUSPEND_KEY,
    metadata: { enabled },
  });
  res.json({ ok: true, enabled });
});

// POST /api/admin/licenses — upsert a license/subscription for a company
router.post("/licenses", requireSuperAdmin, async (req, res) => {
  try {
    const body = req.body ?? {};
    const companyId = toBoundedInt(body.companyId, 1, Number.MAX_SAFE_INTEGER);
    if (companyId == null) { res.status(400).json({ error: "companyId مطلوب وصحيح" }); return; }

    // Verify company exists (clean 4xx instead of FK 500)
    const [company] = await db.select({ id: companiesTable.id }).from(companiesTable).where(eq(companiesTable.id, companyId));
    if (!company) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }

    const plan         = body.plan          ?? "professional";
    const billingCycle = body.billingCycle  ?? "monthly";
    if (!ALLOWED_PLANS.has(plan))    { res.status(400).json({ error: "باقة غير معروفة" }); return; }
    if (!ALLOWED_CYCLES.has(billingCycle)) { res.status(400).json({ error: "دورة فوترة غير صالحة" }); return; }

    if (!isValidISODate(body.startDate)) { res.status(400).json({ error: "تاريخ البدء غير صالح" }); return; }
    if (!isValidISODate(body.endDate))   { res.status(400).json({ error: "تاريخ الانتهاء غير صالح" }); return; }
    if (new Date(body.endDate) <= new Date(body.startDate)) {
      res.status(400).json({ error: "تاريخ الانتهاء يجب أن يكون بعد تاريخ البدء" }); return;
    }

    const maxUsers      = toBoundedInt(body.maxUsers      ?? 5,   0, 1_000_000);
    const maxBranches   = toBoundedInt(body.maxBranches   ?? 1,   0, 1_000_000);
    const maxWarehouses = toBoundedInt(body.maxWarehouses ?? 1,   0, 1_000_000);
    const maxInvoices   = toBoundedInt(body.maxInvoices   ?? 500, 0, 1_000_000);
    if ([maxUsers, maxBranches, maxWarehouses, maxInvoices].some(v => v == null)) {
      res.status(400).json({ error: "قيم الحدود يجب أن تكون أعداد صحيحة موجبة" }); return;
    }
    const priceNum = Number(body.price ?? 0);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      res.status(400).json({ error: "سعر غير صالح" }); return;
    }

    const payload = {
      companyId, plan, billingCycle,
      startDate: body.startDate,
      endDate: body.endDate,
      isActive: body.isActive == null ? true : !!body.isActive,
      price: String(priceNum),
      maxUsers: maxUsers!, maxBranches: maxBranches!,
      maxWarehouses: maxWarehouses!, maxInvoices: maxInvoices!,
    };

    const [existing] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, companyId));
    if (existing) {
      const [updated] = await db.update(subscriptionsTable).set(payload).where(eq(subscriptionsTable.id, existing.id)).returning();
      res.json({ ok: true, subscription: updated, action: "updated" });
    } else {
      const [created] = await db.insert(subscriptionsTable).values(payload).returning();
      res.json({ ok: true, subscription: created, action: "created" });
    }
  } catch (err: any) {
    res.status(500).json({ error: "فشل الحفظ: " + (err.message ?? "خطأ غير متوقع") });
  }
});

// POST /api/admin/seed — create superadmin (only if none exists)
router.post("/seed", async (req, res) => {
  const existing = await db.select().from(usersTable).where(eq(usersTable.role, "superadmin"));
  if (existing.length > 0) {
    res.status(409).json({ error: "المشرف العام موجود مسبقاً", username: existing[0].username });
    return;
  }
  const { username = "superadmin", password = "SuperAdmin@2026" } = req.body;
  const passwordHash = await bcrypt.hash(password, 12);
  const [user] = await db.insert(usersTable).values({
    username,
    email: null,
    passwordHash,
    companyId: null,
    role: "superadmin",
    isActive: true,
    sessionToken: null,
    sessionId: null,
  }).returning();
  res.status(201).json({ ok: true, username: user.username, message: "تم إنشاء المشرف العام بنجاح" });
});

// GET /api/admin/stats — quick stats for superadmin dashboard
router.get("/stats", requireSuperAdmin, async (_req, res) => {
  const companies = await db.select().from(companiesTable);
  const users = await db.select().from(usersTable).where(eq(usersTable.role, "admin"));
  const pending = companies.filter(c => c.status === "pending").length;
  const active = companies.filter(c => c.status === "active").length;
  const rejected = companies.filter(c => c.status === "rejected").length;
  res.json({ total: companies.length, pending, active, rejected, users: users.length });
});

// GET /api/admin/dashboard — single aggregated payload for the SuperAdmin
// Control Center home page. Every figure is derived from a SQL aggregate
// (no full table loads) so this stays fast as the system grows.
router.get("/dashboard", requireSuperAdmin, async (_req, res) => {
  try {
    const [
      companiesAgg,
      signupsTimeline,
      signupsTrend,
      usersAgg,
      subsByPlan,
      backupsAgg,
      missingBackups,
      auditAgg,
    ] = await Promise.all([
      // A) Companies grouped by status
      db.execute<{ status: string; count: string }>(sql`
        SELECT status, COUNT(*)::text AS count
        FROM companies
        GROUP BY status
      `),
      // B) New-company timeline for last 90 days, bucketed by day
      db.execute<{ day: string; count: string }>(sql`
        SELECT DATE_TRUNC('day', created_at)::date::text AS day, COUNT(*)::text AS count
        FROM companies
        WHERE created_at >= NOW() - INTERVAL '90 days'
        GROUP BY day
        ORDER BY day
      `),
      // C) Signups this week vs prior week (for delta tile)
      db.execute<{ this_week: string; last_week: string }>(sql`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::text  AS this_week,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '14 days'
                       AND created_at <  NOW() - INTERVAL '7 days')::text         AS last_week
        FROM companies
      `),
      // D) User counts (total, active in last 24h, by role)
      db.execute<{ total: string; active_today: string; superadmins: string; admins: string }>(sql`
        SELECT
          COUNT(*)::text                                                            AS total,
          COUNT(*) FILTER (WHERE last_login_at > NOW() - INTERVAL '24 hours')::text AS active_today,
          COUNT(*) FILTER (WHERE role = 'superadmin')::text                         AS superadmins,
          COUNT(*) FILTER (WHERE role = 'admin')::text                              AS admins
        FROM users
      `),
      // E) Subscription distribution + revenue + expiry buckets per plan.
      //    end_date is stored as TEXT (default ''); we therefore guard every
      //    cast with a regex check so legacy/empty rows never crash the
      //    aggregate. price is also TEXT — coerce safely with NULLIF + cast.
      db.execute<{
        plan: string; count: string; revenue: string;
        expiring: string; expired: string;
      }>(sql`
        SELECT
          plan,
          -- Truly active per plan = is_active=TRUE AND not date-expired.
          -- Empty/non-date end_date is treated as "no end" (i.e. still active).
          COUNT(*) FILTER (
            WHERE end_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
               OR end_date::date >= CURRENT_DATE
          )::text AS count,
          -- Revenue mirrors the same active scope.
          COALESCE(SUM(NULLIF(price, '')::numeric) FILTER (
            WHERE end_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
               OR end_date::date >= CURRENT_DATE
          ), 0)::text AS revenue,
          COUNT(*) FILTER (
            WHERE end_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
              AND end_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTEGER '30'
          )::text AS expiring,
          COUNT(*) FILTER (
            WHERE end_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
              AND end_date::date < CURRENT_DATE
          )::text AS expired
        FROM subscriptions
        WHERE is_active = TRUE
        GROUP BY plan
      `),
      // F) Backup totals (last 7 days + storage used)
      db.execute<{ backups_7d: string; total_size: string; distinct_companies_7d: string }>(sql`
        SELECT
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::text          AS backups_7d,
          COALESCE(SUM(size_bytes), 0)::text                                             AS total_size,
          COUNT(DISTINCT company_id) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::text
                                                                                         AS distinct_companies_7d
        FROM auto_backups
      `),
      // G) Active companies that have NOT been backed up in 7+ days (or never)
      db.execute<{ id: number; name_ar: string; last_backup: string | null }>(sql`
        SELECT c.id, c.name_ar, MAX(b.created_at)::text AS last_backup
        FROM companies c
        LEFT JOIN auto_backups b ON b.company_id = c.id
        WHERE c.status = 'active'
        GROUP BY c.id, c.name_ar
        HAVING MAX(b.created_at) IS NULL
            OR MAX(b.created_at) < NOW() - INTERVAL '7 days'
        ORDER BY c.name_ar
      `),
      // H) Audit log summary
      db.execute<{ events_today: string; denied_7d: string; logins_24h: string }>(sql`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::text                          AS events_today,
          COUNT(*) FILTER (WHERE action = 'denied'
                       AND created_at > NOW() - INTERVAL '7 days')::text                    AS denied_7d,
          COUNT(*) FILTER (WHERE action = 'login'
                       AND created_at > NOW() - INTERVAL '24 hours')::text                  AS logins_24h
        FROM audit_log
      `),
    ]);

    // ─── Companies summary ──────────────────────────────────────────────
    const byStatus: Record<string, number> = {};
    for (const row of companiesAgg.rows ?? []) {
      byStatus[row.status] = Number(row.count) || 0;
    }
    // Sum ALL grouped statuses (not just a hard-coded subset) so any future
    // status value still contributes to the headline total.
    const totalCompanies = Object.values(byStatus).reduce((a, b) => a + b, 0);

    // ─── Subscriptions roll-up across plans ─────────────────────────────
    // Lifecycle assumption: `is_active` is the *administrative* flag (set by
    // the operator). `end_date` is the contractual expiry. The two are NOT
    // automatically synced — a subscription may be admin-active yet
    // contractually expired, in which case the operator should deactivate
    // it. We therefore expose both views:
    //   • active  — is_active=TRUE AND (end_date empty/non-date OR >= today)
    //   • expired — is_active=TRUE AND end_date::date < today
    //               (rows that need operator action)
    //   • expiring — is_active=TRUE AND end_date in [today, +30 days]
    // byPlan.count and byPlan.revenue mirror the `active` definition so the
    // distribution chart and revenue figure reconcile with the headline KPI.
    let totalActiveSubs = 0, totalExpiring = 0, totalExpired = 0, totalRevenue = 0;
    const planDistribution: { plan: string; count: number; revenue: number }[] = [];
    for (const row of subsByPlan.rows ?? []) {
      const c = Number(row.count) || 0;
      const r = Number(row.revenue) || 0;
      totalActiveSubs += c;
      totalExpiring   += Number(row.expiring) || 0;
      totalExpired    += Number(row.expired)  || 0;
      totalRevenue    += r;
      planDistribution.push({ plan: row.plan, count: c, revenue: r });
    }

    // ─── Trend deltas ──────────────────────────────────────────────────
    const trendRow = signupsTrend.rows?.[0];
    const signupsThisWeek = Number(trendRow?.this_week ?? 0);
    const signupsLastWeek = Number(trendRow?.last_week ?? 0);

    // ─── Users ─────────────────────────────────────────────────────────
    const u = usersAgg.rows?.[0];

    // ─── Backups ───────────────────────────────────────────────────────
    const b = backupsAgg.rows?.[0];
    const missingBackupCompanies = (missingBackups.rows ?? []).map(r => ({
      id: r.id,
      nameAr: r.name_ar,
      lastBackup: r.last_backup,
    }));

    // ─── Audit ─────────────────────────────────────────────────────────
    const a = auditAgg.rows?.[0];

    // ─── Health flags (for the System Health card) ─────────────────────
    type HealthFlag = {
      level: "red" | "amber" | "green";
      message: string;
      href?: string;
    };
    const health: HealthFlag[] = [];
    if (missingBackupCompanies.length > 0) {
      health.push({
        level: "red",
        message: `${missingBackupCompanies.length} شركة لم تأخذ نسخة احتياطية منذ 7 أيام أو أكثر`,
        href: "/admin/backups",
      });
    }
    if (totalExpired > 0) {
      health.push({
        level: "red",
        message: `${totalExpired} اشتراك منتهي يحتاج تجديداً`,
        href: "/admin/subscriptions",
      });
    }
    if (totalExpiring > 0) {
      health.push({
        level: "amber",
        message: `${totalExpiring} اشتراك سينتهي خلال 30 يوماً`,
        href: "/admin/subscriptions",
      });
    }
    if ((byStatus.pending ?? 0) > 0) {
      health.push({
        level: "amber",
        message: `${byStatus.pending} طلب تسجيل بانتظار المراجعة`,
        href: "/admin/requests",
      });
    }
    const deniedCount = Number(a?.denied_7d ?? 0);
    if (deniedCount >= 5) {
      health.push({
        level: "amber",
        message: `${deniedCount} محاولة وصول مرفوضة خلال آخر 7 أيام`,
        href: "/admin/audit-log",
      });
    }

    // Maintenance: critical findings from the latest scheduled scan. Suppressed
    // when the operator has snoozed the banner from the maintenance toolbox.
    try {
      const [schedRow] = await db.select().from(maintenanceScheduleTable)
        .where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));
      const muted = schedRow?.alertsMutedUntil && new Date(schedRow.alertsMutedUntil).getTime() > Date.now();
      if (!muted) {
        const alerts = await getCriticalAlerts(50);
        if (alerts.length > 0) {
          const distinctCompanies = new Set(alerts.map(a => a.companyId)).size;
          health.push({
            level: "red",
            message: `${alerts.length} نتيجة صيانة حرجة في ${distinctCompanies} شركة — تحتاج مراجعة`,
            href: "/admin/ai-fix",
          });
        }
      }
    } catch (e: any) {
      console.error("[admin/dashboard] maintenance critical summary failed:", e?.message ?? e);
    }

    if (health.length === 0) {
      health.push({ level: "green", message: "النظام يعمل بكفاءة — لا توجد تنبيهات" });
    }

    res.json({
      companies: {
        total:      totalCompanies,
        active:     byStatus.active     ?? 0,
        pending:    byStatus.pending    ?? 0,
        rejected:   byStatus.rejected   ?? 0,
        suspended:  byStatus.suspended  ?? 0,
        signupsThisWeek,
        signupsLastWeek,
        signupsDelta: signupsThisWeek - signupsLastWeek,
      },
      users: {
        total:        Number(u?.total        ?? 0),
        activeToday:  Number(u?.active_today ?? 0),
        superadmins:  Number(u?.superadmins  ?? 0),
        admins:       Number(u?.admins       ?? 0),
      },
      subscriptions: {
        active:    totalActiveSubs,
        expiring:  totalExpiring,   // within next 30 days
        expired:   totalExpired,
        revenue:   totalRevenue,    // sum of price across active subs
        byPlan:    planDistribution,
      },
      backups: {
        last7d:                Number(b?.backups_7d            ?? 0),
        totalSizeBytes:        Number(b?.total_size            ?? 0),
        distinctCompanies7d:   Number(b?.distinct_companies_7d ?? 0),
        missingCount:          missingBackupCompanies.length,
        missing:               missingBackupCompanies.slice(0, 10), // cap for payload size
      },
      audit: {
        eventsToday: Number(a?.events_today ?? 0),
        denied7d:    deniedCount,
        logins24h:   Number(a?.logins_24h   ?? 0),
      },
      signupsTimeline: (signupsTimeline.rows ?? []).map(r => ({
        day:   r.day,
        count: Number(r.count) || 0,
      })),
      health,
      generatedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[admin/dashboard] aggregation failed:", detail);
    res.status(500).json({ error: "تعذر جلب بيانات لوحة التحكم" });
  }
});

// GET /api/admin/companies/:id — full company profile for superadmin
router.get("/companies/:id", requireSuperAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, id));
  if (!company) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }

  const [subscription] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, id));
  const users = await db.select({
    id: usersTable.id,
    username: usersTable.username,
    email: usersTable.email,
    role: usersTable.role,
    isActive: usersTable.isActive,
    lastLoginAt: usersTable.lastLoginAt,
    createdAt: usersTable.createdAt,
  }).from(usersTable).where(eq(usersTable.companyId, id));

  const [[{ invoiceCount }], [{ customerCount }], [{ supplierCount }]] = await Promise.all([
    db.select({ invoiceCount: count() }).from(invoicesTable).where(eq(invoicesTable.companyId, id)),
    db.select({ customerCount: count() }).from(customersTable).where(eq(customersTable.companyId, id)),
    db.select({ supplierCount: count() }).from(suppliersTable).where(eq(suppliersTable.companyId, id)),
  ]);

  res.json({ company, subscription: subscription ?? null, users, counts: { invoices: invoiceCount, customers: customerCount, suppliers: supplierCount } });
});

// POST /api/admin/companies/:id/users — add user to a company
router.post("/companies/:id/users", requireSuperAdmin, async (req, res) => {
  const companyId = parseInt(req.params.id);
  const { username, email, password, role = "admin" } = req.body;
  if (!username || !password) { res.status(400).json({ error: "اسم المستخدم وكلمة المرور مطلوبان" }); return; }

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.username, username));
  if (existing) { res.status(409).json({ error: "اسم المستخدم موجود مسبقاً" }); return; }

  const passwordHash = await bcrypt.hash(password, 12);
  const [newUser] = await db.insert(usersTable).values({
    username, email: email ?? null, passwordHash, companyId, role, isActive: true,
  }).returning({ id: usersTable.id, username: usersTable.username, email: usersTable.email, role: usersTable.role, isActive: usersTable.isActive, createdAt: usersTable.createdAt });
  res.status(201).json({ ok: true, user: newUser });
});

// DELETE /api/admin/companies/:id/users/:userId — remove user from a company
router.delete("/companies/:id/users/:userId", requireSuperAdmin, async (req, res) => {
  const userId = parseInt(req.params.userId);
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  res.status(204).send();
});

// PUT /api/admin/companies/:id/users/:userId — toggle user active status
router.put("/companies/:id/users/:userId", requireSuperAdmin, async (req, res) => {
  const userId = parseInt(req.params.userId);
  const { isActive, password } = req.body;
  const updates: Record<string, any> = { updatedAt: new Date() };
  if (isActive != null) updates.isActive = isActive;
  if (password) updates.passwordHash = await bcrypt.hash(password, 12);
  const [updated] = await db.update(usersTable).set(updates).where(eq(usersTable.id, userId)).returning();
  res.json({ ok: true, user: updated });
});

// GET /api/admin/plans — public (used by Register page too)
router.get("/plans", async (_req, res) => {
  const plans = await db.select().from(planConfigsTable).orderBy(asc(planConfigsTable.sortOrder));
  res.json(plans.map(p => ({
    ...p,
    features: JSON.parse(p.features || "[]"),
  })));
});

// PUT /api/admin/plans/:key — update plan config (superadmin only)
router.put("/plans/:key", requireSuperAdmin, async (req, res) => {
  const { key } = req.params;
  const {
    nameAr, nameEn, monthlyPrice, annualPrice,
    maxUsers, maxInvoices, features,
    isRecommended, isActive, sortOrder,
  } = req.body;

  const updates: Record<string, any> = { updatedAt: new Date() };
  if (nameAr        != null) updates.nameAr        = nameAr;
  if (nameEn        != null) updates.nameEn        = nameEn;
  if (monthlyPrice  != null) updates.monthlyPrice  = String(monthlyPrice);
  if (annualPrice   != null) updates.annualPrice   = String(annualPrice);
  if (maxUsers      != null) updates.maxUsers      = Number(maxUsers);
  if (maxInvoices   != null) updates.maxInvoices   = Number(maxInvoices);
  if (features      != null) updates.features      = JSON.stringify(features);
  if (isRecommended != null) updates.isRecommended = isRecommended;
  if (isActive      != null) updates.isActive      = isActive;
  if (sortOrder     != null) updates.sortOrder      = Number(sortOrder);

  const [updated] = await db.update(planConfigsTable)
    .set(updates)
    .where(eq(planConfigsTable.key, key))
    .returning();

  if (!updated) { res.status(404).json({ error: "الباقة غير موجودة" }); return; }
  res.json({ ok: true, plan: { ...updated, features: JSON.parse(updated.features || "[]") } });
});

// ─── Orphan stock movements cleanup ───────────────────────────────────────────
// "Orphan" = a stock_ledger entry whose ref_type points at an invoice/return doc
// (sales_invoice | sales_return | purchase_invoice | purchase_return) but the
// referenced source row no longer exists (the doc was deleted).

const ORPHAN_REF_TYPES = ["sales_invoice", "sales_return", "purchase_invoice", "purchase_return"] as const;

async function filterTrueOrphans(executor: typeof db, rows: any[]) {
  if (!rows.length) return [];
  const idsByType: Record<string, Set<number>> = {
    sales_invoice: new Set(), sales_return: new Set(),
    purchase_invoice: new Set(), purchase_return: new Set(),
  };
  for (const r of rows) {
    if (r.refId != null && r.refType && idsByType[r.refType]) idsByType[r.refType].add(r.refId);
  }
  const existing: Record<string, Set<number>> = {
    sales_invoice: new Set(), sales_return: new Set(),
    purchase_invoice: new Set(), purchase_return: new Set(),
  };
  const checks: [string, any, any][] = [
    ["sales_invoice",    salesInvoicesTable,    salesInvoicesTable.id],
    ["sales_return",     salesReturnsTable,     salesReturnsTable.id],
    ["purchase_invoice", purchaseInvoicesTable, purchaseInvoicesTable.id],
    ["purchase_return",  purchaseReturnsTable,  purchaseReturnsTable.id],
  ];
  for (const [type, table, idCol] of checks) {
    const ids = Array.from(idsByType[type]);
    if (!ids.length) continue;
    const found = await executor.select({ id: idCol }).from(table).where(inArray(idCol, ids));
    for (const f of found) existing[type].add(Number(f.id));
  }
  return rows.filter(r => r.refType && r.refId != null && !existing[r.refType]?.has(Number(r.refId)));
}

async function getOrphanLedgerRows(companyId: number) {
  const rows = await db.select().from(stockLedgerTable).where(and(
    eq(stockLedgerTable.companyId, companyId),
    inArray(stockLedgerTable.refType, ORPHAN_REF_TYPES as unknown as string[]),
  ));
  return filterTrueOrphans(db, rows);
}

// GET /api/admin/companies — minimal list for dropdowns
router.get("/companies", requireSuperAdmin, async (_req, res) => {
  const rows = await db.select({
    id: companiesTable.id, nameAr: companiesTable.nameAr, nameEn: companiesTable.nameEn, status: companiesTable.status,
  }).from(companiesTable).orderBy(asc(companiesTable.nameAr));
  res.json(rows);
});

// GET /api/admin/orphan-stock?companyId=X — preview orphan stock ledger rows
router.get("/orphan-stock", requireSuperAdmin, async (req, res) => {
  const companyId = Number(req.query.companyId);
  if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }
  const orphans = await getOrphanLedgerRows(companyId);
  res.json({
    count: orphans.length,
    totalQty: orphans.reduce((s, r) => s + Number(r.qty), 0),
    orphanIds: orphans.map(o => o.id),         // full set for snapshot-bound cleanup
    rows: orphans.slice(0, 200),               // sample for UI table
  });
});

// POST /api/admin/orphan-stock/cleanup
//   body: { companyId, orphanIds: number[] }
//   - Re-validates each supplied id inside a transaction (still orphan, same company,
//     valid refType) so a stale preview can never delete more than the user reviewed.
//   - Aggregates qty per (item, warehouse) and applies a single atomic SQL delta to
//     stock_balance (`qty = qty - sum`), avoiding read-modify-write races.
//   - Deletes the orphan ledger rows in the same transaction.
router.post("/orphan-stock/cleanup", requireSuperAdmin, async (req, res) => {
  const companyId = Number(req.body?.companyId);
  const suppliedIds = Array.isArray(req.body?.orphanIds)
    ? req.body.orphanIds.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
    : [];
  if (!companyId)        { res.status(400).json({ error: "companyId مطلوب" }); return; }
  if (!suppliedIds.length){ res.json({ ok: true, deleted: 0, balancesAdjusted: 0 }); return; }

  try {
    const result = await db.transaction(async (tx) => {
      // Load only rows that match (company + supplied ids + an orphan-eligible refType)
      const candidates = await tx.select().from(stockLedgerTable).where(and(
        eq(stockLedgerTable.companyId, companyId),
        inArray(stockLedgerTable.id, suppliedIds),
        inArray(stockLedgerTable.refType, ORPHAN_REF_TYPES as unknown as string[]),
      ));
      const trulyOrphan = await filterTrueOrphans(tx as unknown as typeof db, candidates);
      if (!trulyOrphan.length) return { deleted: 0, balancesAdjusted: 0 };

      // Aggregate qty per (itemId, warehouseId)
      const deltas = new Map<string, { itemId: number; warehouseId: number; sum: number }>();
      for (const r of trulyOrphan) {
        const key = `${r.itemId}|${r.warehouseId}`;
        const cur = deltas.get(key) ?? { itemId: r.itemId, warehouseId: r.warehouseId, sum: 0 };
        cur.sum += Number(r.qty);
        deltas.set(key, cur);
      }

      // Atomic SQL delta per (item, warehouse) — no RMW, race-safe under concurrency
      let balancesAdjusted = 0;
      for (const { itemId, warehouseId, sum } of deltas.values()) {
        const updated = await tx.update(stockBalanceTable)
          .set({ qty: sql`${stockBalanceTable.qty} - ${String(sum)}`, updatedAt: new Date() })
          .where(and(
            eq(stockBalanceTable.companyId,   companyId),
            eq(stockBalanceTable.itemId,      itemId),
            eq(stockBalanceTable.warehouseId, warehouseId),
          ))
          .returning({ id: stockBalanceTable.id });
        balancesAdjusted += updated.length;
      }

      await tx.delete(stockLedgerTable).where(inArray(stockLedgerTable.id, trulyOrphan.map(r => r.id)));
      return { deleted: trulyOrphan.length, balancesAdjusted };
    });

    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل التنظيف" });
  }
});

// ─── AI-assisted company diagnostics (read-only) ──────────────────────────────
// Runs a battery of data-integrity checks for one company, then asks the
// configured LLM to write a friendly Arabic summary + prioritized recommendations.
// IMPORTANT: This endpoint never writes data. Fixes (if any) are performed
// elsewhere by the superadmin (e.g. orphan-stock cleanup).

const OPENAI_BASE = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
const OPENAI_KEY  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

type Severity = "high" | "medium" | "low";
type CheckResult = {
  key: string; label: string; severity: Severity;
  count: number; samples: any[];
};

async function diagnoseCompany(companyId: number): Promise<CheckResult[]> {
  const out: CheckResult[] = [];

  // 1) Unbalanced journal entries
  const unbalanced = await db.execute(sql`
    SELECT je.id, je.doc_number, je.entry_date,
           COALESCE(SUM(jel.debit), 0)::text  AS total_debit,
           COALESCE(SUM(jel.credit), 0)::text AS total_credit
    FROM journal_entries je
    LEFT JOIN journal_entry_lines jel ON jel.entry_id = je.id
    WHERE je.company_id = ${companyId}
    GROUP BY je.id, je.doc_number, je.entry_date
    HAVING ROUND(COALESCE(SUM(jel.debit),0) - COALESCE(SUM(jel.credit),0), 2) <> 0
    ORDER BY je.id DESC
    LIMIT 50
  `);
  const unbRows = (unbalanced as any).rows ?? [];
  out.push({
    key: "unbalanced_journals", label: "قيود يومية غير متوازنة (مدين ≠ دائن)",
    severity: "high", count: unbRows.length, samples: unbRows.slice(0, 10),
  });

  // 2) Negative stock balances
  const neg = await db.select({
    id: stockBalanceTable.id, itemId: stockBalanceTable.itemId,
    warehouseId: stockBalanceTable.warehouseId, qty: stockBalanceTable.qty,
  }).from(stockBalanceTable).where(and(
    eq(stockBalanceTable.companyId, companyId),
    sql`${stockBalanceTable.qty} < 0`,
  )).limit(50);
  out.push({
    key: "negative_stock", label: "أرصدة مخزون سالبة",
    severity: "high", count: neg.length, samples: neg.slice(0, 10),
  });

  // 3) Sales invoices without a journal entry (or with a stale one)
  const salesNoJE = await db.execute(sql`
    SELECT si.id, si.doc_number, si.invoice_date, si.total_amount
    FROM sales_invoices si
    WHERE si.company_id = ${companyId}
      AND si.status = 'posted'
      AND (si.journal_entry_id IS NULL
           OR NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.id = si.journal_entry_id))
    ORDER BY si.id DESC LIMIT 50
  `);
  const sniRows = (salesNoJE as any).rows ?? [];
  out.push({
    key: "sales_invoices_without_je", label: "فواتير مبيعات مرحّلة بدون قيد محاسبي",
    severity: "high", count: sniRows.length, samples: sniRows.slice(0, 10),
  });

  // 4) Purchase invoices without a journal entry
  const purNoJE = await db.execute(sql`
    SELECT pi.id, pi.doc_number, pi.invoice_date, pi.total_amount
    FROM purchase_invoices pi
    WHERE pi.company_id = ${companyId}
      AND pi.status = 'posted'
      AND (pi.journal_entry_id IS NULL
           OR NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.id = pi.journal_entry_id))
    ORDER BY pi.id DESC LIMIT 50
  `);
  const pniRows = (purNoJE as any).rows ?? [];
  out.push({
    key: "purchase_invoices_without_je", label: "فواتير مشتريات مرحّلة بدون قيد محاسبي",
    severity: "high", count: pniRows.length, samples: pniRows.slice(0, 10),
  });

  // 5) Orphan stock movements (re-uses cleanup detector)
  const orphans = await getOrphanLedgerRows(companyId);
  out.push({
    key: "orphan_stock", label: "حركات مخزون يتيمة (مستندها محذوف)",
    severity: "medium", count: orphans.length,
    samples: orphans.slice(0, 10).map(o => ({
      id: o.id, itemId: o.itemId, warehouseId: o.warehouseId,
      refType: o.refType, refId: o.refId, qty: o.qty, txDate: o.txDate,
    })),
  });

  // 6) Stock items without a sale price
  const noPrice = await db.select({
    id: itemsTable.id, code: itemsTable.code, nameAr: itemsTable.nameAr, salePrice: itemsTable.salePrice,
  }).from(itemsTable).where(and(
    eq(itemsTable.companyId, companyId),
    eq(itemsTable.itemType,  "stock" as any),
    eq(itemsTable.status,    "active" as any),
    sql`${itemsTable.salePrice}::numeric = 0`,
  )).limit(50);
  out.push({
    key: "items_without_price", label: "أصناف مخزنية فعّالة بدون سعر بيع",
    severity: "medium", count: noPrice.length, samples: noPrice.slice(0, 10),
  });

  // 7) Stock items without a cost
  const noCost = await db.select({
    id: itemsTable.id, code: itemsTable.code, nameAr: itemsTable.nameAr, costPrice: itemsTable.costPrice,
  }).from(itemsTable).where(and(
    eq(itemsTable.companyId, companyId),
    eq(itemsTable.itemType,  "stock" as any),
    eq(itemsTable.status,    "active" as any),
    sql`${itemsTable.costPrice}::numeric = 0`,
  )).limit(50);
  out.push({
    key: "items_without_cost", label: "أصناف مخزنية فعّالة بدون سعر تكلفة",
    severity: "low", count: noCost.length, samples: noCost.slice(0, 10),
  });

  // 8) Stock balance ≠ sum of ledger qty (drift)
  const drift = await db.execute(sql`
    SELECT sb.item_id, sb.warehouse_id,
           sb.qty::text                              AS balance_qty,
           COALESCE(SUM(sl.qty),0)::text             AS ledger_sum
    FROM stock_balance sb
    LEFT JOIN stock_ledger sl
      ON sl.company_id   = sb.company_id
     AND sl.item_id      = sb.item_id
     AND sl.warehouse_id = sb.warehouse_id
    WHERE sb.company_id = ${companyId}
    GROUP BY sb.item_id, sb.warehouse_id, sb.qty
    HAVING ROUND(sb.qty::numeric - COALESCE(SUM(sl.qty),0), 4) <> 0
    LIMIT 50
  `);
  const driftRows = (drift as any).rows ?? [];
  out.push({
    key: "stock_balance_drift", label: "اختلاف بين رصيد المخزون ومجموع الحركات",
    severity: "medium", count: driftRows.length, samples: driftRows.slice(0, 10),
  });

  return out;
}

// GET /api/admin/ai-fix/diagnose?companyId=X
router.get("/ai-fix/diagnose", requireSuperAdmin, async (req, res) => {
  const companyId = Number(req.query.companyId);
  if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }
  try {
    const checks = await diagnoseCompany(companyId);
    const totalIssues = checks.reduce((s, c) => s + c.count, 0);
    res.json({ companyId, totalIssues, checks });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل التشخيص" });
  }
});

// POST /api/admin/ai-fix/summarize  body: { companyId, checks }
//   Sends compact (no PII beyond ids) check summary to the LLM and returns an
//   Arabic narrative + prioritized recommendation list. Read-only on data.
router.post("/ai-fix/summarize", requireSuperAdmin, async (req, res) => {
  const { companyId, checks } = (req.body ?? {}) as { companyId: number; checks: CheckResult[] };
  if (!companyId || !Array.isArray(checks)) { res.status(400).json({ error: "companyId و checks مطلوبان" }); return; }
  if (!OPENAI_BASE || !OPENAI_KEY) {
    res.status(503).json({ error: "خدمة الذكاء الاصطناعي غير مهيأة" }); return;
  }

  const [company] = await db.select({ id: companiesTable.id, nameAr: companiesTable.nameAr, nameEn: companiesTable.nameEn })
    .from(companiesTable).where(eq(companiesTable.id, companyId));

  // Trim payload — keep counts + small samples only
  const compact = checks.map(c => ({
    key: c.key, label: c.label, severity: c.severity, count: c.count,
    samples: (c.samples ?? []).slice(0, 5),
  }));

  const userPrompt = `أنت مدقق محاسبي ومخزني خبير في نظام ERP سعودي يدعم فاتورة ZATCA.
إليك نتائج فحص بيانات الشركة "${company?.nameAr ?? "—"}" (id=${companyId}):

${JSON.stringify(compact, null, 2)}

اكتب تقريراً موجزاً بالعربية الفصحى المهنية وبصيغة Markdown يتضمن:
1. **ملخص الحالة** في فقرة واحدة (٢-٣ أسطر) عن الوضع العام للشركة.
2. **أهم المشاكل** مرتبة حسب الخطورة (high أولاً) — لكل مشكلة: السبب المحتمل، والأثر على القوائم المالية أو المخزون.
3. **خطوات الإصلاح المقترحة** كقائمة مرقمة عملية وموجهة لمشرف النظام، ذكر اسم الشاشة في النظام إن أمكن (مثل: "صفحة تنظيف حركات المخزون اليتيمة" للمشكلة orphan_stock، "دفتر الأستاذ / القيود اليومية" للقيود غير المتوازنة).
4. إن لم تكن هناك مشاكل (كل العدّادات = 0)، اكتب فقرة قصيرة تؤكد سلامة البيانات.

لا تختلق أرقاماً غير موجودة في المدخلات. لا تذكر تنفيذ الإصلاحات تلقائياً.`;

  try {
    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_completion_tokens: 2048,
        messages: [
          { role: "system", content: "أنت مدقق محاسبي ومخزني خبير. ترد بالعربية الفصحى وبصيغة Markdown منظمة. لا تخترع بيانات، واستخدم فقط المدخلات." },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      res.status(502).json({ error: `فشل استدعاء الذكاء الاصطناعي: ${r.status} ${txt.slice(0, 200)}` });
      return;
    }
    const data = await r.json();
    const summary = data?.choices?.[0]?.message?.content ?? "";
    res.json({ summary });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل التلخيص" });
  }
});

// ─── System Auto-Discovery (SuperAdmin AI Repair) ─────────────────────────────
// GET /api/admin/ai-fix/system-tree?scope=superadmin|tenant|all
//
// Returns the auto-discovered structure of the entire system: every Express
// router (via reflection on app.router.stack), every public DB table (via
// pg_class), every frontend page file (filesystem scan of pages/), and every
// dashboard widget label (regex over SuperAdmin*.tsx + admin/*.tsx). NOTHING
// is hand-maintained — adding a new route, table, page, or widget shows up
// here automatically on the next request.
router.get("/ai-fix/system-tree", requireSuperAdmin, async (req, res) => {
  try {
    const raw = String(req.query.scope ?? "superadmin");
    const scope: Scope | "all" =
      raw === "tenant" || raw === "shared" || raw === "all" ? raw : "superadmin";
    const tree = await buildSystemTree(scope);
    res.json(tree);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل اكتشاف هيكل النظام" });
  }
});

// POST /api/admin/ai-fix/system-summarize  body: { tree }
//   AI-generated Arabic markdown report on the discovered system structure.
//   Read-only: never mutates anything; never executes auto-fixes.
router.post("/ai-fix/system-summarize", requireSuperAdmin, async (req, res) => {
  const tree = (req.body?.tree ?? null) as SystemTree | null;
  if (!tree || typeof tree !== "object") { res.status(400).json({ error: "tree مطلوب" }); return; }
  if (!OPENAI_BASE || !OPENAI_KEY) {
    res.status(503).json({ error: "خدمة الذكاء الاصطناعي غير مهيأة" }); return;
  }

  // Compact payload — keep only what the LLM needs to reason about coverage.
  // Drop endpoint paths to a count per module (full list would be wasteful).
  const compact = {
    generatedAt: tree.generatedAt,
    scope: tree.scopeFilter,
    totals: tree.totals,
    apiModules: tree.apiModules.map(m => ({
      mount: m.mount, scope: m.scope, endpointCount: m.endpoints.length,
      sampleMethods: Array.from(new Set(m.endpoints.flatMap(e => e.method.split("|")))).slice(0, 6),
    })),
    dbDomains: tree.dbDomains.map(d => ({ table: d.table, rows: d.rowCountApprox })),
    screensByCategory: Array.from(
      tree.screens.reduce((acc, s) => {
        acc.set(s.category, (acc.get(s.category) ?? 0) + 1);
        return acc;
      }, new Map<string, number>()),
    ).map(([category, count]) => ({ category, count })),
    dashboardWidgets: tree.dashboardWidgets.slice(0, 80),
  };

  const userPrompt = `أنت مهندس أنظمة ERP خبير. لديك خريطة شاملة (مكتشفة تلقائياً) لنظام ERP سعودي يدعم فاتورة ZATCA من نطاق المشرف العام (SuperAdmin):

${JSON.stringify(compact, null, 2)}

اكتب تقريراً موجزاً بالعربية الفصحى المهنية وبصيغة Markdown يتضمن:
1. **نظرة عامة على البنية**: عدد الموديولات، الشاشات، الجداول، عناصر لوحة التحكم.
2. **تغطية SuperAdmin**: ما الموديولات والشاشات التي تخدم المشرف العام تحديداً، وما الذي يبدو غائباً أو ناقصاً مقارنة بنظام ERP متكامل (مثل: تقارير اشتراكات، إعدادات أمان، سجل تدقيق، إدارة خطط، صيانة بيانات).
3. **توصيات للمشرف العام**: قائمة مرقمة (٣-٧ بنود) بأولويات التطوير أو الفحوص التشغيلية المقترحة، مع ربط كل توصية باسم موديول/شاشة فعلية من الخريطة.
4. لا تختلق أسماء موديولات أو جداول غير موجودة في المدخلات. ولا تذكر تنفيذ أي إصلاح تلقائي.`;

  try {
    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_completion_tokens: 2048,
        messages: [
          { role: "system", content: "أنت مهندس أنظمة ERP خبير. ترد بالعربية الفصحى وبصيغة Markdown منظمة. استخدم فقط ما ورد في المدخلات." },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      res.status(502).json({ error: `فشل استدعاء الذكاء الاصطناعي: ${r.status} ${txt.slice(0, 200)}` });
      return;
    }
    const data = await r.json();
    const summary = data?.choices?.[0]?.message?.content ?? "";
    res.json({ summary });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل التلخيص" });
  }
});

// POST /api/admin/ai-fix/notify
//   Body: { companyId, checkKey }
//   Asks AI to write an Arabic Markdown explanation + step-by-step fix for one
//   specific issue, then inserts a broadcast notification (userId=NULL) for that
//   company so all its admins/managers see it in the bell + /notifications page.
// Allow-list of check keys → ensures arbitrary strings can't trigger work,
// and used to dispatch to single-check runners.
const SINGLE_CHECK_RUNNERS: Record<string, (companyId: number) => Promise<CheckResult>> = {
  unbalanced_journals:          (id) => runOneCheck(id, "unbalanced_journals"),
  negative_stock:               (id) => runOneCheck(id, "negative_stock"),
  sales_invoices_without_je:    (id) => runOneCheck(id, "sales_invoices_without_je"),
  purchase_invoices_without_je: (id) => runOneCheck(id, "purchase_invoices_without_je"),
  orphan_stock:                 (id) => runOneCheck(id, "orphan_stock"),
  items_without_price:          (id) => runOneCheck(id, "items_without_price"),
  items_without_cost:           (id) => runOneCheck(id, "items_without_cost"),
  stock_balance_drift:          (id) => runOneCheck(id, "stock_balance_drift"),
};
async function runOneCheck(companyId: number, key: string): Promise<CheckResult> {
  // Cheap re-implementation that runs only the queries needed for one key.
  // Mirrors logic in diagnoseCompany() — keep them in sync.
  if (key === "unbalanced_journals") {
    const r = await db.execute(sql`
      SELECT je.id, je.doc_number, je.entry_date,
             COALESCE(SUM(jel.debit),0)::text AS total_debit,
             COALESCE(SUM(jel.credit),0)::text AS total_credit
      FROM journal_entries je
      LEFT JOIN journal_entry_lines jel ON jel.entry_id = je.id
      WHERE je.company_id = ${companyId}
      GROUP BY je.id, je.doc_number, je.entry_date
      HAVING ROUND(COALESCE(SUM(jel.debit),0) - COALESCE(SUM(jel.credit),0), 2) <> 0
      ORDER BY je.id DESC LIMIT 50`);
    const rows = (r as any).rows ?? [];
    return { key, label: "قيود يومية غير متوازنة (مدين ≠ دائن)", severity: "high", count: rows.length, samples: rows.slice(0, 10) };
  }
  if (key === "negative_stock") {
    const rows = await db.select({ id: stockBalanceTable.id, itemId: stockBalanceTable.itemId, warehouseId: stockBalanceTable.warehouseId, qty: stockBalanceTable.qty })
      .from(stockBalanceTable).where(and(eq(stockBalanceTable.companyId, companyId), sql`${stockBalanceTable.qty} < 0`)).limit(50);
    return { key, label: "أرصدة مخزون سالبة", severity: "high", count: rows.length, samples: rows.slice(0, 10) };
  }
  if (key === "sales_invoices_without_je") {
    const r = await db.execute(sql`
      SELECT si.id, si.doc_number, si.invoice_date, si.total_amount FROM sales_invoices si
      WHERE si.company_id = ${companyId} AND si.status = 'posted'
        AND (si.journal_entry_id IS NULL OR NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.id = si.journal_entry_id))
      ORDER BY si.id DESC LIMIT 50`);
    const rows = (r as any).rows ?? [];
    return { key, label: "فواتير مبيعات مرحّلة بدون قيد محاسبي", severity: "high", count: rows.length, samples: rows.slice(0, 10) };
  }
  if (key === "purchase_invoices_without_je") {
    const r = await db.execute(sql`
      SELECT pi.id, pi.doc_number, pi.invoice_date, pi.total_amount FROM purchase_invoices pi
      WHERE pi.company_id = ${companyId} AND pi.status = 'posted'
        AND (pi.journal_entry_id IS NULL OR NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.id = pi.journal_entry_id))
      ORDER BY pi.id DESC LIMIT 50`);
    const rows = (r as any).rows ?? [];
    return { key, label: "فواتير مشتريات مرحّلة بدون قيد محاسبي", severity: "high", count: rows.length, samples: rows.slice(0, 10) };
  }
  if (key === "orphan_stock") {
    const orphans = await getOrphanLedgerRows(companyId);
    return {
      key, label: "حركات مخزون يتيمة (مستندها محذوف)", severity: "medium", count: orphans.length,
      samples: orphans.slice(0, 10).map(o => ({ id: o.id, itemId: o.itemId, warehouseId: o.warehouseId, refType: o.refType, refId: o.refId, qty: o.qty, txDate: o.txDate })),
    };
  }
  if (key === "items_without_price") {
    const rows = await db.select({ id: itemsTable.id, code: itemsTable.code, nameAr: itemsTable.nameAr, salePrice: itemsTable.salePrice })
      .from(itemsTable).where(and(eq(itemsTable.companyId, companyId), eq(itemsTable.itemType, "stock" as any), eq(itemsTable.status, "active" as any), sql`${itemsTable.salePrice}::numeric = 0`)).limit(50);
    return { key, label: "أصناف مخزنية فعّالة بدون سعر بيع", severity: "medium", count: rows.length, samples: rows.slice(0, 10) };
  }
  if (key === "items_without_cost") {
    const rows = await db.select({ id: itemsTable.id, code: itemsTable.code, nameAr: itemsTable.nameAr, costPrice: itemsTable.costPrice })
      .from(itemsTable).where(and(eq(itemsTable.companyId, companyId), eq(itemsTable.itemType, "stock" as any), eq(itemsTable.status, "active" as any), sql`${itemsTable.costPrice}::numeric = 0`)).limit(50);
    return { key, label: "أصناف مخزنية فعّالة بدون سعر تكلفة", severity: "low", count: rows.length, samples: rows.slice(0, 10) };
  }
  if (key === "stock_balance_drift") {
    const r = await db.execute(sql`
      SELECT sb.item_id, sb.warehouse_id, sb.qty::text AS balance_qty, COALESCE(SUM(sl.qty),0)::text AS ledger_sum
      FROM stock_balance sb
      LEFT JOIN stock_ledger sl ON sl.company_id = sb.company_id AND sl.item_id = sb.item_id AND sl.warehouse_id = sb.warehouse_id
      WHERE sb.company_id = ${companyId}
      GROUP BY sb.item_id, sb.warehouse_id, sb.qty
      HAVING ROUND(sb.qty::numeric - COALESCE(SUM(sl.qty),0), 4) <> 0 LIMIT 50`);
    const rows = (r as any).rows ?? [];
    return { key, label: "اختلاف بين رصيد المخزون ومجموع الحركات", severity: "medium", count: rows.length, samples: rows.slice(0, 10) };
  }
  throw new Error(`نوع فحص غير معروف: ${key}`);
}

router.post("/ai-fix/notify", requireSuperAdmin, async (req, res) => {
  const { companyId: rawCid, checkKey } = (req.body ?? {}) as { companyId: any; checkKey: any };
  const companyId = Number(rawCid);
  if (!Number.isInteger(companyId) || companyId <= 0) { res.status(400).json({ error: "companyId غير صالح" }); return; }
  if (typeof checkKey !== "string" || !SINGLE_CHECK_RUNNERS[checkKey]) {
    res.status(400).json({ error: "checkKey غير صالح" }); return;
  }
  if (!OPENAI_BASE || !OPENAI_KEY) { res.status(503).json({ error: "خدمة الذكاء الاصطناعي غير مهيأة" }); return; }

  try {
    const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId));
    if (!company) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }

    // Run only the requested single check (cheaper + faster than diagnoseCompany).
    const check = await SINGLE_CHECK_RUNNERS[checkKey](companyId);
    if (check.count === 0) { res.status(400).json({ error: "لا توجد مشاكل في هذا الفحص لإرسال تنبيه عنها" }); return; }

    // Idempotency guard: don't insert another notification for the same
    // (company, sourceKey) within the last 5 minutes — protects against
    // accidental double-clicks / retries.
    const recent = await db.execute(sql`
      SELECT id FROM notifications
      WHERE company_id = ${companyId}
        AND source_key = ${checkKey}
        AND created_at > NOW() - INTERVAL '5 minutes'
      LIMIT 1
    `);
    const recentRows = (recent as any).rows ?? [];
    if (recentRows.length > 0) {
      res.status(409).json({ error: "تم إرسال تنبيه مماثل خلال آخر ٥ دقائق. يرجى الانتظار قليلاً." });
      return;
    }

    const screenHints: Record<string, string> = {
      unbalanced_journals:           "دفتر الأستاذ / القيود اليومية",
      negative_stock:                "تقارير المخزون / حركة الأصناف",
      sales_invoices_without_je:     "فواتير المبيعات",
      purchase_invoices_without_je:  "فواتير المشتريات",
      orphan_stock:                  "(يحتاج تدخّل مدير النظام لتنظيفها)",
      items_without_price:           "إدارة الأصناف",
      items_without_cost:            "إدارة الأصناف",
      stock_balance_drift:           "تقارير المخزون / إعادة حساب الأرصدة",
    };

    const userPrompt = `مشكلة تم اكتشافها في بيانات الشركة "${company.nameAr ?? "—"}":
- نوع المشكلة: ${check.label} (${check.key})
- درجة الخطورة: ${check.severity}
- عدد السجلات المتأثرة: ${check.count}
- عينة من السجلات: ${JSON.stringify(check.samples.slice(0, 5))}
- الشاشة المقترحة في النظام: ${screenHints[check.key] ?? "—"}

اكتب تنبيهاً موجهاً لمدير الشركة بالعربية الفصحى وبصيغة Markdown يحتوي على:
1. **سبب المشكلة** في فقرة قصيرة (سطرين كحد أقصى).
2. **الأثر** المتوقع على القوائم المالية أو المخزون.
3. **خطوات الحل** كقائمة مرقمة عملية ومحددة، مع ذكر اسم الشاشة في النظام.
لا تذكر أرقاماً غير موجودة في المدخلات. لا تخترع بيانات. اجعل النص قابلاً للقراءة بسرعة.`;

    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_completion_tokens: 1024,
        messages: [
          { role: "system", content: "أنت مدقق محاسبي ومخزني خبير. ترد بالعربية الفصحى وبصيغة Markdown منظمة وموجزة." },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      res.status(502).json({ error: `فشل استدعاء الذكاء الاصطناعي: ${r.status} ${txt.slice(0, 200)}` });
      return;
    }
    const data = await r.json();
    const body: string = data?.choices?.[0]?.message?.content ?? "";
    if (!body.trim()) { res.status(502).json({ error: "تعذّر توليد محتوى التنبيه" }); return; }

    const title = `[${check.count}] ${check.label}`;
    // Broadcast: userId NULL so every user of the company sees it. Recipient
    // count is computed for the response from the active users in the company.
    const [inserted] = await db.insert(notificationsTable).values({
      companyId, userId: null, title, body,
      severity: check.severity, category: "ai_diagnostic",
      sourceKey: check.key, createdByUserId: req.adminUser!.id,
    }).returning();

    const [{ recipients }] = await db.select({
      recipients: sql<number>`COUNT(*)::int`,
    }).from(usersTable).where(and(
      eq(usersTable.companyId, companyId),
      eq(usersTable.isActive, true),
    ));

    res.json({ ok: true, notificationId: inserted.id, recipients });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل إرسال التنبيه" });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// Backup Operations Center
// SuperAdmin oversight across ALL companies. NEVER selects autoBackups.data
// jsonb (it can be megabytes per row); only metadata + sizeBytes/counts.
// Per-company backup actions still go through /api/backup/* — these
// endpoints exist purely to aggregate the cross-company view and to bulk-
// trigger snapshots in the background.
// ═════════════════════════════════════════════════════════════════════════

interface OverviewLatest {
  id: number;
  createdAt: Date;
  reason: string;
  sizeBytes: number;
  counts: Record<string, number> | null;
}
interface OverviewCompanyRow {
  id: number;
  nameAr: string;
  vatNumber: string;
  status: string;
  autoBackupEnabled: boolean;
  autoBackupFrequencyHours: number;
  autoBackupRetention: number;
  lastAutoBackupAt: string | null;
  // Aggregates
  snapshotsLast30d: number;
  totalSizeBytes30d: number;
  // Total size across ALL stored snapshots for this company (spec requirement
  // for the "size per company" column in the operations table).
  totalSizeBytesAll: number;
  latest: OverviewLatest | null;
  // Health bucket. `disabled` = autoBackup off; otherwise green/amber/red
  // based on age vs frequency.
  bucket: "green" | "amber" | "red" | "disabled";
  ageHours: number | null;
}

function backupBucket(
  enabled: boolean,
  _frequencyHours: number,
  lastAtISO: string | null,
): { bucket: OverviewCompanyRow["bucket"]; ageHours: number | null } {
  // Fixed-threshold bucket logic per task spec:
  //   <24h        → green
  //   1–7 days    → amber
  //   >7 days     → red
  //   never       → red (highlight as missing)
  //   off toggle  → disabled
  if (!enabled) return { bucket: "disabled", ageHours: lastAtISO ? hoursSince(lastAtISO) : null };
  if (!lastAtISO) return { bucket: "red", ageHours: null };
  const age = hoursSince(lastAtISO);
  if (age < 24)        return { bucket: "green", ageHours: age };
  if (age <= 24 * 7)   return { bucket: "amber", ageHours: age };
  return { bucket: "red", ageHours: age };
}
function hoursSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (Date.now() - t) / 3_600_000);
}

// GET /api/admin/backups/overview — per-company backup health for ALL companies
router.get("/backups/overview", requireSuperAdmin, async (_req, res) => {
  try {
    // 1. All companies (we want disabled & suspended too, so admin can see them).
    const companies = await db.select({
      id: companiesTable.id,
      nameAr: companiesTable.nameAr,
      vatNumber: companiesTable.vatNumber,
      status: companiesTable.status,
      autoBackupEnabled: companiesTable.autoBackupEnabled,
      autoBackupFrequencyHours: companiesTable.autoBackupFrequencyHours,
      autoBackupRetention: companiesTable.autoBackupRetention,
      lastAutoBackupAt: companiesTable.lastAutoBackupAt,
    }).from(companiesTable).orderBy(asc(companiesTable.nameAr));

    if (companies.length === 0) {
      res.json({
        kpis: {
          total: 0, green: 0, amber: 0, red: 0, disabled: 0,
          snapshots30d: 0, totalSize30d: 0, totalSizeAll: 0, missing: 0,
          // Spec-required tiles (7-day window):
          totalBackupsAll: 0, backedUpLast7d: 0, missingOver7d: 0,
        },
        rows: [],
        generatedAt: new Date().toISOString(),
      });
      return;
    }

    const companyIds = companies.map(c => c.id);
    const since30d = new Date(Date.now() - 30 * 24 * 3_600_000);

    // 2. 30-day aggregate per company (count + total size). Never touch `data`.
    const aggRows = await db.select({
      companyId: autoBackupsTable.companyId,
      cnt: count(),
      total: sql<number>`COALESCE(SUM(${autoBackupsTable.sizeBytes}), 0)::bigint`,
    })
      .from(autoBackupsTable)
      .where(and(
        inArray(autoBackupsTable.companyId, companyIds),
        gte(autoBackupsTable.createdAt, since30d),
      ))
      .groupBy(autoBackupsTable.companyId);
    const agg30 = new Map<number, { cnt: number; total: number }>();
    for (const r of aggRows) {
      agg30.set(Number(r.companyId), { cnt: Number(r.cnt), total: Number(r.total) });
    }

    // 3. All-time total size per company (one row).
    const allTimeRows = await db.select({
      companyId: autoBackupsTable.companyId,
      total: sql<number>`COALESCE(SUM(${autoBackupsTable.sizeBytes}), 0)::bigint`,
    })
      .from(autoBackupsTable)
      .where(inArray(autoBackupsTable.companyId, companyIds))
      .groupBy(autoBackupsTable.companyId);
    const sizeAll = new Map<number, number>();
    for (const r of allTimeRows) sizeAll.set(Number(r.companyId), Number(r.total));

    // 4. Latest snapshot per company via DISTINCT ON. Selects metadata only.
    interface LatestRow {
      id: number; company_id: number; created_at: Date; reason: string;
      size_bytes: number; counts: Record<string, number> | null;
    }
    const latestRes = await db.execute<LatestRow>(sql`
      SELECT DISTINCT ON (company_id)
             id, company_id, created_at, reason, size_bytes, counts
        FROM auto_backups
       WHERE company_id IN (${sql.join(companyIds.map(id => sql`${id}`), sql`, `)})
       ORDER BY company_id, created_at DESC, id DESC
    `);
    const latestRowsArr: LatestRow[] = Array.isArray(latestRes)
      ? latestRes
      : ((latestRes as { rows?: LatestRow[] }).rows ?? []);
    const latestByCompany = new Map<number, OverviewLatest>();
    for (const r of latestRowsArr) {
      latestByCompany.set(Number(r.company_id), {
        id: Number(r.id),
        createdAt: r.created_at,
        reason: r.reason,
        sizeBytes: Number(r.size_bytes),
        counts: r.counts,
      });
    }

    // 5. Total snapshot count across the system (one cheap COUNT(*)).
    const [totalCntRow] = await db.select({ c: count() }).from(autoBackupsTable);
    const totalBackupsAll = Number(totalCntRow?.c ?? 0);

    // 6. Build rows + KPIs.
    const rows: OverviewCompanyRow[] = [];
    const kpis = {
      total: companies.length, green: 0, amber: 0, red: 0, disabled: 0,
      snapshots30d: 0, totalSize30d: 0, totalSizeAll: 0, missing: 0,
      // Spec-required tiles:
      totalBackupsAll,
      backedUpLast7d: 0,   // companies whose latest snapshot is within last 7 days
      missingOver7d: 0,    // companies with no snapshot OR last snapshot >7 days ago
    };
    const sevenDaysAgoMs = Date.now() - 7 * 24 * 3_600_000;

    for (const c of companies) {
      const a = agg30.get(c.id) ?? { cnt: 0, total: 0 };
      const latest = latestByCompany.get(c.id) ?? null;
      // Source of truth for "latest backup" is the actual latest snapshot row
      // in auto_backups, NOT companies.lastAutoBackupAt — the cached column on
      // companies can drift after snapshot deletions and would falsely report
      // a recent/healthy state for a company whose snapshots were all removed.
      const lastIso = latest?.createdAt
        ? new Date(latest.createdAt).toISOString()
        : null;
      const { bucket, ageHours } = backupBucket(
        c.autoBackupEnabled, c.autoBackupFrequencyHours, lastIso,
      );

      kpis[bucket]++;
      kpis.snapshots30d  += a.cnt;
      kpis.totalSize30d  += a.total;
      kpis.totalSizeAll  += sizeAll.get(c.id) ?? 0;
      if (!latest) kpis.missing++;

      // 7-day tile aggregates — independent of the bucket logic above.
      const lastMs = lastIso ? new Date(lastIso).getTime() : null;
      if (lastMs != null && lastMs >= sevenDaysAgoMs) kpis.backedUpLast7d++;
      else                                            kpis.missingOver7d++;

      rows.push({
        id: c.id,
        nameAr: c.nameAr,
        vatNumber: c.vatNumber,
        status: c.status,
        autoBackupEnabled: c.autoBackupEnabled,
        autoBackupFrequencyHours: c.autoBackupFrequencyHours,
        autoBackupRetention: c.autoBackupRetention,
        lastAutoBackupAt: lastIso,
        snapshotsLast30d: a.cnt,
        totalSizeBytes30d: a.total,
        totalSizeBytesAll: sizeAll.get(c.id) ?? 0,
        latest,
        bucket,
        ageHours,
      });
    }

    res.json({ kpis, rows, generatedAt: new Date().toISOString() });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "خطأ غير متوقع";
    res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// NOTE: Per-company backup operations (settings / run-now / delete / restore /
// download / history list) are intentionally NOT duplicated here. The Backup
// Operations Center calls the existing /api/backup/* endpoints with the
// cross-tenant `?companyId=` (or body.companyId) override that
// resolveCompanyId() already grants to superadmin role. Audit entries for
// cross-tenant superadmin actions live alongside those endpoints in
// backup.ts via isCrossTenantSuperadmin(). Only aggregate admin-only
// surfaces (/overview, /run-all, /run-all/:jobId) belong here.
// ─────────────────────────────────────────────────────────────────────────
// Stub kept temporarily so older tabs hitting the deprecated path see a
// clear 410 instead of a 404 with no explanation.
router.all("/backups/auto/settings/:companyId", requireSuperAdmin, (_req, res) => {
  res.status(410).json({ error: "نُقل هذا المسار إلى /api/backup/auto/settings (مع companyId في body)" });
});
router.all("/backups/run-now/:companyId", requireSuperAdmin, (_req, res) => {
  res.status(410).json({ error: "نُقل هذا المسار إلى /api/backup/auto/run-now (مع companyId في body)" });
});
router.all("/backups/auto/list/:companyId", requireSuperAdmin, (_req, res) => {
  res.status(410).json({ error: "نُقل هذا المسار إلى /api/backup/auto/list?companyId=" });
});

// ─── Bulk run-all (background job with polling) ─────────────────────────
// Persisting snapshots for many companies can take minutes (each one
// re-reads every master-data table). We can't keep the HTTP request open
// that long, so we kick off an in-memory job and let the client poll.
//
// Job retention: completed jobs stay in memory for 1 hour, then are GC'd.
// On API restart all in-flight jobs are lost — superadmin can simply
// re-run; per-snapshot persistence in PostgreSQL is durable.

interface BulkRunItem {
  companyId: number;
  companyName: string;
  status: "pending" | "running" | "ok" | "error";
  snapshotId?: number;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}
interface BulkRunJob {
  id: string;
  startedBy: number | null;
  startedAt: number;
  finishedAt?: number;
  total: number;
  completed: number;
  failed: number;
  items: BulkRunItem[];
  status: "running" | "done";
}
const bulkJobs = new Map<string, BulkRunJob>();
function gcBulkJobs() {
  const cutoff = Date.now() - 60 * 60_000;
  for (const [id, job] of bulkJobs) {
    if (job.status === "done" && (job.finishedAt ?? job.startedAt) < cutoff) {
      bulkJobs.delete(id);
    }
  }
}

async function runBulkJob(job: BulkRunJob, adminUser: { id: number; username: string } | null) {
  for (const item of job.items) {
    item.status = "running";
    item.startedAt = Date.now();
    try {
      const id = await persistSnapshot(item.companyId, "manual");
      item.snapshotId = id;
      item.status = "ok";
      job.completed++;
      await writeAudit({
        userId: adminUser?.id ?? null,
        username: adminUser?.username ?? null,
        role: "superadmin",
        companyId: item.companyId,
        module: "backups",
        action: "create",
        entityType: "auto_backup",
        entityId: String(id),
        metadata: { op: "bulk-run-all", jobId: job.id },
      });
    } catch (e: unknown) {
      item.status = "error";
      item.error = e instanceof Error ? e.message : "خطأ غير متوقع";
      job.failed++;
      // Audit per-company failure inside bulk job for full mutation accountability.
      await writeAudit({
        userId: adminUser?.id ?? null,
        username: adminUser?.username ?? null,
        role: "superadmin",
        companyId: item.companyId,
        module: "backups",
        action: "create",
        entityType: "auto_backup",
        metadata: { op: "bulk-run-all", jobId: job.id, success: false, error: item.error },
      });
    } finally {
      item.finishedAt = Date.now();
    }
  }
  job.status = "done";
  job.finishedAt = Date.now();
  gcBulkJobs();
}

// POST /api/admin/backups/run-all  body: { scope?: "enabled" | "all" }
// Returns immediately with { jobId, total }. Use GET /backups/run-all/:jobId
// to poll progress.
router.post("/backups/run-all", requireSuperAdmin, async (req, res) => {
  try {
    gcBulkJobs();
    // Default scope per task spec is "all" (every active company). The
    // "enabled" scope is an opt-in narrower run for operators who only
    // want the auto-backup-enabled subset.
    const scope = req.body?.scope === "enabled" ? "enabled" : "all";
    const where = scope === "enabled"
      ? and(eq(companiesTable.status, "active"), eq(companiesTable.autoBackupEnabled, true))
      : eq(companiesTable.status, "active");
    const companies = await db.select({
      id: companiesTable.id,
      nameAr: companiesTable.nameAr,
    }).from(companiesTable).where(where).orderBy(asc(companiesTable.nameAr));

    if (companies.length === 0) {
      res.status(400).json({ error: scope === "enabled"
        ? "لا توجد شركات مفعّل لها النسخ التلقائي"
        : "لا توجد شركات نشطة" });
      return;
    }

    // Reject if another bulk run is still in flight (keeps audit clean).
    for (const j of bulkJobs.values()) {
      if (j.status === "running") {
        res.status(409).json({ error: "هناك تشغيل جماعي قيد التنفيذ بالفعل", runningJobId: j.id });
        return;
      }
    }

    const jobId = randomBytes(8).toString("hex");
    const job: BulkRunJob = {
      id: jobId,
      startedBy: req.adminUser?.id ?? null,
      startedAt: Date.now(),
      total: companies.length,
      completed: 0,
      failed: 0,
      items: companies.map(c => ({
        companyId: c.id,
        companyName: c.nameAr,
        status: "pending",
      })),
      status: "running",
    };
    bulkJobs.set(jobId, job);

    const adminUser = req.adminUser
      ? { id: req.adminUser.id, username: req.adminUser.username }
      : null;
    // Fire-and-forget: don't await; surface any unhandled rejection via console.
    void runBulkJob(job, adminUser).catch(e => {
      // Should never happen — runBulkJob catches per-item — but keep the trace.
      console.error("[bulk-run-all] unexpected job failure:", e);
      job.status = "done";
      job.finishedAt = Date.now();
    });

    await writeAudit({
      userId: req.adminUser?.id ?? null,
      username: req.adminUser?.username ?? null,
      role: "superadmin",
      companyId: null,
      module: "backups",
      action: "create",
      entityType: "bulk_run",
      entityId: jobId,
      metadata: { op: "start", scope, total: companies.length },
    });

    res.json({ jobId, total: companies.length, scope });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "فشل بدء التشغيل الجماعي";
    res.status(500).json({ error: msg });
  }
});

// GET /api/admin/backups/run-all/:jobId — poll progress / final results
router.get("/backups/run-all/:jobId", requireSuperAdmin, async (req, res) => {
  const job = bulkJobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: "المهمة غير موجودة أو انتهت صلاحيتها" }); return; }
  res.json(job);
});

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY CENTER (task #4) — Centralized session, login-history, anomaly
// and permissions surfaces. All endpoints requireSuperAdmin and write audit
// rows under module="security" for every mutation. Never returns raw
// passwordHash/sessionToken values.
// ═══════════════════════════════════════════════════════════════════════════

interface LatestLoginRow {
  user_id: number;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

// GET /api/admin/security/sessions — list every user with a non-null sessionToken.
// Augments each row with the IP/User-Agent of their latest successful login
// from audit_log (action="login", module="auth").
router.get("/security/sessions", requireSuperAdmin, async (_req, res) => {
  try {
    // Active sessions = any user with a non-null sessionToken. We deliberately
    // do NOT return the token itself; only the sessionId (UUID, opaque).
    const sessions = await db.select({
      id:          usersTable.id,
      username:    usersTable.username,
      email:       usersTable.email,
      role:        usersTable.role,
      companyId:   usersTable.companyId,
      sessionId:   usersTable.sessionId,
      lastLoginAt: usersTable.lastLoginAt,
    })
      .from(usersTable)
      .where(sql`${usersTable.sessionToken} IS NOT NULL`);

    const userIds = sessions.map(s => s.id);
    const companyIds = Array.from(new Set(sessions.map(s => s.companyId).filter((x): x is number => x != null)));

    // Fetch the latest login audit row per user so we can show IP/UA without
    // adding any new column to the users table.
    // Use parameterized inArray (drizzle binds the values) instead of sql.raw —
    // the IDs are DB-derived but parameterization is still cleaner and safer
    // against any future caller passing them through. Rows are sorted by
    // createdAt DESC, so the FIRST row seen per user is the newest; we only
    // store the first occurrence to guarantee deterministic latest-login.
    const latestLoginRows = userIds.length === 0 ? [] : await db
      .select({
        user_id: auditLogTable.userId, ip: auditLogTable.ip,
        user_agent: auditLogTable.userAgent, created_at: auditLogTable.createdAt,
      })
      .from(auditLogTable)
      .where(and(
        eq(auditLogTable.module, "auth"),
        eq(auditLogTable.action, "login"),
        inArray(auditLogTable.userId, userIds),
      ))
      .orderBy(desc(auditLogTable.createdAt));
    const loginByUser = new Map<number, typeof latestLoginRows[number]>();
    for (const r of latestLoginRows) {
      const k = Number(r.user_id);
      if (!loginByUser.has(k)) loginByUser.set(k, r);
    }

    const companyMap = new Map<number, { id: number; nameAr: string }>();
    if (companyIds.length > 0) {
      const cos = await db.select({ id: companiesTable.id, nameAr: companiesTable.nameAr })
        .from(companiesTable).where(inArray(companiesTable.id, companyIds));
      for (const c of cos) companyMap.set(c.id, c);
    }

    const rows = sessions.map(s => {
      const lg = loginByUser.get(s.id);
      return {
        userId:      s.id,
        username:    s.username,
        email:       s.email,
        role:        s.role,
        companyId:   s.companyId,
        companyName: s.companyId != null ? companyMap.get(s.companyId)?.nameAr ?? null : null,
        sessionId:   s.sessionId,
        lastLoginAt: s.lastLoginAt,
        ip:          lg?.ip ?? null,
        userAgent:   lg?.user_agent ?? null,
      };
    });
    res.json({ rows, total: rows.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "تعذر جلب الجلسات النشطة";
    res.status(500).json({ error: msg });
  }
});

// POST /api/admin/security/sessions/:userId/end — force a single user logout
// by clearing both sessionToken AND sessionId (the auth middleware checks
// sessionToken so this immediately invalidates the bearer token).
router.post("/security/sessions/:userId/end", requireSuperAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
    const [target] = await db.select({
      id: usersTable.id, username: usersTable.username, role: usersTable.role,
      companyId: usersTable.companyId, sessionToken: usersTable.sessionToken,
    }).from(usersTable).where(eq(usersTable.id, userId));
    if (!target)             { res.status(404).json({ error: "المستخدم غير موجود" }); return; }
    if (!target.sessionToken){ res.status(400).json({ error: "لا توجد جلسة نشطة لهذا المستخدم" }); return; }

    await db.update(usersTable)
      .set({ sessionToken: null, sessionId: null, updatedAt: new Date() })
      .where(eq(usersTable.id, userId));

    await writeAudit({
      userId: req.adminUser?.id ?? null,
      username: req.adminUser?.username ?? null,
      role: "superadmin",
      companyId: target.companyId,
      module: "security",
      action: "edit",
      entityType: "user_session",
      entityId: String(userId),
      metadata: { op: "force-logout", target: target.username, targetRole: target.role },
    });
    res.json({ ok: true, userId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "تعذر إنهاء الجلسة";
    res.status(500).json({ error: msg });
  }
});

// POST /api/admin/security/sessions/bulk-end — force-logout many users at once.
router.post("/security/sessions/bulk-end", requireSuperAdmin, async (req, res) => {
  try {
    const userIds: number[] = Array.isArray(req.body?.userIds)
      ? req.body.userIds.map(Number).filter((n: number) => Number.isFinite(n))
      : [];
    if (userIds.length === 0) { res.status(400).json({ error: "حدد مستخدماً واحداً على الأقل" }); return; }

    const targets = await db.select({
      id: usersTable.id, username: usersTable.username, companyId: usersTable.companyId,
    }).from(usersTable)
      .where(and(inArray(usersTable.id, userIds), sql`${usersTable.sessionToken} IS NOT NULL`));

    if (targets.length === 0) { res.json({ ok: true, ended: 0, skipped: userIds.length }); return; }

    const targetIds = targets.map(t => t.id);
    await db.update(usersTable)
      .set({ sessionToken: null, sessionId: null, updatedAt: new Date() })
      .where(inArray(usersTable.id, targetIds));

    for (const t of targets) {
      await writeAudit({
        userId: req.adminUser?.id ?? null,
        username: req.adminUser?.username ?? null,
        role: "superadmin",
        companyId: t.companyId,
        module: "security",
        action: "edit",
        entityType: "user_session",
        entityId: String(t.id),
        metadata: { op: "bulk-force-logout", target: t.username },
      });
    }
    res.json({ ok: true, ended: targets.length, skipped: userIds.length - targets.length, endedIds: targetIds });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "تعذر إنهاء الجلسات";
    res.status(500).json({ error: msg });
  }
});

// GET /api/admin/security/login-history — paginated audit_log filter for
// login/logout/denied. Query: from, to, username, companyId, success
// ("true"|"false"), limit (default 100, max 500), offset.
router.get("/security/login-history", requireSuperAdmin, async (req, res) => {
  try {
    // Per task spec: include all login/logout/denied audit events. Auth-module
    // rows cover wrong-password and account-locked attempts; non-auth module
    // rows cover RBAC permission denials from `requirePermission`. The UI
    // shows a "module" column so superadmins can distinguish at a glance,
    // and the existing 'success' filter (true|false) doubles as a way to
    // isolate denied events when investigating abuse.
    const conds: SQL[] = [
      inArray(auditLogTable.action, ["login", "logout", "denied"]),
    ];
    const username = typeof req.query.username === "string" ? req.query.username.trim().slice(0, 80) : "";
    const companyId = req.query.companyId ? Number(req.query.companyId) : NaN;
    const from = typeof req.query.from === "string" ? new Date(req.query.from) : null;
    const to   = typeof req.query.to   === "string" ? new Date(req.query.to)   : null;
    const succ = typeof req.query.success === "string" ? req.query.success : "";
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100), 1), 500);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);

    if (username)                      conds.push(sql`${auditLogTable.username} ILIKE ${"%" + username + "%"}`);
    if (Number.isFinite(companyId))    conds.push(eq(auditLogTable.companyId, companyId));
    if (from && !isNaN(from.getTime())) conds.push(gte(auditLogTable.createdAt, from));
    if (to   && !isNaN(to.getTime()))   conds.push(lte(auditLogTable.createdAt, to));
    if (succ === "true")               conds.push(sql`${auditLogTable.action} IN ('login','logout')`);
    if (succ === "false")              conds.push(eq(auditLogTable.action, "denied"));

    const where = and(...conds);
    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLogTable).where(where);
    const rows = await db
      .select({
        id: auditLogTable.id, userId: auditLogTable.userId, username: auditLogTable.username,
        role: auditLogTable.role, companyId: auditLogTable.companyId,
        module: auditLogTable.module, action: auditLogTable.action,
        method: auditLogTable.method, path: auditLogTable.path, statusCode: auditLogTable.statusCode,
        ip: auditLogTable.ip, userAgent: auditLogTable.userAgent, metadata: auditLogTable.metadata,
        createdAt: auditLogTable.createdAt,
      })
      .from(auditLogTable).where(where)
      .orderBy(desc(auditLogTable.createdAt))
      .limit(limit).offset(offset);

    // Lightweight 30-day denied-per-day series for the UI mini-chart.
    const seriesResult = await db.execute<{ day: string; n: number }>(sql`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
             count(*)::int AS n
        FROM audit_log
       WHERE action = 'denied'
         AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY 1
       ORDER BY 1
    `);
    const series = sqlRows<{ day: string; n: number }>(seriesResult as SqlExecuteResult<{ day: string; n: number }>);

    res.json({ rows, total: Number(total ?? 0), limit, offset, deniedSeries30d: series });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "تعذر جلب تاريخ الدخول";
    res.status(500).json({ error: msg });
  }
});

// GET /api/admin/security/anomalies — best-effort anomaly detector on top of
// audit_log. Four simple heuristics:
//   1. Any user with ≥5 denied audit rows in the trailing 60 minutes.
//   2. Any user logging in today from an IP that never appeared in their
//      last 30 days of login history.
//   3. Any superadmin login at all from a new IP (more sensitive bar).
//   4. Per-user 7-day baseline deviation: today's distinct IP count or denied
//      count materially exceeds the 7-day baseline average.
//
// NOTE — geographic ("outside Saudi Arabia") detection is intentionally NOT
// implemented here: there is no geo-IP enrichment source wired into the
// platform yet. The new-IP-for-superadmin signal (rule 3) acts as the
// best-effort proxy for "unfamiliar location" until a geo provider is added
// (tracked as follow-up: geo-IP enrichment for security anomalies).
router.get("/security/anomalies", requireSuperAdmin, async (_req, res) => {
  try {
    interface DeniedSpikeRow { user_id: number | null; username: string | null; n: number }
    interface NewIpRow {
      user_id: number; username: string; role: string;
      ip: string; created_at: string;
    }

    // Per task spec: a "denied" spike covers BOTH wrong-password attempts
    // (module='auth') and RBAC permission denials from `requirePermission`
    // (module=<business module>). We aggregate across all modules and
    // surface the top module per user so the banner is actionable.
    const deniedSpikesResult = await db.execute<DeniedSpikeRow>(sql`
      SELECT user_id, username, count(*)::int AS n
        FROM audit_log
       WHERE action = 'denied'
         AND created_at >= NOW() - INTERVAL '1 hour'
       GROUP BY user_id, username
      HAVING count(*) >= 5
       ORDER BY n DESC
       LIMIT 50
    `);
    const deniedSpikes = sqlRows<DeniedSpikeRow>(deniedSpikesResult as SqlExecuteResult<DeniedSpikeRow>);

    // New-IP heuristic: a login row in the last 24h whose IP is NOT present
    // in any login row for the SAME user within the prior 30 days.
    const newIpsResult = await db.execute<NewIpRow>(sql`
      WITH today_logins AS (
        SELECT a.user_id, a.username, a.role, a.ip, a.created_at
          FROM audit_log a
         WHERE a.action = 'login'
           AND a.module = 'auth'
           AND a.ip IS NOT NULL
           AND a.user_id IS NOT NULL
           AND a.created_at >= NOW() - INTERVAL '24 hours'
      ), historical AS (
        SELECT DISTINCT user_id, ip
          FROM audit_log
         WHERE action = 'login'
           AND module = 'auth'
           AND ip IS NOT NULL
           AND created_at <  NOW() - INTERVAL '24 hours'
           AND created_at >= NOW() - INTERVAL '30 days'
      )
      SELECT t.user_id, t.username, t.role, t.ip, t.created_at
        FROM today_logins t
        LEFT JOIN historical h ON h.user_id = t.user_id AND h.ip = t.ip
       WHERE h.ip IS NULL
       ORDER BY t.created_at DESC
       LIMIT 50
    `);
    const newIps = sqlRows<NewIpRow>(newIpsResult as SqlExecuteResult<NewIpRow>);

    // Superadmin-only subset (more sensitive — even one new-IP login matters).
    const superadminNewIps = newIps.filter(r => r.role === "superadmin");

    // 7-day baseline aggregation (per spec):
    //  - Per user, count distinct IPs used today vs the daily average over the
    //    prior 7 days. A user whose distinct-IP count today is ≥3 AND at least
    //    2× their 7-day daily average gets flagged as a "wide-spread login".
    //  - Per user, today's denied count vs the prior-7-day daily average; flag
    //    when today is ≥5 AND ≥3× the baseline.
    interface BaselineRow {
      user_id: number; username: string; role: string;
      today_ips: number; baseline_ips: number;
      today_denied: number; baseline_denied: number;
    }
    const baselineResult = await db.execute<BaselineRow>(sql`
      WITH today AS (
        SELECT user_id, username, role,
               COUNT(DISTINCT ip) FILTER (WHERE action = 'login' AND ip IS NOT NULL) AS ips,
               COUNT(*)            FILTER (WHERE action = 'denied')                  AS denied
          FROM audit_log
         WHERE module = 'auth'
           AND user_id IS NOT NULL
           AND created_at >= date_trunc('day', NOW())
         GROUP BY user_id, username, role
      ), baseline AS (
        SELECT user_id,
               (COUNT(DISTINCT (date_trunc('day', created_at), ip))
                  FILTER (WHERE action = 'login' AND ip IS NOT NULL))::numeric / 7.0 AS avg_ips,
               (COUNT(*) FILTER (WHERE action = 'denied'))::numeric / 7.0            AS avg_denied
          FROM audit_log
         WHERE module = 'auth'
           AND user_id IS NOT NULL
           AND created_at >= date_trunc('day', NOW()) - INTERVAL '7 days'
           AND created_at <  date_trunc('day', NOW())
         GROUP BY user_id
      )
      SELECT t.user_id, t.username, t.role,
             COALESCE(t.ips,    0)::int AS today_ips,
             COALESCE(b.avg_ips,    0)::float AS baseline_ips,
             COALESCE(t.denied, 0)::int AS today_denied,
             COALESCE(b.avg_denied, 0)::float AS baseline_denied
        FROM today t
        LEFT JOIN baseline b ON b.user_id = t.user_id
       WHERE (t.ips    >= 3 AND COALESCE(t.ips,    0) >= 2 * GREATEST(COALESCE(b.avg_ips,    0), 1))
          OR (t.denied >= 5 AND COALESCE(t.denied, 0) >= 3 * GREATEST(COALESCE(b.avg_denied, 0), 1))
       ORDER BY t.denied DESC, t.ips DESC
       LIMIT 50
    `);
    const baselines = sqlRows<BaselineRow>(baselineResult as SqlExecuteResult<BaselineRow>);

    res.json({
      deniedSpikes:  deniedSpikes.map(r => ({ userId: r.user_id, username: r.username, count: r.n })),
      newIps:        newIps.map(r => ({
        userId: r.user_id, username: r.username, role: r.role, ip: r.ip, createdAt: r.created_at,
      })),
      superadminNewIps: superadminNewIps.map(r => ({
        userId: r.user_id, username: r.username, ip: r.ip, createdAt: r.created_at,
      })),
      baselineDeviations: baselines.map(r => ({
        userId: r.user_id, username: r.username, role: r.role,
        todayIps: r.today_ips, baselineIps: Number(r.baseline_ips.toFixed(2)),
        todayDenied: r.today_denied, baselineDenied: Number(r.baseline_denied.toFixed(2)),
      })),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "تعذر حساب التنبيهات الأمنية";
    res.status(500).json({ error: msg });
  }
});

// GET /api/admin/security/permissions-matrix — true matrix (users × permission
// groups) for admin/owner/superadmin users. Each cell is one of:
//   "inherited" — role bypasses RBAC (superadmin/admin), full access by role.
//   "granted"   — explicit user permission map has at least one true action.
//   "denied"    — explicit map exists for the group but every action is false.
//   "none"      — no entry, no inheritance — group is effectively unused.
// Also returns per-role headcount per company for the role-distribution panel.
router.get("/security/permissions-matrix", requireSuperAdmin, async (_req, res) => {
  try {
    // Top permission groups exposed in the matrix. Keep the column count small
    // so the table stays readable; deeper editing happens in the user editor.
    const PERMISSION_GROUPS = [
      "sales_invoices", "purchase_invoices", "items", "customers",
      "suppliers", "journal_entries", "reports", "users",
    ] as const;
    type PermissionGroup = typeof PERMISSION_GROUPS[number];
    type CellState = "inherited" | "granted" | "denied" | "none";

    // Per task spec the matrix rows are admin/owner users only; superadmins
    // are surfaced separately via the role-distribution panel below.
    const adminUsers = await db.select({
      id: usersTable.id, username: usersTable.username, email: usersTable.email,
      role: usersTable.role, companyId: usersTable.companyId,
      permissions: usersTable.permissions, isActive: usersTable.isActive,
      lastLoginAt: usersTable.lastLoginAt,
    })
      .from(usersTable)
      .where(inArray(usersTable.role, ["admin", "owner"]));

    const cids = Array.from(new Set(adminUsers.map(u => u.companyId).filter((x): x is number => x != null)));
    const companyMap = new Map<number, { id: number; nameAr: string }>();
    if (cids.length > 0) {
      const cos = await db.select({ id: companiesTable.id, nameAr: companiesTable.nameAr })
        .from(companiesTable).where(inArray(companiesTable.id, cids));
      for (const c of cos) companyMap.set(c.id, c);
    }

    // Role distribution per company (every role, not just admin-tier).
    interface RoleCountRow { company_id: number | null; role: string; n: number }
    const roleResult = await db.execute<RoleCountRow>(sql`
      SELECT company_id, role, count(*)::int AS n
        FROM users
       GROUP BY company_id, role
       ORDER BY company_id NULLS FIRST, role
    `);
    const roleDist = sqlRows<RoleCountRow>(roleResult as SqlExecuteResult<RoleCountRow>);

    function cellFor(role: string, perms: unknown, group: PermissionGroup): CellState {
      // ONLY superadmin/admin actually bypass RBAC in requirePermission middleware
      // (see middleware/permissions.ts). owner has no bypass — it falls through
      // to the explicit per-user permissions map like any other role. So it must
      // NOT be marked "inherited"; otherwise the matrix would lie about effective
      // access for owner users.
      if (role === "superadmin" || role === "admin") return "inherited";
      if (!perms || typeof perms !== "object") return "none";
      const entry = (perms as Record<string, Record<string, boolean>>)[group];
      if (!entry || typeof entry !== "object") return "none";
      const vals = Object.values(entry);
      if (vals.length === 0) return "none";
      return vals.some(v => v === true) ? "granted" : "denied";
    }

    res.json({
      // Column definitions for the matrix UI.
      columns: PERMISSION_GROUPS.map(g => ({ key: g })),
      users: adminUsers.map(u => {
        const cells: Record<string, CellState> = {};
        for (const g of PERMISSION_GROUPS) cells[g] = cellFor(u.role, u.permissions, g);
        return {
          id: u.id, username: u.username, email: u.email, role: u.role,
          companyId: u.companyId,
          companyName: u.companyId != null ? companyMap.get(u.companyId)?.nameAr ?? null : null,
          cells,
          isActive: u.isActive,
          lastLoginAt: u.lastLoginAt,
        };
      }),
      roleDistribution: roleDist.map(r => ({
        companyId: r.company_id,
        // Surface the company name alongside the id so the side panel is
        // operator-friendly (avoids forcing the UI to do a second lookup).
        // Falls back to null for tenant-less rows (e.g. superadmin users).
        companyName: r.company_id != null ? companyMap.get(r.company_id)?.nameAr ?? null : null,
        role: r.role,
        count: r.n,
      })),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "تعذر جلب مصفوفة الصلاحيات";
    res.status(500).json({ error: msg });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  CROSS-COMPANY REPORTS HUB  (Task #5)
// ───────────────────────────────────────────────────────────────────────────
//  Four SuperAdmin-only reports that aggregate across all tenants:
//    1. /reports/company-performance — revenue + invoice count + AOV + growth %
//    2. /reports/operational-summary — operational KPIs (customers, suppliers,
//       items, open POS sessions, last activity, latest backup, audit events,
//       denied attempts in last 7d)
//    3. /reports/plan-usage          — actual vs allowed quotas per subscription
//    4. /reports/revenue-by-plan     — billed amount grouped by plan + cycle
//  Plus /reports/summary which feeds the hub cards' live preview numbers.
//
//  Hard rules (per task spec):
//    • requireSuperAdmin on every endpoint.
//    • All aggregations live in SQL with GROUP BY (never load full transaction
//      tables into memory) so the system stays fast as tenant count grows.
// Revenue = SUM(total_amount) on sales_invoices WHERE status='posted',
// scoped to companies with a currently-active subscription.
// CSV: ?format=csv returns UTF-8 BOM + Arabic headers.
// ═══════════════════════════════════════════════════════════════════════════

// ?period=<preset>|custom (+ ?from/&to when custom). Returns inclusive [from,to]
// plus an equal-length previous window anchored just before `from`.
const PERIOD_PRESETS = [
  "this_month", "last_month",
  "this_quarter", "last_quarter",
  "this_year", "last_year",
  "custom",
] as const;
type PeriodPreset = typeof PERIOD_PRESETS[number];
function isPeriodPreset(v: unknown): v is PeriodPreset {
  return typeof v === "string" && (PERIOD_PRESETS as readonly string[]).includes(v);
}
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const utcDate = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

interface ReportPeriod {
  from: string; to: string; prevFrom: string; prevTo: string; days: number;
}
function parsePeriod(req: { query?: { from?: unknown; to?: unknown; period?: unknown } }): ReportPeriod | { error: string } {
  const now = new Date();
  const Y = now.getUTCFullYear();
  const M = now.getUTCMonth();           // 0-11
  const Q = Math.floor(M / 3);           // 0-3
  const presetRaw = req.query?.period;
  const preset: PeriodPreset = isPeriodPreset(presetRaw)
    ? presetRaw
    : (typeof req.query?.from === "string" || typeof req.query?.to === "string" ? "custom" : "this_month");

  let from: Date, to: Date;
  switch (preset) {
    case "this_month":
      from = utcDate(Y, M,     1);
      to   = utcDate(Y, M + 1, 0);
      break;
    case "last_month":
      from = utcDate(Y, M - 1, 1);
      to   = utcDate(Y, M,     0);
      break;
    case "this_quarter":
      from = utcDate(Y, Q * 3,       1);
      to   = utcDate(Y, Q * 3 + 3,   0);
      break;
    case "last_quarter":
      from = utcDate(Y, (Q - 1) * 3,     1);
      to   = utcDate(Y, (Q - 1) * 3 + 3, 0);
      break;
    case "this_year":
      from = utcDate(Y,     0,  1);
      to   = utcDate(Y,    11, 31);
      break;
    case "last_year":
      from = utcDate(Y - 1, 0,  1);
      to   = utcDate(Y - 1, 11, 31);
      break;
    case "custom": {
      const fromRaw = typeof req.query?.from === "string" ? req.query.from : "";
      const toRaw   = typeof req.query?.to   === "string" ? req.query.to   : "";
      if (!isValidISODate(fromRaw)) return { error: "تاريخ البدء غير صالح" };
      if (!isValidISODate(toRaw))   return { error: "تاريخ الانتهاء غير صالح" };
      if (toRaw < fromRaw) return { error: "تاريخ الانتهاء يجب ألا يسبق تاريخ البدء" };
      from = new Date(fromRaw + "T00:00:00Z");
      to   = new Date(toRaw   + "T00:00:00Z");
      break;
    }
  }
  // Previous-period window of identical length (inclusive day count) anchored
  // immediately before `from` so growth %s are apples-to-apples.
  const fromMs = from.getTime();
  const toMs   = to.getTime();
  const days   = Math.round((toMs - fromMs) / 86_400_000) + 1;
  const prevToMs   = fromMs - 86_400_000;
  const prevFromMs = prevToMs - (days - 1) * 86_400_000;
  return {
    from: isoDate(from), to: isoDate(to), days,
    prevFrom: isoDate(new Date(prevFromMs)),
    prevTo:   isoDate(new Date(prevToMs)),
  };
}

// ─── CSV helpers ──────────────────────────────────────────────────────────
// RFC4180-ish escaping: wrap in quotes if the cell contains a comma, quote,
// or newline; double-up internal quotes. Arabic text is preserved verbatim
// and the response is prefixed with a UTF-8 BOM so Excel detects encoding.
function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function sendCsv(res: import("express").Response, filename: string, headers: string[], rows: unknown[][]) {
  const lines = [headers.map(csvEscape).join(",")];
  for (const r of rows) lines.push(r.map(csvEscape).join(","));
  // \uFEFF = UTF-8 BOM. Excel needs this to display Arabic correctly.
  const body = "\uFEFF" + lines.join("\r\n") + "\r\n";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(body);
}

// ─── Search helper (case-insensitive name match) ──────────────────────────
function applySearch(rows: { companyName: string }[], search: string | undefined): typeof rows {
  if (!search) return rows;
  const needle = search.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(r => (r.companyName ?? "").toLowerCase().includes(needle));
}

// ─── Shared row interfaces ────────────────────────────────────────────────
interface RevenueRow      { company_id: number; revenue: string; invoice_count: number }
interface OperationalRow  {
  company_id: number; customers: number; suppliers: number; items: number;
  open_pos_sessions: number; last_activity_at: string | null;
  audit_events_period: number; denied_period: number;
}
// auto_backups doesn't track an explicit "status" column — every persisted row
// represents a successful backup (failures aren't recorded). We derive a
// human-readable status from the trailing reason and timestamp.
interface BackupOverviewRow { company_id: number; reason: string; created_at: string | null }
interface PlanUsageRow {
  subscription_id: number; company_id: number; plan: string; billing_cycle: string;
  max_users: number; max_branches: number; max_warehouses: number; max_invoices: number;
  start_date: string; end_date: string; price: string; is_active: boolean;
  actual_users: number; actual_branches: number; actual_warehouses: number;
  actual_invoices_period: number;
}
interface RevenueByPlanRow {
  plan: string; billing_cycle: string; subscription_count: number; total_billed: string;
}

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/admin/reports/summary — feeds the hub cards' live numbers.
// ───────────────────────────────────────────────────────────────────────────
//  Returns small aggregate KPIs (no per-row data) for the current month.
// ═══════════════════════════════════════════════════════════════════════════
router.get("/reports/summary", requireSuperAdmin, async (_req, res) => {
  try {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const monthEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);

    interface SumRow  { v: string | null }
    interface CountRow { n: number }

    const [revenueResult, billedResult, activeCompaniesResult, overLimitResult] = await Promise.all([
      // Posted (non-draft) sales invoices in the current month, restricted to
      // companies with an active subscription (matches the spec's revenue rule
      // and keeps this card consistent with the per-plan revenue report).
      db.execute<SumRow>(sql`
        SELECT COALESCE(SUM(si.total_amount), 0)::text AS v
          FROM sales_invoices si
         WHERE si.status = 'posted'
           AND si.invoice_date >= ${monthStart}
           AND si.invoice_date <= ${monthEnd}
           AND EXISTS (
             SELECT 1 FROM subscriptions s
              WHERE s.company_id = si.company_id
                AND s.is_active  = true
                AND s.end_date  >= ${todayISO()}
           )
      `),
      // Billed amount = SUM(price) of subscriptions that are currently active.
      db.execute<SumRow>(sql`
        SELECT COALESCE(SUM(price::numeric), 0)::text AS v
          FROM subscriptions
         WHERE is_active = true
           AND end_date >= ${todayISO()}
      `),
      db.execute<CountRow>(sql`
        SELECT COUNT(*)::int AS n FROM companies WHERE status = 'active'
      `),
      // Subscriptions where any usage metric exceeds its allowance.
      db.execute<CountRow>(sql`
        WITH latest AS (
          SELECT DISTINCT ON (company_id) id, company_id, max_users, max_branches, max_warehouses
            FROM subscriptions
           ORDER BY company_id, end_date DESC, id DESC
        ),
        u AS (SELECT company_id, COUNT(*)::int n FROM users      GROUP BY company_id),
        b AS (SELECT company_id, COUNT(*)::int n FROM branches   GROUP BY company_id),
        w AS (SELECT company_id, COUNT(*)::int n FROM warehouses GROUP BY company_id)
        SELECT COUNT(*)::int AS n
          FROM latest l
          LEFT JOIN u ON u.company_id = l.company_id
          LEFT JOIN b ON b.company_id = l.company_id
          LEFT JOIN w ON w.company_id = l.company_id
         WHERE COALESCE(u.n,0) > l.max_users
            OR COALESCE(b.n,0) > l.max_branches
            OR COALESCE(w.n,0) > l.max_warehouses
      `),
    ]);

    const revenueMonth = Number(sqlRows<SumRow>(revenueResult as SqlExecuteResult<SumRow>)[0]?.v ?? "0");
    const billedActive = Number(sqlRows<SumRow>(billedResult as SqlExecuteResult<SumRow>)[0]?.v ?? "0");
    const activeCompanies = sqlRows<CountRow>(activeCompaniesResult as SqlExecuteResult<CountRow>)[0]?.n ?? 0;
    const overLimitSubs   = sqlRows<CountRow>(overLimitResult as SqlExecuteResult<CountRow>)[0]?.n ?? 0;

    res.json({
      period: { from: monthStart, to: monthEnd },
      revenueMonth, billedActive, activeCompanies, overLimitSubs,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "تعذر جلب ملخص التقارير";
    res.status(500).json({ error: msg });
  }
});

// GET /api/admin/reports/company-performance — revenue/invoices/AOV/growth%
// per company within the period, scoped to companies with an active sub.
router.get("/reports/company-performance", requireSuperAdmin, async (req, res) => {
  try {
    const period = parsePeriod(req);
    if ("error" in period) { res.status(400).json({ error: period.error }); return; }
    const search = typeof req.query?.search === "string" ? req.query.search : undefined;
    const format = req.query?.format === "csv" ? "csv" : "json";

    // Restrict to companies with a currently-active subscription. We pick
    // exactly ONE active sub per company (the most recent end_date, then id)
    // via DISTINCT ON; otherwise duplicate active rows would multiply the
    // joined invoices and inflate revenue / invoice counts.
    const today = todayISO();

    const [currResult, prevResult, companiesList] = await Promise.all([
      db.execute<RevenueRow>(sql`
        WITH active_sub AS (
          SELECT DISTINCT ON (company_id) company_id
            FROM subscriptions
           WHERE is_active = true AND end_date >= ${today}
           ORDER BY company_id, end_date DESC, id DESC
        )
        SELECT si.company_id,
               COALESCE(SUM(si.total_amount), 0)::text AS revenue,
               COUNT(*)::int                           AS invoice_count
          FROM sales_invoices si
          JOIN active_sub a ON a.company_id = si.company_id
         WHERE si.status = 'posted'
           AND si.invoice_date >= ${period.from}
           AND si.invoice_date <= ${period.to}
         GROUP BY si.company_id
      `),
      db.execute<RevenueRow>(sql`
        WITH active_sub AS (
          SELECT DISTINCT ON (company_id) company_id
            FROM subscriptions
           WHERE is_active = true AND end_date >= ${today}
           ORDER BY company_id, end_date DESC, id DESC
        )
        SELECT si.company_id,
               COALESCE(SUM(si.total_amount), 0)::text AS revenue,
               COUNT(*)::int                           AS invoice_count
          FROM sales_invoices si
          JOIN active_sub a ON a.company_id = si.company_id
         WHERE si.status = 'posted'
           AND si.invoice_date >= ${period.prevFrom}
           AND si.invoice_date <= ${period.prevTo}
         GROUP BY si.company_id
      `),
      db.select({ id: companiesTable.id, nameAr: companiesTable.nameAr, status: companiesTable.status })
        .from(companiesTable)
        .where(eq(companiesTable.status, "active")),
    ]);

    const currMap = new Map<number, RevenueRow>();
    for (const r of sqlRows<RevenueRow>(currResult as SqlExecuteResult<RevenueRow>)) {
      currMap.set(Number(r.company_id), r);
    }
    const prevMap = new Map<number, RevenueRow>();
    for (const r of sqlRows<RevenueRow>(prevResult as SqlExecuteResult<RevenueRow>)) {
      prevMap.set(Number(r.company_id), r);
    }

    let rows = companiesList.map(c => {
      const curr = currMap.get(c.id);
      const prev = prevMap.get(c.id);
      const revenue       = Number(curr?.revenue ?? "0");
      const invoiceCount  = Number(curr?.invoice_count ?? 0);
      const prevRevenue   = Number(prev?.revenue ?? "0");
      const aov           = invoiceCount > 0 ? revenue / invoiceCount : 0;
      // Growth %: (curr - prev) / prev * 100. When prev is zero we report null
      // (an "infinite" growth rate is meaningless to render).
      const growthPct = prevRevenue > 0
        ? ((revenue - prevRevenue) / prevRevenue) * 100
        : (revenue > 0 ? null : 0);
      return {
        companyId: c.id, companyName: c.nameAr,
        revenue, invoiceCount, avgInvoice: aov,
        prevRevenue, growthPct,
      };
    });
    rows = applySearch(rows, search);
    rows.sort((a, b) => b.revenue - a.revenue);

    if (format === "csv") {
      sendCsv(res, `company-performance-${period.from}_${period.to}.csv`,
        ["الشركة", "الإيرادات", "عدد الفواتير", "متوسط الفاتورة", "إيرادات الفترة السابقة", "نمو %"],
        rows.map(r => [
          r.companyName, r.revenue.toFixed(2), r.invoiceCount, r.avgInvoice.toFixed(2),
          r.prevRevenue.toFixed(2), r.growthPct == null ? "—" : r.growthPct.toFixed(2),
        ]),
      );
      return;
    }
    res.json({ period, rows });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "تعذر جلب تقرير أداء الشركات";
    res.status(500).json({ error: msg });
  }
});

// GET /api/admin/reports/operational-summary
// Period drives audit/denied counts; the 30-day inactivity flag is fixed.
router.get("/reports/operational-summary", requireSuperAdmin, async (req, res) => {
  try {
    const period = parsePeriod(req);
    if ("error" in period) { res.status(400).json({ error: period.error }); return; }
    const search = typeof req.query?.search === "string" ? req.query.search : undefined;
    const format = req.query?.format === "csv" ? "csv" : "json";
    const onlyInactive = req.query?.onlyInactive === "true" || req.query?.onlyInactive === "1";

    const fromTs = `${period.from} 00:00:00`;
    const toTsExclusive = `${period.to} 23:59:59.999`;

    const [opsResult, backupsResult, companiesList] = await Promise.all([
      db.execute<OperationalRow>(sql`
        WITH c   AS (SELECT company_id, COUNT(*)::int n FROM customers GROUP BY company_id),
             s   AS (SELECT company_id, COUNT(*)::int n FROM suppliers GROUP BY company_id),
             i   AS (SELECT company_id, COUNT(*)::int n FROM items     GROUP BY company_id),
             pos AS (SELECT company_id, COUNT(*)::int n FROM pos_sessions WHERE status = 'open' GROUP BY company_id),
             la  AS (
               SELECT company_id, MAX(ts) AS last_activity_at FROM (
                 SELECT company_id, invoice_date::timestamp AS ts
                   FROM sales_invoices WHERE status = 'posted'
                 UNION ALL
                 SELECT company_id, created_at AS ts FROM audit_log
               ) u
               GROUP BY company_id
             ),
             ae  AS (
               SELECT company_id, COUNT(*)::int n FROM audit_log
                WHERE created_at >= ${fromTs}::timestamp
                  AND created_at <= ${toTsExclusive}::timestamp
                GROUP BY company_id
             ),
             de  AS (
               SELECT company_id, COUNT(*)::int n FROM audit_log
                WHERE action = 'denied'
                  AND created_at >= ${fromTs}::timestamp
                  AND created_at <= ${toTsExclusive}::timestamp
                GROUP BY company_id
             )
        SELECT co.id                       AS company_id,
               COALESCE(c.n,   0)          AS customers,
               COALESCE(s.n,   0)          AS suppliers,
               COALESCE(i.n,   0)          AS items,
               COALESCE(pos.n, 0)          AS open_pos_sessions,
               la.last_activity_at::text   AS last_activity_at,
               COALESCE(ae.n,  0)          AS audit_events_period,
               COALESCE(de.n,  0)          AS denied_period
          FROM companies co
          LEFT JOIN c   ON c.company_id   = co.id
          LEFT JOIN s   ON s.company_id   = co.id
          LEFT JOIN i   ON i.company_id   = co.id
          LEFT JOIN pos ON pos.company_id = co.id
          LEFT JOIN la  ON la.company_id  = co.id
          LEFT JOIN ae  ON ae.company_id  = co.id
          LEFT JOIN de  ON de.company_id  = co.id
      `),
      // Latest auto-backup row per company (DISTINCT ON keeps only the newest).
      db.execute<BackupOverviewRow>(sql`
        SELECT DISTINCT ON (company_id) company_id, reason, created_at::text
          FROM auto_backups
         ORDER BY company_id, created_at DESC, id DESC
      `),
      // Companies list for name + status lookup (kept as Drizzle query
      // because the column names live in the schema, not the SQL).
      db.select({ id: companiesTable.id, nameAr: companiesTable.nameAr, status: companiesTable.status })
        .from(companiesTable),
    ]);

    const backups = new Map<number, BackupOverviewRow>();
    for (const b of sqlRows<BackupOverviewRow>(backupsResult as SqlExecuteResult<BackupOverviewRow>)) {
      backups.set(Number(b.company_id), b);
    }
    const companyMap = new Map(companiesList.map(c => [c.id, c]));

    // Inactivity threshold = no activity in the last 30 days (any source).
    const inactiveCutoffMs = Date.now() - 30 * 86_400_000;
    let rows = sqlRows<OperationalRow>(opsResult as SqlExecuteResult<OperationalRow>).map(r => {
      const cid = Number(r.company_id);
      const company = companyMap.get(cid);
      const lastActivityAt = r.last_activity_at ?? null;
      const inactive = !lastActivityAt || new Date(lastActivityAt).getTime() < inactiveCutoffMs;
      const backup = backups.get(cid);
      return {
        companyId: cid,
        companyName: company?.nameAr ?? "—",
        companyStatus: company?.status ?? "unknown",
        customers: r.customers, suppliers: r.suppliers, items: r.items,
        openPosSessions: r.open_pos_sessions,
        lastActivityAt, inactive,
        auditEventsPeriod: r.audit_events_period,
        deniedPeriod:      r.denied_period,
        // Legacy aliases for one release window of compatibility.
        auditEvents7d:     r.audit_events_period,
        denied7d:          r.denied_period,
        latestBackupReason: backup?.reason ?? null,
        latestBackupAt:     backup?.created_at ?? null,
      };
    });
    rows = applySearch(rows, search);
    if (onlyInactive) rows = rows.filter(r => r.inactive);
    rows.sort((a, b) => a.companyName.localeCompare(b.companyName, "ar"));

    if (format === "csv") {
      sendCsv(res, `operational-summary-${period.from}_${period.to}.csv`,
        ["الشركة", "الحالة", "العملاء", "الموردون", "الأصناف", "جلسات نقاط البيع المفتوحة", "آخر نشاط", "أحداث التدقيق (الفترة)", "محاولات مرفوضة (الفترة)", "آخر نسخة احتياطية", "نوع النسخة", "راكدة (>30 يوم)"],
        rows.map(r => [
          r.companyName, r.companyStatus, r.customers, r.suppliers, r.items,
          r.openPosSessions, r.lastActivityAt ?? "—", r.auditEventsPeriod, r.deniedPeriod,
          r.latestBackupAt ?? "—", r.latestBackupReason ?? "—", r.inactive ? "نعم" : "لا",
        ]),
      );
      return;
    }
    res.json({ period, rows });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "تعذر جلب الملخص التشغيلي";
    res.status(500).json({ error: msg });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/admin/reports/plan-usage
// ───────────────────────────────────────────────────────────────────────────
//  Per latest subscription: actual vs allowed (users / branches / warehouses /
//  invoices for the requested period). Flags any over-limit metric.
// ═══════════════════════════════════════════════════════════════════════════
router.get("/reports/plan-usage", requireSuperAdmin, async (req, res) => {
  try {
    const period = parsePeriod(req);
    if ("error" in period) { res.status(400).json({ error: period.error }); return; }
    const search = typeof req.query?.search === "string" ? req.query.search : undefined;
    const format = req.query?.format === "csv" ? "csv" : "json";
    const onlyOver = req.query?.onlyOver === "true" || req.query?.onlyOver === "1";

    const result = await db.execute<PlanUsageRow>(sql`
      WITH latest AS (
        SELECT DISTINCT ON (company_id)
               id, company_id, plan, billing_cycle, max_users, max_branches,
               max_warehouses, max_invoices, start_date, end_date, price, is_active
          FROM subscriptions
         ORDER BY company_id, end_date DESC, id DESC
      ),
      u AS (SELECT company_id, COUNT(*)::int n FROM users      GROUP BY company_id),
      b AS (SELECT company_id, COUNT(*)::int n FROM branches   GROUP BY company_id),
      w AS (SELECT company_id, COUNT(*)::int n FROM warehouses GROUP BY company_id),
      iv AS (
        SELECT company_id, COUNT(*)::int n
          FROM sales_invoices
         WHERE status = 'posted'
           AND invoice_date >= ${period.from}
           AND invoice_date <= ${period.to}
         GROUP BY company_id
      )
      SELECT l.id              AS subscription_id,
             l.company_id      AS company_id,
             l.plan            AS plan,
             l.billing_cycle   AS billing_cycle,
             l.max_users       AS max_users,
             l.max_branches    AS max_branches,
             l.max_warehouses  AS max_warehouses,
             l.max_invoices    AS max_invoices,
             l.start_date      AS start_date,
             l.end_date        AS end_date,
             l.price           AS price,
             l.is_active       AS is_active,
             COALESCE(u.n,  0) AS actual_users,
             COALESCE(b.n,  0) AS actual_branches,
             COALESCE(w.n,  0) AS actual_warehouses,
             COALESCE(iv.n, 0) AS actual_invoices_period
        FROM latest l
        LEFT JOIN u  ON u.company_id  = l.company_id
        LEFT JOIN b  ON b.company_id  = l.company_id
        LEFT JOIN w  ON w.company_id  = l.company_id
        LEFT JOIN iv ON iv.company_id = l.company_id
    `);

    const usageRows = sqlRows<PlanUsageRow>(result as SqlExecuteResult<PlanUsageRow>);
    const companyIds = usageRows.map(r => Number(r.company_id));
    const companies = companyIds.length === 0 ? [] : await db.select({
      id: companiesTable.id, nameAr: companiesTable.nameAr, status: companiesTable.status,
    }).from(companiesTable).where(inArray(companiesTable.id, companyIds));
    const companyMap = new Map(companies.map(c => [c.id, c]));

    let rows = usageRows.map(r => {
      const cid = Number(r.company_id);
      const company = companyMap.get(cid);
      const actualUsers      = Number(r.actual_users);
      const actualBranches   = Number(r.actual_branches);
      const actualWarehouses = Number(r.actual_warehouses);
      const actualInvoices   = Number(r.actual_invoices_period);
      const overLimit =
        actualUsers      > r.max_users      ||
        actualBranches   > r.max_branches   ||
        actualWarehouses > r.max_warehouses ||
        actualInvoices   > r.max_invoices;
      return {
        subscriptionId: Number(r.subscription_id),
        companyId: cid,
        companyName: company?.nameAr ?? "—",
        companyStatus: company?.status ?? "unknown",
        plan: r.plan, billingCycle: r.billing_cycle,
        startDate: r.start_date, endDate: r.end_date,
        price: Number(r.price), isActive: !!r.is_active,
        users:      { actual: actualUsers,      max: r.max_users },
        branches:   { actual: actualBranches,   max: r.max_branches },
        warehouses: { actual: actualWarehouses, max: r.max_warehouses },
        invoices:   { actual: actualInvoices,   max: r.max_invoices },
        overLimit,
      };
    });
    rows = applySearch(rows, search);
    if (onlyOver) rows = rows.filter(r => r.overLimit);
    // Over-limit first, then by company name.
    rows.sort((a, b) => {
      if (a.overLimit !== b.overLimit) return a.overLimit ? -1 : 1;
      return a.companyName.localeCompare(b.companyName, "ar");
    });

    if (format === "csv") {
      sendCsv(res, `plan-usage-${period.from}_${period.to}.csv`,
        ["الشركة", "الباقة", "الدورة", "المستخدمون (فعلي/مسموح)", "الفروع (فعلي/مسموح)", "المخازن (فعلي/مسموح)", "الفواتير في الفترة (فعلي/مسموح)", "تجاوز الحد", "السعر", "نشط"],
        rows.map(r => [
          r.companyName, r.plan, r.billingCycle,
          `${r.users.actual}/${r.users.max}`,
          `${r.branches.actual}/${r.branches.max}`,
          `${r.warehouses.actual}/${r.warehouses.max}`,
          `${r.invoices.actual}/${r.invoices.max}`,
          r.overLimit ? "نعم" : "لا",
          r.price.toFixed(2),
          r.isActive ? "نعم" : "لا",
        ]),
      );
      return;
    }
    res.json({ period, rows });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "تعذر جلب تقرير استخدام الباقات";
    res.status(500).json({ error: msg });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/admin/reports/revenue-by-plan
// ───────────────────────────────────────────────────────────────────────────
//  Revenue source = SUM(sales_invoices.total_amount) for posted invoices
//  inside the selected period — i.e. ACTUAL invoice-earned revenue, NOT
//  subscription billing. Each tenant is attributed to its currently-active
//  subscription's plan + billing cycle, then totals are grouped by
//  (plan, billing_cycle). This is intentionally different from the hub
//  preview KPI `billedActive` (sum of active subscription prices), which
//  is shown only as a reference figure — they answer different questions.
//  Optional ?search filters by company nameAr BEFORE aggregation so totals
//  match the visible CSV output.
//  Subscription `billing_cycle` value "annual" (legacy) is normalized to
//  "yearly" in the SELECT.
// ═══════════════════════════════════════════════════════════════════════════
router.get("/reports/revenue-by-plan", requireSuperAdmin, async (req, res) => {
  try {
    const format = req.query?.format === "csv" ? "csv" : "json";
    const search = typeof req.query?.search === "string" ? req.query.search.trim() : "";
    const period = parsePeriod(req);
    if ("error" in period) { res.status(400).json({ error: period.error }); return; }
    // Use ILIKE for case-insensitive Arabic-friendly substring match. The
    // pattern is parameterised through Drizzle's sql template (no injection).
    const namePattern = search ? `%${search}%` : null;

    const result = await db.execute<RevenueByPlanRow>(sql`
      WITH active_sub AS (
        -- Latest active subscription per company (plan + cycle).
        -- Active = is_active AND not yet expired (matches /reports/summary).
        SELECT DISTINCT ON (company_id)
               company_id,
               plan,
               CASE WHEN billing_cycle = 'annual' THEN 'yearly' ELSE billing_cycle END AS billing_cycle
          FROM subscriptions
         WHERE is_active = true
           AND end_date >= ${todayISO()}
         ORDER BY company_id, end_date DESC, id DESC
      ),
      eligible_co AS (
        -- Companies that survive the optional name filter.
        SELECT co.id
          FROM companies co
         WHERE ${namePattern}::text IS NULL OR co.name_ar ILIKE ${namePattern}::text
      ),
      rev AS (
        -- Period-scoped posted invoice revenue, restricted to companies with
        -- an active subscription (matches the spec rule).
        SELECT si.company_id,
               COALESCE(SUM(si.total_amount::numeric), 0) AS revenue
          FROM sales_invoices si
          JOIN active_sub a  ON a.company_id  = si.company_id
          JOIN eligible_co e ON e.id          = si.company_id
         WHERE si.status = 'posted'
           AND si.invoice_date BETWEEN ${period.from} AND ${period.to}
         GROUP BY si.company_id
      )
      SELECT a.plan,
             a.billing_cycle                              AS billing_cycle,
             COUNT(DISTINCT a.company_id)::int            AS subscription_count,
             COALESCE(SUM(r.revenue), 0)::text            AS total_billed
        FROM active_sub a
        JOIN eligible_co e ON e.id = a.company_id
        LEFT JOIN rev    r ON r.company_id = a.company_id
       GROUP BY a.plan, a.billing_cycle
       ORDER BY a.plan, a.billing_cycle
    `);
    const rows = sqlRows<RevenueByPlanRow>(result as SqlExecuteResult<RevenueByPlanRow>).map(r => ({
      plan: r.plan,
      billingCycle: r.billing_cycle,
      subscriptionCount: Number(r.subscription_count),
      totalBilled: Number(r.total_billed),
    }));
    const total = rows.reduce((s, r) => s + r.totalBilled, 0);

    if (format === "csv") {
      sendCsv(res, `revenue-by-plan-${period.from}_${period.to}.csv`,
        ["الباقة", "الدورة", "عدد الشركات", "إجمالي الإيرادات", "الحصة %"],
        rows.map(r => [
          r.plan, r.billingCycle, r.subscriptionCount, r.totalBilled.toFixed(2),
          total > 0 ? ((r.totalBilled / total) * 100).toFixed(2) : "0.00",
        ]),
      );
      return;
    }
    res.json({ period, rows, total });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "تعذر جلب تقرير الإيرادات حسب الباقة";
    res.status(500).json({ error: msg });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  REPORT EMAIL SCHEDULE  (Task #14)
// ───────────────────────────────────────────────────────────────────────────
//  Lets the SuperAdmin opt-in to a recurring digest of cross-company reports
//  delivered as CSV attachments. The actual sending is driven by a 15-minute
//  scheduler tick (lib/reportScheduler.ts); these endpoints just expose the
//  config + history + a manual "send now" trigger.
// ═══════════════════════════════════════════════════════════════════════════

const FREQUENCIES = ["weekly", "monthly"] as const;
type Frequency = typeof FREQUENCIES[number];
const isFrequency = (v: unknown): v is Frequency =>
  typeof v === "string" && (FREQUENCIES as readonly string[]).includes(v);

// Permissive RFC-ish email check — we don't need full RFC 5322, just enough
// to reject obvious typos before nodemailer rejects the entire batch.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function serialiseSchedule(row: typeof reportEmailSchedulesTable.$inferSelect) {
  return {
    enabled: row.enabled,
    reports: Array.isArray(row.reports) ? row.reports : [],
    frequency: row.frequency,
    recipients: Array.isArray(row.recipients) ? row.recipients : [],
    lastSentAt: row.lastSentAt ? row.lastSentAt.toISOString() : null,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    lastReports: Array.isArray(row.lastReports) ? row.lastReports : [],
    lastRecipients: row.lastRecipients,
  };
}

// GET /api/admin/reports/email-schedule — returns config + recent history.
router.get("/reports/email-schedule", requireSuperAdmin, async (_req, res) => {
  try {
    const cfg = await ensureScheduleRow();
    const runs = await db.select().from(reportEmailScheduleRunsTable)
      .orderBy(desc(reportEmailScheduleRunsTable.ranAt))
      .limit(20);
    res.json({
      schedule: serialiseSchedule(cfg),
      availableReports: AVAILABLE_REPORTS.map(r => ({ key: r.key, label: r.labelAr })),
      smtpConfigured: emailConfigured(),
      history: runs.map(r => ({
        id: r.id,
        ranAt: r.ranAt.toISOString(),
        trigger: r.trigger,
        status: r.status,
        reports: Array.isArray(r.reports) ? r.reports : [],
        recipients: r.recipients,
        message: r.message,
      })),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "تعذر جلب إعدادات الجدولة";
    res.status(500).json({ error: msg });
  }
});

// PUT /api/admin/reports/email-schedule — updates config (enable/disable +
// list of reports + frequency + recipients). Validates inputs before saving
// so a bad payload can't poison the scheduler tick.
router.put("/reports/email-schedule", requireSuperAdmin, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const enabled = body.enabled === true;

    const reportsRaw = Array.isArray(body.reports) ? body.reports : [];
    const reports: string[] = [];
    for (const r of reportsRaw) {
      if (typeof r !== "string") { res.status(400).json({ error: "قائمة التقارير غير صالحة" }); return; }
      if (!REPORT_KEYS.includes(r)) { res.status(400).json({ error: `تقرير غير معروف: ${r}` }); return; }
      if (!reports.includes(r)) reports.push(r);
    }

    if (!isFrequency(body.frequency)) {
      res.status(400).json({ error: "تكرار الإرسال يجب أن يكون أسبوعيًا أو شهريًا" });
      return;
    }
    const frequency = body.frequency;

    const recipientsRaw = Array.isArray(body.recipients) ? body.recipients : [];
    const recipients: string[] = [];
    for (const e of recipientsRaw) {
      if (typeof e !== "string") { res.status(400).json({ error: "قائمة المستلمين غير صالحة" }); return; }
      const trimmed = e.trim().toLowerCase();
      if (!trimmed) continue;
      if (!EMAIL_RE.test(trimmed)) { res.status(400).json({ error: `بريد غير صالح: ${e}` }); return; }
      if (!recipients.includes(trimmed)) recipients.push(trimmed);
    }

    if (enabled && reports.length === 0) {
      res.status(400).json({ error: "اختر تقريرًا واحدًا على الأقل قبل التفعيل" });
      return;
    }
    if (enabled && recipients.length === 0) {
      res.status(400).json({ error: "أضف بريدًا واحدًا على الأقل قبل التفعيل" });
      return;
    }

    await ensureScheduleRow();
    await db.update(reportEmailSchedulesTable).set({
      enabled, reports, frequency, recipients,
      updatedAt: new Date(),
    }).where(eq(reportEmailSchedulesTable.id, REPORT_SCHEDULE_ID));

    await writeAudit({
      userId:    req.adminUser?.id ?? null,
      username:  req.adminUser?.username ?? null,
      role:      "superadmin",
      companyId: null,
      module: "reports", action: "edit",
      entityType: "report_email_schedule",
      entityId:   String(REPORT_SCHEDULE_ID),
      metadata: {
        enabled, frequency,
        reports, recipientsCount: recipients.length,
      },
    });

    const cfg = await ensureScheduleRow();
    res.json({ schedule: serialiseSchedule(cfg) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "تعذر حفظ إعدادات الجدولة";
    res.status(500).json({ error: msg });
  }
});

// POST /api/admin/reports/email-schedule/run-now — manual trigger. Bypasses
// the "is it due?" check so the SuperAdmin can verify SMTP/recipients
// without waiting for the next interval. Still respects "no reports / no
// recipients" guards inside runReportDigest().
router.post("/reports/email-schedule/run-now", requireSuperAdmin, async (req, res) => {
  try {
    const outcome = await runReportDigest("manual");
    await writeAudit({
      userId:    req.adminUser?.id ?? null,
      username:  req.adminUser?.username ?? null,
      role:      "superadmin",
      companyId: null,
      module: "reports", action: "export",
      entityType: "report_email_schedule",
      entityId:   String(REPORT_SCHEDULE_ID),
      metadata: {
        trigger: "manual",
        status: outcome.status,
        message: outcome.message,
        reports: outcome.reports,
        recipients: outcome.recipients,
      },
    });
    res.json({ ok: outcome.status === "ok", outcome });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "تعذر إرسال التقرير";
    res.status(500).json({ error: msg });
  }
});

// ─── Maintenance Toolbox (deterministic one-click checkers + fixes) ─────────
// Sits above the AI scanner on the AICompanyFix screen. Every endpoint is
// `requireSuperAdmin`, scoped per `companyId`, and writes an `audit_log` row
// with `module='maintenance'`. Fixes run inside a single DB transaction so a
// partial failure rolls back cleanly.

// Common helpers ────────────────────────────────────────────────────────────
// Reconstructs the public-facing origin (proto://host) for the current request
// so emails can build deep-links back to the SuperAdmin UI. Mirrors the helper
// used in superAdminAuth.ts.
function publicBaseUrlFromReq(req: Request): string {
  const proto = ((req.headers["x-forwarded-proto"] as string) || "https").split(",")[0].trim();
  const host  = ((req.headers["x-forwarded-host"]  as string) || (req.headers.host as string) || "");
  return host ? `${proto}://${host}` : "";
}
function maintGuard(req: Request, res: Response): { companyId: number } | null {
  const companyId = Number(req.query.companyId ?? req.body?.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    res.status(400).json({ error: "companyId مطلوب وصحيح" });
    return null;
  }
  return { companyId };
}
function clampInt(v: any, min: number, max: number, def: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
// True when the caller wants the maintenance result rendered as a downloadable
// CSV instead of JSON. Drives the "تصدير CSV" button on every tool card.
function wantsCsv(req: Request): boolean {
  return typeof req.query.format === "string" && req.query.format.toLowerCase() === "csv";
}
// ISO timestamp → "YYYY-MM-DD HH:mm" in UTC. Keeps CSV cells stable across
// locales (Excel parses both forms; admins reviewing offline expect ISO-ish).
function csvDate(v: unknown): string {
  if (v == null || v === "") return "";
  const s = String(v);
  // Date-only strings (YYYY-MM-DD) come straight from Postgres date columns.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toISOString().replace("T", " ").slice(0, 16);
}
async function logMaint(
  req: Request, companyId: number, action: string,
  entityType: string, metadata: Record<string, any>,
) {
  await writeAudit({
    userId:   req.adminUser?.id ?? null,
    username: req.adminUser?.username ?? null,
    role:     "superadmin",
    companyId,
    module:   "maintenance",
    action,
    method:   req.method,
    path:     req.originalUrl,
    entityType,
    entityId: null,
    metadata,
  });
}

// 1. Pending journal entries (status='draft' older than N days) ─────────────
router.get("/maintenance/journal-pending", requireSuperAdmin, async (req, res) => {
  const g = maintGuard(req, res); if (!g) return;
  const days = clampInt(req.query.days, 0, 3650, 30);
  try {
    if (wantsCsv(req)) {
      // Bypass the inline-UI row cap so the CSV reflects every matching row.
      const r = await checkJournalPending(g.companyId, days, { unlimited: true });
      const items = r.items ?? [];
      const headers = ["المعرّف", "رقم المستند", "تاريخ القيد", "الوصف", "إجمالي مدين", "إجمالي دائن", "تاريخ الإنشاء"];
      const rows = items.map((it: any) => [
        it.id, it.docNumber ?? "", csvDate(it.entryDate), it.description ?? "",
        Number(it.totalDebit ?? 0).toFixed(2), Number(it.totalCredit ?? 0).toFixed(2),
        csvDate(it.createdAt),
      ]);
      await logMaint(req, g.companyId, "export_csv", "journal_pending", { count: items.length, format: "csv", days });
      sendCsv(res, `journal-pending-${g.companyId}-${Date.now()}.csv`, headers, rows);
      return;
    }
    const r = await checkJournalPending(g.companyId, days);
    res.json({ count: r.count, days, items: r.items ?? [] });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل الفحص" });
  }
});

router.post("/maintenance/journal-pending/fix", requireSuperAdmin, async (req, res) => {
  const g = maintGuard(req, res); if (!g) return;
  const action = String(req.body?.action ?? "");
  if (action !== "post" && action !== "delete") {
    res.status(400).json({ error: "action يجب أن يكون post أو delete" }); return;
  }
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map((n: any) => Number(n)).filter(Number.isInteger)
    : [];
  if (!ids.length) { res.json({ ok: true, processed: 0 }); return; }

  try {
    const result = await db.transaction(async (tx) => {
      // Re-validate scope: only this tenant + still draft.
      const candidates = await tx.select({ id: journalEntriesTable.id })
        .from(journalEntriesTable)
        .where(and(
          eq(journalEntriesTable.companyId, g.companyId),
          eq(journalEntriesTable.status, "draft"),
          inArray(journalEntriesTable.id, ids),
        ));
      const validIds = candidates.map(c => c.id);
      if (!validIds.length) return { processed: 0, skipped: ids.length };

      if (action === "post") {
        // Only post entries whose debit equals credit (rounded to 2 dp).
        const balExec = await tx.execute<{ id: number; balanced: boolean }>(sql`
          SELECT je.id,
                 (ROUND(COALESCE(SUM(jel.debit),0) - COALESCE(SUM(jel.credit),0), 2) = 0) AS balanced
            FROM journal_entries je
            LEFT JOIN journal_entry_lines jel ON jel.entry_id = je.id
           WHERE je.id = ANY(${sql.raw(`ARRAY[${validIds.join(",")}]::int[]`)})
           GROUP BY je.id
        `);
        const balRows = (balExec as any).rows ?? [];
        const postable = balRows.filter((r: any) => r.balanced).map((r: any) => Number(r.id));
        const unbalanced = balRows.filter((r: any) => !r.balanced).map((r: any) => Number(r.id));
        if (postable.length) {
          await tx.update(journalEntriesTable)
            .set({ status: "posted", updatedAt: new Date() })
            .where(and(
              eq(journalEntriesTable.companyId, g.companyId),
              inArray(journalEntriesTable.id, postable),
            ));
        }
        return { processed: postable.length, skipped: unbalanced.length, unbalancedIds: unbalanced };
      }

      // delete: remove lines first (FK cascade is set on lines, but be explicit
      // for clarity and to record exact counts).
      await tx.delete(journalEntryLinesTable)
        .where(inArray(journalEntryLinesTable.entryId, validIds));
      const deleted = await tx.delete(journalEntriesTable)
        .where(and(
          eq(journalEntriesTable.companyId, g.companyId),
          inArray(journalEntriesTable.id, validIds),
        ))
        .returning({ id: journalEntriesTable.id });
      return { processed: deleted.length };
    });
    await logMaint(req, g.companyId, "fix", "journal_pending", { action, requested: ids.length, ...result });
    res.json({ ok: true, action, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل التنفيذ" });
  }
});

// 2. Broken references — posted invoices with NULL or missing JE id ─────────
router.get("/maintenance/broken-refs", requireSuperAdmin, async (req, res) => {
  const g = maintGuard(req, res); if (!g) return;
  try {
    if (wantsCsv(req)) {
      const r = await checkBrokenRefs(g.companyId, { unlimited: true });
      const items = r.items ?? [];
      const headers = ["النوع", "المعرّف", "رقم المستند", "تاريخ الفاتورة", "المبلغ", "معرّف القيد", "السبب"];
      const rows = items.map((it: any) => [
        it.kind === "sales" ? "مبيعات" : "مشتريات",
        it.id, it.docNumber ?? "", csvDate(it.invoiceDate),
        Number(it.totalAmount ?? 0).toFixed(2),
        it.journalEntryId ?? "",
        it.reason === "missing" ? "بدون قيد" : "قيد محذوف",
      ]);
      await logMaint(req, g.companyId, "export_csv", "broken_refs", {
        count: items.length, format: "csv",
        salesCount: r.extras?.salesCount ?? 0, purchaseCount: r.extras?.purchaseCount ?? 0,
      });
      sendCsv(res, `broken-refs-${g.companyId}-${Date.now()}.csv`, headers, rows);
      return;
    }
    const r = await checkBrokenRefs(g.companyId);
    res.json({
      count: r.count,
      salesCount:    r.extras?.salesCount    ?? 0,
      purchaseCount: r.extras?.purchaseCount ?? 0,
      items: r.items ?? [],
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل الفحص" });
  }
});

router.post("/maintenance/broken-refs/fix", requireSuperAdmin, async (req, res) => {
  const g = maintGuard(req, res); if (!g) return;
  // Items shape: [{ kind: "sales"|"purchase", id: number }]. Returning to
  // status='draft' lets the operator re-post via the existing UI which will
  // recreate the journal entry through the normal posting flow.
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const sales: number[] = [];
  const purchases: number[] = [];
  for (const it of items) {
    const id = Number(it?.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (it.kind === "sales")    sales.push(id);
    if (it.kind === "purchase") purchases.push(id);
  }
  if (!sales.length && !purchases.length) { res.json({ ok: true, processed: 0 }); return; }
  try {
    const result = await db.transaction(async (tx) => {
      let salesUpdated = 0, purchasesUpdated = 0;
      if (sales.length) {
        const upd = await tx.update(salesInvoicesTable)
          .set({ status: "draft", journalEntryId: null, updatedAt: new Date() })
          .where(and(
            eq(salesInvoicesTable.companyId, g.companyId),
            eq(salesInvoicesTable.status, "posted"),
            inArray(salesInvoicesTable.id, sales),
          ))
          .returning({ id: salesInvoicesTable.id });
        salesUpdated = upd.length;
      }
      if (purchases.length) {
        const upd = await tx.update(purchaseInvoicesTable)
          .set({ status: "draft", journalEntryId: null, updatedAt: new Date() })
          .where(and(
            eq(purchaseInvoicesTable.companyId, g.companyId),
            eq(purchaseInvoicesTable.status, "posted"),
            inArray(purchaseInvoicesTable.id, purchases),
          ))
          .returning({ id: purchaseInvoicesTable.id });
        purchasesUpdated = upd.length;
      }
      return { salesUpdated, purchasesUpdated, processed: salesUpdated + purchasesUpdated };
    });
    await logMaint(req, g.companyId, "fix", "broken_refs", {
      requested: { sales: sales.length, purchases: purchases.length }, ...result,
    });
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل التنفيذ" });
  }
});

// 3. Unlinked accounts — JE lines whose accountId is missing from accounts ──
router.get("/maintenance/unlinked-accounts", requireSuperAdmin, async (req, res) => {
  const g = maintGuard(req, res); if (!g) return;
  try {
    if (wantsCsv(req)) {
      const r = await checkUnlinkedAccounts(g.companyId, { unlimited: true });
      const items = r.items ?? [];
      const headers = ["معرّف الحساب", "عدد السطور", "معرّف قيد عيّنة", "رقم مستند عيّنة"];
      const rows = items.map((it: any) => [
        it.accountId, it.lineCount, it.sampleEntryId ?? "", it.sampleDocNumber ?? "",
      ]);
      await logMaint(req, g.companyId, "export_csv", "unlinked_accounts", { count: items.length, format: "csv" });
      sendCsv(res, `unlinked-accounts-${g.companyId}-${Date.now()}.csv`, headers, rows);
      return;
    }
    const r = await checkUnlinkedAccounts(g.companyId);
    res.json({ count: r.count, items: r.items ?? [] });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل الفحص" });
  }
});

// 4. Sequence gaps — issued numbers in [startNumber, currentNumber-1] with no log row
router.get("/maintenance/sequence-gaps", requireSuperAdmin, async (req, res) => {
  const g = maintGuard(req, res); if (!g) return;
  try {
    if (wantsCsv(req)) {
      // `unlimited` drops both per-sequence row caps inside the checker so
      // `gapCount` equals the true number of missing numbers and `sampleGaps`
      // holds every gap (not just the first 20). We then flatten one CSV row
      // per gap so admins can audit each missing number individually.
      const r = await checkSequenceGaps(g.companyId, { unlimited: true });
      const items = r.items ?? [];
      const headers = ["معرّف المسلسل", "الرمز", "اسم المسلسل", "الرقم", "الرقم المنسّق"];
      const rows: any[] = [];
      for (const seq of items) {
        for (const gap of (seq.sampleGaps ?? [])) {
          rows.push([seq.sequenceId, seq.code ?? "", seq.nameAr ?? "", gap.number, gap.formatted]);
        }
      }
      await logMaint(req, g.companyId, "export_csv", "sequence_gaps", {
        count: rows.length, format: "csv",
        sequencesAffected: r.extras?.sequencesAffected ?? 0,
      });
      sendCsv(res, `sequence-gaps-${g.companyId}-${Date.now()}.csv`, headers, rows);
      return;
    }
    const r = await checkSequenceGaps(g.companyId);
    res.json({
      count: r.count,
      sequencesAffected: r.extras?.sequencesAffected ?? 0,
      items: r.items ?? [],
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل الفحص" });
  }
});

// 5. Dormant users — last login > N days ago or never logged in ─────────────
router.get("/maintenance/dormant-users", requireSuperAdmin, async (req, res) => {
  const g = maintGuard(req, res); if (!g) return;
  const days = clampInt(req.query.days, 1, 3650, 90);
  try {
    if (wantsCsv(req)) {
      const r = await checkDormantUsers(g.companyId, days, { unlimited: true });
      const items = r.items ?? [];
      const headers = ["المعرّف", "اسم المستخدم", "الاسم", "البريد", "الدور", "آخر دخول", "تاريخ الإنشاء"];
      const rows = items.map((u: any) => [
        u.id, u.username ?? "", u.nameAr ?? "", u.email ?? "", u.role ?? "",
        u.lastLoginAt ? csvDate(u.lastLoginAt) : "لم يدخل أبداً",
        csvDate(u.createdAt),
      ]);
      await logMaint(req, g.companyId, "export_csv", "dormant_users", { count: items.length, format: "csv", days });
      sendCsv(res, `dormant-users-${g.companyId}-${Date.now()}.csv`, headers, rows);
      return;
    }
    const r = await checkDormantUsers(g.companyId, days);
    res.json({ count: r.count, days, items: r.items ?? [] });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل الفحص" });
  }
});

router.post("/maintenance/dormant-users/fix", requireSuperAdmin, async (req, res) => {
  const g = maintGuard(req, res); if (!g) return;
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map((n: any) => Number(n)).filter(Number.isInteger)
    : [];
  if (!ids.length) { res.json({ ok: true, processed: 0 }); return; }
  try {
    const result = await db.transaction(async (tx) => {
      // Never touch superadmins; never cross tenant boundary.
      const upd = await tx.update(usersTable)
        .set({ isActive: false, sessionToken: null, sessionId: null, updatedAt: new Date() })
        .where(and(
          eq(usersTable.companyId, g.companyId),
          inArray(usersTable.id, ids),
          sql`${usersTable.role} <> 'superadmin'`,
        ))
        .returning({ id: usersTable.id });
      return { processed: upd.length };
    });
    await logMaint(req, g.companyId, "fix", "dormant_users", { requested: ids.length, ...result });
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل التنفيذ" });
  }
});

// ─── Toolbox expansion (F): Inventory / Accounting / Logs ──────────────────
// Same pattern as the original 5 tools above: GET checker (with ?format=csv),
// optional POST fix; everything is requireSuperAdmin + per-company + audit-logged.

// 7. أرصدة سالبة — items whose stock_balance.qty < 0. Read-only by design:
// the right "fix" is to record the missing inflow (purchase / adjustment) via
// the normal flow so the cost layer is correct.
router.get("/maintenance/negative-stock", requireSuperAdmin, async (req, res) => {
  const g = maintGuard(req, res); if (!g) return;
  try {
    if (wantsCsv(req)) {
      const r = await checkNegativeStock(g.companyId, { unlimited: true });
      const items = r.items ?? [];
      const headers = ["كود الصنف", "اسم الصنف", "المستودع", "الكمية", "متوسط التكلفة", "آخر تحديث"];
      const rows = items.map((it: any) => [
        it.itemCode ?? "", it.itemName ?? "", it.warehouseName ?? "",
        Number(it.qty ?? 0).toFixed(4), Number(it.avgCost ?? 0).toFixed(4),
        csvDate(it.updatedAt),
      ]);
      await logMaint(req, g.companyId, "export_csv", "negative_stock", { count: items.length, format: "csv" });
      sendCsv(res, `negative-stock-${g.companyId}-${Date.now()}.csv`, headers, rows);
      return;
    }
    const r = await checkNegativeStock(g.companyId);
    res.json({ count: r.count, items: r.items ?? [] });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل الفحص" });
  }
});

// 8. انحراف رصيد المخزون — stored balance vs running ledger sum. The fix
// recomputes from the ledger and writes the corrected balance row (creating
// it when missing). Audit-logged with the per-row delta so the operator can
// reverse the action manually if needed.
router.get("/maintenance/stock-balance-drift", requireSuperAdmin, async (req, res) => {
  const g = maintGuard(req, res); if (!g) return;
  try {
    if (wantsCsv(req)) {
      const r = await checkStockBalanceDrift(g.companyId, { unlimited: true });
      const items = r.items ?? [];
      const headers = ["كود الصنف", "اسم الصنف", "المستودع", "الرصيد المخزّن", "مجموع الحركات", "الفارق"];
      const rows = items.map((it: any) => [
        it.itemCode ?? "", it.itemName ?? "", it.warehouseName ?? "",
        Number(it.storedQty ?? 0).toFixed(4), Number(it.ledgerQty ?? 0).toFixed(4),
        Number(it.drift ?? 0).toFixed(4),
      ]);
      await logMaint(req, g.companyId, "export_csv", "stock_balance_drift", { count: items.length, format: "csv" });
      sendCsv(res, `stock-balance-drift-${g.companyId}-${Date.now()}.csv`, headers, rows);
      return;
    }
    const r = await checkStockBalanceDrift(g.companyId);
    res.json({ count: r.count, items: r.items ?? [] });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل الفحص" });
  }
});

router.post("/maintenance/stock-balance-drift/fix", requireSuperAdmin, async (req, res) => {
  const g = maintGuard(req, res); if (!g) return;
  // Items shape from client: [{ itemId, warehouseId }]. Anything else (e.g.
  // a `ledgerQty` field) is IGNORED by design — the authoritative ledger sum
  // is computed server-side inside the transaction so a privileged caller
  // cannot smuggle a fake balance through this endpoint.
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const targets: Array<{ itemId: number; warehouseId: number }> = [];
  const seen = new Set<string>();
  for (const it of items) {
    const itemId = Number(it?.itemId);
    const warehouseId = Number(it?.warehouseId);
    if (!Number.isInteger(itemId) || itemId <= 0) continue;
    if (!Number.isInteger(warehouseId) || warehouseId <= 0) continue;
    const key = `${itemId}:${warehouseId}`;
    if (seen.has(key)) continue;     // dedupe — UI may submit the same row twice
    seen.add(key);
    targets.push({ itemId, warehouseId });
  }
  if (!targets.length) { res.json({ ok: true, processed: 0 }); return; }
  try {
    const result = await db.transaction(async (tx) => {
      // 1. Validate ownership: every (itemId, warehouseId) pair must belong
      //    to this tenant. Any pair pointing at a foreign item or warehouse
      //    is silently dropped (would otherwise create cross-tenant data).
      const itemIds = Array.from(new Set(targets.map(t => t.itemId)));
      const whIds   = Array.from(new Set(targets.map(t => t.warehouseId)));
      const ownedItems = await tx.execute<{ id: number }>(sql`
        SELECT id FROM items
         WHERE company_id = ${g.companyId}
           AND id = ANY(${sql.raw(`ARRAY[${itemIds.join(",")}]::int[]`)})
      `);
      const ownedWhs = await tx.execute<{ id: number }>(sql`
        SELECT id FROM warehouses
         WHERE company_id = ${g.companyId}
           AND id = ANY(${sql.raw(`ARRAY[${whIds.join(",")}]::int[]`)})
      `);
      const okItems = new Set(((ownedItems as any).rows ?? []).map((r: any) => Number(r.id)));
      const okWhs   = new Set(((ownedWhs   as any).rows ?? []).map((r: any) => Number(r.id)));
      const valid = targets.filter(t => okItems.has(t.itemId) && okWhs.has(t.warehouseId));
      const skippedOwnership = targets.length - valid.length;
      if (!valid.length) return { processed: 0, updated: 0, inserted: 0, skippedOwnership };

      // 2. For each valid pair, compute the authoritative SUM(qty) from the
      //    ledger (server-side; client value never touched), then UPDATE the
      //    existing balance row OR INSERT a fresh one with avg_cost=0.
      //
      //    Note: we DO NOT recompute avg_cost here. Reconstructing weighted-
      //    average cost from a possibly-edited ledger is non-trivial (outflows
      //    consume layers, opening balances may predate the ledger window),
      //    so we keep the existing avg_cost on update and seed 0 on insert —
      //    the operator can re-cost via the normal adjustment flow afterwards.
      let updated = 0, inserted = 0;
      for (const t of valid) {
        const sumExec = await tx.execute<{ qty: string }>(sql`
          SELECT COALESCE(SUM(qty), 0)::text AS qty
            FROM stock_ledger
           WHERE company_id   = ${g.companyId}
             AND item_id      = ${t.itemId}
             AND warehouse_id = ${t.warehouseId}
        `);
        const ledgerQty = String(((sumExec as any).rows ?? [{}])[0]?.qty ?? "0");

        const upd = await tx.execute<{ id: number }>(sql`
          UPDATE stock_balance
             SET qty = ${ledgerQty}::numeric,
                 updated_at = NOW()
           WHERE company_id   = ${g.companyId}
             AND item_id      = ${t.itemId}
             AND warehouse_id = ${t.warehouseId}
           RETURNING id
        `);
        if (((upd as any).rows ?? []).length) { updated += 1; continue; }
        await tx.execute(sql`
          INSERT INTO stock_balance (company_id, item_id, warehouse_id, qty, avg_cost, updated_at)
          VALUES (${g.companyId}, ${t.itemId}, ${t.warehouseId}, ${ledgerQty}::numeric, 0, NOW())
        `);
        inserted += 1;
      }
      return { processed: updated + inserted, updated, inserted, skippedOwnership };
    });
    await logMaint(req, g.companyId, "fix", "stock_balance_drift", {
      requested: targets.length, ...result,
    });
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل التنفيذ" });
  }
});

// 9. قيود غير متوازنة — posted JEs where SUM(debit) ≠ SUM(credit). Read-only
// by design: auto-balancing requires choosing which side is wrong, which only
// the accountant can decide. Operator typically un-posts via the UI and fixes.
router.get("/maintenance/unbalanced-entries", requireSuperAdmin, async (req, res) => {
  const g = maintGuard(req, res); if (!g) return;
  try {
    if (wantsCsv(req)) {
      const r = await checkUnbalancedEntries(g.companyId, { unlimited: true });
      const items = r.items ?? [];
      const headers = ["المعرّف", "رقم المستند", "تاريخ القيد", "الوصف", "إجمالي مدين", "إجمالي دائن", "الفارق", "عدد السطور"];
      const rows = items.map((it: any) => [
        it.id, it.docNumber ?? "", csvDate(it.entryDate), it.description ?? "",
        Number(it.totalDebit ?? 0).toFixed(2), Number(it.totalCredit ?? 0).toFixed(2),
        Number(it.diff ?? 0).toFixed(2), it.lineCount ?? 0,
      ]);
      await logMaint(req, g.companyId, "export_csv", "unbalanced_entries", { count: items.length, format: "csv" });
      sendCsv(res, `unbalanced-entries-${g.companyId}-${Date.now()}.csv`, headers, rows);
      return;
    }
    const r = await checkUnbalancedEntries(g.companyId);
    res.json({ count: r.count, items: r.items ?? [] });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل الفحص" });
  }
});

// 10. سجلات تدقيق قديمة — count of audit_log rows older than `days`.
// Fix: delete those rows. We re-evaluate `days` server-side at fix time so a
// stale UI cannot widen the cutoff.
router.get("/maintenance/old-audit-logs", requireSuperAdmin, async (req, res) => {
  const g = maintGuard(req, res); if (!g) return;
  const days = clampInt(req.query.days, 30, 3650, 365);
  try {
    if (wantsCsv(req)) {
      const r = await checkOldAuditLogs(g.companyId, days, { unlimited: true });
      const items = r.items ?? [];
      const headers = ["المعرّف", "المستخدم", "الدور", "الوحدة", "الإجراء", "الطريقة", "المسار", "الحالة", "IP", "التاريخ"];
      const rows = items.map((it: any) => [
        it.id, it.username ?? "", it.role ?? "", it.module ?? "", it.action ?? "",
        it.method ?? "", it.path ?? "", it.statusCode ?? "", it.ip ?? "",
        csvDate(it.createdAt),
      ]);
      await logMaint(req, g.companyId, "export_csv", "old_audit_logs", { count: items.length, format: "csv", days });
      sendCsv(res, `old-audit-logs-${g.companyId}-${Date.now()}.csv`, headers, rows);
      return;
    }
    const r = await checkOldAuditLogs(g.companyId, days);
    res.json({
      count: r.count, days,
      oldest: r.extras?.oldest ?? null,
      newest: r.extras?.newest ?? null,
      items: r.items ?? [],
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل الفحص" });
  }
});

router.post("/maintenance/old-audit-logs/fix", requireSuperAdmin, async (req, res) => {
  const g = maintGuard(req, res); if (!g) return;
  const days = clampInt(req.body?.days, 30, 3650, 365);
  try {
    const exec = await db.execute<{ id: number }>(sql`
      DELETE FROM audit_log
       WHERE company_id = ${g.companyId}
         AND created_at < NOW() - (${days}::int || ' days')::interval
       RETURNING id
    `);
    const deleted = ((exec as any).rows ?? []).length;
    // NB: we deliberately log this AFTER the DELETE so the prune itself is
    // recorded in audit_log (and won't be erased by its own action since
    // created_at = NOW() < cutoff).
    await logMaint(req, g.companyId, "fix", "old_audit_logs", { deleted, days });
    res.json({ ok: true, deleted, days });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل التنفيذ" });
  }
});

// 11. سجلات صيانة قديمة — count of maintenance_runs older than `days`.
// Fix: delete those rows. Default 90d keeps a quarter of trend data on hand.
router.get("/maintenance/old-maintenance-runs", requireSuperAdmin, async (req, res) => {
  const g = maintGuard(req, res); if (!g) return;
  const days = clampInt(req.query.days, 7, 3650, 90);
  try {
    if (wantsCsv(req)) {
      const r = await checkOldMaintenanceRuns(g.companyId, days, { unlimited: true });
      const items = r.items ?? [];
      const headers = ["المعرّف", "الأداة", "الحالة", "العدد", "المصدر", "تاريخ التشغيل", "المدة (مللي ثانية)", "الخطأ"];
      const rows = items.map((it: any) => [
        it.id, it.toolKey ?? "", it.status ?? "", it.count ?? 0,
        it.trigger ?? "", csvDate(it.runAt), it.durationMs ?? 0, it.error ?? "",
      ]);
      await logMaint(req, g.companyId, "export_csv", "old_maintenance_runs", { count: items.length, format: "csv", days });
      sendCsv(res, `old-maintenance-runs-${g.companyId}-${Date.now()}.csv`, headers, rows);
      return;
    }
    const r = await checkOldMaintenanceRuns(g.companyId, days);
    res.json({
      count: r.count, days,
      oldest: r.extras?.oldest ?? null,
      newest: r.extras?.newest ?? null,
      items: r.items ?? [],
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل الفحص" });
  }
});

router.post("/maintenance/old-maintenance-runs/fix", requireSuperAdmin, async (req, res) => {
  const g = maintGuard(req, res); if (!g) return;
  const days = clampInt(req.body?.days, 7, 3650, 90);
  try {
    const exec = await db.execute<{ id: number }>(sql`
      DELETE FROM maintenance_runs
       WHERE company_id = ${g.companyId}
         AND run_at < NOW() - (${days}::int || ' days')::interval
       RETURNING id
    `);
    const deleted = ((exec as any).rows ?? []).length;
    await logMaint(req, g.companyId, "fix", "old_maintenance_runs", { deleted, days });
    res.json({ ok: true, deleted, days });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل التنفيذ" });
  }
});

// 6. Maintenance history — last N audit_log rows (module='maintenance') ─────
//    `?format=csv` returns the FULL audit-logged history (not just the
//    on-screen 50 rows) so admins can archive it for compliance review. The
//    export call itself is audit-logged via `logMaint` so the trail stays
//    complete.
router.get("/maintenance/history", requireSuperAdmin, async (req, res) => {
  const g = maintGuard(req, res); if (!g) return;
  const limit = clampInt(req.query.limit, 1, 200, 50);
  try {
    if (wantsCsv(req)) {
      const rows = await db.select({
        id: auditLogTable.id, action: auditLogTable.action,
        entityType: auditLogTable.entityType, username: auditLogTable.username,
        metadata: auditLogTable.metadata, createdAt: auditLogTable.createdAt,
      })
        .from(auditLogTable)
        .where(and(
          eq(auditLogTable.companyId, g.companyId),
          eq(auditLogTable.module, "maintenance"),
        ))
        .orderBy(desc(auditLogTable.createdAt));
      const headers = ["التاريخ", "المستخدم", "الفئة", "الإجراء", "التفاصيل"];
      const csvRows = rows.map((r) => [
        csvDate(r.createdAt),
        r.username ?? "",
        r.entityType ?? "",
        r.action ?? "",
        r.metadata ? JSON.stringify(r.metadata) : "",
      ]);
      await logMaint(req, g.companyId, "export_csv", "maintenance_history", {
        count: rows.length, format: "csv",
      });
      sendCsv(res, `maintenance-history-${g.companyId}-${Date.now()}.csv`, headers, csvRows);
      return;
    }
    const rows = await db.select({
      id: auditLogTable.id, action: auditLogTable.action,
      entityType: auditLogTable.entityType, username: auditLogTable.username,
      metadata: auditLogTable.metadata, createdAt: auditLogTable.createdAt,
    })
      .from(auditLogTable)
      .where(and(
        eq(auditLogTable.companyId, g.companyId),
        eq(auditLogTable.module, "maintenance"),
      ))
      .orderBy(desc(auditLogTable.createdAt))
      .limit(limit);
    res.json({ count: rows.length, items: rows });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل جلب السجل" });
  }
});

// ─── Scheduled maintenance scans ─────────────────────────────────────────────
// GET /maintenance/latest?companyId=X — most recent scheduled/manual run per
// tool for one company. Drives the "آخر فحص" badge on every tool card.
router.get("/maintenance/latest", requireSuperAdmin, async (req, res) => {
  const g = maintGuard(req, res); if (!g) return;
  try {
    // ?trigger=scheduled|manual narrows the badge source (dashboards usually
    // want the latest *automatic* result so a one-off manual run doesn't hide
    // the nightly outcome). Default = both, matches existing UI behaviour.
    const rawTrigger = typeof req.query.trigger === "string" ? req.query.trigger : "";
    const trigger = rawTrigger === "scheduled" || rawTrigger === "manual" ? rawTrigger : undefined;
    const items = await getLatestResultsForCompany(g.companyId, { trigger });
    res.json({ count: items.length, items });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل جلب آخر نتائج الفحص" });
  }
});

// GET /maintenance/trend?companyId=&days=14 — small time-series view that
// powers the per-tool sparkline on each maintenance card and the cross-tenant
// "fleet" panel that flags companies hammered by recurring critical findings.
//
// Behaviour:
//   • When `companyId` is supplied → returns one row per (toolKey, day) for the
//     last `days` calendar days (Asia/Riyadh) with the *worst* status of the
//     day and the latest `count`. The UI groups these into per-tool sparklines.
//   • When `companyId` is omitted → returns the top 5 active companies with
//     the most critical findings inside the same window so SuperAdmins can
//     spot recurring offenders without picking each tenant manually.
//
// Both branches are read-only; nothing is written to the audit log because the
// view is consulted whenever the maintenance page is opened.
router.get("/maintenance/trend", requireSuperAdmin, async (req, res) => {
  try {
    const days = clampInt(req.query.days, 1, 90, 14);
    const companyIdRaw = req.query.companyId;
    const hasCompany = companyIdRaw != null && String(companyIdRaw) !== "";
    if (hasCompany) {
      const companyId = Number(companyIdRaw);
      if (!Number.isInteger(companyId) || companyId <= 0) {
        res.status(400).json({ error: "companyId غير صحيح" });
        return;
      }
      // For each (tool, KSA-day) pick the *latest* run as the day's badge so
      // a manual fix that flipped status from critical→ok in the afternoon
      // shows green. DISTINCT ON returns the row matching the ORDER BY
      // tiebreak (most-recent run_at), giving us the day's final state.
      const exec = await db.execute<any>(sql`
        WITH per_run AS (
          SELECT tool_key,
                 to_char((run_at AT TIME ZONE 'Asia/Riyadh')::date, 'YYYY-MM-DD') AS day_str,
                 count, status, run_at
            FROM maintenance_runs
           WHERE company_id = ${companyId}
             AND run_at >= now() - ((${days})::int || ' days')::interval
        )
        SELECT DISTINCT ON (tool_key, day_str)
               tool_key  AS "toolKey",
               day_str   AS "day",
               count     AS "count",
               status    AS "status"
          FROM per_run
         ORDER BY tool_key, day_str, run_at DESC
      `);
      res.json({ days, companyId, items: (exec as any).rows ?? [] });
      return;
    }
    // Fleet view — rank active companies by total critical issues across all
    // tools in the window. `criticalRuns` counts how many distinct
    // (tool, KSA-day) pairs hit critical so a single huge "broken-refs=500"
    // run doesn't mask a company that is critical on five different tools.
    const exec = await db.execute<any>(sql`
      WITH window_runs AS (
        SELECT m.company_id,
               m.tool_key,
               to_char((m.run_at AT TIME ZONE 'Asia/Riyadh')::date, 'YYYY-MM-DD') AS day_str,
               m.status, m.count, m.run_at
          FROM maintenance_runs m
         WHERE m.run_at >= now() - ((${days})::int || ' days')::interval
      ),
      crit AS (
        SELECT company_id, tool_key, day_str, MAX(count) AS day_count
          FROM window_runs
         WHERE status = 'critical'
         GROUP BY company_id, tool_key, day_str
      )
      SELECT crit.company_id AS "companyId",
             c.name_ar       AS "companyName",
             SUM(day_count)::int          AS "criticalCount",
             COUNT(*)::int                AS "criticalRuns",
             COUNT(DISTINCT tool_key)::int AS "toolCount",
             MAX( (SELECT MAX(run_at) FROM window_runs w
                    WHERE w.company_id = crit.company_id
                      AND w.tool_key   = crit.tool_key
                      AND w.day_str    = crit.day_str
                      AND w.status     = 'critical') ) AS "lastRunAt"
        FROM crit
        JOIN companies c ON c.id = crit.company_id
       WHERE c.status = 'active'
       GROUP BY crit.company_id, c.name_ar
       ORDER BY "criticalRuns" DESC, "criticalCount" DESC
       LIMIT 5
    `);
    res.json({ days, fleet: (exec as any).rows ?? [] });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل جلب الاتجاه" });
  }
});

// GET /maintenance/schedule — single-row config + last-tick snapshot.
router.get("/maintenance/schedule", requireSuperAdmin, async (_req, res) => {
  try {
    const row = await ensureMaintenanceScheduleRow();
    res.json({ schedule: row, toolKeys: MAINTENANCE_TOOL_KEYS });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل جلب إعدادات الجدولة" });
  }
});

// PUT /maintenance/schedule — body: { enabled, hourOfDay, minuteOfHour, emailMinIntervalHours }.
router.put("/maintenance/schedule", requireSuperAdmin, async (req, res) => {
  try {
    await ensureMaintenanceScheduleRow();
    const patch: Record<string, any> = { updatedAt: new Date() };
    if (typeof req.body?.enabled === "boolean") patch.enabled = req.body.enabled;
    if (req.body?.hourOfDay != null) {
      const h = clampInt(req.body.hourOfDay, 0, 23, 3);
      patch.hourOfDay = h;
    }
    if (req.body?.minuteOfHour != null) {
      const m = clampInt(req.body.minuteOfHour, 0, 59, 0);
      patch.minuteOfHour = m;
    }
    // Cooldown between successive critical-digest emails. 0 disables rate
    // limiting (legacy "fire on every sweep" behaviour). Cap at 720h (~30
    // days) so a typo can't accidentally mute alerts forever.
    if (req.body?.emailMinIntervalHours != null) {
      patch.emailMinIntervalHours = clampInt(req.body.emailMinIntervalHours, 0, 720, 24);
    }
    await db.update(maintenanceScheduleTable).set(patch)
      .where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));
    const [row] = await db.select().from(maintenanceScheduleTable)
      .where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));
    await writeAudit({
      userId: req.adminUser?.id ?? null, username: req.adminUser?.username ?? null,
      role: "superadmin", companyId: null, module: "maintenance", action: "edit_schedule",
      method: req.method, path: req.originalUrl, entityType: "maintenance_schedule",
      entityId: null, metadata: patch,
    });
    res.json({ schedule: row });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل تحديث الجدولة" });
  }
});

// POST /maintenance/run-now — fire the sweep across all active companies on
// demand. Body: { companyId? } — when set, scans only that one company.
router.post("/maintenance/run-now", requireSuperAdmin, async (req, res) => {
  try {
    const companyId = req.body?.companyId != null ? Number(req.body.companyId) : null;
    if (companyId != null && (!Number.isInteger(companyId) || companyId <= 0)) {
      res.status(400).json({ error: "companyId غير صحيح" }); return;
    }
    let summary;
    if (companyId) {
      // Per-company manual run: run + persist outcomes for one tenant only.
      const { runAllChecks } = await import("../lib/maintenanceChecks.js");
      const outcomes = await runAllChecks(companyId);
      const rows = outcomes.map(o => ({
        companyId, toolKey: o.toolKey, status: o.status, count: o.count,
        trigger: "manual" as const, durationMs: o.durationMs,
        error: o.error ?? null, details: o.extras ?? null,
      }));
      if (rows.length) await db.insert(maintenanceRunsTable).values(rows);
      summary = {
        companies: 1, toolsRun: outcomes.length,
        criticalCount: outcomes.filter(o => o.status === "critical").length,
        warnCount:     outcomes.filter(o => o.status === "warn").length,
        errorCount:    outcomes.filter(o => o.status === "error").length,
        failedCompanies: 0,
      };
    } else {
      summary = await runMaintenanceSweep("manual", { publicBaseUrl: publicBaseUrlFromReq(req) });
    }
    await writeAudit({
      userId: req.adminUser?.id ?? null, username: req.adminUser?.username ?? null,
      role: "superadmin", companyId: companyId ?? null, module: "maintenance",
      action: companyId ? "run_now_one" : "run_now_all",
      method: req.method, path: req.originalUrl,
      entityType: "maintenance_runs", entityId: null, metadata: summary,
    });
    res.json({ ok: true, summary });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل تشغيل الفحص" });
  }
});

// GET /maintenance/critical-summary — list of tools that are currently
// critical across all active companies. Drives the SuperAdmin dashboard banner.
router.get("/maintenance/critical-summary", requireSuperAdmin, async (req, res) => {
  const limit = clampInt(req.query.limit, 1, 100, 20);
  try {
    const items = await getCriticalAlerts(limit);
    res.json({ count: items.length, items });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل جلب التنبيهات الحرجة" });
  }
});

// POST /maintenance/schedule/test-email — fire a one-off SuperAdmin digest
// using the latest critical findings (or a placeholder row when nothing is
// critical) so admins can validate that SMTP/Outlook is reachable. Updates
// the same lastEmail* columns the auto-dispatch uses.
router.post("/maintenance/schedule/test-email", requireSuperAdmin, async (req, res) => {
  try {
    await ensureMaintenanceScheduleRow();
    const outcome = await dispatchCriticalDigest({
      publicBaseUrl: publicBaseUrlFromReq(req),
      isTest: true,
    });
    await writeAudit({
      userId: req.adminUser?.id ?? null, username: req.adminUser?.username ?? null,
      role: "superadmin", companyId: null, module: "maintenance",
      action: "send_test_email",
      method: req.method, path: req.originalUrl,
      entityType: "maintenance_schedule", entityId: null, metadata: outcome,
    });
    if (outcome.status === "ok") {
      res.json({ ok: true, outcome });
    } else {
      // Surface non-OK outcomes (no recipients, no transport, send failed) as
      // 400/502 so the UI can show a useful toast — but still return the
      // structured outcome so the schedule card refreshes consistently.
      const code = outcome.status === "failed" ? 502 : 400;
      res.status(code).json({ ok: false, outcome, error: outcomeMessageAr(outcome) });
    }
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل إرسال البريد التجريبي" });
  }
});

function outcomeMessageAr(o: { status: string; message: string }): string {
  switch (o.status) {
    case "ok":             return "تم الإرسال بنجاح";
    case "no_recipients":  return "لا يوجد سوبر أدمن لديه بريد إلكتروني مفعّل";
    case "no_transport":   return "إعدادات البريد غير مهيأة على الخادم (SMTP أو Outlook)";
    case "snoozed":        return "التنبيهات مكتومة حالياً";
    case "no_critical":    return "لا توجد نتائج حرجة لإرسالها";
    case "failed":         return `تعذّر الإرسال: ${o.message}`;
    default:               return o.message || "حدث خطأ غير معروف";
  }
}

// POST /maintenance/critical-summary/snooze — mute the dashboard banner until
// the next scheduled run lifts the count back up. Body: { hours? } default 24.
router.post("/maintenance/critical-summary/snooze", requireSuperAdmin, async (req, res) => {
  try {
    await ensureMaintenanceScheduleRow();
    const hours = clampInt(req.body?.hours, 1, 24 * 7, 24);
    const until = new Date(Date.now() + hours * 60 * 60_000);
    await db.update(maintenanceScheduleTable)
      .set({ alertsMutedUntil: until, updatedAt: new Date() })
      .where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));
    res.json({ ok: true, alertsMutedUntil: until });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "فشل كتم التنبيهات" });
  }
});

export default router;
