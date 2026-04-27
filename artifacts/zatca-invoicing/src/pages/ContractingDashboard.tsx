import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  HardHat, Briefcase, TrendingUp, Wallet, AlertTriangle, ShieldAlert,
  CheckCircle2, Clock, Activity, ArrowRight,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import ContractingAIAssistant from "@/components/ContractingAIAssistant";

const API = import.meta.env.VITE_API_URL || "";

type DashboardData = {
  totals: {
    total: number; inProgress: number; onHold: number; completed: number;
    delayed: number; contractValueSum: number; plannedBudgetSum: number;
    actualCostSum: number; avgProgress: number;
  };
  risksByStatus: { open: number; mitigating: number; resolved: number; highScore: number };
  recentEvents: Array<{
    id: number; eventType: string; title: string; description: string | null;
    severity: string; createdAt: string; projectId: number | null;
  }>;
  topRisks: Array<{
    id: number; title: string; category: string; likelihood: string; impact: string;
    score: number; status: string; projectId: number;
  }>;
};

export default function ContractingDashboard() {
  const { t } = useTranslation();
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/contracting/dashboard`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
    } catch (e: any) {
      toast({ title: t("common.errorOccurred", "حدث خطأ"), description: e?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [token, t, toast]);

  useEffect(() => { void load(); }, [load]);

  const fmt = (n: number) => Number(n || 0).toLocaleString("ar-SA", { maximumFractionDigits: 0 });
  const fmtPct = (n: number) => `${Number(n || 0).toFixed(1)}%`;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="rounded-xl bg-gradient-to-br from-orange-500 to-amber-500 p-2 text-white shadow">
          <HardHat className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{t("contracting.dashboard.title", "لوحة المقاولات")}</h1>
          <p className="text-sm text-slate-500">{t("contracting.dashboard.subtitle", "نظرة شاملة على مشاريع المقاولات والمخاطر والمستخلصات")}</p>
        </div>
        <Link href="/contracting/projects">
          <Button>{t("contracting.dashboard.openProjects", "فتح المشاريع")} <ArrowRight className="h-4 w-4 mx-1" /></Button>
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi icon={<Briefcase className="h-5 w-5" />} label={t("contracting.dashboard.totalProjects", "إجمالي المشاريع")}
                 value={data?.totals.total ?? 0} tone="violet" loading={loading && !data} />
            <Kpi icon={<Activity className="h-5 w-5" />} label={t("contracting.dashboard.inProgress", "قيد التنفيذ")}
                 value={data?.totals.inProgress ?? 0} tone="emerald" loading={loading && !data} />
            <Kpi icon={<Clock className="h-5 w-5" />} label={t("contracting.dashboard.delayed", "متأخرة")}
                 value={data?.totals.delayed ?? 0} tone="amber" loading={loading && !data} />
            <Kpi icon={<CheckCircle2 className="h-5 w-5" />} label={t("contracting.dashboard.completed", "مكتملة")}
                 value={data?.totals.completed ?? 0} tone="indigo" loading={loading && !data} />

            <Kpi icon={<Wallet className="h-5 w-5" />} label={t("contracting.dashboard.contractValueSum", "إجمالي قيمة العقود")}
                 value={fmt(data?.totals.contractValueSum ?? 0) + " ر.س"} tone="violet" loading={loading && !data} />
            <Kpi icon={<TrendingUp className="h-5 w-5" />} label={t("contracting.dashboard.plannedBudgetSum", "الميزانية المخططة")}
                 value={fmt(data?.totals.plannedBudgetSum ?? 0) + " ر.س"} tone="emerald" loading={loading && !data} />
            <Kpi icon={<Wallet className="h-5 w-5" />} label={t("contracting.dashboard.actualCostSum", "التكلفة الفعلية")}
                 value={fmt(data?.totals.actualCostSum ?? 0) + " ر.س"} tone="amber" loading={loading && !data} />
            <Kpi icon={<TrendingUp className="h-5 w-5" />} label={t("contracting.dashboard.avgProgress", "متوسط الإنجاز")}
                 value={fmtPct(data?.totals.avgProgress ?? 0)} tone="indigo" loading={loading && !data} />
          </div>

          {/* Risks summary band */}
          <div className="rounded-lg border bg-white dark:bg-slate-900 p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-red-600" />
                <h2 className="font-bold">{t("contracting.dashboard.risksSummary", "ملخص المخاطر")}</h2>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <RiskCell label={t("contracting.dashboard.risksOpen", "مفتوحة")} value={data?.risksByStatus.open ?? 0} color="text-amber-600" />
              <RiskCell label={t("contracting.dashboard.risksMitigating", "قيد المعالجة")} value={data?.risksByStatus.mitigating ?? 0} color="text-blue-600" />
              <RiskCell label={t("contracting.dashboard.risksResolved", "مغلقة")} value={data?.risksByStatus.resolved ?? 0} color="text-emerald-600" />
              <RiskCell label={t("contracting.dashboard.risksHigh", "حرجة")} value={data?.risksByStatus.highScore ?? 0} color="text-red-600" />
            </div>
          </div>

          {/* Top risks list */}
          <div className="rounded-lg border bg-white dark:bg-slate-900 p-4">
            <h2 className="font-bold mb-3 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              {t("contracting.dashboard.topRisks", "أعلى 5 مخاطر")}
            </h2>
            {loading && !data && <Skeleton className="h-32 w-full" />}
            {data && data.topRisks.length === 0 && (
              <div className="text-sm text-slate-500">{t("contracting.dashboard.noRisks", "لا توجد مخاطر مسجلة بعد")}</div>
            )}
            <div className="space-y-2">
              {data?.topRisks.map(r => (
                <Link key={r.id} href={`/contracting/projects/${r.projectId}`}>
                  <div className="flex items-center justify-between rounded-md border px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer">
                    <div className="flex-1">
                      <div className="font-medium text-sm">{r.title}</div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {r.category} • {t("contracting.risks.likelihood", "الاحتمال")}: {r.likelihood} • {t("contracting.risks.impact", "الأثر")}: {r.impact}
                      </div>
                    </div>
                    <div className={`rounded-full px-2 py-0.5 text-xs font-bold ${r.score >= 6 ? "bg-red-100 text-red-700" : r.score >= 4 ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>
                      {r.score}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>

          {/* Recent events timeline */}
          <div className="rounded-lg border bg-white dark:bg-slate-900 p-4">
            <h2 className="font-bold mb-3">{t("contracting.dashboard.recentEvents", "آخر الأحداث")}</h2>
            {loading && !data && <Skeleton className="h-40 w-full" />}
            {data && data.recentEvents.length === 0 && (
              <div className="text-sm text-slate-500">{t("contracting.dashboard.noEvents", "لا توجد أحداث بعد")}</div>
            )}
            <div className="space-y-1.5">
              {data?.recentEvents.slice(0, 10).map(e => (
                <div key={e.id} className="flex items-start gap-2 text-sm py-1.5 border-b last:border-0">
                  <div className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${
                    e.severity === "error" ? "bg-red-500" :
                    e.severity === "warn"  ? "bg-amber-500" : "bg-emerald-500"
                  }`} />
                  <div className="flex-1">
                    <div className="font-medium">{e.title}</div>
                    {e.description && <div className="text-[11px] text-slate-500">{e.description}</div>}
                    <div className="text-[10px] text-slate-400 mt-0.5">{new Date(e.createdAt).toLocaleString("ar-SA")}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <ContractingAIAssistant screenContext="contracting.dashboard" currentAction="reviewing contracting KPIs" />
        </div>
      </div>
    </div>
  );
}

function Kpi({ icon, label, value, tone, loading }: {
  icon: React.ReactNode; label: string; value: React.ReactNode;
  tone: "violet" | "emerald" | "amber" | "indigo"; loading?: boolean;
}) {
  const toneCls: Record<typeof tone, string> = {
    violet:  "from-violet-500 to-fuchsia-500",
    emerald: "from-emerald-500 to-teal-500",
    amber:   "from-amber-500 to-orange-500",
    indigo:  "from-indigo-500 to-blue-500",
  };
  return (
    <div className="rounded-lg border bg-white dark:bg-slate-900 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] text-slate-500 truncate">{label}</div>
          <div className="text-lg font-bold mt-1">{loading ? <Skeleton className="h-6 w-16" /> : value}</div>
        </div>
        <div className={`rounded-md bg-gradient-to-br ${toneCls[tone]} p-1.5 text-white shrink-0`}>{icon}</div>
      </div>
    </div>
  );
}

function RiskCell({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
    </div>
  );
}
