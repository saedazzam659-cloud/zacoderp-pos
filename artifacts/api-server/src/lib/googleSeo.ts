import { JWT } from "google-auth-library";

export interface SeoConnectionRow {
  analytics: boolean;
  searchConsole: boolean;
  analyticsPropertyId: string | null;
  searchConsoleSiteUrl: string | null;
  serviceAccountJson: string | null;
  updatedAt: string | null;
}

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id?: string;
}

const GA_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

export function parseServiceAccount(json: string | null | undefined): ServiceAccountKey | null {
  if (!json || typeof json !== "string") return null;
  try {
    const o = JSON.parse(json);
    if (typeof o?.client_email === "string" && typeof o?.private_key === "string") {
      return {
        client_email: o.client_email,
        private_key: o.private_key,
        project_id: typeof o.project_id === "string" ? o.project_id : undefined,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function getAccessToken(sa: ServiceAccountKey, scope: string): Promise<string> {
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [scope] });
  const tk = await jwt.authorize();
  if (!tk?.access_token) throw new Error("لم يتم استلام رمز وصول من Google");
  return tk.access_token;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

// ─── Connection tests ───────────────────────────────────────────────────
export interface TestResult { ok: boolean; error?: string }

export async function testGsc(sa: ServiceAccountKey, siteUrl: string): Promise<TestResult> {
  try {
    const token = await getAccessToken(sa, GSC_SCOPE);
    const url = `https://searchconsole.googleapis.com/v1/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate: ymd(daysAgo(7)),
        endDate: ymd(daysAgo(1)),
        rowLimit: 1,
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return { ok: false, error: humanError(r.status, t, "Search Console") };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || "تعذّر الاتصال بـ Search Console" };
  }
}

export async function testGa4(sa: ServiceAccountKey, propertyId: string): Promise<TestResult> {
  try {
    const token = await getAccessToken(sa, GA_SCOPE);
    const url = `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`;
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }],
        metrics: [{ name: "totalUsers" }],
        limit: 1,
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return { ok: false, error: humanError(r.status, t, "Google Analytics") };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || "تعذّر الاتصال بـ Google Analytics" };
  }
}

function humanError(status: number, body: string, svc: string): string {
  if (status === 401 || status === 403) {
    return `ليس لدى حساب الخدمة صلاحية على ${svc}. تأكد من إضافة بريد حساب الخدمة كمستخدم في الإعدادات.`;
  }
  if (status === 404) return `لم يتم العثور على المورد في ${svc}. تحقق من المعرّف/الرابط المُدخل.`;
  if (status === 400) {
    const msg = tryExtractGoogleMsg(body) || "طلب غير صالح";
    return `خطأ من ${svc}: ${msg}`;
  }
  const m = tryExtractGoogleMsg(body);
  return `خطأ من ${svc} (HTTP ${status})${m ? ` — ${m}` : ""}`;
}

function tryExtractGoogleMsg(body: string): string | null {
  try {
    const j = JSON.parse(body);
    return j?.error?.message ?? null;
  } catch {
    return null;
  }
}

// ─── Real data fetchers ─────────────────────────────────────────────────
// Each returns null on failure so the caller can fall back to mock cleanly.

export interface GscTotals {
  clicks: number;
  impressions: number;
  ctr: number;       // 0-1
  position: number;  // avg
}

export async function fetchGscTotals(sa: ServiceAccountKey, siteUrl: string, days = 28): Promise<GscTotals | null> {
  try {
    const token = await getAccessToken(sa, GSC_SCOPE);
    const url = `https://searchconsole.googleapis.com/v1/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate: ymd(daysAgo(days)),
        endDate: ymd(daysAgo(1)),
        rowLimit: 1,
        // No dimensions → returns one aggregate row
      }),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const row = j?.rows?.[0];
    if (!row) return { clicks: 0, impressions: 0, ctr: 0, position: 0 };
    return {
      clicks: Number(row.clicks ?? 0),
      impressions: Number(row.impressions ?? 0),
      ctr: Number(row.ctr ?? 0),
      position: Number(row.position ?? 0),
    };
  } catch {
    return null;
  }
}

export interface GscKeyword { keyword: string; clicks: number; impressions: number; position: number; page: string }

export async function fetchGscKeywords(sa: ServiceAccountKey, siteUrl: string, days = 28): Promise<GscKeyword[] | null> {
  try {
    const token = await getAccessToken(sa, GSC_SCOPE);
    const url = `https://searchconsole.googleapis.com/v1/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate: ymd(daysAgo(days)),
        endDate: ymd(daysAgo(1)),
        dimensions: ["query", "page"],
        rowLimit: 25,
      }),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const rows: any[] = j?.rows ?? [];
    return rows.map((r) => ({
      keyword: String(r.keys?.[0] ?? ""),
      page: String(r.keys?.[1] ?? ""),
      clicks: Number(r.clicks ?? 0),
      impressions: Number(r.impressions ?? 0),
      position: Number(r.position ?? 0),
    }));
  } catch {
    return null;
  }
}

export interface GscDayPoint { day: string; clicks: number; impressions: number }

export async function fetchGscTimeline(sa: ServiceAccountKey, siteUrl: string, days = 30): Promise<GscDayPoint[] | null> {
  try {
    const token = await getAccessToken(sa, GSC_SCOPE);
    const url = `https://searchconsole.googleapis.com/v1/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate: ymd(daysAgo(days)),
        endDate: ymd(daysAgo(1)),
        dimensions: ["date"],
        rowLimit: days + 5,
      }),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const rows: any[] = j?.rows ?? [];
    return rows.map((r) => ({
      day: String(r.keys?.[0] ?? ""),
      clicks: Number(r.clicks ?? 0),
      impressions: Number(r.impressions ?? 0),
    }));
  } catch {
    return null;
  }
}

export interface Ga4Totals { totalUsers: number }

async function ga4RunReport(sa: ServiceAccountKey, propertyId: string, body: unknown): Promise<any | null> {
  try {
    const token = await getAccessToken(sa, GA_SCOPE);
    const url = `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`;
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function fetchGa4Totals(sa: ServiceAccountKey, propertyId: string, days = 28): Promise<Ga4Totals | null> {
  const j = await ga4RunReport(sa, propertyId, {
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: "yesterday" }],
    metrics: [{ name: "totalUsers" }],
  });
  if (!j) return null;
  const v = Number(j?.rows?.[0]?.metricValues?.[0]?.value ?? 0);
  return { totalUsers: v };
}

export interface Ga4Source { source: "organic" | "direct" | "social" | "referral"; sessions: number }

export async function fetchGa4TrafficSources(sa: ServiceAccountKey, propertyId: string, days = 28): Promise<Ga4Source[] | null> {
  const j = await ga4RunReport(sa, propertyId, {
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: "yesterday" }],
    dimensions: [{ name: "sessionDefaultChannelGroup" }],
    metrics: [{ name: "sessions" }],
    limit: 25,
  });
  if (!j) return null;
  const buckets: Record<Ga4Source["source"], number> = { organic: 0, direct: 0, social: 0, referral: 0 };
  for (const row of (j?.rows ?? []) as any[]) {
    const channel = String(row?.dimensionValues?.[0]?.value ?? "").toLowerCase();
    const sessions = Number(row?.metricValues?.[0]?.value ?? 0);
    if (channel.includes("organic")) buckets.organic += sessions;
    else if (channel.includes("direct")) buckets.direct += sessions;
    else if (channel.includes("social")) buckets.social += sessions;
    else buckets.referral += sessions;
  }
  return (Object.keys(buckets) as Ga4Source["source"][]).map((k) => ({ source: k, sessions: buckets[k] }));
}

export interface Ga4PageRow { url: string; title: string; visits: number; avgSessionSeconds: number }

export async function fetchGa4TopPages(sa: ServiceAccountKey, propertyId: string, days = 28): Promise<Ga4PageRow[] | null> {
  const j = await ga4RunReport(sa, propertyId, {
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: "yesterday" }],
    dimensions: [{ name: "pagePath" }, { name: "pageTitle" }],
    metrics: [{ name: "screenPageViews" }, { name: "averageSessionDuration" }],
    limit: 10,
    orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
  });
  if (!j) return null;
  return ((j?.rows ?? []) as any[]).map((r) => ({
    url: String(r?.dimensionValues?.[0]?.value ?? ""),
    title: String(r?.dimensionValues?.[1]?.value ?? ""),
    visits: Number(r?.metricValues?.[0]?.value ?? 0),
    avgSessionSeconds: Math.round(Number(r?.metricValues?.[1]?.value ?? 0)),
  }));
}

export async function fetchGa4DailyVisitors(sa: ServiceAccountKey, propertyId: string, days = 30): Promise<{ day: string; visitors: number }[] | null> {
  const j = await ga4RunReport(sa, propertyId, {
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: "yesterday" }],
    dimensions: [{ name: "date" }],
    metrics: [{ name: "totalUsers" }],
    orderBys: [{ dimension: { dimensionName: "date" } }],
  });
  if (!j) return null;
  return ((j?.rows ?? []) as any[]).map((r) => ({
    day: String(r?.dimensionValues?.[0]?.value ?? ""),
    visitors: Number(r?.metricValues?.[0]?.value ?? 0),
  }));
}
