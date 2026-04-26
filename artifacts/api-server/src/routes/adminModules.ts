import { Router, type Request, type Response, type NextFunction } from "express";
import { db, modulesTable, usersTable } from "@workspace/db";
import { eq, asc, sql } from "drizzle-orm";
import { resolveBearerToken } from "../middleware/auth.js";

const router = Router();

// Same superadmin gate as admin.ts. Kept inline so this file is self-contained
// and doesn't force `admin.ts` (4.7k lines) to export internals.
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
function normaliseKey(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_");
}

function clampPrice(raw: unknown): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return "0";
  // Stored as text to match plan_configs pattern. Two-decimal rounding to keep
  // SAR amounts tidy.
  return (Math.round(n * 100) / 100).toFixed(2);
}

// GET /api/admin/modules — list all modules (super-admin only).
router.get("/", requireSuperAdmin, async (_req, res) => {
  try {
    const rows = await db.select().from(modulesTable)
      .orderBy(asc(modulesTable.sortOrder), asc(modulesTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/modules — create
router.post("/", requireSuperAdmin, async (req, res) => {
  try {
    const key = normaliseKey(req.body?.key);
    if (!key) { res.status(400).json({ error: "المُعرّف (key) مطلوب" }); return; }
    const nameAr = String(req.body?.nameAr ?? "").trim();
    if (!nameAr) { res.status(400).json({ error: "الاسم بالعربي مطلوب" }); return; }

    // Pre-check uniqueness so we can return a friendly Arabic error instead of
    // raw Postgres "duplicate key" output.
    const [dup] = await db.select({ id: modulesTable.id })
      .from(modulesTable).where(eq(modulesTable.key, key));
    if (dup) { res.status(409).json({ error: "هذا المُعرّف مستخدم بالفعل" }); return; }

    const [row] = await db.insert(modulesTable).values({
      key,
      nameAr,
      nameEn: String(req.body?.nameEn ?? "").trim(),
      description: String(req.body?.description ?? "").trim(),
      monthlyPrice: clampPrice(req.body?.monthlyPrice),
      icon: String(req.body?.icon ?? "Package").trim() || "Package",
      iconColor: String(req.body?.iconColor ?? "#0ea5e9").trim() || "#0ea5e9",
      category: String(req.body?.category ?? "").trim(),
      sortOrder: Number.isFinite(Number(req.body?.sortOrder)) ? Number(req.body.sortOrder) : 0,
      isActive: req.body?.isActive === false ? false : true,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PUT /api/admin/modules/:id — full update
router.put("/:id", requireSuperAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

    const [existing] = await db.select().from(modulesTable).where(eq(modulesTable.id, id));
    if (!existing) { res.status(404).json({ error: "الوحدة غير موجودة" }); return; }

    // `key` change must stay unique. We only re-check when the value actually
    // changes — otherwise self-collision (the row's own key) would be reported
    // as a conflict.
    let nextKey = existing.key;
    if (req.body?.key !== undefined) {
      const k = normaliseKey(req.body.key);
      if (!k) { res.status(400).json({ error: "المُعرّف (key) مطلوب" }); return; }
      if (k !== existing.key) {
        const [dup] = await db.select({ id: modulesTable.id })
          .from(modulesTable).where(eq(modulesTable.key, k));
        if (dup) { res.status(409).json({ error: "هذا المُعرّف مستخدم بالفعل" }); return; }
        nextKey = k;
      }
    }

    const nameAr = req.body?.nameAr !== undefined
      ? String(req.body.nameAr).trim() : existing.nameAr;
    if (!nameAr) { res.status(400).json({ error: "الاسم بالعربي مطلوب" }); return; }

    const [row] = await db.update(modulesTable).set({
      key: nextKey,
      nameAr,
      nameEn: req.body?.nameEn !== undefined ? String(req.body.nameEn).trim() : existing.nameEn,
      description: req.body?.description !== undefined ? String(req.body.description).trim() : existing.description,
      monthlyPrice: req.body?.monthlyPrice !== undefined ? clampPrice(req.body.monthlyPrice) : existing.monthlyPrice,
      icon: req.body?.icon !== undefined ? (String(req.body.icon).trim() || "Package") : existing.icon,
      iconColor: req.body?.iconColor !== undefined ? (String(req.body.iconColor).trim() || "#0ea5e9") : existing.iconColor,
      category: req.body?.category !== undefined ? String(req.body.category).trim() : existing.category,
      sortOrder: req.body?.sortOrder !== undefined && Number.isFinite(Number(req.body.sortOrder))
        ? Number(req.body.sortOrder) : existing.sortOrder,
      isActive: req.body?.isActive !== undefined ? Boolean(req.body.isActive) : existing.isActive,
      updatedAt: new Date(),
    }).where(eq(modulesTable.id, id)).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/admin/modules/:id/toggle — quick activate/deactivate switch
router.patch("/:id/toggle", requireSuperAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [existing] = await db.select().from(modulesTable).where(eq(modulesTable.id, id));
    if (!existing) { res.status(404).json({ error: "الوحدة غير موجودة" }); return; }
    const [row] = await db.update(modulesTable)
      .set({ isActive: !existing.isActive, updatedAt: new Date() })
      .where(eq(modulesTable.id, id)).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/modules/:id
router.delete("/:id", requireSuperAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = await db.delete(modulesTable).where(eq(modulesTable.id, id)).returning();
    if (!result.length) { res.status(404).json({ error: "الوحدة غير موجودة" }); return; }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/modules/seed — one-shot bootstrap with the default catalogue
// from the registration screen. Idempotent: skips keys that already exist so
// the operator can run it on a partially-populated DB without losing edits.
router.post("/seed", requireSuperAdmin, async (_req, res) => {
  try {
    const defaults: Array<Omit<typeof modulesTable.$inferInsert, "id" | "createdAt" | "updatedAt">> = [
      { key: "sales",        nameAr: "العملاء والمبيعات",      nameEn: "Customers & Sales",     description: "إدارة العملاء، عروض الأسعار، فواتير المبيعات وتقاريرها", monthlyPrice: "350.00", icon: "Users",        iconColor: "#2563eb", category: "المبيعات والعملاء", sortOrder: 10, isActive: true },
      { key: "purchasing",   nameAr: "المشتريات والموردون",    nameEn: "Purchasing & Suppliers", description: "إدارة الموردين، أوامر وفواتير الشراء والتقارير",         monthlyPrice: "350.00", icon: "Truck",        iconColor: "#0ea5e9", category: "العمليات",          sortOrder: 20, isActive: true },
      { key: "inventory",    nameAr: "المخزون والمستودعات",    nameEn: "Inventory & Warehouses",description: "تتبع الأصناف، الأرصدة، التحويلات، الجرد وتقارير المخزون",   monthlyPrice: "450.00", icon: "Boxes",        iconColor: "#f59e0b", category: "العمليات",          sortOrder: 30, isActive: true },
      { key: "pos",          nameAr: "نقاط البيع",             nameEn: "Point of Sale",         description: "كاشير، جلسات، أجهزة نقاط البيع ومتابعة الحركة",         monthlyPrice: "450.00", icon: "Store",        iconColor: "#10b981", category: "العمليات",          sortOrder: 40, isActive: true },
      { key: "accounting",   nameAr: "المحاسبة العامة",        nameEn: "Accounting",            description: "دليل الحسابات، القيود، ميزان المراجعة والقوائم المالية", monthlyPrice: "550.00", icon: "Calculator",   iconColor: "#8b5cf6", category: "المالية",           sortOrder: 50, isActive: true },
      { key: "cash",         nameAr: "النقد والبنوك",          nameEn: "Cash & Banks",          description: "الخزائن، الحسابات البنكية، سندات القبض والصرف",          monthlyPrice: "300.00", icon: "Wallet",       iconColor: "#0891b2", category: "المالية",           sortOrder: 60, isActive: true },
      { key: "hr",           nameAr: "الموارد البشرية",        nameEn: "HR & Payroll",          description: "بيانات الموظفين، كشوف الرواتب، البدلات والاستقطاعات",   monthlyPrice: "400.00", icon: "UserCog",      iconColor: "#db2777", category: "المالية",           sortOrder: 70, isActive: true },
      { key: "zatca",        nameAr: "فوترة زاتكا الإلكترونية", nameEn: "ZATCA E-Invoicing",     description: "إصدار الفواتير الإلكترونية المتوافقة مع زاتكا (المرحلتين)", monthlyPrice: "200.00", icon: "FileCheck",    iconColor: "#16a34a", category: "الالتزام",          sortOrder: 80, isActive: true },
    ];

    let inserted = 0;
    let skipped = 0;
    for (const m of defaults) {
      const [existing] = await db.select({ id: modulesTable.id })
        .from(modulesTable).where(eq(modulesTable.key, m.key));
      if (existing) { skipped++; continue; }
      await db.insert(modulesTable).values(m);
      inserted++;
    }
    res.json({ ok: true, inserted, skipped, total: defaults.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;

// Suppress "unused import" lint when Postgres is consulted only for migrations.
void sql;
