import { Router } from "express";
import { db } from "@workspace/db";
import { companiesTable, usersTable, subscriptionsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
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

// DELETE /api/admin/requests/:id — delete request
router.delete("/requests/:id", requireSuperAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  // This cascades to users/subscriptions/suppliers
  await db.delete(companiesTable).where(eq(companiesTable.id, id));
  res.status(204).send();
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

// PUT /api/admin/subscriptions/:id — update a subscription
router.put("/subscriptions/:id", requireSuperAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { plan, maxUsers, maxInvoices, billingCycle, startDate, endDate, isActive, price } = req.body;

  const PLANS: Record<string, { maxUsers: number; maxInvoices: number; price: string }> = {
    starter:      { maxUsers: 1,   maxInvoices: 50,     price: "99" },
    professional: { maxUsers: 5,   maxInvoices: 500,    price: "299" },
    enterprise:   { maxUsers: 999, maxInvoices: 999999, price: "899" },
  };

  const updates: Record<string, any> = {};
  if (plan)          { updates.plan = plan; }
  if (maxUsers       != null) updates.maxUsers     = maxUsers;
  if (maxInvoices    != null) updates.maxInvoices  = maxInvoices;
  if (billingCycle)  updates.billingCycle = billingCycle;
  if (startDate)     updates.startDate = startDate;
  if (endDate)       updates.endDate   = endDate;
  if (isActive       != null) updates.isActive = isActive;
  if (price          != null) updates.price = String(price);

  // Auto-fill plan defaults if plan changed
  if (plan && PLANS[plan] && maxUsers == null)    updates.maxUsers    = PLANS[plan].maxUsers;
  if (plan && PLANS[plan] && maxInvoices == null) updates.maxInvoices = PLANS[plan].maxInvoices;
  if (plan && PLANS[plan] && price == null)       updates.price       = PLANS[plan].price;

  const [updated] = await db.update(subscriptionsTable).set(updates).where(eq(subscriptionsTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "الاشتراك غير موجود" }); return; }
  res.json({ ok: true, subscription: updated });
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

export default router;
