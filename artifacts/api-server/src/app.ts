import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { eq, asc, desc } from "drizzle-orm";
import { db, planConfigsTable, seoGeneratedArticlesTable } from "@workspace/db";
import router from "./routes";
import { logger } from "./lib/logger";
import { visitorCountryMiddleware, visitorCountryHandler } from "./middleware/visitorCountry.js";

// ─── Marketing/SEO discovery surface ────────────────────────────────────
// Builds the dynamic sitemap.xml + robots.txt so Google can discover the
// public /pricing landing page, the published SEO articles authored from
// the SuperAdmin Studio, and the per-plan landing slugs configured by the
// admin in PlanSettings. Both responses are cached at the edge for ~1h
// so we don't hammer the DB on every crawl.
async function buildSitemapXml(origin: string): Promise<string> {
  const lastmodNow = new Date().toISOString();
  const urls: Array<{ loc: string; lastmod: string; changefreq: string; priority: string }> = [
    // Homepage gets priority 1.0 — it's the canonical entry for the
    // primary keyword "نظام محاسبة سعودي".
    { loc: `${origin}/`,         lastmod: lastmodNow, changefreq: "daily",  priority: "1.0" },
    { loc: `${origin}/pricing`,  lastmod: lastmodNow, changefreq: "daily",  priority: "0.9" },
    { loc: `${origin}/pos-system`, lastmod: lastmodNow, changefreq: "weekly", priority: "0.9" },
    { loc: `${origin}/register`, lastmod: lastmodNow, changefreq: "weekly", priority: "0.7" },
    { loc: `${origin}/login`,    lastmod: lastmodNow, changefreq: "monthly", priority: "0.3" },
  ];
  // Add per-plan SEO landing slugs and per-plan deep links (the /pricing
  // page accepts ?plan=KEY so each plan gets its own canonical URL).
  try {
    const plans = await db.select().from(planConfigsTable)
      .where(eq(planConfigsTable.isActive, true))
      .orderBy(asc(planConfigsTable.sortOrder));
    for (const p of plans) {
      const updated = (p.updatedAt instanceof Date ? p.updatedAt : new Date()).toISOString();
      urls.push({ loc: `${origin}/pricing?plan=${encodeURIComponent(p.key)}`,
                  lastmod: updated, changefreq: "weekly", priority: "0.8" });
      const slug = (p.seoLandingSlug || "").trim();
      if (slug) {
        urls.push({ loc: `${origin}/blog/${encodeURIComponent(slug)}`,
                    lastmod: updated, changefreq: "weekly", priority: "0.8" });
      }
    }
  } catch (e) {
    logger.warn({ err: e }, "sitemap: failed to load plans");
  }
  // Add every published SEO article so Google can crawl the long-tail
  // content from a single sitemap entry.
  try {
    const articles = await db.select({
      slug:      seoGeneratedArticlesTable.slug,
      updatedAt: seoGeneratedArticlesTable.updatedAt,
    })
      .from(seoGeneratedArticlesTable)
      .where(eq(seoGeneratedArticlesTable.status, "published"))
      .orderBy(desc(seoGeneratedArticlesTable.updatedAt))
      .limit(2000);
    for (const a of articles) {
      const updated = (a.updatedAt instanceof Date ? a.updatedAt : new Date()).toISOString();
      urls.push({ loc: `${origin}/blog/${encodeURIComponent(a.slug)}`,
                  lastmod: updated, changefreq: "weekly", priority: "0.7" });
    }
  } catch (e) {
    logger.warn({ err: e }, "sitemap: failed to load articles");
  }

  const body = urls.map(u =>
    `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function originFromReq(req: express.Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() || req.protocol || "https";
  const host  = (req.headers["x-forwarded-host"] as string)?.split(",")[0]?.trim() || req.get("host") || "localhost";
  return `${proto}://${host}`;
}

async function sitemapHandler(req: express.Request, res: express.Response): Promise<void> {
  try {
    const xml = await buildSitemapXml(originFromReq(req));
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(xml);
  } catch (e: any) {
    logger.error({ err: e }, "sitemap.xml failed");
    res.status(500).type("text/plain").send("sitemap error");
  }
}

function robotsHandler(req: express.Request, res: express.Response): void {
  const origin = originFromReq(req);
  // Explicit Allow rules for the public marketing surface ensure no
  // crawler interprets a parent Disallow as covering them. Disallow
  // covers private app routes, the API, and the internal admin surface
  // so crawlers don't waste crawl budget on auth-walled pages.
  const body = [
    "User-agent: *",
    "Allow: /$",
    "Allow: /pricing",
    "Allow: /pos-system",
    "Allow: /blog/",
    "Allow: /register",
    "Allow: /login",
    "Disallow: /api/",
    "Disallow: /admin/",
    "Disallow: /accounting/",
    "Disallow: /settings/",
    "Disallow: /pos-app/",
    "Disallow: /super/",
    "Disallow: /pending-approval",
    "Disallow: /recover-superadmin",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(body);
}

const app: Express = express();

// Disable ETag generation to prevent 304 stale responses
app.set("etag", false);

// Trust the first proxy hop (Replit's edge proxy) so `req.ip` reflects the
// real client IP from X-Forwarded-For instead of the proxy's loopback
// address. SuperAdmin rate-limiting and risk-scoring rely on this — without
// it, every request looks like it comes from 127.0.0.1 and an attacker can
// trivially defeat per-IP throttles by spoofing the header. With trust=1,
// Express only uses the *last* X-Forwarded-For entry (set by the trusted
// proxy) and ignores client-injected leftmost values.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// Bumped from 100kb default so the Settings → Data Import/Export wizard
// can post realistic Excel/CSV payloads (5k–20k rows ≈ several MB of JSON).
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// Cookie parser is required by the visitor-country middleware below — it
// reads the sticky `visitor_country` cookie set when a user explicitly
// selects a country from the landing/login selector.
app.use(cookieParser());

// Detect visitor country (Cloudflare CF-IPCountry header / ?country
// override / sticky cookie / GLOBAL fallback) and attach to req. Must run
// BEFORE both the SEO routes mounted at root and the /api router so every
// downstream handler sees a populated req.visitorCountry.
app.use(visitorCountryMiddleware);

// Prevent HTTP caching on all API responses so clients always get fresh data
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  next();
});

// SEO entry points — registered BEFORE /api so they remain reachable at
// the domain root in production (Google insists on /robots.txt and
// /sitemap.xml at root). For dev/preview we also expose mirrors under
// /api/* below so the artifact's path-based routing can serve them too.
app.get("/sitemap.xml", sitemapHandler);
app.get("/robots.txt", robotsHandler);
app.get("/api/sitemap.xml", sitemapHandler);
app.get("/api/robots.txt", robotsHandler);

// Public endpoint the SPA hits on mount (when it has no cookie/query
// override) to learn the geo-IP-resolved country. Returning {country,
// resolved} lets the SPA decide whether to trust the value or stick
// with its UI default.
app.get("/api/visitor-country", visitorCountryHandler);

app.use("/api", router);

// JSON error handler — must be the LAST middleware so async errors return JSON
// (not Express's default HTML "Internal Server Error" page).
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err, url: req.url, method: req.method }, "unhandled API error");
  if (res.headersSent) return;
  const status = typeof err?.status === "number" ? err.status : 500;
  const message = err?.message || "حدث خطأ غير متوقع في الخادم";
  res.status(status).json({ error: message });
});

export default app;
