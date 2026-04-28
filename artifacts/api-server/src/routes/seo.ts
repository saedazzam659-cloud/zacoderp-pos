import { Router } from "express";
import { eq, desc } from "drizzle-orm";
import { db, seoGeneratedArticlesTable } from "@workspace/db";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { buildSeoPayload } from "./admin-seo.js";

// ─── Company-facing SEO endpoints ────────────────────────────────────────
// These are the per-tenant counterparts of /api/admin/seo/*. The superadmin
// surface (admin-seo.ts) is platform-wide; this surface is gated by the
// company's `seo_dashboard` module toggle (companies.menuPermissions) AND by
// the per-user `seo_dashboard.view` permission map.
//
// Until real Google Analytics + Search Console credentials are wired, both
// surfaces serve the same deterministic mock generator. The mock is seeded
// with the company id here so each tenant sees stable-but-different numbers.
const router = Router();

// ─── Public, unauthenticated subroutes ───────────────────────────────────
// These MUST be declared before the auth middleware below so the public
// /pricing page (and Google's crawler hitting the sitemap) can read them
// without a session. The route paths are namespaced under /public/* to
// keep them clearly separated from the per-tenant authenticated surface.
router.get("/public/articles", async (_req, res) => {
  try {
    const rows = await db.select({
      id:              seoGeneratedArticlesTable.id,
      title:           seoGeneratedArticlesTable.title,
      slug:            seoGeneratedArticlesTable.slug,
      metaDescription: seoGeneratedArticlesTable.metaDescription,
      updatedAt:       seoGeneratedArticlesTable.updatedAt,
    })
      .from(seoGeneratedArticlesTable)
      .where(eq(seoGeneratedArticlesTable.status, "published"))
      .orderBy(desc(seoGeneratedArticlesTable.updatedAt))
      .limit(500);
    // The /pricing page renders this list as "اقرأ أيضاً" cards next to a
    // selected plan. The sitemap builder consumes the same shape too.
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تعذّر تحميل المقالات" });
  }
});

router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});
router.use(requirePermission("seo_dashboard", "view"));

router.get("/dashboard", async (req, res) => {
  try {
    const cid = await resolveCompanyId(req as any);
    if (!cid) { res.status(400).json({ error: "لا توجد شركة مرتبطة بالمستخدم" }); return; }
    res.json(buildSeoPayload(cid));
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تعذّر تحميل بيانات SEO" });
  }
});

router.post("/refresh", async (req, res) => {
  try {
    const cid = await resolveCompanyId(req as any);
    if (!cid) { res.status(400).json({ error: "لا توجد شركة مرتبطة بالمستخدم" }); return; }
    res.json(buildSeoPayload(cid));
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تعذّر تحديث البيانات" });
  }
});

export default router;
