import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calculator, AlertCircle, CheckCircle2, ChevronDown, Split, History, Receipt } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { usePermission } from "@/hooks/usePermission";
import { ProductionTimeCosts } from "@/components/ProductionTimeCosts";

type CostTraceProps = {
  orderId: number;
  costDrilldown: any;
  orderStatus: string;
  token: string;
};

export function ProductionCostTrace({ orderId, costDrilldown, orderStatus, token }: CostTraceProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const canPost = usePermission("simple_manufacturing", "post");


  if (!costDrilldown) {
    return <div className="p-8 text-center text-slate-500">لا تتوفر بيانات تتبع التكلفة.</div>;
  }

  const trace = costDrilldown.trace && typeof costDrilldown.trace === "object" ? costDrilldown.trace : {};
  const materials = Array.isArray(trace.materials) ? trace.materials : [];
  const labor = trace.labor && typeof trace.labor === "object" ? trace.labor : null;
  const overhead = trace.overhead && typeof trace.overhead === "object" ? trace.overhead : null;
  const waste = Array.isArray(trace.waste) ? trace.waste : [];
  const stageWaste = Array.isArray(trace.stageWaste) ? trace.stageWaste : [];
  const savedStages = Array.isArray(trace.stages) ? trace.stages : [];
  const wasteSummary = trace.wasteSummary && typeof trace.wasteSummary === "object"
    ? trace.wasteSummary
    : null;
  const resourceCosts = trace.resourceCosts && typeof trace.resourceCosts === "object" ? trace.resourceCosts : null;
  const resourceTotals = resourceCosts?.totals;
  const hasProvisionalElectricityAccrual = (Array.isArray(resourceCosts?.stages) ? resourceCosts.stages : [])
    .some((stage: any) => (Array.isArray(stage?.snapshot) ? stage.snapshot : []).some((component: any) => {
      const snapshot = component?.component === "electricity" ? component?.snapshot : null;
      return Number(snapshot?.provisionalAccrualAccountId) > 0 &&
        Number(snapshot?.provisionalAccrualAmount) > 0;
    }));

  const totals = costDrilldown.totals || {};
  const act = Number(totals.actual || 0);
  const std = Number(totals.standard || 0);
  // The server's variance contract is actual minus standard.  A positive
  // value is therefore an overrun, never a browser-reversed "saving".
  const variance = Number(totals.variance ?? (act - std));

  const formatMoney = (val: any) => {
    const num = Number(val);
    return Number.isFinite(num) ? num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
  };
  const formatQuantity = (val: any) => {
    const num = Number(val);
    return Number.isFinite(num) ? num.toLocaleString("en-US", { maximumFractionDigits: 6 }) : "—";
  };
  const fallbackStageWaste = stageWaste.length > 0
    ? stageWaste
    : savedStages
      .filter((stage: any) => stage.status === "done" && Number(stage.wasteQty || 0) > 0)
      .map((stage: any) => ({
        stageId: stage.id,
        stageName: stage.name,
        classification: stage.wasteClassification === "normal" ? "normal" : "abnormal",
        qty: Number(stage.wasteQty || 0),
        unitCode: stage.wasteUnit,
        unitFactor: Number(stage.wasteUnitFactor || 1),
        convertedQty: Number(stage.convertedWasteQty ?? stage.wasteQty ?? 0),
        financialCost: null,
        financialCostStatus: "not_separately_measured",
      }));
  const stageWasteQty = Number.isFinite(Number(wasteSummary?.stageWasteQty))
    ? Number(wasteSummary.stageWasteQty)
    : fallbackStageWaste.reduce((sum: number, row: any) => sum + Number(row.convertedQty || 0), 0);
  const normalStageWasteQty = Number.isFinite(Number(wasteSummary?.normalStageWasteQty))
    ? Number(wasteSummary.normalStageWasteQty)
    : fallbackStageWaste
      .filter((row: any) => row.classification === "normal")
      .reduce((sum: number, row: any) => sum + Number(row.convertedQty || 0), 0);
  const abnormalStageWasteQty = Number.isFinite(Number(wasteSummary?.abnormalStageWasteQty))
    ? Number(wasteSummary.abnormalStageWasteQty)
    : Math.max(0, stageWasteQty - normalStageWasteQty);
  const headerWasteQty = Number.isFinite(Number(wasteSummary?.headerWasteQty))
    ? Number(wasteSummary.headerWasteQty)
    : Number(costDrilldown.order?.wasteQty || 0);
  const additionalHeaderWasteQty = Number.isFinite(Number(wasteSummary?.additionalHeaderWasteQty))
    ? Number(wasteSummary.additionalHeaderWasteQty)
    : Math.max(0, headerWasteQty - stageWasteQty);
  const financialCostValue = (row: any) =>
    row.financialCost !== undefined ? row.financialCost : row.amount;
  const financialCostKnown = (row: any) => {
    const value = financialCostValue(row);
    return value != null && Number.isFinite(Number(value));
  };
  const recordedWasteFinancialCostRows = waste.filter(financialCostKnown);
  const recordedWasteFinancialCost = Number.isFinite(Number(wasteSummary?.recordedWasteFinancialCost))
    ? Number(wasteSummary.recordedWasteFinancialCost)
    : recordedWasteFinancialCostRows.reduce(
      (sum: number, row: any) => sum + Number(financialCostValue(row) || 0),
      0,
    );
  const wasteFinancialCostAvailable = recordedWasteFinancialCostRows.length > 0 ||
    Number(wasteSummary?.recordedWasteFinancialCostRows || 0) > 0;
  const financialCostText = (row: any) =>
    financialCostKnown(row) ? formatMoney(financialCostValue(row)) : "غير متاح";

  return (
    <div className="space-y-6">
      <ProductionTimeCosts trace={trace} status={orderStatus} />
      {/* KPI Cards */}
      <div className="grid md:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-white p-4 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 end-0 w-16 h-16 bg-gradient-to-br from-violet-100 to-transparent rounded-bl-full opacity-50" />
          <div className="text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wider">التكلفة التقديرية (القياسية)</div>
          <div className="text-2xl font-bold text-slate-800">{formatMoney(std)}</div>
        </div>
        
        <div className="rounded-xl border bg-white p-4 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 end-0 w-16 h-16 bg-gradient-to-br from-blue-100 to-transparent rounded-bl-full opacity-50" />
          <div className="text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wider">التكلفة الفعلية (تراكمي)</div>
          <div className="text-2xl font-bold text-slate-800">{formatMoney(act)}</div>
        </div>

        <div className="rounded-xl border bg-white p-4 shadow-sm relative overflow-hidden">
           <div className={`absolute top-0 end-0 w-16 h-16 bg-gradient-to-br ${variance <= 0 ? 'from-emerald-100' : 'from-rose-100'} to-transparent rounded-bl-full opacity-50`} />
          <div className="text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wider">الانحراف (Variance)</div>
           <div className={`text-2xl font-bold flex items-center gap-2 ${variance <= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
            {formatMoney(Math.abs(variance))}
             {variance > 0 ? (
              <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200 text-[10px]">تجاوز</Badge>
             ) : variance < 0 ? (
               <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 text-[10px]">توفير</Badge>
            ) : null}
          </div>
        </div>
      </div>

      {/* Detailed Trace */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden text-sm">
        <div className="bg-slate-50 border-b p-3 font-semibold text-slate-700 flex items-center gap-2">
          <Split className="h-4 w-4 text-violet-500" /> تتبع مسببات التكلفة (Drivers & Sources)
        </div>
        
        <div className="divide-y">
          {/* Materials */}
          <div className="p-4 hover:bg-slate-50/50 transition-colors">
            <div className="flex items-center justify-between mb-2">
              <div className="font-semibold text-slate-800">المواد الخام والتغليف</div>
              <div className="font-bold text-slate-800">{formatMoney(materials.reduce((sum: number, row: any) => sum + Number(row.amount || 0), 0))}</div>
            </div>
            <div className="text-xs text-slate-500 mb-3">مسحوبة عبر صرف مخزني مباشر للأمر</div>
            {materials.length > 0 ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                {materials.map((m: any, i: number) => (
                  <div key={i} className="bg-white border rounded p-2 flex justify-between">
                    <span className="truncate pe-2 text-slate-600">{m.itemName || `صنف #${m.itemId}`}</span>
                    <span className="font-medium">{formatMoney(m.amount)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-slate-400">لا توجد مواد مصروفة.</div>
            )}
          </div>

          {Number(resourceCosts?.version) >= 1 && (
            <div className="p-4 hover:bg-slate-50/50 transition-colors">
              <div className="flex items-center justify-between mb-2">
                <div className="font-semibold text-slate-800">مكونات موارد التنفيذ المجمدة</div>
                <div className="font-bold text-slate-800">{formatMoney(resourceTotals?.total)}</div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                <div className="rounded border bg-white p-2">عمالة: <b>{formatMoney(resourceTotals?.labor)}</b></div>
                <div className="rounded border bg-white p-2">إهلاك: <b>{formatMoney(resourceTotals?.depreciation)}</b></div>
                <div className="rounded border bg-white p-2">كهرباء: <b>{formatMoney(resourceTotals?.electricity)}</b></div>
                <div className="rounded border bg-white p-2">عبء مصنع: <b>{formatMoney(resourceTotals?.factoryOverhead)}</b></div>
              </div>
              <div className="mt-2 text-xs leading-5 text-slate-500">
                هذه تفصيلة لقطات خادم وليست جمعاً جديداً فوق إجمالي التكلفة الفعلية. {hasProvisionalElectricityAccrual
                  ? "تحمل الكهرباء المعلّقة استحقاقاً مؤقتاً مرسملًا ضمن استلام الإنتاج؛ التسوية اللاحقة تزيل الاستحقاق وتطبّق فرق الفاتورة الفعلية فقط."
                  : "تظل الكهرباء المرتبطة بمصدر مرحّل ضمن مسار المصدر، أما اللقطات التاريخية بلا استحقاق فتبقى أدلة استخدام فقط."}
              </div>
            </div>
          )}

          {/* Labor */}
          <div className="p-4 hover:bg-slate-50/50 transition-colors">
            <div className="flex items-center justify-between mb-2">
              <div className="font-semibold text-slate-800">الأجور والعمالة (Labor)</div>
              <div className="font-bold text-slate-800">{formatMoney(labor?.amount)}</div>
            </div>
            <div className="text-xs text-slate-500 mb-3">محملة من مصدر: {labor?.sourceType || 'غير محدد'} (فترة: {labor?.period || '—'})</div>
            {labor?.source && Array.isArray(labor.source) && labor.source.length > 0 && (
              <div className="text-xs border rounded p-2 bg-white max-h-32 overflow-y-auto">
                <table className="w-full text-left">
                  <tbody>
                    {labor.source.map((s: any, i: number) => (
                      <tr key={i} className="border-b last:border-0 border-slate-100">
                        <td className="py-1 text-right text-slate-600">مصدر رواتب #{s.sourceRecordId}</td>
                        <td className="py-1">{["operating_hours", "fixed_hourly_rate"].includes(s.snapshotMeta?.formulaMethod) ? `${s.snapshotMeta.numerator} ساعة مخططة` : "تخصيص معتمد"}</td>
                        <td className="py-1 text-violet-600 font-medium">{formatMoney(s.allocatedAmount)} <span className="text-slate-500">تحميل أصلي</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Overhead */}
          <div className="p-4 hover:bg-slate-50/50 transition-colors">
            <div className="flex items-center justify-between mb-2">
              <div className="font-semibold text-slate-800">التكاليف غير المباشرة (Overhead / Depreciation)</div>
              <div className="font-bold text-slate-800">{formatMoney(overhead?.amount)}</div>
            </div>
            <div className="text-xs text-slate-500 mb-2">موزعة بناءً على: {overhead?.driver || 'مراكز التكلفة / الساعات'}</div>
            {overhead?.notes && <div className="text-xs text-amber-700 bg-amber-50 p-2 rounded">{overhead.notes}</div>}
          </div>

          {/* Waste */}
          <div className="p-4 hover:bg-slate-50/50 transition-colors">
            <div className="flex items-center justify-between mb-2">
              <div className="font-semibold text-rose-700 flex items-center gap-1.5"><AlertCircle className="h-4 w-4" /> التكلفة المالية المسجلة للهالك</div>
              <div className="font-bold text-rose-700">
                {wasteFinancialCostAvailable ? formatMoney(recordedWasteFinancialCost) : "غير متاح"}
              </div>
            </div>
            <div className="text-xs text-slate-600 bg-slate-50 p-2.5 rounded-md border border-slate-100 mb-3 leading-relaxed">
              <strong>تكلفة الهالك الطبيعي (Normal Waste)</strong> تُرسمل (Capitalized) وتبقى كجزء من تكلفة مخزون المنتج التام (WIP).<br/>
              <strong>الهالك غير الطبيعي (Abnormal) والهالك غير المصنف (Unclassified Header Waste)</strong> يُقيد مباشرة كمصروف خسارة ويُحمل على حساب فروقات تكلفة الإنتاج (Variance/Waste Expense Account).
            </div>
            <div className="mb-3 rounded-md border border-rose-100 bg-rose-50/40 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <strong className="text-rose-900">الكميات الفعلية المحفوظة</strong>
                <span className="text-[11px] text-slate-500">لا تُستنتج من المخطط ناقص المنتج</span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-5">
                <div className="rounded border bg-white p-2">
                  هالك المراحل
                  <b className="mt-1 block">{formatQuantity(stageWasteQty)}</b>
                </div>
                <div className="rounded border bg-white p-2">
                  طبيعي
                  <b className="mt-1 block text-emerald-700">{formatQuantity(normalStageWasteQty)}</b>
                </div>
                <div className="rounded border bg-white p-2">
                  غير طبيعي
                  <b className="mt-1 block text-rose-700">{formatQuantity(abnormalStageWasteQty)}</b>
                </div>
                <div className="rounded border bg-white p-2">
                  رأس الأمر
                  <b className="mt-1 block">{formatQuantity(headerWasteQty)}</b>
                </div>
                <div className="rounded border border-amber-200 bg-amber-50 p-2">
                  إضافي غير مصنف
                  <b className="mt-1 block text-amber-700">{formatQuantity(additionalHeaderWasteQty)}</b>
                </div>
              </div>
              <div className="mt-2 text-[11px] text-slate-600">
                قيمة التكلفة المالية المعروضة أعلاه تخص سجلات تكلفة الهالك فقط:
                {" "}
                {wasteFinancialCostAvailable
                  ? `${recordedWasteFinancialCostRows.length || Number(wasteSummary?.recordedWasteFinancialCostRows || 0)} سجل`
                  : "لا توجد قيمة مالية مسجلة"}
                . أما كمية الهالك الطبيعي فتبقى ظاهرة هنا حتى عندما لا تحمل صف تكلفة مستقل بقيمة 0.
              </div>
            </div>

            {waste.length > 0 || fallbackStageWaste.length > 0 || additionalHeaderWasteQty > 0 ? (
              <div className="grid md:grid-cols-2 gap-2 text-xs">
                {waste.map((w: any, i: number) => (
                  <div key={`record-${w.id ?? i}`} className={`border rounded p-2 flex flex-col gap-1 ${
                    w.classification === "abnormal"
                      ? "bg-rose-50/50 border-rose-200"
                      : w.classification === "normal"
                        ? "bg-white"
                        : "bg-amber-50/50 border-amber-200"
                  }`}>
                    <div className="flex justify-between font-semibold">
                      <span className={
                        w.classification === "abnormal"
                          ? "text-rose-700"
                          : w.classification === "normal"
                            ? "text-slate-700"
                            : "text-amber-800"
                      }>
                        {w.classification === "abnormal"
                          ? "هالك غير طبيعي (سجل)"
                          : w.classification === "normal"
                            ? "هالك طبيعي (سجل)"
                            : "هالك غير مصنف (سجل)"}
                      </span>
                      <span>{financialCostText(w)}</span>
                    </div>
                    {w.qty != null && (
                      <div className="text-slate-500">
                        الكمية: {formatQuantity(w.convertedQty ?? w.qty)} {w.unitCode || ""}
                      </div>
                    )}
                    {w.reason && (
                      <div className="text-slate-600 italic">السبب: {w.reason}</div>
                    )}
                  </div>
                ))}
                {fallbackStageWaste.map((w: any, i: number) => (
                  <div key={`stage-${w.stageId ?? i}`} className={`border rounded p-2 flex flex-col gap-1 ${w.classification === "abnormal" ? "bg-rose-50/50 border-rose-200" : "bg-emerald-50/30 border-emerald-200"}`}>
                    <div className="flex justify-between font-semibold">
                      <span className={w.classification === "abnormal" ? "text-rose-700" : "text-emerald-700"}>
                        {w.classification === "abnormal" ? "هالك مرحلة غير طبيعي" : "هالك مرحلة طبيعي"}
                      </span>
                      <span>{financialCostText(w)}</span>
                    </div>
                    <div className="text-slate-500">
                      المرحلة: {w.stageName || `#${w.stageId ?? "—"}`} — الكمية المحولة: {formatQuantity(w.convertedQty ?? w.qty)} {w.unitCode || ""}
                    </div>
                    <div className="text-[11px] text-slate-500">الهالك محفوظ ككمية تنفيذ؛ لا يمثل غياب صف التكلفة غياب الهالك.</div>
                  </div>
                ))}
                {additionalHeaderWasteQty > 0 && (
                  <div className="border border-amber-200 bg-amber-50/50 rounded p-2 flex flex-col gap-1">
                    <div className="flex justify-between font-semibold text-amber-800">
                      <span>هالك إضافي غير مصنف (رأس الأمر)</span>
                      <span>غير متاح</span>
                    </div>
                    <div className="text-slate-600">الكمية: {formatQuantity(additionalHeaderWasteQty)} {costDrilldown.order?.unitCode || ""}</div>
                    <div className="text-[11px] text-amber-800">مصروف هالك منفصل؛ لا تُخمن له تكلفة من الفرق بين الكميات.</div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-xs text-slate-400">لا توجد كمية هالك محفوظة أو تكلفة هالك مسجلة.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}