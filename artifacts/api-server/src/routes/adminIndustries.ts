import { Router, type Request, type Response, type NextFunction } from "express";
import { db, industriesTable, usersTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { resolveBearerToken } from "../middleware/auth.js";

const router = Router();

// Same superadmin gate used by adminModules. Kept inline so this file
// is self-contained and we don't force admin.ts to export internals.
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
  next();
}

// Slug-ish key: latin letters / digits / underscore, lowercased.
function normaliseCode(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_");
}

// Coerces an arbitrary input to a clean string[] of granular menu-
// permission keys. Drops non-strings, trims, dedupes, preserves
// user-provided ordering, AND validates each key against the canonical
// catalog in `lib/menuPermissionCatalog.ts`. Unknown keys are silently
// dropped — this is the chokepoint that prevents typos or stale UI
// strings from ever reaching the DB and later leaking into a freshly
// registered company's `menu_permissions` JSONB via the industry merge.
import { filterCanonicalKeys } from "../lib/menuPermissionCatalog.js";

function normaliseModuleKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return filterCanonicalKeys(raw);
}

// GET /api/admin/industries — full list (admin only)
//
// Heavy template payloads (`coaTemplate`, `mappingsTemplate` JSON arrays)
// are explicitly EXCLUDED — they are only fetched on demand via the
// per-industry GET /:id/template/* endpoints. The list still surfaces
// the row counts and upload timestamps so the UI can show a summary
// badge ("📁 41 صف · آخر رفع …") next to each card.
router.get("/", requireSuperAdmin, async (_req, res) => {
  try {
    const rows = await db.select({
      id:                          industriesTable.id,
      code:                        industriesTable.code,
      nameAr:                      industriesTable.nameAr,
      nameEn:                      industriesTable.nameEn,
      emoji:                       industriesTable.emoji,
      recommendedModuleKeys:       industriesTable.recommendedModuleKeys,
      sortOrder:                   industriesTable.sortOrder,
      isActive:                    industriesTable.isActive,
      coaTemplateRowCount:         industriesTable.coaTemplateRowCount,
      coaTemplateUploadedAt:       industriesTable.coaTemplateUploadedAt,
      mappingsTemplateRowCount:    industriesTable.mappingsTemplateRowCount,
      mappingsTemplateUploadedAt:  industriesTable.mappingsTemplateUploadedAt,
      createdAt:                   industriesTable.createdAt,
      updatedAt:                   industriesTable.updatedAt,
    }).from(industriesTable)
      .orderBy(asc(industriesTable.sortOrder), asc(industriesTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/industries/public — UNAUTHENTICATED, used by the public
// Register wizard so SuperAdmin edits in /admin/industries show up
// immediately. Only `isActive=true` rows are returned.
router.get("/public", async (_req, res) => {
  try {
    const rows = await db.select({
      code:                  industriesTable.code,
      nameAr:                industriesTable.nameAr,
      nameEn:                industriesTable.nameEn,
      emoji:                 industriesTable.emoji,
      recommendedModuleKeys: industriesTable.recommendedModuleKeys,
      sortOrder:             industriesTable.sortOrder,
    }).from(industriesTable)
      .where(eq(industriesTable.isActive, true))
      .orderBy(asc(industriesTable.sortOrder), asc(industriesTable.id));
    // CDN/edge can hold this for 30s without making admin edits feel
    // laggy — same cache hint as /api/admin/modules/public.
    res.set("Cache-Control", "public, max-age=30");
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/industries — create
router.post("/", requireSuperAdmin, async (req, res) => {
  try {
    const code = normaliseCode(req.body?.code);
    if (!code) { res.status(400).json({ error: "المُعرّف (code) مطلوب" }); return; }
    const nameAr = String(req.body?.nameAr ?? "").trim();
    if (!nameAr) { res.status(400).json({ error: "الاسم بالعربي مطلوب" }); return; }

    const [dup] = await db.select({ id: industriesTable.id })
      .from(industriesTable).where(eq(industriesTable.code, code));
    if (dup) { res.status(409).json({ error: "هذا المُعرّف مستخدم بالفعل" }); return; }

    const [row] = await db.insert(industriesTable).values({
      code,
      nameAr,
      nameEn: String(req.body?.nameEn ?? "").trim(),
      emoji: String(req.body?.emoji ?? "🏢").trim() || "🏢",
      recommendedModuleKeys: normaliseModuleKeys(req.body?.recommendedModuleKeys),
      sortOrder: Number.isFinite(Number(req.body?.sortOrder)) ? Number(req.body.sortOrder) : 0,
      isActive: req.body?.isActive === false ? false : true,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PUT /api/admin/industries/:id — update
router.put("/:id", requireSuperAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

    const [existing] = await db.select().from(industriesTable).where(eq(industriesTable.id, id));
    if (!existing) { res.status(404).json({ error: "النشاط غير موجود" }); return; }

    // Only re-check uniqueness when the code actually changed (otherwise
    // self-collision would be reported as a conflict).
    let nextCode = existing.code;
    if (req.body?.code !== undefined) {
      const c = normaliseCode(req.body.code);
      if (!c) { res.status(400).json({ error: "المُعرّف (code) مطلوب" }); return; }
      if (c !== existing.code) {
        const [dup] = await db.select({ id: industriesTable.id })
          .from(industriesTable).where(eq(industriesTable.code, c));
        if (dup) { res.status(409).json({ error: "هذا المُعرّف مستخدم بالفعل" }); return; }
        nextCode = c;
      }
    }

    const nameAr = req.body?.nameAr !== undefined
      ? String(req.body.nameAr).trim() : existing.nameAr;
    if (!nameAr) { res.status(400).json({ error: "الاسم بالعربي مطلوب" }); return; }

    const [row] = await db.update(industriesTable).set({
      code: nextCode,
      nameAr,
      nameEn: req.body?.nameEn !== undefined ? String(req.body.nameEn).trim() : existing.nameEn,
      emoji: req.body?.emoji !== undefined ? (String(req.body.emoji).trim() || "🏢") : existing.emoji,
      recommendedModuleKeys: req.body?.recommendedModuleKeys !== undefined
        ? normaliseModuleKeys(req.body.recommendedModuleKeys)
        : existing.recommendedModuleKeys,
      sortOrder: req.body?.sortOrder !== undefined && Number.isFinite(Number(req.body.sortOrder))
        ? Number(req.body.sortOrder) : existing.sortOrder,
      isActive: req.body?.isActive !== undefined ? Boolean(req.body.isActive) : existing.isActive,
      updatedAt: new Date(),
    }).where(eq(industriesTable.id, id)).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/admin/industries/:id/toggle — quick activate/deactivate
router.patch("/:id/toggle", requireSuperAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [existing] = await db.select().from(industriesTable).where(eq(industriesTable.id, id));
    if (!existing) { res.status(404).json({ error: "النشاط غير موجود" }); return; }
    const [row] = await db.update(industriesTable)
      .set({ isActive: !existing.isActive, updatedAt: new Date() })
      .where(eq(industriesTable.id, id)).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/industries/:id
router.delete("/:id", requireSuperAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = await db.delete(industriesTable).where(eq(industriesTable.id, id)).returning();
    if (!result.length) { res.status(404).json({ error: "النشاط غير موجود" }); return; }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// =====================================================================
// Default catalogue — used both by POST /seed (manual reseed from the
// SuperAdmin UI) and by the bootstrap auto-seeder in api-server/index.ts
// (so a fresh DB always has the activity-type chips ready).
//
// `recommendedModuleKeys` now stores GRANULAR menu-permission keys
// (matching MENU_ITEMS in artifacts/zatca-invoicing/src/lib/menuItems.ts)
// — selecting an industry on the registration screen will OR these
// keys directly into the new company's menuPermissions JSON, so the
// linked sidebar items show up immediately. The legacy column name is
// preserved for migration compatibility.
//
// Each default also includes the always-on core (dashboard, invoices,
// customers) so the admin can see exactly what gets enabled. The
// registration handler ignores duplicates harmlessly.
// =====================================================================
export const DEFAULT_INDUSTRIES: Array<Omit<typeof industriesTable.$inferInsert, "id" | "createdAt" | "updatedAt">> = [
  {
    code: "commercial",  nameAr: "تجاري",   nameEn: "Commercial",  emoji: "🛒",
    sortOrder: 10, isActive: true,
    recommendedModuleKeys: [
      "dashboard", "invoices", "customers", "suppliers",
      "inventory_mobile", "inventory_reports",
      "sales_module", "sales_reports",
      "purchases_module", "purchases_reports",
      "cash_module", "cash_reports", "accounts", "accounting_reports",
      "hr_module",
    ],
  },
  {
    code: "industrial",  nameAr: "صناعي",   nameEn: "Industrial",  emoji: "🏭",
    sortOrder: 20, isActive: true,
    recommendedModuleKeys: [
      "dashboard", "invoices", "customers", "suppliers",
      "inventory_mobile", "inventory_reports",
      "sales_module", "sales_reports",
      "purchases_module", "purchases_reports",
      "cash_module", "cash_reports", "accounts", "accounting_reports",
      "hr_module", "production",
    ],
  },
  {
    code: "contracting", nameAr: "مقاولات", nameEn: "Contracting", emoji: "🏗️",
    sortOrder: 30, isActive: true,
    recommendedModuleKeys: [
      "dashboard", "invoices", "customers", "suppliers",
      "inventory_mobile", "inventory_reports",
      "sales_module", "sales_reports",
      "purchases_module", "purchases_reports",
      "cash_module", "cash_reports", "accounts", "accounting_reports",
      "hr_module", "production", "contracting",
    ],
  },
  {
    code: "medical",     nameAr: "طبي",     nameEn: "Medical",     emoji: "🩺",
    sortOrder: 40, isActive: true,
    recommendedModuleKeys: [
      "dashboard", "invoices", "customers",
      "sales_module", "sales_reports",
      "inventory_mobile", "inventory_reports",
      "pos",
      "cash_module", "accounts", "accounting_reports",
      "hr_module", "zatca", "reports",
    ],
  },
  {
    code: "hotels",      nameAr: "فنادق",   nameEn: "Hotels",      emoji: "🏨",
    sortOrder: 50, isActive: true,
    recommendedModuleKeys: [
      "dashboard", "invoices", "customers",
      "sales_module", "sales_reports",
      "pos",
      "inventory_mobile", "inventory_reports",
      "cash_module", "accounts", "accounting_reports",
      "hr_module", "zatca", "reports",
    ],
  },
];

// POST /api/admin/industries/seed — idempotent reseed: skips codes that
// already exist so the operator can run it on a partially-populated DB
// without losing edits. Uses ON CONFLICT DO NOTHING so concurrent calls
// (or a race with the bootstrap auto-seeder) cannot trip the unique
// constraint on `code`.
router.post("/seed", requireSuperAdmin, async (_req, res) => {
  try {
    const result = await db.insert(industriesTable)
      .values(DEFAULT_INDUSTRIES)
      .onConflictDoNothing({ target: industriesTable.code })
      .returning({ code: industriesTable.code });
    const inserted = result.length;
    const skipped  = DEFAULT_INDUSTRIES.length - inserted;
    res.json({ ok: true, inserted, skipped });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// =====================================================================
// PER-INDUSTRY DEFAULT TEMPLATES
//
// SuperAdmin uploads two optional templates per industry:
//   • COA (chart of accounts) — full account tree
//   • Mappings (accounting mappings) — document/role → account-code
//
// Templates are stored as parsed JSON arrays so the registration flow
// can apply them in one DB round-trip without ever re-parsing an .xlsx.
// Re-uploads REPLACE the stored template fully (per spec).
// All endpoints are SuperAdmin-only.
// =====================================================================

const MAX_TEMPLATE_ROWS = 5000;

function parseIndustryId(req: any, res: any): number | null {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return null; }
  return id;
}

// ── COA template ─────────────────────────────────────────────────────
router.get("/:id/template/coa", requireSuperAdmin, async (req, res) => {
  try {
    const id = parseIndustryId(req, res); if (id === null) return;
    const [row] = await db.select({
      rows:       industriesTable.coaTemplate,
      uploadedAt: industriesTable.coaTemplateUploadedAt,
      count:      industriesTable.coaTemplateRowCount,
    }).from(industriesTable).where(eq(industriesTable.id, id));
    if (!row) { res.status(404).json({ error: "النشاط غير موجود" }); return; }
    res.json({
      rows:       Array.isArray(row.rows) ? row.rows : [],
      uploadedAt: row.uploadedAt,
      count:      row.count,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/:id/template/coa", requireSuperAdmin, async (req, res) => {
  try {
    const id = parseIndustryId(req, res); if (id === null) return;
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows || rows.length === 0) { res.status(400).json({ error: "لا توجد صفوف للرفع" }); return; }
    if (rows.length > MAX_TEMPLATE_ROWS) {
      res.status(400).json({ error: `الحد الأقصى ${MAX_TEMPLATE_ROWS} صف في القالب الواحد` }); return;
    }
    const [updated] = await db.update(industriesTable).set({
      coaTemplate:           rows,
      coaTemplateRowCount:   rows.length,
      coaTemplateUploadedAt: new Date(),
      updatedAt:             new Date(),
    }).where(eq(industriesTable.id, id)).returning({
      coaTemplateRowCount:   industriesTable.coaTemplateRowCount,
      coaTemplateUploadedAt: industriesTable.coaTemplateUploadedAt,
    });
    if (!updated) { res.status(404).json({ error: "النشاط غير موجود" }); return; }
    res.json({ ok: true, ...updated });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/:id/template/coa", requireSuperAdmin, async (req, res) => {
  try {
    const id = parseIndustryId(req, res); if (id === null) return;
    const [updated] = await db.update(industriesTable).set({
      coaTemplate:           null,
      coaTemplateRowCount:   0,
      coaTemplateUploadedAt: null,
      updatedAt:             new Date(),
    }).where(eq(industriesTable.id, id)).returning({ id: industriesTable.id });
    if (!updated) { res.status(404).json({ error: "النشاط غير موجود" }); return; }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── Mappings template ────────────────────────────────────────────────
router.get("/:id/template/mappings", requireSuperAdmin, async (req, res) => {
  try {
    const id = parseIndustryId(req, res); if (id === null) return;
    const [row] = await db.select({
      rows:       industriesTable.mappingsTemplate,
      uploadedAt: industriesTable.mappingsTemplateUploadedAt,
      count:      industriesTable.mappingsTemplateRowCount,
    }).from(industriesTable).where(eq(industriesTable.id, id));
    if (!row) { res.status(404).json({ error: "النشاط غير موجود" }); return; }
    res.json({
      rows:       Array.isArray(row.rows) ? row.rows : [],
      uploadedAt: row.uploadedAt,
      count:      row.count,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/:id/template/mappings", requireSuperAdmin, async (req, res) => {
  try {
    const id = parseIndustryId(req, res); if (id === null) return;
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows || rows.length === 0) { res.status(400).json({ error: "لا توجد صفوف للرفع" }); return; }
    if (rows.length > MAX_TEMPLATE_ROWS) {
      res.status(400).json({ error: `الحد الأقصى ${MAX_TEMPLATE_ROWS} صف في القالب الواحد` }); return;
    }
    const [updated] = await db.update(industriesTable).set({
      mappingsTemplate:           rows,
      mappingsTemplateRowCount:   rows.length,
      mappingsTemplateUploadedAt: new Date(),
      updatedAt:                  new Date(),
    }).where(eq(industriesTable.id, id)).returning({
      mappingsTemplateRowCount:   industriesTable.mappingsTemplateRowCount,
      mappingsTemplateUploadedAt: industriesTable.mappingsTemplateUploadedAt,
    });
    if (!updated) { res.status(404).json({ error: "النشاط غير موجود" }); return; }
    res.json({ ok: true, ...updated });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/:id/template/mappings", requireSuperAdmin, async (req, res) => {
  try {
    const id = parseIndustryId(req, res); if (id === null) return;
    const [updated] = await db.update(industriesTable).set({
      mappingsTemplate:           null,
      mappingsTemplateRowCount:   0,
      mappingsTemplateUploadedAt: null,
      updatedAt:                  new Date(),
    }).where(eq(industriesTable.id, id)).returning({ id: industriesTable.id });
    if (!updated) { res.status(404).json({ error: "النشاط غير موجود" }); return; }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
