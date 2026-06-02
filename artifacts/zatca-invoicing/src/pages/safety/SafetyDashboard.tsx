import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  ShieldAlert, AlertTriangle, Activity, CalendarClock, ClipboardList,
  HeartPulse, Skull, ListChecks,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { safetyApi, type SafetyKpis } from "@/lib/safetyApi";

const RISK_COLORS: Record<string, string> = {
  low: "bg-emerald-100 text-emerald-700",
  medium: "bg-amber-100 text-amber-700",
  high: "bg-orange-100 text-orange-700",
  critical: "bg-red-100 text-red-700",
};
const RISK_LABELS: Record<string, string> = {
  low: "منخفض", medium: "متوسط", high: "عالٍ", critical: "حرج",
};

function fmt(n: number | null, digits = 2): string {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export default function SafetyDashboard() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [kpis, setKpis] = useState<SafetyKpis | null>(null);
  const [loading, setLoading] = useState(false);
  const [manHours, setManHours] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const mh = Number(manHours);
      const data = await safetyApi.kpis(
        Number.isFinite(mh) && mh > 0 ? { manHours: mh } : {},
      );
      setKpis(data);
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [token, manHours, toast]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Re-fetch the rate metrics 400ms after the man-hours field settles.
  useEffect(() => {
    const id = setTimeout(() => { if (token) void load(); }, 400);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manHours]);

  const inc = kpis?.incidents;
  const risks = kpis?.risks;
  const capa = kpis?.capa;
  const rates = kpis?.rates;

  const riskBars = useMemo(() => {
    const by = risks?.byLevel ?? { low: 0, medium: 0, high: 0, critical: 0 };
    const total = Math.max(1, (by.low ?? 0) + (by.medium ?? 0) + (by.high ?? 0) + (by.critical ?? 0));
    return (["critical", "high", "medium", "low"] as const).map((lvl) => ({
      lvl, count: by[lvl] ?? 0, pct: Math.round(((by[lvl] ?? 0) / total) * 100),
    }));
  }, [risks]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-gradient-to-br from-red-500 to-rose-600 p-2 text-white shadow">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">لوحة السلامة والصحة المهنية</h1>
            <p className="text-sm text-slate-500">
              مؤشرات الأداء وفق ISO 45001:2018 — معدلات الإصابات المسجَّلة (TRIR)
              وتكرار الإصابات بفقد الوقت (LTIFR) ومعدل الشدة وأيام منذ آخر إصابة.
            </p>
          </div>
        </div>
        <div className="flex items-end gap-2">
          <div>
            <Label className="text-xs">ساعات العمل (للفترة)</Label>
            <Input
              type="number"
              min={0}
              value={manHours}
              onChange={(e) => setManHours(e.target.value)}
              placeholder="مثال: 200000"
              className="w-44"
              data-testid="input-man-hours"
            />
          </div>
        </div>
      </div>

      {loading && !kpis ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
      ) : (
        <>
          {/* Incident counters */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard icon={<AlertTriangle className="h-5 w-5" />} tone="red"
              label="إجمالي الحوادث" value={String(inc?.total ?? 0)} testid="kpi-total-incidents" />
            <StatCard icon={<Activity className="h-5 w-5" />} tone="amber"
              label="حوادث وشيكة (Near-miss)" value={String(inc?.nearMiss ?? 0)} testid="kpi-near-miss" />
            <StatCard icon={<HeartPulse className="h-5 w-5" />} tone="orange"
              label="حوادث مسجَّلة (Recordable)" value={String(inc?.recordable ?? 0)} testid="kpi-recordable" />
            <StatCard icon={<Skull className="h-5 w-5" />} tone="rose"
              label="إصابات بفقد الوقت / وفيات" value={String(inc?.lostTime ?? 0)} testid="kpi-lost-time" />
          </div>

          {/* Rate metrics + days since LTI */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard icon={<CalendarClock className="h-5 w-5" />} tone="emerald"
              label="أيام منذ آخر إصابة بفقد الوقت"
              value={kpis?.daysSinceLastLti == null ? "—" : String(kpis.daysSinceLastLti)}
              testid="kpi-days-since-lti" />
            <StatCard icon={<Activity className="h-5 w-5" />} tone="blue"
              label="TRIR (معدل الإصابات المسجَّلة)" value={fmt(rates?.trir ?? null)}
              hint="× 200,000 ساعة" testid="kpi-trir" />
            <StatCard icon={<Activity className="h-5 w-5" />} tone="blue"
              label="LTIFR (تكرار الإصابات)" value={fmt(rates?.ltifr ?? null)}
              hint="× 1,000,000 ساعة" testid="kpi-ltifr" />
            <StatCard icon={<Activity className="h-5 w-5" />} tone="blue"
              label="معدل الشدة (أيام مفقودة)" value={fmt(rates?.severityRate ?? null)}
              hint="× 1,000,000 ساعة" testid="kpi-severity-rate" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Risk register snapshot */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <ClipboardList className="h-4 w-4 text-red-600" /> سجل المخاطر
                </CardTitle>
                <span className="text-xs text-slate-500">
                  {risks?.open ?? 0} مفتوح من {risks?.total ?? 0}
                </span>
              </CardHeader>
              <CardContent className="space-y-2">
                {(risks?.total ?? 0) === 0 ? (
                  <p className="text-sm text-slate-400 py-4 text-center">لا توجد تقييمات مخاطر بعد.</p>
                ) : (
                  riskBars.map((b) => (
                    <div key={b.lvl} className="flex items-center gap-2">
                      <span className={`text-xs w-14 rounded px-1.5 py-0.5 text-center ${RISK_COLORS[b.lvl]}`}>
                        {RISK_LABELS[b.lvl]}
                      </span>
                      <div className="flex-1 h-3 rounded bg-slate-100 overflow-hidden">
                        <div
                          className={`h-full ${RISK_COLORS[b.lvl].split(" ")[0]}`}
                          style={{ width: `${b.pct}%` }}
                        />
                      </div>
                      <span className="text-xs w-8 text-end font-medium">{b.count}</span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            {/* CAPA snapshot */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <ListChecks className="h-4 w-4 text-red-600" /> الإجراءات التصحيحية والوقائية (CAPA)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="rounded-lg bg-slate-50 p-3">
                    <div className="text-2xl font-bold">{capa?.total ?? 0}</div>
                    <div className="text-xs text-slate-500 mt-1">الإجمالي</div>
                  </div>
                  <div className="rounded-lg bg-amber-50 p-3">
                    <div className="text-2xl font-bold text-amber-700">{capa?.open ?? 0}</div>
                    <div className="text-xs text-slate-500 mt-1">مفتوحة</div>
                  </div>
                  <div className="rounded-lg bg-red-50 p-3">
                    <div className="text-2xl font-bold text-red-700">{capa?.overdue ?? 0}</div>
                    <div className="text-xs text-slate-500 mt-1">متأخرة</div>
                  </div>
                </div>
                <p className="text-xs text-slate-400 mt-3">
                  إجمالي أيام العمل المفقودة بسبب الإصابات: <strong>{inc?.totalLostDays ?? 0}</strong> يوم.
                </p>
              </CardContent>
            </Card>
          </div>

          <p className="text-xs text-slate-400">
            أدخل إجمالي ساعات العمل خلال الفترة لحساب المعدلات النسبية (TRIR / LTIFR / الشدة).
            بدون ساعات العمل تظهر هذه المؤشرات كـ «—» لتجنّب أرقام مضلِّلة.
          </p>
        </>
      )}
    </div>
  );
}

function StatCard({
  icon, label, value, tone, hint, testid,
}: {
  icon: React.ReactNode; label: string; value: string;
  tone: "red" | "amber" | "orange" | "rose" | "emerald" | "blue";
  hint?: string; testid?: string;
}) {
  const tones: Record<string, string> = {
    red: "from-red-500 to-rose-600",
    amber: "from-amber-400 to-amber-600",
    orange: "from-orange-400 to-orange-600",
    rose: "from-rose-500 to-pink-600",
    emerald: "from-emerald-400 to-emerald-600",
    blue: "from-sky-400 to-blue-600",
  };
  return (
    <Card data-testid={testid}>
      <CardContent className="p-4 flex items-center gap-3">
        <div className={`rounded-lg bg-gradient-to-br ${tones[tone]} p-2 text-white shrink-0`}>
          {icon}
        </div>
        <div className="min-w-0">
          <div className="text-2xl font-bold leading-tight">{value}</div>
          <div className="text-xs text-slate-500 truncate">{label}</div>
          {hint && <div className="text-[10px] text-slate-400">{hint}</div>}
        </div>
      </CardContent>
    </Card>
  );
}
