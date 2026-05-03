import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import {
  ClipboardList, ReceiptText, Undo2, Sparkles, RefreshCw,
  CheckCircle2, RotateCcw, Pencil, Eye, AlertTriangle, TrendingUp,
  FileText, Search, Filter, Loader2, ClipboardCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { posOperationsApi, type PosInvoiceRow, type PosReturnRow } from "@/lib/posOperationsApi";

const SAR = (n: number | string | null | undefined, locale: string) =>
  new Intl.NumberFormat(locale, { style: "currency", currency: "SAR", maximumFractionDigits: 2 }).format(Number(n ?? 0));

const fmtDate = (s: string | null | undefined, locale: string) =>
  s ? new Date(s).toLocaleDateString(locale, { dateStyle: "medium" }) : "—";

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  if (status === "posted") return (
    <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 hover:bg-emerald-100">
      <CheckCircle2 className="w-3 h-3 me-1" />{t("posOps.statusPosted")}
    </Badge>
  );
  if (status === "draft") return (
    <Badge className="bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-100">
      <FileText className="w-3 h-3 me-1" />{t("posOps.statusDraft")}
    </Badge>
  );
  return <Badge variant="secondary">{status}</Badge>;
}

function StatCard({ icon: Icon, label, value, accent, sub }: {
  icon: any; label: string; value: string; accent: string; sub?: string;
}) {
  return (
    <Card className="overflow-hidden border-0 shadow-sm">
      <CardContent className="p-5">
        <div className="flex items-center gap-4">
          <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${accent}`}>
            <Icon className="w-6 h-6 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-2xl font-bold leading-tight truncate">{value}</div>
            {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function PosOperations() {
  const { user } = useAuth();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const locale = isRtl ? "ar-SA" : "en-US";
  const tr = (k: string, opts?: any) => t(`posOps.${k}`, opts) as string;
  const pickName = (r: { nameAr?: string | null; nameEn?: string | null } | null | undefined) =>
    !r ? "" : (isRtl ? (r.nameAr ?? r.nameEn ?? "") : (r.nameEn ?? r.nameAr ?? ""));
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  const isAdmin = user?.role === "admin" || user?.role === "superadmin";

  // Filters
  const [status, setStatus] = useState<"" | "draft" | "posted">("");
  const [search, setSearch] = useState("");
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const [fromDate, setFromDate] = useState<string>(monthAgo);
  const [toDate,   setToDate]   = useState<string>(today);
  const [tab, setTab] = useState<"invoices" | "returns" | "ai">("invoices");
  const [busyId, setBusyId] = useState<string | null>(null);

  const summary = useQuery({
    queryKey: ["pos-ops-summary", fromDate, toDate],
    queryFn: () => posOperationsApi.summary({ fromDate, toDate }),
  });
  const invoices = useQuery({
    queryKey: ["pos-ops-invoices", status, fromDate, toDate],
    queryFn: () => posOperationsApi.invoices({ status: status || undefined, fromDate, toDate }),
    enabled: tab === "invoices",
  });
  const returns = useQuery({
    queryKey: ["pos-ops-returns", status, fromDate, toDate],
    queryFn: () => posOperationsApi.returns({ status: status || undefined, fromDate, toDate }),
    enabled: tab === "returns",
  });
  const insights = useQuery({
    queryKey: ["pos-ops-insights"],
    queryFn: () => posOperationsApi.insights(),
    enabled: tab === "ai",
  });

  const filteredInvoices = useMemo(() => {
    const rows = invoices.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      String(r.id).includes(q) ||
      r.docNumber?.toLowerCase().includes(q) ||
      r.cashier?.username?.toLowerCase().includes(q) ||
      r.cashier?.nameAr?.toLowerCase().includes(q) ||
      r.branch?.nameAr?.toLowerCase().includes(q)
    );
  }, [invoices.data, search]);

  const filteredReturns = useMemo(() => {
    const rows = returns.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      String(r.id).includes(q) ||
      r.docNumber?.toLowerCase().includes(q) ||
      r.invoiceDocNumber?.toLowerCase().includes(q) ||
      r.cashier?.username?.toLowerCase().includes(q)
    );
  }, [returns.data, search]);

  async function doPostInvoice(id: number) {
    setBusyId(`inv-post-${id}`);
    try {
      await posOperationsApi.postInvoice(id);
      toast({ title: tr("toastPostedTitle"), description: tr("toastPostedDesc", { id }) });
      qc.invalidateQueries({ queryKey: ["pos-ops-invoices"] });
      qc.invalidateQueries({ queryKey: ["pos-ops-summary"] });
    } catch (e: any) {
      toast({ title: tr("toastFailedTitle"), description: e?.message || "", variant: "destructive" });
    } finally { setBusyId(null); }
  }
  async function doUnpostInvoice(id: number) {
    if (!confirm(tr("confirmUnpost", { id }))) return;
    setBusyId(`inv-unpost-${id}`);
    try {
      await posOperationsApi.unpostInvoice(id);
      toast({ title: tr("toastUnpostedTitle"), description: tr("toastUnpostedDesc", { id }) });
      qc.invalidateQueries({ queryKey: ["pos-ops-invoices"] });
      qc.invalidateQueries({ queryKey: ["pos-ops-summary"] });
    } catch (e: any) {
      toast({ title: tr("toastFailedTitle"), description: e?.message || "", variant: "destructive" });
    } finally { setBusyId(null); }
  }
  async function doPostReturn(id: number) {
    setBusyId(`ret-post-${id}`);
    try {
      await posOperationsApi.postReturn(id);
      toast({ title: tr("toastPostedTitle"), description: tr("toastPostedDesc", { id }) });
      qc.invalidateQueries({ queryKey: ["pos-ops-returns"] });
      qc.invalidateQueries({ queryKey: ["pos-ops-summary"] });
    } catch (e: any) {
      toast({ title: tr("toastFailedTitle"), description: e?.message || "", variant: "destructive" });
    } finally { setBusyId(null); }
  }

  return (
    <div className="space-y-6 p-1" dir={isRtl ? "rtl" : "ltr"}>
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ClipboardList className="w-6 h-6 text-violet-600" />
            {tr("title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{tr("subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate("/sales/invoices")}
            className="gap-1.5 border-violet-200 text-violet-700 hover:bg-violet-50"
            title={isRtl ? "الجرد الخارجي لفواتير المبيعات — مراجعة وتدقيق شامل" : "Sales Invoices Stocktake"}
          >
            <ClipboardCheck className="w-4 h-4" />
            {isRtl ? "الجرد الخارجي" : "Stocktake"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => {
            summary.refetch(); invoices.refetch(); returns.refetch(); insights.refetch();
          }} className="gap-1">
            <RefreshCw className="w-4 h-4" />{tr("refresh")}
          </Button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {summary.isLoading ? [0,1,2,3].map(i => <Skeleton key={i} className="h-24 rounded-xl" />) : (
          <>
            <StatCard
              icon={ReceiptText}
              label={tr("kpiTotalInvoices")}
              value={String(summary.data?.invoices.total ?? 0)}
              accent="bg-gradient-to-br from-violet-500 to-purple-600"
              sub={tr("kpiPeriod")}
            />
            <StatCard
              icon={CheckCircle2}
              label={tr("kpiPostedSales")}
              value={SAR(summary.data?.invoices.posted_total ?? 0, locale)}
              accent="bg-gradient-to-br from-emerald-500 to-emerald-600"
              sub={tr("kpiPostedCount", { n: summary.data?.invoices.posted ?? 0 })}
            />
            <StatCard
              icon={FileText}
              label={tr("kpiDrafts")}
              value={String(summary.data?.invoices.drafts ?? 0)}
              accent="bg-gradient-to-br from-amber-500 to-orange-600"
              sub={SAR(summary.data?.invoices.drafts_total ?? 0, locale)}
            />
            <StatCard
              icon={Undo2}
              label={tr("kpiReturns")}
              value={String(summary.data?.returns.total ?? 0)}
              accent="bg-gradient-to-br from-rose-500 to-red-600"
              sub={SAR(summary.data?.returns.posted_total ?? 0, locale)}
            />
          </>
        )}
      </div>

      {/* Filters */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-4 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground`} />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={tr("searchPh")}
              className={isRtl ? "pe-9" : "ps-9"}
            />
          </div>
          <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v as any)}>
            <SelectTrigger className="w-44"><Filter className="w-4 h-4 me-1" /><SelectValue placeholder={tr("allStatuses")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tr("allStatuses")}</SelectItem>
              <SelectItem value="draft">{tr("statusDraft")}</SelectItem>
              <SelectItem value="posted">{tr("statusPosted")}</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2">
            <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="w-40" />
            <span className="text-muted-foreground text-sm">—</span>
            <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="w-40" />
          </div>
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
        <TabsList className="grid w-full max-w-md grid-cols-3">
          <TabsTrigger value="invoices" className="gap-1.5"><ReceiptText className="w-4 h-4" />{tr("tabInvoices")}</TabsTrigger>
          <TabsTrigger value="returns"  className="gap-1.5"><Undo2 className="w-4 h-4" />{tr("tabReturns")}</TabsTrigger>
          <TabsTrigger value="ai"       className="gap-1.5"><Sparkles className="w-4 h-4" />{tr("tabAi")}</TabsTrigger>
        </TabsList>

        {/* Invoices */}
        <TabsContent value="invoices" className="mt-4">
          <Card className="border-0 shadow-sm">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs">
                    <tr className={isRtl ? "text-right" : "text-left"}>
                      <th className="p-3">{tr("colDoc")}</th>
                      <th className="p-3">{tr("colDate")}</th>
                      <th className="p-3">{tr("colCashier")}</th>
                      <th className="p-3">{tr("colBranch")}</th>
                      <th className="p-3">{tr("colPayment")}</th>
                      <th className={`p-3 ${isRtl ? "text-left" : "text-right"}`}>{tr("colTotal")}</th>
                      <th className="p-3">{tr("colStatus")}</th>
                      <th className={`p-3 ${isRtl ? "text-left" : "text-right"}`}>{tr("colActions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.isLoading && (
                      <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">{tr("loading")}</td></tr>
                    )}
                    {!invoices.isLoading && filteredInvoices.length === 0 && (
                      <tr><td colSpan={8} className="p-8 text-center text-muted-foreground">{tr("noInvoices")}</td></tr>
                    )}
                    {filteredInvoices.map(r => (
                      <InvoiceRow
                        key={r.id} row={r} locale={locale} isRtl={isRtl}
                        isAdmin={isAdmin} busyId={busyId}
                        onView={() => navigate(`/sales/invoices/${r.id}`)}
                        onPost={() => doPostInvoice(r.id)}
                        onUnpost={() => doUnpostInvoice(r.id)}
                        pickName={pickName} tr={tr}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Returns */}
        <TabsContent value="returns" className="mt-4">
          <Card className="border-0 shadow-sm">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs">
                    <tr className={isRtl ? "text-right" : "text-left"}>
                      <th className="p-3">{tr("colDoc")}</th>
                      <th className="p-3">{tr("colDate")}</th>
                      <th className="p-3">{tr("colSourceInv")}</th>
                      <th className="p-3">{tr("colCashier")}</th>
                      <th className="p-3">{tr("colBranch")}</th>
                      <th className={`p-3 ${isRtl ? "text-left" : "text-right"}`}>{tr("colTotal")}</th>
                      <th className="p-3">{tr("colStatus")}</th>
                      <th className={`p-3 ${isRtl ? "text-left" : "text-right"}`}>{tr("colActions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {returns.isLoading && (
                      <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">{tr("loading")}</td></tr>
                    )}
                    {!returns.isLoading && filteredReturns.length === 0 && (
                      <tr><td colSpan={8} className="p-8 text-center text-muted-foreground">{tr("noReturns")}</td></tr>
                    )}
                    {filteredReturns.map(r => (
                      <ReturnRow
                        key={r.id} row={r} locale={locale} isRtl={isRtl}
                        busyId={busyId}
                        onPost={() => doPostReturn(r.id)}
                        pickName={pickName} tr={tr}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* AI Insights */}
        <TabsContent value="ai" className="mt-4 space-y-4">
          {insights.isLoading && (
            <Card className="border-0 shadow-sm"><CardContent className="p-8 text-center text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin inline-block me-2" />
              {tr("aiLoading")}
            </CardContent></Card>
          )}
          {insights.isError && (
            <Card className="border-0 shadow-sm border-l-4 border-l-red-500">
              <CardContent className="p-5 flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5" />
                <div className="text-sm">
                  <div className="font-semibold text-red-700">{tr("toastFailedTitle")}</div>
                  <div className="text-muted-foreground mt-1">
                    {(insights.error as Error | undefined)?.message || ""}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          {insights.data && (
            <>
              {/* Insights bullets */}
              <Card className="border-0 shadow-sm bg-gradient-to-br from-violet-50 to-fuchsia-50">
                <CardContent className="p-5">
                  <h3 className="font-semibold mb-3 flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-violet-600" />
                    {tr("aiInsightsTitle")}
                    <Badge variant="outline" className="ms-auto text-[10px]">
                      {insights.data.source === "ai" ? tr("sourceAi") : tr("sourceRule")}
                    </Badge>
                  </h3>
                  <ul className="space-y-2 text-sm">
                    {insights.data.insights.map((line, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="w-5 h-5 rounded-full bg-violet-200 text-violet-800 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">{i + 1}</span>
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>

              {/* Anomalies */}
              {insights.data.anomalies.length > 0 && (
                <Card className="border-0 shadow-sm">
                  <CardContent className="p-5">
                    <h3 className="font-semibold mb-3 flex items-center gap-2">
                      <AlertTriangle className="w-5 h-5 text-amber-600" />
                      {tr("aiAnomaliesTitle")}
                    </h3>
                    <div className="space-y-2">
                      {insights.data.anomalies.map((a, i) => {
                        const tone = a.severity === "high"
                          ? "border-red-200 bg-red-50"
                          : a.severity === "low"
                          ? "border-blue-200 bg-blue-50"
                          : "border-amber-200 bg-amber-50";
                        const dotTone = a.severity === "high" ? "bg-red-500" : a.severity === "low" ? "bg-blue-500" : "bg-amber-500";
                        return (
                          <div key={i} className={`rounded-lg border p-3 ${tone}`}>
                            <div className="flex items-center gap-2 mb-1">
                              <span className={`w-2 h-2 rounded-full ${dotTone}`} />
                              <div className="font-semibold text-sm">{a.title}</div>
                              <Badge variant="outline" className="ms-auto text-[10px]">{tr(`severity_${a.severity}`)}</Badge>
                            </div>
                            <div className="text-xs text-muted-foreground">{a.description}</div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Top cashiers */}
              {insights.data.topCashiers.length > 0 && (
                <Card className="border-0 shadow-sm">
                  <CardContent className="p-5">
                    <h3 className="font-semibold mb-3 flex items-center gap-2">
                      <TrendingUp className="w-5 h-5 text-emerald-600" />
                      {tr("aiTopCashiers")}
                    </h3>
                    <div className="space-y-2">
                      {insights.data.topCashiers.map((c, idx) => (
                        <div key={c.id} className="flex items-center gap-3">
                          <div className="w-7 h-7 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-xs font-bold">{idx + 1}</div>
                          <div className="flex-1 text-sm font-medium">{pickName(c) || c.username}</div>
                          <div className="text-xs text-muted-foreground">{tr("invoicesShort", { n: c.invoices })}</div>
                          <div className="font-semibold text-sm">{SAR(c.revenue, locale)}</div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Return ratio */}
              {insights.data.returnRatio.length > 0 && (
                <Card className="border-0 shadow-sm">
                  <CardContent className="p-5">
                    <h3 className="font-semibold mb-3 flex items-center gap-2">
                      <Undo2 className="w-5 h-5 text-rose-600" />
                      {tr("aiReturnRatio")}
                    </h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="text-xs text-muted-foreground">
                          <tr className={isRtl ? "text-right" : "text-left"}>
                            <th className="p-2">{tr("colCashier")}</th>
                            <th className={`p-2 ${isRtl ? "text-left" : "text-right"}`}>{tr("colInvoices")}</th>
                            <th className={`p-2 ${isRtl ? "text-left" : "text-right"}`}>{tr("colSales")}</th>
                            <th className={`p-2 ${isRtl ? "text-left" : "text-right"}`}>{tr("colReturns")}</th>
                            <th className={`p-2 ${isRtl ? "text-left" : "text-right"}`}>{tr("colReturnRate")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {insights.data.returnRatio.map((r, i) => (
                            <tr key={i} className="border-t">
                              <td className="p-2 font-medium">{r.nameAr || r.username}</td>
                              <td className={`p-2 ${isRtl ? "text-left" : "text-right"} tabular-nums`}>{r.invoices}</td>
                              <td className={`p-2 ${isRtl ? "text-left" : "text-right"} tabular-nums`}>{SAR(r.sales, locale)}</td>
                              <td className={`p-2 ${isRtl ? "text-left" : "text-right"} tabular-nums`}>{SAR(r.refunded, locale)}</td>
                              <td className={`p-2 ${isRtl ? "text-left" : "text-right"} tabular-nums font-semibold ${r.returnRatePct >= 15 ? "text-red-600" : r.returnRatePct >= 5 ? "text-amber-600" : "text-emerald-600"}`}>
                                {r.returnRatePct}%
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function InvoiceRow({ row, locale, isRtl, isAdmin, busyId, onView, onPost, onUnpost, pickName, tr }: {
  row: PosInvoiceRow; locale: string; isRtl: boolean; isAdmin: boolean; busyId: string | null;
  onView: () => void; onPost: () => void; onUnpost: () => void;
  pickName: (r: any) => string; tr: (k: string, opts?: any) => string;
}) {
  const isPosted = row.status === "posted";
  const isDraft  = row.status === "draft";
  const busyPost   = busyId === `inv-post-${row.id}`;
  const busyUnpost = busyId === `inv-unpost-${row.id}`;

  return (
    <tr className="border-t hover:bg-muted/30">
      <td className="p-3">
        <div className="font-mono text-xs">{row.docNumber || `#${row.id}`}</div>
        {row.zatcaStatus && row.zatcaStatus !== "pending" && (
          <Badge variant="outline" className="text-[10px] mt-1">ZATCA: {row.zatcaStatus}</Badge>
        )}
      </td>
      <td className="p-3 text-xs">{fmtDate(row.invoiceDate, locale)}</td>
      <td className="p-3">
        {row.cashier ? (
          <>
            <div className="font-medium">{pickName(row.cashier) || row.cashier.username}</div>
            <div className="text-[11px] text-muted-foreground">{row.cashier.username}</div>
          </>
        ) : "—"}
      </td>
      <td className="p-3">{pickName(row.branch) || "—"}</td>
      <td className="p-3 text-xs"><Badge variant="outline">{row.paymentType || "—"}</Badge></td>
      <td className={`p-3 ${isRtl ? "text-left" : "text-right"} font-semibold tabular-nums`}>{SAR(row.totalAmount, locale)}</td>
      <td className="p-3"><StatusBadge status={row.status} /></td>
      <td className={`p-3 ${isRtl ? "text-left" : "text-right"}`}>
        <div className="flex items-center gap-1 justify-end">
          <Button size="sm" variant="ghost" onClick={onView} title={tr("actView")} className="h-8 w-8 p-0">
            <Eye className="w-4 h-4" />
          </Button>
          {isDraft && (
            <Button size="sm" variant="ghost" onClick={onView} title={tr("actEdit")} className="h-8 w-8 p-0">
              <Pencil className="w-4 h-4" />
            </Button>
          )}
          {isDraft && (
            <Button size="sm" variant="default" onClick={onPost} disabled={busyPost} className="h-8 gap-1 text-xs">
              {busyPost ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
              {tr("actPost")}
            </Button>
          )}
          {isPosted && isAdmin && (
            <Button size="sm" variant="outline" onClick={onUnpost} disabled={busyUnpost} className="h-8 gap-1 text-xs">
              {busyUnpost ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
              {tr("actUnpost")}
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

function ReturnRow({ row, locale, isRtl, busyId, onPost, pickName, tr }: {
  row: PosReturnRow; locale: string; isRtl: boolean; busyId: string | null;
  onPost: () => void; pickName: (r: any) => string; tr: (k: string, opts?: any) => string;
}) {
  const busyPost = busyId === `ret-post-${row.id}`;
  return (
    <tr className="border-t hover:bg-muted/30">
      <td className="p-3 font-mono text-xs">{row.docNumber || `#${row.id}`}</td>
      <td className="p-3 text-xs">{fmtDate(row.returnDate, locale)}</td>
      <td className="p-3 font-mono text-xs">{row.invoiceDocNumber || (row.invoiceId ? `#${row.invoiceId}` : "—")}</td>
      <td className="p-3">{row.cashier ? (pickName(row.cashier) || row.cashier.username) : "—"}</td>
      <td className="p-3">{pickName(row.branch) || "—"}</td>
      <td className={`p-3 ${isRtl ? "text-left" : "text-right"} font-semibold tabular-nums`}>{SAR(row.totalAmount, locale)}</td>
      <td className="p-3"><StatusBadge status={row.status} /></td>
      <td className={`p-3 ${isRtl ? "text-left" : "text-right"}`}>
        {row.status === "draft" && (
          <Button size="sm" variant="default" onClick={onPost} disabled={busyPost} className="h-8 gap-1 text-xs">
            {busyPost ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
            {tr("actPost")}
          </Button>
        )}
      </td>
    </tr>
  );
}
