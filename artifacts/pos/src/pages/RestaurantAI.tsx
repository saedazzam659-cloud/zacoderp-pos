import { useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Sparkles, ChevronRight, TrendingUp, Clock, AlertTriangle,
  Loader2, RefreshCw, CheckCheck, ShieldAlert, Users, Crown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, getToken } from "@/lib/api";

const DOW_AR = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

export default function RestaurantAI() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();

  useEffect(() => { if (!getToken()) setLocation("/login"); }, [setLocation]);

  const peaksQ = useQuery({ queryKey: ["r-peaks"],   queryFn: () => api.rPeakHours(30) });
  const topQ   = useQuery({ queryKey: ["r-top"],     queryFn: () => api.rRecommend(10) });
  const suspQ  = useQuery({ queryKey: ["r-susp"],    queryFn: () => api.rSuspicious() });

  const scan = useMutation({
    mutationFn: () => api.rSuspiciousScan(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["r-susp"] }),
  });
  const ack = useMutation({
    mutationFn: (id: number) => api.rSuspiciousAck(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["r-susp"] }),
  });

  const peaks = peaksQ.data;
  const maxHourOrders = Math.max(1, ...((peaks?.byHour ?? []).map(h => h.orders)));
  const maxDowOrders  = Math.max(1, ...((peaks?.byDow ?? []).map(d => d.orders)));

  return (
    <div dir="rtl" className="min-h-screen bg-slate-950 text-white">
      <header className="flex items-center justify-between p-3 border-b border-white/10 bg-slate-900">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setLocation("/restaurant")}>
            <ChevronRight className="h-4 w-4 ml-1" /> رجوع
          </Button>
          <Sparkles className="text-amber-400" />
          <div className="font-bold">التحليلات الذكية</div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => {
          qc.invalidateQueries({ queryKey: ["r-peaks"] });
          qc.invalidateQueries({ queryKey: ["r-top"] });
          qc.invalidateQueries({ queryKey: ["r-susp"] });
        }}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </header>

      <main className="p-4 max-w-6xl mx-auto space-y-6">
        {/* KPI strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="الطلبات (30 يوم)" value={peaks?.totalOrders ?? 0} icon={TrendingUp} color="text-emerald-400" />
          <Stat label="الإيراد" value={`${(peaks?.totalRevenue ?? 0).toFixed(0)} ر.س`} icon={Crown} color="text-amber-400" />
          <Stat label="ساعة الذروة" value={peaks?.peakHour ? `${peaks.peakHour.hour}:00` : "—"} icon={Clock} color="text-rose-400" />
          <Stat label="أكثر يوم" value={peaks?.peakDow ? DOW_AR[peaks.peakDow.dow] : "—"} icon={Users} color="text-blue-400" />
        </div>

        {/* Peak hours */}
        <Card title="توزيع الطلبات على الساعات (آخر 30 يوم)" icon={Clock}>
          {peaksQ.isLoading ? <Loader2 className="animate-spin mx-auto my-6" /> :
            (peaks?.byHour ?? []).length === 0 ? (
              <Empty msg="لا توجد بيانات بعد — ابدأ بإصدار طلبات" />
            ) : (
              <div className="space-y-1.5">
                {Array.from({ length: 24 }, (_, h) => {
                  const row = peaks!.byHour.find(r => r.hour === h);
                  const orders = row?.orders ?? 0;
                  const pct = (orders / maxHourOrders) * 100;
                  return (
                    <div key={h} className="flex items-center gap-2 text-xs">
                      <div className="w-12 text-white/60">{String(h).padStart(2, "0")}:00</div>
                      <div className="flex-1 bg-slate-800 rounded h-5 overflow-hidden">
                        <div className="h-full bg-gradient-to-l from-amber-500 to-rose-500"
                          style={{ width: `${pct}%` }} />
                      </div>
                      <div className="w-12 text-left font-bold">{orders}</div>
                    </div>
                  );
                })}
              </div>
            )}
        </Card>

        {/* Day-of-week */}
        <Card title="أكثر الأيام ازدحاماً" icon={Users}>
          {(peaks?.byDow ?? []).length === 0 ? <Empty msg="لا توجد بيانات" /> : (
            <div className="grid grid-cols-7 gap-2">
              {Array.from({ length: 7 }, (_, d) => {
                const row = peaks!.byDow.find(r => r.dow === d);
                const orders = row?.orders ?? 0;
                const pct = (orders / maxDowOrders) * 100;
                return (
                  <div key={d} className="bg-slate-800 rounded-lg p-2 text-center">
                    <div className="text-[11px] text-white/60">{DOW_AR[d]}</div>
                    <div className="my-2 h-16 flex items-end justify-center">
                      <div className="w-6 bg-gradient-to-t from-amber-500 to-rose-500 rounded"
                        style={{ height: `${pct}%`, minHeight: orders > 0 ? "8px" : "0" }} />
                    </div>
                    <div className="font-bold text-sm">{orders}</div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* Staffing */}
        {(peaks?.recommendations ?? []).length > 0 && (
          <Card title="توصيات التوظيف للساعات النشطة" icon={Sparkles}>
            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2">
              {peaks!.recommendations.map(r => (
                <div key={r.hour} className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-2 text-center">
                  <div className="text-xs text-amber-300">{String(r.hour).padStart(2, "0")}:00</div>
                  <div className="text-2xl font-bold text-amber-400">{r.suggestedWaiters}</div>
                  <div className="text-[10px] text-white/60">نادل</div>
                  <div className="text-[10px] text-white/40">~{r.avgOrdersPerDay} طلب/يوم</div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Top items */}
        <Card title="أفضل الأصناف مبيعاً (آخر 30 يوم)" icon={Crown}>
          {topQ.isLoading ? <Loader2 className="animate-spin mx-auto my-6" /> :
            (topQ.data ?? []).length === 0 ? <Empty msg="لا توجد مبيعات بعد" /> : (
              <div className="space-y-2">
                {topQ.data!.map((it, i) => (
                  <div key={it.menuItemId ?? i} className="flex items-center gap-3 bg-slate-800 rounded p-2">
                    <div className={`w-7 h-7 rounded-full grid place-items-center text-xs font-bold ${
                      i === 0 ? "bg-amber-500 text-slate-900" : i === 1 ? "bg-slate-300 text-slate-900" : i === 2 ? "bg-amber-700" : "bg-slate-600"
                    }`}>{i + 1}</div>
                    <div className="flex-1 font-semibold">{it.nameSnapshot}</div>
                    <div className="text-xs text-white/60">{Number(it.qtySum).toFixed(0)} وحدة</div>
                    <div className="text-amber-400 font-bold">{Number(it.revenue).toFixed(0)} ر.س</div>
                  </div>
                ))}
              </div>
            )}
        </Card>

        {/* Suspicious */}
        <Card title="مراقبة العمليات المشبوهة" icon={ShieldAlert} action={
          <Button size="sm" disabled={scan.isPending} onClick={() => scan.mutate()}
            className="bg-rose-600 hover:bg-rose-700">
            {scan.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertTriangle className="h-4 w-4 ml-1" />}
            فحص الآن
          </Button>
        }>
          {suspQ.isLoading ? <Loader2 className="animate-spin mx-auto my-6" /> :
            (suspQ.data ?? []).length === 0 ? (
              <Empty msg="لا توجد عمليات مشبوهة — اضغط فحص الآن للمسح" />
            ) : (
              <div className="space-y-2">
                {suspQ.data!.map(s => (
                  <div key={s.id} className={`flex items-center gap-3 rounded p-3 border ${
                    s.acknowledged ? "bg-slate-800/40 border-slate-700 opacity-60" :
                    s.severity === "high" ? "bg-rose-900/30 border-rose-500" :
                    s.severity === "medium" ? "bg-amber-900/30 border-amber-500" :
                    "bg-blue-900/30 border-blue-500"
                  }`}>
                    <AlertTriangle className={`h-5 w-5 ${
                      s.severity === "high" ? "text-rose-400" :
                      s.severity === "medium" ? "text-amber-400" : "text-blue-400"
                    }`} />
                    <div className="flex-1">
                      <div className="font-semibold text-sm">{s.description}</div>
                      <div className="text-xs text-white/50 mt-0.5">
                        {s.kind} • {new Date(s.createdAt).toLocaleString("ar-SA")}
                      </div>
                    </div>
                    {!s.acknowledged && (
                      <Button size="sm" variant="ghost" onClick={() => ack.mutate(s.id)}>
                        <CheckCheck className="h-4 w-4 text-emerald-400" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
        </Card>
      </main>
    </div>
  );
}

function Stat({ label, value, icon: Icon, color }: { label: string; value: any; icon: any; color: string }) {
  return (
    <div className="bg-slate-900 border border-white/10 rounded-xl p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-white/60">{label}</div>
        <Icon className={`h-4 w-4 ${color}`} />
      </div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );
}

function Card({ title, icon: Icon, action, children }: { title: string; icon: any; action?: any; children: any }) {
  return (
    <div className="bg-slate-900 border border-white/10 rounded-xl overflow-hidden">
      <div className="p-3 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-2 font-bold">
          <Icon className="h-4 w-4 text-amber-400" /> {title}
        </div>
        {action}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return <div className="text-center text-white/50 py-6 text-sm">{msg}</div>;
}
