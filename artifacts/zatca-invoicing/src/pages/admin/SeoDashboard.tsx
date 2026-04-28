import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Card, CardHeader, CardTitle, CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import {
  Eye, MousePointerClick, BarChart3 as ChartIcon, Trophy, RefreshCw,
  TrendingUp, TrendingDown, ArrowUpRight, AlertTriangle,
  Sparkles, Search, Globe, Link as LinkIcon, FileText,
  ShieldCheck, Info, AlertCircle,
} from "lucide-react";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, PieChart, Pie, Cell, Legend,
} from "recharts";
import { useAuth } from "@/contexts/AuthContext";

// Same pattern as SuperAdminDashboard — base URL is the artifact's mount path.
const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─── Types — mirror the API response shape ────────────────────────────
interface TimelinePoint  { day: string; visitors: number; clicks: number; impressions: number }
interface KeywordRow     { keyword: string; impressions: number; clicks: number; position: number; page: string }
interface PageRow        { url: string; title: string; visits: number; avgSessionSeconds: number; position: number }
interface SourceSlice    { source: "organic" | "direct" | "social" | "referral"; sessions: number; pct: number }
interface IndexStatus    { indexed: number; notIndexed: number; crawlErrors: number }
interface AlertRow       { id: string; severity: "info" | "warn" | "critical"; message: string }
interface RecRow         { id: string; title: string; details: string; impact: "low" | "medium" | "high" }

interface SeoDashboardData {
  connected: { analytics: boolean; searchConsole: boolean };
  generatedAt: string;
  totals: {
    visitors: number; clicks: number; impressions: number;
    averagePosition: number; visibilityScore: number;
    visitorsDeltaPct: number; clicksDeltaPct: number;
    impressionsDeltaPct: number; positionDelta: number;
  };
  timeline: { daily: TimelinePoint[]; weekly: TimelinePoint[]; monthly: TimelinePoint[] };
  keywords: KeywordRow[];
  topPages: PageRow[];
  trafficSources: SourceSlice[];
  indexStatus: IndexStatus;
  alerts: AlertRow[];
  recommendations: RecRow[];
}

// ─── Small helpers ─────────────────────────────────────────────────────
const fmt = (n?: number) => (n === undefined || n === null ? "—" : n.toLocaleString("ar-SA"));
const fmtPct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;

const SOURCE_LABEL_AR: Record<SourceSlice["source"], string> = {
  organic:  "بحث عضوي",
  direct:   "مباشر",
  social:   "وسائل التواصل",
  referral: "إحالات",
};
const SOURCE_COLORS: Record<SourceSlice["source"], string> = {
  organic:  "#16a34a",
  direct:   "#2563eb",
  social:   "#a855f7",
  referral: "#f59e0b",
};

// ─── KPI tile (mirrors the SuperAdmin dashboard look) ─────────────────
function KpiTile({
  label, value, icon: Icon, color, bg, delta, deltaIsBetter,
}: {
  label: string; value: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string; bg: string;
  delta?: number;
  /** When true, a positive delta is "good" (green). When false (e.g. avg position
   * where lower numbers are better), positive delta is "bad" (red). */
  deltaIsBetter?: (d: number) => boolean;
}) {
  const showDelta = typeof delta === "number" && !Number.isNaN(delta);
  const better = showDelta && (deltaIsBetter ? deltaIsBetter(delta!) : delta! > 0);
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground mb-1">{label}</p>
            <p className="text-2xl font-bold text-foreground tabular-nums truncate">{value}</p>
            {showDelta && (
              <p className={`text-xs mt-1 inline-flex items-center gap-1 ${better ? "text-green-700" : "text-rose-700"}`}>
                {better ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                {fmtPct(delta!)}
                <span className="text-muted-foreground"> مقارنة بالفترة السابقة</span>
              </p>
            )}
          </div>
          <div className={`shrink-0 rounded-lg p-2 ${bg}`}>
            <Icon className={`h-5 w-5 ${color}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Section header ────────────────────────────────────────────────────
function SectionHeader({
  icon: Icon, title, color = "text-primary",
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  color?: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className={`h-4 w-4 ${color}`} />
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────
export default function SeoDashboard() {
  const { token, user } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };
  const [tab, setTab] = useState<"daily" | "weekly" | "monthly">("daily");

  // Pick the right backend surface based on caller role:
  //   - superadmin → platform-wide /api/admin/seo/* (mock seeded by date only)
  //   - everyone else → per-company /api/seo/* (mock seeded by companyId)
  // The page UI is identical; only the fetch URL changes.
  const isSuperAdmin = user?.role === "superadmin";
  const base = isSuperAdmin ? "/api/admin/seo" : "/api/seo";

  // 24-hour auto-refresh window per spec.
  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

  // Cross-tenant cache safety: include the user's identity (id + companyId) in
  // the query key so a logout/login as a different company in the same browser
  // session never serves the previous tenant's cached payload before refetch.
  const { data, isLoading, refetch, isFetching } = useQuery<SeoDashboardData>({
    queryKey: ["seo-dashboard", base, user?.companyId ?? "none", user?.id ?? "anon"],
    queryFn: async () => {
      const res = await fetch(`${API}${base}/dashboard`, { headers });
      if (!res.ok) throw new Error("فشل تحميل بيانات SEO");
      return res.json();
    },
    refetchInterval: TWENTY_FOUR_HOURS_MS,
    staleTime: TWENTY_FOUR_HOURS_MS,
  });

  // Manual refresh button hits the explicit /refresh hook then refetches.
  const refreshMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API}${base}/refresh`, { method: "POST", headers });
      if (!res.ok) throw new Error("فشل التحديث");
      return res.json();
    },
    onSuccess: () => { refetch(); },
  });

  const t = data?.totals;
  const timeline = useMemo<TimelinePoint[]>(() => {
    if (!data) return [];
    return data.timeline[tab];
  }, [data, tab]);

  const sourcesPie = (data?.trafficSources ?? []).map((s) => ({
    name: SOURCE_LABEL_AR[s.source],
    value: s.sessions,
    pct: s.pct,
    fill: SOURCE_COLORS[s.source],
  }));

  return (
    <div className="space-y-6">
      {/* ─── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Search className="h-6 w-6 text-primary" />
            إدارة تحسين محركات البحث (SEO)
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            مركز قياس أداء الموقع — زيارات، نقرات، ظهور، كلمات مفتاحية، توصيات الذكاء الاصطناعي. يُحدَّث تلقائياً كل 24 ساعة.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data?.generatedAt && (
            <p className="text-[11px] text-muted-foreground">
              آخر تحديث: {new Date(data.generatedAt).toLocaleString("ar-SA")}
            </p>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => refreshMut.mutate()}
            disabled={isFetching || refreshMut.isPending}
            className="gap-1"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${(isFetching || refreshMut.isPending) ? "animate-spin" : ""}`} />
            تحديث الآن
          </Button>
        </div>
      </div>

      {/* ─── Connection banner ──────────────────────────────────────── */}
      {data && !data.connected.analytics && !data.connected.searchConsole && (
        <Card className="border-amber-300 bg-amber-50/40">
          <CardContent className="p-4 flex items-start gap-3">
            <Info className="h-5 w-5 text-amber-700 shrink-0 mt-0.5" />
            <div className="text-sm text-amber-900">
              <p className="font-semibold mb-1">البيانات المعروضة للعرض التوضيحي</p>
              <p>
                لم يتم بعد ربط <span className="font-semibold">Google Analytics</span> و
                <span className="font-semibold"> Search Console</span>. الأرقام أدناه تمثل عينة واقعية لشكل اللوحة.
                لربط حساباتك الفعلية وعرض البيانات الحقيقية، تواصل مع فريق التطوير لتفعيل التكامل.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── 1. KPI cards ────────────────────────────────────────────── */}
      <div>
        <SectionHeader icon={ChartIcon} title="مؤشرات الأداء الرئيسية" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiTile
            label="إجمالي الزوار" value={fmt(t?.visitors)}
            icon={Eye} color="text-blue-700" bg="bg-blue-100"
            delta={t?.visitorsDeltaPct}
          />
          <KpiTile
            label="عدد النقرات" value={fmt(t?.clicks)}
            icon={MousePointerClick} color="text-violet-700" bg="bg-violet-100"
            delta={t?.clicksDeltaPct}
          />
          <KpiTile
            label="مرات الظهور" value={fmt(t?.impressions)}
            icon={ChartIcon} color="text-emerald-700" bg="bg-emerald-100"
            delta={t?.impressionsDeltaPct}
          />
          <KpiTile
            label="متوسط الترتيب" value={t ? t.averagePosition.toFixed(2) : "—"}
            icon={Trophy} color="text-amber-700" bg="bg-amber-100"
            delta={t?.positionDelta}
            deltaIsBetter={(d) => d < 0}
          />
        </div>
      </div>

      {/* ─── 2. Visibility score (clicks/impressions × 100) ──────────── */}
      <div>
        <SectionHeader icon={Sparkles} title="درجة الظهور (Visibility Score)" color="text-fuchsia-700" />
        <Card>
          <CardContent className="p-5 flex items-center justify-between gap-6 flex-wrap">
            <div className="flex items-center gap-4">
              <div className="rounded-full p-3 bg-fuchsia-100">
                <Sparkles className="h-7 w-7 text-fuchsia-700" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">معدّل النقر إلى الظهور (CTR)</p>
                <p className="text-4xl font-bold text-fuchsia-700 tabular-nums">
                  {t ? `${t.visibilityScore.toFixed(2)}%` : "—"}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  المعادلة: (النقرات ÷ الظهور) × 100
                </p>
              </div>
            </div>
            <div className="text-sm text-muted-foreground max-w-md leading-relaxed">
              كلما ارتفعت هذه النسبة، كان أداء عنوان ووصف الصفحات أفضل في جذب المستخدمين بعد ظهورها في نتائج البحث.
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ─── 3. Traffic timeline chart ───────────────────────────────── */}
      <div>
        <SectionHeader icon={TrendingUp} title="حركة الزيارات عبر الزمن" color="text-blue-700" />
        <Card>
          <CardHeader className="pb-2">
            <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
              <TabsList>
                <TabsTrigger value="daily">يومي (30 يوم)</TabsTrigger>
                <TabsTrigger value="weekly">أسبوعي (12 أسبوع)</TabsTrigger>
                <TabsTrigger value="monthly">شهري (12 شهر)</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent className="pt-2">
            {timeline.length === 0 ? (
              <div className="h-72 flex items-center justify-center text-sm text-muted-foreground">
                {isLoading ? "جاري التحميل..." : "لا توجد بيانات"}
              </div>
            ) : (
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={timeline} margin={{ left: 4, right: 16, top: 8, bottom: 0 }}>
                    <defs>
                      <linearGradient id="visitorsFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%"   stopColor="#2563eb" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#2563eb" stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="clicksFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%"   stopColor="#a855f7" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#a855f7" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <RTooltip
                      formatter={(v: number, name) => [fmt(v), name === "visitors" ? "الزوار" : name === "clicks" ? "النقرات" : "الظهور"]}
                      labelFormatter={(l) => `الفترة: ${l}`}
                    />
                    <Legend
                      formatter={(v) => v === "visitors" ? "الزوار" : v === "clicks" ? "النقرات" : "الظهور"}
                    />
                    <Area type="monotone" dataKey="visitors"    stroke="#2563eb" fill="url(#visitorsFill)" strokeWidth={2} />
                    <Area type="monotone" dataKey="clicks"      stroke="#a855f7" fill="url(#clicksFill)"   strokeWidth={2} />
                    <Area type="monotone" dataKey="impressions" stroke="#10b981" fill="transparent"        strokeWidth={1.5} strokeDasharray="4 3" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ─── 4. Search performance summary ───────────────────────────── */}
      <div>
        <SectionHeader icon={Search} title="أداء البحث (Search Console)" color="text-emerald-700" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card><CardContent className="p-4">
            <p className="text-xs text-muted-foreground">إجمالي الظهور</p>
            <p className="text-xl font-bold tabular-nums">{fmt(t?.impressions)}</p>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <p className="text-xs text-muted-foreground">إجمالي النقرات</p>
            <p className="text-xl font-bold tabular-nums">{fmt(t?.clicks)}</p>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <p className="text-xs text-muted-foreground">معدل النقر CTR</p>
            <p className="text-xl font-bold tabular-nums">{t ? `${t.visibilityScore.toFixed(2)}%` : "—"}</p>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <p className="text-xs text-muted-foreground">متوسط الترتيب</p>
            <p className="text-xl font-bold tabular-nums">{t ? t.averagePosition.toFixed(2) : "—"}</p>
          </CardContent></Card>
        </div>
      </div>

      {/* ─── 5+6. Two-column row: Keywords + Top pages ───────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              أعلى الكلمات المفتاحية
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            {(data?.keywords ?? []).length === 0 ? (
              <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">لا توجد كلمات</div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>الكلمة</TableHead>
                      <TableHead className="text-end">الظهور</TableHead>
                      <TableHead className="text-end">النقرات</TableHead>
                      <TableHead className="text-end">الترتيب</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data!.keywords.slice(0, 10).map((k) => (
                      <TableRow key={k.keyword}>
                        <TableCell className="font-medium">
                          <div>{k.keyword}</div>
                          <div className="text-[11px] text-muted-foreground">{k.page}</div>
                        </TableCell>
                        <TableCell className="text-end tabular-nums">{fmt(k.impressions)}</TableCell>
                        <TableCell className="text-end tabular-nums">{fmt(k.clicks)}</TableCell>
                        <TableCell className="text-end tabular-nums">
                          <Badge variant={k.position <= 3 ? "default" : k.position <= 10 ? "secondary" : "outline"}>
                            {k.position.toFixed(1)}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <LinkIcon className="h-4 w-4 text-primary" />
              أعلى الصفحات أداءً
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            {(data?.topPages ?? []).length === 0 ? (
              <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">لا توجد صفحات</div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>الصفحة</TableHead>
                      <TableHead className="text-end">الزيارات</TableHead>
                      <TableHead className="text-end">متوسط الجلسة</TableHead>
                      <TableHead className="text-end">الترتيب</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data!.topPages.slice(0, 10).map((p) => (
                      <TableRow key={p.url}>
                        <TableCell className="font-medium">
                          <div>{p.title}</div>
                          <div className="text-[11px] text-muted-foreground">{p.url}</div>
                        </TableCell>
                        <TableCell className="text-end tabular-nums">{fmt(p.visits)}</TableCell>
                        <TableCell className="text-end tabular-nums">
                          {Math.floor(p.avgSessionSeconds / 60)}د {p.avgSessionSeconds % 60}ث
                        </TableCell>
                        <TableCell className="text-end tabular-nums">
                          <Badge variant={p.position <= 3 ? "default" : p.position <= 10 ? "secondary" : "outline"}>
                            {p.position.toFixed(1)}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ─── 7+8. Traffic sources + Index status ─────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Globe className="h-4 w-4 text-primary" />
              مصادر الزيارات
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            {sourcesPie.length === 0 ? (
              <div className="h-56 flex items-center justify-center text-sm text-muted-foreground">لا توجد بيانات</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-center">
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={sourcesPie} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
                        {sourcesPie.map((s, i) => <Cell key={i} fill={s.fill} />)}
                      </Pie>
                      <RTooltip formatter={(v: number) => fmt(v)} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="space-y-2">
                  {(data?.trafficSources ?? []).map((s) => (
                    <div key={s.source} className="flex items-center justify-between gap-3 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: SOURCE_COLORS[s.source] }} />
                        <span>{SOURCE_LABEL_AR[s.source]}</span>
                      </div>
                      <div className="tabular-nums text-muted-foreground">
                        {fmt(s.sessions)} <span className="text-foreground font-semibold">({s.pct.toFixed(1)}%)</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              حالة الأرشفة (Index Status)
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-2 space-y-3">
            <div className="flex items-center justify-between rounded-md bg-green-50 border border-green-200 p-3">
              <div className="text-sm text-green-900">صفحات مؤرشفة</div>
              <div className="text-xl font-bold text-green-700 tabular-nums">{fmt(data?.indexStatus.indexed)}</div>
            </div>
            <div className="flex items-center justify-between rounded-md bg-amber-50 border border-amber-200 p-3">
              <div className="text-sm text-amber-900">غير مؤرشفة</div>
              <div className="text-xl font-bold text-amber-700 tabular-nums">{fmt(data?.indexStatus.notIndexed)}</div>
            </div>
            <div className="flex items-center justify-between rounded-md bg-rose-50 border border-rose-200 p-3">
              <div className="text-sm text-rose-900">أخطاء زحف</div>
              <div className="text-xl font-bold text-rose-700 tabular-nums">{fmt(data?.indexStatus.crawlErrors)}</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ─── 9. AI Alerts ────────────────────────────────────────────── */}
      <div>
        <SectionHeader icon={AlertTriangle} title="تنبيهات الذكاء الاصطناعي" color="text-rose-700" />
        <div className="space-y-2">
          {(data?.alerts ?? []).map((a) => {
            const styles = a.severity === "critical"
              ? "border-rose-300 bg-rose-50/60 text-rose-900"
              : a.severity === "warn"
              ? "border-amber-300 bg-amber-50/60 text-amber-900"
              : "border-blue-300 bg-blue-50/60 text-blue-900";
            const Icon = a.severity === "critical" ? AlertCircle : a.severity === "warn" ? AlertTriangle : Info;
            return (
              <Card key={a.id} className={styles}>
                <CardContent className="p-3 flex items-start gap-3">
                  <Icon className="h-5 w-5 shrink-0 mt-0.5" />
                  <p className="text-sm leading-relaxed">{a.message}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* ─── 10. AI Recommendations ──────────────────────────────────── */}
      <div>
        <SectionHeader icon={Sparkles} title="توصيات الذكاء الاصطناعي" color="text-indigo-700" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {(data?.recommendations ?? []).map((r) => (
            <Card key={r.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <h3 className="font-semibold text-sm leading-snug flex items-start gap-2">
                    <ArrowUpRight className="h-4 w-4 text-indigo-600 shrink-0 mt-0.5" />
                    <span>{r.title}</span>
                  </h3>
                  <Badge
                    variant={r.impact === "high" ? "default" : r.impact === "medium" ? "secondary" : "outline"}
                    className="shrink-0"
                  >
                    {r.impact === "high" ? "أثر عالي" : r.impact === "medium" ? "أثر متوسط" : "أثر منخفض"}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">{r.details}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
