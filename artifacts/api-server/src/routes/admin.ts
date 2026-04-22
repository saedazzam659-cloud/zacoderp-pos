import { Router } from "express";
import { db } from "@workspace/db";
import { companiesTable, usersTable, subscriptionsTable, planConfigsTable, invoicesTable, invoiceLineItemsTable, customersTable, suppliersTable } from "@workspace/db";
import { eq, and, asc, count } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";

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

export default router;
