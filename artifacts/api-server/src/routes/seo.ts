import { Router } from "express";
import { eq, desc, and, ne, or, like, sql } from "drizzle-orm";
import { db, seoGeneratedArticlesTable } from "@workspace/db";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { buildSeoPayload } from "./admin-seo.js";
import { logger } from "../lib/logger.js";

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
// Build the country filter used by every public article endpoint:
//   show rows whose target_countries CSV either contains the visitor's
//   country code (e.g. "SA" matches "SA", "SA,AE", "AE,SA,KW") OR the
//   "GLOBAL" sentinel (the universal fallback). The sitemap builder also
//   uses this so per-country crawlers see the appropriate set.
//
// Note: we use the literal CSV match instead of pg arrays because the
// column is text — see the schema comment for rationale.
function countryFilter(country: string | undefined) {
  const c = (country || "GLOBAL").trim().toUpperCase();
  if (!c || c === "GLOBAL") {
    // Visitor has no specific country — show only GLOBAL articles.
    return like(seoGeneratedArticlesTable.targetCountries, "%GLOBAL%");
  }
  return or(
    like(seoGeneratedArticlesTable.targetCountries, `%${c}%`),
    like(seoGeneratedArticlesTable.targetCountries, "%GLOBAL%"),
  );
}

router.get("/public/articles", async (req, res) => {
  try {
    // The visitor country is auto-detected by the visitorCountry middleware
    // (Cloudflare header / ?country override / sticky cookie / GLOBAL).
    const country = (req as any).visitorCountry as string | undefined;
    const rows = await db.select({
      id:              seoGeneratedArticlesTable.id,
      title:           seoGeneratedArticlesTable.title,
      slug:            seoGeneratedArticlesTable.slug,
      metaDescription: seoGeneratedArticlesTable.metaDescription,
      targetCountries: seoGeneratedArticlesTable.targetCountries,
      updatedAt:       seoGeneratedArticlesTable.updatedAt,
    })
      .from(seoGeneratedArticlesTable)
      .where(and(
        eq(seoGeneratedArticlesTable.status, "published"),
        countryFilter(country),
      ))
      .orderBy(desc(seoGeneratedArticlesTable.updatedAt))
      .limit(500);
    // The /pricing page renders this list as "اقرأ أيضاً" cards next to a
    // selected plan. The sitemap builder consumes the same shape too.
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تعذّر تحميل المقالات" });
  }
});

// Single-article endpoint for the public /blog/:slug page. Returns the
// full markdown body, meta, and timestamps so the front-end can render
// the article and its JSON-LD Article schema. Only published articles
// are exposed; drafts/reviewed return 404 to keep them out of the index.
router.get("/public/articles/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) { res.status(400).json({ error: "slug مفقود" }); return; }
    // We do NOT apply the country filter for direct slug lookups: a deep
    // link / shared URL must always resolve as long as the article is
    // published, even if the visitor's country isn't in its target list.
    // The country tag is still surfaced in the response so the SPA can
    // render an "أيضاً متاح في…" hint if it wants to.
    const rows = await db.select({
      id:              seoGeneratedArticlesTable.id,
      title:           seoGeneratedArticlesTable.title,
      slug:            seoGeneratedArticlesTable.slug,
      metaDescription: seoGeneratedArticlesTable.metaDescription,
      content:         seoGeneratedArticlesTable.content,
      targetKeyword:   seoGeneratedArticlesTable.targetKeyword,
      targetCountries: seoGeneratedArticlesTable.targetCountries,
      createdAt:       seoGeneratedArticlesTable.createdAt,
      updatedAt:       seoGeneratedArticlesTable.updatedAt,
    })
      .from(seoGeneratedArticlesTable)
      .where(and(
        eq(seoGeneratedArticlesTable.slug, slug),
        eq(seoGeneratedArticlesTable.status, "published"),
      ))
      .limit(1);
    if (!rows.length) { res.status(404).json({ error: "المقالة غير موجودة" }); return; }
    res.json(rows[0]);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تعذّر تحميل المقالة" });
  }
});

// Returns up to 3 OTHER published articles, used by the /blog/:slug page
// to render an "اقرأ أيضاً" section. Internal links between articles and
// product pages were the explicit SEO AI low-impact recommendation —
// they boost crawl-depth and per-page session length.
router.get("/public/related/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) { res.status(400).json({ error: "slug مفقود" }); return; }
    const country = (req as any).visitorCountry as string | undefined;
    const rows = await db.select({
      id:              seoGeneratedArticlesTable.id,
      title:           seoGeneratedArticlesTable.title,
      slug:            seoGeneratedArticlesTable.slug,
      metaDescription: seoGeneratedArticlesTable.metaDescription,
      targetCountries: seoGeneratedArticlesTable.targetCountries,
      updatedAt:       seoGeneratedArticlesTable.updatedAt,
    })
      .from(seoGeneratedArticlesTable)
      .where(and(
        eq(seoGeneratedArticlesTable.status, "published"),
        ne(seoGeneratedArticlesTable.slug, slug),
        countryFilter(country),
      ))
      .orderBy(desc(seoGeneratedArticlesTable.updatedAt))
      .limit(3);
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تعذّر تحميل المقالات ذات الصلة" });
  }
});

// Lightweight 404 logger: the SPA's NotFound page POSTs here so admins
// can audit broken inbound links weekly via server logs (no DB table —
// pino logs are already centralised). We never block the user on this
// call, and we don't echo back the path to avoid amplifying probe noise.
router.post("/log-404", (req, res) => {
  try {
    const path     = String(req.body?.path || "").slice(0, 512);
    const referrer = String(req.body?.referrer || "").slice(0, 512);
    const ua       = String(req.headers["user-agent"] || "").slice(0, 256);
    if (path) {
      logger.warn({ event: "public_404", path, referrer, ua, ip: req.ip }, "public_404");
    }
    res.json({ ok: true });
  } catch {
    // The logger should never throw, but in case it does we still ack so
    // the SPA doesn't surface a broken-tracking error to the user.
    res.json({ ok: true });
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
