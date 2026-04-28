import { Router, type Request, type Response, type NextFunction } from "express";
import { db, usersTable, systemSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resolveBearerToken } from "../middleware/auth.js";

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

// ─── Endpoints ───────────────────────────────────────────────────────────

// GET /api/admin/seo/dashboard — full SEO dashboard payload.
router.get("/dashboard", requireSuperAdmin, async (_req, res) => {
  try {
    res.json(buildSeoPayload());
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تعذّر تحميل بيانات SEO" });
  }
});

// POST /api/admin/seo/refresh — explicit "refresh now" hook. With the mock
// generator the output is day-stable so this is a no-op that just returns
// the current payload, matching the UX of the spec's "Refresh Now" button.
router.post("/refresh", requireSuperAdmin, async (_req, res) => {
  try {
    res.json(buildSeoPayload());
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تعذّر تحديث البيانات" });
  }
});

// GET /api/admin/seo/connection — read which Google integrations are set up.
// Reads from system_settings (key: 'seo_connection') so a future settings
// screen can flip these flags without code changes. Falls back to a closed
// connection state if the row is missing.
router.get("/connection", requireSuperAdmin, async (_req, res) => {
  try {
    const [row] = await db.select().from(systemSettingsTable)
      .where(eq(systemSettingsTable.key, "seo_connection"));
    let v: any = {};
    if (row?.value) {
      try { v = JSON.parse(row.value); } catch { v = {}; }
    }
    res.json({
      analytics:     !!v.analytics,
      searchConsole: !!v.searchConsole,
      analyticsPropertyId: v.analyticsPropertyId ?? null,
      searchConsoleSiteUrl: v.searchConsoleSiteUrl ?? null,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "تعذّر قراءة حالة الربط" });
  }
});

export default router;
