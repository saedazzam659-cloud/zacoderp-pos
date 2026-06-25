import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import {
  usersTable, companiesTable, companyTemplatesTable, companyCloneRunsTable,
} from "@workspace/db";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { resolveBearerToken } from "../middleware/auth.js";
import { cloneCompany, recordCloneRun } from "../lib/cloneCompany.js";
import { seedDefaultFiscalYear } from "../lib/seedDefaultFiscalYear.js";

const router = Router();

// ─── SuperAdmin gate (mirrors admin-data-copy / adminIndustries) ─────────────
async function requireSuperAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { res.status(401).json({ error: "غير مصرح" }); return; }
  const token = auth.slice(7);

  let [user] = await db.select().from(usersTable).where(eq(usersTable.sessionToken, token));
  if (!user) {
    const resolved = await resolveBearerToken(token);
    if (resolved && resolved.origin === "superadmin") {
      const [full] = await db.select().from(usersTable).where(eq(usersTable.id, resolved.user.id));
      if (full) user = full;
    }
  }

  if (!user || !user.isActive || user.role !== "superadmin") {
    res.status(403).json({ error: "هذه الصفحة للمشرف العام فقط" }); return;
  }
  (req as any).authUser = user;
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/company-cloning/companies
// Source-company picker (live companies only).
// ─────────────────────────────────────────────────────────────────────────────
router.get("/companies", requireSuperAdmin, async (_req, res) => {
  const rows = await db.select({
    id:        companiesTable.id,
    code:      companiesTable.code,
    nameAr:    companiesTable.nameAr,
    nameEn:    companiesTable.nameEn,
    vatNumber: companiesTable.vatNumber,
    industryName: companiesTable.industryName,
    status:    companiesTable.status,
  }).from(companiesTable)
    .where(isNull(companiesTable.deletedAt))
    .orderBy(asc(companiesTable.nameAr));
  res.json({ companies: rows });
});

// ─────────────────────────────────────────────────────────────────────────────
// Templates CRUD
// ─────────────────────────────────────────────────────────────────────────────
router.get("/templates", requireSuperAdmin, async (_req, res) => {
  const rows = await db.select({
    id:            companyTemplatesTable.id,
    nameAr:        companyTemplatesTable.nameAr,
    nameEn:        companyTemplatesTable.nameEn,
    description:   companyTemplatesTable.description,
    industryName:  companyTemplatesTable.industryName,
    sourceCompanyId: companyTemplatesTable.sourceCompanyId,
    isActive:      companyTemplatesTable.isActive,
    createdAt:     companyTemplatesTable.createdAt,
    sourceNameAr:  companiesTable.nameAr,
    sourceCode:    companiesTable.code,
  }).from(companyTemplatesTable)
    .leftJoin(companiesTable, eq(companyTemplatesTable.sourceCompanyId, companiesTable.id))
    .orderBy(desc(companyTemplatesTable.createdAt));
  res.json({ templates: rows });
});

router.post("/templates", requireSuperAdmin, async (req, res) => {
  const b = req.body ?? {};
  const nameAr = String(b.nameAr ?? "").trim();
  const sourceCompanyId = Number(b.sourceCompanyId);
  if (!nameAr) { res.status(400).json({ error: "اسم القالب مطلوب" }); return; }
  if (!Number.isInteger(sourceCompanyId) || sourceCompanyId <= 0) {
    res.status(400).json({ error: "الشركة المصدر مطلوبة" }); return;
  }
  const [src] = await db.select({ id: companiesTable.id })
    .from(companiesTable)
    .where(and(eq(companiesTable.id, sourceCompanyId), isNull(companiesTable.deletedAt)));
  if (!src) { res.status(400).json({ error: "الشركة المصدر غير موجودة" }); return; }

  const [row] = await db.insert(companyTemplatesTable).values({
    nameAr,
    nameEn:          b.nameEn ? String(b.nameEn).trim() : null,
    description:     b.description ? String(b.description).trim() : null,
    industryName:    b.industryName ? String(b.industryName).trim() : null,
    sourceCompanyId,
    isActive:        b.isActive === false ? false : true,
    createdByUserId: (req as any).authUser?.id ?? null,
  }).returning();
  res.status(201).json({ template: row });
});

router.patch("/templates/:id", requireSuperAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const b = req.body ?? {};
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (b.nameAr !== undefined)       updates.nameAr = String(b.nameAr).trim();
  if (b.nameEn !== undefined)       updates.nameEn = b.nameEn ? String(b.nameEn).trim() : null;
  if (b.description !== undefined)  updates.description = b.description ? String(b.description).trim() : null;
  if (b.industryName !== undefined) updates.industryName = b.industryName ? String(b.industryName).trim() : null;
  if (b.isActive !== undefined)     updates.isActive = !!b.isActive;
  const [row] = await db.update(companyTemplatesTable).set(updates)
    .where(eq(companyTemplatesTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "القالب غير موجود" }); return; }
  res.json({ template: row });
});

router.delete("/templates/:id", requireSuperAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [row] = await db.delete(companyTemplatesTable)
    .where(eq(companyTemplatesTable.id, id)).returning({ id: companyTemplatesTable.id });
  if (!row) { res.status(404).json({ error: "القالب غير موجود" }); return; }
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/company-cloning/runs — recent clone history
// ─────────────────────────────────────────────────────────────────────────────
router.get("/runs", requireSuperAdmin, async (_req, res) => {
  const rows = await db.select().from(companyCloneRunsTable)
    .orderBy(desc(companyCloneRunsTable.createdAt)).limit(50);
  res.json({ runs: rows });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/company-cloning/clone — perform the clone
// Body: { sourceCompanyId?, templateId?, identity:{...}, admin:{...}, copyUsers? }
// Exactly one of sourceCompanyId / templateId identifies the source.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/clone", requireSuperAdmin, async (req, res) => {
  const b = req.body ?? {};
  const performedByUserId = (req as any).authUser?.id ?? null;

  // Resolve source: explicit company id OR a template's source company.
  let sourceCompanyId = Number.isInteger(Number(b.sourceCompanyId)) ? Number(b.sourceCompanyId) : 0;
  let templateId: number | null = null;
  if (Number.isInteger(Number(b.templateId)) && Number(b.templateId) > 0) {
    templateId = Number(b.templateId);
    const [tpl] = await db.select().from(companyTemplatesTable)
      .where(eq(companyTemplatesTable.id, templateId));
    if (!tpl) { res.status(400).json({ error: "القالب غير موجود" }); return; }
    sourceCompanyId = tpl.sourceCompanyId;
  }
  if (!Number.isInteger(sourceCompanyId) || sourceCompanyId <= 0) {
    res.status(400).json({ error: "يجب اختيار شركة مصدر أو قالب" }); return;
  }

  const id = b.identity ?? {};
  const admin = b.admin ?? {};
  const required: Array<[string, unknown]> = [
    ["اسم الشركة", id.nameAr], ["الرقم الضريبي", id.vatNumber], ["السجل التجاري", id.crNumber],
    ["المدينة", id.city], ["الشارع", id.street], ["رقم المبنى", id.buildingNumber],
    ["الرمز البريدي", id.postalCode],
    ["اسم المستخدم للمدير", admin.username], ["كلمة المرور للمدير", admin.password],
  ];
  for (const [label, val] of required) {
    if (!String(val ?? "").trim()) { res.status(400).json({ error: `${label} مطلوب` }); return; }
  }
  if (String(admin.password).length < 6) {
    res.status(400).json({ error: "كلمة مرور المدير يجب ألا تقل عن 6 أحرف" }); return;
  }

  try {
    const result = await cloneCompany({
      sourceCompanyId,
      templateId,
      performedByUserId,
      copyUsers: b.copyUsers !== false,
      identity: {
        nameAr:           String(id.nameAr).trim(),
        nameEn:           id.nameEn ? String(id.nameEn).trim() : null,
        vatNumber:        String(id.vatNumber).trim(),
        crNumber:         String(id.crNumber).trim(),
        city:             String(id.city).trim(),
        district:         id.district ? String(id.district).trim() : null,
        street:           String(id.street).trim(),
        buildingNumber:   String(id.buildingNumber).trim(),
        postalCode:       String(id.postalCode).trim(),
        additionalNumber: id.additionalNumber ? String(id.additionalNumber).trim() : null,
        phone:            id.phone ? String(id.phone).trim() : null,
        country:          id.country ? String(id.country).trim() : null,
        industryName:     id.industryName ? String(id.industryName).trim() : null,
      },
      admin: {
        username: String(admin.username).trim(),
        password: String(admin.password),
        nameAr:   admin.nameAr ? String(admin.nameAr).trim() : null,
        nameEn:   admin.nameEn ? String(admin.nameEn).trim() : null,
        email:    admin.email ? String(admin.email).trim() : null,
      },
    });

    // Fresh fiscal year for the new company (own tx; idempotent).
    await seedDefaultFiscalYear({ companyId: result.newCompanyId });

    await recordCloneRun({
      sourceCompanyId,
      targetCompanyId:   result.newCompanyId,
      templateId,
      performedByUserId,
      status:            "success",
      summary:           result.counts,
    });

    res.status(201).json({
      ok: true,
      companyId:   result.newCompanyId,
      companyCode: result.newCompanyCode,
      adminUserId: result.adminUserId,
      counts:      result.counts,
    });
  } catch (err: any) {
    const message = typeof err === "string" ? err : (err?.message ?? "فشل الاستنساخ");
    await recordCloneRun({
      sourceCompanyId,
      targetCompanyId:   null,
      templateId,
      performedByUserId,
      status:            "failed",
      error:             String(message).slice(0, 1000),
    });
    res.status(400).json({ error: message });
  }
});

export default router;
