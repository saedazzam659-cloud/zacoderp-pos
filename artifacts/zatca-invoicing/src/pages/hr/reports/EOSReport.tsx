import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { LogOut, Search, Download } from "lucide-react";
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

export default function EOSReport() {
  const fmt = useFmt();
  const [from, setFrom] = useState("");
  const [to, setTo]     = useState("");
  const [filters, setFilters] = useState<{ from?: string; to?: string }>({});

  const { data, isLoading } = useQuery({
    queryKey: ["hr-report-eos", filters],
    queryFn: () => employeesApi.reportEos(filters),
  });

  const summary = data?.summary;
  const rows = data?.rows ?? [];

  function handleExport() {
    if (!rows.length) return;
    exportCsv(
      `eos_report_${new Date().toISOString().slice(0, 10)}.csv`,
      ["كود الموظف", "الاسم", "القسم", "تاريخ التعيين", "تاريخ الإنهاء", "سنوات الخدمة", "الراتب الشهري", "تقدير المكافأة"],
      rows.map((r: any) => [
        r.code, r.nameAr, r.department || "",
        r.hireDate || "", r.endDate || "",
        (r.yearsServed || 0).toFixed(2),
        r.monthlyGross.toFixed(2),
        r.eosEstimate.toFixed(2),
      ])
    );
  }

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <LogOut className="h-6 w-6 text-rose-600" /> تقرير نهاية الخدمة
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            الموظفون المنتهية خدمتهم مع تقدير المستحقات وفق نظام العمل السعودي
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={!rows.length} className="gap-2">
          <Download className="h-4 w-4" /> تصدير CSV
        </Button>
      </div>

      <div className="rounded-xl border bg-white p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">من تاريخ الإنهاء</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">إلى تاريخ الإنهاء</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button onClick={() => setFilters({ from: from || undefined, to: to || undefined })} className="w-full gap-2">
              <Search className="h-4 w-4" /> تحديث
            </Button>
          </div>
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatCard label="عدد الموظفين المنتهية خدمتهم" value={summary.total} color="rose" />
          <StatCard label="إجمالي تقدير المكافآت" value={fmt.fmt(summary.totalEosEstimate)} color="amber" />
          <StatCard label="متوسط سنوات الخدمة" value={`${summary.averageYears.toFixed(1)} سنة`} color="indigo" />
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
                <th className="px-3 py-2.5 font-semibold">تاريخ التعيين</th>
                <th className="px-3 py-2.5 font-semibold">تاريخ الإنهاء</th>
                <th className="px-3 py-2.5 font-semibold">سنوات الخدمة</th>
                <th className="px-3 py-2.5 font-semibold text-left">الراتب الشهري</th>
                <th className="px-3 py-2.5 font-semibold text-left">تقدير المكافأة</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b"><td colSpan={8} className="px-3 py-2"><Skeleton className="h-6 w-full" /></td></tr>
                ))
              ) : rows.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">لا توجد سجلات نهاية خدمة لهذه الفترة</td></tr>
              ) : rows.map((r: any) => (
                <tr key={r.id} className="border-b hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-xs">{r.code}</td>
                  <td className="px-3 py-2 font-medium">{r.nameAr}</td>
                  <td className="px-3 py-2">{r.department || "—"}</td>
                  <td className="px-3 py-2 text-xs">{r.hireDate || "—"}</td>
                  <td className="px-3 py-2 text-xs">{r.endDate || "—"}</td>
                  <td className="px-3 py-2 text-xs">{r.yearsServed ? r.yearsServed.toFixed(2) : "—"}</td>
                  <td className="px-3 py-2 text-left font-mono">{fmt.fmt(r.monthlyGross)}</td>
                  <td className="px-3 py-2 text-left font-mono font-bold text-amber-700">{fmt.fmt(r.eosEstimate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > 0 && (
          <div className="border-t bg-slate-50 px-4 py-2.5 text-xs text-muted-foreground">
            * تقدير المكافأة وفق نظام العمل السعودي: نصف شهر عن السنوات الخمس الأولى + شهر كامل عن كل سنة بعدها (الراتب الإجمالي).
          </div>
        )}
      </div>

      {summary && rows.length > 0 && (
        <AIInsightsPanel
          reportType="eos"
          title="تقرير نهاية الخدمة"
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
    rose: "border-rose-200 bg-rose-50 text-rose-800",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    indigo: "border-indigo-200 bg-indigo-50 text-indigo-800",
  };
  return (
    <div className={`rounded-lg border p-3 ${palette[color] || palette.rose}`}>
      <div className="text-xs opacity-80">{label}</div>
      <div className="text-lg font-bold mt-0.5">{value}</div>
    </div>
  );
}
