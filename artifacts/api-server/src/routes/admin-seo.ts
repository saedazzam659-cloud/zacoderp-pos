import { Router, type Request, type Response, type NextFunction } from "express";
import { db, usersTable, systemSettingsTable, seoGeneratedArticlesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
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

// POST /api/admin/seo/ai-articles/generate
//   body: { topic: string, targetKeyword?: string, sourceTopic?: string }
// Calls Anthropic with the saved settings, parses a JSON envelope from the
// model, persists the draft, and returns it.
router.post("/ai-articles/generate", requireSuperAdmin, async (req: any, res) => {
  try {
    const topicRaw = String(req.body?.topic ?? "").trim();
    const targetKeywordRaw = String(req.body?.targetKeyword ?? "").trim();
    const sourceTopic = String(req.body?.sourceTopic ?? topicRaw).trim();
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

    const prompt = [
      `أنت كاتب محتوى محترف لتحسين محركات البحث (SEO) لموقع برنامج محاسبة وفوترة إلكترونية سعودي.`,
      ``,
      `إعدادات التوليد:`,
      `- النبرة: ${toneLabel}`,
      `- الطول المستهدف: حوالي ${targetWords} كلمة`,
      `- اللغة: ${langInstruction}`,
      `- الكلمات المفتاحية الافتراضية للموقع: ${settings.defaultKeywords.join("، ")}`,
      `- توجيهات الإدارة: ${settings.guidance}`,
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

    const client = new Anthropic({
      apiKey:  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
    });

    const message = await client.messages.create({
      model:      settings.model || "claude-sonnet-4-6",
      max_tokens: 8192,
      messages:   [{ role: "user", content: prompt }],
    });

    // Concatenate all text blocks; the model occasionally splits into more
    // than one block when reasoning is enabled.
    const rawText = message.content
      .map(b => (b.type === "text" ? b.text : ""))
      .join("\n")
      .trim();

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
    const [row] = await db.update(seoGeneratedArticlesTable)
      .set(patch).where(eq(seoGeneratedArticlesTable.id, id)).returning();
    if (!row) return res.status(404).json({ error: "المقال غير موجود" });
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
