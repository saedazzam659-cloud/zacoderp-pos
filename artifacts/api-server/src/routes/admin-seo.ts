import { Router, type Request, type Response, type NextFunction } from "express";
import { db, usersTable, systemSettingsTable, seoGeneratedArticlesTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import { chat as aiChat } from "../lib/aiClient.js";
import dns from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { resolveBearerToken } from "../middleware/auth.js";
import { pingArticleUrls } from "../lib/indexNow.js";
import {
  parseServiceAccount,
  testGsc,
  testGa4,
  fetchGscTotals,
  fetchGscKeywords,
  fetchGscTimeline,
  fetchGa4Totals,
  fetchGa4TrafficSources,
  fetchGa4TopPages,
  fetchGa4DailyVisitors,
} from "../lib/googleSeo.js";

const router = Router();

// ─── Auth ────────────────────────────────────────────────────────────────
// Same superadmin gate used elsewhere in the admin surface. Kept inline so
// this file is self-contained.
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
  // Expose the authenticated SuperAdmin so downstream handlers can attribute
  // writes (createdByUserId) and apply per-user rate limits.
  (req as any).user = user;
  next();
}

// ─── Deterministic mock generator ────────────────────────────────────────
// Until Google Analytics + Search Console credentials are wired, we serve a
// realistic-shaped payload so the SEO dashboard is fully functional and
// inspectable. Values are SEEDED off the current calendar day so a tenant
// sees STABLE numbers within a day (matching the "24-hour refresh" UX in
// the spec) but they evolve naturally day to day.
//
// When GA/GSC integration ships, replace each section with the real fetch
// keeping the response shape unchanged.
function dayKey(d: Date = new Date()): number {
  return Math.floor(d.getTime() / 86_400_000);
}

// Cheap LCG PRNG seeded by an integer — keeps mock data reproducible per day
// without bringing in a crypto-grade RNG.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function jitter(rand: () => number, base: number, spreadPct = 0.15): number {
  const delta = base * spreadPct * (rand() * 2 - 1);
  return Math.max(0, Math.round(base + delta));
}

interface SeoTimelinePoint { day: string; visitors: number; clicks: number; impressions: number }
interface KeywordRow      { keyword: string; impressions: number; clicks: number; position: number; page: string }
interface PageRow         { url: string; title: string; visits: number; avgSessionSeconds: number; position: number }
interface SourceSlice     { source: "organic" | "direct" | "social" | "referral"; sessions: number; pct: number }
interface IndexStatus     { indexed: number; notIndexed: number; crawlErrors: number }
interface AlertRow        { id: string; severity: "info" | "warn" | "critical"; message: string }
interface RecommendationRow { id: string; title: string; details: string; impact: "low" | "medium" | "high" }

interface SeoDashboardPayload {
  connected: { analytics: boolean; searchConsole: boolean };
  generatedAt: string;
  // Top KPI cards — current period totals
  totals: {
    visitors:        number;
    clicks:          number;
    impressions:     number;
    averagePosition: number;     // 1.0 best
    visibilityScore: number;     // (clicks/impressions) * 100
    // Period-over-period delta (% vs the prior equivalent window)
    visitorsDeltaPct:    number;
    clicksDeltaPct:      number;
    impressionsDeltaPct: number;
    positionDelta:       number; // negative = improvement (lower position number)
  };
  // Three timelines (daily / weekly / monthly) — UI picks one via tab
  timeline: {
    daily:   SeoTimelinePoint[]; // last 30 days
    weekly:  SeoTimelinePoint[]; // last 12 weeks
    monthly: SeoTimelinePoint[]; // last 12 months
  };
  keywords: KeywordRow[];
  topPages: PageRow[];
  trafficSources: SourceSlice[];
  indexStatus: IndexStatus;
  alerts: AlertRow[];
  recommendations: RecommendationRow[];
}

// Realistic Arabic SEO sample data drawn for a Saudi ZATCA / accounting SaaS.
const SAMPLE_KEYWORDS = [
  { keyword: "برنامج فاتورة الكترونية",      page: "/features/zatca" },
  { keyword: "نظام محاسبة سعودي",            page: "/" },
  { keyword: "زاتكا فاتورة الكترونية",       page: "/features/zatca" },
  { keyword: "برنامج نقاط بيع",              page: "/features/pos" },
  { keyword: "أفضل برنامج محاسبة للمتاجر",   page: "/blog/best-pos-2026" },
  { keyword: "مخزون متعدد الفروع",           page: "/features/inventory" },
  { keyword: "برنامج موارد بشرية سعودي",     page: "/features/hr" },
  { keyword: "حساب نهاية الخدمة",            page: "/blog/end-of-service" },
  { keyword: "ضريبة القيمة المضافة 15%",     page: "/blog/vat-guide" },
  { keyword: "ربط Zatca المرحلة الثانية",    page: "/features/zatca" },
  { keyword: "برنامج مقاولات ومستخلصات",    page: "/features/contracting" },
  { keyword: "شجرة الحسابات التجارية",       page: "/blog/coa-template" },
] as const;

const SAMPLE_PAGES = [
  { url: "/",                          title: "الرئيسية" },
  { url: "/features/zatca",            title: "ربط الفاتورة الإلكترونية" },
  { url: "/features/pos",              title: "نقاط البيع" },
  { url: "/features/inventory",        title: "إدارة المخزون" },
  { url: "/features/hr",               title: "الموارد البشرية" },
  { url: "/features/contracting",      title: "إدارة المقاولات" },
  { url: "/blog/best-pos-2026",        title: "أفضل برامج نقاط البيع 2026" },
  { url: "/blog/vat-guide",            title: "دليل ضريبة القيمة المضافة" },
  { url: "/blog/coa-template",         title: "قالب دليل الحسابات التجاري" },
  { url: "/pricing",                   title: "الباقات والأسعار" },
] as const;

// `seedSalt` lets each company get a stable-but-different mock when the same
// generator is called from the per-company /api/seo route. Pass the company
// id (or 0 for platform-wide / superadmin view).
export function buildSeoPayload(seedSalt = 0): SeoDashboardPayload {
  const today = new Date();
  const seed = dayKey(today) + seedSalt * 1_000_003; // prime offset
  const rand = rng(seed);

  // Headline numbers (roughly 30-day totals).
  const visitors    = jitter(rand, 28_500, 0.10);
  const impressions = jitter(rand, 412_000, 0.10);
  const clicks      = jitter(rand,   9_350, 0.10);
  const avgPos      = +(3.8 + (rand() * 1.4)).toFixed(2);
  const visibility  = +(clicks / impressions * 100).toFixed(2);

  const visitorsDeltaPct    = +((rand() * 28 - 8)).toFixed(1);
  const clicksDeltaPct      = +((rand() * 30 - 6)).toFixed(1);
  const impressionsDeltaPct = +((rand() * 22 - 4)).toFixed(1);
  const positionDelta       = +((rand() * 0.8 - 0.4)).toFixed(2);

  // ─── Timelines ─────────────────────────────────────────────────────────
  const daily: SeoTimelinePoint[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    daily.push({
      day:         d.toISOString().slice(0, 10),
      visitors:    jitter(rand, visitors / 30, 0.35),
      clicks:      jitter(rand, clicks / 30,   0.35),
      impressions: jitter(rand, impressions / 30, 0.30),
    });
  }
  const weekly: SeoTimelinePoint[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i * 7);
    weekly.push({
      day:         `الأسبوع ${12 - i}`,
      visitors:    jitter(rand, visitors / 4,    0.20),
      clicks:      jitter(rand, clicks / 4,      0.20),
      impressions: jitter(rand, impressions / 4, 0.20),
    });
  }
  const monthly: SeoTimelinePoint[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(today);
    d.setMonth(d.getMonth() - i);
    const monthLabel = d.toLocaleDateString("ar-SA", { month: "short", year: "2-digit" });
    monthly.push({
      day:         monthLabel,
      visitors:    jitter(rand, visitors,    0.18),
      clicks:      jitter(rand, clicks,      0.18),
      impressions: jitter(rand, impressions, 0.18),
    });
  }

  // ─── Keywords ─────────────────────────────────────────────────────────
  const keywords: KeywordRow[] = SAMPLE_KEYWORDS.map((k) => {
    const kImp = jitter(rand, 9_500, 0.55);
    const ctr  = 0.015 + rand() * 0.085; // 1.5%–10%
    return {
      keyword:     k.keyword,
      page:        k.page,
      impressions: kImp,
      clicks:      Math.round(kImp * ctr),
      position:    +(1 + rand() * 18).toFixed(1),
    };
  }).sort((a, b) => b.impressions - a.impressions);

  // ─── Top pages ────────────────────────────────────────────────────────
  const topPages: PageRow[] = SAMPLE_PAGES.map((p) => ({
    url:               p.url,
    title:             p.title,
    visits:            jitter(rand, 2_400, 0.55),
    avgSessionSeconds: Math.round(40 + rand() * 200),
    position:          +(1 + rand() * 18).toFixed(1),
  })).sort((a, b) => b.visits - a.visits);

  // ─── Traffic sources ──────────────────────────────────────────────────
  const orgPct  = +(58 + (rand() * 8 - 4)).toFixed(1);
  const dirPct  = +(18 + (rand() * 6 - 3)).toFixed(1);
  const socPct  = +(13 + (rand() * 6 - 3)).toFixed(1);
  const refPct  = +(100 - orgPct - dirPct - socPct).toFixed(1);
  const trafficSources: SourceSlice[] = [
    { source: "organic",  sessions: Math.round(visitors * orgPct / 100), pct: orgPct  },
    { source: "direct",   sessions: Math.round(visitors * dirPct / 100), pct: dirPct  },
    { source: "social",   sessions: Math.round(visitors * socPct / 100), pct: socPct  },
    { source: "referral", sessions: Math.round(visitors * refPct / 100), pct: refPct  },
  ];

  // ─── Index status ─────────────────────────────────────────────────────
  const indexStatus: IndexStatus = {
    indexed:     jitter(rand, 184, 0.05),
    notIndexed:  jitter(rand,  17, 0.40),
    crawlErrors: jitter(rand,   3, 0.80),
  };

  // ─── Alerts (simple AI heuristics over the mock numbers) ──────────────
  const alerts: AlertRow[] = [];
  if (visitorsDeltaPct < -5) {
    alerts.push({
      id: "traffic_drop",
      severity: "critical",
      message: `انخفاض في الترافيك بنسبة ${Math.abs(visitorsDeltaPct)}% مقارنة بالفترة السابقة`,
    });
  }
  if (positionDelta > 0.2) {
    alerts.push({
      id: "ranking_drop",
      severity: "warn",
      message: `متوسط الترتيب تراجع بمقدار ${positionDelta} نقطة — راجع أداء أهم الكلمات`,
    });
  }
  if (indexStatus.crawlErrors > 5) {
    alerts.push({
      id: "crawl_errors",
      severity: "warn",
      message: `${indexStatus.crawlErrors} صفحة بها أخطاء زحف — افتح Search Console لإصلاحها`,
    });
  }
  if (visibility < 1.5) {
    alerts.push({
      id: "low_ctr",
      severity: "info",
      message: `نسبة الظهور (Visibility) منخفضة (${visibility}%) — حسّن العناوين والوصف الميتا`,
    });
  }
  if (alerts.length === 0) {
    alerts.push({
      id: "all_good",
      severity: "info",
      message: "لا توجد تنبيهات حرجة — الأداء ضمن النطاق المتوقع",
    });
  }

  // ─── AI recommendations ───────────────────────────────────────────────
  const recommendations: RecommendationRow[] = [
    {
      id: "improve_top_keyword",
      title: `حسّن صفحة "${keywords[0]?.page ?? "/"}" المرتبطة بكلمة "${keywords[0]?.keyword ?? ""}"`,
      details: "هذه الكلمة تجلب أكبر عدد ظهور — تحسين العنوان والوصف يمكن أن يرفع نسبة النقر بشكل ملحوظ.",
      impact: "high",
    },
    {
      id: "expand_blog",
      title: "أضف 3 مقالات جديدة حول الفاتورة الإلكترونية المرحلة الثانية",
      details: "الكلمات المتعلقة بـZATCA ترفع من حجم البحث شهرياً — تغطية أوسع تعني ظهوراً أكبر.",
      impact: "high",
    },
    {
      id: "optimize_pos_page",
      title: "حدّث صفحة نقاط البيع بإضافة فيديو توضيحي وقسم أسئلة شائعة",
      details: "الصفحة في المركز الثاني من حيث الزيارات لكن متوسط الجلسة قصير — محتوى أعمق يطيلها.",
      impact: "medium",
    },
    {
      id: "fix_crawl",
      title: "أصلح أخطاء الزحف الموجودة على الصفحات غير المؤرشفة",
      details: "كل صفحة غير مؤرشفة تعني فقدان فرص ظهور — راجع robots.txt وروابط 404.",
      impact: "medium",
    },
    {
      id: "internal_linking",
      title: "أضف روابط داخلية بين المقالات والصفحات المنتجة للمبيعات",
      details: "روابط داخلية ذكية ترفع ترتيب الصفحات الأهم وتزيد متوسط مدة الجلسة.",
      impact: "low",
    },
  ];

  return {
    connected: { analytics: false, searchConsole: false },
    generatedAt: today.toISOString(),
    totals: {
      visitors, clicks, impressions, averagePosition: avgPos, visibilityScore: visibility,
      visitorsDeltaPct, clicksDeltaPct, impressionsDeltaPct, positionDelta,
    },
    timeline: { daily, weekly, monthly },
    keywords, topPages, trafficSources, indexStatus, alerts, recommendations,
  };
}

// ─── Connection settings — shared loader/saver ──────────────────────────
// Centralises read/write of the seo_connection blob in system_settings so
// both the dashboard endpoint (for live data) and the connection endpoints
// (for status / save / test) agree on the shape.
interface ConnectionRow {
  analytics: boolean;
  searchConsole: boolean;
  analyticsPropertyId: string | null;
  searchConsoleSiteUrl: string | null;
  serviceAccountJson: string | null; // raw JSON blob — never returned to client
}

async function loadConnectionRow(): Promise<ConnectionRow> {
  const [row] = await db.select().from(systemSettingsTable)
    .where(eq(systemSettingsTable.key, "seo_connection"));
  let v: any = {};
  if (row?.value) {
    try { v = JSON.parse(row.value); } catch { v = {}; }
  }
  return {
    analytics:           !!v.analytics,
    searchConsole:       !!v.searchConsole,
    analyticsPropertyId: typeof v.analyticsPropertyId === "string" ? v.analyticsPropertyId : null,
    searchConsoleSiteUrl: typeof v.searchConsoleSiteUrl === "string" ? v.searchConsoleSiteUrl : null,
    serviceAccountJson:  typeof v.serviceAccountJson === "string" ? v.serviceAccountJson : null,
  };
}

async function saveConnectionRow(row: ConnectionRow): Promise<void> {
  const value = JSON.stringify(row);
  await db.insert(systemSettingsTable)
    .values({ key: "seo_connection", value })
    .onConflictDoUpdate({
      target: systemSettingsTable.key,
      set: { value, updatedAt: sql`now()` },
    });
}

// Date helpers for delta calculation.
function pct(curr: number, prev: number): number {
  if (!prev) return 0;
  return +(((curr - prev) / prev) * 100).toFixed(1);
}

// Build the dashboard payload, preferring real GSC/GA4 data when the
// SuperAdmin has saved working credentials. Any missing / failed real
// fetch falls back to the mock generator so the UI never breaks.
async function buildSeoPayloadHybrid(): Promise<SeoDashboardPayload> {
  const mock = buildSeoPayload();
  const conn = await loadConnectionRow();
  const sa = parseServiceAccount(conn.serviceAccountJson);

  const useGsc = conn.searchConsole && sa && conn.searchConsoleSiteUrl;
  const useGa4 = conn.analytics && sa && conn.analyticsPropertyId;

  if (!useGsc && !useGa4) {
    return { ...mock, connected: { analytics: false, searchConsole: false } };
  }

  const [
    gscNow, gscPrev, gscKw, gscLine,
    ga4Now, ga4Prev, ga4Sources, ga4Pages, ga4Daily,
  ] = await Promise.all([
    useGsc ? fetchGscTotals(sa!, conn.searchConsoleSiteUrl!, 28) : Promise.resolve(null),
    useGsc ? fetchGscTotals(sa!, conn.searchConsoleSiteUrl!, 56).then(prev28 => {
      // We pulled 56-day total; subtract current 28 to approximate prior 28
      // (rough but cheap — avoids a 3rd call). If prev<curr it just damps.
      return prev28 ? Promise.resolve(prev28) : null;
    }) : Promise.resolve(null),
    useGsc ? fetchGscKeywords(sa!, conn.searchConsoleSiteUrl!, 28) : Promise.resolve(null),
    useGsc ? fetchGscTimeline(sa!, conn.searchConsoleSiteUrl!, 30) : Promise.resolve(null),
    useGa4 ? fetchGa4Totals(sa!, conn.analyticsPropertyId!, 28) : Promise.resolve(null),
    useGa4 ? fetchGa4Totals(sa!, conn.analyticsPropertyId!, 56) : Promise.resolve(null),
    useGa4 ? fetchGa4TrafficSources(sa!, conn.analyticsPropertyId!, 28) : Promise.resolve(null),
    useGa4 ? fetchGa4TopPages(sa!, conn.analyticsPropertyId!, 28) : Promise.resolve(null),
    useGa4 ? fetchGa4DailyVisitors(sa!, conn.analyticsPropertyId!, 30) : Promise.resolve(null),
  ]);

  // ─── Totals ────────────────────────────────────────────────────────────
  const visitors    = ga4Now?.totalUsers   ?? mock.totals.visitors;
  const clicks      = gscNow?.clicks       ?? mock.totals.clicks;
  const impressions = gscNow?.impressions  ?? mock.totals.impressions;
  const avgPos      = gscNow?.position     ?? mock.totals.averagePosition;
  const visibility  = gscNow ? +(gscNow.ctr * 100).toFixed(2) : mock.totals.visibilityScore;

  // Period-over-period — use the 56-day sample as a rough prior baseline.
  const visitorsPrev    = ga4Prev?.totalUsers   ? Math.max(0, ga4Prev.totalUsers   - (ga4Now?.totalUsers ?? 0)) : 0;
  const clicksPrev      = gscPrev?.clicks       ? Math.max(0, gscPrev.clicks      - clicks) : 0;
  const impressionsPrev = gscPrev?.impressions  ? Math.max(0, gscPrev.impressions - impressions) : 0;
  const visitorsDeltaPct    = ga4Now && ga4Prev ? pct(visitors, visitorsPrev) : mock.totals.visitorsDeltaPct;
  const clicksDeltaPct      = gscNow && gscPrev ? pct(clicks, clicksPrev) : mock.totals.clicksDeltaPct;
  const impressionsDeltaPct = gscNow && gscPrev ? pct(impressions, impressionsPrev) : mock.totals.impressionsDeltaPct;
  const positionDelta       = mock.totals.positionDelta; // GSC doesn't expose prior easily; keep mock heuristic

  // ─── Keywords ──────────────────────────────────────────────────────────
  const keywords = gscKw && gscKw.length > 0
    ? gscKw.map((k) => ({
        keyword: k.keyword,
        page: k.page,
        impressions: Math.round(k.impressions),
        clicks: Math.round(k.clicks),
        position: +k.position.toFixed(1),
      }))
    : mock.keywords;

  // ─── Top pages ─────────────────────────────────────────────────────────
  const topPages = ga4Pages && ga4Pages.length > 0
    ? ga4Pages.map((p) => ({
        url: p.url, title: p.title || p.url,
        visits: p.visits,
        avgSessionSeconds: p.avgSessionSeconds,
        position: 0, // GA4 doesn't expose ranking position per page
      }))
    : mock.topPages;

  // ─── Traffic sources ───────────────────────────────────────────────────
  let trafficSources = mock.trafficSources;
  if (ga4Sources) {
    const total = ga4Sources.reduce((a, b) => a + b.sessions, 0) || 1;
    trafficSources = ga4Sources.map((s) => ({
      source: s.source,
      sessions: s.sessions,
      pct: +((s.sessions / total) * 100).toFixed(1),
    }));
  }

  // ─── Daily timeline ────────────────────────────────────────────────────
  let daily = mock.timeline.daily;
  if (gscLine || ga4Daily) {
    const byDay: Record<string, { visitors: number; clicks: number; impressions: number }> = {};
    for (const p of mock.timeline.daily) byDay[p.day] = { ...p };
    for (const p of (gscLine ?? [])) {
      const k = p.day;
      byDay[k] = byDay[k] ?? { visitors: 0, clicks: 0, impressions: 0, day: k } as any;
      byDay[k].clicks = p.clicks;
      byDay[k].impressions = p.impressions;
    }
    for (const p of (ga4Daily ?? [])) {
      // GA4 returns date as YYYYMMDD; normalise to YYYY-MM-DD
      const k = p.day.length === 8
        ? `${p.day.slice(0,4)}-${p.day.slice(4,6)}-${p.day.slice(6,8)}`
        : p.day;
      byDay[k] = byDay[k] ?? { visitors: 0, clicks: 0, impressions: 0, day: k } as any;
      byDay[k].visitors = p.visitors;
    }
    daily = Object.entries(byDay)
      .map(([day, v]) => ({ day, ...v }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  return {
    ...mock,
    connected: { analytics: !!useGa4, searchConsole: !!useGsc },
    totals: {
      visitors, clicks, impressions,
      averagePosition: +avgPos.toFixed(2),
      visibilityScore: +visibility.toFixed(2),
      visitorsDeltaPct, clicksDeltaPct, impressionsDeltaPct, positionDelta,
    },
    timeline: { ...mock.timeline, daily },
    keywords, topPages, trafficSources,
  };
}

// ─── Endpoints ───────────────────────────────────────────────────────────

// GET /api/admin/seo/dashboard — full SEO dashboard payload.
router.get("/dashboard", requireSuperAdmin, async (_req, res) => {
  try {
    res.json(await buildSeoPayloadHybrid());
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تعذّر تحميل بيانات SEO" });
  }
});

// POST /api/admin/seo/refresh — explicit "refresh now" hook. With the mock
// generator the output is day-stable so this is a no-op that just returns
// the current payload, matching the UX of the spec's "Refresh Now" button.
router.post("/refresh", requireSuperAdmin, async (_req, res) => {
  try {
    res.json(await buildSeoPayloadHybrid());
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تعذّر تحديث البيانات" });
  }
});

// ─── AI Studio ───────────────────────────────────────────────────────────
// Default settings used when no row exists in system_settings yet. These
// describe how the AI generator should write articles aimed at boosting
// the site's organic traffic.
const DEFAULT_AI_SETTINGS = {
  model:         "claude-sonnet-4-6",
  tone:          "professional",   // professional|friendly|marketing|educational
  length:        "medium",         // short(~500) | medium(~1000) | long(~1800)
  language:      "ar",             // ar | en | both
  defaultKeywords: ["فاتورة إلكترونية", "ZATCA", "محاسبة سعودية", "ضريبة القيمة المضافة"],
  // Free-form publishing notes the SuperAdmin wants the AI to honor (brand
  // voice, target audience, internal linking conventions, etc.).
  guidance:      "اكتب مقالاً تسويقياً موجهاً للشركات السعودية الصغيرة والمتوسطة، مع التركيز على الالتزام بمتطلبات هيئة الزكاة والضريبة والجمارك.",
} as const;

type SeoAiSettings = typeof DEFAULT_AI_SETTINGS & { defaultKeywords: string[]; guidance: string };

async function readAiSettings(): Promise<SeoAiSettings> {
  const [row] = await db.select().from(systemSettingsTable)
    .where(eq(systemSettingsTable.key, "seo_ai_settings"));
  if (!row?.value) return { ...DEFAULT_AI_SETTINGS };
  try {
    const parsed = JSON.parse(row.value);
    return {
      ...DEFAULT_AI_SETTINGS,
      ...parsed,
      defaultKeywords: Array.isArray(parsed?.defaultKeywords)
        ? parsed.defaultKeywords.filter((s: any) => typeof s === "string")
        : [...DEFAULT_AI_SETTINGS.defaultKeywords],
    };
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

// GET /api/admin/seo/ai-settings — current generator config.
router.get("/ai-settings", requireSuperAdmin, async (_req, res) => {
  try {
    const settings = await readAiSettings();
    res.json(settings);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تعذّر قراءة الإعدادات" });
  }
});

// PUT /api/admin/seo/ai-settings — save generator config.
router.put("/ai-settings", requireSuperAdmin, async (req, res) => {
  try {
    const body = req.body ?? {};
    const next: SeoAiSettings = {
      model:    typeof body.model === "string" ? body.model : DEFAULT_AI_SETTINGS.model,
      tone:     typeof body.tone === "string" ? body.tone : DEFAULT_AI_SETTINGS.tone,
      length:   typeof body.length === "string" ? body.length : DEFAULT_AI_SETTINGS.length,
      language: typeof body.language === "string" ? body.language : DEFAULT_AI_SETTINGS.language,
      defaultKeywords: Array.isArray(body.defaultKeywords)
        ? body.defaultKeywords.filter((s: any) => typeof s === "string" && s.trim()).map((s: string) => s.trim())
        : [...DEFAULT_AI_SETTINGS.defaultKeywords],
      guidance: typeof body.guidance === "string" ? body.guidance : DEFAULT_AI_SETTINGS.guidance,
    };
    const value = JSON.stringify(next);
    await db
      .insert(systemSettingsTable)
      .values({ key: "seo_ai_settings", value })
      .onConflictDoUpdate({
        target: systemSettingsTable.key,
        set:    { value, updatedAt: new Date() },
      });
    res.json(next);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تعذّر حفظ الإعدادات" });
  }
});

// GET /api/admin/seo/ai-articles — list generated articles, newest first.
router.get("/ai-articles", requireSuperAdmin, async (_req, res) => {
  try {
    const rows = await db.select().from(seoGeneratedArticlesTable)
      .orderBy(desc(seoGeneratedArticlesTable.createdAt))
      .limit(200);
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تعذّر تحميل المقالات" });
  }
});

// Word target by length preset — used in the AI prompt and for the generator
// preview card. These are loose targets; we ask the model to produce a long-
// form Arabic article and trust it to land near the target.
// Allowed values for the article's targetCountries field. Mirrors the
// SPA's countries.ts catalog so the SuperAdmin UI and the API stay in
// lock-step. "GLOBAL" is the catch-all fallback and is mutually
// exclusive with specific country codes.
const ALLOWED_TARGET_COUNTRIES = new Set<string>([
  "SA", "AE", "KW", "QA", "BH", "OM", "EG", "GLOBAL",
]);

const LENGTH_TARGETS: Record<string, number> = { short: 500, medium: 1000, long: 1800 };
const TONE_LABEL_AR: Record<string, string> = {
  professional: "احترافي",
  friendly:     "ودي وقريب",
  marketing:    "تسويقي مقنع",
  educational:  "تعليمي تثقيفي",
};

function slugify(input: string): string {
  // Keep Arabic letters AND latin/digits; collapse runs of separators to "-".
  // Browsers and most CMSes handle Arabic slugs fine via percent-encoding.
  return input
    .trim()
    .replace(/[\s\u00A0]+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || `article-${Date.now()}`;
}

// Returns a slug guaranteed not to collide with any existing row in
// seo_generated_articles. Tries the base slug first, then appends -2, -3 …
// until it finds a free one. Without a DB UNIQUE constraint this isn't
// race-proof, but for a single SuperAdmin operator it's effectively safe
// and cheaper than a migration.
async function uniqueArticleSlug(base: string): Promise<string> {
  let candidate = base;
  for (let n = 2; n < 1000; n++) {
    const [hit] = await db.select({ id: seoGeneratedArticlesTable.id })
      .from(seoGeneratedArticlesTable)
      .where(eq(seoGeneratedArticlesTable.slug, candidate))
      .limit(1);
    if (!hit) return candidate;
    candidate = `${base}-${n}`.slice(0, 90);
  }
  // Astronomically unlikely; fall back to a timestamp suffix.
  return `${base}-${Date.now()}`.slice(0, 90);
}

// Per-user in-memory rate limiter for the AI generator. The endpoint is
// expensive (network + tokens), and even though it's SuperAdmin-only, an
// open browser tab or runaway script could rack up cost quickly.
//   - cooldown: 20s between consecutive calls per user
//   - burst window: max 8 calls in any rolling 10-minute window per user
const GEN_COOLDOWN_MS    = 20_000;
const GEN_WINDOW_MS      = 10 * 60_000;
const GEN_WINDOW_MAX     = 8;
const genHistory = new Map<number, number[]>();    // userId → timestamps (ms)
function checkGenRateLimit(userId: number): { ok: true } | { ok: false; retryInSec: number; reason: string } {
  const now = Date.now();
  const arr = (genHistory.get(userId) ?? []).filter(t => now - t < GEN_WINDOW_MS);
  if (arr.length > 0 && now - arr[arr.length - 1] < GEN_COOLDOWN_MS) {
    return { ok: false, retryInSec: Math.ceil((GEN_COOLDOWN_MS - (now - arr[arr.length - 1])) / 1000),
             reason: "الرجاء الانتظار قبل توليد مقال آخر" };
  }
  if (arr.length >= GEN_WINDOW_MAX) {
    const retry = Math.ceil((GEN_WINDOW_MS - (now - arr[0])) / 1000);
    return { ok: false, retryInSec: retry,
             reason: `تم تجاوز الحد المسموح (${GEN_WINDOW_MAX} مقالات كل 10 دقائق)` };
  }
  arr.push(now);
  genHistory.set(userId, arr);
  return { ok: true };
}

// Per-user in-memory rate limiter for the LIGHTWEIGHT suggestion endpoint.
// Suggestions are short (≤6 lines, no article body) so we allow more bursts
// than the article generator: 4s cooldown, max 30 calls in any rolling
// 10-minute window per user. Same callerKey scheme as the generator so an
// unauthenticated edge case (no req.user) still maps to a stable bucket.
const SUG_COOLDOWN_MS  = 4_000;
const SUG_WINDOW_MS    = 10 * 60_000;
const SUG_WINDOW_MAX   = 30;
const sugHistory = new Map<number, number[]>();    // userId → timestamps (ms)
function checkSuggestRateLimit(userId: number): { ok: true } | { ok: false; retryInSec: number; reason: string } {
  const now = Date.now();
  const arr = (sugHistory.get(userId) ?? []).filter(t => now - t < SUG_WINDOW_MS);
  if (arr.length > 0 && now - arr[arr.length - 1] < SUG_COOLDOWN_MS) {
    return { ok: false, retryInSec: Math.ceil((SUG_COOLDOWN_MS - (now - arr[arr.length - 1])) / 1000),
             reason: "الرجاء الانتظار قليلاً قبل توليد اقتراحات جديدة" };
  }
  if (arr.length >= SUG_WINDOW_MAX) {
    const retry = Math.ceil((SUG_WINDOW_MS - (now - arr[0])) / 1000);
    return { ok: false, retryInSec: retry,
             reason: `تم تجاوز الحد المسموح (${SUG_WINDOW_MAX} طلبات اقتراحات كل 10 دقائق)` };
  }
  arr.push(now);
  sugHistory.set(userId, arr);
  return { ok: true };
}

// POST /api/admin/seo/ai-suggestions
//   body: { keyword?: string, targetCountries?: string[] }
// Returns a fresh batch of short Arabic SEO topic ideas for the "اقتراحات
// سريعة" chips on the generation form. Cheaper than /generate (no article
// body) so it has its own looser rate limiter.
router.post("/ai-suggestions", requireSuperAdmin, async (req: any, res): Promise<void> => {
  try {
    const keywordRaw = String(req.body?.keyword ?? "").trim().slice(0, 120);
    const rawCountries = Array.isArray(req.body?.targetCountries)
      ? (req.body.targetCountries as unknown[])
          .map(c => String(c).trim().toUpperCase())
          .filter(c => ALLOWED_TARGET_COUNTRIES.has(c))
      : [];
    const targetCountriesArr = rawCountries.length ? Array.from(new Set(rawCountries)) : ["GLOBAL"];
    // Mirror /ai-articles/generate: GLOBAL is mutually exclusive with
    // specific country codes (it's the catch-all sentinel). Mixing them
    // produces ambiguous prompts, so reject the payload outright.
    if (targetCountriesArr.includes("GLOBAL") && targetCountriesArr.length > 1) {
      res.status(400).json({ error: "لا يمكن دمج GLOBAL مع دول محدّدة" });
      return;
    }

    if (!process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL || !process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
      res.status(503).json({ error: "خدمة الذكاء الاصطناعي غير مهيأة على الخادم" });
      return;
    }

    const callerKey: number = (req as any).user?.id
      ?? -Math.abs(((req.ip || "anon").split("").reduce((h: number, c: string) => (h * 31 + c.charCodeAt(0)) | 0, 0)));
    const rl = checkSuggestRateLimit(callerKey);
    if (!rl.ok) {
      res.setHeader("Retry-After", String(rl.retryInSec));
      res.status(429).json({ error: rl.reason, retryInSec: rl.retryInSec });
      return;
    }

    const settings = await readAiSettings();
    const COUNTRY_AR_LABEL: Record<string, string> = {
      SA: "السعودية", AE: "الإمارات", KW: "الكويت", QA: "قطر",
      BH: "البحرين", OM: "عُمان", EG: "مصر", GLOBAL: "كل الدول (محتوى عام)",
    };
    const countryLabels = targetCountriesArr.map(c => COUNTRY_AR_LABEL[c] ?? c).join("، ");

    const prompt = [
      `أنت خبير محتوى SEO لموقع برنامج محاسبة وفوترة إلكترونية يستهدف الشركات في الخليج العربي.`,
      ``,
      `سياق الموقع:`,
      `- الكلمات المفتاحية الافتراضية: ${settings.defaultKeywords.join("، ")}`,
      `- توجيهات الإدارة: ${settings.guidance}`,
      `- الدول المستهدفة الآن: ${countryLabels}`,
      keywordRaw ? `- الكلمة المفتاحية التي يفكر فيها المستخدم حالياً: ${keywordRaw}` : ``,
      ``,
      `اقترح 6 عناوين مقالات قصيرة وجذابة (كل عنوان من 6 إلى 12 كلمة بحد أقصى) قابلة للنقر تستخدم لرفع الترافيك العضوي. تجنّب التكرار، وراعِ تنوّع الزوايا (دليل / مقارنة / قائمة / كيف / أخطاء شائعة / 2026).`,
      ``,
      `أعد الناتج كـ JSON صالح فقط ضمن كتلة \`\`\`json … \`\`\` بهذا الشكل تماماً:`,
      `{ "suggestions": ["عنوان 1", "عنوان 2", "عنوان 3", "عنوان 4", "عنوان 5", "عنوان 6"] }`,
      ``,
      `لا تكتب أي شيء خارج كتلة JSON.`,
    ].filter(Boolean).join("\n");

    const aiRes = await aiChat(
      [{ role: "user", content: prompt }],
      { maxTokens: 1024 },
    );
    if (!aiRes.ok) {
      res.status(503).json({ error: "تعذّر الاتصال بخدمة الذكاء الاصطناعي. حاول لاحقاً." });
      return;
    }
    const rawText = (aiRes.text ?? "").trim();

    let parsed: any = null;
    const fenced = rawText.match(/```json\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : (rawText.match(/\{[\s\S]*\}/)?.[0] ?? "");
    try { parsed = JSON.parse(candidate); } catch {/* fallthrough */}

    const list = Array.isArray(parsed?.suggestions) ? parsed.suggestions : null;
    if (!list || list.length === 0) {
      res.status(502).json({ error: "تعذّر تحليل اقتراحات الذكاء الاصطناعي. حاول مرة أخرى." });
      return;
    }

    // Normalize: trim, drop empties/duplicates, cap length, return up to 8.
    const seen = new Set<string>();
    const suggestions: string[] = [];
    for (const item of list) {
      const s = String(item ?? "").trim().replace(/^[-*•]\s*/, "").slice(0, 140);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      suggestions.push(s);
      if (suggestions.length >= 8) break;
    }
    if (suggestions.length === 0) {
      res.status(502).json({ error: "تعذّر تحليل اقتراحات الذكاء الاصطناعي. حاول مرة أخرى." });
      return;
    }

    res.json({ suggestions });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تعذّر توليد الاقتراحات" });
  }
});

// POST /api/admin/seo/ai-articles/generate
//   body: { topic: string, targetKeyword?: string, sourceTopic?: string }
// Calls Anthropic with the saved settings, parses a JSON envelope from the
// model, persists the draft, and returns it.
router.post("/ai-articles/generate", requireSuperAdmin, async (req: any, res) => {
  try {
    const topicRaw = String(req.body?.topic ?? "").trim();
    const targetKeywordRaw = String(req.body?.targetKeyword ?? "").trim();
    const sourceTopic = String(req.body?.sourceTopic ?? topicRaw).trim();
    // Optional: list of ISO country codes (e.g. ["SA","AE"]) or ["GLOBAL"].
    // The SuperAdmin picks these in the SEO Studio UI; default to GLOBAL so
    // existing call sites keep working unchanged. Server-side enforcement
    // mirrors the client's allowlist (SA/AE/KW/QA/BH/OM/EG + GLOBAL) and
    // refuses payloads that mix GLOBAL with specific codes — the two are
    // mutually exclusive by design (GLOBAL is the catch-all fallback).
    const rawCountries = Array.isArray(req.body?.targetCountries)
      ? (req.body.targetCountries as unknown[])
          .map(c => String(c).trim().toUpperCase())
          .filter(c => ALLOWED_TARGET_COUNTRIES.has(c))
      : [];
    const targetCountriesArr = rawCountries.length ? Array.from(new Set(rawCountries)) : ["GLOBAL"];
    if (targetCountriesArr.includes("GLOBAL") && targetCountriesArr.length > 1) {
      return res.status(400).json({ error: "لا يمكن دمج GLOBAL مع دول محدّدة" });
    }
    const targetCountries = targetCountriesArr.join(",");
    if (!topicRaw || topicRaw.length < 4) {
      return res.status(400).json({ error: "الرجاء إدخال موضوع لا يقل عن 4 أحرف" });
    }
    if (!process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL || !process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: "خدمة الذكاء الاصطناعي غير مهيأة على الخادم" });
    }

    // Per-user generator rate limit (cost guard). Falls back to remote IP
    // when no user is attached so the limit is never silently bypassed.
    const callerKey: number = (req as any).user?.id
      ?? -Math.abs(((req.ip || "anon").split("").reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)));
    const rl = checkGenRateLimit(callerKey);
    if (!rl.ok) {
      res.setHeader("Retry-After", String(rl.retryInSec));
      return res.status(429).json({ error: rl.reason, retryInSec: rl.retryInSec });
    }

    const settings = await readAiSettings();
    const targetWords = LENGTH_TARGETS[settings.length] ?? 1000;
    const toneLabel = TONE_LABEL_AR[settings.tone] ?? "احترافي";
    const langInstruction =
      settings.language === "en"   ? "Write the article in English."
      : settings.language === "both" ? "اكتب المقال بالعربية مع عناوين فرعية بالإنجليزية بين قوسين عند الحاجة."
      : "اكتب المقال بالعربية الفصحى المبسّطة.";

    // Map ISO codes back to display labels in the prompt so the model
    // tailors examples (currency, regulator names, market context) per
    // country. Kept inline rather than imported from the SPA's countries.ts
    // to keep the API package independent of any one artifact.
    const COUNTRY_AR_LABEL: Record<string, string> = {
      SA: "السعودية", AE: "الإمارات", KW: "الكويت", QA: "قطر",
      BH: "البحرين", OM: "عُمان", EG: "مصر", GLOBAL: "كل الدول (محتوى عام)",
    };
    const countryLabels = targetCountriesArr.map(c => COUNTRY_AR_LABEL[c] ?? c).join("، ");
    const countryGuidance = targetCountriesArr.includes("GLOBAL")
      ? "الجمهور المستهدف عام (أكثر من دولة) — تجنّب التفاصيل المحلية المخصّصة لدولة واحدة فقط."
      : `الجمهور المستهدف من: ${countryLabels}. اذكر الجهات التنظيمية والعملة والمتطلبات الخاصة بهذه الدولة/الدول حصراً.`;

    const prompt = [
      `أنت كاتب محتوى محترف لتحسين محركات البحث (SEO) لموقع برنامج محاسبة وفوترة إلكترونية.`,
      ``,
      `إعدادات التوليد:`,
      `- النبرة: ${toneLabel}`,
      `- الطول المستهدف: حوالي ${targetWords} كلمة`,
      `- اللغة: ${langInstruction}`,
      `- الكلمات المفتاحية الافتراضية للموقع: ${settings.defaultKeywords.join("، ")}`,
      `- توجيهات الإدارة: ${settings.guidance}`,
      `- الدول المستهدفة: ${countryLabels}`,
      `- ${countryGuidance}`,
      ``,
      `الموضوع المطلوب: ${topicRaw}`,
      targetKeywordRaw ? `الكلمة المفتاحية الرئيسية المستهدفة: ${targetKeywordRaw}` : ``,
      ``,
      `أعد الناتج كـ JSON صالح ضمن كتلة \`\`\`json … \`\`\` بهذا الشكل تماماً:`,
      `{`,
      `  "title": "عنوان جذاب يحوي الكلمة المفتاحية، أقل من 60 حرفاً",`,
      `  "metaDescription": "وصف ميتا تسويقي بين 140 و160 حرفاً",`,
      `  "targetKeyword": "الكلمة أو العبارة المفتاحية الرئيسية",`,
      `  "slug": "slug-عربي-أو-لاتيني-قصير",`,
      `  "content": "نص المقال بصيغة Markdown يبدأ بمقدمة قوية، يتضمن عناوين فرعية ## و###، نقاط، وفقرة خاتمة. تجنّب الحشو."`,
      `}`,
      ``,
      `لا تكتب أي شيء خارج كتلة JSON.`,
    ].filter(Boolean).join("\n");

    const aiRes = await aiChat(
      [{ role: "user", content: prompt }],
      { maxTokens: 8192 },
    );
    if (!aiRes.ok) {
      return res.status(503).json({ error: "تعذّر الاتصال بخدمة الذكاء الاصطناعي. حاول لاحقاً." });
    }
    const rawText = (aiRes.text ?? "").trim();

    // Extract the fenced JSON block; fall back to the largest {…} substring.
    let parsed: any = null;
    const fenced = rawText.match(/```json\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : (rawText.match(/\{[\s\S]*\}/)?.[0] ?? "");
    try { parsed = JSON.parse(candidate); } catch {/* fallthrough */}
    if (!parsed || typeof parsed !== "object" || !parsed.title || !parsed.content) {
      return res.status(502).json({ error: "تعذّر تحليل ناتج الذكاء الاصطناعي. حاول مرة أخرى." });
    }

    const title = String(parsed.title).trim();
    const slug  = await uniqueArticleSlug(slugify(String(parsed.slug || title)));
    const metaDescription = String(parsed.metaDescription ?? "").trim();
    const targetKeyword   = String(parsed.targetKeyword ?? targetKeywordRaw ?? "").trim();
    const content         = String(parsed.content).trim();

    const [row] = await db.insert(seoGeneratedArticlesTable).values({
      title, slug, metaDescription, content, targetKeyword,
      sourceTopic,
      aiModel:         settings.model || "claude-sonnet-4-6",
      status:          "draft",
      targetCountries,
      createdByUserId: req.user?.id ?? null,
    }).returning();

    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تعذّر توليد المقال" });
  }
});

// PATCH /api/admin/seo/ai-articles/:id — update editable fields/status.
router.patch("/ai-articles/:id", requireSuperAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "معرّف غير صالح" });
    const patch: any = { updatedAt: new Date() };
    if (typeof req.body?.title === "string")           patch.title = req.body.title.trim();
    if (typeof req.body?.metaDescription === "string") patch.metaDescription = req.body.metaDescription.trim();
    if (typeof req.body?.content === "string")         patch.content = req.body.content;
    if (typeof req.body?.targetKeyword === "string")   patch.targetKeyword = req.body.targetKeyword.trim();
    if (typeof req.body?.status === "string"
      && ["draft","reviewed","published"].includes(req.body.status)) patch.status = req.body.status;
    if (typeof req.body?.slug === "string")            patch.slug = slugify(req.body.slug);
    // Accept targetCountries as either an array (canonical) or a CSV
    // string. Validate, dedupe, then store as CSV. An empty input is
    // collapsed to "GLOBAL" so the row is still discoverable somewhere.
    if (Array.isArray(req.body?.targetCountries) || typeof req.body?.targetCountries === "string") {
      const raw = Array.isArray(req.body.targetCountries)
        ? req.body.targetCountries
        : String(req.body.targetCountries).split(",");
      const clean = raw
        .map((c: any) => String(c).trim().toUpperCase())
        .filter((c: string) => ALLOWED_TARGET_COUNTRIES.has(c));
      const deduped = Array.from(new Set(clean));
      if (deduped.includes("GLOBAL") && deduped.length > 1) {
        return res.status(400).json({ error: "لا يمكن دمج GLOBAL مع دول محدّدة" });
      }
      patch.targetCountries = (deduped.length ? deduped : ["GLOBAL"]).join(",");
    }
    const [row] = await db.update(seoGeneratedArticlesTable)
      .set(patch).where(eq(seoGeneratedArticlesTable.id, id)).returning();
    if (!row) return res.status(404).json({ error: "المقال غير موجود" });

    // If this transition published the article (status changed TO
    // "published"), fire-and-forget an IndexNow ping so Bing/Yandex/
    // Yahoo/Naver/Seznam crawl the new URL within minutes instead of
    // waiting for their next scheduled pass. Google ignores IndexNow,
    // but its sitemap.xml is dynamic and lists this slug immediately.
    if (patch.status === "published") {
      const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim()
        || req.protocol || "https";
      const host  = (req.headers["x-forwarded-host"] as string)?.split(",")[0]?.trim()
        || req.get("host") || "";
      if (host) {
        const origin = `${proto}://${host}`;
        // Don't await — IndexNow has its own 5s timeout and we don't want
        // the admin's PATCH response to wait on it.
        pingArticleUrls(origin, [row.slug]).catch(() => { /* logged inside */ });
      }
    }

    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تعذّر تحديث المقال" });
  }
});

// DELETE /api/admin/seo/ai-articles/:id
router.delete("/ai-articles/:id", requireSuperAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "معرّف غير صالح" });
    await db.delete(seoGeneratedArticlesTable).where(eq(seoGeneratedArticlesTable.id, id));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تعذّر حذف المقال" });
  }
});

// GET /api/admin/seo/connection — read which Google integrations are set up.
// Returns connection metadata + a derived `serviceAccountEmail` (read from the
// stored JSON) so the UI can display which service account the admin must
// invite into GA4 and Search Console. Never returns the private key blob.
router.get("/connection", requireSuperAdmin, async (_req, res) => {
  try {
    const conn = await loadConnectionRow();
    const sa = parseServiceAccount(conn.serviceAccountJson);
    res.json({
      analytics:     !!conn.analytics,
      searchConsole: !!conn.searchConsole,
      analyticsPropertyId: conn.analyticsPropertyId,
      searchConsoleSiteUrl: conn.searchConsoleSiteUrl,
      serviceAccountSet: !!sa,
      serviceAccountEmail: sa?.client_email ?? null,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تعذّر قراءة حالة الربط" });
  }
});

// PUT /api/admin/seo/connection — save Google connection settings.
// Body: {
//   analyticsPropertyId?: string|null,
//   searchConsoleSiteUrl?: string|null,
//   serviceAccountJson?: string|null,   // pass an empty string to clear; omit to keep current
//   analytics?: boolean,                  // enable/disable use of GA in dashboard
//   searchConsole?: boolean,
// }
router.put("/connection", requireSuperAdmin, async (req, res) => {
  try {
    const current = await loadConnectionRow();
    const body = req.body ?? {};

    const next: ConnectionRow = {
      analytics:     typeof body.analytics === "boolean" ? body.analytics : current.analytics,
      searchConsole: typeof body.searchConsole === "boolean" ? body.searchConsole : current.searchConsole,
      analyticsPropertyId:  "analyticsPropertyId" in body
        ? (body.analyticsPropertyId === null || body.analyticsPropertyId === "" ? null : String(body.analyticsPropertyId).trim())
        : current.analyticsPropertyId,
      searchConsoleSiteUrl: "searchConsoleSiteUrl" in body
        ? (body.searchConsoleSiteUrl === null || body.searchConsoleSiteUrl === "" ? null : String(body.searchConsoleSiteUrl).trim())
        : current.searchConsoleSiteUrl,
      serviceAccountJson:   "serviceAccountJson" in body
        ? (body.serviceAccountJson === null || body.serviceAccountJson === "" ? null : String(body.serviceAccountJson))
        : current.serviceAccountJson,
    };

    // If service account JSON is being set, validate its shape early so we
    // surface a useful error instead of failing later at API call time.
    if (next.serviceAccountJson) {
      const parsed = parseServiceAccount(next.serviceAccountJson);
      if (!parsed) {
        return res.status(400).json({
          error: "ملف حساب الخدمة غير صالح — يجب أن يحتوي على client_email و private_key",
        });
      }
    }

    // If toggling a service ON, require its dependent fields.
    if (next.analytics) {
      if (!next.serviceAccountJson) return res.status(400).json({ error: "لتفعيل Google Analytics، الصق محتوى ملف حساب الخدمة (Service Account JSON) أولاً" });
      if (!next.analyticsPropertyId) return res.status(400).json({ error: "لتفعيل Google Analytics، أدخل معرّف الموقع (Property ID)" });
    }
    if (next.searchConsole) {
      if (!next.serviceAccountJson) return res.status(400).json({ error: "لتفعيل Search Console، الصق محتوى ملف حساب الخدمة (Service Account JSON) أولاً" });
      if (!next.searchConsoleSiteUrl) return res.status(400).json({ error: "لتفعيل Search Console، أدخل رابط الموقع (Site URL)" });
    }

    await saveConnectionRow(next);

    const sa = parseServiceAccount(next.serviceAccountJson);
    return res.json({
      analytics:     next.analytics,
      searchConsole: next.searchConsole,
      analyticsPropertyId:  next.analyticsPropertyId,
      searchConsoleSiteUrl: next.searchConsoleSiteUrl,
      serviceAccountSet:    !!sa,
      serviceAccountEmail:  sa?.client_email ?? null,
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "تعذّر حفظ الإعدادات" });
  }
});

// POST /api/admin/seo/connection/test — verify creds against Google APIs.
// Body may override fields (handy for "test before save"); if a field is
// omitted we use the currently-saved value. Returns per-service results.
router.post("/connection/test", requireSuperAdmin, async (req, res) => {
  try {
    const current = await loadConnectionRow();
    const body = req.body ?? {};

    const propertyId = "analyticsPropertyId" in body
      ? (body.analyticsPropertyId == null ? null : String(body.analyticsPropertyId).trim())
      : current.analyticsPropertyId;
    const siteUrl = "searchConsoleSiteUrl" in body
      ? (body.searchConsoleSiteUrl == null ? null : String(body.searchConsoleSiteUrl).trim())
      : current.searchConsoleSiteUrl;
    const saJson = "serviceAccountJson" in body && body.serviceAccountJson
      ? String(body.serviceAccountJson)
      : current.serviceAccountJson;

    const sa = parseServiceAccount(saJson);
    if (!sa) {
      return res.status(400).json({
        error: "ملف حساب الخدمة غير موجود أو غير صالح. الصق محتوى ملف JSON من Google Cloud Console.",
      });
    }

    const out: {
      analytics: { tested: boolean; ok: boolean; error?: string };
      searchConsole: { tested: boolean; ok: boolean; error?: string };
      serviceAccountEmail: string;
    } = {
      analytics: { tested: false, ok: false },
      searchConsole: { tested: false, ok: false },
      serviceAccountEmail: sa.client_email,
    };

    const tasks: Promise<void>[] = [];
    if (propertyId) {
      tasks.push((async () => {
        const r = await testGa4(sa, propertyId);
        out.analytics = { tested: true, ok: r.ok, error: r.error };
      })());
    }
    if (siteUrl) {
      tasks.push((async () => {
        const r = await testGsc(sa, siteUrl);
        out.searchConsole = { tested: true, ok: r.ok, error: r.error };
      })());
    }
    await Promise.all(tasks);

    if (!propertyId && !siteUrl) {
      return res.status(400).json({
        error: "أدخل على الأقل معرّف Google Analytics أو رابط Search Console للاختبار",
      });
    }

    return res.json(out);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "تعذّر اختبار الاتصال" });
  }
});

// ─── Site-fetch helpers for AI suggestion ───────────────────────────────
// When the admin pastes their website URL, we can usually scrape the
// homepage HTML for `gtag('config', 'G-XXXXXXXXXX')` to give the AI
// concrete signals about which Analytics property is in use. The
// network call is wrapped in SSRF guards because the endpoint is
// behind requireSuperAdmin but we still don't want a typo to let the
// API server hit private addresses.

const SITE_FETCH_TIMEOUT_MS = 5_000;
const SITE_FETCH_MAX_BYTES = 500 * 1024; // half a megabyte of HTML is plenty
const SITE_FETCH_MAX_REDIRECTS = 3;
const SITE_FETCH_USER_AGENT = "ZatcaInvoiceBot/1.0 (+seo-suggest)";

function isPrivateOrLoopbackIp(ip: string): boolean {
  if (!ip) return true;
  const v = net.isIP(ip);
  if (v === 4) return isPrivateOrLoopbackIpv4(ip);
  if (v === 6) return isPrivateOrLoopbackIpv6(ip);
  return true; // not a valid IP literal
}

function isPrivateOrLoopbackIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0)   return true;                          // 0.0.0.0/8
  if (a === 10)  return true;                          // 10.0.0.0/8
  if (a === 127) return true;                          // loopback
  if (a === 169 && b === 254)                 return true; // link-local
  if (a === 172 && b >= 16 && b <= 31)        return true; // 172.16.0.0/12
  if (a === 192 && b === 168)                 return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127)       return true; // 100.64.0.0/10 (CGNAT)
  if (a === 198 && (b === 18 || b === 19))    return true; // 198.18.0.0/15 (benchmarking)
  if (a === 192 && b === 0)                   return true; // 192.0.0.0/24 (IETF)
  if (a >= 224)                               return true; // multicast / reserved
  return false;
}

/**
 * Expand an IPv6 literal into its 8 16-bit groups so we can reason
 * about IPv4-mapped addresses regardless of how the user wrote them
 * (e.g. ::ffff:127.0.0.1 vs ::ffff:7f00:1 are the same address).
 */
function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  // Strip a trailing dotted-IPv4 tail (`::ffff:127.0.0.1`) and turn
  // it into two hextets so the rest of the parser is uniform.
  const dotted = s.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted) {
    const [, head, v4] = dotted;
    const o = v4.split(".").map((n) => Number(n));
    if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    s = head + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const dblColonParts = s.split("::");
  if (dblColonParts.length > 2) return null;
  const left  = dblColonParts[0] ? dblColonParts[0].split(":") : [];
  const right = dblColonParts.length === 2 && dblColonParts[1] ? dblColonParts[1].split(":") : [];
  const fillerLen = 8 - (left.length + right.length);
  if (fillerLen < 0) return null;
  if (dblColonParts.length === 1 && (left.length + right.length) !== 8) return null;
  const groups = [
    ...left,
    ...new Array<string>(Math.max(0, fillerLen)).fill("0"),
    ...right,
  ];
  if (groups.length !== 8) return null;
  const nums: number[] = [];
  for (const g of groups) {
    if (g.length === 0 || g.length > 4) return null;
    if (!/^[0-9a-f]+$/.test(g)) return null;
    nums.push(parseInt(g, 16));
  }
  return nums;
}

function isPrivateOrLoopbackIpv6(ip: string): boolean {
  const g = expandIpv6(ip);
  if (!g) return true;
  // Unspecified ::, loopback ::1
  if (g.every((n, i) => i < 7 ? n === 0 : true) && (g[7] === 0 || g[7] === 1)) return true;
  // IPv4-mapped ::ffff:0:0/96 — reduce to the embedded v4 and re-check.
  // Catches both ::ffff:127.0.0.1 AND ::ffff:7f00:1 etc.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    const v4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
    return isPrivateOrLoopbackIpv4(v4);
  }
  // IPv4-compatible ::a.b.c.d (deprecated but still routes locally).
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0
      && (g[6] !== 0 || g[7] !== 0)) {
    const v4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
    return isPrivateOrLoopbackIpv4(v4);
  }
  // fc00::/7 — unique local
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  // fe80::/10 — link-local
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  // ff00::/8 — multicast
  if ((g[0] & 0xff00) === 0xff00) return true;
  // 64:ff9b::/96 — well-known NAT64 (could route to private v4)
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    const v4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
    return isPrivateOrLoopbackIpv4(v4);
  }
  // 2001:db8::/32 — documentation block, never a real host
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
  return false;
}

/**
 * Validate the URL AND, in one DNS step, pick the safe IP we will pin
 * for the actual TCP connect. Returns `null` if anything looks unsafe.
 * Combining validation + resolution removes the previous double-DNS
 * lookup so there is no second window for rebinding to slip in.
 */
async function urlSafeIp(target: URL): Promise<{ address: string; family: 4 | 6 } | null> {
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  if (!target.hostname) return null;
  // Block URL-credential injection like https://user:pass@evil.tld
  if (target.username || target.password) return null;

  const literal = net.isIP(target.hostname);
  if (literal) {
    if (isPrivateOrLoopbackIp(target.hostname)) return null;
    return { address: target.hostname, family: literal as 4 | 6 };
  }
  try {
    const addrs = await dns.lookup(target.hostname, { all: true });
    if (addrs.length === 0) return null;
    // ALL resolved addresses must be public — even one private IP in
    // the round-robin set means the host might be partially internal.
    if (addrs.some((a) => isPrivateOrLoopbackIp(a.address))) return null;
    const safe = addrs[0];
    return { address: safe.address, family: safe.family as 4 | 6 };
  } catch {
    return null;
  }
}

type SingleHopResult =
  | { kind: "redirect"; location: string }
  | { kind: "body"; html: string }
  | { kind: "abort" };

/**
 * Issue a single HTTP(S) request with DNS pinned to `safeIp` to defeat
 * DNS rebinding, with a hard end-to-end timeout (covers headers AND
 * body), and with a hard body-size cap. Returns either a redirect
 * location, the HTML body, or an abort signal on any failure.
 */
function singleSafeRequest(target: URL, safeIp: { address: string; family: 4 | 6 }): Promise<SingleHopResult> {
  return new Promise((resolve) => {
    const isHttps = target.protocol === "https:";
    const lib = isHttps ? https : http;
    const port = target.port
      ? Number(target.port)
      : (isHttps ? 443 : 80);

    let settled = false;
    const finish = (r: SingleHopResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    // End-to-end timer covers headers + body. We resolve as "abort"
    // and destroy the socket so nothing leaks.
    const overallTimer = setTimeout(() => {
      try { req.destroy(new Error("safe-fetch overall timeout")); } catch { /* ignore */ }
      finish({ kind: "abort" });
    }, SITE_FETCH_TIMEOUT_MS);

    const req = lib.request({
      hostname: target.hostname,
      port,
      path: (target.pathname || "/") + (target.search || ""),
      method: "GET",
      headers: {
        "Host":            target.host,
        "User-Agent":      SITE_FETCH_USER_AGENT,
        "Accept":          "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "Accept-Language": "ar,en;q=0.7",
        "Connection":      "close",
      },
      // CRITICAL: pin the IP we already vetted. The lookup callback
      // is invoked at TCP-connect time, so even if the attacker rebinds
      // the public DNS record between our SSRF check and the connect,
      // we still hit the safe IP we already approved.
      lookup: ((_h: string, _opts: any, cb: any) => {
        cb(null, safeIp.address, safeIp.family);
      }) as any,
      // For HTTPS we keep the original hostname for SNI / cert
      // validation — Node's https.request uses `hostname` for SNI by
      // default when `servername` is not given.
      ...(isHttps ? { servername: target.hostname } : {}),
    }, (res) => {
      const status = res.statusCode || 0;

      // Redirect — drain quickly and resolve with location so the
      // caller can re-validate the next hop.
      if ([301, 302, 303, 307, 308].includes(status)) {
        const loc = res.headers["location"];
        res.resume(); // discard body
        clearTimeout(overallTimer);
        if (typeof loc === "string" && loc.length > 0) {
          finish({ kind: "redirect", location: loc });
        } else {
          finish({ kind: "abort" });
        }
        return;
      }

      if (status < 200 || status >= 300) {
        res.resume();
        clearTimeout(overallTimer);
        finish({ kind: "abort" });
        return;
      }

      // Skip obvious binary content types. Missing header → assume HTML.
      const ct = String(res.headers["content-type"] ?? "").toLowerCase();
      if (ct && !ct.includes("text/") && !ct.includes("html") && !ct.includes("xml") && !ct.includes("javascript")) {
        res.resume();
        clearTimeout(overallTimer);
        finish({ kind: "abort" });
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > SITE_FETCH_MAX_BYTES) {
          // Stop reading and treat what we have as enough — typical
          // gtag/GTM signals appear in <head>, well within 500 KB.
          chunks.push(chunk);
          try { res.destroy(); } catch { /* ignore */ }
          clearTimeout(overallTimer);
          finish({ kind: "body", html: Buffer.concat(chunks).toString("utf8") });
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        clearTimeout(overallTimer);
        finish({ kind: "body", html: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", () => {
        clearTimeout(overallTimer);
        finish({ kind: "abort" });
      });
    });

    req.on("error", () => {
      clearTimeout(overallTimer);
      finish({ kind: "abort" });
    });
    // Belt-and-braces: socket inactivity timeout (in case the server
    // accepts the TCP connection but stalls).
    req.setTimeout(SITE_FETCH_TIMEOUT_MS, () => {
      try { req.destroy(new Error("safe-fetch socket timeout")); } catch { /* ignore */ }
      clearTimeout(overallTimer);
      finish({ kind: "abort" });
    });
    req.end();
  });
}

/**
 * Fetch a remote URL as HTML text with strict guardrails:
 *   - SSRF check resolves DNS, picks a public IP, and pins it at
 *     connect-time via Node's `lookup` callback (defeats rebinding).
 *   - End-to-end timeout covers BOTH headers and body streaming.
 *   - Body size capped at SITE_FETCH_MAX_BYTES.
 *   - Manual redirect handling re-validates each hop.
 * Returns `null` on any failure so the suggest route can silently
 * fall back to its other heuristics.
 */
async function safeFetchHtml(initialUrl: string): Promise<{ url: string; html: string } | null> {
  let target: URL;
  try { target = new URL(initialUrl); } catch { return null; }

  for (let hop = 0; hop <= SITE_FETCH_MAX_REDIRECTS; hop++) {
    // Single combined check — also returns the IP we will pin for the
    // connect, so there's no second DNS window for rebinding to slip in.
    const safeIp = await urlSafeIp(target);
    if (!safeIp) return null;

    const result = await singleSafeRequest(target, safeIp);
    if (result.kind === "abort") return null;
    if (result.kind === "body") return { url: target.toString(), html: result.html };

    // Redirect — re-validate the next hop in the next iteration.
    try { target = new URL(result.location, target); } catch { return null; }
  }
  return null;
}

/**
 * Pull common Google Tag/Analytics signals out of an HTML page. The
 * measurement ID `G-XXXXXXXXXX` is the public ID that ships in the
 * page's gtag snippet — it is NOT the numeric GA4 Property ID needed
 * by the Data API, but it gives the AI a strong hint and lets us tell
 * the admin where to look.
 */
function extractGtagSignals(html: string): {
  measurementIds: string[];
  gtmIds: string[];
  uaIds: string[];
} {
  const measurementIds = new Set<string>();
  const gtmIds = new Set<string>();
  const uaIds = new Set<string>();

  // GA4 measurement ID — appears in:
  //   googletagmanager.com/gtag/js?id=G-XXXXXXXXXX
  //   gtag('config', 'G-XXXXXXXXXX')
  //   <meta name="google-analytics" content="G-XXXXXXXXXX">
  for (const m of html.matchAll(/\bG-[A-Z0-9]{6,12}\b/g)) {
    measurementIds.add(m[0].toUpperCase());
  }
  // GTM container ID.
  for (const m of html.matchAll(/\bGTM-[A-Z0-9]{4,10}\b/g)) {
    gtmIds.add(m[0].toUpperCase());
  }
  // Legacy Universal Analytics UA-XXXXXX-N — kept just so we can tell
  // the user "you're still on UA, you need to upgrade to GA4".
  for (const m of html.matchAll(/\bUA-\d{4,10}-\d{1,3}\b/g)) {
    uaIds.add(m[0].toUpperCase());
  }
  return {
    measurementIds: [...measurementIds],
    gtmIds:         [...gtmIds],
    uaIds:          [...uaIds],
  };
}

// POST /api/admin/seo/connection/suggest — AI helper that extracts a
// GA4 Property ID and a Search Console site URL from any free-text hint
// the admin pastes (a GA dashboard URL, a Search Console URL, the company
// website, an email signature, etc.). Falls back to a deterministic regex
// pass when AI is not configured so the helper never silently fails.
//
// When the hint contains a website URL we additionally fetch the page
// (SSRF-guarded) and extract its `G-XXXXXXXXXX` measurement ID. The
// public Measurement ID is not the numeric Property ID needed by the
// Data API, but it strongly hints which property is in use and lets
// us point the admin at the right place to look up the Property ID.
router.post("/connection/suggest", requireSuperAdmin, async (req: any, res): Promise<void> => {
  try {
    const hint = String(req.body?.hint ?? "").trim().slice(0, 2000);
    if (!hint) {
      res.status(400).json({ error: "اكتب رابط موقعك أو رابط لوحة Google Analytics لاقتراح الإعدادات" });
      return;
    }

    // ── Deterministic pass — cheap, always runs ────────────────────────
    // GA4 URLs look like: https://analytics.google.com/analytics/web/#/p123456789/...
    // Property IDs are pure digits, typically 9-12 chars.
    let analyticsPropertyId: string | null = null;
    const ga4Match =
      hint.match(/[/#]p(\d{6,15})\b/i) ||
      hint.match(/properties\/(\d{6,15})\b/i) ||
      hint.match(/property[_\s-]*id[^0-9]{0,8}(\d{6,15})/i) ||
      hint.match(/\bGA4[^0-9]{0,8}(\d{6,15})/i);
    if (ga4Match) analyticsPropertyId = ga4Match[1];

    // Search Console: pull a clean origin from any URL in the hint, or
    // recognise an explicit sc-domain:example.com / *.example.com form.
    let searchConsoleSiteUrl: string | null = null;
    let websiteOrigin: string | null = null; // best fetchable URL we found
    const scDomainMatch = hint.match(/sc-domain:([a-z0-9.-]+\.[a-z]{2,})/i);
    if (scDomainMatch) {
      searchConsoleSiteUrl = `sc-domain:${scDomainMatch[1].toLowerCase()}`;
      websiteOrigin = `https://${scDomainMatch[1].toLowerCase()}/`;
    } else {
      const urlMatch = hint.match(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(\/[^\s"'<>]*)?/i);
      if (urlMatch) {
        const host = urlMatch[1].toLowerCase().replace(/^www\./, "");
        // Skip URLs that are clearly internal Google admin URLs — we
        // don't want to fetch analytics.google.com just because the
        // user pasted their dashboard link.
        if (!/^(analytics|search|tagmanager|console)\.google\.com$/i.test(host)) {
          searchConsoleSiteUrl = `https://${host}/`;
          websiteOrigin = `https://${host}/`;
        }
      } else {
        const bareHost = hint.match(/\b([a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?)\b/i);
        if (bareHost) {
          const host = bareHost[1].toLowerCase().replace(/^www\./, "");
          searchConsoleSiteUrl = `https://${host}/`;
          websiteOrigin = `https://${host}/`;
        }
      }
    }

    // ── Fetch the website and look for gtag/GTM signals ────────────────
    // This is the core improvement: the AI cannot guess the real
    // measurement ID, but it's almost always sitting in plain text in
    // the homepage's <script> tags.
    let analyticsMeasurementId: string | null = null;
    let gtmContainerId: string | null = null;
    let legacyUaId: string | null = null;
    let fetchedFrom: string | null = null;
    if (websiteOrigin) {
      const page = await safeFetchHtml(websiteOrigin);
      if (page) {
        fetchedFrom = page.url;
        const sig = extractGtagSignals(page.html);
        if (sig.measurementIds.length > 0) analyticsMeasurementId = sig.measurementIds[0];
        if (sig.gtmIds.length > 0)         gtmContainerId         = sig.gtmIds[0];
        if (sig.uaIds.length > 0)          legacyUaId             = sig.uaIds[0];
      }
    }

    let notes = "";
    let source: "ai" | "regex" = "regex";

    // ── AI pass — only when configured. The AI can rescue cases where
    // the user pasted Arabic prose or a screenshot transcript, and it
    // can pick the right Search Console URL form (https vs sc-domain).
    if (process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL && process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
      const callerKey: number = (req as any).user?.id
        ?? -Math.abs(((req.ip || "anon").split("").reduce((h: number, c: string) => (h * 31 + c.charCodeAt(0)) | 0, 0)));
      const rl = checkSuggestRateLimit(callerKey);
      if (!rl.ok) {
        res.setHeader("Retry-After", String(rl.retryInSec));
        res.status(429).json({ error: rl.reason, retryInSec: rl.retryInSec });
        return;
      }

      const settings = await readAiSettings();
      // Build a "what we found on the page" section only when we
      // actually fetched something — keeps the prompt short otherwise.
      const siteSignals: string[] = [];
      if (fetchedFrom) {
        siteSignals.push(`تم جلب الصفحة الرئيسية لموقع المستخدم: ${fetchedFrom}`);
        if (analyticsMeasurementId) {
          siteSignals.push(`- وُجد في الصفحة معرّف قياس GA4 (Measurement ID): ${analyticsMeasurementId}`);
          siteSignals.push(`  ⚠️ هذا ليس Property ID الرقمي. لا تضعه في analyticsPropertyId. استخدمه فقط كدليل على أن الموقع يستعمل GA4، واطلب من المستخدم في notes فتح Google Analytics → Admin → Property Settings لنسخ Property ID الرقمي.`);
        }
        if (gtmContainerId) siteSignals.push(`- وُجد Google Tag Manager: ${gtmContainerId}`);
        if (legacyUaId)     siteSignals.push(`- وُجد معرّف Universal Analytics قديم: ${legacyUaId} (ملاحظة: UA متوقّف منذ 2023، أبلغ المستخدم).`);
        if (!analyticsMeasurementId && !gtmContainerId && !legacyUaId) {
          siteSignals.push(`- لم نجد أي شيفرة gtag أو GTM في الصفحة. ربما لم يثبّت المستخدم Google Analytics بعد.`);
        }
      } else if (websiteOrigin) {
        siteSignals.push(`حاولنا جلب صفحة الموقع ${websiteOrigin} لكن الطلب فشل (الموقع قد يكون خلف Cloudflare أو غير متاح).`);
      }

      const prompt = [
        `أنت مساعد إعداد لربط Google Analytics 4 و Google Search Console.`,
        `سيعطيك المستخدم أي نص (رابط لوحة Analytics، رابط Search Console، اسم نطاق، ملاحظات بالعربية…)`,
        `ومهمتك استخراج إعدادين فقط:`,
        `1) analyticsPropertyId — معرّف GA4 الرقمي فقط (بدون G- أو p)، عادةً من 9 إلى 12 رقم.`,
        `   هذا الحقل يأتي من Google Analytics → Admin → Property Settings → Property ID.`,
        `   لا يمكن استنتاجه من شيفرة gtag في صفحة الموقع (G-XXXX هو معرّف قياس مختلف).`,
        `   إن لم تجد رقم Property واضح في النص، أعد null.`,
        `2) searchConsoleSiteUrl — رابط الموقع كما هو محفوظ في Search Console.`,
        `   • إن كانت الخاصية من نوع URL prefix أعدها بصيغة "https://example.com/" مع شرطة مائلة في النهاية.`,
        `   • إن كانت الخاصية من نوع Domain property أعدها بصيغة "sc-domain:example.com" بدون https.`,
        `   • أزل www. إلا إذا كان واضحاً أن الموقع مسجّل بها.`,
        `   إن لم تستطع التحديد، أعد null.`,
        ``,
        `اقتراحات أوّلية مبنية على Regex (قد تكون خاطئة، صحّحها أو أكّدها):`,
        `- analyticsPropertyId المقترح: ${analyticsPropertyId ?? "null"}`,
        `- searchConsoleSiteUrl المقترح: ${searchConsoleSiteUrl ?? "null"}`,
        ...(siteSignals.length ? ["", `إشارات مستخرَجة فعلياً من الموقع:`, ...siteSignals] : []),
        ``,
        `النص الذي قدّمه المستخدم (بين علامتين):`,
        `«${hint}»`,
        ``,
        `إرشادات لحقل notes (مهم جداً):`,
        `• اجعله بالعربية في 1-3 جمل قصيرة.`,
        `• إن وجدت Measurement ID في الموقع لكن المستخدم لم يعطِ Property ID، أبلغه أن GA4 مثبَّت لكن عليه أيضاً نسخ Property ID الرقمي من Admin → Property Settings.`,
        `• إن لم نجد أي شيفرة Analytics في الموقع، نبّه المستخدم بلطف.`,
        `• إن وجد UA-… فقط، اطلب من المستخدم الترقية إلى GA4.`,
        ``,
        `أعد JSON صالح فقط داخل كتلة \`\`\`json … \`\`\` بهذا الشكل:`,
        `{ "analyticsPropertyId": "123456789" أو null,`,
        `  "searchConsoleSiteUrl": "https://example.com/" أو "sc-domain:example.com" أو null,`,
        `  "notes": "نص قصير بالعربية" }`,
        `لا تكتب أي شيء خارج كتلة JSON.`,
      ].join("\n");

      try {
        const aiRes = await aiChat(
          [{ role: "user", content: prompt }],
          { maxTokens: 400 },
        );
        if (!aiRes.ok) {
          throw new Error(aiRes.reason || "ai-unavailable");
        }
        const text = aiRes.text ?? "";
        const jsonBlock = text.match(/```json\s*([\s\S]*?)```/i);
        const raw = jsonBlock ? jsonBlock[1] : text;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          if (typeof parsed.analyticsPropertyId === "string" && /^\d{6,15}$/.test(parsed.analyticsPropertyId.trim())) {
            analyticsPropertyId = parsed.analyticsPropertyId.trim();
          } else if (parsed.analyticsPropertyId === null) {
            // AI explicitly said no match — keep regex result if any.
          }
          if (typeof parsed.searchConsoleSiteUrl === "string") {
            const v = parsed.searchConsoleSiteUrl.trim();
            if (/^sc-domain:[a-z0-9.-]+\.[a-z]{2,}$/i.test(v) || /^https?:\/\//i.test(v)) {
              searchConsoleSiteUrl = v;
            }
          }
          if (typeof parsed.notes === "string") notes = parsed.notes.trim().slice(0, 240);
          source = "ai";
        }
      } catch (aiErr: any) {
        // AI failed — keep the regex result and report it to the client.
        notes = `تعذّر الاتصال بالذكاء الاصطناعي، تم الاعتماد على الاستخراج التلقائي فقط.`;
      }
    } else {
      notes = "خدمة الذكاء الاصطناعي غير مهيأة على الخادم — تم الاعتماد على الاستخراج التلقائي فقط.";
    }

    // ── Deterministic notes for the site-fetch step ───────────────────
    // Even when the AI is configured we want to make absolutely sure
    // the admin sees the site-fetch result in the notes — the AI
    // sometimes drops these details when it's confident about the
    // numeric Property ID.
    const factualLines: string[] = [];
    if (analyticsMeasurementId) {
      factualLines.push(
        `وُجد في صفحة موقعك معرّف قياس GA4 (${analyticsMeasurementId}). هذا ليس Property ID؛ افتح Google Analytics → الإدارة → إعدادات الخاصية وانسخ الرقم الذي يظهر تحت "معرّف الموقع" (9-12 رقم).`
      );
    } else if (legacyUaId) {
      factualLines.push(
        `موقعك ما زال يستعمل Universal Analytics (${legacyUaId}) المتوقّف منذ يوليو 2023. أنشئ خاصية GA4 جديدة وانسخ Property ID الخاص بها.`
      );
    } else if (gtmContainerId && !analyticsMeasurementId) {
      factualLines.push(
        `وُجد Google Tag Manager (${gtmContainerId}) في موقعك لكن لم نجد شيفرة GA4 مباشرة. تأكد من وجود وسم GA4 مفعَّل داخل حاوية Tag Manager.`
      );
    } else if (fetchedFrom) {
      factualLines.push(
        `جلبنا صفحة موقعك (${fetchedFrom}) ولم نجد فيها أي شيفرة Google Analytics. تأكد من تثبيت GA4 على الموقع أولاً.`
      );
    } else if (websiteOrigin) {
      factualLines.push(
        `تعذّر جلب صفحة موقعك (${websiteOrigin}) — قد يكون خلف Cloudflare أو يحجب البوتات. أدخل Property ID يدوياً من Google Analytics.`
      );
    }
    // Compose final notes: factual first, then whatever the AI added.
    if (factualLines.length) {
      notes = [...factualLines, notes].filter(Boolean).join(" ").trim().slice(0, 500);
    }

    res.json({
      analyticsPropertyId,
      searchConsoleSiteUrl,
      analyticsMeasurementId,
      gtmContainerId,
      legacyUaId,
      fetchedFrom,
      notes,
      source,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تعذّر توليد الاقتراحات" });
  }
});

export default router;
