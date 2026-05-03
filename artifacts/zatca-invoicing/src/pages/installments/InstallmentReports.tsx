import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BarChart3, CreditCard, Wallet, AlertTriangle, TrendingUp,
  ShieldCheck, ShieldAlert, ShieldX, Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

function fmt(n: number | string | null | undefined) {
  return Number(n ?? 0).toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type RiskRow = {
  id: number; contractNumber: string; customerName: string;
  creditScore: number | null; riskLevel: "low"|"medium"|"high";
  defaultProbability: string | null; totalAmount: string; status: string;
};

export default function InstallmentReports() {
  const { user, token } = useAuth() as any;
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const { data: stats, isLoading: ls } = useQuery<any>({
    queryKey: ["installments-stats", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/installments/stats?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل التحميل");
      return r.json();
    },
    enabled: !!cid,
  });

  const { data: risk = [], isLoading: lr } = useQuery<RiskRow[]>({
    queryKey: ["installments-risk", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/installments/reports/risk?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل التحميل");
      return r.json();
    },
    enabled: !!cid,
  });

  const lowRisk = risk.filter(r => r.riskLevel === "low").length;
  const medRisk = risk.filter(r => r.riskLevel === "medium").length;
  const hiRisk  = risk.filter(r => r.riskLevel === "high").length;

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-amber-600" />
          تقارير التقسيط
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          نظرة شاملة على المحفظة — العقود، الأرباح، التحصيل، والمخاطر.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard icon={CreditCard} label="إجمالي العقود" value={ls ? "…" : String(stats?.contracts ?? 0)} tone="indigo" />
        <KpiCard icon={Activity}   label="عقود نشطة" value={ls ? "…" : String(stats?.active ?? 0)}     tone="emerald" />
        <KpiCard icon={AlertTriangle} label="بانتظار الموافقة" value={ls ? "…" : String(stats?.pending ?? 0)} tone="amber" />
        <KpiCard icon={AlertTriangle} label="أقساط متأخرة" value={ls ? "…" : String(stats?.overdue ?? 0)} tone="rose" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <KpiCard icon={Wallet}    label="إجمالي المحصَّل" value={ls ? "…" : `${fmt(stats?.collected ?? 0)} ر.س`} tone="emerald" />
        <KpiCard icon={TrendingUp} label="المبالغ المتبقية"  value={ls ? "…" : `${fmt(stats?.outstanding ?? 0)} ر.س`} tone="amber" />
        <KpiCard icon={TrendingUp} label="إجمالي الأرباح (الفوائد)"   value={ls ? "…" : `${fmt(stats?.profits ?? 0)} ر.س`}     tone="indigo" />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <RiskBox icon={ShieldCheck} count={lowRisk} label="مخاطر منخفضة" tone="emerald" />
        <RiskBox icon={ShieldAlert} count={medRisk} label="مخاطر متوسطة" tone="amber" />
        <RiskBox icon={ShieldX}    count={hiRisk}  label="مخاطر عالية"  tone="rose" />
      </div>

      <div className="rounded-lg border bg-white overflow-hidden shadow-sm">
        <div className="px-3 py-2 bg-slate-100 border-b font-bold text-sm flex items-center gap-2">
          <ShieldAlert className="h-4 w-4" /> العقود مرتبة حسب احتمال التعثر
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs" dir="rtl">
            <thead className="bg-slate-50">
              <tr>
                <th className="p-2 text-start">رقم العقد</th>
                <th className="p-2 text-start">العميل</th>
                <th className="p-2 text-end">القيمة الإجمالية</th>
                <th className="p-2 text-center">الدرجة</th>
                <th className="p-2 text-center">المخاطر</th>
                <th className="p-2 text-center">احتمال التعثر</th>
                <th className="p-2 text-center">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {lr && <tr><td colSpan={7} className="p-8"><Skeleton className="h-12" /></td></tr>}
              {!lr && risk.length === 0 && (
                <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">لا توجد عقود حتى الآن</td></tr>
              )}
              {risk.map(r => (
                <tr key={r.id} className="border-t hover:bg-slate-50">
                  <td className="p-2 font-mono">{r.contractNumber}</td>
                  <td className="p-2 font-medium">{r.customerName}</td>
                  <td className="p-2 text-end">{fmt(r.totalAmount)}</td>
                  <td className="p-2 text-center">
                    <span className={cn("inline-block min-w-[2.5rem] py-0.5 rounded font-bold",
                      (r.creditScore ?? 0) >= 75 ? "bg-emerald-100 text-emerald-800" :
                      (r.creditScore ?? 0) >= 55 ? "bg-amber-100 text-amber-800" : "bg-rose-100 text-rose-800")}>
                      {r.creditScore ?? "—"}
                    </span>
                  </td>
                  <td className="p-2 text-center">
                    <span className={cn("inline-block px-2 py-0.5 rounded-full text-[10px] font-medium",
                      r.riskLevel === "low" ? "bg-emerald-100 text-emerald-800" :
                      r.riskLevel === "medium" ? "bg-amber-100 text-amber-800" : "bg-rose-100 text-rose-800")}>
                      {r.riskLevel === "low" ? "منخفضة" : r.riskLevel === "medium" ? "متوسطة" : "عالية"}
                    </span>
                  </td>
                  <td className="p-2 text-center font-bold text-rose-700">{Number(r.defaultProbability ?? 0)}%</td>
                  <td className="p-2 text-center">{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function KpiCard({ icon: Icon, label, value, tone }: { icon: any; label: string; value: string; tone: string }) {
  const toneClass = {
    indigo: "border-indigo-200 bg-indigo-50 text-indigo-700",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    rose: "border-rose-200 bg-rose-50 text-rose-700",
  }[tone] ?? "";
  return (
    <div className={cn("rounded-lg border p-4", toneClass)}>
      <div className="flex items-center gap-2 text-xs">
        <Icon className="h-4 w-4" /> {label}
      </div>
      <div className="text-2xl font-bold mt-2">{value}</div>
    </div>
  );
}

function RiskBox({ icon: Icon, count, label, tone }: { icon: any; count: number; label: string; tone: string }) {
  const toneClass = {
    emerald: "border-emerald-300 bg-emerald-50 text-emerald-800",
    amber: "border-amber-300 bg-amber-50 text-amber-800",
    rose: "border-rose-300 bg-rose-50 text-rose-800",
  }[tone] ?? "";
  return (
    <div className={cn("rounded-lg border p-4 flex flex-col items-center justify-center", toneClass)}>
      <Icon className="h-8 w-8" />
      <div className="text-3xl font-extrabold mt-2">{count}</div>
      <div className="text-xs mt-1">{label}</div>
    </div>
  );
}
