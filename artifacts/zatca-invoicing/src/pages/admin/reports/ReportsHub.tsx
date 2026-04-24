import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft, BarChart3, Activity, Gauge, PieChart as PieIcon,
  Loader2, Building2, Wallet,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

interface SummaryResp {
  period: { from: string; to: string };
  revenueMonth: number;
  billedActive: number;
  activeCompanies: number;
  overLimitSubs: number;
}

const fmtSAR = (n: number) =>
  new Intl.NumberFormat("ar-SA", { style: "currency", currency: "SAR", maximumFractionDigits: 0 }).format(n);

const REPORTS = [
  {
    href: "/admin/reports/company-performance",
    title: "أداء الشركات",
    desc: "مقارنة الإيرادات وعدد الفواتير ومتوسط الفاتورة ونسبة النمو بين كل الشركات.",
    icon: BarChart3,
    color: "from-sky-50 to-sky-100/40 text-sky-700 border-sky-200",
    previewKey: "revenueMonth" as const,
    previewLabel: "إجمالي الإيرادات هذا الشهر",
    previewFmt: (s: SummaryResp) => fmtSAR(s.revenueMonth),
  },
  {
    href: "/admin/reports/operational-summary",
    title: "الملخص التشغيلي",
    desc: "صحة كل شركة: العملاء، الموردون، الأصناف، جلسات نقاط البيع، النشاط، النسخ الاحتياطية.",
    icon: Activity,
    color: "from-emerald-50 to-emerald-100/40 text-emerald-700 border-emerald-200",
    previewKey: "activeCompanies" as const,
    previewLabel: "شركات نشطة",
    previewFmt: (s: SummaryResp) => `${s.activeCompanies}`,
  },
  {
    href: "/admin/reports/plan-usage",
    title: "استخدام الباقات",
    desc: "الفعلي مقابل المسموح لكل اشتراك (مستخدمون، فروع، مخازن، فواتير) مع تنبيهات التجاوز.",
    icon: Gauge,
    color: "from-amber-50 to-amber-100/40 text-amber-700 border-amber-200",
    previewKey: "overLimitSubs" as const,
    previewLabel: "اشتراكات تجاوزت الحدود",
    previewFmt: (s: SummaryResp) => `${s.overLimitSubs}`,
  },
  {
    href: "/admin/reports/revenue-by-plan",
    title: "الإيرادات حسب الباقة",
    desc: "توزيع إجمالي الفوترة حسب الباقة ودورة الفوترة في رسم بياني وجدول.",
    icon: PieIcon,
    color: "from-purple-50 to-purple-100/40 text-purple-700 border-purple-200",
    previewKey: "billedActive" as const,
    previewLabel: "إجمالي الفوترة من الاشتراكات النشطة",
    previewFmt: (s: SummaryResp) => fmtSAR(s.billedActive),
  },
];

export default function ReportsHub() {
  const { token } = useAuth();
  const { data, isLoading, error } = useQuery<SummaryResp>({
    queryKey: ["reports-summary"],
    queryFn: async () => {
      const r = await fetch("/api/admin/reports/summary", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "تعذر التحميل");
      return r.json();
    },
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  return (
    <div className="space-y-6" dir="rtl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-primary" /> تقارير عابرة للشركات
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          تقارير المشرف العام التي تقارن الأداء والاستخدام والإيرادات بين كل شركات النظام.
        </p>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <SummaryStat
          icon={Wallet}
          label="إيرادات هذا الشهر"
          value={data ? fmtSAR(data.revenueMonth) : "—"}
          loading={isLoading}
        />
        <SummaryStat
          icon={Wallet}
          label="فوترة الاشتراكات النشطة"
          value={data ? fmtSAR(data.billedActive) : "—"}
          loading={isLoading}
        />
        <SummaryStat
          icon={Building2}
          label="شركات نشطة"
          value={data ? `${data.activeCompanies}` : "—"}
          loading={isLoading}
        />
        <SummaryStat
          icon={Gauge}
          label="اشتراكات متجاوزة"
          value={data ? `${data.overLimitSubs}` : "—"}
          loading={isLoading}
          accent={data && data.overLimitSubs > 0 ? "warn" : undefined}
        />
      </div>

      {error && (
        <div className="text-rose-700 bg-rose-50 border border-rose-200 rounded p-3 text-sm">
          {(error as Error).message}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {REPORTS.map(r => (
          <Link key={r.href} href={r.href}>
            <a className={`group rounded-xl border bg-gradient-to-br ${r.color} p-5 transition-all hover:shadow-md hover:-translate-y-0.5 cursor-pointer block`}>
              <div className="flex items-start justify-between mb-3">
                <r.icon className="h-7 w-7" />
                <ChevronLeft className="h-4 w-4 opacity-40 group-hover:opacity-100 group-hover:-translate-x-1 transition-all" />
              </div>
              <h3 className="text-base font-bold mb-1.5">{r.title}</h3>
              <p className="text-xs opacity-80 leading-relaxed mb-3">{r.desc}</p>
              <div className="text-xs bg-white/60 rounded px-2 py-1.5 flex items-center justify-between">
                <span className="text-muted-foreground">{r.previewLabel}</span>
                <span className="font-bold tabular-nums">
                  {isLoading ? <Loader2 className="h-3 w-3 animate-spin inline" /> : data ? r.previewFmt(data) : "—"}
                </span>
              </div>
            </a>
          </Link>
        ))}
      </div>
    </div>
  );
}

function SummaryStat({
  icon: Icon, label, value, loading, accent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string; value: string; loading?: boolean; accent?: "warn";
}) {
  const accentClass = accent === "warn" ? "border-amber-300 bg-amber-50" : "bg-card";
  return (
    <div className={`border rounded-lg p-3 ${accentClass}`}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <div className="text-lg font-bold tabular-nums">
        {loading ? <Loader2 className="h-4 w-4 animate-spin inline" /> : value}
      </div>
    </div>
  );
}
