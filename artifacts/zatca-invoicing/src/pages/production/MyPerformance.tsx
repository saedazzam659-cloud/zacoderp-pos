import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Trophy, Activity, TrendingUp, TrendingDown, Minus, Award } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DateField } from "@/components/ui/date-field";

const API = import.meta.env.VITE_API_URL || "";

type Operator = {
  operatorUserId: number;
  operatorName: string | null;
  stagesTotal: number;
  stagesCompleted: number;
  avgDurationMins: number;
  totalOutput: number;
  stageWasteQty: number;
  wasteEvents: number;
  wasteQty: number;
  wasteCost: number;
  qcChecks: number;
  qcFails: number;
  qcConditionals: number;
  wasteRatePct: number;
  qcFailRatePct: number;
};

type CompanyAvg = {
  avgStagesCompleted: number;
  avgOutput: number;
  avgWasteRatePct: number;
  avgQcFailRatePct: number;
  avgDurationMins: number;
} | null;

const fmt = (n: number, d = 2) =>
  Number.isFinite(n)
    ? n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 })
    : "0";
const fmtPct = (n: number) => `${fmt(n, 1)}%`;
const fmtMins = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 60) return `${fmt(n, 0)} د`;
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  return m > 0 ? `${h}س ${m}د` : `${h}س`;
};

// "Better than avg" direction depends on metric semantics:
//   higher-is-better → output, stagesCompleted
//   lower-is-better  → wasteRate, qcFailRate, avgDuration
function Comparison({
  mine,
  avg,
  higherIsBetter,
  unit = "",
}: {
  mine: number;
  avg: number;
  higherIsBetter: boolean;
  unit?: string;
}) {
  if (!Number.isFinite(avg) || avg === 0) {
    return <span className="text-xs text-slate-400">— (لا متوسط)</span>;
  }
  const diffPct = ((mine - avg) / avg) * 100;
  const better = higherIsBetter ? diffPct > 0 : diffPct < 0;
  const same = Math.abs(diffPct) < 1;
  const cls = same
    ? "text-slate-500"
    : better
      ? "text-emerald-700"
      : "text-rose-700";
  const Icon = same ? Minus : better ? TrendingUp : TrendingDown;
  const sign = diffPct > 0 ? "+" : "";
  return (
    <span className={`text-xs inline-flex items-center gap-1 ${cls}`}>
      <Icon className="h-3 w-3" />
      متوسط الشركة: {fmt(avg, 1)}{unit} ({sign}{fmt(diffPct, 1)}%)
    </span>
  );
}

export default function MyPerformance() {
  const { token, user } = useAuth() as any;
  const { toast } = useToast();
  const [from, setFrom] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [me, setMe] = useState<Operator | null>(null);
  const [companyAvg, setCompanyAvg] = useState<CompanyAvg>(null);
  const [loading, setLoading] = useState(false);
  const [empty, setEmpty] = useState(false);

  const headers = useMemo(
    () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" }),
    [token],
  );

  const load = useCallback(async () => {
    if (!token || !user?.id) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      params.set("operatorUserId", String(user.id));
      params.set("includeCompanyAvg", "true");
      const r = await fetch(`${API}/api/production/operators/performance?${params}`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const myRow = (data?.operators ?? []).find((o: Operator) => o.operatorUserId === user.id) ?? null;
      setMe(myRow);
      setCompanyAvg(data?.companyAvg ?? null);
      setEmpty(!myRow);
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [token, headers, from, to, toast, user?.id]);

  useEffect(() => { void load(); }, [load]);

  // Achievement badges — simple, fun, encourages engagement.
  const badges = useMemo(() => {
    if (!me) return [];
    const out: { label: string; color: string }[] = [];
    if (me.stagesCompleted >= 50) out.push({ label: "🏆 50+ مرحلة", color: "bg-amber-100 text-amber-800" });
    if (me.stagesCompleted >= 100) out.push({ label: "🎖️ 100+ مرحلة", color: "bg-indigo-100 text-indigo-800" });
    if (me.qcChecks >= 20 && me.qcFailRatePct < 5) out.push({ label: "✨ جودة عالية (<5%)", color: "bg-emerald-100 text-emerald-800" });
    if (me.wasteRatePct > 0 && me.wasteRatePct < 3) out.push({ label: "♻️ هدر منخفض (<3%)", color: "bg-emerald-100 text-emerald-800" });
    if (companyAvg && me.totalOutput > companyAvg.avgOutput * 1.5)
      out.push({ label: "🚀 أعلى من المتوسط بـ 50%+", color: "bg-rose-100 text-rose-800" });
    return out;
  }, [me, companyAvg]);

  return (
    <div className="container mx-auto p-4 space-y-4" dir="rtl">
      <div className="flex items-center gap-3">
        <Trophy className="h-6 w-6 text-amber-500" />
        <div>
          <h1 className="text-2xl font-bold">أدائي</h1>
          <p className="text-sm text-slate-500">
            مرحباً {user?.name ?? "بك"} — تقرير أدائك الشخصي مقارنةً بمتوسط الشركة
          </p>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-3 flex flex-wrap items-end gap-3">
          <div>
            <Label className="text-xs">من تاريخ</Label>
            <DateField value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">إلى تاريخ</Label>
            <DateField value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button onClick={() => void load()} disabled={loading} data-testid="btn-refresh-my-perf">
            تحديث
          </Button>
        </CardContent>
      </Card>

      {/* Badges */}
      {badges.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/40">
          <CardContent className="p-3 flex flex-wrap items-center gap-2">
            <Award className="h-5 w-5 text-amber-600" />
            <span className="text-sm font-bold text-amber-900 me-2">إنجازاتك:</span>
            {badges.map((b, i) => (
              <Badge key={i} className={b.color + " hover:" + b.color}>{b.label}</Badge>
            ))}
          </CardContent>
        </Card>
      )}

      {loading && !me && !empty && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => (<Skeleton key={i} className="h-24" />))}
        </div>
      )}

      {empty && !loading && (
        <Card>
          <CardContent className="p-8 text-center text-slate-500">
            <Activity className="h-10 w-10 mx-auto mb-2 opacity-40" />
            لا توجد بيانات أداء لك في المدى الزمني المحدد.
            <div className="text-xs mt-1">جرّب توسيع المدى أو تحقق من تخصيصك على مراحل الإنتاج.</div>
          </CardContent>
        </Card>
      )}

      {me && (
        <>
          {/* Personal KPIs with comparison */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <Card>
              <CardContent className="p-3 space-y-1">
                <div className="text-xs text-emerald-600">مراحل مكتملة</div>
                <div className="text-3xl font-bold text-emerald-700">{fmt(me.stagesCompleted, 0)}</div>
                <div className="text-xs text-slate-500">من إجمالي {fmt(me.stagesTotal, 0)}</div>
                {companyAvg && (
                  <Comparison mine={me.stagesCompleted} avg={companyAvg.avgStagesCompleted} higherIsBetter />
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3 space-y-1">
                <div className="text-xs text-indigo-600">إجمالي إنتاجي</div>
                <div className="text-3xl font-bold text-indigo-700">{fmt(me.totalOutput)}</div>
                <div className="text-xs text-slate-500">وحدة</div>
                {companyAvg && (
                  <Comparison mine={me.totalOutput} avg={companyAvg.avgOutput} higherIsBetter />
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3 space-y-1">
                <div className="text-xs text-rose-600">% الهالك</div>
                <div className={`text-3xl font-bold ${me.wasteRatePct > 10 ? "text-rose-700" : "text-slate-800"}`}>{fmtPct(me.wasteRatePct)}</div>
                <div className="text-xs text-slate-500">{fmt(Math.max(me.stageWasteQty, me.wasteQty))} وحدة • {fmt(me.wasteCost)} ر.س</div>
                {companyAvg && (
                  <Comparison mine={me.wasteRatePct} avg={companyAvg.avgWasteRatePct} higherIsBetter={false} unit="%" />
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3 space-y-1">
                <div className="text-xs text-amber-600">% فشل QC</div>
                <div className={`text-3xl font-bold ${me.qcFailRatePct > 20 ? "text-rose-700" : "text-slate-800"}`}>
                  {me.qcChecks > 0 ? fmtPct(me.qcFailRatePct) : "—"}
                </div>
                <div className="text-xs text-slate-500">{fmt(me.qcFails, 0)} فاشلة من {fmt(me.qcChecks, 0)}</div>
                {companyAvg && me.qcChecks > 0 && (
                  <Comparison mine={me.qcFailRatePct} avg={companyAvg.avgQcFailRatePct} higherIsBetter={false} unit="%" />
                )}
              </CardContent>
            </Card>
          </div>

          {/* Secondary stats */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">تفاصيل إضافية</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                <div>
                  <div className="text-xs text-slate-500">متوسط وقت المرحلة</div>
                  <div className="text-xl font-bold">{fmtMins(me.avgDurationMins)}</div>
                  {companyAvg && me.avgDurationMins > 0 && (
                    <Comparison mine={me.avgDurationMins} avg={companyAvg.avgDurationMins} higherIsBetter={false} unit=" د" />
                  )}
                </div>
                <div>
                  <div className="text-xs text-slate-500">أحداث هالك مسجّلة</div>
                  <div className="text-xl font-bold">{fmt(me.wasteEvents, 0)}</div>
                  <div className="text-xs text-slate-400">مسجّلة على اسمك</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">فحوصات مشروطة</div>
                  <div className="text-xl font-bold text-amber-700">{fmt(me.qcConditionals, 0)}</div>
                  <div className="text-xs text-slate-400">تحتاج متابعة</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
