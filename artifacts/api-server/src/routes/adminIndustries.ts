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

// Coerces an arbitrary input to a clean string[] of module keys. Drops
// non-strings, trims, dedupes, and preserves user-provided ordering.
function normaliseModuleKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const k = v.trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

// GET /api/admin/industries — full list (admin only)
router.get("/", requireSuperAdmin, async (_req, res) => {
  try {
    const rows = await db.select().from(industriesTable)
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
// (so a fresh DB always has the activity-type chips ready). Keep in
// sync with `recommendedModuleKeys` referencing live `modules.key`s.
// =====================================================================
export const DEFAULT_INDUSTRIES: Array<Omit<typeof industriesTable.$inferInsert, "id" | "createdAt" | "updatedAt">> = [
  {
    code: "commercial",  nameAr: "تجاري",   nameEn: "Commercial",  emoji: "🛒",
    sortOrder: 10, isActive: true,
    recommendedModuleKeys: ["inventory", "sales", "purchasing", "accounting", "hr"],
  },
  {
    code: "industrial",  nameAr: "صناعي",   nameEn: "Industrial",  emoji: "🏭",
    sortOrder: 20, isActive: true,
    recommendedModuleKeys: ["inventory", "sales", "purchasing", "accounting", "hr", "production"],
  },
  {
    code: "contracting", nameAr: "مقاولات", nameEn: "Contracting", emoji: "🏗️",
    sortOrder: 30, isActive: true,
    recommendedModuleKeys: ["inventory", "sales", "purchasing", "accounting", "hr", "production", "contracting"],
  },
  {
    code: "medical",     nameAr: "طبي",     nameEn: "Medical",     emoji: "🩺",
    sortOrder: 40, isActive: true,
    recommendedModuleKeys: ["sales", "inventory", "cash", "accounting", "hr", "zatca", "pos"],
  },
  {
    code: "hotels",      nameAr: "فنادق",   nameEn: "Hotels",      emoji: "🏨",
    sortOrder: 50, isActive: true,
    recommendedModuleKeys: ["sales", "pos", "inventory", "cash", "accounting", "hr", "zatca"],
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

export default router;
