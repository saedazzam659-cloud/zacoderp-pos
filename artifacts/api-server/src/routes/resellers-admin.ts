import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import {
  resellersTable, resellerCompaniesTable, resellerCommissionsTable,
  resellerTicketsTable, resellerActivationRequestsTable,
  companiesTable,
  RESELLER_PERMISSION_KEYS, type ResellerPermissions,
} from "@workspace/db";
import { eq, and, desc, sql, notInArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { writeAudit } from "../middleware/permissions.js";
import { extractAuth } from "../middleware/auth.js";

// ─────────────────────────────────────────────────────────────────────────
// SuperAdmin reseller (Agent) management — Task #237 (additive only).
// Mounted at /api/admin/resellers. Every endpoint requires the platform
// SuperAdmin role; this router NEVER touches existing company/user data.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();
router.use(extractAuth);

async function requireSuperAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const u = req.authUser;
  if (!u) { res.status(401).json({ error: "غير مصرح" }); return; }
  if (u.role !== "superadmin") { res.status(403).json({ error: "هذه الصفحة لمدير المنصة فقط" }); return; }
  next();
}
router.use(requireSuperAdmin);

// Sanitise an arbitrary permissions object down to the known keys only.
function sanitizePermissions(input: any): ResellerPermissions {
  const out: ResellerPermissions = {};
  if (input && typeof input === "object") {
    for (const k of RESELLER_PERMISSION_KEYS) out[k] = input[k] === true;
  }
  return out;
}

function publicReseller(r: typeof resellersTable.$inferSelect) {
  const { passwordHash, sessionToken, sessionId, ...rest } = r;
  return rest;
}

// ─── List resellers (with client count + commission totals) ──────────────
router.get("/", async (_req, res) => {
  const rows = await db.select().from(resellersTable).orderBy(desc(resellersTable.createdAt));
  const counts = await db
    .select({ resellerId: resellerCompaniesTable.resellerId, n: sql<number>`count(*)::int` })
    .from(resellerCompaniesTable)
    .groupBy(resellerCompaniesTable.resellerId);
  const totals = await db
    .select({
      resellerId: resellerCommissionsTable.resellerId,
      total: sql<string>`coalesce(sum(${resellerCommissionsTable.commissionAmount}),0)`,
    })
    .from(resellerCommissionsTable)
    .groupBy(resellerCommissionsTable.resellerId);
  const countMap = new Map(counts.map((c) => [c.resellerId, c.n]));
  const totalMap = new Map(totals.map((t) => [t.resellerId, t.total]));
  res.json({
    resellers: rows.map((r) => ({
      ...publicReseller(r),
      clientCount: countMap.get(r.id) ?? 0,
      commissionTotal: totalMap.get(r.id) ?? "0",
    })),
  });
});

// ─── Create reseller ─────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  const b = req.body ?? {};
  const code = String(b.code ?? "").trim();
  const nameAr = String(b.nameAr ?? "").trim();
  const username = String(b.username ?? "").trim();
  const password = String(b.password ?? "");
  if (!code || !nameAr || !username || !password) {
    res.status(400).json({ error: "الكود والاسم واسم المستخدم وكلمة المرور حقول مطلوبة" }); return;
  }
  if (password.length < 6) { res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" }); return; }

  const [dupCode] = await db.select({ id: resellersTable.id }).from(resellersTable).where(eq(resellersTable.code, code));
  if (dupCode) { res.status(409).json({ error: "الكود مستخدم مسبقاً" }); return; }
  const [dupUser] = await db.select({ id: resellersTable.id }).from(resellersTable).where(eq(resellersTable.username, username));
  if (dupUser) { res.status(409).json({ error: "اسم المستخدم مستخدم مسبقاً" }); return; }

  const passwordHash = await bcrypt.hash(password, 12);
  const rate = Number(b.commissionRate);
  const [created] = await db.insert(resellersTable).values({
    code, nameAr,
    nameEn: b.nameEn ? String(b.nameEn).trim() : null,
    phone: b.phone ? String(b.phone).trim() : null,
    email: b.email ? String(b.email).trim() : null,
    address: b.address ? String(b.address).trim() : null,
    username, passwordHash,
    commissionRate: Number.isFinite(rate) && rate >= 0 ? rate.toFixed(3) : "0",
    status: b.status === "suspended" ? "suspended" : "active",
    permissions: sanitizePermissions(b.permissions),
    notes: b.notes ? String(b.notes).trim() : null,
    activatedAt: new Date().toISOString().slice(0, 10),
  }).returning();

  await writeAudit({
    userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null, role: "superadmin",
    companyId: null, module: "resellers", action: "create",
    entityType: "reseller", entityId: String(created.id), metadata: { code, username },
  });
  res.status(201).json({ ok: true, reseller: publicReseller(created) });
});

// ─── Single reseller (+ linked companies + recent commissions) ───────────
router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [reseller] = await db.select().from(resellersTable).where(eq(resellersTable.id, id));
  if (!reseller) { res.status(404).json({ error: "الموزّع غير موجود" }); return; }

  const companies = await db
    .select({
      linkId: resellerCompaniesTable.id,
      companyId: companiesTable.id,
      nameAr: companiesTable.nameAr,
      nameEn: companiesTable.nameEn,
      code: companiesTable.code,
      status: companiesTable.status,
      linkedAt: resellerCompaniesTable.linkedAt,
    })
    .from(resellerCompaniesTable)
    .innerJoin(companiesTable, eq(companiesTable.id, resellerCompaniesTable.companyId))
    .where(eq(resellerCompaniesTable.resellerId, id))
    .orderBy(desc(resellerCompaniesTable.linkedAt));

  const commissions = await db
    .select()
    .from(resellerCommissionsTable)
    .where(eq(resellerCommissionsTable.resellerId, id))
    .orderBy(desc(resellerCommissionsTable.createdAt))
    .limit(50);

  res.json({ reseller: publicReseller(reseller), companies, commissions });
});

// ─── Update reseller (profile / rate / permissions / status) ─────────────
router.put("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [existing] = await db.select().from(resellersTable).where(eq(resellersTable.id, id));
  if (!existing) { res.status(404).json({ error: "الموزّع غير موجود" }); return; }
  const b = req.body ?? {};
  const patch: Record<string, any> = { updatedAt: new Date() };

  if (b.code !== undefined) {
    const code = String(b.code).trim();
    if (!code) { res.status(400).json({ error: "الكود مطلوب" }); return; }
    if (code !== existing.code) {
      const [dup] = await db.select({ id: resellersTable.id }).from(resellersTable).where(eq(resellersTable.code, code));
      if (dup) { res.status(409).json({ error: "الكود مستخدم مسبقاً" }); return; }
    }
    patch.code = code;
  }
  if (b.username !== undefined) {
    const username = String(b.username).trim();
    if (!username) { res.status(400).json({ error: "اسم المستخدم مطلوب" }); return; }
    if (username !== existing.username) {
      const [dup] = await db.select({ id: resellersTable.id }).from(resellersTable).where(eq(resellersTable.username, username));
      if (dup) { res.status(409).json({ error: "اسم المستخدم مستخدم مسبقاً" }); return; }
    }
    patch.username = username;
  }
  if (b.nameAr !== undefined) { const v = String(b.nameAr).trim(); if (!v) { res.status(400).json({ error: "الاسم مطلوب" }); return; } patch.nameAr = v; }
  if (b.nameEn !== undefined)  patch.nameEn  = b.nameEn ? String(b.nameEn).trim() : null;
  if (b.phone !== undefined)   patch.phone   = b.phone ? String(b.phone).trim() : null;
  if (b.email !== undefined)   patch.email   = b.email ? String(b.email).trim() : null;
  if (b.address !== undefined) patch.address = b.address ? String(b.address).trim() : null;
  if (b.notes !== undefined)   patch.notes   = b.notes ? String(b.notes).trim() : null;
  if (b.commissionRate !== undefined) {
    const rate = Number(b.commissionRate);
    if (!Number.isFinite(rate) || rate < 0) { res.status(400).json({ error: "نسبة عمولة غير صالحة" }); return; }
    patch.commissionRate = rate.toFixed(3);
  }
  if (b.status !== undefined)      patch.status      = b.status === "suspended" ? "suspended" : "active";
  if (b.permissions !== undefined) patch.permissions = sanitizePermissions(b.permissions);

  const [updated] = await db.update(resellersTable).set(patch).where(eq(resellersTable.id, id)).returning();
  await writeAudit({
    userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null, role: "superadmin",
    companyId: null, module: "resellers", action: "edit",
    entityType: "reseller", entityId: String(id), metadata: { fields: Object.keys(patch) },
  });
  res.json({ ok: true, reseller: publicReseller(updated) });
});

// ─── Reset reseller password ─────────────────────────────────────────────
router.post("/:id/reset-password", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const password = String(req.body?.password ?? "");
  if (password.length < 6) { res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" }); return; }
  const [existing] = await db.select({ id: resellersTable.id }).from(resellersTable).where(eq(resellersTable.id, id));
  if (!existing) { res.status(404).json({ error: "الموزّع غير موجود" }); return; }
  const passwordHash = await bcrypt.hash(password, 12);
  // Invalidate any active session by clearing the token.
  await db.update(resellersTable).set({ passwordHash, sessionToken: null, sessionId: null, updatedAt: new Date() }).where(eq(resellersTable.id, id));
  await writeAudit({
    userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null, role: "superadmin",
    companyId: null, module: "resellers", action: "edit",
    entityType: "reseller", entityId: String(id), metadata: { op: "reset-password" },
  });
  res.json({ ok: true });
});

// ─── Delete reseller ─────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [existing] = await db.select().from(resellersTable).where(eq(resellersTable.id, id));
  if (!existing) { res.status(404).json({ error: "الموزّع غير موجود" }); return; }
  await db.delete(resellersTable).where(eq(resellersTable.id, id));
  await writeAudit({
    userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null, role: "superadmin",
    companyId: null, module: "resellers", action: "delete",
    entityType: "reseller", entityId: String(id), metadata: { code: existing.code },
  });
  res.json({ ok: true });
});

// ─── Companies available to link (not yet owned by ANY reseller) ─────────
router.get("/companies/available", async (req, res) => {
  const search = String(req.query.search ?? "").trim();
  const linked = await db.select({ companyId: resellerCompaniesTable.companyId }).from(resellerCompaniesTable);
  const linkedIds = linked.map((l) => l.companyId);
  const whereExpr = linkedIds.length
    ? notInArray(companiesTable.id, linkedIds)
    : sql`true`;
  let rows = await db
    .select({ id: companiesTable.id, nameAr: companiesTable.nameAr, nameEn: companiesTable.nameEn, code: companiesTable.code, status: companiesTable.status })
    .from(companiesTable)
    .where(whereExpr)
    .orderBy(desc(companiesTable.id))
    .limit(200);
  if (search) {
    const s = search.toLowerCase();
    rows = rows.filter((r) =>
      (r.nameAr ?? "").toLowerCase().includes(s) ||
      (r.nameEn ?? "").toLowerCase().includes(s) ||
      (r.code ?? "").toLowerCase().includes(s));
  }
  res.json({ companies: rows });
});

// ─── Link a company to a reseller ────────────────────────────────────────
router.post("/:id/companies", async (req, res) => {
  const id = parseInt(req.params.id);
  const companyId = parseInt(req.body?.companyId);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف الموزّع غير صالح" }); return; }
  if (!Number.isInteger(companyId) || companyId <= 0) { res.status(400).json({ error: "معرّف الشركة غير صالح" }); return; }
  const [reseller] = await db.select({ id: resellersTable.id }).from(resellersTable).where(eq(resellersTable.id, id));
  if (!reseller) { res.status(404).json({ error: "الموزّع غير موجود" }); return; }
  const [company] = await db.select({ id: companiesTable.id }).from(companiesTable).where(eq(companiesTable.id, companyId));
  if (!company) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }
  const [already] = await db.select({ id: resellerCompaniesTable.id, resellerId: resellerCompaniesTable.resellerId })
    .from(resellerCompaniesTable).where(eq(resellerCompaniesTable.companyId, companyId));
  if (already) {
    res.status(409).json({ error: already.resellerId === id ? "الشركة مرتبطة بهذا الموزّع مسبقاً" : "الشركة مرتبطة بموزّع آخر" });
    return;
  }
  const [link] = await db.insert(resellerCompaniesTable).values({ resellerId: id, companyId }).returning();
  await writeAudit({
    userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null, role: "superadmin",
    companyId, module: "resellers", action: "edit",
    entityType: "reseller", entityId: String(id), metadata: { op: "link-company", companyId },
  });
  res.status(201).json({ ok: true, link });
});

// ─── Unlink a company from a reseller ────────────────────────────────────
router.delete("/:id/companies/:companyId", async (req, res) => {
  const id = parseInt(req.params.id);
  const companyId = parseInt(req.params.companyId);
  if (!Number.isInteger(id) || !Number.isInteger(companyId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const del = await db.delete(resellerCompaniesTable)
    .where(and(eq(resellerCompaniesTable.resellerId, id), eq(resellerCompaniesTable.companyId, companyId)))
    .returning({ id: resellerCompaniesTable.id });
  if (!del.length) { res.status(404).json({ error: "الارتباط غير موجود" }); return; }
  await writeAudit({
    userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null, role: "superadmin",
    companyId, module: "resellers", action: "edit",
    entityType: "reseller", entityId: String(id), metadata: { op: "unlink-company", companyId },
  });
  res.json({ ok: true });
});

// ─── Commission ledger for a reseller ────────────────────────────────────
router.get("/:id/commissions", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const rows = await db
    .select({
      id: resellerCommissionsTable.id,
      companyId: resellerCommissionsTable.companyId,
      companyName: companiesTable.nameAr,
      subscriptionId: resellerCommissionsTable.subscriptionId,
      eventType: resellerCommissionsTable.eventType,
      description: resellerCommissionsTable.description,
      baseAmount: resellerCommissionsTable.baseAmount,
      commissionRate: resellerCommissionsTable.commissionRate,
      commissionAmount: resellerCommissionsTable.commissionAmount,
      periodMonth: resellerCommissionsTable.periodMonth,
      periodYear: resellerCommissionsTable.periodYear,
      status: resellerCommissionsTable.status,
      createdAt: resellerCommissionsTable.createdAt,
    })
    .from(resellerCommissionsTable)
    .leftJoin(companiesTable, eq(companiesTable.id, resellerCommissionsTable.companyId))
    .where(eq(resellerCommissionsTable.resellerId, id))
    .orderBy(desc(resellerCommissionsTable.createdAt));
  res.json({ commissions: rows });
});

// ─── Reseller support tickets (head-office inbox) ────────────────────────
router.get("/inbox/tickets", async (req, res) => {
  const status = String(req.query.status ?? "").trim();
  const base = db
    .select({
      id: resellerTicketsTable.id,
      resellerId: resellerTicketsTable.resellerId,
      resellerName: resellersTable.nameAr,
      companyId: resellerTicketsTable.companyId,
      subject: resellerTicketsTable.subject,
      body: resellerTicketsTable.body,
      category: resellerTicketsTable.category,
      priority: resellerTicketsTable.priority,
      status: resellerTicketsTable.status,
      adminReply: resellerTicketsTable.adminReply,
      adminReplyAt: resellerTicketsTable.adminReplyAt,
      createdAt: resellerTicketsTable.createdAt,
    })
    .from(resellerTicketsTable)
    .leftJoin(resellersTable, eq(resellersTable.id, resellerTicketsTable.resellerId));
  const rows = status
    ? await base.where(eq(resellerTicketsTable.status, status)).orderBy(desc(resellerTicketsTable.createdAt))
    : await base.orderBy(desc(resellerTicketsTable.createdAt));
  res.json({ tickets: rows });
});

router.post("/inbox/tickets/:id/reply", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const reply = String(req.body?.reply ?? "").trim();
  const status = String(req.body?.status ?? "answered").trim();
  if (!reply) { res.status(400).json({ error: "نص الرد مطلوب" }); return; }
  const [updated] = await db.update(resellerTicketsTable)
    .set({ adminReply: reply, adminReplyAt: new Date(), status: status === "closed" ? "closed" : "answered", updatedAt: new Date() })
    .where(eq(resellerTicketsTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "التذكرة غير موجودة" }); return; }
  res.json({ ok: true, ticket: updated });
});

// ─── Activation requests (head-office approval queue) ────────────────────
router.get("/inbox/activation-requests", async (req, res) => {
  const status = String(req.query.status ?? "").trim();
  const base = db
    .select({
      id: resellerActivationRequestsTable.id,
      resellerId: resellerActivationRequestsTable.resellerId,
      resellerName: resellersTable.nameAr,
      companyNameAr: resellerActivationRequestsTable.companyNameAr,
      contactPhone: resellerActivationRequestsTable.contactPhone,
      contactEmail: resellerActivationRequestsTable.contactEmail,
      plan: resellerActivationRequestsTable.plan,
      notes: resellerActivationRequestsTable.notes,
      status: resellerActivationRequestsTable.status,
      adminNote: resellerActivationRequestsTable.adminNote,
      createdAt: resellerActivationRequestsTable.createdAt,
    })
    .from(resellerActivationRequestsTable)
    .leftJoin(resellersTable, eq(resellersTable.id, resellerActivationRequestsTable.resellerId));
  const rows = status
    ? await base.where(eq(resellerActivationRequestsTable.status, status)).orderBy(desc(resellerActivationRequestsTable.createdAt))
    : await base.orderBy(desc(resellerActivationRequestsTable.createdAt));
  res.json({ requests: rows });
});

router.post("/inbox/activation-requests/:id/resolve", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const decision = String(req.body?.decision ?? "");
  if (decision !== "approved" && decision !== "rejected") { res.status(400).json({ error: "قرار غير صالح" }); return; }
  const adminNote = req.body?.adminNote ? String(req.body.adminNote).trim() : null;
  const [updated] = await db.update(resellerActivationRequestsTable)
    .set({ status: decision, adminNote, resolvedAt: new Date(), updatedAt: new Date() })
    .where(eq(resellerActivationRequestsTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "الطلب غير موجود" }); return; }
  await writeAudit({
    userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null, role: "superadmin",
    companyId: null, module: "resellers", action: "edit",
    entityType: "reseller_activation_request", entityId: String(id), metadata: { decision },
  });
  res.json({ ok: true, request: updated });
});

export default router;
