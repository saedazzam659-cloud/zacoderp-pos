import { Router } from "express";
import { db } from "@workspace/db";
import { companiesTable, usersTable, subscriptionsTable, planConfigsTable, invoicesTable, invoiceLineItemsTable, customersTable, suppliersTable, stockLedgerTable, stockBalanceTable, salesInvoicesTable, salesReturnsTable, purchaseInvoicesTable, purchaseReturnsTable, journalEntriesTable, journalEntryLinesTable, itemsTable, notificationsTable, branchesTable, warehousesTable, systemSettingsTable, autoBackupsTable } from "@workspace/db";
import { eq, and, asc, count, inArray, notInArray, sql, desc, lt, isNull, gte, lte } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { buildSystemTree, type SystemTree, type Scope } from "../lib/systemRegistry.js";
import { writeAudit } from "../middleware/permissions.js";
import { persistSnapshot, restoreFromSnapshotPayload } from "./backup.js";
import { randomBytes } from "crypto";

const router = Router();

// Middleware: superadmin only
async function requireSuperAdmin(req: any, res: any, next: any) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { res.status(401).json({ error: "غير مصرح" }); return; }
  const token = auth.slice(7);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.sessionToken, token));
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
      const lastIso = c.lastAutoBackupAt ? new Date(c.lastAutoBackupAt).toISOString() : null;
      const { bucket, ageHours } = backupBucket(
        c.autoBackupEnabled, c.autoBackupFrequencyHours, lastIso,
      );
      const a = agg30.get(c.id) ?? { cnt: 0, total: 0 };
      const latest = latestByCompany.get(c.id) ?? null;

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

// POST /api/admin/backups/auto/settings/:companyId — admin-side proxy that
// updates per-company backup settings without forcing the SuperAdmin to
// switch tenants. Mirrors POST /api/backup/auto/settings.
router.post("/backups/auto/settings/:companyId", requireSuperAdmin, async (req, res) => {
  try {
    const companyId = Number(req.params.companyId);
    if (!Number.isFinite(companyId)) { res.status(400).json({ error: "معرّف شركة غير صالح" }); return; }
    const [exists] = await db.select({ id: companiesTable.id }).from(companiesTable).where(eq(companiesTable.id, companyId));
    if (!exists) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }

    const patch: Record<string, unknown> = {};
    if (typeof req.body?.enabled === "boolean") patch.autoBackupEnabled = req.body.enabled;
    if (Number.isFinite(Number(req.body?.frequencyHours))) {
      patch.autoBackupFrequencyHours = Math.max(1, Math.min(168, Number(req.body.frequencyHours)));
    }
    if (Number.isFinite(Number(req.body?.retention))) {
      patch.autoBackupRetention = Math.max(1, Math.min(30, Number(req.body.retention)));
    }
    if (Object.keys(patch).length === 0) { res.status(400).json({ error: "لا توجد تغييرات" }); return; }

    await db.update(companiesTable).set(patch).where(eq(companiesTable.id, companyId));
    await writeAudit({
      userId: req.adminUser?.id ?? null,
      username: req.adminUser?.username ?? null,
      role: "superadmin",
      companyId,
      module: "backups",
      action: "edit",
      entityType: "auto_backup_settings",
      entityId: String(companyId),
      metadata: { fields: Object.keys(patch) },
    });
    res.json({ ok: true, settings: patch });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "خطأ غير متوقع";
    res.status(500).json({ error: msg });
  }
});

// POST /api/admin/backups/run-now/:companyId — admin-triggered single snapshot
router.post("/backups/run-now/:companyId", requireSuperAdmin, async (req, res) => {
  try {
    const companyId = Number(req.params.companyId);
    if (!Number.isFinite(companyId)) { res.status(400).json({ error: "معرّف شركة غير صالح" }); return; }
    const [exists] = await db.select({ id: companiesTable.id }).from(companiesTable).where(eq(companiesTable.id, companyId));
    if (!exists) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }

    const id = await persistSnapshot(companyId, "manual");
    await writeAudit({
      userId: req.adminUser?.id ?? null,
      username: req.adminUser?.username ?? null,
      role: "superadmin",
      companyId,
      module: "backups",
      action: "create",
      entityType: "auto_backup",
      entityId: String(id),
      metadata: { op: "run-now" },
    });
    res.json({ ok: true, id });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "فشل أخذ النسخة";
    res.status(500).json({ error: msg });
  }
});

// DELETE /api/admin/backups/auto/:id — admin-side delete (not company-scoped)
router.delete("/backups/auto/:id", requireSuperAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
    const [row] = await db.select({ id: autoBackupsTable.id, companyId: autoBackupsTable.companyId })
      .from(autoBackupsTable).where(eq(autoBackupsTable.id, id));
    if (!row) { res.status(404).json({ error: "النسخة غير موجودة" }); return; }
    await db.delete(autoBackupsTable).where(eq(autoBackupsTable.id, id));
    await writeAudit({
      userId: req.adminUser?.id ?? null,
      username: req.adminUser?.username ?? null,
      role: "superadmin",
      companyId: row.companyId,
      module: "backups",
      action: "delete",
      entityType: "auto_backup",
      entityId: String(id),
    });
    res.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "خطأ غير متوقع";
    res.status(500).json({ error: msg });
  }
});

// POST /api/admin/backups/auto/:id/restore — admin-side restore (with safety net)
// Body: { confirmVatNumber: string } — operator must type the VAT number of the
// owning company to confirm. Before applying, we always take a fresh "manual"
// pre-restore snapshot so any mistake is reversible.
router.post("/backups/auto/:id/restore", requireSuperAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
    const [snap] = await db.select().from(autoBackupsTable).where(eq(autoBackupsTable.id, id));
    if (!snap) { res.status(404).json({ error: "النسخة غير موجودة" }); return; }
    const [comp] = await db.select({ id: companiesTable.id, vatNumber: companiesTable.vatNumber, nameAr: companiesTable.nameAr })
      .from(companiesTable).where(eq(companiesTable.id, snap.companyId));
    if (!comp) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }

    const provided = String(req.body?.confirmVatNumber ?? "").trim();
    if (provided !== String(comp.vatNumber).trim()) {
      res.status(400).json({ error: "الرقم الضريبي غير مطابق — لم يتم تنفيذ الاستعادة" });
      return;
    }

    // Safety-net snapshot first — MANDATORY. If we can't take a pre-restore
    // snapshot, abort: a failed restore must always be reversible.
    let preRestoreId: number;
    try {
      preRestoreId = await persistSnapshot(comp.id, "manual");
    } catch (snapErr: unknown) {
      const m = snapErr instanceof Error ? snapErr.message : "unknown";
      res.status(500).json({ error: `تعذّر إنشاء نسخة الأمان قبل الاستعادة — لم يتم تنفيذ أي تغيير. (${m})` });
      return;
    }

    const out = await restoreFromSnapshotPayload(
      comp.id,
      snap.data as { data?: Record<string, unknown> } | null,
    );

    await writeAudit({
      userId: req.adminUser?.id ?? null,
      username: req.adminUser?.username ?? null,
      role: "superadmin",
      companyId: comp.id,
      module: "backups",
      action: "edit",
      entityType: "auto_backup_restore",
      entityId: String(id),
      metadata: { snapshotId: id, preRestoreId, report: out.report },
    });
    res.json({ ok: true, snapshotId: id, preRestoreId, report: out.report });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "فشل الاستعادة";
    res.status(500).json({ error: msg });
  }
});

// GET /api/admin/backups/auto/:id/download — download a snapshot's JSON
router.get("/backups/auto/:id/download", requireSuperAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
    const [row] = await db.select().from(autoBackupsTable).where(eq(autoBackupsTable.id, id));
    if (!row) { res.status(404).json({ error: "النسخة غير موجودة" }); return; }
    // Sensitive read — full snapshot payload contains company data — audit it.
    await writeAudit({
      userId: req.adminUser?.id ?? null,
      username: req.adminUser?.username ?? null,
      role: "superadmin",
      companyId: row.companyId,
      module: "backups",
      action: "view",
      entityType: "auto_backup_download",
      entityId: String(id),
    });
    res.json(row.data);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "خطأ غير متوقع";
    res.status(500).json({ error: msg });
  }
});

// GET /api/admin/backups/auto/list/:companyId — snapshot history for one company
router.get("/backups/auto/list/:companyId", requireSuperAdmin, async (req, res) => {
  try {
    const companyId = Number(req.params.companyId);
    if (!Number.isFinite(companyId)) { res.status(400).json({ error: "معرّف شركة غير صالح" }); return; }
    // Spec: cap history at the last 30 snapshots — older snapshots are still
    // retained per the company's retention setting and visible via direct
    // download by id, but the on-screen list never exceeds 30 rows.
    const rows = await db.select({
      id:        autoBackupsTable.id,
      createdAt: autoBackupsTable.createdAt,
      reason:    autoBackupsTable.reason,
      sizeBytes: autoBackupsTable.sizeBytes,
      counts:    autoBackupsTable.counts,
    }).from(autoBackupsTable)
      .where(eq(autoBackupsTable.companyId, companyId))
      .orderBy(desc(autoBackupsTable.createdAt))
      .limit(30);
    // Lightweight audit — operator opened a company's backup history panel.
    await writeAudit({
      userId: req.adminUser?.id ?? null,
      username: req.adminUser?.username ?? null,
      role: "superadmin",
      companyId,
      module: "backups",
      action: "view",
      entityType: "auto_backup_list",
      entityId: String(companyId),
      metadata: { count: rows.length },
    });
    res.json({ snapshots: rows });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "خطأ غير متوقع";
    res.status(500).json({ error: msg });
  }
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

export default router;
