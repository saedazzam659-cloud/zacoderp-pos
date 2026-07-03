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
import { HandCoins, Search, Download } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import AIInsightsPanel from "./_AIInsightsPanel";

function exportCsv(filename: string, headers: string[], rows: any[][]) {
  const esc = (v: any) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(","), ...rows.map(r => r.map(esc).join(","))].join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
  void saveBlob(blob, filename);
}

export default function LoansReport() {
  const fmt = useFmt();
  const [status, setStatus] = useState("all");
  const [filters, setFilters] = useState<{ status: string }>({ status: "all" });

  const { data, isLoading } = useQuery({
    queryKey: ["hr-report-loans", filters],
    queryFn: () => employeesApi.reportLoans({
      status: filters.status === "all" ? undefined : filters.status,
    }),
  });

  const summary = data?.summary;
  const rows = data?.rows ?? [];

  function handleExport() {
    if (!rows.length) return;
    exportCsv(
      `loans_report_${new Date().toISOString().slice(0, 10)}.csv`,
      ["كود الموظف", "اسم الموظف", "نوع", "تاريخ", "المبلغ", "أقساط", "قسط شهري", "المسدد", "المتبقي", "نسبة التقدم", "الأشهر المتبقية", "الحالة"],
      rows.map((r: any) => [
        r.empCode, r.empName, r.loanType === "loan" ? "سلفة" : r.loanType,
        r.loanDate, r.amountNum.toFixed(2), r.installments,
        Number(r.installmentAmt).toFixed(2),
        r.paidNum.toFixed(2), r.remaining.toFixed(2),
        `${r.progressPct.toFixed(1)}%`, r.monthsRemaining,
        r.status === "active" ? "نشطة" : r.status === "closed" ? "مسددة" : r.status,
      ])
    );
  }

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <HandCoins className="h-6 w-6 text-orange-600" /> تقرير السلف والقروض
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            السلف القائمة والمسددة مع نسبة التقدم والأقساط المتبقية
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={!rows.length} className="gap-2">
          <Download className="h-4 w-4" /> تصدير CSV
        </Button>
      </div>

      <div className="rounded-xl border bg-white p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <Label className="text-xs">الحالة</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">الكل</SelectItem>
                <SelectItem value="active">نشطة</SelectItem>
                <SelectItem value="closed">مسددة</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <Button onClick={() => setFilters({ status })} className="w-full gap-2">
              <Search className="h-4 w-4" /> تحديث
            </Button>
          </div>
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="إجمالي السلف" value={summary.total} color="sky" />
          <StatCard label="نشطة" value={summary.active} color="emerald" />
          <StatCard label="مسددة" value={summary.closed} color="green" />
          <StatCard label="إجمالي المبلغ" value={fmt.fmt(summary.totalAmount)} color="indigo" />
          <StatCard label="إجمالي المسدد" value={fmt.fmt(summary.totalPaid)} color="violet" />
          <StatCard label="إجمالي المتبقي" value={fmt.fmt(summary.totalRemaining)} color="rose" />
          <StatCard label="رصيد السلف النشطة" value={fmt.fmt(summary.activeRemaining)} color="amber" />
          <StatCard label="نسبة التحصيل" value={`${summary.totalAmount ? ((summary.totalPaid / summary.totalAmount) * 100).toFixed(1) : 0}%`} color="cyan" />
        </div>
      )}

      <div className="rounded-xl border bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b">
              <tr className="text-right">
                <th className="px-3 py-2.5 font-semibold">الموظف</th>
                <th className="px-3 py-2.5 font-semibold">النوع</th>
                <th className="px-3 py-2.5 font-semibold">التاريخ</th>
                <th className="px-3 py-2.5 font-semibold text-left">المبلغ</th>
                <th className="px-3 py-2.5 font-semibold">قسط</th>
                <th className="px-3 py-2.5 font-semibold text-left">مسدد</th>
                <th className="px-3 py-2.5 font-semibold text-left">متبقي</th>
                <th className="px-3 py-2.5 font-semibold">التقدم</th>
                <th className="px-3 py-2.5 font-semibold">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b"><td colSpan={9} className="px-3 py-2"><Skeleton className="h-6 w-full" /></td></tr>
                ))
              ) : rows.length === 0 ? (
                <tr><td colSpan={9} className="px-3 py-10 text-center text-muted-foreground">لا توجد سلف</td></tr>
              ) : rows.map((r: any) => (
                <tr key={r.id} className="border-b hover:bg-slate-50">
                  <td className="px-3 py-2"><div className="font-medium">{r.empName}</div><div className="text-xs text-muted-foreground">{r.empCode}</div></td>
                  <td className="px-3 py-2 text-xs">{r.loanType === "loan" ? "سلفة" : r.loanType}</td>
                  <td className="px-3 py-2 text-xs">{r.loanDate}</td>
                  <td className="px-3 py-2 text-left font-mono">{fmt.fmt(r.amountNum)}</td>
                  <td className="px-3 py-2 text-xs">{r.installments}</td>
                  <td className="px-3 py-2 text-left font-mono text-emerald-700">{fmt.fmt(r.paidNum)}</td>
                  <td className="px-3 py-2 text-left font-mono text-rose-700">{fmt.fmt(r.remaining)}</td>
                  <td className="px-3 py-2 min-w-[120px]">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-500" style={{ width: `${Math.min(100, r.progressPct)}%` }} />
                      </div>
                      <span className="text-xs font-mono">{r.progressPct.toFixed(0)}%</span>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {r.status === "active" ? (
                      <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-700 text-xs">نشطة</span>
                    ) : r.status === "closed" ? (
                      <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 text-xs">مسددة</span>
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
          reportType="loans"
          title="تقرير السلف"
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
