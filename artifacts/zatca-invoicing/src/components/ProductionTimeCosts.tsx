import { Clock } from "lucide-react";

/** Read-only view of persisted execution and approved source snapshots. */
export function ProductionTimeCosts({ trace, status }: { trace: any; status: string }) {
  const stages = Array.isArray(trace?.stages) ? trace.stages : [];
  const allocations = Array.isArray(trace?.allocations) ? trace.allocations : [];
  const hours = stages.reduce((sum: number, stage: any) => sum + Number(stage.actualDurationMinutes ?? 0) / 60, 0);
  const fmt = (value: unknown) => Number(value ?? 0).toLocaleString("en-US", { maximumFractionDigits: 4 });
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
        الوقت يُقرأ من بيانات المراحل المحفوظة. المصادر المرتبطة بالساعات تستخدم قاعدة التحميل المعتمدة؛ عدد العمالة لا يضاعف التكلفة تلقائيًا.
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