import { saveBlob } from "@/lib/saveFile";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { FileSignature, Search, Download } from "lucide-react";
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

export default function ContractsReport() {
  const fmt = useFmt();
  const [status, setStatus] = useState("all");
  const [expDays, setExpDays] = useState<number>(60);
  const [filters, setFilters] = useState<{ status: string; expiringDays: number }>({ status: "all", expiringDays: 60 });

  const { data, isLoading } = useQuery({
    queryKey: ["hr-report-contracts", filters],
    queryFn: () => employeesApi.reportContracts({
      status: filters.status === "all" ? undefined : filters.status,
      expiringDays: filters.expiringDays,
    }),
  });

  function apply() { setFilters({ status, expiringDays: expDays }); }

  const summary = data?.summary;
  const rows = data?.rows ?? [];

  function handleExport() {
    if (!rows.length) return;
    exportCsv(
      `contracts_report_${new Date().toISOString().slice(0, 10)}.csv`,
      ["رقم العقد", "كود الموظف", "اسم الموظف", "النوع", "بداية", "نهاية", "الأيام المتبقية", "الإجمالي", "الحالة"],
      rows.map((r: any) => [
        r.contractNumber, r.empCode || "", r.empName || "",
        r.contractType === "fixed" ? "محدد المدة" : "غير محدد المدة",
        r.startDate || "", r.endDate || "—",
        r.remainingDays !== null ? r.remainingDays : "—",
        Number(r.gross).toFixed(2),
        r.isExpired ? "منتهي" : r.isExpiringSoon ? "قارب الانتهاء" : (r.status === "active" ? "نشط" : r.status),
      ])
    );
  }

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileSignature className="h-6 w-6 text-primary" /> تقرير العقود
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            حالة العقود مع التركيز على المنتهية والقريبة من الانتهاء
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={!rows.length} className="gap-2">
          <Download className="h-4 w-4" /> تصدير CSV
        </Button>
      </div>

      <div className="rounded-xl border bg-white p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">حالة العقد</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">الكل</SelectItem>
                <SelectItem value="active">نشط</SelectItem>
                <SelectItem value="expired">منتهي</SelectItem>
                <SelectItem value="terminated">ملغى</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">أيام التحذير قبل الانتهاء</Label>
            <Input type="number" min={1} value={expDays} onChange={(e) => setExpDays(Number(e.target.value) || 60)} />
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
          <StatCard label="إجمالي العقود" value={summary.total} color="sky" />
          <StatCard label="نشطة" value={summary.active} color="emerald" />
          <StatCard label="منتهية" value={summary.expired} color="rose" />
          <StatCard label={`قاربت الانتهاء (≤ ${filters.expiringDays} يوم)`} value={summary.expiringSoon} color="amber" />
          <StatCard label="محددة المدة" value={summary.fixed} color="indigo" />
          <StatCard label="غير محددة" value={summary.indefinite} color="violet" />
          <StatCard label="إجمالي قيم العقود النشطة" value={fmt.fmt(summary.totalGross)} color="green" />
          <StatCard label="نسبة العقود النشطة" value={`${summary.total ? ((summary.active / summary.total) * 100).toFixed(1) : 0}%`} color="cyan" />
        </div>
      )}

      <div className="rounded-xl border bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b">
              <tr className="text-right">
                <th className="px-3 py-2.5 font-semibold">رقم العقد</th>
                <th className="px-3 py-2.5 font-semibold">الموظف</th>
                <th className="px-3 py-2.5 font-semibold">النوع</th>
                <th className="px-3 py-2.5 font-semibold">بداية</th>
                <th className="px-3 py-2.5 font-semibold">نهاية</th>
                <th className="px-3 py-2.5 font-semibold">المتبقي</th>
                <th className="px-3 py-2.5 font-semibold text-left">الإجمالي</th>
                <th className="px-3 py-2.5 font-semibold">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b"><td colSpan={8} className="px-3 py-2"><Skeleton className="h-6 w-full" /></td></tr>
                ))
              ) : rows.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">لا توجد عقود</td></tr>
              ) : rows.map((r: any) => (
                <tr key={r.id} className="border-b hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-xs">{r.contractNumber}</td>
                  <td className="px-3 py-2"><div className="font-medium">{r.empName}</div><div className="text-xs text-muted-foreground">{r.empCode}</div></td>
                  <td className="px-3 py-2 text-xs">{r.contractType === "fixed" ? "محدد" : "غير محدد"}</td>
                  <td className="px-3 py-2 text-xs">{r.startDate || "—"}</td>
                  <td className="px-3 py-2 text-xs">{r.endDate || "—"}</td>
                  <td className="px-3 py-2">
                    {r.remainingDays !== null ? (
                      <span className={r.isExpired ? "text-rose-700 font-semibold" : r.isExpiringSoon ? "text-amber-700 font-semibold" : ""}>
                        {r.remainingDays} يوم
                      </span>
                    ) : "—"}
                  </td>
                  <td className="px-3 py-2 text-left font-mono">{fmt.fmt(r.gross)}</td>
                  <td className="px-3 py-2">
                    {r.isExpired ? (
                      <span className="px-2 py-0.5 rounded bg-rose-100 text-rose-700 text-xs">منتهي</span>
                    ) : r.isExpiringSoon ? (
                      <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-700 text-xs">قارب الانتهاء</span>
                    ) : r.status === "active" ? (
                      <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 text-xs">نشط</span>
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
          reportType="contracts"
          title="تقرير العقود"
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
