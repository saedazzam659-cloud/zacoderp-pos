import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Coins, Search, Download } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import AIInsightsPanel from "./_AIInsightsPanel";

function exportCsv(filename: string, headers: string[], rows: any[][]) {
  const esc = (v: any) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(","), ...rows.map(r => r.map(esc).join(","))].join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export default function EmployeeCostReport() {
  const fmt = useFmt();
  const [gosi, setGosi] = useState(11.75);
  const [activeGosi, setActiveGosi] = useState(11.75);

  const { data, isLoading } = useQuery({
    queryKey: ["hr-report-employee-cost", activeGosi],
    queryFn: () => employeesApi.reportEmployeeCost(activeGosi),
  });

  const summary = data?.summary;
  const rows = data?.rows ?? [];

  function handleExport() {
    if (!rows.length) return;
    exportCsv(
      `employee_cost_${new Date().toISOString().slice(0, 10)}.csv`,
      ["الكود", "الاسم", "القسم", "المسمى", "أساسي", "بدل سكن", "بدل نقل", "بدلات أخرى", "إجمالي شهري", "GOSI صاحب العمل", "تكلفة شهرية", "تكلفة سنوية"],
      rows.map((r: any) => [
        r.code, r.nameAr, r.department || "", r.jobTitle || "",
        r.basic.toFixed(2), r.housing.toFixed(2), r.transport.toFixed(2), r.other.toFixed(2),
        r.gross.toFixed(2), r.gosiEmployer.toFixed(2),
        r.monthlyCost.toFixed(2), r.annualCost.toFixed(2),
      ])
    );
  }

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Coins className="h-6 w-6 text-teal-600" /> تقرير تكلفة الموظفين
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            التكلفة الشهرية والسنوية لكل موظف شاملة حصة صاحب العمل من التأمينات
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={!rows.length} className="gap-2">
          <Download className="h-4 w-4" /> تصدير CSV
        </Button>
      </div>

      <div className="rounded-xl border bg-white p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <Label className="text-xs">نسبة GOSI لصاحب العمل (%)</Label>
            <Input type="number" step="0.01" min={0} max={50} value={gosi} onChange={(e) => setGosi(Number(e.target.value) || 0)} />
            <p className="text-[11px] text-muted-foreground mt-1">
              النسبة الافتراضية في السعودية: 11.75% للسعوديين، 2% للمقيمين (يحسب على الأساسي + السكن المغطى).
            </p>
          </div>
          <div className="flex items-end">
            <Button onClick={() => setActiveGosi(gosi)} className="w-full gap-2">
              <Search className="h-4 w-4" /> تحديث
            </Button>
          </div>
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="عدد الموظفين النشطين" value={summary.total} color="sky" />
          <StatCard label="إجمالي رواتب شهرية" value={fmt.fmt(summary.totalGross)} color="indigo" />
          <StatCard label="إجمالي GOSI صاحب العمل" value={fmt.fmt(summary.totalGosi)} color="amber" />
          <StatCard label="متوسط تكلفة شهرية" value={fmt.fmt(summary.averageMonthlyCost)} color="violet" />
          <StatCard label="إجمالي تكلفة شهرية" value={fmt.fmt(summary.totalMonthlyCost)} color="rose" />
          <StatCard label="إجمالي تكلفة سنوية" value={fmt.fmt(summary.totalAnnualCost)} color="green" cls="sm:col-span-2" />
          <StatCard label="نسبة GOSI المطبقة" value={`${summary.gosiEmployerPct}%`} color="teal" />
        </div>
      )}

      <div className="rounded-xl border bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b">
              <tr className="text-right">
                <th className="px-3 py-2.5 font-semibold">الكود</th>
                <th className="px-3 py-2.5 font-semibold">الاسم</th>
                <th className="px-3 py-2.5 font-semibold">القسم</th>
                <th className="px-3 py-2.5 font-semibold text-left">أساسي</th>
                <th className="px-3 py-2.5 font-semibold text-left">سكن</th>
                <th className="px-3 py-2.5 font-semibold text-left">نقل</th>
                <th className="px-3 py-2.5 font-semibold text-left">إجمالي شهري</th>
                <th className="px-3 py-2.5 font-semibold text-left">GOSI</th>
                <th className="px-3 py-2.5 font-semibold text-left">تكلفة شهرية</th>
                <th className="px-3 py-2.5 font-semibold text-left">تكلفة سنوية</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b"><td colSpan={10} className="px-3 py-2"><Skeleton className="h-6 w-full" /></td></tr>
                ))
              ) : rows.length === 0 ? (
                <tr><td colSpan={10} className="px-3 py-10 text-center text-muted-foreground">لا توجد بيانات</td></tr>
              ) : rows.map((r: any) => (
                <tr key={r.id} className="border-b hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-xs">{r.code}</td>
                  <td className="px-3 py-2 font-medium">{r.nameAr}</td>
                  <td className="px-3 py-2 text-xs">{r.department || "—"}</td>
                  <td className="px-3 py-2 text-left font-mono">{fmt.fmt(r.basic)}</td>
                  <td className="px-3 py-2 text-left font-mono">{fmt.fmt(r.housing)}</td>
                  <td className="px-3 py-2 text-left font-mono">{fmt.fmt(r.transport)}</td>
                  <td className="px-3 py-2 text-left font-mono">{fmt.fmt(r.gross)}</td>
                  <td className="px-3 py-2 text-left font-mono text-amber-700">{fmt.fmt(r.gosiEmployer)}</td>
                  <td className="px-3 py-2 text-left font-mono font-semibold text-rose-700">{fmt.fmt(r.monthlyCost)}</td>
                  <td className="px-3 py-2 text-left font-mono font-bold text-emerald-700">{fmt.fmt(r.annualCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {summary && rows.length > 0 && (
        <AIInsightsPanel
          reportType="employee-cost"
          title="تقرير تكلفة الموظفين"
          summary={summary}
          rows={rows}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, color, cls = "" }: { label: string; value: any; color: string; cls?: string }) {
  const palette: Record<string, string> = {
    sky: "border-sky-200 bg-sky-50 text-sky-800",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
    green: "border-green-200 bg-green-50 text-green-800",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    indigo: "border-indigo-200 bg-indigo-50 text-indigo-800",
    violet: "border-violet-200 bg-violet-50 text-violet-800",
    rose: "border-rose-200 bg-rose-50 text-rose-800",
    teal: "border-teal-200 bg-teal-50 text-teal-800",
  };
  return (
    <div className={`rounded-lg border p-3 ${palette[color] || palette.sky} ${cls}`}>
      <div className="text-xs opacity-80">{label}</div>
      <div className="text-lg font-bold mt-0.5">{value}</div>
    </div>
  );
}
