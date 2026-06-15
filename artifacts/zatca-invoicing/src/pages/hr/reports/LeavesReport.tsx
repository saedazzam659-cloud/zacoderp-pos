import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarDays, Search, Download } from "lucide-react";
import AIInsightsPanel from "./_AIInsightsPanel";
import { DateField } from "@/components/ui/date-field";

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

const TYPE_AR: Record<string, string> = {
  annual: "سنوية",
  sick: "مرضية",
  emergency: "طارئة",
  unpaid: "بدون راتب",
  maternity: "أمومة",
  paternity: "أبوة",
  hajj: "حج",
  other: "أخرى",
};

export default function LeavesReport() {
  const [from, setFrom] = useState("");
  const [to, setTo]     = useState("");
  const [filters, setFilters] = useState<{ from?: string; to?: string }>({});

  const { data, isLoading } = useQuery({
    queryKey: ["hr-report-leaves", filters],
    queryFn: () => employeesApi.reportLeaves(filters),
  });

  const summary = data?.summary;
  const rows = data?.rows ?? [];

  function handleExport() {
    if (!rows.length) return;
    exportCsv(
      `leaves_report_${new Date().toISOString().slice(0, 10)}.csv`,
      ["كود الموظف", "الاسم", "القسم", "نوع الإجازة", "بداية", "نهاية", "أيام", "مدفوعة", "الحالة"],
      rows.map((r: any) => [
        r.empCode, r.empName, r.empDept || "",
        TYPE_AR[r.leaveType] || r.leaveType,
        r.startDate, r.endDate, r.days,
        r.paid ? "نعم" : "لا",
        r.status === "approved" ? "معتمدة" : r.status === "pending" ? "معلقة" : r.status === "rejected" ? "مرفوضة" : r.status,
      ])
    );
  }

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CalendarDays className="h-6 w-6 text-cyan-600" /> تقرير الإجازات
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            ملخص طلبات الإجازات لكل موظف خلال فترة محددة
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={!rows.length} className="gap-2">
          <Download className="h-4 w-4" /> تصدير CSV
        </Button>
      </div>

      <div className="rounded-xl border bg-white p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">من تاريخ</Label>
            <DateField value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">إلى تاريخ</Label>
            <DateField value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button onClick={() => setFilters({ from: from || undefined, to: to || undefined })} className="w-full gap-2">
              <Search className="h-4 w-4" /> تحديث
            </Button>
          </div>
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="إجمالي الطلبات" value={summary.total} color="sky" />
          <StatCard label="معتمدة" value={summary.approved} color="emerald" />
          <StatCard label="معلقة" value={summary.pending} color="amber" />
          <StatCard label="مرفوضة" value={summary.rejected} color="rose" />
          <StatCard label="إجمالي الأيام" value={summary.totalDays} color="indigo" />
          <StatCard label="أيام مدفوعة" value={summary.paidDays} color="green" />
          <StatCard label="أيام غير مدفوعة" value={summary.unpaidDays} color="orange" />
          <StatCard label="متوسط الأيام" value={summary.total ? (summary.totalDays / summary.total).toFixed(1) : 0} color="violet" />
        </div>
      )}

      <div className="rounded-xl border bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b">
              <tr className="text-right">
                <th className="px-3 py-2.5 font-semibold">الموظف</th>
                <th className="px-3 py-2.5 font-semibold">القسم</th>
                <th className="px-3 py-2.5 font-semibold">النوع</th>
                <th className="px-3 py-2.5 font-semibold">بداية</th>
                <th className="px-3 py-2.5 font-semibold">نهاية</th>
                <th className="px-3 py-2.5 font-semibold">أيام</th>
                <th className="px-3 py-2.5 font-semibold">مدفوعة</th>
                <th className="px-3 py-2.5 font-semibold">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b"><td colSpan={8} className="px-3 py-2"><Skeleton className="h-6 w-full" /></td></tr>
                ))
              ) : rows.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">لا توجد طلبات إجازة</td></tr>
              ) : rows.map((r: any) => (
                <tr key={r.id} className="border-b hover:bg-slate-50">
                  <td className="px-3 py-2"><div className="font-medium">{r.empName}</div><div className="text-xs text-muted-foreground">{r.empCode}</div></td>
                  <td className="px-3 py-2 text-xs">{r.empDept || "—"}</td>
                  <td className="px-3 py-2 text-xs">{TYPE_AR[r.leaveType] || r.leaveType}</td>
                  <td className="px-3 py-2 text-xs">{r.startDate}</td>
                  <td className="px-3 py-2 text-xs">{r.endDate}</td>
                  <td className="px-3 py-2 font-semibold">{r.days}</td>
                  <td className="px-3 py-2 text-xs">{r.paid ? "نعم" : "لا"}</td>
                  <td className="px-3 py-2">
                    {r.status === "approved" ? (
                      <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 text-xs">معتمدة</span>
                    ) : r.status === "pending" ? (
                      <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-700 text-xs">معلقة</span>
                    ) : r.status === "rejected" ? (
                      <span className="px-2 py-0.5 rounded bg-rose-100 text-rose-700 text-xs">مرفوضة</span>
                    ) : (
                      <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-xs">{r.status}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {summary && rows.length > 0 && (
        <AIInsightsPanel
          reportType="leaves"
          title="تقرير الإجازات"
          summary={summary}
          rows={rows}
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
