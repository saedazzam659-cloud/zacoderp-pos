import { saveBlob } from "@/lib/saveFile";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { FileWarning, Search, Download } from "lucide-react";
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

export default function DocumentsExpiryReport() {
  const [days, setDays] = useState(90);
  const [activeDays, setActiveDays] = useState(90);

  const { data, isLoading } = useQuery({
    queryKey: ["hr-report-documents", activeDays],
    queryFn: () => employeesApi.reportDocumentsExpiry(activeDays),
  });

  const summary = data?.summary;
  const rows = data?.rows ?? [];

  function handleExport() {
    if (!rows.length) return;
    exportCsv(
      `documents_expiry_${new Date().toISOString().slice(0, 10)}.csv`,
      ["كود الموظف", "اسم الموظف", "القسم", "الجنسية", "نوع الوثيقة", "رقم الوثيقة", "تاريخ الانتهاء", "الأيام المتبقية", "الحالة"],
      rows.map((r: any) => [
        r.empCode, r.empName, r.department || "", r.nationality || "",
        r.docTypeAr, r.docNumber || "", r.expiryDate,
        r.remainingDays,
        r.isExpired ? "منتهية" : r.isExpiringSoon ? "قاربت الانتهاء" : "سارية",
      ])
    );
  }

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileWarning className="h-6 w-6 text-amber-600" /> تقرير وثائق منتهية الصلاحية
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            الإقامات وجوازات السفر للموظفين النشطين — تنبيه قبل الانتهاء
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={!rows.length} className="gap-2">
          <Download className="h-4 w-4" /> تصدير CSV
        </Button>
      </div>

      <div className="rounded-xl border bg-white p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <Label className="text-xs">عتبة التحذير (الأيام المتبقية)</Label>
            <Input type="number" min={1} value={days} onChange={(e) => setDays(Number(e.target.value) || 90)} />
          </div>
          <div className="flex items-end">
            <Button onClick={() => setActiveDays(days)} className="w-full gap-2">
              <Search className="h-4 w-4" /> تحديث
            </Button>
          </div>
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="إجمالي الوثائق" value={summary.total} color="sky" />
          <StatCard label="منتهية" value={summary.expired} color="rose" />
          <StatCard label={`قاربت الانتهاء (≤ ${activeDays} يوم)`} value={summary.expiringSoon} color="amber" />
          <StatCard label="إقامات منتهية" value={summary.iqamaExpired} color="orange" />
          <StatCard label="إقامات قاربت" value={summary.iqamaExpiring} color="amber" />
          <StatCard label="جوازات منتهية" value={summary.passportExpired} color="rose" />
          <StatCard label="جوازات قاربت" value={summary.passportExpiring} color="violet" />
          <StatCard label="سارية" value={summary.total - summary.expired - summary.expiringSoon} color="emerald" />
        </div>
      )}

      <div className="rounded-xl border bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b">
              <tr className="text-right">
                <th className="px-3 py-2.5 font-semibold">الموظف</th>
                <th className="px-3 py-2.5 font-semibold">الجنسية</th>
                <th className="px-3 py-2.5 font-semibold">نوع الوثيقة</th>
                <th className="px-3 py-2.5 font-semibold">الرقم</th>
                <th className="px-3 py-2.5 font-semibold">تاريخ الانتهاء</th>
                <th className="px-3 py-2.5 font-semibold">المتبقي</th>
                <th className="px-3 py-2.5 font-semibold">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b"><td colSpan={7} className="px-3 py-2"><Skeleton className="h-6 w-full" /></td></tr>
                ))
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="px-3 py-10 text-center text-muted-foreground">لا توجد وثائق</td></tr>
              ) : rows.map((r: any, i: number) => (
                <tr key={`${r.employeeId}-${r.docType}-${i}`} className="border-b hover:bg-slate-50">
                  <td className="px-3 py-2"><div className="font-medium">{r.empName}</div><div className="text-xs text-muted-foreground">{r.empCode} • {r.department || "—"}</div></td>
                  <td className="px-3 py-2 text-xs">{r.nationality || "—"}</td>
                  <td className="px-3 py-2 text-xs">{r.docTypeAr}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.docNumber || "—"}</td>
                  <td className="px-3 py-2 text-xs">{r.expiryDate}</td>
                  <td className="px-3 py-2">
                    <span className={r.isExpired ? "text-rose-700 font-bold" : r.isExpiringSoon ? "text-amber-700 font-semibold" : ""}>
                      {r.remainingDays} يوم
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {r.isExpired ? (
                      <span className="px-2 py-0.5 rounded bg-rose-100 text-rose-700 text-xs">منتهية</span>
                    ) : r.isExpiringSoon ? (
                      <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-700 text-xs">قاربت الانتهاء</span>
                    ) : (
                      <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 text-xs">سارية</span>
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
          reportType="documents"
          title="تقرير الوثائق المنتهية"
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
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    orange: "border-orange-200 bg-orange-50 text-orange-800",
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
