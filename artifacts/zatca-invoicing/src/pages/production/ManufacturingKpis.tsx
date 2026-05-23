import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  Gauge, RefreshCw, ShieldCheck, Activity, Calculator, ArrowLeftRight,
  TrendingUp, TrendingDown, ClipboardList, AlertTriangle, Package,
  Factory, CheckCircle2, Clock, BarChart3,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from "@/components/ui/tabs";

const API = import.meta.env.VITE_API_URL || "";

type Kpi = {
  period: { from: string; to: string; days: number };
  orders: {
    byStatus: Array<{ status: string; count: number; plannedQty: number; producedQty: number; wasteQty: number }>;
    totals: { planned: number; produced: number; waste: number };
  };
  scrap: { rate: number; producedQty: number; wasteQty: number };
  onTime: { completedCount: number; measurableCount: number; onTimeCount: number; lateCount: number; rate: number };
  approvals: { pendingDrafts: number; mandatory: number };
  downtime: {
    totalMinutes: number; plannedMinutes: number; unplannedMinutes: number;
    topReasons: Array<{ reasonId: number | null; code: string | null; nameAr: string | null; category: string | null; minutes: number }>;
  };
  oee: { workCenterCount: number; avgAvailability: number; avgQuality: number; avgOee: number };
  mrp: {
    shortageCount: number;
    topShortages: Array<{ itemId: number; nameAr: string | null; reorderLevel: number; onHand: number; net: number }>;
  };
};

const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
const fmtNum = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const fmtMin = (n: number) => {
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  return h > 0 ? `${h}س ${m}د` : `${m}د`;
};
const oeeColor = (n: number) =>
  n >= 0.85 ? "text-emerald-700 bg-emerald-50 border-emerald-300"
  : n >= 0.60 ? "text-amber-700 bg-amber-50 border-amber-300"
  : "text-rose-700 bg-rose-50 border-rose-300";
const scrapColor = (n: number) =>
  n <= 0.02 ? "text-emerald-700" : n <= 0.05 ? "text-amber-700" : "text-rose-700";
const statusLabel: Record<string, string> = {
  draft: "مسودة", approved: "معتمد", in_production: "قيد الإنتاج",
  quality_check: "فحص جودة", completed: "مكتمل", cancelled: "ملغى",
};
const statusBadge: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  approved: "bg-violet-100 text-violet-800",
  in_production: "bg-blue-100 text-blue-800",
  quality_check: "bg-amber-100 text-amber-800",
  completed: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-rose-100 text-rose-800",
};

export default function ManufacturingKpis() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Kpi | null>(null);
  const [loading, setLoading] = useState(true);

  const headers = useMemo(() => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }), [token]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/production/kpi-dashboard?days=${days}`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
    } catch (e: any) {
      toast({ title: "فشل تحميل المؤشرات", description: e?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [days, headers, toast]);

  useEffect(() => { if (token) load(); }, [token, load]);

  return (
    <div className="container mx-auto p-4 space-y-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Gauge className="h-6 w-6 text-indigo-600" />
          <div>
            <h1 className="text-2xl font-bold">لوحة مؤشرات التصنيع</h1>
            <p className="text-sm text-slate-500">
              عرض موحّد لكل وحدات الإنتاج: الأوامر، الجودة، التسليم، الاعتمادات، التوقفات، OEE، ونقص الخامات.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {[7, 30, 90].map((d) => (
            <Button key={d} size="sm" variant={days === d ? "default" : "outline"}
              onClick={() => setDays(d)}>{d}ي</Button>
          ))}
          <Button size="sm" variant="outline" onClick={load} disabled={loading}>
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {loading && !data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => <Skeleton key={i} className="h-24" />)}
        </div>
      )}

      {data && (
        <>
          {/* Top KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Link href="/production/kanban">
              <Card className="hover:shadow-md transition cursor-pointer">
                <CardContent className="p-3">
                  <div className="text-xs text-slate-500 flex items-center gap-1">
                    <Factory className="h-3 w-3" />أوامر قيد التنفيذ
                  </div>
                  <div className="text-2xl font-bold mt-1 text-blue-700">
                    {data.orders.byStatus.find((s) => s.status === "in_production")?.count ?? 0}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-1">من إجمالي {data.orders.byStatus.reduce((s, r) => s + r.count, 0)}</div>
                </CardContent>
              </Card>
            </Link>

            <Link href="/production/approvals">
              <Card className={`hover:shadow-md transition cursor-pointer ${data.approvals.mandatory > 0 ? "border-amber-300" : ""}`}>
                <CardContent className="p-3">
                  <div className="text-xs text-slate-500 flex items-center gap-1">
                    <ShieldCheck className="h-3 w-3" />تنتظر الاعتماد
                  </div>
                  <div className={`text-2xl font-bold mt-1 ${data.approvals.mandatory > 0 ? "text-amber-700" : "text-slate-700"}`}>
                    {data.approvals.pendingDrafts}
                  </div>
                  {data.approvals.mandatory > 0 && (
                    <div className="text-[10px] text-amber-700 mt-1 font-bold">
                      {data.approvals.mandatory} إلزامية
                    </div>
                  )}
                </CardContent>
              </Card>
            </Link>

            <Link href="/production/downtime">
              <Card className="hover:shadow-md transition cursor-pointer">
                <CardContent className="p-3">
                  <div className="text-xs text-slate-500 flex items-center gap-1">
                    <Gauge className="h-3 w-3" />متوسط OEE
                  </div>
                  <div className="flex items-baseline gap-2 mt-1">
                    {data.oee.workCenterCount > 0 ? (
                      <span className={`text-2xl font-bold px-2 rounded border ${oeeColor(data.oee.avgOee)}`}>
                        {fmtPct(data.oee.avgOee)}
                      </span>
                    ) : (
                      <span className="text-slate-400 text-sm">لا توجد مراكز</span>
                    )}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-1">
                    {data.oee.workCenterCount} مركز • توافر {fmtPct(data.oee.avgAvailability)} • جودة {fmtPct(data.oee.avgQuality)}
                  </div>
                </CardContent>
              </Card>
            </Link>

            <Card>
              <CardContent className="p-3">
                <div className="text-xs text-slate-500 flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" />التسليم في الموعد
                </div>
                <div className="text-2xl font-bold mt-1">
                  {data.onTime.measurableCount > 0 ? (
                    <span className={data.onTime.rate >= 0.9 ? "text-emerald-700" : data.onTime.rate >= 0.7 ? "text-amber-700" : "text-rose-700"}>
                      {fmtPct(data.onTime.rate)}
                    </span>
                  ) : (
                    <span className="text-slate-400 text-sm">لا بيانات</span>
                  )}
                </div>
                <div className="text-[10px] text-slate-400 mt-1">
                  {data.onTime.onTimeCount} في الموعد / {data.onTime.lateCount} متأخر
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Second row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card>
              <CardContent className="p-3">
                <div className="text-xs text-slate-500 flex items-center gap-1">
                  <Package className="h-3 w-3" />منتج (آخر {data.period.days}ي)
                </div>
                <div className="text-2xl font-bold mt-1 font-mono text-emerald-700">
                  {fmtNum(data.scrap.producedQty)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <div className="text-xs text-slate-500 flex items-center gap-1">
                  <TrendingDown className="h-3 w-3" />هالك
                </div>
                <div className="text-2xl font-bold mt-1 font-mono text-rose-700">
                  {fmtNum(data.scrap.wasteQty)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <div className="text-xs text-slate-500 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />نسبة الهالك
                </div>
                <div className={`text-2xl font-bold mt-1 ${scrapColor(data.scrap.rate)}`}>
                  {fmtPct(data.scrap.rate)}
                </div>
                <div className="text-[10px] text-slate-400 mt-1">
                  المستهدف ≤ 2%
                </div>
              </CardContent>
            </Card>
            <Link href="/production/mrp">
              <Card className={`hover:shadow-md transition cursor-pointer ${data.mrp.shortageCount > 0 ? "border-rose-300" : ""}`}>
                <CardContent className="p-3">
                  <div className="text-xs text-slate-500 flex items-center gap-1">
                    <ArrowLeftRight className="h-3 w-3" />نقص خامات
                  </div>
                  <div className={`text-2xl font-bold mt-1 ${data.mrp.shortageCount > 0 ? "text-rose-700" : "text-slate-700"}`}>
                    {data.mrp.shortageCount}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-1">
                    أصناف تحت حد إعادة الطلب
                  </div>
                </CardContent>
              </Card>
            </Link>
          </div>

          {/* Detail tabs */}
          <Tabs defaultValue="orders" className="w-full">
            <TabsList>
              <TabsTrigger value="orders"><Factory className="h-3 w-3 me-1" />الأوامر</TabsTrigger>
              <TabsTrigger value="downtime"><Activity className="h-3 w-3 me-1" />التوقفات</TabsTrigger>
              <TabsTrigger value="mrp"><ArrowLeftRight className="h-3 w-3 me-1" />نقص الخامات</TabsTrigger>
            </TabsList>

            <TabsContent value="orders">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <ClipboardList className="h-4 w-4" />توزيع الأوامر بالحالة
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-100/60 text-xs">
                      <tr>
                        <th className="p-2 text-start">الحالة</th>
                        <th className="p-2 text-end">عدد الأوامر</th>
                        <th className="p-2 text-end">مخطط</th>
                        <th className="p-2 text-end">منتج</th>
                        <th className="p-2 text-end">هالك</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.orders.byStatus.length === 0 ? (
                        <tr><td colSpan={5} className="p-6 text-center text-slate-500">لا توجد أوامر</td></tr>
                      ) : data.orders.byStatus.map((s) => (
                        <tr key={s.status} className="border-t">
                          <td className="p-2">
                            <span className={`px-2 py-0.5 rounded text-xs ${statusBadge[s.status] ?? "bg-slate-100 text-slate-700"}`}>
                              {statusLabel[s.status] ?? s.status}
                            </span>
                          </td>
                          <td className="p-2 text-end font-bold">{s.count}</td>
                          <td className="p-2 text-end font-mono">{fmtNum(s.plannedQty)}</td>
                          <td className="p-2 text-end font-mono text-emerald-700">{fmtNum(s.producedQty)}</td>
                          <td className="p-2 text-end font-mono text-rose-700">{fmtNum(s.wasteQty)}</td>
                        </tr>
                      ))}
                      <tr className="border-t bg-slate-100 font-bold">
                        <td className="p-2">الإجمالي</td>
                        <td className="p-2 text-end">{data.orders.byStatus.reduce((s, r) => s + r.count, 0)}</td>
                        <td className="p-2 text-end font-mono">{fmtNum(data.orders.totals.planned)}</td>
                        <td className="p-2 text-end font-mono">{fmtNum(data.orders.totals.produced)}</td>
                        <td className="p-2 text-end font-mono">{fmtNum(data.orders.totals.waste)}</td>
                      </tr>
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="downtime">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <Card>
                  <CardContent className="p-3 text-center">
                    <div className="text-xs text-slate-500 flex items-center justify-center gap-1">
                      <Clock className="h-3 w-3" />إجمالي التوقفات
                    </div>
                    <div className="text-xl font-bold mt-1 font-mono">{fmtMin(data.downtime.totalMinutes)}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-3 text-center">
                    <div className="text-xs text-blue-700 flex items-center justify-center gap-1">
                      <Clock className="h-3 w-3" />مخطط
                    </div>
                    <div className="text-xl font-bold mt-1 font-mono text-blue-700">{fmtMin(data.downtime.plannedMinutes)}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-3 text-center">
                    <div className="text-xs text-rose-700 flex items-center justify-center gap-1">
                      <AlertTriangle className="h-3 w-3" />غير مخطط
                    </div>
                    <div className="text-xl font-bold mt-1 font-mono text-rose-700">{fmtMin(data.downtime.unplannedMinutes)}</div>
                  </CardContent>
                </Card>
              </div>
              <Card className="mt-3">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">أكثر 5 أسباب توقف</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {data.downtime.topReasons.length === 0 ? (
                    <div className="p-6 text-center text-slate-500 text-sm">لا توجد توقفات في الفترة</div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="bg-slate-100/60 text-xs">
                        <tr>
                          <th className="p-2 text-start">السبب</th>
                          <th className="p-2 text-start">الفئة</th>
                          <th className="p-2 text-end">المدة</th>
                          <th className="p-2 text-end">النسبة</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.downtime.topReasons.map((r, i) => (
                          <tr key={i} className="border-t">
                            <td className="p-2">
                              <div className="font-bold">{r.nameAr ?? "—"}</div>
                              {r.code && <div className="text-[10px] text-slate-500 font-mono">{r.code}</div>}
                            </td>
                            <td className="p-2">
                              {r.category === "planned" && <Badge className="text-[10px] bg-blue-100 text-blue-800 hover:bg-blue-100">مخطط</Badge>}
                              {r.category === "unplanned" && <Badge className="text-[10px] bg-rose-100 text-rose-800 hover:bg-rose-100">غير مخطط</Badge>}
                            </td>
                            <td className="p-2 text-end font-mono">{fmtMin(r.minutes)}</td>
                            <td className="p-2 text-end font-mono text-slate-500">
                              {data.downtime.totalMinutes > 0
                                ? fmtPct(r.minutes / data.downtime.totalMinutes)
                                : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="mrp">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <BarChart3 className="h-4 w-4" />
                    أعلى 8 نواقص (حسب الفجوة من حد إعادة الطلب)
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {data.mrp.topShortages.length === 0 ? (
                    <div className="p-6 text-center text-slate-500 text-sm">
                      <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-emerald-400" />
                      لا يوجد نقص في الخامات.
                    </div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="bg-slate-100/60 text-xs">
                        <tr>
                          <th className="p-2 text-start">الصنف</th>
                          <th className="p-2 text-end">حد إعادة الطلب</th>
                          <th className="p-2 text-end">الرصيد</th>
                          <th className="p-2 text-end">الفجوة</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.mrp.topShortages.map((s) => (
                          <tr key={s.itemId} className="border-t">
                            <td className="p-2 font-bold">{s.nameAr ?? `#${s.itemId}`}</td>
                            <td className="p-2 text-end font-mono">{fmtNum(s.reorderLevel)}</td>
                            <td className="p-2 text-end font-mono">{fmtNum(s.onHand)}</td>
                            <td className="p-2 text-end font-mono font-bold text-rose-700">{fmtNum(s.net)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          {/* Quick links footer */}
          <div className="flex gap-2 flex-wrap">
            <Link href="/production/approvals">
              <Button variant="outline" size="sm"><ShieldCheck className="h-3 w-3 me-1" />اعتمادات</Button>
            </Link>
            <Link href="/production/mrp">
              <Button variant="outline" size="sm"><ArrowLeftRight className="h-3 w-3 me-1" />MRP</Button>
            </Link>
            <Link href="/production/downtime">
              <Button variant="outline" size="sm"><Activity className="h-3 w-3 me-1" />التوقفات / OEE</Button>
            </Link>
            <Link href="/production/cost-rollup">
              <Button variant="outline" size="sm"><Calculator className="h-3 w-3 me-1" />تكلفة المنتج</Button>
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
