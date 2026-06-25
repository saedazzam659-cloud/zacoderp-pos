import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import {
  platformPartnersTable, partnerDocumentsTable, partnerCompaniesTable, partnerCommissionsTable,
  resellersTable, resellerCompaniesTable, resellerCommissionsTable,
  companiesTable,
  PARTNER_KINDS, PARTNER_STATUSES, PARTNER_ONBOARDING_FLOW, PARTNER_PERMISSION_KEYS,
  type PartnerKind, type PartnerStatus, type PartnerPermissions,
} from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { writeAudit } from "../middleware/permissions.js";
import { extractAuth } from "../middleware/auth.js";

// ─────────────────────────────────────────────────────────────────────────
// SuperAdmin Developer & Partner Control Center — Phase 1 (additive only).
// Mounted at /api/admin/partners. Every endpoint requires the platform
// SuperAdmin role; this router NEVER touches existing company/user/reseller
// data (it only READS resellers for the consolidated commissions report).
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

function sanitizePermissions(input: any): PartnerPermissions {
  const out: PartnerPermissions = {};
  if (input && typeof input === "object") {
    for (const k of PARTNER_PERMISSION_KEYS) out[k] = input[k] === true;
  }
  return out;
}

function normalizeKind(v: any): PartnerKind {
  return PARTNER_KINDS.includes(v) ? (v as PartnerKind) : "developer";
}

// Generate the issued Partner ID on approval: DV-###### / PT-######.
function makePartnerCode(kind: PartnerKind, id: number): string {
  const prefix = kind === "partner" ? "PT" : "DV";
  return `${prefix}-${String(id).padStart(6, "0")}`;
}

const now = () => new Date();
const period = () => { const d = new Date(); return { m: d.getMonth() + 1, y: d.getFullYear() }; };

// ─── List partners (filter by ?kind=, with company count + commission total) ─
router.get("/", async (req, res) => {
  const kindFilter = String(req.query.kind ?? "").trim();
  const rows = await db.select().from(platformPartnersTable).orderBy(desc(platformPartnersTable.createdAt));
  const counts = await db
    .select({ partnerId: partnerCompaniesTable.partnerId, n: sql<number>`count(*)::int` })
    .from(partnerCompaniesTable)
    .groupBy(partnerCompaniesTable.partnerId);
  const totals = await db
    .select({
      partnerId: partnerCommissionsTable.partnerId,
      total: sql<string>`coalesce(sum(${partnerCommissionsTable.commissionAmount}),0)`,
    })
    .from(partnerCommissionsTable)
    .groupBy(partnerCommissionsTable.partnerId);
  const countMap = new Map(counts.map((c) => [c.partnerId, c.n]));
  const totalMap = new Map(totals.map((t) => [t.partnerId, t.total]));
  const filtered = kindFilter && PARTNER_KINDS.includes(kindFilter as PartnerKind)
    ? rows.filter((r) => r.kind === kindFilter)
    : rows;
  res.json({
    partners: filtered.map((r) => ({
      ...r,
      companyCount: countMap.get(r.id) ?? 0,
      commissionTotal: totalMap.get(r.id) ?? "0",
    })),
  });
});

// ─── Consolidated commissions report (agents + developers/partners) ─────────
// MUST be registered before "/:id" routes so "reports" is not eaten by ":id".
router.get("/reports/commissions", async (_req, res) => {
  // Developers / partners
  const partners = await db.select().from(platformPartnersTable);
  const pCounts = await db
    .select({ partnerId: partnerCompaniesTable.partnerId, n: sql<number>`count(*)::int` })
    .from(partnerCompaniesTable).groupBy(partnerCompaniesTable.partnerId);
  const pAgg = await db
    .select({
      partnerId: partnerCommissionsTable.partnerId,
      base: sql<string>`coalesce(sum(${partnerCommissionsTable.baseAmount}),0)`,
      commission: sql<string>`coalesce(sum(${partnerCommissionsTable.commissionAmount}),0)`,
    })
    .from(partnerCommissionsTable).groupBy(partnerCommissionsTable.partnerId);
  const pCountMap = new Map(pCounts.map((c) => [c.partnerId, c.n]));
  const pBaseMap = new Map(pAgg.map((a) => [a.partnerId, a.base]));
  const pCommMap = new Map(pAgg.map((a) => [a.partnerId, a.commission]));

  // Agents (resellers) — read-only.
  const resellers = await db.select().from(resellersTable);
  const rCounts = await db
    .select({ resellerId: resellerCompaniesTable.resellerId, n: sql<number>`count(*)::int` })
    .from(resellerCompaniesTable).groupBy(resellerCompaniesTable.resellerId);
  const rAgg = await db
    .select({
      resellerId: resellerCommissionsTable.resellerId,
      base: sql<string>`coalesce(sum(${resellerCommissionsTable.baseAmount}),0)`,
      commission: sql<string>`coalesce(sum(${resellerCommissionsTable.commissionAmount}),0)`,
    })
    .from(resellerCommissionsTable).groupBy(resellerCommissionsTable.resellerId);
  const rCountMap = new Map(rCounts.map((c) => [c.resellerId, c.n]));
  const rBaseMap = new Map(rAgg.map((a) => [a.resellerId, a.base]));
  const rCommMap = new Map(rAgg.map((a) => [a.resellerId, a.commission]));

  const rows = [
    ...partners.map((p) => ({
      entityType: p.kind as string,             // developer | partner
      id: p.id,
      code: p.partnerCode,
      name: p.nameAr,
      status: p.status,
      commissionRate: p.commissionRate,
      companies: pCountMap.get(p.id) ?? 0,
      baseAmount: pBaseMap.get(p.id) ?? "0",
      commissionTotal: pCommMap.get(p.id) ?? "0",
    })),
    ...resellers.map((r) => ({
      entityType: "agent",
      id: r.id,
      code: r.code,
      name: r.nameAr,
      status: r.status,
      commissionRate: r.commissionRate,
      companies: rCountMap.get(r.id) ?? 0,
      baseAmount: rBaseMap.get(r.id) ?? "0",
      commissionTotal: rCommMap.get(r.id) ?? "0",
    })),
  ];

  const totals = rows.reduce(
    (acc, r) => {
      acc.companies += r.companies;
      acc.baseAmount += Number(r.baseAmount) || 0;
      acc.commissionTotal += Number(r.commissionTotal) || 0;
      return acc;
    },
    { companies: 0, baseAmount: 0, commissionTotal: 0, entities: rows.length },
  );

  res.json({
    rows,
    totals: {
      entities: totals.entities,
      companies: totals.companies,
      baseAmount: totals.baseAmount.toFixed(2),
      commissionTotal: totals.commissionTotal.toFixed(2),
    },
  });
});

// ─── Create partner (starts in 'draft') ─────────────────────────────────────
router.post("/", async (req, res) => {
  const b = req.body ?? {};
  const nameAr = String(b.nameAr ?? "").trim();
  if (!nameAr) { res.status(400).json({ error: "الاسم مطلوب" }); return; }
  const kind = normalizeKind(b.kind);
  const rate = Number(b.commissionRate);
  const [created] = await db.insert(platformPartnersTable).values({
    kind, nameAr,
    nameEn: b.nameEn ? String(b.nameEn).trim() : null,
    contactName: b.contactName ? String(b.contactName).trim() : null,
    phone: b.phone ? String(b.phone).trim() : null,
    email: b.email ? String(b.email).trim() : null,
    address: b.address ? String(b.address).trim() : null,
    website: b.website ? String(b.website).trim() : null,
    commissionRate: Number.isFinite(rate) && rate >= 0 ? rate.toFixed(3) : "0",
    permissions: sanitizePermissions(b.permissions),
    notes: b.notes ? String(b.notes).trim() : null,
    status: "draft",
  }).returning();
  await writeAudit({
    userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null, role: "superadmin",
    companyId: null, module: "partners", action: "create",
    entityType: "partner", entityId: String(created.id), metadata: { kind, nameAr },
  });
  res.status(201).json({ ok: true, partner: created });
});

// ─── Single partner (+ companies + commissions + documents) ─────────────────
router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [partner] = await db.select().from(platformPartnersTable).where(eq(platformPartnersTable.id, id));
  if (!partner) { res.status(404).json({ error: "الكيان غير موجود" }); return; }

  const companies = await db
    .select({
      linkId: partnerCompaniesTable.id,
      companyId: companiesTable.id,
      nameAr: companiesTable.nameAr,
      nameEn: companiesTable.nameEn,
      code: companiesTable.code,
      status: companiesTable.status,
      role: partnerCompaniesTable.role,
      linkedAt: partnerCompaniesTable.linkedAt,
    })
    .from(partnerCompaniesTable)
    .innerJoin(companiesTable, eq(companiesTable.id, partnerCompaniesTable.companyId))
    .where(eq(partnerCompaniesTable.partnerId, id))
    .orderBy(desc(partnerCompaniesTable.linkedAt));

  const commissions = await db
    .select()
    .from(partnerCommissionsTable)
    .where(eq(partnerCommissionsTable.partnerId, id))
    .orderBy(desc(partnerCommissionsTable.createdAt))
    .limit(50);

  const documents = await db
    .select()
    .from(partnerDocumentsTable)
    .where(eq(partnerDocumentsTable.partnerId, id))
    .orderBy(desc(partnerDocumentsTable.createdAt));

  res.json({ partner, companies, commissions, documents });
});

// ─── Update partner (profile / rate / permissions / kind) ───────────────────
router.put("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [existing] = await db.select().from(platformPartnersTable).where(eq(platformPartnersTable.id, id));
  if (!existing) { res.status(404).json({ error: "الكيان غير موجود" }); return; }
  const b = req.body ?? {};
  const patch: Record<string, any> = { updatedAt: now() };

  if (b.nameAr !== undefined) { const v = String(b.nameAr).trim(); if (!v) { res.status(400).json({ error: "الاسم مطلوب" }); return; } patch.nameAr = v; }
  if (b.nameEn !== undefined)      patch.nameEn      = b.nameEn ? String(b.nameEn).trim() : null;
  if (b.contactName !== undefined) patch.contactName = b.contactName ? String(b.contactName).trim() : null;
  if (b.phone !== undefined)       patch.phone       = b.phone ? String(b.phone).trim() : null;
  if (b.email !== undefined)       patch.email       = b.email ? String(b.email).trim() : null;
  if (b.address !== undefined)     patch.address     = b.address ? String(b.address).trim() : null;
  if (b.website !== undefined)     patch.website     = b.website ? String(b.website).trim() : null;
  if (b.notes !== undefined)       patch.notes       = b.notes ? String(b.notes).trim() : null;
  if (b.kind !== undefined)        patch.kind        = normalizeKind(b.kind);
  if (b.commissionRate !== undefined) {
    const rate = Number(b.commissionRate);
    if (!Number.isFinite(rate) || rate < 0) { res.status(400).json({ error: "نسبة عمولة غير صالحة" }); return; }
    patch.commissionRate = rate.toFixed(3);
  }
  if (b.permissions !== undefined) patch.permissions = sanitizePermissions(b.permissions);

  const [updated] = await db.update(platformPartnersTable).set(patch).where(eq(platformPartnersTable.id, id)).returning();
  await writeAudit({
    userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null, role: "superadmin",
    companyId: null, module: "partners", action: "edit",
    entityType: "partner", entityId: String(id), metadata: { fields: Object.keys(patch) },
  });
  res.json({ ok: true, partner: updated });
});

// ─── Advance / set onboarding status (state machine) ────────────────────────
// body: { to?: PartnerStatus }. With no `to`, advances to the next stage in the
// forward flow. Reaching 'approved' issues the Partner ID. 'suspended' /
// 'rejected' can be set explicitly; reactivation goes back to 'approved'.
router.post("/:id/advance", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [existing] = await db.select().from(platformPartnersTable).where(eq(platformPartnersTable.id, id));
  if (!existing) { res.status(404).json({ error: "الكيان غير موجود" }); return; }

  const to = req.body?.to ? String(req.body.to) : "";
  let target: PartnerStatus;
  if (to) {
    if (!PARTNER_STATUSES.includes(to as PartnerStatus)) { res.status(400).json({ error: "حالة غير صالحة" }); return; }
    target = to as PartnerStatus;
  } else {
    const idx = PARTNER_ONBOARDING_FLOW.indexOf(existing.status as PartnerStatus);
    const nextIdx = idx < 0 ? 0 : idx + 1;
    if (nextIdx >= PARTNER_ONBOARDING_FLOW.length) { res.status(400).json({ error: "تمت الموافقة بالفعل" }); return; }
    target = PARTNER_ONBOARDING_FLOW[nextIdx];
  }

  const patch: Record<string, any> = { status: target, updatedAt: now() };
  // Issue Partner ID on first approval.
  if (target === "approved") {
    if (!existing.partnerCode) {
      patch.partnerCode = makePartnerCode(existing.kind as PartnerKind, existing.id);
      patch.partnerIdIssuedAt = now();
    }
    if (!existing.approvedAt) patch.approvedAt = now();
    patch.isActive = true;
  }
  if (target === "suspended") patch.isActive = false;

  const [updated] = await db.update(platformPartnersTable).set(patch).where(eq(platformPartnersTable.id, id)).returning();
  await writeAudit({
    userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null, role: "superadmin",
    companyId: null, module: "partners", action: "edit",
    entityType: "partner", entityId: String(id), metadata: { op: "advance", from: existing.status, to: target },
  });
  res.json({ ok: true, partner: updated });
});

// ─── Delete partner ─────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [existing] = await db.select().from(platformPartnersTable).where(eq(platformPartnersTable.id, id));
  if (!existing) { res.status(404).json({ error: "الكيان غير موجود" }); return; }
  await db.delete(platformPartnersTable).where(eq(platformPartnersTable.id, id));
  await writeAudit({
    userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null, role: "superadmin",
    companyId: null, module: "partners", action: "delete",
    entityType: "partner", entityId: String(id), metadata: { name: existing.nameAr },
  });
  res.json({ ok: true });
});

// ─── Documents ──────────────────────────────────────────────────────────────
router.post("/:id/documents", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [partner] = await db.select({ id: platformPartnersTable.id }).from(platformPartnersTable).where(eq(platformPartnersTable.id, id));
  if (!partner) { res.status(404).json({ error: "الكيان غير موجود" }); return; }
  const docType = String(req.body?.docType ?? "").trim();
  if (!docType) { res.status(400).json({ error: "نوع المستند مطلوب" }); return; }
  const [doc] = await db.insert(partnerDocumentsTable).values({
    partnerId: id, docType,
    title: req.body?.title ? String(req.body.title).trim() : null,
    fileUrl: req.body?.fileUrl ? String(req.body.fileUrl).trim() : null,
    note: req.body?.note ? String(req.body.note).trim() : null,
  }).returning();
  res.status(201).json({ ok: true, document: doc });
});

router.put("/:id/documents/:docId", async (req, res) => {
  const id = parseInt(req.params.id);
  const docId = parseInt(req.params.docId);
  if (!Number.isInteger(id) || !Number.isInteger(docId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const decision = String(req.body?.status ?? "").trim();
  if (!["pending", "verified", "rejected"].includes(decision)) { res.status(400).json({ error: "حالة غير صالحة" }); return; }
  const [updated] = await db.update(partnerDocumentsTable)
    .set({ status: decision, note: req.body?.note ? String(req.body.note).trim() : null, reviewedAt: now() })
    .where(and(eq(partnerDocumentsTable.id, docId), eq(partnerDocumentsTable.partnerId, id)))
    .returning();
  if (!updated) { res.status(404).json({ error: "المستند غير موجود" }); return; }
  res.json({ ok: true, document: updated });
});

router.delete("/:id/documents/:docId", async (req, res) => {
  const id = parseInt(req.params.id);
  const docId = parseInt(req.params.docId);
  if (!Number.isInteger(id) || !Number.isInteger(docId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const del = await db.delete(partnerDocumentsTable)
    .where(and(eq(partnerDocumentsTable.id, docId), eq(partnerDocumentsTable.partnerId, id)))
    .returning({ id: partnerDocumentsTable.id });
  if (!del.length) { res.status(404).json({ error: "المستند غير موجود" }); return; }
  res.json({ ok: true });
});

// ─── Companies available to link (not yet linked to THIS partner) ───────────
router.get("/:id/companies/available", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const search = String(req.query.search ?? "").trim();
  const linked = await db.select({ companyId: partnerCompaniesTable.companyId })
    .from(partnerCompaniesTable).where(eq(partnerCompaniesTable.partnerId, id));
  const linkedSet = new Set(linked.map((l) => l.companyId));
  let rows = await db
    .select({ id: companiesTable.id, nameAr: companiesTable.nameAr, nameEn: companiesTable.nameEn, code: companiesTable.code, status: companiesTable.status })
    .from(companiesTable)
    .orderBy(desc(companiesTable.id))
    .limit(300);
  rows = rows.filter((r) => !linkedSet.has(r.id));
  if (search) {
    const s = search.toLowerCase();
    rows = rows.filter((r) =>
      (r.nameAr ?? "").toLowerCase().includes(s) ||
      (r.nameEn ?? "").toLowerCase().includes(s) ||
      (r.code ?? "").toLowerCase().includes(s));
  }
  res.json({ companies: rows.slice(0, 200) });
});

// ─── Link a company to a partner ────────────────────────────────────────────
router.post("/:id/companies", async (req, res) => {
  const id = parseInt(req.params.id);
  const companyId = parseInt(req.body?.companyId);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف الكيان غير صالح" }); return; }
  if (!Number.isInteger(companyId) || companyId <= 0) { res.status(400).json({ error: "معرّف الشركة غير صالح" }); return; }
  const [partner] = await db.select({ id: platformPartnersTable.id }).from(platformPartnersTable).where(eq(platformPartnersTable.id, id));
  if (!partner) { res.status(404).json({ error: "الكيان غير موجود" }); return; }
  const [company] = await db.select({ id: companiesTable.id }).from(companiesTable).where(eq(companiesTable.id, companyId));
  if (!company) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }
  const [already] = await db.select({ id: partnerCompaniesTable.id })
    .from(partnerCompaniesTable)
    .where(and(eq(partnerCompaniesTable.partnerId, id), eq(partnerCompaniesTable.companyId, companyId)));
  if (already) { res.status(409).json({ error: "الشركة مرتبطة بهذا الكيان مسبقاً" }); return; }
  const role = req.body?.role ? String(req.body.role).trim() : "served";
  const [link] = await db.insert(partnerCompaniesTable).values({ partnerId: id, companyId, role }).returning();
  await writeAudit({
    userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null, role: "superadmin",
    companyId, module: "partners", action: "edit",
    entityType: "partner", entityId: String(id), metadata: { op: "link-company", companyId },
  });
  res.status(201).json({ ok: true, link });
});

// ─── Unlink a company from a partner ────────────────────────────────────────
router.delete("/:id/companies/:companyId", async (req, res) => {
  const id = parseInt(req.params.id);
  const companyId = parseInt(req.params.companyId);
  if (!Number.isInteger(id) || !Number.isInteger(companyId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const del = await db.delete(partnerCompaniesTable)
    .where(and(eq(partnerCompaniesTable.partnerId, id), eq(partnerCompaniesTable.companyId, companyId)))
    .returning({ id: partnerCompaniesTable.id });
  if (!del.length) { res.status(404).json({ error: "الارتباط غير موجود" }); return; }
  await writeAudit({
    userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null, role: "superadmin",
    companyId, module: "partners", action: "edit",
    entityType: "partner", entityId: String(id), metadata: { op: "unlink-company", companyId },
  });
  res.json({ ok: true });
});

// ─── Commission ledger for a partner ────────────────────────────────────────
router.get("/:id/commissions", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const rows = await db
    .select({
      id: partnerCommissionsTable.id,
      companyId: partnerCommissionsTable.companyId,
      companyName: companiesTable.nameAr,
      extensionId: partnerCommissionsTable.extensionId,
      eventType: partnerCommissionsTable.eventType,
      description: partnerCommissionsTable.description,
      baseAmount: partnerCommissionsTable.baseAmount,
      commissionRate: partnerCommissionsTable.commissionRate,
      commissionAmount: partnerCommissionsTable.commissionAmount,
      periodMonth: partnerCommissionsTable.periodMonth,
      periodYear: partnerCommissionsTable.periodYear,
      status: partnerCommissionsTable.status,
      createdAt: partnerCommissionsTable.createdAt,
    })
    .from(partnerCommissionsTable)
    .leftJoin(companiesTable, eq(companiesTable.id, partnerCommissionsTable.companyId))
    .where(eq(partnerCommissionsTable.partnerId, id))
    .orderBy(desc(partnerCommissionsTable.createdAt));
  res.json({ commissions: rows });
});

// ─── Manually accrue a commission (ready for marketplace auto-accrual) ──────
router.post("/:id/commissions", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [partner] = await db.select().from(platformPartnersTable).where(eq(platformPartnersTable.id, id));
  if (!partner) { res.status(404).json({ error: "الكيان غير موجود" }); return; }
  const b = req.body ?? {};
  const eventType = String(b.eventType ?? "").trim();
  if (!["app_sale", "app_renewal", "subscription", "adjustment"].includes(eventType)) {
    res.status(400).json({ error: "نوع الحدث غير صالح" }); return;
  }
  const base = Number(b.baseAmount);
  if (!Number.isFinite(base) || base < 0) { res.status(400).json({ error: "المبلغ الأساسي غير صالح" }); return; }
  let rate = Number(b.commissionRate);
  if (!Number.isFinite(rate) || rate < 0) rate = Number(partner.commissionRate) || 0;
  const commission = +(base * (rate / 100)).toFixed(2);
  const companyId = Number.isInteger(parseInt(b.companyId)) && parseInt(b.companyId) > 0 ? parseInt(b.companyId) : null;
  const p = period();
  const [created] = await db.insert(partnerCommissionsTable).values({
    partnerId: id,
    companyId,
    extensionId: b.extensionId ? String(b.extensionId).trim() : null,
    eventType,
    description: b.description ? String(b.description).trim() : null,
    baseAmount: base.toFixed(2),
    commissionRate: rate.toFixed(3),
    commissionAmount: commission.toFixed(2),
    periodMonth: p.m,
    periodYear: p.y,
  }).returning();
  await writeAudit({
    userId: req.authUser?.id ?? null, username: req.authUser?.username ?? null, role: "superadmin",
    companyId, module: "partners", action: "create",
    entityType: "partner_commission", entityId: String(created.id), metadata: { partnerId: id, eventType, commission },
  });
  res.status(201).json({ ok: true, commission: created });
});

export default router;
