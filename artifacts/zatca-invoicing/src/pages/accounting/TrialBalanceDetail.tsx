import { useState, useMemo } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useFormatters } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { trialBalancesApi, type TrialBalanceFull, type TrialBalance, type TrialBalanceDetail } from "@/lib/trialBalancesApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft, Upload, Save, Trash2, Plus, CheckCircle2, AlertTriangle, Sparkles,
  RotateCcw, FileSpreadsheet, ScrollText, Wrench, GitCompareArrows, FileText, ChevronRight,
} from "lucide-react";
import * as XLSX from "xlsx";
import TrialBalanceImportDialog from "./TrialBalanceImportDialog";
import { DateField } from "@/components/ui/date-field";

const STATUS_CLS: Record<string, string> = {
  draft:     "bg-yellow-50 text-yellow-700 border-yellow-200",
  in_review: "bg-blue-50 text-blue-700 border-blue-200",
  approved:  "bg-green-50 text-green-700 border-green-200",
};

interface AccountOpt { id: number; code: string; nameAr: string; accountType: string; isPosting: boolean; isActive: boolean; }

function num(v: any): number {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export default function TrialBalanceDetailPage() {
  const params = useParams();
  const id = Number(params.id);
  const { t } = useTranslation();
  const { user, token } = useAuth() as any;
  const { fmt } = useFormatters();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const API = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

  const [importOpen, setImportOpen] = useState(false);
  const [adjOpen, setAdjOpen] = useState(false);
  const [compareOtherId, setCompareOtherId] = useState<string>("");
  const [aiOpen, setAiOpen] = useState(false);
  const [aiResult, setAiResult] = useState<any>(null);
  const [editLine, setEditLine] = useState<TrialBalanceDetail | null>(null);
  const [reportType, setReportType] = useState<"detailed"|"summary"|"before-after"|"adjustments">("detailed");

  const { data: tb, isLoading } = useQuery<TrialBalanceFull>({
    queryKey: ["trial-balance", id],
    queryFn:  () => trialBalancesApi.get(id),
    enabled:  !!id && !isNaN(id),
  });

  const { data: allTbs = [] } = useQuery<TrialBalance[]>({
    queryKey: ["trial-balances", cid],
    queryFn:  () => trialBalancesApi.list(),
  });

  const { data: accounts = [] } = useQuery<AccountOpt[]>({
    queryKey: ["accounts-leaf", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/accounts?companyId=${cid}` : `${API}/api/accounts`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const all: AccountOpt[] = await res.json();
      return all.filter(a => a.isPosting && a.isActive);
    },
    enabled: !!user,
  });

  const editLineMut = useMutation({
    mutationFn: (p: { lineId: number; debit: string; credit: string; reason: string }) =>
      trialBalancesApi.editLine(id, p.lineId, { debit: p.debit, credit: p.credit, changeReason: p.reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trial-balance", id] });
      toast({ title: t("trialBalanceMaintenance.lineUpdated") });
      setEditLine(null);
    },
    onError: (e: any) => toast({ title: t("common.error"), description: String(e?.message || e), variant: "destructive" }),
  });

  const deleteLineMut = useMutation({
    mutationFn: (lineId: number) => trialBalancesApi.deleteLine(id, lineId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trial-balance", id] });
      toast({ title: t("trialBalanceMaintenance.lineDeleted") });
    },
    onError: (e: any) => toast({ title: t("common.error"), description: String(e?.message || e), variant: "destructive" }),
  });

  const approveMut = useMutation({
    mutationFn: () => trialBalancesApi.approve(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trial-balance", id] });
      qc.invalidateQueries({ queryKey: ["trial-balances", cid] });
      toast({ title: t("trialBalanceMaintenance.approvedToast") });
    },
    onError: (e: any) => toast({ title: t("trialBalanceMaintenance.approveFailed"), description: String(e?.message || e), variant: "destructive" }),
  });

  const convertMut = useMutation({
    mutationFn: () => trialBalancesApi.convertToClosing(id),
    onSuccess: (closing) => {
      qc.invalidateQueries({ queryKey: ["trial-balances", cid] });
      toast({ title: t("trialBalanceMaintenance.convertedToast") });
      navigate(`/accounting/maintenance/${closing.id}`);
    },
    onError: (e: any) => toast({ title: t("common.error"), description: String(e?.message || e), variant: "destructive" }),
  });

  const aiMut = useMutation({
    mutationFn: async () => {
      const accountById = new Map(accounts.map(a => [a.id, a]));
      const lines = (tb?.details ?? []).map(d => ({
        accountCode: d.accountCode, accountName: d.accountName,
        accountType: d.accountId ? (accountById.get(d.accountId)?.accountType ?? "") : "",
        debit: num(d.debit), credit: num(d.credit),
      }));
      return trialBalancesApi.aiAnalyze({
        totalDebit:  Number(tb?.totalDebit  ?? 0),
        totalCredit: Number(tb?.totalCredit ?? 0),
        lines,
      });
    },
    onSuccess: (r) => { setAiResult(r); setAiOpen(true); },
    onError: (e: any) => toast({ title: t("common.error"), description: String(e?.message || e), variant: "destructive" }),
  });

  const compareQ = useQuery({
    queryKey: ["tb-compare", id, compareOtherId],
    queryFn:  () => trialBalancesApi.compare(id, Number(compareOtherId)),
    enabled:  !!compareOtherId && Number(compareOtherId) !== id,
  });

  const reportQ = useQuery({
    queryKey: ["tb-report", id, reportType],
    queryFn:  () => trialBalancesApi.report(id, reportType),
    enabled:  !!tb,
  });

  const td = num(tb?.totalDebit);
  const tc = num(tb?.totalCredit);
  const diff = +(td - tc).toFixed(2);
  const balanced = Math.abs(diff) < 0.01;

  const exportLinesXlsx = () => {
    if (!tb) return;
    const aoa: any[][] = [
      ["كود الحساب", "اسم الحساب", "مدين أصلي", "دائن أصلي", "مدين معدّل", "دائن معدّل", "سبب التعديل"],
      ...tb.details.map(d => [d.accountCode, d.accountName, num(d.originalDebit), num(d.originalCredit), num(d.debit), num(d.credit), d.changeReason ?? ""]),
      ["", "الإجمالي", "", "", td, tc, ""],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Trial Balance");
    XLSX.writeFile(wb, `ميزان-مراجعة-${tb.fiscalYear}-${tb.periodEnd}.xlsx`);
  };

  if (isLoading) return <div className="p-6">{t("common.loading")}</div>;
  if (!tb)       return <div className="p-6">{t("trialBalanceMaintenance.notFound")}</div>;

  const isApproved = tb.status === "approved";

  return (
    <div className="space-y-4 p-4" data-testid="trial-balance-detail">
      <Button variant="ghost" size="sm" onClick={() => navigate("/accounting/maintenance")} data-testid="btn-back">
        <ArrowLeft className="h-4 w-4 me-1" /> {t("common.back")}
      </Button>

      {/* Header card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between flex-wrap gap-3">
            <div>
              <CardTitle className="text-xl flex items-center gap-2">
                <Wrench className="h-5 w-5 text-primary" />
                {t("trialBalanceMaintenance.headerTitle", { year: tb.fiscalYear, end: tb.periodEnd })}
              </CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                {tb.periodStart} ← {tb.periodEnd} · {t(`trialBalanceMaintenance.type${tb.balanceType.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase())}`, { defaultValue: tb.balanceType })}
              </p>
              {tb.notes && <p className="text-xs text-muted-foreground mt-1">{tb.notes}</p>}
            </div>
            <div className="flex items-center gap-2">
              <Badge className={STATUS_CLS[tb.status]} data-testid="status-badge">{t(`trialBalanceMaintenance.status${tb.status.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase())}`)}</Badge>
              {!isApproved && (
                <Button onClick={() => setImportOpen(true)} data-testid="btn-open-import">
                  <Upload className="h-4 w-4 me-1" /> {t("trialBalanceMaintenance.importNow")}
                </Button>
              )}
              <Button variant="outline" onClick={exportLinesXlsx} data-testid="btn-export-xlsx">
                <FileSpreadsheet className="h-4 w-4 me-1" /> {t("trialBalanceMaintenance.exportXlsx")}
              </Button>
              <Button variant="outline" onClick={() => aiMut.mutate()} disabled={aiMut.isPending} data-testid="btn-ai-analyze">
                <Sparkles className="h-4 w-4 me-1" /> {aiMut.isPending ? t("common.loading") : t("trialBalanceMaintenance.aiAnalyze")}
              </Button>
              {!isApproved && (
                <Button variant="default" onClick={() => approveMut.mutate()} disabled={approveMut.isPending} data-testid="btn-approve">
                  <CheckCircle2 className="h-4 w-4 me-1" /> {t("trialBalanceMaintenance.approve")}
                </Button>
              )}
              {isApproved && tb.balanceType !== "closing" && (
                <Button variant="default" onClick={() => convertMut.mutate()} disabled={convertMut.isPending} data-testid="btn-convert-closing">
                  <RotateCcw className="h-4 w-4 me-1" /> {t("trialBalanceMaintenance.convertToClosing")}
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-3">
            <div className="border rounded p-3">
              <div className="text-xs text-muted-foreground">{t("trialBalanceMaintenance.totalDebit")}</div>
              <div className="text-xl font-mono font-bold">{fmt(td)}</div>
            </div>
            <div className="border rounded p-3">
              <div className="text-xs text-muted-foreground">{t("trialBalanceMaintenance.totalCredit")}</div>
              <div className="text-xl font-mono font-bold">{fmt(tc)}</div>
            </div>
            <div className={`border rounded p-3 ${balanced ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"}`}>
              <div className="text-xs text-muted-foreground">{t("trialBalanceMaintenance.diff")}</div>
              <div className={`text-xl font-mono font-bold flex items-center gap-1 ${balanced ? "text-green-700" : "text-red-700"}`} data-testid="diff-value">
                {balanced ? <CheckCircle2 className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
                {fmt(diff)}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="lines" className="w-full">
        <TabsList>
          <TabsTrigger value="lines" data-testid="tab-lines">{t("trialBalanceMaintenance.tabLines")}</TabsTrigger>
          <TabsTrigger value="compare" data-testid="tab-compare">{t("trialBalanceMaintenance.tabCompare")}</TabsTrigger>
          <TabsTrigger value="adjustments" data-testid="tab-adjustments">{t("trialBalanceMaintenance.tabAdjustments")}</TabsTrigger>
          <TabsTrigger value="reports" data-testid="tab-reports">{t("trialBalanceMaintenance.tabReports")}</TabsTrigger>
          <TabsTrigger value="log" data-testid="tab-log">{t("trialBalanceMaintenance.tabLog")}</TabsTrigger>
        </TabsList>

        {/* LINES TAB */}
        <TabsContent value="lines">
          <Card>
            <CardContent className="pt-4">
              {tb.details.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <FileSpreadsheet className="h-10 w-10 mx-auto mb-2 opacity-50" />
                  {t("trialBalanceMaintenance.noLinesYet")}
                  {!isApproved && (
                    <div className="mt-3"><Button onClick={() => setImportOpen(true)}><Upload className="h-4 w-4 me-1" /> {t("trialBalanceMaintenance.importNow")}</Button></div>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-start p-2">{t("trialBalanceMaintenance.code")}</th>
                        <th className="text-start p-2">{t("trialBalanceMaintenance.accountName")}</th>
                        <th className="text-end p-2">{t("trialBalanceMaintenance.originalDebit")}</th>
                        <th className="text-end p-2">{t("trialBalanceMaintenance.originalCredit")}</th>
                        <th className="text-end p-2">{t("trialBalanceMaintenance.debit")}</th>
                        <th className="text-end p-2">{t("trialBalanceMaintenance.credit")}</th>
                        <th className="text-start p-2">{t("trialBalanceMaintenance.changeReason")}</th>
                        <th className="text-end p-2">{t("common.actions")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tb.details.map(d => {
                        const changed = num(d.debit) !== num(d.originalDebit) || num(d.credit) !== num(d.originalCredit);
                        return (
                          <tr key={d.id} className={`border-t ${d.isUnlinked ? "bg-yellow-50" : ""} ${changed ? "bg-blue-50/30" : ""}`} data-testid={`line-${d.id}`}>
                            <td className="p-2 font-mono">
                              {d.accountCode}
                              {d.isUnlinked === 1 && (
                                <Badge variant="outline" className="ms-1 text-[10px] bg-yellow-100">{t("trialBalanceMaintenance.unlinked")}</Badge>
                              )}
                            </td>
                            <td className="p-2">{d.accountName}</td>
                            <td className="p-2 text-end font-mono text-muted-foreground">{fmt(num(d.originalDebit))}</td>
                            <td className="p-2 text-end font-mono text-muted-foreground">{fmt(num(d.originalCredit))}</td>
                            <td className="p-2 text-end font-mono">{fmt(num(d.debit))}</td>
                            <td className="p-2 text-end font-mono">{fmt(num(d.credit))}</td>
                            <td className="p-2 text-xs text-muted-foreground">{d.changeReason ?? ""}</td>
                            <td className="p-2 text-end">
                              {!isApproved && (
                                <div className="flex gap-1 justify-end">
                                  <Button size="icon" variant="ghost" onClick={() => setEditLine(d)} data-testid={`btn-edit-line-${d.id}`}><Wrench className="h-4 w-4" /></Button>
                                  <Button size="icon" variant="ghost" onClick={() => deleteLineMut.mutate(d.id)} data-testid={`btn-delete-line-${d.id}`}><Trash2 className="h-4 w-4 text-red-600" /></Button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="font-bold bg-muted/30">
                      <tr className="border-t-2">
                        <td colSpan={4} className="p-2 text-end">{t("trialBalanceMaintenance.totals")}</td>
                        <td className="p-2 text-end font-mono">{fmt(td)}</td>
                        <td className="p-2 text-end font-mono">{fmt(tc)}</td>
                        <td colSpan={2}></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* COMPARE TAB */}
        <TabsContent value="compare">
          <Card>
            <CardContent className="pt-4 space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-sm">{t("trialBalanceMaintenance.compareWith")}:</span>
                <Select value={compareOtherId} onValueChange={setCompareOtherId}>
                  <SelectTrigger className="w-[300px]" data-testid="select-compare"><SelectValue placeholder={t("trialBalanceMaintenance.selectAnother")} /></SelectTrigger>
                  <SelectContent>
                    {allTbs.filter(x => x.id !== id).map(x => (
                      <SelectItem key={x.id} value={String(x.id)}>
                        #{x.id} · {x.fiscalYear} · {x.periodEnd} · {x.balanceType}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {!compareOtherId && <p className="text-sm text-muted-foreground">{t("trialBalanceMaintenance.compareHint")}</p>}
              {compareQ.data && (
                <div className="overflow-x-auto">
                  <div className="text-sm mb-2">
                    {t("trialBalanceMaintenance.changedLines")}: <strong>{compareQ.data.summary.changedCount}</strong> / {compareQ.data.summary.totalCount}
                  </div>
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-start p-2">{t("trialBalanceMaintenance.code")}</th>
                        <th className="text-start p-2">{t("trialBalanceMaintenance.accountName")}</th>
                        <th className="text-end p-2">{t("trialBalanceMaintenance.baseDebit")}</th>
                        <th className="text-end p-2">{t("trialBalanceMaintenance.baseCredit")}</th>
                        <th className="text-end p-2">{t("trialBalanceMaintenance.otherDebit")}</th>
                        <th className="text-end p-2">{t("trialBalanceMaintenance.otherCredit")}</th>
                        <th className="text-end p-2">{t("trialBalanceMaintenance.diffDebit")}</th>
                        <th className="text-end p-2">{t("trialBalanceMaintenance.diffCredit")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {compareQ.data.lines.map(l => (
                        <tr key={l.accountCode} className={`border-t ${l.changed ? "bg-yellow-50" : ""}`}>
                          <td className="p-2 font-mono">{l.accountCode}</td>
                          <td className="p-2">{l.accountName}</td>
                          <td className="p-2 text-end font-mono">{fmt(num(l.baseDebit))}</td>
                          <td className="p-2 text-end font-mono">{fmt(num(l.baseCredit))}</td>
                          <td className="p-2 text-end font-mono">{fmt(num(l.otherDebit))}</td>
                          <td className="p-2 text-end font-mono">{fmt(num(l.otherCredit))}</td>
                          <td className={`p-2 text-end font-mono ${num(l.diffDebit) !== 0 ? "text-blue-700 font-bold" : ""}`}>{fmt(num(l.diffDebit))}</td>
                          <td className={`p-2 text-end font-mono ${num(l.diffCredit) !== 0 ? "text-blue-700 font-bold" : ""}`}>{fmt(num(l.diffCredit))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ADJUSTMENTS TAB */}
        <TabsContent value="adjustments">
          <Card>
            <CardContent className="pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold">{t("trialBalanceMaintenance.adjustmentsTitle")}</h3>
                {!isApproved && (
                  <Button onClick={() => setAdjOpen(true)} data-testid="btn-add-adjustment">
                    <Plus className="h-4 w-4 me-1" /> {t("trialBalanceMaintenance.addAdjustment")}
                  </Button>
                )}
              </div>
              {tb.adjustments.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">{t("trialBalanceMaintenance.noAdjustments")}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-start p-2">#</th>
                        <th className="text-start p-2">{t("trialBalanceMaintenance.adjDescription")}</th>
                        <th className="text-start p-2">{t("trialBalanceMaintenance.adjCategory")}</th>
                        <th className="text-end p-2">{t("trialBalanceMaintenance.amount")}</th>
                        <th className="text-start p-2">{t("trialBalanceMaintenance.linkedJournal")}</th>
                        <th className="text-start p-2">{t("trialBalanceMaintenance.createdAt")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tb.adjustments.map(a => (
                        <tr key={a.id} className="border-t" data-testid={`adj-${a.id}`}>
                          <td className="p-2 font-mono">#{a.id}</td>
                          <td className="p-2">{a.description}</td>
                          <td className="p-2">{a.category}</td>
                          <td className="p-2 text-end font-mono">{fmt(num(a.amount))}</td>
                          <td className="p-2 font-mono">
                            {a.journalEntryId
                              ? <button className="text-blue-700 underline" onClick={() => navigate(`/accounting/journals/${a.journalEntryId}`)}>JE-{a.journalEntryId}</button>
                              : "—"}
                          </td>
                          <td className="p-2 text-xs">{a.createdAt?.slice(0, 16).replace("T", " ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* REPORTS TAB */}
        <TabsContent value="reports">
          <Card>
            <CardContent className="pt-4 space-y-3">
              <div className="flex items-center gap-2">
                <Select value={reportType} onValueChange={(v) => setReportType(v as any)}>
                  <SelectTrigger className="w-[260px]" data-testid="select-report-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="detailed">{t("trialBalanceMaintenance.reportDetailed")}</SelectItem>
                    <SelectItem value="summary">{t("trialBalanceMaintenance.reportSummary")}</SelectItem>
                    <SelectItem value="before-after">{t("trialBalanceMaintenance.reportBeforeAfter")}</SelectItem>
                    <SelectItem value="adjustments">{t("trialBalanceMaintenance.reportAdjustments")}</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="outline" onClick={() => window.print()}><FileText className="h-4 w-4 me-1" />{t("trialBalanceMaintenance.print")}</Button>
              </div>
              {reportQ.data && reportType === "detailed" && (
                <div className="overflow-x-auto border rounded">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50"><tr>
                      <th className="text-start p-2">{t("trialBalanceMaintenance.code")}</th>
                      <th className="text-start p-2">{t("trialBalanceMaintenance.accountName")}</th>
                      <th className="text-end p-2">{t("trialBalanceMaintenance.debit")}</th>
                      <th className="text-end p-2">{t("trialBalanceMaintenance.credit")}</th>
                    </tr></thead>
                    <tbody>{(reportQ.data.lines ?? []).map((l: any) => (
                      <tr key={l.id} className="border-t">
                        <td className="p-2 font-mono">{l.accountCode}</td>
                        <td className="p-2">{l.accountName}</td>
                        <td className="p-2 text-end font-mono">{fmt(num(l.debit))}</td>
                        <td className="p-2 text-end font-mono">{fmt(num(l.credit))}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
              {reportQ.data && reportType === "summary" && (
                <div className="overflow-x-auto border rounded">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50"><tr>
                      <th className="text-start p-2">{t("trialBalanceMaintenance.accountType")}</th>
                      <th className="text-end p-2">{t("trialBalanceMaintenance.count")}</th>
                      <th className="text-end p-2">{t("trialBalanceMaintenance.totalDebit")}</th>
                      <th className="text-end p-2">{t("trialBalanceMaintenance.totalCredit")}</th>
                    </tr></thead>
                    <tbody>{(reportQ.data.groups ?? []).map((g: any) => (
                      <tr key={g.accountType} className="border-t">
                        <td className="p-2">{t(`trialBalanceMaintenance.acctType.${g.accountType}`, { defaultValue: g.accountType })}</td>
                        <td className="p-2 text-end">{g.count}</td>
                        <td className="p-2 text-end font-mono">{fmt(num(g.totalDebit))}</td>
                        <td className="p-2 text-end font-mono">{fmt(num(g.totalCredit))}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
              {reportQ.data && reportType === "before-after" && (
                <div className="overflow-x-auto border rounded">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50"><tr>
                      <th className="text-start p-2">{t("trialBalanceMaintenance.code")}</th>
                      <th className="text-start p-2">{t("trialBalanceMaintenance.accountName")}</th>
                      <th className="text-end p-2">{t("trialBalanceMaintenance.beforeDebit")}</th>
                      <th className="text-end p-2">{t("trialBalanceMaintenance.beforeCredit")}</th>
                      <th className="text-end p-2">{t("trialBalanceMaintenance.afterDebit")}</th>
                      <th className="text-end p-2">{t("trialBalanceMaintenance.afterCredit")}</th>
                      <th className="text-end p-2">{t("trialBalanceMaintenance.diffDebit")}</th>
                      <th className="text-end p-2">{t("trialBalanceMaintenance.diffCredit")}</th>
                    </tr></thead>
                    <tbody>{(reportQ.data.lines ?? []).map((l: any, i: number) => (
                      <tr key={i} className={`border-t ${num(l.diffDebit)!==0 || num(l.diffCredit)!==0 ? "bg-blue-50/30" : ""}`}>
                        <td className="p-2 font-mono">{l.accountCode}</td>
                        <td className="p-2">{l.accountName}</td>
                        <td className="p-2 text-end font-mono">{fmt(num(l.beforeDebit))}</td>
                        <td className="p-2 text-end font-mono">{fmt(num(l.beforeCredit))}</td>
                        <td className="p-2 text-end font-mono">{fmt(num(l.afterDebit))}</td>
                        <td className="p-2 text-end font-mono">{fmt(num(l.afterCredit))}</td>
                        <td className="p-2 text-end font-mono">{fmt(num(l.diffDebit))}</td>
                        <td className="p-2 text-end font-mono">{fmt(num(l.diffCredit))}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
              {reportQ.data && reportType === "adjustments" && (
                <div className="overflow-x-auto border rounded">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50"><tr>
                      <th className="text-start p-2">{t("trialBalanceMaintenance.adjDescription")}</th>
                      <th className="text-end p-2">{t("trialBalanceMaintenance.amount")}</th>
                      <th className="text-start p-2">{t("trialBalanceMaintenance.adjCategory")}</th>
                      <th className="text-start p-2">{t("trialBalanceMaintenance.createdAt")}</th>
                    </tr></thead>
                    <tbody>{(reportQ.data.adjustments ?? []).map((a: any) => (
                      <tr key={a.id} className="border-t">
                        <td className="p-2">{a.description}</td>
                        <td className="p-2 text-end font-mono">{fmt(num(a.amount))}</td>
                        <td className="p-2">{a.category}</td>
                        <td className="p-2 text-xs">{a.createdAt?.slice(0,16).replace("T"," ")}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* LOG TAB */}
        <TabsContent value="log">
          <Card>
            <CardContent className="pt-4">
              {tb.logs.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">{t("trialBalanceMaintenance.noLogs")}</p>
              ) : (
                <div className="space-y-1.5">
                  {tb.logs.map(l => (
                    <div key={l.id} className="border-s-2 border-primary/30 ps-3 py-1 text-sm">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{l.action}</Badge>
                        <span className="text-xs text-muted-foreground">{l.createdAt?.slice(0,19).replace("T"," ")}</span>
                      </div>
                      {l.details && <pre className="text-xs mt-1 text-muted-foreground whitespace-pre-wrap font-mono">{JSON.stringify(l.details, null, 0)}</pre>}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Import dialog */}
      <TrialBalanceImportDialog
        trialBalanceId={id}
        open={importOpen}
        onOpenChange={setImportOpen}
      />

      {/* Edit line dialog */}
      <EditLineDialog
        line={editLine}
        onClose={() => setEditLine(null)}
        onSave={(p) => editLineMut.mutate(p)}
        saving={editLineMut.isPending}
      />

      {/* Add adjustment dialog */}
      <AdjustmentDialog
        open={adjOpen}
        onOpenChange={setAdjOpen}
        accounts={accounts}
        defaultDate={tb.periodEnd}
        onSave={async (payload) => {
          try {
            await trialBalancesApi.addAdjustment(id, payload);
            qc.invalidateQueries({ queryKey: ["trial-balance", id] });
            toast({ title: t("trialBalanceMaintenance.adjustmentAdded") });
            setAdjOpen(false);
          } catch (e: any) {
            toast({ title: t("common.error"), description: String(e?.message || e), variant: "destructive" });
          }
        }}
      />

      {/* AI result dialog */}
      <Dialog open={aiOpen} onOpenChange={setAiOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-amber-500" />{t("trialBalanceMaintenance.aiResultTitle")}</DialogTitle></DialogHeader>
          {aiResult && (
            <div className="space-y-3 text-sm">
              <Alert className={aiResult.balanced ? "border-green-300" : "border-red-300"}>
                <AlertTitle className="flex items-center gap-2">
                  {aiResult.balanced ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <AlertTriangle className="h-4 w-4 text-red-600" />}
                  {aiResult.balanced ? t("trialBalanceMaintenance.aiBalanced") : t("trialBalanceMaintenance.aiUnbalanced")}
                </AlertTitle>
                <AlertDescription>{aiResult.imbalanceReason}</AlertDescription>
              </Alert>

              {aiResult.abnormalAccounts?.length > 0 && (
                <div>
                  <h4 className="font-semibold mb-1">{t("trialBalanceMaintenance.aiAbnormal")}</h4>
                  <ul className="space-y-1 text-xs">
                    {aiResult.abnormalAccounts.map((a: any, i: number) => (
                      <li key={i} className="border rounded p-2">
                        <div className="flex items-center gap-2">
                          <Badge variant={a.severity === "high" ? "destructive" : "secondary"}>{a.severity}</Badge>
                          <span className="font-mono">{a.accountCode}</span>
                          <span>{a.accountName}</span>
                        </div>
                        <div className="text-muted-foreground mt-1">{a.reason}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {aiResult.suggestions?.length > 0 && (
                <div>
                  <h4 className="font-semibold mb-1">{t("trialBalanceMaintenance.aiSuggestions")}</h4>
                  <ul className="space-y-1 text-xs">
                    {aiResult.suggestions.map((s: any, i: number) => (
                      <li key={i} className="border rounded p-2">
                        <div>{s.description}</div>
                        {s.lines && s.lines.length > 0 && (
                          <table className="w-full mt-1 text-xs"><tbody>
                            {s.lines.map((ln: any, j: number) => (
                              <tr key={j}><td className="font-mono">{ln.accountCode}</td><td className="text-end font-mono">{fmt(num(ln.debit))}</td><td className="text-end font-mono">{fmt(num(ln.credit))}</td></tr>
                            ))}
                          </tbody></table>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="text-[10px] text-muted-foreground">{t("trialBalanceMaintenance.aiSource")}: {aiResult.source}</div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Edit Line dialog ─────────────────────────────────────────────────────────
function EditLineDialog({ line, onClose, onSave, saving }: {
  line: TrialBalanceDetail | null;
  onClose: () => void;
  onSave: (p: { lineId: number; debit: string; credit: string; reason: string }) => void;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const [debit, setDebit]   = useState("");
  const [credit, setCredit] = useState("");
  const [reason, setReason] = useState("");
  useMemo(() => {
    if (line) {
      setDebit(String(line.debit ?? "0"));
      setCredit(String(line.credit ?? "0"));
      setReason(line.changeReason ?? "");
    }
  }, [line]);
  if (!line) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("trialBalanceMaintenance.editLineTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground">
            <div><strong>{line.accountCode}</strong> — {line.accountName}</div>
            <div>{t("trialBalanceMaintenance.originalDebit")}: {line.originalDebit} · {t("trialBalanceMaintenance.originalCredit")}: {line.originalCredit}</div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs">{t("trialBalanceMaintenance.debit")}</label><Input data-testid="input-edit-debit" value={debit} onChange={e => setDebit(e.target.value)} /></div>
            <div><label className="text-xs">{t("trialBalanceMaintenance.credit")}</label><Input data-testid="input-edit-credit" value={credit} onChange={e => setCredit(e.target.value)} /></div>
          </div>
          <div><label className="text-xs">{t("trialBalanceMaintenance.changeReason")}</label><Textarea data-testid="input-edit-reason" value={reason} onChange={e => setReason(e.target.value)} rows={2} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
          <Button data-testid="btn-save-line" disabled={saving} onClick={() => onSave({ lineId: line.id, debit: String(num(debit)), credit: String(num(credit)), reason })}>
            <Save className="h-4 w-4 me-1" /> {saving ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Add Adjustment dialog ────────────────────────────────────────────────────
function AdjustmentDialog({ open, onOpenChange, accounts, defaultDate, onSave }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  accounts: AccountOpt[];
  defaultDate: string;
  onSave: (p: { description: string; category: string; entryDate: string; lines: { accountId: number; debit: number; credit: number; description: string }[] }) => void;
}) {
  const { t } = useTranslation();
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("manual");
  const [entryDate, setEntryDate] = useState(defaultDate);
  const [lines, setLines] = useState<{ accountId: string; debit: string; credit: string; description: string }[]>([
    { accountId: "", debit: "", credit: "", description: "" },
    { accountId: "", debit: "", credit: "", description: "" },
  ]);
  const td = lines.reduce((s, l) => s + num(l.debit), 0);
  const tc = lines.reduce((s, l) => s + num(l.credit), 0);
  const balanced = Math.abs(td - tc) < 0.01 && td > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t("trialBalanceMaintenance.addAdjustmentTitle")}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2"><label className="text-xs">{t("trialBalanceMaintenance.adjDescription")}</label><Input data-testid="input-adj-desc" value={description} onChange={e => setDescription(e.target.value)} /></div>
            <div><label className="text-xs">{t("trialBalanceMaintenance.adjDate")}</label><DateField value={entryDate} onChange={e => setEntryDate(e.target.value)} /></div>
            <div><label className="text-xs">{t("trialBalanceMaintenance.adjCategory")}</label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">{t("trialBalanceMaintenance.catManual")}</SelectItem>
                  <SelectItem value="depreciation">{t("trialBalanceMaintenance.catDepreciation")}</SelectItem>
                  <SelectItem value="accruals">{t("trialBalanceMaintenance.catAccruals")}</SelectItem>
                  <SelectItem value="prepayments">{t("trialBalanceMaintenance.catPrepayments")}</SelectItem>
                  <SelectItem value="error_correction">{t("trialBalanceMaintenance.catErrorCorrection")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="border rounded">
            <table className="w-full text-sm">
              <thead className="bg-muted/50"><tr>
                <th className="text-start p-2">{t("trialBalanceMaintenance.account")}</th>
                <th className="text-end p-2">{t("trialBalanceMaintenance.debit")}</th>
                <th className="text-end p-2">{t("trialBalanceMaintenance.credit")}</th>
                <th className="text-start p-2">{t("trialBalanceMaintenance.lineDescription")}</th>
                <th></th>
              </tr></thead>
              <tbody>
                {lines.map((ln, i) => (
                  <tr key={i} className="border-t">
                    <td className="p-1">
                      <Select value={ln.accountId} onValueChange={v => { const c = [...lines]; c[i].accountId = v; setLines(c); }}>
                        <SelectTrigger className="h-8" data-testid={`select-adj-account-${i}`}><SelectValue placeholder={t("trialBalanceMaintenance.selectAccount")} /></SelectTrigger>
                        <SelectContent className="max-h-[300px]">
                          {accounts.map(a => <SelectItem key={a.id} value={String(a.id)}>{a.code} — {a.nameAr}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="p-1"><Input className="h-8 text-end font-mono" value={ln.debit} onChange={e => { const c = [...lines]; c[i].debit = e.target.value; setLines(c); }} data-testid={`input-adj-debit-${i}`} /></td>
                    <td className="p-1"><Input className="h-8 text-end font-mono" value={ln.credit} onChange={e => { const c = [...lines]; c[i].credit = e.target.value; setLines(c); }} data-testid={`input-adj-credit-${i}`} /></td>
                    <td className="p-1"><Input className="h-8" value={ln.description} onChange={e => { const c = [...lines]; c[i].description = e.target.value; setLines(c); }} /></td>
                    <td className="p-1"><Button size="icon" variant="ghost" onClick={() => { const c = lines.filter((_, j) => j !== i); setLines(c.length >= 2 ? c : lines); }}><Trash2 className="h-3 w-3" /></Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button variant="outline" size="sm" onClick={() => setLines([...lines, { accountId: "", debit: "", credit: "", description: "" }])}><Plus className="h-3 w-3 me-1" />{t("trialBalanceMaintenance.addRow")}</Button>
          <div className="flex items-center justify-end gap-3 text-sm">
            <span>{t("trialBalanceMaintenance.totalDebit")}: <strong className="font-mono">{td.toFixed(2)}</strong></span>
            <span>{t("trialBalanceMaintenance.totalCredit")}: <strong className="font-mono">{tc.toFixed(2)}</strong></span>
            {balanced
              ? <CheckCircle2 className="h-5 w-5 text-green-600" />
              : <span className="text-red-600 flex items-center gap-1"><AlertTriangle className="h-4 w-4" />{t("trialBalanceMaintenance.notBalanced")}</span>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button data-testid="btn-save-adjustment" disabled={!description.trim() || !balanced || lines.some(l => !l.accountId)}
            onClick={() => onSave({ description, category, entryDate, lines: lines.map(l => ({ accountId: Number(l.accountId), debit: num(l.debit), credit: num(l.credit), description: l.description })) })}>
            <Save className="h-4 w-4 me-1" /> {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
