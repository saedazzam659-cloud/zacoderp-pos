import { Router, type Request, type Response, type NextFunction } from "express";
import { centralDb, db } from "@workspace/db";
import {
  usersTable, companiesTable, companyTemplatesTable, companyCloneRunsTable,
} from "@workspace/db";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { resolveBearerToken } from "../middleware/auth.js";
import { cloneCompany, recordCloneRun } from "../lib/cloneCompany.js";
import { seedDefaultFiscalYear } from "../lib/seedDefaultFiscalYear.js";
import {
  listTransferCompanies,
  parseTransferLocation,
  preflightCompanyTransfer,
  transferCompany,
  transferLocationKey,
} from "../lib/companyTransfer.js";
import { writeTransferAuditSafely } from "../lib/companyTransferAudit.js";
import { listInitializedAgents } from "../lib/agentScope.js";

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

router.get("/transfer/locations", requireSuperAdmin, async (_req, res) => {
  const agents = await listInitializedAgents();
  res.json({
    locations: [
      { key: "central", kind: "central", name: "المنصة المركزية", domain: null, online: true },
      ...agents.map((agent) => ({
        key: `agent:${agent.id}`,
        kind: "agent",
        agentId: agent.id,
        name: agent.name,
        domain: agent.domain,
        online: !!agent.lastHeartbeatAt
          && Date.now() - new Date(agent.lastHeartbeatAt).getTime() < 5 * 60_000,
      })),
    ],
  });
});

router.get("/transfer/companies", requireSuperAdmin, async (req, res) => {
  try {
    const location = parseTransferLocation(req.query.location);
    const companies = await listTransferCompanies(location);
    res.json({ location: transferLocationKey(location), companies });
  } catch (error: any) {
    res.status(400).json({ error: error?.message ?? "تعذر جلب شركات الموقع" });
  }
});

router.get("/transfer/runs", requireSuperAdmin, async (_req, res) => {
  const runs = await centralDb.select().from(companyCloneRunsTable)
    .where(sql`${companyCloneRunsTable.summary} @> '{"__transfer":1}'::jsonb`)
    .orderBy(desc(companyCloneRunsTable.createdAt)).limit(50);
  res.json({
    runs: runs.map((run) => {
      let details: Record<string, unknown> = {};
      if (run.status === "success" && run.error) {
        try { details = JSON.parse(run.error); } catch { details = {}; }
      }
      const summary = (run.summary ?? {}) as Record<string, unknown>;
      return {
        ...run,
        sourceLocation: details.sourceLocation
          ?? (Number(summary.__sourceAgentId) > 0 ? `agent:${summary.__sourceAgentId}` : "central"),
        targetLocation: details.targetLocation
          ?? (Number(summary.__targetAgentId) > 0 ? `agent:${summary.__targetAgentId}` : "central"),
        sourceName: details.sourceName ?? null,
        targetCompanyId: run.targetCompanyId,
        companyCode: details.companyCode ?? null,
        error: run.status === "failed" ? run.error : null,
      };
    }),
  });
});

function validateTransferAdmin(value: any) {
  const username = String(value?.username ?? "").trim();
  const password = String(value?.password ?? "");
  if (!username) throw new Error("اسم مستخدم مدير الشركة الهدف مطلوب");
  if (password.length < 6) throw new Error("كلمة مرور المدير يجب ألا تقل عن 6 أحرف");
  return {
    username,
    password,
    nameAr: value?.nameAr ? String(value.nameAr).trim() : null,
    nameEn: value?.nameEn ? String(value.nameEn).trim() : null,
    email: value?.email ? String(value.email).trim() : null,
  };
}

router.post("/transfer/preflight", requireSuperAdmin, async (req, res) => {
  try {
    const result = await preflightCompanyTransfer({
      sourceLocation: parseTransferLocation(req.body?.sourceLocation),
      targetLocation: parseTransferLocation(req.body?.targetLocation),
      sourceCompanyId: Number(req.body?.sourceCompanyId),
      exportedBy: (req as any).authUser?.username ?? null,
      includeAttachments: req.body?.includeAttachments === true,
    });
    res.json({ ok: result.integrity.ok, ...result });
  } catch (error: any) {
    res.status(400).json({
      error: error?.message ?? "تعذر فحص نقل الشركة",
      ...(error?.integrity ? { integrity: error.integrity } : {}),
    });
  }
});

router.post("/transfer", requireSuperAdmin, async (req, res) => {
  const performedByUserId = (req as any).authUser?.id ?? null;
  const sourceCompanyId = Number(req.body?.sourceCompanyId);
  let sourceLocation;
  let targetLocation;
  let sourceName = `#${sourceCompanyId}`;
  let result;
  try {
    sourceLocation = parseTransferLocation(req.body?.sourceLocation);
    targetLocation = parseTransferLocation(req.body?.targetLocation);
    result = await transferCompany({
      sourceLocation,
      targetLocation,
      sourceCompanyId,
      exportedBy: (req as any).authUser?.username ?? null,
      admin: validateTransferAdmin(req.body?.admin),
      includeAttachments: req.body?.includeAttachments === true,
    });
    sourceName = result.sourceCompanyName;
  } catch (error: any) {
    const message = error?.message ?? "فشل نقل الشركة";
    await centralDb.insert(companyCloneRunsTable).values({
      sourceCompanyId: Number.isInteger(sourceCompanyId) && sourceCompanyId > 0 ? sourceCompanyId : 0,
      targetCompanyId: null,
      performedByUserId,
      status: "failed",
      summary: {
        __transfer: 1,
        __sourceAgentId: sourceLocation?.kind === "agent" ? sourceLocation.agentId : 0,
        __targetAgentId: targetLocation?.kind === "agent" ? targetLocation.agentId : 0,
      },
      error: message,
    } as any).catch(() => {});
    res.status(400).json({ error: message, ...(error?.integrity ? { integrity: error.integrity } : {}) });
    return;
  }
  const summary = {
    __transfer: 1,
    __sourceAgentId: sourceLocation.kind === "agent" ? sourceLocation.agentId : 0,
    __targetAgentId: targetLocation.kind === "agent" ? targetLocation.agentId : 0,
    __filesExcluded: result.excludedFileReferences,
    __filesCopied: result.filesCopied,
    __zatcaReconnect: 1,
    ...result.counts,
  };
  if (result.warning) {
    req.log?.warn?.({
      sourceCompanyId,
      targetCompanyId: result.companyId,
      sourceLocation: transferLocationKey(sourceLocation),
      targetLocation: transferLocationKey(targetLocation),
      warning: result.warning,
    }, "company transfer completed with cleanup warning");
  }
  const auditLogged = await writeTransferAuditSafely(async () => {
    await centralDb.insert(companyCloneRunsTable).values({
      sourceCompanyId,
      targetCompanyId: result.companyId,
      performedByUserId,
      status: "success",
      summary,
      error: JSON.stringify({
        sourceName,
        sourceLocation: transferLocationKey(sourceLocation),
        targetLocation: transferLocationKey(targetLocation),
        companyCode: result.companyCode,
        warning: result.warning ?? null,
      }),
    } as any);
  }, (auditError) => {
    req.log?.error?.({
      err: auditError,
      sourceCompanyId,
      targetCompanyId: result.companyId,
      sourceLocation: transferLocationKey(sourceLocation),
      targetLocation: transferLocationKey(targetLocation),
    }, "company transfer completed but central audit log insert failed");
  });
  res.status(201).json({
    ok: true,
    ...result,
    auditLogged,
    ...(auditLogged ? {} : {
      warning: [
        result.warning,
        "اكتمل النقل بنجاح، لكن تعذّر حفظ سطر سجل العملية المركزي.",
      ].filter(Boolean).join(" "),
    }),
  });
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
