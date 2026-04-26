import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Banknote, Search, Download } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import AIInsightsPanel from "./_AIInsightsPanel";

const MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

function exportCsv(filename: string, headers: string[], rows: any[][]) {
  const sep = ",";
  const esc = (v: any) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(sep), ...rows.map(r => r.map(esc).join(sep))].join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export default function PayrollReport() {
  const fmt = useFmt();
  const now = new Date();
  const [year, setYear] = useState<number>(now.getFullYear());
  const [monthFrom, setMonthFrom] = useState<number>(1);
  const [monthTo, setMonthTo] = useState<number>(12);
  const [filters, setFilters] = useState({ year: now.getFullYear(), monthFrom: 1, monthTo: 12 });

  const { data, isLoading } = useQuery({
    queryKey: ["hr-report-payroll", filters],
    queryFn: () => employeesApi.reportPayroll(filters),
  });

  function apply() { setFilters({ year, monthFrom, monthTo }); }

  const summary = data?.summary;
  const employees = data?.employees ?? [];

  function handleExport() {
    if (!employees.length) return;
    exportCsv(
      `payroll_report_${filters.year}_${filters.monthFrom}-${filters.monthTo}.csv`,
      ["الكود", "الاسم", "القسم", "أشهر", "الإجمالي", "أوفر تايم", "مكافآت", "GOSI", "السلف", "إجمالي الاستقطاعات", "الصافي"],
      employees.map((e: any) => [
        e.empCode, e.empName, e.department || "", e.months,
        e.gross.toFixed(2), e.overtime.toFixed(2), e.bonus.toFixed(2),
        e.gosi.toFixed(2), e.loans.toFixed(2), e.deductions.toFixed(2), e.net.toFixed(2),
      ])
    );
  }

  const years = Array.from({ length: 6 }, (_, i) => now.getFullYear() - i);

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Banknote className="h-6 w-6 text-primary" /> تقرير الرواتب
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            ملخص مسيرات الرواتب لفترة محددة مع الإجمالي والاستقطاعات والصافي
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={!employees.length} className="gap-2">
          <Download className="h-4 w-4" /> تصدير CSV
        </Button>
      </div>

      <div className="rounded-xl border bg-white p-4">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div>
            <Label className="text-xs">السنة</Label>
            <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {years.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">من شهر</Label>
            <Select value={String(monthFrom)} onValueChange={(v) => setMonthFrom(Number(v))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTHS_AR.map((m, i) => <SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">إلى شهر</Label>
            <Select value={String(monthTo)} onValueChange={(v) => setMonthTo(Number(v))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTHS_AR.map((m, i) => <SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <Button onClick={apply} className="w-full gap-2">
              <Search className="h-4 w-4" /> تحديث
            </Button>
          </div>
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="عدد المسيرات" value={summary.runsCount} color="sky" />
          <StatCard label="عدد الموظفين" value={summary.employeesCount} color="indigo" />
          <StatCard label="إجمالي الإجمالي" value={fmt.fmt(summary.totalGross)} color="emerald" />
          <StatCard label="إجمالي الصافي" value={fmt.fmt(summary.totalNet)} color="green" />
          <StatCard label="GOSI الموظف" value={fmt.fmt(summary.totalGosi)} color="amber" />
          <StatCard label="استقطاع السلف" value={fmt.fmt(summary.totalLoans)} color="orange" />
          <StatCard label="أوفر تايم" value={fmt.fmt(summary.totalOvertime)} color="violet" />
          <StatCard label="متوسط الصافي" value={fmt.fmt(summary.averageNet)} color="rose" />
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
                <th className="px-3 py-2.5 font-semibold">أشهر</th>
                <th className="px-3 py-2.5 font-semibold text-left">الإجمالي</th>
                <th className="px-3 py-2.5 font-semibold text-left">GOSI</th>
                <th className="px-3 py-2.5 font-semibold text-left">السلف</th>
                <th className="px-3 py-2.5 font-semibold text-left">إجمالي الاستقطاعات</th>
                <th className="px-3 py-2.5 font-semibold text-left">الصافي</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b"><td colSpan={9} className="px-3 py-2"><Skeleton className="h-6 w-full" /></td></tr>
                ))
              ) : employees.length === 0 ? (
                <tr><td colSpan={9} className="px-3 py-10 text-center text-muted-foreground">لا توجد بيانات لهذه الفترة</td></tr>
              ) : employees.map((e: any) => (
                <tr key={e.employeeId} className="border-b hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-xs">{e.empCode}</td>
                  <td className="px-3 py-2 font-medium">{e.empName}</td>
                  <td className="px-3 py-2">{e.department || "—"}</td>
                  <td className="px-3 py-2">{e.months}</td>
                  <td className="px-3 py-2 text-left font-mono">{fmt.fmt(e.gross)}</td>
                  <td className="px-3 py-2 text-left font-mono text-amber-700">{fmt.fmt(e.gosi)}</td>
                  <td className="px-3 py-2 text-left font-mono text-orange-700">{fmt.fmt(e.loans)}</td>
                  <td className="px-3 py-2 text-left font-mono text-rose-700">{fmt.fmt(e.deductions)}</td>
                  <td className="px-3 py-2 text-left font-mono font-bold text-emerald-700">{fmt.fmt(e.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {summary && employees.length > 0 && (
        <AIInsightsPanel
          reportType="payroll"
          title="تقرير الرواتب"
          summary={summary}
          rows={employees}
          period={{ year: filters.year, monthFrom: filters.monthFrom, monthTo: filters.monthTo }}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: any; color: string }) {
  const palette: Record<string, string> = {
    sky: "border-sky-200 bg-sky-50 text-sky-800",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
    green: "border-green-200 bg-green-50 text-green-800",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    orange: "border-orange-200 bg-orange-50 text-orange-800",
    indigo: "border-indigo-200 bg-indigo-50 text-indigo-800",
    violet: "border-violet-200 bg-violet-50 text-violet-800",
    rose: "border-rose-200 bg-rose-50 text-rose-800",
  };
  return (
    <div className={`rounded-lg border p-3 ${palette[color] || palette.sky}`}>
      <div className="text-xs opacity-80">{label}</div>
      <div className="text-lg font-bold mt-0.5">{value}</div>
    </div>
  );
}
