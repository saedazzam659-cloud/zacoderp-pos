import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Building2, Clock, CheckCircle2, XCircle, Users, ArrowLeft, Plus, Package,
  TrendingUp, TrendingDown, AlertTriangle, ShieldCheck, ShieldAlert,
  HardDrive, ScrollText, Activity, LineChart as LineChartIcon, PieChart as PieChartIcon,
  KeyRound, Inbox, BarChart3, Wrench, FileBarChart, Sparkles,
  type LucideIcon,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip,
  PieChart, Pie, Cell, Legend,
} from "recharts";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─── Local view-model types ──────────────────────────────────────────────
type QuickLink = {
  title: string;
  desc: string;
  href: string;
  icon: LucideIcon;
  bg: string;
  color: string;
  /** When true, render as a disabled placeholder with a "قريباً" badge. */
  soon?: boolean;
};

// Recharts tooltip "payload" carries the original datum; we destructure
// only the known fields below (name + revenue for plan slice tooltips).
type PlanDatum = { name: string; plan: string; value: number; revenue: number };
type SignupDatum = { day: string; count: number };

// ─── Types matching the /api/admin/dashboard payload ─────────────────────
interface DashboardData {
  companies: {
    total: number; active: number; pending: number; rejected: number; suspended: number;
    signupsThisWeek: number; signupsLastWeek: number; signupsDelta: number;
  };
  users: { total: number; activeToday: number; superadmins: number; admins: number };
  subscriptions: {
    active: number; expiring: number; expired: number; revenue: number;
    byPlan: { plan: string; count: number; revenue: number }[];
  };
  backups: {
    last7d: number; totalSizeBytes: number; distinctCompanies7d: number;
    missingCount: number;
    missing: { id: number; nameAr: string; lastBackup: string | null }[];
  };
  audit: { eventsToday: number; denied7d: number; logins24h: number };
  signupsTimeline: { day: string; count: number }[];
  health: { level: "red" | "amber" | "green"; message: string; href?: string }[];
  generatedAt: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────
function formatBytes(n: number): string {
  if (n < 1024)            return `${n} B`;
  if (n < 1024 * 1024)     return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3)       return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatSAR(n: number): string {
  return `${n.toLocaleString("ar-SA", { maximumFractionDigits: 0 })} ر.س`;
}

const PLAN_LABEL_AR: Record<string, string> = {
  starter: "مبتدئ",
  professional: "احترافي",
  enterprise: "مؤسسي",
  custom: "مخصص",
};

const PLAN_COLORS: Record<string, string> = {
  starter:      "#60a5fa", // blue-400
  professional: "#8b5cf6", // violet-500
  enterprise:   "#f59e0b", // amber-500
  custom:       "#94a3b8", // slate-400
};

// Reusable KPI tile
function KpiTile({
  label, value, icon: Icon, color = "text-foreground", bg = "bg-muted",
  delta, deltaLabel, alert,
}: {
  label: string;
  value: string | number;
  icon: LucideIcon;
  color?: string;
  bg?: string;
  delta?: number;
  deltaLabel?: string;
  alert?: boolean;
}) {
  return (
    <Card className={alert ? "border-amber-300 bg-amber-50/50" : ""}>
      <CardContent className="pt-4 pb-3 px-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground truncate">{label}</p>
            <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
            {delta !== undefined && (
              <div className={`flex items-center gap-1 mt-1 text-[11px] ${
                delta > 0 ? "text-green-700" : delta < 0 ? "text-rose-700" : "text-muted-foreground"
              }`}>
                {delta > 0 ? <TrendingUp className="h-3 w-3" /> :
                 delta < 0 ? <TrendingDown className="h-3 w-3" /> : null}
                <span>{delta > 0 ? `+${delta}` : delta} {deltaLabel ?? ""}</span>
              </div>
            )}
          </div>
          <div className={`h-9 w-9 rounded-xl flex items-center justify-center shrink-0 ${bg}`}>
            <Icon className={`h-4.5 w-4.5 ${color}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Reusable category section header
function CategoryHeader({ icon: Icon, label, color }: { icon: LucideIcon; label: string; color: string }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <Icon className={`h-4 w-4 ${color}`} />
      <h2 className="text-sm font-semibold text-foreground">{label}</h2>
    </div>
  );
}

export default function SuperAdminDashboard() {
  const { token } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };

  // Single consolidated query — every figure on this page is computed
  // server-side in /api/admin/dashboard. Pending-request preview lives in
  // the System Health card (with a direct link), so no second query is
  // needed.
  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ["admin-dashboard"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/admin/dashboard`, { headers });
      if (!res.ok) throw new Error("فشل تحميل بيانات اللوحة");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const c = data?.companies;
  const u = data?.users;
  const s = data?.subscriptions;
  const b = data?.backups;
  const a = data?.audit;
  const fmt = (n?: number) => (n === undefined ? "—" : n.toLocaleString("ar-SA"));

  // Plan distribution data for the donut chart
  const planChartData = (s?.byPlan ?? []).map(p => ({
    name: PLAN_LABEL_AR[p.plan] ?? p.plan,
    plan: p.plan,
    value: p.count,
    revenue: p.revenue,
  }));

  // Signups timeline — Recharts wants short labels
  const signupChartData = (data?.signupsTimeline ?? []).map(d => ({
    day:   d.day.slice(5), // MM-DD
    count: d.count,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-foreground">لوحة التحكم الرئيسية</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            مركز التحكم — نظرة شاملة على الشركات، الاشتراكات، النشاط، والصحة العامة للنظام
          </p>
        </div>
        {data?.generatedAt && (
          <p className="text-[11px] text-muted-foreground">
            آخر تحديث: {new Date(data.generatedAt).toLocaleString("ar-SA")}
          </p>
        )}
      </div>

      {/* ─── System Health Card ───────────────────────────────────────── */}
      {data && (
        <Card className={
          data.health.some(h => h.level === "red") ? "border-rose-300 bg-rose-50/40" :
          data.health.some(h => h.level === "amber") ? "border-amber-300 bg-amber-50/40" :
          "border-green-300 bg-green-50/40"
        }>
          <CardHeader className="pb-2 pt-4">
            <CardTitle className="text-base flex items-center gap-2">
              {data.health.some(h => h.level === "red")
                ? <><ShieldAlert className="h-4 w-4 text-rose-700" /> <span className="text-rose-800">صحة النظام — تحتاج انتباه</span></>
                : data.health.some(h => h.level === "amber")
                ? <><ShieldAlert className="h-4 w-4 text-amber-700" /> <span className="text-amber-800">صحة النظام — تنبيهات</span></>
                : <><ShieldCheck  className="h-4 w-4 text-green-700" /> <span className="text-green-800">صحة النظام — على ما يرام</span></>}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 pb-4">
            <div className="space-y-2">
              {data.health.map((h, i) => (
                <div key={i} className={`flex items-center justify-between gap-3 text-sm ${
                  h.level === "red"   ? "text-rose-800" :
                  h.level === "amber" ? "text-amber-800" :
                                        "text-green-800"
                }`}>
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${
                      h.level === "red"   ? "bg-rose-600" :
                      h.level === "amber" ? "bg-amber-500" :
                                            "bg-green-600"
                    }`} />
                    <span>{h.message}</span>
                  </div>
                  {h.href && (
                    <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1">
                      <Link href={h.href}>فتح <ArrowLeft className="h-3 w-3" /></Link>
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Companies row ────────────────────────────────────────────── */}
      <div>
        <CategoryHeader icon={Building2} label="الشركات" color="text-primary" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiTile
            label="إجمالي الشركات" value={fmt(c?.total)}
            icon={Building2} color="text-primary" bg="bg-primary/10"
            delta={c?.signupsDelta} deltaLabel="هذا الأسبوع"
          />
          <KpiTile
            label="نشطة" value={fmt(c?.active)}
            icon={CheckCircle2} color="text-green-700" bg="bg-green-100"
          />
          <KpiTile
            label="طلبات معلقة" value={fmt(c?.pending)}
            icon={Clock} color="text-amber-700" bg="bg-amber-100"
            alert={(c?.pending ?? 0) > 0}
          />
          <KpiTile
            label="مرفوضة" value={fmt(c?.rejected)}
            icon={XCircle} color="text-rose-700" bg="bg-rose-100"
          />
        </div>
      </div>

      {/* ─── Subscriptions row ───────────────────────────────────────── */}
      <div>
        <CategoryHeader icon={Package} label="الاشتراكات" color="text-violet-700" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiTile
            label="اشتراكات نشطة" value={fmt(s?.active)}
            icon={Package} color="text-violet-700" bg="bg-violet-100"
          />
          <KpiTile
            label="تنتهي خلال 30 يوم" value={fmt(s?.expiring)}
            icon={Clock} color="text-amber-700" bg="bg-amber-100"
            alert={(s?.expiring ?? 0) > 0}
          />
          <KpiTile
            label="منتهية" value={fmt(s?.expired)}
            icon={XCircle} color="text-rose-700" bg="bg-rose-100"
            alert={(s?.expired ?? 0) > 0}
          />
          <KpiTile
            label="إيراد شهري متوقع" value={s ? formatSAR(s.revenue) : "—"}
            icon={TrendingUp} color="text-green-700" bg="bg-green-100"
          />
        </div>
      </div>

      {/* ─── Activity & Health row ──────────────────────────────────── */}
      <div>
        <CategoryHeader icon={Activity} label="النشاط والصحة" color="text-blue-700" />
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <KpiTile
            label="إجمالي المستخدمين" value={fmt(u?.total)}
            icon={Users} color="text-blue-700" bg="bg-blue-100"
          />
          <KpiTile
            label="نشطون آخر 24 ساعة" value={fmt(u?.activeToday)}
            icon={Activity} color="text-blue-700" bg="bg-blue-100"
          />
          <KpiTile
            label="نسخ احتياطي (7 أيام)" value={fmt(b?.last7d)}
            icon={HardDrive} color="text-emerald-700" bg="bg-emerald-100"
          />
          <KpiTile
            label="أحداث اليوم" value={fmt(a?.eventsToday)}
            icon={ScrollText} color="text-slate-700" bg="bg-slate-100"
          />
          <KpiTile
            label="رفض وصول (7 أيام)" value={fmt(a?.denied7d)}
            icon={ShieldAlert} color="text-rose-700" bg="bg-rose-100"
            alert={(a?.denied7d ?? 0) >= 5}
          />
        </div>
      </div>

      {/* ─── Charts row: signups timeline + plan distribution ────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Signups timeline (90 days) */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <LineChartIcon className="h-4 w-4 text-primary" />
              تسجيلات الشركات — آخر 90 يوماً
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            {signupChartData.length === 0 ? (
              <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">
                لا توجد تسجيلات في آخر 90 يوماً
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={signupChartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <XAxis dataKey="day" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 10 }} allowDecimals={false} width={28} />
                  <Tooltip
                    formatter={(value: number | string) => [`${value} شركة`, "الجديد"]}
                    labelFormatter={(label) => `يوم ${label}`}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <Bar dataKey="count" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Plan distribution donut */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <PieChartIcon className="h-4 w-4 text-violet-700" />
              توزيع الباقات
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            {planChartData.length === 0 ? (
              <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">
                لا توجد اشتراكات نشطة
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={planChartData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%" cy="50%"
                    innerRadius={45} outerRadius={75}
                    paddingAngle={2}
                  >
                    {planChartData.map((entry, i) => (
                      <Cell key={i} fill={PLAN_COLORS[entry.plan] ?? "#94a3b8"} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: number | string, _name: string, item: { payload?: PlanDatum }) => {
                      const p = item.payload;
                      return [
                        `${value} شركة • ${formatSAR(p?.revenue ?? 0)}`,
                        p?.name ?? "",
                      ];
                    }}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ─── Quick links to every SuperAdmin area ─────────────────────── */}
      {/* Includes the four Control-Center pillars (Backups / Security /     */}
      {/* Reports / Maintenance) — those that are not yet built carry a      */}
      {/* "قريباً" badge but still appear so navigation is discoverable.    */}
      <div>
        <CategoryHeader icon={LineChartIcon} label="روابط سريعة" color="text-foreground" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[
            // ── Existing screens ──────────────────────────────────────
            { title: "طلبات التسجيل", desc: (c?.pending ?? 0) > 0 ? `${c?.pending} طلب بانتظار المراجعة` : "لا توجد طلبات معلقة",
              href: "/admin/requests", icon: Clock, bg: "bg-amber-100", color: "text-amber-700" },
            { title: "إدارة الاشتراكات والباقات", desc: `${s?.active ?? 0} اشتراك نشط${(s?.expiring ?? 0) > 0 ? ` • ${s?.expiring} ينتهي قريباً` : ""}`,
              href: "/admin/subscriptions", icon: Package, bg: "bg-violet-100", color: "text-violet-700" },
            { title: "التراخيص", desc: "إصدار وإدارة تراخيص الشركات",
              href: "/admin/licenses", icon: KeyRound, bg: "bg-blue-100", color: "text-blue-700" },
            // ── Control-Center pillars ────────────────────────────────
            { title: "مركز النسخ الاحتياطي", desc: `${b?.last7d ?? 0} نسخة آخر 7 أيام${(b?.missingCount ?? 0) > 0 ? ` • ${b?.missingCount} شركة متأخرة` : ""}`,
              href: "/admin/backups", icon: HardDrive, bg: "bg-emerald-100", color: "text-emerald-700", soon: true },
            { title: "مركز الأمان", desc: `${a?.logins24h ?? 0} دخول • ${a?.denied7d ?? 0} رفض (7 أيام)`,
              href: "/admin/security", icon: ShieldCheck, bg: "bg-rose-100", color: "text-rose-700", soon: true },
            { title: "تقارير عابرة للشركات", desc: "أداء وتشغيل وباقات",
              href: "/admin/reports", icon: FileBarChart, bg: "bg-indigo-100", color: "text-indigo-700", soon: true },
            { title: "صندوق أدوات الصيانة", desc: "قيود ومراجع ومسلسلات وأدوات سلامة البيانات",
              href: "/admin/ai-fix", icon: Wrench, bg: "bg-slate-100", color: "text-slate-700" },
            // ── Other admin tools ─────────────────────────────────────
            { title: "سجل التدقيق", desc: `${a?.eventsToday ?? 0} حدث اليوم`,
              href: "/admin/audit-log", icon: ScrollText, bg: "bg-slate-100", color: "text-slate-700" },
            { title: "صندوق الدعم الفني", desc: "رسائل وردت من الشركات",
              href: "/admin/support", icon: Inbox, bg: "bg-cyan-100", color: "text-cyan-700" },
            { title: "تنظيف حركات المخزون اليتيمة", desc: "حذف حركات المخزون لفواتير محذوفة",
              href: "/admin/orphan-stock", icon: AlertTriangle, bg: "bg-amber-100", color: "text-amber-700" },
            { title: "أدوات إصلاح الشركة الذكية", desc: "تشخيص ومعالجة مشاكل البيانات",
              href: "/admin/ai-fix", icon: Sparkles, bg: "bg-violet-100", color: "text-violet-700" },
            { title: "صلاحيات القوائم", desc: "إظهار وإخفاء أقسام لكل شركة",
              href: "/admin/menu-permissions", icon: BarChart3, bg: "bg-slate-100", color: "text-slate-700" },
          ].map((qa: QuickLink, i) => {
            const inner = (
              <Card className={`border-dashed border-2 transition-colors h-full ${
                qa.soon ? "opacity-90 hover:border-amber-300" : "hover:border-primary/50 cursor-pointer"
              }`}>
                <CardContent className="pt-4 pb-3 px-4">
                  <div className="flex items-center gap-3">
                    <div className={`h-9 w-9 rounded-xl flex items-center justify-center shrink-0 ${qa.bg}`}>
                      <qa.icon className={`h-4.5 w-4.5 ${qa.color}`} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-sm text-foreground truncate">{qa.title}</p>
                        {qa.soon && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200 shrink-0">
                            قريباً
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{qa.desc}</p>
                    </div>
                    {!qa.soon && <ArrowLeft className="h-4 w-4 text-muted-foreground shrink-0" />}
                  </div>
                </CardContent>
              </Card>
            );
            return qa.soon
              ? <div key={`${qa.href}-${i}`}>{inner}</div>
              : <Link key={`${qa.href}-${i}`} href={qa.href}>{inner}</Link>;
          })}
        </div>
      </div>

      {/* ─── Backup health detail (only when there are missing backups) ─ */}
      {b && b.missingCount > 0 && (
        <Card className="border-amber-200">
          <CardHeader className="border-b bg-amber-50/50 pb-3">
            <CardTitle className="text-base flex items-center gap-2 text-amber-800">
              <HardDrive className="h-4 w-4" />
              شركات بحاجة لنسخة احتياطية ({b.missingCount})
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="space-y-2">
              {b.missing.map(m => (
                <div key={m.id} className="flex items-center justify-between gap-3 py-1.5 border-b last:border-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="h-7 w-7 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center font-bold text-xs shrink-0">
                      {m.nameAr?.[0] ?? "؟"}
                    </div>
                    <span className="text-sm text-foreground truncate">{m.nameAr}</span>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {m.lastBackup
                      ? `آخر نسخة: ${new Date(m.lastBackup).toLocaleDateString("ar-SA")}`
                      : "لم يتم نسخها مطلقاً"}
                  </span>
                </div>
              ))}
            </div>
            {b.missingCount > b.missing.length && (
              <p className="text-xs text-muted-foreground mt-3 text-center">
                و {b.missingCount - b.missing.length} شركة أخرى…
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ─── Loading skeleton ─────────────────────────────────────────── */}
      {isLoading && !data && (
        <Card>
          <CardContent className="pt-5 pb-4 text-center text-sm text-muted-foreground">
            جاري تحميل بيانات اللوحة...
          </CardContent>
        </Card>
      )}
    </div>
  );
}
