import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { BarChart3, Package, Wrench, ArrowRightLeft, Trash2, AlertTriangle } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Summary = {
  totalAssets: number; totalPurchase: number; totalBookValue: number;
  totalAccumulatedDepreciation: number; totalMaintenanceCost: number;
  maintenanceCount: number; transfersCount: number; disposalsCount: number;
  depreciationRuns: number; expiringInsurance: number;
  byStatus: Record<string, number>;
};

const STATUS_LABELS: Record<string,string> = {
  active:"نشط", in_maintenance:"تحت الصيانة", transferred:"منقول",
  sold:"مباع", scrapped:"مخرّد", fully_depreciated:"مهلك بالكامل",
};

export default function FaReports() {
  const { user, token } = useAuth() as any;
  const cid = user?.companyId;
  const headers = { Authorization: `Bearer ${token}` };

  const { data: s, isLoading } = useQuery<Summary>({
    queryKey:["fa/summary", cid],
    queryFn: async () => (await fetch(`${API}/api/fixed-assets/summary?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });

  const card = (label:string, value:string|number, icon:any, color:string) => {
    const Icon = icon;
    return (
      <div className={`border rounded-lg p-4 bg-${color}-50 border-${color}-200`}>
        <div className="flex items-center justify-between">
          <div>
            <div className={`text-xs text-${color}-700`}>{label}</div>
            <div className={`text-xl font-bold mt-1 text-${color}-800 font-mono`}>{value}</div>
          </div>
          <Icon className={`h-8 w-8 text-${color}-400`} />
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-emerald-600" />
          تقارير الأصول الثابتة
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          ملخص شامل: الأصول، الإهلاك، الصيانة، النقل، التخلص، وتنبيهات التأمين
        </p>
      </div>

      {isLoading && <div className="text-center py-8 text-muted-foreground">جاري التحميل…</div>}

      {s && <>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {card("إجمالي الأصول", s.totalAssets, Package, "emerald")}
          {card("قيمة الشراء", `${s.totalPurchase.toLocaleString("ar-EG")} ر.س`, Package, "blue")}
          {card("القيمة الدفترية", `${s.totalBookValue.toLocaleString("ar-EG")} ر.س`, Package, "violet")}
          {card("الإهلاك المتراكم", `${s.totalAccumulatedDepreciation.toLocaleString("ar-EG")} ر.س`, Package, "amber")}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {card("سجلات الصيانة", s.maintenanceCount, Wrench, "orange")}
          {card("تكلفة الصيانة", `${s.totalMaintenanceCost.toLocaleString("ar-EG")} ر.س`, Wrench, "orange")}
          {card("عمليات النقل", s.transfersCount, ArrowRightLeft, "indigo")}
          {card("عمليات التخلص", s.disposalsCount, Trash2, "rose")}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {card("ترحيلات الإهلاك", s.depreciationRuns, BarChart3, "violet")}
          {card("تأمين قارب على الانتهاء (30 يوم)", s.expiringInsurance, AlertTriangle, "rose")}
        </div>

        <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
          <div className="px-4 py-2 border-b bg-slate-50 text-sm font-semibold text-slate-800">
            توزيع الأصول حسب الحالة
          </div>
          <div className="p-4">
            {Object.keys(s.byStatus).length === 0 && <div className="text-center text-muted-foreground py-4">لا توجد بيانات</div>}
            {Object.entries(s.byStatus).map(([k,v]) => {
              const pct = s.totalAssets > 0 ? (v / s.totalAssets) * 100 : 0;
              return (
                <div key={k} className="mb-3">
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-semibold">{STATUS_LABELS[k] || k}</span>
                    <span className="font-mono text-muted-foreground">{v} ({pct.toFixed(1)}%)</span>
                  </div>
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </>}
    </div>
  );
}
