import { Router } from "express";
import { db } from "@workspace/db";
import { companiesTable, usersTable, subscriptionsTable, planConfigsTable, invoicesTable, invoiceLineItemsTable, customersTable, suppliersTable, stockLedgerTable, stockBalanceTable, salesInvoicesTable, salesReturnsTable, purchaseInvoicesTable, purchaseReturnsTable, journalEntriesTable, journalEntryLinesTable, itemsTable, notificationsTable } from "@workspace/db";
import { eq, and, asc, count, inArray, notInArray, sql, desc, lt, isNull } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { buildSystemTree, type SystemTree, type Scope } from "../lib/systemRegistry.js";

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
    if (!ALLOWED_CYCLES.has(billingCycle)) { res.status(400).json({ error: "دورة فوترة غير صالحة" }); return; }
    updates.billingCycle = billingCycle;
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
  res.json({ ok: true, subscription: updated });
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
    // Semantics: byPlan.count and revenue are now scoped to TRULY active rows
    // (is_active=TRUE AND end_date is empty/non-date OR end_date >= today),
    // so the headline `active`, the plan-distribution chart, and the revenue
    // total all share the same definition. `expiring` and `expired` count
    // is_active=TRUE rows by their date status separately.
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

export default router;
