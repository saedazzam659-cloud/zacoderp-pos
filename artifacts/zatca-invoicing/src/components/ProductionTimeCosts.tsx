import { Clock } from "lucide-react";

/** Read-only view of persisted execution and approved source snapshots. */
export function ProductionTimeCosts({ trace, status }: { trace: any; status: string }) {
  const stages = Array.isArray(trace?.stages) ? trace.stages : [];
  const allocations = Array.isArray(trace?.allocations) ? trace.allocations : [];
  // This object is returned by the server from immutable source snapshots.
  // It is deliberately displayed as-is; no browser-side financial rollup is made.
  const resourceCost = trace?.resourceCost ?? trace?.resourceCosts ?? null;
  const resourceStages = Array.isArray(resourceCost?.stages) ? resourceCost.stages : [];
  const hours = stages.reduce((sum: number, stage: any) => sum + Number(stage.actualDurationMinutes ?? 0) / 60, 0);
  const fmt = (value: unknown) => Number(value ?? 0).toLocaleString("en-US", { maximumFractionDigits: 4 });
  const money = (value: unknown) => value == null ? "—" : Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sourceLabels: Record<string, string> = {
    payroll: "الرواتب", fixed_asset_depreciation: "الإهلاك", prepaid_amortization: "المصروفات المقدمة",
    industrial_purchase: "مشتريات صناعية",
  };
  return (
    <section className="rounded-xl border border-violet-200 bg-violet-50/30 p-4 space-y-3">
      <div className="flex flex-wrap justify-between gap-2 font-semibold">
        <span className="flex items-center gap-2"><Clock className="h-4 w-4" /> الوقت الفعلي وربطه بالتكاليف</span>
        <span>{fmt(hours)} ساعة محفوظة</span>
      </div>
      <p className="text-xs text-slate-600">
        الوقت يُقرأ من بيانات المراحل المحفوظة. تكلفة المورد أدناه لقطة خادم مصدرية؛ لا يعاد حسابها من أسعار أو إعدادات المتصفح الحالية.
        {status !== "completed" && " تسوية فرق التحميل تتم عند إكمال الأمر، وليس عند حفظ المرحلة."}
      </p>
      {stages.length > 0 && <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b text-slate-500"><th className="text-start p-2">المرحلة</th><th className="text-start p-2">دقائق العمل</th><th className="text-start p-2">الساعات</th><th className="text-start p-2">عدد العمالة</th></tr></thead>
          <tbody>{stages.map((stage: any) => <tr key={stage.id} className="border-b last:border-0">
            <td className="p-2">{stage.name}</td><td className="p-2">{fmt(stage.actualDurationMinutes)}</td>
            <td className="p-2">{fmt(Number(stage.actualDurationMinutes ?? 0) / 60)}</td><td className="p-2">{stage.workerCount == null ? "—" : fmt(stage.workerCount)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      {Number(resourceCost?.version) >= 1 && (
        <div className="space-y-3 rounded-lg border border-violet-200 bg-white p-3">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-semibold text-violet-950">لقطة تكلفة موارد المراحل</h4>
            <span className="text-[11px] text-violet-700">إصدار اللقطة {resourceCost.version}</span>
          </div>
          <p className="text-xs leading-5 text-amber-900">الكهرباء تقدير استخدام للآلة فقط وليست تكلفة مرسملة أو مبلغاً فعلياً حتى يُربط مصدر كهرباء صناعي مُرحّل عبر مسار التخصيص والإقفال القائم. لا تُضاف تلقائياً إلى إجمالي محاسبة الأمر.</p>
          {resourceStages.length > 0 ? <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-xs">
              <thead><tr className="border-b text-slate-500">
                <th className="p-2 text-start">المرحلة</th><th className="p-2 text-start">نمط المورد</th><th className="p-2 text-start">عمالة</th><th className="p-2 text-start">إهلاك</th><th className="p-2 text-start">كهرباء (تقدير)</th><th className="p-2 text-start">عبء مصنع</th><th className="p-2 text-start">إجمالي لقطة الاستخدام</th>
              </tr></thead>
              <tbody>{resourceStages.map((stage: any) => {
                const routeStage = stages.find((candidate: any) => String(candidate.id) === String(stage.stageId));
                const modeLabel = stage.resourceMode === "both" ? "آلة + عمالة" : stage.resourceMode === "machine" ? "آلة" : "عمالة";
                return <tr key={stage.stageId} className="border-b last:border-0">
                  <td className="p-2 font-medium">{routeStage?.name ?? `#${stage.stageId}`}</td>
                  <td className="p-2">{modeLabel}</td><td className="p-2">{money(stage.labor)}</td><td className="p-2">{money(stage.depreciation)}</td>
                  <td className="p-2">{money(stage.electricity)}</td><td className="p-2">{money(stage.factoryOverhead)}</td><td className="p-2 font-semibold">{money(stage.total)}</td>
                </tr>;
              })}</tbody>
              {resourceCost?.totals && <tfoot><tr className="border-t-2 border-violet-200 font-semibold text-violet-950">
                <td className="p-2" colSpan={2}>إجمالي لقطة الاستخدام (لا يرحّل الكهرباء)</td><td className="p-2">{money(resourceCost.totals.labor)}</td><td className="p-2">{money(resourceCost.totals.depreciation)}</td>
                <td className="p-2">{money(resourceCost.totals.electricity)}</td><td className="p-2">{money(resourceCost.totals.factoryOverhead)}</td><td className="p-2">{money(resourceCost.totals.total)}</td>
              </tr></tfoot>}
            </table>
          </div> : <p className="text-xs text-slate-500">لا توجد لقطة تكلفة مرحلة مكتملة بعد.</p>}
        </div>
      )}
      <div className="space-y-2">
        {allocations.map((source: any) => {
          const meta = source.snapshotMeta ?? {};
          const method = meta.formulaMethod;
          const rule = method === "operating_hours"
            ? `ساعات التشغيل ÷ ${fmt(meta.denominatorOrRate)} ساعة معتمدة × قيمة المصدر`
            : method === "fixed_hourly_rate"
              ? `ساعات التشغيل × معدل ${fmt(meta.denominatorOrRate)} للساعة`
              : method === "production_quantity" ? "حسب كمية الإنتاج، وليس الوقت" : "حسب التخصيص المعتمد، وليس الوقت";
          return <div key={source.id} className="rounded-lg border bg-white p-3 text-sm">
            <div className="font-medium">{sourceLabels[source.sourceType] ?? "مصدر تكلفة"} #{source.sourceRecordId}</div>
            <div className="text-xs text-slate-600 mt-1">{rule}</div>
            {meta.includeInManufacturing === false && <div className="text-xs text-amber-700 mt-1">تحليلي فقط — غير محمل على التصنيع</div>}
          </div>;
        })}
        {allocations.length === 0 && <p className="text-sm text-slate-500">لا توجد مصادر تكلفة مرتبطة بهذا الأمر؛ تسجيل الوقت وحده لا ينشئ مصروفًا.</p>}
      </div>
    </section>
  );
}