import { saveBlob } from "@/lib/saveFile";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

const MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

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

export default function PayrollReport() {
  const { i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const fmt = useFmt();
  const now = new Date();
  const [year, setYear] = useState<number>(now.getFullYear());
  const [monthFrom, setMonthFrom] = useState<number>(1);
  const [monthTo, setMonthTo] = useState<number>(12);
  const [filters, setFilters] = useState({ year: now.getFullYear(), monthFrom: 1, monthTo: 12 });
  const [reportTab, setReportTab] = useState("payroll");

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
    <div className="space-y-5" dir={isRtl ? "rtl" : "ltr"}>
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

      <Tabs value={reportTab} onValueChange={setReportTab}>
        <TabsList>
          <TabsTrigger value="payroll">ملخص الرواتب</TabsTrigger>
          <TabsTrigger value="allocations">تخصيص الرواتب</TabsTrigger>
        </TabsList>
        <TabsContent value="payroll" className="mt-4 space-y-5">
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
              <tr>
                <th className="px-3 py-2.5 font-semibold text-start">الكود</th>
                <th className="px-3 py-2.5 font-semibold text-start">الاسم</th>
                <th className="px-3 py-2.5 font-semibold text-start">القسم</th>
                <th className="px-3 py-2.5 font-semibold text-end">أشهر</th>
                <th className="px-3 py-2.5 font-semibold text-end">الإجمالي</th>
                <th className="px-3 py-2.5 font-semibold text-end">GOSI</th>
                <th className="px-3 py-2.5 font-semibold text-end">السلف</th>
                <th className="px-3 py-2.5 font-semibold text-end">إجمالي الاستقطاعات</th>
                <th className="px-3 py-2.5 font-semibold text-end">الصافي</th>
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
                  <td className="px-3 py-2 font-mono text-xs" dir="ltr">{e.empCode}</td>
                  <td className="px-3 py-2 font-medium">{e.empName}</td>
                  <td className="px-3 py-2">{e.department || "—"}</td>
                  <td className="px-3 py-2 text-end tabular-nums" dir="ltr">{e.months}</td>
                  <td className="px-3 py-2 text-end font-mono" dir="ltr">{fmt.fmt(e.gross)}</td>
                  <td className="px-3 py-2 text-end font-mono text-amber-700" dir="ltr">{fmt.fmt(e.gosi)}</td>
                  <td className="px-3 py-2 text-end font-mono text-orange-700" dir="ltr">{fmt.fmt(e.loans)}</td>
                  <td className="px-3 py-2 text-end font-mono text-rose-700" dir="ltr">{fmt.fmt(e.deductions)}</td>
                  <td className="px-3 py-2 text-end font-mono font-bold text-emerald-700" dir="ltr">{fmt.fmt(e.net)}</td>
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
        </TabsContent>
        <TabsContent value="allocations" className="mt-4">
          <PayrollAllocations year={year} monthFrom={monthFrom} monthTo={monthTo} years={years} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PayrollAllocations({ year: initialYear, monthFrom: initialFrom, monthTo: initialTo, years }: { year: number; monthFrom: number; monthTo: number; years: number[] }) {
  const fmt = useFmt();
  const [year, setYear] = useState(initialYear);
  const [monthFrom, setMonthFrom] = useState(initialFrom);
  const [monthTo, setMonthTo] = useState(initialTo);
  const [employeeId, setEmployeeId] = useState("all");
  const [projectId, setProjectId] = useState("all");
  const [costCenterId, setCostCenterId] = useState("all");
  const [filters, setFilters] = useState({ year: initialYear, monthFrom: initialFrom, monthTo: initialTo, employeeId: undefined as number | undefined, projectId: undefined as number | undefined, costCenterId: undefined as number | undefined });
  const allocationQ = useQuery({ queryKey: ["hr-report-payroll-allocations", filters], queryFn: () => employeesApi.reportPayrollAllocations(filters) });
  const employeesQ = useQuery({ queryKey: ["employees"], queryFn: employeesApi.list });
  const projectsQ = useQuery({ queryKey: ["contracting-projects"], queryFn: employeesApi.projects });
  const centersQ = useQuery({ queryKey: ["cost-centers"], queryFn: employeesApi.costCenters });
  const rows = allocationQ.data?.rows ?? [];
  const label = (v: any) => v?.nameAr ?? v?.name ?? v?.code ?? `#${v?.id}`;
  const apply = () => setFilters({ year, monthFrom, monthTo, employeeId: employeeId === "all" ? undefined : Number(employeeId), projectId: projectId === "all" ? undefined : Number(projectId), costCenterId: costCenterId === "all" ? undefined : Number(costCenterId) });
  const exportAllocations = () => exportCsv(`payroll_allocations_${filters.year}_${filters.monthFrom}-${filters.monthTo}.csv`, ["الموظف", "المشروع", "مركز التكلفة", "الشهر", "أساس التكلفة", "المبلغ"], rows.map((r: any) => [r.employeeName ?? r.empName ?? "", r.projectName ?? "", r.costCenterName ?? "", r.month ?? r.period ?? "", r.costBasis ?? "", Number(r.allocatedAmount ?? r.amount ?? r.allocationAmount ?? 0).toFixed(2)]));
  return <div className="space-y-4">
    <div className="flex items-center justify-between gap-3 flex-wrap"><div><h2 className="font-semibold">تخصيص الرواتب</h2><p className="text-xs text-muted-foreground">توزيع تكاليف الرواتب حسب المشروع ومركز التكلفة والفترة.</p></div><Button variant="outline" size="sm" onClick={exportAllocations} disabled={!rows.length}><Download className="h-4 w-4 ms-1" />تصدير CSV</Button></div>
    <div className="rounded-xl border bg-white p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
      <FilterSelect label="السنة" value={String(year)} onChange={v => setYear(Number(v))} options={years.map(v => [String(v), String(v)])} />
      <FilterSelect label="من شهر" value={String(monthFrom)} onChange={v => setMonthFrom(Number(v))} options={MONTHS_AR.map((v, i) => [String(i + 1), v])} />
      <FilterSelect label="إلى شهر" value={String(monthTo)} onChange={v => setMonthTo(Number(v))} options={MONTHS_AR.map((v, i) => [String(i + 1), v])} />
      <FilterSelect label="الموظف" value={employeeId} onChange={setEmployeeId} options={[["all", "كل الموظفين"], ...(employeesQ.data ?? []).map((e: any) => [String(e.id), `${e.code ?? ""} — ${e.nameAr ?? e.name ?? ""}`])]} />
      <FilterSelect label="المشروع" value={projectId} onChange={setProjectId} options={[["all", "كل المشاريع"], ...(projectsQ.data ?? []).map((p: any) => [String(p.id), label(p)])]} />
      <FilterSelect label="مركز التكلفة" value={costCenterId} onChange={setCostCenterId} options={[["all", "كل المراكز"], ...(centersQ.data ?? []).map((c: any) => [String(c.id), label(c)])]} />
      <div className="lg:col-span-6"><Button onClick={apply}><Search className="h-4 w-4 ms-1" />تحديث التقرير</Button></div>
    </div>
    <div className="rounded-xl border bg-white overflow-hidden"><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-slate-50 border-b"><tr><th className="p-3 text-start">الموظف</th><th className="p-3 text-start">المشروع</th><th className="p-3 text-start">مركز التكلفة</th><th className="p-3 text-start">الفترة</th><th className="p-3 text-start">أساس التكلفة</th><th className="p-3 text-end">المبلغ</th></tr></thead><tbody>{allocationQ.isLoading ? <tr><td colSpan={6} className="p-3"><Skeleton className="h-6 w-full" /></td></tr> : allocationQ.isError ? <tr><td colSpan={6} className="p-8 text-center text-rose-600">تعذر تحميل تقرير التخصيص. حاول مرة أخرى.</td></tr> : !rows.length ? <tr><td colSpan={6} className="p-10 text-center text-muted-foreground">لا توجد تخصيصات لهذه الفلاتر</td></tr> : rows.map((r: any, i: number) => <tr key={r.id ?? `${r.employeeId}-${i}`} className="border-b hover:bg-slate-50"><td className="p-3 font-medium">{r.employeeName ?? r.empName ?? "—"}</td><td className="p-3">{r.projectName ?? "—"}</td><td className="p-3">{r.costCenterName ?? "—"}</td><td className="p-3" dir="ltr">{r.month ?? r.period ?? "—"}</td><td className="p-3">{r.costBasis ?? "—"}</td><td className="p-3 text-end font-mono" dir="ltr">{fmt.fmt(r.allocatedAmount ?? r.amount ?? r.allocationAmount ?? 0)}</td></tr>)}</tbody></table></div></div>
  </div>;
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[][] }) {
  return <div><Label className="text-xs">{label}</Label><Select value={value} onValueChange={onChange}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{options.map(([value, text]) => <SelectItem key={value} value={value}>{text}</SelectItem>)}</SelectContent></Select></div>;
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
