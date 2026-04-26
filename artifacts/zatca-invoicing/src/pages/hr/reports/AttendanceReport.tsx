import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Clock, Search, Download } from "lucide-react";
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

function defaultRange() {
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  return {
    from: first.toISOString().slice(0, 10),
    to: today.toISOString().slice(0, 10),
  };
}

export default function AttendanceReport() {
  const def = defaultRange();
  const [from, setFrom] = useState(def.from);
  const [to, setTo]     = useState(def.to);
  const [filters, setFilters] = useState({ from: def.from, to: def.to });

  const { data, isLoading } = useQuery({
    queryKey: ["hr-report-attendance", filters],
    queryFn: () => employeesApi.reportAttendance(filters),
    enabled: !!filters.from && !!filters.to,
  });

  function apply() { setFilters({ from, to }); }

  const summary = data?.summary;
  const employees = data?.employees ?? [];

  function handleExport() {
    if (!employees.length) return;
    exportCsv(
      `attendance_report_${filters.from}_to_${filters.to}.csv`,
      ["الكود", "الاسم", "القسم", "أيام", "حضور", "غياب", "إجازة", "عطلة", "تأخير", "ساعات عمل", "ساعات إضافية"],
      employees.map((e: any) => [
        e.empCode, e.empName, e.department || "", e.totalDays,
        e.present, e.absent, e.leave, e.holiday, e.late,
        e.workedHours.toFixed(2), e.overtimeHours.toFixed(2),
      ])
    );
  }

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Clock className="h-6 w-6 text-primary" /> تقرير الحضور والانصراف
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            إحصائيات الحضور والغياب والتأخير وساعات العمل لفترة محددة
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={!employees.length} className="gap-2">
          <Download className="h-4 w-4" /> تصدير CSV
        </Button>
      </div>

      <div className="rounded-xl border bg-white p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">من تاريخ</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">إلى تاريخ</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
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
          <StatCard label="عدد الموظفين" value={summary.employeesCount} color="sky" />
          <StatCard label="إجمالي السجلات" value={summary.totalRecords} color="indigo" />
          <StatCard label="حضور" value={summary.totalPresent} color="emerald" />
          <StatCard label="غياب" value={summary.totalAbsent} color="rose" />
          <StatCard label="إجازات" value={summary.totalLeave} color="amber" />
          <StatCard label="تأخير" value={summary.totalLate} color="orange" />
          <StatCard label="إجمالي ساعات العمل" value={summary.totalWorkedHours.toFixed(1)} color="violet" />
          <StatCard label="متوسط نسبة الحضور" value={`${summary.avgAttendanceRate.toFixed(1)}%`} color="green" />
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
                <th className="px-3 py-2.5 font-semibold">أيام</th>
                <th className="px-3 py-2.5 font-semibold text-emerald-700">حضور</th>
                <th className="px-3 py-2.5 font-semibold text-rose-700">غياب</th>
                <th className="px-3 py-2.5 font-semibold text-amber-700">إجازة</th>
                <th className="px-3 py-2.5 font-semibold text-orange-700">تأخير</th>
                <th className="px-3 py-2.5 font-semibold text-left">ساعات عمل</th>
                <th className="px-3 py-2.5 font-semibold text-left">ساعات إضافية</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b"><td colSpan={10} className="px-3 py-2"><Skeleton className="h-6 w-full" /></td></tr>
                ))
              ) : employees.length === 0 ? (
                <tr><td colSpan={10} className="px-3 py-10 text-center text-muted-foreground">لا توجد سجلات حضور لهذه الفترة</td></tr>
              ) : employees.map((e: any) => (
                <tr key={e.employeeId} className="border-b hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-xs">{e.empCode}</td>
                  <td className="px-3 py-2 font-medium">{e.empName}</td>
                  <td className="px-3 py-2">{e.department || "—"}</td>
                  <td className="px-3 py-2">{e.totalDays}</td>
                  <td className="px-3 py-2 text-emerald-700 font-semibold">{e.present}</td>
                  <td className="px-3 py-2 text-rose-700 font-semibold">{e.absent}</td>
                  <td className="px-3 py-2 text-amber-700">{e.leave}</td>
                  <td className="px-3 py-2 text-orange-700">{e.late}</td>
                  <td className="px-3 py-2 text-left font-mono">{e.workedHours.toFixed(1)}</td>
                  <td className="px-3 py-2 text-left font-mono">{e.overtimeHours.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {summary && employees.length > 0 && (
        <AIInsightsPanel
          reportType="attendance"
          title="تقرير الحضور"
          summary={summary}
          rows={employees}
          period={{ from: filters.from, to: filters.to }}
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
