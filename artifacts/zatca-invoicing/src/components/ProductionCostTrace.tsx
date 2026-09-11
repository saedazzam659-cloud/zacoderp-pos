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

  const totals = costDrilldown.totals || {};
  const act = Number(totals.actual || 0);
  const std = Number(totals.standard || 0);
  const variance = std - act; // Positive means saving, Negative means over budget

  const formatMoney = (val: any) => {
    const num = Number(val);
    return Number.isFinite(num) ? num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
  };

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
          <div className={`absolute top-0 end-0 w-16 h-16 bg-gradient-to-br ${variance >= 0 ? 'from-emerald-100' : 'from-rose-100'} to-transparent rounded-bl-full opacity-50`} />
          <div className="text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wider">الانحراف (Variance)</div>
          <div className={`text-2xl font-bold flex items-center gap-2 ${variance >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
            {formatMoney(Math.abs(variance))}
            {variance > 0 ? (
              <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 text-[10px]">توفير</Badge>
            ) : variance < 0 ? (
              <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200 text-[10px]">تجاوز</Badge>
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
              <div className="font-semibold text-rose-700 flex items-center gap-1.5"><AlertCircle className="h-4 w-4" /> تكلفة الهالك (Waste)</div>
              <div className="font-bold text-rose-700">{formatMoney(waste.reduce((sum: number, row: any) => sum + Number(row.amount || 0), 0))}</div>
            </div>
            <div className="text-xs text-slate-600 bg-slate-50 p-2.5 rounded-md border border-slate-100 mb-3 leading-relaxed">
              <strong>تكلفة الهالك الطبيعي (Normal Waste)</strong> تُرسمل (Capitalized) وتبقى كجزء من تكلفة مخزون المنتج التام (WIP).<br/>
              <strong>الهالك غير الطبيعي (Abnormal) والهالك غير المصنف (Unclassified Header Waste)</strong> يُقيد مباشرة كمصروف خسارة ويُحمل على حساب فروقات تكلفة الإنتاج (Variance/Waste Expense Account).
            </div>
            
            {waste.length > 0 ? (
              <div className="grid md:grid-cols-2 gap-2 text-xs">
                {waste.map((w: any, i: number) => (
                  <div key={i} className={`border rounded p-2 flex flex-col gap-1 ${w.classification === "abnormal" ? "bg-rose-50/50 border-rose-200" : "bg-white"}`}>
                    <div className="flex justify-between font-semibold">
                      <span className={w.classification === "abnormal" ? "text-rose-700" : "text-slate-700"}>
                        {w.classification === "abnormal" ? "هالك غير طبيعي (استثنائي)" : "هالك طبيعي (مخطط)"}
                      </span>
                      <span>{formatMoney(w.amount)}</span>
                    </div>
                    {w.qty != null && (
                      <div className="text-slate-500">
                        الكمية: {Number(w.qty).toLocaleString()} {w.unitCode || ""}
                      </div>
                    )}
                    {w.reason && (
                      <div className="text-slate-600 italic">السبب: {w.reason}</div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-slate-400">لا توجد تكلفة هالك مسجلة.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}