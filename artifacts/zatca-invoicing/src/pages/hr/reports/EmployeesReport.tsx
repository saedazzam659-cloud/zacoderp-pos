import { saveBlob } from "@/lib/saveFile";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, Search, Download, FileText } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import AIInsightsPanel from "./_AIInsightsPanel";

function exportCsv(filename: string, headers: string[], rows: any[][]) {
  const sep = ",";
  const esc = (v: any) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(sep), ...rows.map(r => r.map(esc).join(sep))].join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
  void saveBlob(blob, filename);
}

export default function EmployeesReport() {
  const fmt = useFmt();
  const [status, setStatus] = useState<string>("active");
  const [department, setDepartment] = useState<string>("all");
  const [filters, setFilters] = useState<{ status: string; department?: string }>({ status: "active" });

  const { data, isLoading } = useQuery({
    queryKey: ["hr-report-employees", filters],
    queryFn: () => employeesApi.reportEmployees({
      status: filters.status === "all" ? undefined : filters.status,
      department: filters.department === "all" ? undefined : filters.department,
    }),
  });

  function applyFilters() {
    setFilters({ status, department });
  }

  function handleExport() {
    if (!data?.rows) return;
    exportCsv(
      `employees_report_${new Date().toISOString().slice(0, 10)}.csv`,
      ["الكود", "الاسم", "القسم", "المسمى الوظيفي", "الجنسية", "تاريخ التعيين", "الحالة", "الراتب الأساسي", "بدل سكن", "بدل نقل", "الإجمالي"],
      data.rows.map((r: any) => [
        r.code, r.nameAr, r.department || "", r.jobTitle || "", r.nationality || "",
        r.hireDate || "", r.status === "active" ? "نشط" : "غير نشط",
        Number(r.basicSalary || 0), Number(r.housingAllow || 0), Number(r.transportAllow || 0),
        Number(r.basicSalary || 0) + Number(r.housingAllow || 0) + Number(r.transportAllow || 0) + Number(r.otherAllow || 0),
      ])
    );
  }

  const departments = data?.summary?.departments ?? [];
  const summary = data?.summary;
  const rows = data?.rows ?? [];

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="h-6 w-6 text-primary" /> تقرير الموظفين
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            قائمة الموظفين مع الرواتب والبدلات وإحصائيات التوزيع
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={!rows.length} className="gap-2">
          <Download className="h-4 w-4" /> تصدير CSV
        </Button>
      </div>

      {/* Filters */}
      <div className="rounded-xl border bg-white p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">الحالة</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">الكل</SelectItem>
                <SelectItem value="active">نشط</SelectItem>
                <SelectItem value="inactive">غير نشط</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">القسم</Label>
            <Select value={department} onValueChange={setDepartment}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">جميع الأقسام</SelectItem>
                {departments.map((d: string) => (
                  <SelectItem key={d} value={d}>{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <Button onClick={applyFilters} className="w-full gap-2">
              <Search className="h-4 w-4" /> تحديث
            </Button>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="إجمالي الموظفين" value={summary.total} color="sky" />
          <StatCard label="نشطون" value={summary.active} color="emerald" />
          <StatCard label="سعوديون" value={summary.saudis} color="green" />
          <StatCard label="غير سعوديين" value={summary.nonSaudis} color="amber" />
          <StatCard label="إجمالي الراتب الأساسي" value={fmt.fmt(summary.totalBasicSalary)} color="indigo" />
          <StatCard label="إجمالي البدلات" value={fmt.fmt(summary.totalAllowances)} color="violet" />
          <StatCard label="الإجمالي الشهري" value={fmt.fmt(summary.totalGross)} color="rose" />
          <StatCard label="عدد الأقسام" value={departments.length} color="cyan" />
        </div>
      )}

      {/* Table */}
      <div className="rounded-xl border bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b">
              <tr className="text-right">
                <th className="px-3 py-2.5 font-semibold">الكود</th>
                <th className="px-3 py-2.5 font-semibold">الاسم</th>
                <th className="px-3 py-2.5 font-semibold">القسم</th>
                <th className="px-3 py-2.5 font-semibold">المسمى</th>
                <th className="px-3 py-2.5 font-semibold">الجنسية</th>
                <th className="px-3 py-2.5 font-semibold">تاريخ التعيين</th>
                <th className="px-3 py-2.5 font-semibold">الحالة</th>
                <th className="px-3 py-2.5 font-semibold text-left">الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b">
                    <td colSpan={8} className="px-3 py-2"><Skeleton className="h-6 w-full" /></td>
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">لا توجد بيانات</td></tr>
              ) : rows.map((r: any) => {
                const total = Number(r.basicSalary || 0) + Number(r.housingAllow || 0) + Number(r.transportAllow || 0) + Number(r.otherAllow || 0);
                return (
                  <tr key={r.id} className="border-b hover:bg-slate-50">
                    <td className="px-3 py-2 font-mono text-xs">{r.code}</td>
                    <td className="px-3 py-2 font-medium">{r.nameAr}</td>
                    <td className="px-3 py-2">{r.department || "—"}</td>
                    <td className="px-3 py-2">{r.jobTitle || "—"}</td>
                    <td className="px-3 py-2">{r.nationality || "—"}</td>
                    <td className="px-3 py-2 text-xs">{r.hireDate || "—"}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${r.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                        {r.status === "active" ? "نشط" : "غير نشط"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-left font-mono">{fmt.fmt(total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* AI panel */}
      {summary && rows.length > 0 && (
        <AIInsightsPanel
          reportType="employees"
          title="تقرير الموظفين"
          summary={summary}
          rows={rows}
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
    indigo: "border-indigo-200 bg-indigo-50 text-indigo-800",
    violet: "border-violet-200 bg-violet-50 text-violet-800",
    rose: "border-rose-200 bg-rose-50 text-rose-800",
    cyan: "border-cyan-200 bg-cyan-50 text-cyan-800",
  };
  return (
    <div className={`rounded-lg border p-3 ${palette[color] || palette.sky}`}>
      <div className="text-xs opacity-80">{label}</div>
      <div className="text-lg font-bold mt-0.5">{value}</div>
    </div>
  );
}
