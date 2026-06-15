import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Users, Activity, Trophy, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
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

type Totals = {
  operators: number;
  stagesCompleted: number;
  totalOutput: number;
  totalWaste: number;
  totalWasteCost: number;
  qcChecks: number;
  qcFails: number;
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

export default function OperatorPerformance() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [from, setFrom] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [operators, setOperators] = useState<Operator[] | null>(null);
  const [totals, setTotals] = useState<Totals>(null);
  const [loading, setLoading] = useState(false);

  const headers = useMemo(
    () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" }),
    [token],
  );

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const r = await fetch(`${API}/api/production/operators/performance?${params}`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setOperators(Array.isArray(data?.operators) ? data.operators : []);
      setTotals(data?.totals ?? null);
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [token, headers, from, to, toast]);

  useEffect(() => { void load(); }, [load]);

  const top = operators?.[0];
  const worstWaste = useMemo(() => {
    if (!operators) return null;
    return [...operators]
      .filter((o) => o.wasteRatePct > 0)
      .sort((a, b) => b.wasteRatePct - a.wasteRatePct)[0] ?? null;
  }, [operators]);

  return (
    <div className="container mx-auto p-4 space-y-4" dir="rtl">
      <div className="flex items-center gap-3">
        <Users className="h-6 w-6 text-indigo-600" />
        <div>
          <h1 className="text-2xl font-bold">أداء المشغّلين</h1>
          <p className="text-sm text-slate-500">
            تقرير الإنتاجية لكل مشغّل: مراحل مكتملة، متوسط الوقت، الإنتاج، الهالك، وفحوصات الجودة
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
          <Button onClick={() => void load()} disabled={loading} data-testid="btn-refresh-ops">
            تحديث
          </Button>
        </CardContent>
      </Card>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card><CardContent className="p-3"><div className="text-xs text-slate-500">عدد المشغّلين</div><div className="text-2xl font-bold">{totals?.operators ?? 0}</div></CardContent></Card>
        <Card><CardContent className="p-3"><div className="text-xs text-emerald-600">مراحل مكتملة</div><div className="text-2xl font-bold text-emerald-700">{fmt(totals?.stagesCompleted ?? 0, 0)}</div></CardContent></Card>
        <Card><CardContent className="p-3"><div className="text-xs text-indigo-600">إجمالي الإنتاج</div><div className="text-2xl font-bold text-indigo-700">{fmt(totals?.totalOutput ?? 0)}</div></CardContent></Card>
        <Card><CardContent className="p-3"><div className="text-xs text-rose-600">إجمالي الهالك</div><div className="text-2xl font-bold text-rose-700">{fmt(totals?.totalWaste ?? 0)}</div><div className="text-[10px] text-slate-500 mt-1">تكلفة: {fmt(totals?.totalWasteCost ?? 0)} ر.س</div></CardContent></Card>
        <Card><CardContent className="p-3"><div className="text-xs text-amber-600">QC: فاشلة / إجمالي</div><div className="text-2xl font-bold text-amber-700">{fmt(totals?.qcFails ?? 0, 0)} / {fmt(totals?.qcChecks ?? 0, 0)}</div></CardContent></Card>
      </div>

      {/* Highlights */}
      {(top || worstWaste) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {top && (
            <Card className="border-emerald-200">
              <CardContent className="p-3 flex items-center gap-3">
                <Trophy className="h-8 w-8 text-emerald-600" />
                <div>
                  <div className="text-xs text-emerald-700">الأعلى إنتاجية</div>
                  <div className="font-bold">{top.operatorName ?? `#${top.operatorUserId}`}</div>
                  <div className="text-xs text-slate-500">
                    {fmt(top.stagesCompleted, 0)} مرحلة • {fmt(top.totalOutput)} وحدة
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          {worstWaste && (
            <Card className="border-rose-200">
              <CardContent className="p-3 flex items-center gap-3">
                <AlertTriangle className="h-8 w-8 text-rose-600" />
                <div>
                  <div className="text-xs text-rose-700">الأعلى نسبة هالك</div>
                  <div className="font-bold">{worstWaste.operatorName ?? `#${worstWaste.operatorUserId}`}</div>
                  <div className="text-xs text-slate-500">
                    {fmtPct(worstWaste.wasteRatePct)} • {fmt(Math.max(worstWaste.stageWasteQty, worstWaste.wasteQty))} وحدة
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">تفاصيل المشغّلين</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading && !operators && (
            <div className="p-4 space-y-2">
              {[1, 2, 3].map((i) => (<Skeleton key={i} className="h-12 w-full" />))}
            </div>
          )}
          {operators && operators.length === 0 && (
            <div className="p-8 text-center text-slate-500">
              <Activity className="h-10 w-10 mx-auto mb-2 opacity-40" />
              لا توجد بيانات أداء في المدى الزمني المحدد
            </div>
          )}
          {operators && operators.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-900">
                  <tr>
                    <th className="p-3 text-start">المشغّل</th>
                    <th className="p-3 text-start">مراحل (مكتملة/إجمالي)</th>
                    <th className="p-3 text-start">متوسط الوقت</th>
                    <th className="p-3 text-start">الإنتاج</th>
                    <th className="p-3 text-start">الهالك (كمية)</th>
                    <th className="p-3 text-start">% الهالك</th>
                    <th className="p-3 text-start">تكلفة الهالك</th>
                    <th className="p-3 text-start">QC: فحوصات/فاشلة</th>
                    <th className="p-3 text-start">% فشل QC</th>
                  </tr>
                </thead>
                <tbody>
                  {operators.map((o) => (
                    <tr key={o.operatorUserId} className="border-t" data-testid={`op-row-${o.operatorUserId}`}>
                      <td className="p-3 font-medium">{o.operatorName ?? `#${o.operatorUserId}`}</td>
                      <td className="p-3">
                        <span className="font-bold text-emerald-700">{fmt(o.stagesCompleted, 0)}</span>
                        <span className="text-slate-400"> / {fmt(o.stagesTotal, 0)}</span>
                      </td>
                      <td className="p-3">{fmtMins(o.avgDurationMins)}</td>
                      <td className="p-3 font-mono">{fmt(o.totalOutput)}</td>
                      <td className="p-3 font-mono text-rose-700">
                        {fmt(Math.max(o.stageWasteQty, o.wasteQty))}
                        {o.wasteEvents > 0 && (
                          <span className="text-[10px] text-slate-500 ms-1">({o.wasteEvents} حدث)</span>
                        )}
                      </td>
                      <td className="p-3">
                        <span className={o.wasteRatePct > 10 ? "text-rose-700 font-bold" : "text-slate-700"}>
                          {fmtPct(o.wasteRatePct)}
                        </span>
                      </td>
                      <td className="p-3 font-mono text-xs">{fmt(o.wasteCost)} ر.س</td>
                      <td className="p-3">
                        <span className="font-bold text-amber-700">{fmt(o.qcFails, 0)}</span>
                        <span className="text-slate-400"> / {fmt(o.qcChecks, 0)}</span>
                        {o.qcConditionals > 0 && (
                          <span className="text-[10px] text-amber-600 ms-1">+{o.qcConditionals} مشروط</span>
                        )}
                      </td>
                      <td className="p-3">
                        <span className={o.qcFailRatePct > 20 ? "text-rose-700 font-bold" : "text-slate-700"}>
                          {o.qcChecks > 0 ? fmtPct(o.qcFailRatePct) : "—"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
