import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { parseError } from "@/lib/parseError";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Banknote, FileSpreadsheet, Sparkles, Calculator, CheckCircle2, Trash2, Loader2, Eye, Save, Receipt, X, BookOpen, RotateCcw } from "lucide-react";
import { SearchCombobox } from "@/components/ui/search-combobox";

export default function Payroll() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`hrPages.payroll.${k}`, opts) as string;
  const pickName = (ar?: string, en?: string) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");

  const STATUS: Record<string, { label: string; cls: string }> = {
    draft:  { label: tr("statusDraft"),  cls: "bg-amber-50 text-amber-700 border-amber-200" },
    posted: { label: tr("statusPosted"), cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  };
  const MONTHS = [
    tr("monthsJan"), tr("monthsFeb"), tr("monthsMar"), tr("monthsApr"),
    tr("monthsMay"), tr("monthsJun"), tr("monthsJul"), tr("monthsAug"),
    tr("monthsSep"), tr("monthsOct"), tr("monthsNov"), tr("monthsDec"),
  ];

  const autoPostingEnabled = (user as any)?.company?.autoPostingEnabled !== false;
  const now = new Date();
  const [tab, setTab] = useState("runs");
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [preview, setPreview] = useState<any | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [showJournal, setShowJournal] = useState(false);
  const [jeExplain, setJeExplain] = useState<string>("");

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
    onSuccess: (data) => { setPreview(data); setTab("preview"); toast({ title: tr("toastPreviewDone") }); },
    onError: (e) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) }),
  });

  const createMut = useMutation({
    mutationFn: async (data: any) => {
      const created = await employeesApi.createPayroll(data);
      if (autoPostingEnabled && created?.id && (created.status ?? "draft") === "draft") {
        try {
          await employeesApi.postPayroll(created.id);
          return { ...created, _posted: true };
        } catch (e: any) {
          return { ...created, _posted: false, _postError: parseError(e) };
        }
      }
      return { ...created, _posted: false };
    },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["payroll-runs"] });
      qc.invalidateQueries({ queryKey: ["loans"] });
      setPreview(null); setTab("runs");
      if (data?._posted) {
        toast({ title: tr("toastRunCreatedAndPostedTitle"), description: tr("toastRunCreatedAndPostedDesc") });
      } else if (data?._postError) {
        toast({ variant: "destructive", title: tr("toastRunCreatedPostFailedTitle"), description: data._postError });
      } else {
        toast({ title: tr("toastRunCreatedTitle"), description: tr("toastRunCreatedDesc") });
      }
    },
    onError: (e) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) }),
  });

  const postMut = useMutation({
    mutationFn: (id: number) => employeesApi.postPayroll(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll-runs"] });
      qc.invalidateQueries({ queryKey: ["payroll-run", viewing] });
      qc.invalidateQueries({ queryKey: ["loans"] });
      toast({ title: tr("toastPostedTitle"), description: tr("toastPostedDesc") });
    },
    onError: (e) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) }),
  });

  const unpostMut = useMutation({
    mutationFn: (id: number) => employeesApi.unpostPayroll(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll-runs"] });
      qc.invalidateQueries({ queryKey: ["payroll-run", viewing] });
      qc.invalidateQueries({ queryKey: ["loans"] });
      setShowJournal(false); setJeExplain("");
      toast({ title: tr("toastUnpostedTitle"), description: tr("toastUnpostedDesc") });
    },
    onError: (e) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) }),
  });

  const { data: journalData, isLoading: loadingJe } = useQuery<any>({
    queryKey: ["payroll-journal", viewing],
    queryFn: () => employeesApi.payrollJournal(viewing!),
    enabled: !!viewing && showJournal && viewRun?.status === "posted",
  });

  const explainJeMut = useMutation({
    mutationFn: () => employeesApi.aiExplainHrJournal("payroll_run", journalData.entry, journalData.lines, { run: { code: viewRun.code, year: viewRun.year, month: viewRun.month, employeesCount: viewRun.employeesCount } }),
    onSuccess: (data) => { setJeExplain(data.explanation); toast({ title: tr("toastExplainGenerated") }); },
    onError: (e) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) }),
  });

  const delMut = useMutation({
    mutationFn: (id: number) => employeesApi.deletePayroll(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["payroll-runs"] }); toast({ title: tr("toastDeleted") }); },
    onError: (e) => toast({ variant: "destructive", title: tr("toastErrorTitle"), description: parseError(e) }),
  });

  function downloadCSV() {
    const r = viewRun;
    if (!r) return;
    const head = [tr("csvCode"), tr("csvName"), tr("csvBasic"), tr("csvHousing"), tr("csvTransport"), tr("csvOther"), tr("csvOvertime"), tr("csvGross"), tr("csvGosi"), tr("csvLoans"), tr("csvAbsence"), tr("csvDeductions"), tr("csvNet"), tr("csvIban")];
    const rows = r.lines.map((l: any) => [
      l.empCode, pickName(l.empNameAr, l.empNameEn), l.basicSalary, l.housingAllow, l.transportAllow, l.otherAllow,
      l.overtimeAmount, l.grossSalary, l.gosiEmployee, l.loanDeduction, l.absenceDeduction, l.totalDeductions, l.netSalary, l.iban || "",
    ]);
    const csv = "\uFEFF" + [head, ...rows].map(r => r.map((c: any) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `${r.code}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4 p-2 md:p-4" data-testid="page-payroll" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Banknote className="size-6 text-primary" />
          <h1 className="text-xl font-semibold">{tr("title")}</h1>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="runs" data-testid="tab-runs"><FileSpreadsheet className="size-4 me-1" />{tr("tabRuns")}</TabsTrigger>
          <TabsTrigger value="preview" data-testid="tab-preview"><Calculator className="size-4 me-1" />{tr("tabPreview")}</TabsTrigger>
          {viewing && <TabsTrigger value="detail" data-testid="tab-detail"><Eye className="size-4 me-1" />{tr("tabDetail")}</TabsTrigger>}
        </TabsList>

        <TabsContent value="runs" className="space-y-3">
          <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{tr("labelYear")}</label>
              <Input type="number" value={year} onChange={e => setYear(Number(e.target.value))} className="w-24" data-testid="year-input" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{tr("labelMonth")}</label>
              <SearchCombobox
                items={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))}
                value={String(month)}
                onValueChange={(v) => setMonth(Number(v))}
                placeholder={tr("labelMonth")}
                className="w-32"
              />
            </div>
            <Button onClick={() => previewMut.mutate()} disabled={previewMut.isPending} data-testid="btn-preview">
              {previewMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Calculator className="size-4 me-1" />}
              {tr("btnPreview")}
            </Button>
            <div className="ms-auto text-xs text-muted-foreground bg-blue-50/50 border border-blue-200 rounded p-2 max-w-md">
              <Sparkles className="size-3.5 inline text-blue-600 me-1" />
              {tr("previewHelp")}
            </div>
          </div>

          <div className="rounded-lg border overflow-x-auto bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase">
                <tr>
                  <th className="p-2 text-start">{tr("colCode")}</th>
                  <th className="p-2">{tr("colPeriod")}</th>
                  <th className="p-2">{tr("colEmployees")}</th>
                  <th className="p-2">{tr("colTotal")}</th>
                  <th className="p-2">{tr("colDeductions")}</th>
                  <th className="p-2">{tr("colNet")}</th>
                  <th className="p-2">{tr("colStatus")}</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {loadingRuns ? (
                  <tr><td colSpan={8} className="p-4"><Skeleton className="h-12" /></td></tr>
                ) : runs.length === 0 ? (
                  <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">{tr("noRuns")}</td></tr>
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
                            <Button size="sm" variant="ghost" onClick={() => { if (confirm(tr("approveConfirm"))) postMut.mutate(r.id); }}
                              title={tr("approveTooltip")} data-testid={`btn-post-${r.id}`}>
                              <CheckCircle2 className="size-3.5 text-emerald-600" />
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => { if (confirm(tr("deleteDraftConfirm"))) delMut.mutate(r.id); }}
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
            <div className="text-center text-muted-foreground p-8">{tr("previewPrompt")}</div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="rounded-lg border p-3 bg-card">
                  <div className="text-xs text-muted-foreground">{tr("cardPeriod")}</div>
                  <div className="text-base font-semibold">{MONTHS[preview.month - 1]} {preview.year}</div>
                  <div className="text-xs text-muted-foreground mt-1">{preview.periodStart} → {preview.periodEnd}</div>
                </div>
                <div className="rounded-lg border p-3 bg-card">
                  <div className="text-xs text-muted-foreground">{tr("cardEmployees")}</div>
                  <div className="text-2xl font-semibold">{preview.totals.employeesCount}</div>
                </div>
                <div className="rounded-lg border p-3 bg-amber-50/50 border-amber-200">
                  <div className="text-xs text-amber-700">{tr("cardTotalSalaries")}</div>
                  <div className="text-2xl font-semibold text-amber-700 tabular-nums">{preview.totals.gross.toFixed(2)}</div>
                </div>
                <div className="rounded-lg border p-3 bg-emerald-50/50 border-emerald-200">
                  <div className="text-xs text-emerald-700">{tr("cardNetToPay")}</div>
                  <div className="text-2xl font-semibold text-emerald-700 tabular-nums">{preview.totals.net.toFixed(2)}</div>
                </div>
              </div>

              <div className="rounded-lg border overflow-x-auto bg-card">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 uppercase">
                    <tr>
                      <th className="p-2 text-start">{tr("prevColEmployee")}</th>
                      <th className="p-2">{tr("prevColBasic")}</th>
                      <th className="p-2">{tr("prevColHousing")}</th>
                      <th className="p-2">{tr("prevColTransport")}</th>
                      <th className="p-2">{tr("prevColOvertime")}</th>
                      <th className="p-2 bg-amber-50">{tr("prevColTotal")}</th>
                      <th className="p-2">{tr("prevColInsurance")}</th>
                      <th className="p-2">{tr("prevColLoans")}</th>
                      <th className="p-2">{tr("prevColAbsence")}</th>
                      <th className="p-2 bg-rose-50">{tr("prevColDeductions")}</th>
                      <th className="p-2 bg-emerald-50">{tr("prevColNet")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.lines.map((l: any) => (
                      <tr key={l.employeeId} className="border-t" data-testid={`row-prev-${l.employeeId}`}>
                        <td className="p-2">
                          <div className="font-medium">{pickName(l.empNameAr, l.empNameEn)}</div>
                          <div className="text-[10px] text-muted-foreground">{l.empCode} {l.isSaudi && <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 ms-1 text-[9px]">{tr("badgeSaudi")}</Badge>}</div>
                        </td>
                        <td className="p-2 tabular-nums text-center">{l.basicSalary.toFixed(2)}</td>
                        <td className="p-2 tabular-nums text-center">{l.housingAllow.toFixed(2)}</td>
                        <td className="p-2 tabular-nums text-center">{l.transportAllow.toFixed(2)}</td>
                        <td className="p-2 tabular-nums text-center">{l.overtimeAmount > 0 ? <span className="text-emerald-700 font-medium">{l.overtimeAmount.toFixed(2)}</span> : "—"}</td>
                        <td className="p-2 tabular-nums text-center bg-amber-50/30 font-semibold">{l.grossSalary.toFixed(2)}</td>
                        <td className="p-2 tabular-nums text-center text-rose-600">{l.gosiEmployee > 0 ? l.gosiEmployee.toFixed(2) : "—"}</td>
                        <td className="p-2 tabular-nums text-center text-rose-600">{l.loanDeduction > 0 ? l.loanDeduction.toFixed(2) : "—"}</td>
                        <td className="p-2 tabular-nums text-center text-rose-600">{l.absenceDeduction > 0 ? `${l.absenceDeduction.toFixed(2)} (${l.absentDays}${tr("absenceDaysSuffix")})` : "—"}</td>
                        <td className="p-2 tabular-nums text-center bg-rose-50/30 text-rose-700">{l.totalDeductions.toFixed(2)}</td>
                        <td className="p-2 tabular-nums text-center bg-emerald-50/30 font-semibold text-emerald-700">{l.netSalary.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setPreview(null)} data-testid="btn-discard">
                  <X className="size-4 me-1" /> {tr("btnDiscard")}
                </Button>
                <Button onClick={() => createMut.mutate({ year: preview.year, month: preview.month, lines: preview.lines })}
                  disabled={createMut.isPending} data-testid="btn-save-run">
                  {createMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Save className="size-4 me-1" />}
                  {tr("btnSaveDraft")}
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
                      <Receipt className="size-4 me-1" /> {tr("btnExportCsv")}
                    </Button>
                    {viewRun.status === "draft" && (
                      <Button onClick={() => postMut.mutate(viewRun.id)} disabled={postMut.isPending} data-testid="btn-post-detail">
                        <CheckCircle2 className="size-4 me-1" /> {tr("btnPostDetail")}
                      </Button>
                    )}
                    {viewRun.status === "posted" && (
                      <>
                        <Button variant="outline" onClick={() => { setShowJournal((s) => !s); setJeExplain(""); }} data-testid="btn-toggle-je">
                          <BookOpen className="size-4 me-1" /> {showJournal ? tr("btnHideJournal") : tr("btnShowJournal")}
                        </Button>
                        <Button variant="outline" className="text-rose-700 hover:text-rose-800"
                          onClick={() => { if (confirm(tr("unpostConfirm"))) unpostMut.mutate(viewRun.id); }}
                          disabled={unpostMut.isPending} data-testid="btn-unpost">
                          {unpostMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <RotateCcw className="size-4 me-1" />}
                          {tr("btnUnpost")}
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {showJournal && viewRun.status === "posted" && (
                  <div className="rounded-lg border bg-card overflow-hidden">
                    <div className="bg-muted/40 p-3 border-b font-semibold flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2">
                        <BookOpen className="size-4" /> {tr("journalTitle")}
                      </div>
                      {journalData && (
                        <Button size="sm" variant="outline" onClick={() => explainJeMut.mutate()} disabled={explainJeMut.isPending} data-testid="btn-explain-je">
                          {explainJeMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Sparkles className="size-4 me-1" />}
                          {tr("btnExplainAi")}
                        </Button>
                      )}
                    </div>
                    {loadingJe || !journalData ? (
                      <div className="p-4"><Skeleton className="h-32" /></div>
                    ) : (
                      <div className="p-4 space-y-3">
                        <div className="text-sm text-muted-foreground">
                          {tr("docNumberLabel")} <strong>{journalData.entry.docNumber}</strong> ·
                          {" "}{tr("dateLabel")} <strong>{journalData.entry.entryDate}</strong> ·
                          {" "}{tr("descriptionLabel")} <strong>{journalData.entry.description}</strong>
                        </div>
                        <table className="w-full text-sm border rounded-lg overflow-hidden">
                          <thead className="bg-muted/40 text-xs">
                            <tr>
                              <th className="p-2 text-start">{tr("jeColAccount")}</th>
                              <th className="p-2 text-start">{tr("jeColDescription")}</th>
                              <th className="p-2 text-end">{tr("jeColDebit")}</th>
                              <th className="p-2 text-end">{tr("jeColCredit")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {journalData.lines.map((l: any, i: number) => (
                              <tr key={i} className="border-t">
                                <td className="p-2"><span className="font-mono text-xs text-muted-foreground">{l.accountCode}</span> {pickName(l.accountNameAr, l.accountNameEn)}</td>
                                <td className="p-2 text-xs">{l.description}</td>
                                <td className="p-2 text-end tabular-nums text-emerald-700">{Number(l.debit) > 0 ? Number(l.debit).toFixed(2) : "—"}</td>
                                <td className="p-2 text-end tabular-nums text-rose-700">{Number(l.credit) > 0 ? Number(l.credit).toFixed(2) : "—"}</td>
                              </tr>
                            ))}
                            <tr className="border-t bg-muted/20 font-semibold">
                              <td className="p-2" colSpan={2}>{tr("totalRow")}</td>
                              <td className="p-2 text-end tabular-nums text-emerald-700">{Number(journalData.entry.totalDebit).toFixed(2)}</td>
                              <td className="p-2 text-end tabular-nums text-rose-700">{Number(journalData.entry.totalCredit).toFixed(2)}</td>
                            </tr>
                          </tbody>
                        </table>
                        {jeExplain && (
                          <div className="rounded-lg border bg-blue-50/30 border-blue-200 p-4">
                            <div className="flex items-center gap-2 mb-2 text-blue-900 font-semibold">
                              <Sparkles className="size-4" /> {tr("explainHeading")}
                            </div>
                            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-800">{jeExplain}</pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="rounded-lg border p-3 bg-card"><div className="text-xs text-muted-foreground">{tr("cardEmployeesShort")}</div><div className="text-xl font-semibold">{viewRun.employeesCount}</div></div>
                  <div className="rounded-lg border p-3 bg-card"><div className="text-xs text-muted-foreground">{tr("cardTotalShort")}</div><div className="text-xl font-semibold tabular-nums">{Number(viewRun.totalGross).toFixed(2)}</div></div>
                  <div className="rounded-lg border p-3 bg-rose-50/50 border-rose-200"><div className="text-xs text-rose-700">{tr("cardDeductionsShort")}</div><div className="text-xl font-semibold text-rose-700 tabular-nums">{Number(viewRun.totalDeductions).toFixed(2)}</div></div>
                  <div className="rounded-lg border p-3 bg-emerald-50/50 border-emerald-200"><div className="text-xs text-emerald-700">{tr("cardNetShort")}</div><div className="text-xl font-semibold text-emerald-700 tabular-nums">{Number(viewRun.totalNet).toFixed(2)}</div></div>
                </div>

                <div className="rounded-lg border overflow-x-auto bg-card">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40 uppercase">
                      <tr>
                        <th className="p-2 text-start">{tr("detailColEmployee")}</th>
                        <th className="p-2">{tr("detailColBasic")}</th>
                        <th className="p-2">{tr("detailColAllowances")}</th>
                        <th className="p-2">{tr("detailColOvertime")}</th>
                        <th className="p-2">{tr("detailColTotal")}</th>
                        <th className="p-2">{tr("detailColDeductions")}</th>
                        <th className="p-2">{tr("detailColNet")}</th>
                        <th className="p-2 text-start">{tr("detailColIban")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {viewRun.lines.map((l: any) => (
                        <tr key={l.id} className="border-t">
                          <td className="p-2">
                            <div className="font-medium">{pickName(l.empNameAr, l.empNameEn)}</div>
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
