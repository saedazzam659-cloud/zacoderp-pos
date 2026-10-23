import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, FileText, TrendingUp, TrendingDown, Layers, Calculator, Users, Wrench, Zap, AlertTriangle } from "lucide-react";
import { MonthlyOverheadClosures } from "@/components/MonthlyOverheadClosures";

function statusLabel(status: string) {
  return ({
    draft: "مسودة", approved: "معتمد", in_production: "قيد الإنتاج",
    paused: "متوقف مؤقتاً", quality_check: "فحص الجودة", completed: "مكتمل",
    cancelled: "ملغى", reversed: "معكوس",
  } as Record<string, string>)[status] ?? status;
}

export function SimpleReports({ request }: { request: (path: string, init?: RequestInit) => Promise<any> }) {
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [resourceEstimate, setResourceEstimate] = useState<any>(null);
  const [resourceEstimateError, setResourceEstimateError] = useState("");
  const [resourceEstimateLoading, setResourceEstimateLoading] = useState(true);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setReport(null);
    request("/api/simple-manufacturing/reports", { signal: controller.signal })
      .then(data => {
        if (requestId !== requestIdRef.current) return;
        if (!data || typeof data !== "object" || !data.totals || !Array.isArray(data.rows)) {
          throw new Error("استجابة التقرير غير صالحة");
        }
        setReport(data);
      })
      .catch((e: any) => {
        if (e?.name !== "AbortError" && requestId === requestIdRef.current) setError(e.message);
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
    return () => controller.abort();
  }, [request]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setResourceEstimate(null);
    setResourceEstimateLoading(true);
    setResourceEstimateError("");
    request("/api/simple-manufacturing/reports/resource-estimates", { signal: controller.signal })
      .then(data => {
        if (!active) return;
        if (!data || !Array.isArray(data.orders) || !data.totals || !data.actualTotals) {
          throw new Error("استجابة تقدير الموارد غير صالحة");
        }
        setResourceEstimate(data);
      })
      .catch((e: any) => {
        if (active && e?.name !== "AbortError") setResourceEstimateError(e.message);
      })
      .finally(() => {
        if (active) setResourceEstimateLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [request]);

  if (error) {
    return (
      <Card className="border-destructive/50 bg-destructive/5">
        <CardContent className="p-6 text-destructive text-center flex flex-col items-center gap-2">
          <span className="font-semibold">تعذر تحميل التقرير</span>
          <span className="text-sm opacity-80">{error}</span>
        </CardContent>
      </Card>
    );
  }

  if (loading || !report) {
    return (
      <Card>
        <CardContent className="p-16 flex flex-col items-center justify-center text-muted-foreground gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-violet-500" />
          <p>جاري تجميع بيانات التكلفة والإنتاج...</p>
        </CardContent>
      </Card>
    );
  }

  const stdCost = Number(report.totals.standardCost || 0);
  const actCost = Number(report.totals.actualCost || 0);
  const diff = actCost - stdCost;
  const actualIncompleteStages = (resourceEstimate?.orders ?? [])
    .flatMap((order: any) => order.stages ?? [])
    .filter((stage: any) => stage.actualExecutionRecorded && stage.actualMissing?.length).length;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="bg-gradient-to-br from-slate-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-lg bg-blue-100 text-blue-600"><Layers className="h-5 w-5" /></div>
              <h3 className="font-semibold text-slate-700">التكلفة المعيارية</h3>
            </div>
            <div className="text-3xl font-bold text-slate-900">{stdCost.toLocaleString()}</div>
            <p className="text-xs text-slate-500 mt-1">حسب تسعير المكونات والمصادر المتوقعة</p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-slate-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-lg bg-emerald-100 text-emerald-600"><TrendingUp className="h-5 w-5" /></div>
              <h3 className="font-semibold text-slate-700">التكلفة الفعلية</h3>
            </div>
            <div className="text-3xl font-bold text-slate-900">{actCost.toLocaleString()}</div>
            <p className="text-xs text-slate-500 mt-1">إجمالي ما تم صرفه فعلياً على الأوامر</p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-slate-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-center gap-3 mb-2">
              <div className={`p-2 rounded-lg ${diff > 0 ? "bg-red-100 text-red-600" : "bg-emerald-100 text-emerald-600"}`}>
                <TrendingDown className="h-5 w-5" />
              </div>
              <h3 className="font-semibold text-slate-700">انحراف التكلفة</h3>
            </div>
            <div className={`text-3xl font-bold ${diff > 0 ? "text-red-600" : "text-emerald-600"}`}>
              {diff > 0 ? "+" : ""}{diff.toLocaleString()}
            </div>
            <p className="text-xs text-slate-500 mt-1">الفارق بين الفعلي والمعياري</p>
          </CardContent>
        </Card>
      </div>

      <Card className="border-indigo-200">
        <CardHeader className="border-b bg-indigo-50/60">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Calculator className="h-5 w-5 text-indigo-600" />
            تقدير موارد مسارات أوامر الإنتاج
          </CardTitle>
          <p className="text-sm text-slate-600">
            مقارنة قراءة فقط بين موارد المرحلة المخططة والمنفذة. الفعلي هنا محسوب من مدة التنفيذ والموظفين المسجلين في المرحلة ومعدلات رواتبهم الفردية؛
            لا يغيّر التكلفة الفعلية المحاسبية ولا ينشئ قيوداً.
          </p>
        </CardHeader>
        <CardContent className="space-y-4 p-4">
          {resourceEstimateLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin" /> جاري حساب التقدير...
            </div>
          ) : resourceEstimateError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              تعذر حساب تقدير موارد المسارات: {resourceEstimateError}
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                {[
                  { key: "labor", label: "العمالة المخططة", Icon: Users, color: "text-blue-700", source: "planned" },
                  { key: "depreciation", label: "إهلاك مخطط", Icon: Wrench, color: "text-violet-700", source: "planned" },
                  { key: "electricity", label: "كهرباء مخططة", Icon: Zap, color: "text-amber-700", source: "planned" },
                  { key: "total", label: "إجمالي الموارد المخططة", Icon: Calculator, color: "text-indigo-800", source: "planned" },
                  { key: "total", label: "موارد منفذة (تحليل فقط)", Icon: TrendingUp, color: "text-emerald-700", source: "actual" },
                ].map(({ key, label, Icon, color, source }) => (
                  <div key={label} className="rounded-lg border bg-white p-3">
                    <div className={`flex items-center gap-2 text-xs ${color}`}>
                      <Icon className="h-4 w-4" />{label}
                    </div>
                    <div className={`mt-2 text-xl font-bold font-mono ${color}`}>
                      {Number(resourceEstimate[source === "actual" ? "actualTotals" : "totals"]?.[key] || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-slate-500">
                سعر ساعة الموظف = راتبه الإجمالي في آخر مسير مرحّل مناسب ÷ (30 يوماً × ساعات دوامه اليومية في العقد الساري). العمالة الفعلية تستخدم ساعات التنفيذ الفعلية ومعدل كل موظف في فترة التنفيذ؛ الكهرباء تستخدم التعريفة المسجلة حالياً.
                الإجمالي المنفذ قد يكون جزئياً عند نقص البيانات؛ لا يُعامل النقص كتكلفة مؤكدة.
              </p>
              {actualIncompleteStages > 0 && (
                <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                  توجد {actualIncompleteStages} مرحلة ينقصها بيان لحساب موارد التنفيذ بدقة؛ راجع سبب النقص داخل تفاصيل المرحلة.
                </p>
              )}
              {resourceEstimate.truncated && (
                <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                  عُرضت تقديرات آخر 1000 أمر فقط.
                </p>
              )}
              <div className="max-h-[34rem] space-y-2 overflow-auto">
                {(resourceEstimate.orders ?? []).filter((order: any) => order.stages?.length).map((order: any) => (
                  <details key={order.id} className="rounded-lg border bg-white">
                    <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 p-3">
                      <span className="font-semibold text-slate-800">
                        {order.orderNumber} — {order.title}
                      </span>
                      <span className="text-xs text-slate-500">
                        فترة السعر: {order.period} · تقدير الموارد:{" "}
                        {Number(order.stages.reduce((sum: number, stage: any) => sum + Number(stage.total || 0), 0))
                          .toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </span>
                    </summary>
                    <div className="overflow-x-auto border-t">
                      <table className="w-full min-w-[1120px] text-xs">
                        <thead className="bg-slate-50 text-slate-600">
                          <tr>
                            <th className="p-2 text-right">المرحلة / المورد</th>
                            <th className="p-2 text-right">المدة المخططة / الفعلية</th>
                            <th className="p-2 text-right">عمالة مخططة</th>
                            <th className="p-2 text-right">عمالة فعلية</th>
                            <th className="p-2 text-right">إهلاك مخطط</th>
                            <th className="p-2 text-right">إهلاك فعلي</th>
                            <th className="p-2 text-right">كهرباء مخططة</th>
                            <th className="p-2 text-right">كهرباء فعلية</th>
                            <th className="p-2 text-right">إجمالي مخطط</th>
                            <th className="p-2 text-right">إجمالي فعلي (تحليل)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {order.stages.map((stage: any, index: number) => (
                            <tr key={`${order.id}-${stage.sequence}-${index}`} className="border-t align-top">
                              <td className="p-2">
                                <div className="font-medium">{stage.nameAr}</div>
                                {stage.resourceName && <div className="text-slate-500">{stage.resourceName}</div>}
                                {!!stage.laborSourcePeriods?.length && (
                                  <div className="text-slate-500">مسير المخطط: {stage.laborSourcePeriods.join("، ")}</div>
                                )}
                                {!!stage.actualLaborSourcePeriods?.length && (
                                  <div className="text-slate-500">مسير التنفيذ: {stage.actualLaborSourcePeriods.join("، ")}</div>
                                )}
                                {stage.depreciationSourcePeriod && (
                                  <div className="text-slate-500">أساس الإهلاك: {stage.depreciationSourcePeriod}</div>
                                )}
                                {stage.actualDepreciationSourcePeriod && (
                                  <div className="text-slate-500">أساس الإهلاك الفعلي: {stage.actualDepreciationSourcePeriod}</div>
                                )}
                                {!!stage.missing?.length && (
                                  <div className="mt-1 flex items-start gap-1 text-amber-700">
                                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                                    <span>{stage.missing.join("، ")}</span>
                                  </div>
                                )}
                                {!!stage.actualMissing?.length && (
                                  <div className="mt-1 flex items-start gap-1 text-amber-700">
                                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                                    <span>فعلي: {stage.actualMissing.join("، ")}</span>
                                  </div>
                                )}
                              </td>
                              <td className="p-2">{stage.durationMinutes ?? "—"} / {Number(stage.actualDurationMinutes) > 0 ? stage.actualDurationMinutes : "—"} دقيقة</td>
                              <td className="p-2 font-mono">{Number(stage.labor || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                              <td className="p-2 font-mono">{!stage.actualExecutionRecorded || stage.actualLaborSourcePeriods?.length !== stage.assignedEmployeeCount || stage.actualMissing?.some((m: string) => /(موظف|عامل|مسير|عقد|راتب)/.test(m))
                                ? "—" : Number(stage.actualLabor || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                              <td className="p-2 font-mono">{Number(stage.depreciation || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                              <td className="p-2 font-mono">{!stage.actualExecutionRecorded || stage.actualMissing?.some((m: string) => m.includes("إهلاك") || m.includes("الأصل"))
                                ? "—" : Number(stage.actualDepreciation || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                              <td className="p-2 font-mono">{Number(stage.electricity || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                              <td className="p-2 font-mono">{!stage.actualExecutionRecorded || stage.actualMissing?.some((m: string) => m.includes("كهرباء") || m.includes("تعريفة"))
                                ? "—" : Number(stage.actualElectricity || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                              <td className="p-2 font-mono font-semibold">{Number(stage.total || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                              <td className="p-2 font-mono font-semibold">{!stage.actualExecutionRecorded
                                ? "—" : stage.actualMissing?.length
                                  ? "غير مكتمل" : Number(stage.actualTotal || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                ))}
                {!(resourceEstimate.orders ?? []).some((order: any) => order.stages?.length) && (
                  <div className="rounded-lg border border-dashed p-6 text-center text-sm text-slate-500">
                    لا توجد أوامر محفوظة بمراحل إنتاج لعرض تقدير الموارد.
                  </div>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b bg-slate-50/50">
          <CardTitle className="text-lg flex items-center gap-2">
            <FileText className="h-5 w-5 text-violet-600" />
            تفصيل تكلفة الأوامر
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-slate-500 text-right border-b">
                  <th className="p-4 font-medium">رقم الأمر</th>
                  <th className="p-4 font-medium">المنتج / العنوان</th>
                  <th className="p-4 font-medium">الحالة</th>
                  <th className="p-4 font-medium">المعياري المحفوظ</th>
                  <th className="p-4 font-medium">التكلفة الفعلية</th>
                  <th className="p-4 font-medium">الانحراف</th>
                </tr>
              </thead>
              <tbody>
                {(report.rows || []).map((row: any) => (
                  <tr key={row.id} className="border-b last:border-0 hover:bg-slate-50/50">
                    <td className="p-4 font-semibold text-violet-700">{row.orderNumber}</td>
                    <td className="p-4">{row.productName || row.title}</td>
                    <td className="p-4"><Badge variant="outline">{statusLabel(row.status)}</Badge></td>
                    <td className="p-4 font-mono">{Number(row.estimatedCost || 0).toLocaleString()}</td>
                    <td className="p-4 font-mono font-medium">{Number(row.actualCost || 0).toLocaleString()}</td>
                    <td className={`p-4 font-mono font-semibold ${
                      Number(row.actualCost || 0) > Number(row.estimatedCost || 0)
                        ? "text-red-600" : "text-emerald-700"
                    }`}>
                      {(Number(row.actualCost || 0) - Number(row.estimatedCost || 0)).toLocaleString()}
                    </td>
                  </tr>
                ))}
                {!(report.rows?.length) && (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-slate-500">لا توجد بيانات للأوامر</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <MonthlyOverheadClosures request={request} />
    </div>
  );
}
