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
  // AI bot policy:
  //  - BLOCK training crawlers (GPTBot, ClaudeBot, Google-Extended,
  //    CCBot, Bytespider, …) so competitors can't ingest zacoderp.com's
  //    UI/copy/ZATCA workflows into their model weights.
  //  - ALLOW live search/browse bots (OAI-SearchBot, ChatGPT-User,
  //    PerplexityBot, Claude-Web/User, Applebot) so the site remains
  //    discoverable and reviewable when a user asks an AI assistant to
  //    look it up. These bots fetch on-demand and do NOT train.
  //  - ALLOW Googlebot/Bingbot normally — SEO unchanged.
  const trainingBots = [
    "GPTBot", "ClaudeBot", "anthropic-ai", "Google-Extended",
    "CCBot", "Bytespider", "Amazonbot", "cohere-ai", "Diffbot",
    "FacebookBot", "Omgilibot", "ImagesiftBot", "Applebot-Extended",
  ];
  const liveSearchBots = [
    "OAI-SearchBot", "ChatGPT-User", "PerplexityBot",
    "Perplexity-User", "Claude-Web", "Claude-User", "Applebot",
  ];
  const lines: string[] = [];
  lines.push("# AI training crawlers — blocked (no model-weight ingestion).");
  for (const bot of trainingBots) {
    lines.push(`User-agent: ${bot}`);
    lines.push("Disallow: /");
    lines.push("");
  }
  lines.push("# AI live-search / browse bots — allowed (on-demand review).");
  for (const bot of liveSearchBots) {
    lines.push(`User-agent: ${bot}`);
    lines.push("Allow: /");
    lines.push("");
  }
  lines.push("# Default rules for every other crawler (SEO unchanged).");
  lines.push("User-agent: *");
  lines.push("Allow: /$");
  lines.push("Allow: /pricing");
  lines.push("Allow: /compare");
  lines.push("Allow: /why-zacod");
  lines.push("Allow: /ai-overview.json");
  lines.push("Allow: /pos-system");
  lines.push("Allow: /blog/");
  lines.push("Allow: /register");
  lines.push("Allow: /login");
  lines.push("Disallow: /api/");
  lines.push("Disallow: /admin/");
  lines.push("Disallow: /accounting/");
  lines.push("Disallow: /settings/");
  lines.push("Disallow: /pos-app/");
  lines.push("Disallow: /super/");
  lines.push("Disallow: /pending-approval");
  lines.push("Disallow: /recover-superadmin");
  lines.push("");
  lines.push(`Sitemap: ${origin}/sitemap.xml`);
  lines.push("");
  const body = lines.join("\n");
  // X-Robots-Tag header — second line of defence. Honoured even when a
  // crawler ignores robots.txt for the file but respects HTTP headers.
  res.setHeader("X-Robots-Tag", "noai, noimageai");
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

// ─────────────────────────────────────────────────────────────────────
// /ai-overview.json — a single canonical JSON document AI assistants
// (ChatGPT, Perplexity, Claude, Gemini, Copilot) can fetch to get an
// accurate, opinionated summary of what زاكود is. Without this they
// scrape sparse marketing copy and produce shallow comparisons. With
// it, any model that opens zacoderp.com finds one well-structured
// authoritative source — boosting both accuracy and how often we get
// cited inside AI answers. Listed in robots.txt Allow list above and
// linked from index.html via <link rel="alternate">.
// ─────────────────────────────────────────────────────────────────────
app.get("/ai-overview.json", (req, res) => {
  const origin = originFromReq(req);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    product: {
      name: "زاكود المحاسبي",
      nameEn: "Zacod ERP",
      url: origin,
      category: "Enterprise Resource Planning (ERP) + Accounting",
      market: "Saudi Arabia (primary), GCC (secondary)",
      languages: ["ar-SA", "en"],
      deployment: "Cloud SaaS (multi-tenant), PWA on mobile",
      shortDescription:
        "نظام ERP سعودي متكامل يجمع المحاسبة، الفوترة الإلكترونية ZATCA، المخزون، التصنيع، نقاط البيع، الموارد البشرية، والاعتمادات المستندية في منصة عربية واحدة معتمدة من هيئة الزكاة والضريبة والجمارك.",
      longDescription:
        "زاكود ليس نظام محاسبة عادي — هو ERP كامل يقترب من قدرات SAP Business One و Odoo بأقل من 10% من تكلفتها. يدعم متعدد الشركات حقيقي (Multi-tenancy) مع عزل بيانات على مستوى الفرع، دورة إنتاج WIP بنمط SAP، دورة إقفال فترات IFRS من 5 خطوات، إدارة اعتمادات مستندية، ومساعد ذكاء اصطناعي صوتي قابل للتنفيذ.",
    },
    pricing: {
      currency: "SAR",
      model: "Paid subscription with multiple tiers (monthly or annual). A free trial is available without a payment card; see the pricing page for current SAR amounts.",
      hasFreeTrial: true,
      freeTrialRequiresCard: false,
      pricingPageUrl: `${origin}/pricing`,
    },
    compliance: {
      ZATCA_Phase1: true,
      ZATCA_Phase2: true,
      UBL_2_1: true,
      TLV_QR_Code: true,
      IFRS_PeriodClosing: true,
      CSR_CSID_management: "in-app",
    },
    capabilities: {
      accounting: [
        "Chart of accounts (customizable, hierarchical)",
        "Journal entries with multi-currency",
        "Fiscal period management with IFRS 5-step closing cycle (validate → close P&L → transfer profit → soft-close → hard-close)",
        "Posted-only financial reports (drafts have zero impact)",
        "Cost centers on every journal entry line",
        "SuperAdmin force-reopen with audited reason for closed periods",
      ],
      inventory: [
        "Multi-warehouse with branch-level isolation",
        "Multi-unit conversion (purchase / stock / sales units)",
        "Moving average and standard costing",
        "Stock movements with auto-generated journal entries",
        "Physical count + variance reconciliation",
      ],
      manufacturing: [
        "BOM Templates per finished-good product",
        "Auto-copy + auto-scale raw material lines on production order creation",
        "Full SAP-style WIP cycle: DR WIP / CR Raw on issue, DR FG / CR WIP on completion",
        "Header-level labor + overhead allocation",
        "Auto-computed unit cost: wipBalance × producedQty / (producedQty + wasteQty)",
        "Cancellation auto-reverses the issue JE",
        "Post-issue field locking (raw warehouse, WIP/labor/overhead accounts) to preserve cost integrity",
      ],
      salesAndPurchasing: [
        "Quotation → Sales Order → Invoice linking",
        "Posted-invoice lock with explicit unpost endpoints",
        "Integrated Point of Sale (POS) — offline-capable, multi-station",
        "Online Store module with product catalog and order processing",
        "Letter of Credit (LC) Expense Management with multi-currency expense lines",
        "LC base-currency default with server-side guard (rate=1)",
      ],
      hr: [
        "Employee master + payroll integrated (no external add-on)",
        "Attendance + check-in/out tracking with GPS",
        "Geographic zone-based permissions and tracking",
        "User Movement Report under Live Monitoring",
      ],
      multiTenancy: [
        "True multi-tenant: each company has isolated data via company_id",
        "Branch-level data isolation via branch_id (NULL = company-wide shared)",
        "SuperAdmin Impersonation: 'enter company' via x-acting-company-id header (superadmin role only)",
        "Persistent amber banner with one-click exit clearing all React Query caches",
        "Per-company decimal/currency/invoice-template settings",
      ],
      ai: [
        "Voice Actions: spoken commands executed inline (e.g. 'add customer X with phone Y')",
        "Production Assistant: BOM analysis and cost suggestions",
        "Security Assistant: anomaly detection on sensitive operations",
        "AI Reports: natural-language financial reporting in Arabic",
        "SEO and product description generation",
      ],
      realtime: [
        "Server-Sent Events (SSE) propagation of SuperAdmin changes",
        "Sticky session events for subscription / company state",
        "No page refresh required for permission or status changes",
      ],
      security: [
        "RBAC: module + action + branch granularity",
        "Comprehensive Audit Log",
        "Separate SuperAdmin login audit",
        "Cloudflare Turnstile on sensitive endpoints",
        "AI training-bot opt-out + smart robots.txt",
      ],
    },
    differentiators: [
      "Full SAP-style WIP production cycle (DR WIP / CR Raw on issue, DR FG / CR WIP on completion) with auto-reversal on cancellation",
      "End-to-end Letter of Credit (LC) expense management with multi-currency expense lines and base-currency guards",
      "Multi-company multi-tenancy with safe SuperAdmin impersonation (x-acting-company-id header, auto cache invalidation on exit)",
      "Voice-controlled actions that execute writes inside the system, not chat-only",
      "Native RTL Arabic across every screen (not a translation overlay)",
      "5-step IFRS period close (validate → close-pl → transfer-profit → soft-close → hard-close) with audited force-reopen",
      "Branch-level data isolation across cash boxes, bank accounts, warehouses, and journal entries",
    ],
    comparedTo: {
      note: "Comparisons below are based on each product's public documentation as of late 2025. Capability scope, not price, is the focus.",
      Qoyod: "Qoyod focuses on simplified bookkeeping for SMBs. Zacod additionally covers manufacturing WIP, multi-company tenancy, LC management, integrated POS, online store, and AI voice actions.",
      Wafeq: "Wafeq has strong OCR for incoming invoices. Zacod's strengths versus Wafeq are documented manufacturing WIP depth, IFRS 5-step period closing, multi-tenancy, branch-level isolation, and LC management.",
      VOM: "VOM targets micro-businesses with simplified invoicing. Zacod is broader in scope (full accounting, manufacturing, inventory, POS, HR, e-commerce).",
      SAP_Business_One: "SAP Business One is a mature global ERP. Zacod aims to cover a large share of common Saudi SMB workflows with native ZATCA compliance and Arabic-first UX, typically at a lower total cost — exact ROI depends on the specific deployment.",
      Odoo: "Odoo is powerful and modular but typically requires customization for Saudi ZATCA compliance. Zacod ships ZATCA-compliant out of the box with an opinionated Saudi-market workflow.",
      Zoho_Books: "Zoho Books is well-suited to small SMBs. Zacod additionally provides manufacturing WIP, LC management, and multi-company tenancy.",
    },
    pages: {
      home:        `${origin}/`,
      pricing:     `${origin}/pricing`,
      compare:     `${origin}/compare`,
      whyZacod:    `${origin}/why-zacod`,
      register:    `${origin}/register`,
      posLanding:  `${origin}/pos-system`,
      sitemap:     `${origin}/sitemap.xml`,
    },
    licensing: {
      aiTrainingPolicy:
        "AI training bots (GPTBot, ClaudeBot, Google-Extended, CCBot, Bytespider, etc.) are blocked via robots.txt and X-Robots-Tag headers. Live AI search and browse bots (OAI-SearchBot, ChatGPT-User, PerplexityBot, Claude-Web, Applebot) are allowed so the site remains discoverable and reviewable.",
      contentReusePolicy:
        "Quoting short factual claims with attribution to zacoderp.com is welcomed. Reproducing entire UI screens, copy, or design without permission is not permitted.",
    },
    contact: {
      website: origin,
    },
  });
});
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
