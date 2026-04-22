import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { parseError } from "@/lib/parseError";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Banknote, FileSpreadsheet, Sparkles, Calculator, CheckCircle2, Trash2, Loader2, Eye, Save, Receipt, X } from "lucide-react";

const STATUS: Record<string, { label: string; cls: string }> = {
  draft:  { label: "مسودة",   cls: "bg-amber-50 text-amber-700 border-amber-200" },
  posted: { label: "معتمدة",  cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
};

const MONTHS = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];

export default function Payroll() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const now = new Date();
  const [tab, setTab] = useState("runs");
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [preview, setPreview] = useState<any | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);

  const { data: runs = [], isLoading: loadingRuns } = useQuery<any[]>({
    queryKey: ["payroll-runs"], queryFn: () => employeesApi.payrollRuns(),
  });

  const { data: viewRun } = useQuery<any>({
    queryKey: ["payroll-run", viewing],
    queryFn: () => employeesApi.payrollRun(viewing!),
    enabled: !!viewing,
  });

  const previewMut = useMutation({
    mutationFn: () => employeesApi.payrollPreview(year, month),
    onSuccess: (data) => { setPreview(data); setTab("preview"); toast({ title: "تم احتساب المعاينة" }); },
    onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }),
  });

  const createMut = useMutation({
    mutationFn: (data: any) => employeesApi.createPayroll(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll-runs"] });
      setPreview(null); setTab("runs");
      toast({ title: "تم إنشاء المسير", description: "حالته: مسودة. يمكنك اعتماده الآن." });
    },
    onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }),
  });

  const postMut = useMutation({
    mutationFn: (id: number) => employeesApi.postPayroll(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["payroll-runs"] }); qc.invalidateQueries({ queryKey: ["loans"] }); toast({ title: "تم اعتماد المسير", description: "تم خصم أقساط السلف من أرصدة الموظفين." }); },
    onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }),
  });

  const delMut = useMutation({
    mutationFn: (id: number) => employeesApi.deletePayroll(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["payroll-runs"] }); toast({ title: "تم الحذف" }); },
    onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }),
  });

  function downloadCSV() {
    const r = viewRun;
    if (!r) return;
    const head = ["الكود","الاسم","الأساسي","السكن","الانتقال","أخرى","إضافي","الإجمالي","التأمينات","سلف","غياب","خصومات","الصافي","الآيبان"];
    const rows = r.lines.map((l: any) => [
      l.empCode, l.empNameAr, l.basicSalary, l.housingAllow, l.transportAllow, l.otherAllow,
      l.overtimeAmount, l.grossSalary, l.gosiEmployee, l.loanDeduction, l.absenceDeduction, l.totalDeductions, l.netSalary, l.iban || "",
    ]);
    const csv = "\uFEFF" + [head, ...rows].map(r => r.map((c: any) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `${r.code}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4 p-2 md:p-4" data-testid="page-payroll">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Banknote className="size-6 text-primary" />
          <h1 className="text-xl font-semibold">مسيرات الرواتب</h1>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="runs" data-testid="tab-runs"><FileSpreadsheet className="size-4 me-1" />المسيرات</TabsTrigger>
          <TabsTrigger value="preview" data-testid="tab-preview"><Calculator className="size-4 me-1" />معاينة شهرية</TabsTrigger>
          {viewing && <TabsTrigger value="detail" data-testid="tab-detail"><Eye className="size-4 me-1" />تفاصيل المسير</TabsTrigger>}
        </TabsList>

        <TabsContent value="runs" className="space-y-3">
          <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">السنة</label>
              <Input type="number" value={year} onChange={e => setYear(Number(e.target.value))} className="w-24" data-testid="year-input" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">الشهر</label>
              <select value={month} onChange={e => setMonth(Number(e.target.value))}
                className="h-9 rounded-md border bg-background px-2" data-testid="month-input">
                {MONTHS.map((m, i) => <option key={i+1} value={i+1}>{m}</option>)}
              </select>
            </div>
            <Button onClick={() => previewMut.mutate()} disabled={previewMut.isPending} data-testid="btn-preview">
              {previewMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Calculator className="size-4 me-1" />}
              احتساب المعاينة
            </Button>
            <div className="ms-auto text-xs text-muted-foreground bg-blue-50/50 border border-blue-200 rounded p-2 max-w-md">
              <Sparkles className="size-3.5 inline text-blue-600 me-1" />
              يقوم النظام بجلب الراتب من بيانات الموظف، يحسم أيام الغياب، يحتسب الإضافي 1.5×، التأمينات (10% للسعوديين)، وأقساط السلف النشطة تلقائياً.
            </div>
          </div>

          <div className="rounded-lg border overflow-x-auto bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase">
                <tr>
                  <th className="p-2 text-start">الكود</th>
                  <th className="p-2">الفترة</th>
                  <th className="p-2">عدد الموظفين</th>
                  <th className="p-2">الإجمالي</th>
                  <th className="p-2">الخصومات</th>
                  <th className="p-2">الصافي</th>
                  <th className="p-2">الحالة</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {loadingRuns ? (
                  <tr><td colSpan={8} className="p-4"><Skeleton className="h-12" /></td></tr>
                ) : runs.length === 0 ? (
                  <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">لا توجد مسيرات. ابدأ بالمعاينة الشهرية أعلاه.</td></tr>
                ) : runs.map((r: any) => {
                  const st = STATUS[r.status] || STATUS.draft;
                  return (
                    <tr key={r.id} className="border-t" data-testid={`row-run-${r.id}`}>
                      <td className="p-2 font-medium">{r.code}</td>
                      <td className="p-2 text-xs">{MONTHS[r.month - 1]} {r.year}</td>
                      <td className="p-2 text-center">{r.employeesCount}</td>
                      <td className="p-2 text-xs tabular-nums">{Number(r.totalGross).toFixed(2)}</td>
                      <td className="p-2 text-xs tabular-nums text-rose-700">{Number(r.totalDeductions).toFixed(2)}</td>
                      <td className="p-2 text-sm tabular-nums font-semibold text-emerald-700">{Number(r.totalNet).toFixed(2)}</td>
                      <td className="p-2"><Badge variant="outline" className={st.cls}>{st.label}</Badge></td>
                      <td className="p-2 text-end whitespace-nowrap">
                        <Button size="sm" variant="ghost" onClick={() => { setViewing(r.id); setTab("detail"); }} data-testid={`btn-view-${r.id}`}>
                          <Eye className="size-3.5" />
                        </Button>
                        {r.status === "draft" && (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => { if (confirm("اعتماد المسير؟ سيتم خصم أقساط السلف.")) postMut.mutate(r.id); }}
                              title="اعتماد" data-testid={`btn-post-${r.id}`}>
                              <CheckCircle2 className="size-3.5 text-emerald-600" />
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => { if (confirm("حذف المسودة؟")) delMut.mutate(r.id); }}
                              data-testid={`btn-del-run-${r.id}`}>
                              <Trash2 className="size-3.5 text-rose-600" />
                            </Button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="preview" className="space-y-3">
          {!preview ? (
            <div className="text-center text-muted-foreground p-8">قم بضغط "احتساب المعاينة" من تبويب المسيرات.</div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="rounded-lg border p-3 bg-card">
                  <div className="text-xs text-muted-foreground">الفترة</div>
                  <div className="text-base font-semibold">{MONTHS[preview.month - 1]} {preview.year}</div>
                  <div className="text-xs text-muted-foreground mt-1">{preview.periodStart} → {preview.periodEnd}</div>
                </div>
                <div className="rounded-lg border p-3 bg-card">
                  <div className="text-xs text-muted-foreground">عدد الموظفين</div>
                  <div className="text-2xl font-semibold">{preview.totals.employeesCount}</div>
                </div>
                <div className="rounded-lg border p-3 bg-amber-50/50 border-amber-200">
                  <div className="text-xs text-amber-700">إجمالي الرواتب</div>
                  <div className="text-2xl font-semibold text-amber-700 tabular-nums">{preview.totals.gross.toFixed(2)}</div>
                </div>
                <div className="rounded-lg border p-3 bg-emerald-50/50 border-emerald-200">
                  <div className="text-xs text-emerald-700">صافي للصرف</div>
                  <div className="text-2xl font-semibold text-emerald-700 tabular-nums">{preview.totals.net.toFixed(2)}</div>
                </div>
              </div>

              <div className="rounded-lg border overflow-x-auto bg-card">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 uppercase">
                    <tr>
                      <th className="p-2 text-start">الموظف</th>
                      <th className="p-2">أساسي</th>
                      <th className="p-2">سكن</th>
                      <th className="p-2">انتقال</th>
                      <th className="p-2">إضافي</th>
                      <th className="p-2 bg-amber-50">الإجمالي</th>
                      <th className="p-2">تأمينات</th>
                      <th className="p-2">سلف</th>
                      <th className="p-2">غياب</th>
                      <th className="p-2 bg-rose-50">خصومات</th>
                      <th className="p-2 bg-emerald-50">الصافي</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.lines.map((l: any) => (
                      <tr key={l.employeeId} className="border-t" data-testid={`row-prev-${l.employeeId}`}>
                        <td className="p-2">
                          <div className="font-medium">{l.empNameAr}</div>
                          <div className="text-[10px] text-muted-foreground">{l.empCode} {l.isSaudi && <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 ms-1 text-[9px]">سعودي</Badge>}</div>
                        </td>
                        <td className="p-2 tabular-nums text-center">{l.basicSalary.toFixed(2)}</td>
                        <td className="p-2 tabular-nums text-center">{l.housingAllow.toFixed(2)}</td>
                        <td className="p-2 tabular-nums text-center">{l.transportAllow.toFixed(2)}</td>
                        <td className="p-2 tabular-nums text-center">{l.overtimeAmount > 0 ? <span className="text-emerald-700 font-medium">{l.overtimeAmount.toFixed(2)}</span> : "—"}</td>
                        <td className="p-2 tabular-nums text-center bg-amber-50/30 font-semibold">{l.grossSalary.toFixed(2)}</td>
                        <td className="p-2 tabular-nums text-center text-rose-600">{l.gosiEmployee > 0 ? l.gosiEmployee.toFixed(2) : "—"}</td>
                        <td className="p-2 tabular-nums text-center text-rose-600">{l.loanDeduction > 0 ? l.loanDeduction.toFixed(2) : "—"}</td>
                        <td className="p-2 tabular-nums text-center text-rose-600">{l.absenceDeduction > 0 ? `${l.absenceDeduction.toFixed(2)} (${l.absentDays}ي)` : "—"}</td>
                        <td className="p-2 tabular-nums text-center bg-rose-50/30 text-rose-700">{l.totalDeductions.toFixed(2)}</td>
                        <td className="p-2 tabular-nums text-center bg-emerald-50/30 font-semibold text-emerald-700">{l.netSalary.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setPreview(null)} data-testid="btn-discard">
                  <X className="size-4 me-1" /> تجاهل
                </Button>
                <Button onClick={() => createMut.mutate({ year: preview.year, month: preview.month, lines: preview.lines })}
                  disabled={createMut.isPending} data-testid="btn-save-run">
                  {createMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Save className="size-4 me-1" />}
                  حفظ كمسير (مسودة)
                </Button>
              </div>
            </>
          )}
        </TabsContent>

        {viewing && (
          <TabsContent value="detail" className="space-y-3">
            {!viewRun ? <Skeleton className="h-32" /> : (
              <>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="text-lg font-semibold">{viewRun.code}</div>
                    <div className="text-xs text-muted-foreground">{MONTHS[viewRun.month - 1]} {viewRun.year} · {viewRun.periodStart} → {viewRun.periodEnd}</div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={downloadCSV} data-testid="btn-export-csv">
                      <Receipt className="size-4 me-1" /> تصدير CSV (للبنك)
                    </Button>
                    {viewRun.status === "draft" && (
                      <Button onClick={() => postMut.mutate(viewRun.id)} disabled={postMut.isPending} data-testid="btn-post-detail">
                        <CheckCircle2 className="size-4 me-1" /> اعتماد المسير
                      </Button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="rounded-lg border p-3 bg-card"><div className="text-xs text-muted-foreground">الموظفون</div><div className="text-xl font-semibold">{viewRun.employeesCount}</div></div>
                  <div className="rounded-lg border p-3 bg-card"><div className="text-xs text-muted-foreground">الإجمالي</div><div className="text-xl font-semibold tabular-nums">{Number(viewRun.totalGross).toFixed(2)}</div></div>
                  <div className="rounded-lg border p-3 bg-rose-50/50 border-rose-200"><div className="text-xs text-rose-700">الخصومات</div><div className="text-xl font-semibold text-rose-700 tabular-nums">{Number(viewRun.totalDeductions).toFixed(2)}</div></div>
                  <div className="rounded-lg border p-3 bg-emerald-50/50 border-emerald-200"><div className="text-xs text-emerald-700">الصافي</div><div className="text-xl font-semibold text-emerald-700 tabular-nums">{Number(viewRun.totalNet).toFixed(2)}</div></div>
                </div>

                <div className="rounded-lg border overflow-x-auto bg-card">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40 uppercase">
                      <tr>
                        <th className="p-2 text-start">الموظف</th>
                        <th className="p-2">أساسي</th>
                        <th className="p-2">بدلات</th>
                        <th className="p-2">إضافي</th>
                        <th className="p-2">الإجمالي</th>
                        <th className="p-2">خصومات</th>
                        <th className="p-2">الصافي</th>
                        <th className="p-2 text-start">الآيبان</th>
                      </tr>
                    </thead>
                    <tbody>
                      {viewRun.lines.map((l: any) => (
                        <tr key={l.id} className="border-t">
                          <td className="p-2">
                            <div className="font-medium">{l.empNameAr}</div>
                            <div className="text-[10px] text-muted-foreground">{l.empCode}</div>
                          </td>
                          <td className="p-2 tabular-nums text-center">{Number(l.basicSalary).toFixed(2)}</td>
                          <td className="p-2 tabular-nums text-center">{(Number(l.housingAllow)+Number(l.transportAllow)+Number(l.otherAllow)).toFixed(2)}</td>
                          <td className="p-2 tabular-nums text-center">{Number(l.overtimeAmount).toFixed(2)}</td>
                          <td className="p-2 tabular-nums text-center font-medium">{Number(l.grossSalary).toFixed(2)}</td>
                          <td className="p-2 tabular-nums text-center text-rose-700">{Number(l.totalDeductions).toFixed(2)}</td>
                          <td className="p-2 tabular-nums text-center font-semibold text-emerald-700">{Number(l.netSalary).toFixed(2)}</td>
                          <td className="p-2 text-[10px] font-mono">{l.iban || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
