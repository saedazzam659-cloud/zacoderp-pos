import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import {
  salesAnalyticsApi,
  type DailyDetailedReport as DailyDetailedReportData,
  type PaymentMixAiInsights,
} from "@/lib/salesAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import { useTranslation } from "react-i18next";
import { useFmt } from "@/hooks/use-fmt";
import {
  CreditCard, FileText, Receipt, Building2, Users, Clock, Package,
  ListChecks, ChevronDown, ChevronUp, Sparkles, Loader2, AlertTriangle,
  CheckCircle2, Lightbulb,
} from "lucide-react";

const METHOD_TONE: Record<string, { bar: string; badge: string }> = {
  cash:     { bar: "bg-emerald-500/80", badge: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  bank:     { bar: "bg-sky-500/80",     badge: "bg-sky-50 text-sky-700 border-sky-200"             },
  credit:   { bar: "bg-amber-500/80",   badge: "bg-amber-50 text-amber-700 border-amber-200"       },
  transfer: { bar: "bg-violet-500/80",  badge: "bg-violet-50 text-violet-700 border-violet-200"    },
  cheque:   { bar: "bg-rose-500/80",    badge: "bg-rose-50 text-rose-700 border-rose-200"          },
  other:    { bar: "bg-slate-500/80",   badge: "bg-slate-50 text-slate-700 border-slate-200"       },
};
function tone(method: string) {
  return METHOD_TONE[method] ?? { bar: "bg-zinc-500/80", badge: "bg-zinc-50 text-zinc-700 border-zinc-200" };
}

export default function DailyDetailedReport() {
  const { fmt } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const isAr  = isRtl;
  const tr  = (k: string, opts?: any) => t(`salesReports.dailyDetailed.${k}`, opts) as string;
  const trp = (k: string, opts?: any) => t(`salesReports.paymentMix.${k}`, opts) as string;
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);

  const [date, setDate] = useState(today);
  const [branchId, setBranchId] = useState<number | undefined>(undefined);
  const [insights, setInsights] = useState<PaymentMixAiInsights | null>(null);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [expandedInv, setExpandedInv] = useState<Record<number, boolean>>({});

  const { data, isLoading } = useQuery({
    queryKey: ["daily-detailed-report", cid, date, branchId],
    queryFn: () => salesAnalyticsApi.dailyDetailedReport(cid, date, branchId),
  });

  function resetInsights() { setInsights(null); setInsightsError(null); setExpandedInv({}); }

  const aiMutation = useMutation({
    mutationFn: async () => {
      if (!data) throw new Error("no data");
      return salesAnalyticsApi.paymentMixAiInsights({
        date: data.date,
        totals: {
          invoiceCount:   data.totals.invoiceCount,
          receiptCount:   data.totals.receiptCount,
          invoicesAmount: data.totals.invoicesAmount,
          receiptsAmount: data.totals.receiptsAmount,
          totalAmount:    data.totals.totalAmount,
          methodsCount:   data.totals.methodsCount,
        },
        rows: data.rows, byHour: data.byHour, byBranch: data.byBranch, topCustomers: data.topCustomers,
        language: isAr ? "ar" : "en",
      });
    },
    onSuccess: (res) => { setInsights(res); setInsightsError(null); },
    onError:   (err: any) => { setInsightsError(err?.message ?? "AI error"); setInsights(null); },
  });

  const totals       = data?.totals;
  const rows         = data?.rows         ?? [];
  const byHour       = data?.byHour       ?? [];
  const byBranch     = data?.byBranch     ?? [];
  const topCustomers = data?.topCustomers ?? [];
  const invoices     = data?.invoices     ?? [];
  const lines        = data?.lines        ?? [];
  const byItem       = data?.byItem       ?? [];
  const total = Number(totals?.totalAmount ?? 0);

  const pickName = (ar: string | null | undefined, en: string | null | undefined) =>
    isAr ? (ar || en || "—") : (en || ar || "—");
  const methodLabel = (m: string, label?: { ar: string; en: string }) =>
    isAr ? (label?.ar ?? m) : (label?.en ?? m);
  const methodLabelByCode = (m: string) => {
    const r = rows.find(x => x.method === m);
    return methodLabel(m, r?.label);
  };

  const hourGrid = useMemo(() => {
    const hours = Array.from({ length: 24 }, (_, i) => i);
    const maxAmount = Math.max(0, ...byHour.map(h => h.amount));
    return { hours, maxAmount };
  }, [byHour]);
  const getHourValue = (hour: number, method: string) =>
    byHour.find(h => h.hour === hour && h.method === method)?.amount ?? 0;
  const getHourTotal = (hour: number) =>
    byHour.filter(h => h.hour === hour).reduce((s, h) => s + h.amount, 0);

  const linesByInvoice = useMemo(() => {
    const m = new Map<number, typeof lines>();
    for (const ln of lines) {
      const arr = m.get(ln.invoiceId) ?? [];
      arr.push(ln); m.set(ln.invoiceId, arr);
    }
    return m;
  }, [lines]);

  // ── Export columns: per-invoice list (the headline new table)
  const EXPORT_COLS = useMemo(() => ([
    { key: "time",       header: tr("inv.time"),       width: 8  },
    { key: "docNumber",  header: tr("inv.doc"),        width: 14 },
    { key: "customer",   header: tr("inv.customer"),   width: 26 },
    { key: "branch",     header: tr("inv.branch"),     width: 16 },
    { key: "salesRep",   header: tr("inv.salesRep"),   width: 16 },
    { key: "method",     header: tr("inv.method"),     width: 10 },
    { key: "lineCount",  header: tr("inv.lineCount"),  width: 8  },
    { key: "totalQty",   header: tr("inv.qty"),        width: 8  },
    { key: "subtotal",   header: tr("inv.subtotal"),   width: 12 },
    { key: "discount",   header: tr("inv.discount"),   width: 10 },
    { key: "vatAmount",  header: tr("inv.vat"),        width: 10 },
    { key: "totalAmount",header: tr("inv.total"),      width: 12 },
  ]), [t, isAr]);

  const exportRows = invoices.map(i => ({
    time:        i.time || "—",
    docNumber:   i.docNumber ?? `#${i.id}`,
    customer:    pickName(i.customerNameAr, i.customerNameEn),
    branch:      pickName(i.branchNameAr, i.branchNameEn),
    salesRep:    pickName(i.salesRepNameAr, i.salesRepNameEn),
    method:      methodLabelByCode(i.paymentType),
    lineCount:   i.lineCount,
    totalQty:    fmt(i.totalQty),
    subtotal:    fmt(i.subtotal),
    discount:    fmt(i.discount),
    vatAmount:   fmt(i.vatAmount),
    totalAmount: fmt(i.totalAmount),
  }));

  const exportTotalsRow: Record<string, unknown> | null = (!isLoading && totals && invoices.length > 0)
    ? {
        time:        tr("totalLabel"),
        docNumber:   "",
        customer:    "",
        branch:      "",
        salesRep:    "",
        method:      "",
        lineCount:   totals.lineCount,
        totalQty:    fmt(totals.totalQty),
        subtotal:    fmt(totals.subtotal),
        discount:    fmt(totals.discount),
        vatAmount:   fmt(totals.vatAmount),
        totalAmount: fmt(totals.invoicesAmount),
      }
    : null;

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      {/* ───── Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ListChecks className="h-6 w-6 text-primary" />
            {tr("title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`${tr("exportFilename")}-${date}`}
          title={tr("exportTitle")}
          subtitle={tr("exportSubtitle", { date, value: fmt(total) })}
          totalsRow={exportTotalsRow}
        />
      </div>

      {/* ───── Filters */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label>{tr("date")}</Label>
          <Input type="date" value={date} onChange={e => { setDate(e.target.value); resetInsights(); }} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("common.branch")}</Label>
          <BranchFilter value={branchId} onChange={(v) => { setBranchId(v); resetInsights(); }} />
        </div>
        <div className="space-y-1.5">
          <Label className="invisible">.</Label>
          <button
            type="button"
            className="w-full h-10 rounded-md border bg-card hover:bg-muted/30 text-sm"
            onClick={() => { setDate(today); resetInsights(); }}
          >
            {tr("backToToday")}
          </button>
        </div>
      </div>

      {/* ───── KPI tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiTile icon={CreditCard} tone="primary"
          label={tr("kpi.totalAmount")}
          value={isLoading ? "…" : fmt(total)}
          hint={tr("kpi.totalHint", { n: totals?.methodsCount ?? 0 })} />
        <KpiTile icon={FileText} tone="success"
          label={tr("kpi.invoicesAmount")}
          value={isLoading ? "…" : fmt(totals?.invoicesAmount ?? 0)}
          hint={tr("kpi.invoicesCount", { n: totals?.invoiceCount ?? 0 })} />
        <KpiTile icon={Receipt} tone="warning"
          label={tr("kpi.receiptsAmount")}
          value={isLoading ? "…" : fmt(totals?.receiptsAmount ?? 0)}
          hint={tr("kpi.receiptsCount", { n: totals?.receiptCount ?? 0 })} />
        <KpiTile icon={Package} tone="info"
          label={tr("kpi.itemsSold")}
          value={isLoading ? "…" : fmt(totals?.totalQty ?? 0)}
          hint={tr("kpi.linesHint", { n: totals?.lineCount ?? 0 })} />
      </div>

      {/* ───── AI Insights panel */}
      <Section title={tr("sections.ai")} icon={Sparkles}>
        {!insights && !aiMutation.isPending && !insightsError && (
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <p className="text-sm text-muted-foreground">
              {!rows.length && !isLoading ? trp("ai.noDataHint") : trp("ai.idleText")}
            </p>
            <button
              type="button"
              disabled={isLoading}
              onClick={() => aiMutation.mutate()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white text-sm font-bold shadow hover:opacity-90 disabled:opacity-50"
            >
              <Sparkles className="h-4 w-4" /> {trp("ai.cta")}
            </button>
          </div>
        )}
        {aiMutation.isPending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {trp("ai.loading")}
          </div>
        )}
        {insightsError && (
          <div className="flex items-center justify-between gap-4 flex-wrap rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
            <span>{trp("ai.errorPrefix")} {insightsError}</span>
            <button type="button" onClick={() => aiMutation.mutate()}
              className="px-3 py-1 rounded border border-rose-300 bg-white hover:bg-rose-100 text-xs font-bold">
              {trp("ai.retry")}
            </button>
          </div>
        )}
        {insights && !aiMutation.isPending && (
          <div className="space-y-4">
            {insights.headline && (
              <div className="rounded-lg border bg-gradient-to-br from-violet-50 to-fuchsia-50/50 border-violet-200 p-4">
                <div className="flex items-start gap-3">
                  <Sparkles className="h-5 w-5 text-violet-600 mt-0.5 shrink-0" />
                  <p className="text-base font-bold text-violet-900 leading-relaxed">{insights.headline}</p>
                </div>
              </div>
            )}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {insights.highlights.length > 0 && (
                <div className="rounded-lg border bg-emerald-50/40 border-emerald-200 p-3">
                  <h4 className="text-xs font-bold text-emerald-700 mb-2 flex items-center gap-1.5">
                    <CheckCircle2 className="h-4 w-4" /> {trp("ai.highlights")}
                  </h4>
                  <ul className="space-y-1.5 text-sm text-emerald-900">
                    {insights.highlights.map((h, i) => (
                      <li key={i} className="flex gap-2"><span className="text-emerald-500">•</span><span>{h}</span></li>
                    ))}
                  </ul>
                </div>
              )}
              {insights.concerns.length > 0 && (
                <div className="rounded-lg border bg-amber-50/40 border-amber-200 p-3">
                  <h4 className="text-xs font-bold text-amber-700 mb-2 flex items-center gap-1.5">
                    <AlertTriangle className="h-4 w-4" /> {trp("ai.concerns")}
                  </h4>
                  <ul className="space-y-1.5 text-sm text-amber-900">
                    {insights.concerns.map((c, i) => (
                      <li key={i} className="flex gap-2"><span className="text-amber-500">•</span><span>{c}</span></li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            {insights.recommendation && (
              <div className="rounded-lg border bg-sky-50/40 border-sky-200 p-3">
                <h4 className="text-xs font-bold text-sky-700 mb-1.5 flex items-center gap-1.5">
                  <Lightbulb className="h-4 w-4" /> {trp("ai.recommendation")}
                </h4>
                <p className="text-sm text-sky-900">{insights.recommendation}</p>
              </div>
            )}
            <div className="flex justify-end pt-2">
              <button type="button" onClick={() => aiMutation.mutate()}
                className="text-xs px-3 py-1 rounded border bg-card hover:bg-muted/30">
                {trp("ai.regenerate")}
              </button>
            </div>
          </div>
        )}
      </Section>

      {/* ───── Methods breakdown table */}
      <Section title={trp("sections.methods")} icon={CreditCard}>
        {isLoading ? <Skeleton className="h-32 w-full" /> : rows.length === 0 ? (
          <EmptyText>{trp("empty.noData")}</EmptyText>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[760px]">
              <thead className="bg-muted/40 border-b">
                <tr>
                  <th className={`px-3 py-2 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{trp("colMethod")}</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{trp("colInvoiceCount")}</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{trp("colInvoicesAmt")}</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{trp("colReceiptCount")}</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{trp("colReceiptsAmt")}</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{trp("colTotal")}</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{trp("colShare")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map(r => {
                  const share = total > 0 ? (r.totalAmount / total) * 100 : 0;
                  const T = tone(r.method);
                  return (
                    <tr key={r.method} className="hover:bg-muted/20">
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] border ${T.badge}`}>
                          {methodLabel(r.method, r.label)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center tabular-nums">{r.invoiceCount}</td>
                      <td className="px-3 py-2 text-center tabular-nums text-xs">{fmt(r.invoicesAmount)}</td>
                      <td className="px-3 py-2 text-center tabular-nums">{r.receiptCount}</td>
                      <td className="px-3 py-2 text-center tabular-nums text-xs">{fmt(r.receiptsAmount)}</td>
                      <td className="px-3 py-2 text-center tabular-nums font-bold">{fmt(r.totalAmount)}</td>
                      <td className="px-3 py-2 text-center">
                        <div className="flex items-center gap-2 justify-center">
                          <div className="w-20 h-2 bg-muted/40 rounded overflow-hidden">
                            <div className={`h-full ${T.bar}`} style={{ width: `${Math.min(100, share)}%` }} />
                          </div>
                          <span className="tabular-nums text-xs text-muted-foreground w-12 text-right">{share.toFixed(1)}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {totals && (
                <tfoot className="bg-muted/30 border-t">
                  <tr>
                    <td className="px-3 py-2 text-xs font-bold">{tr("totalLabel")}</td>
                    <td className="px-3 py-2 text-center tabular-nums font-bold">{totals.invoiceCount}</td>
                    <td className="px-3 py-2 text-center tabular-nums font-bold text-xs">{fmt(totals.invoicesAmount)}</td>
                    <td className="px-3 py-2 text-center tabular-nums font-bold">{totals.receiptCount}</td>
                    <td className="px-3 py-2 text-center tabular-nums font-bold text-xs">{fmt(totals.receiptsAmount)}</td>
                    <td className="px-3 py-2 text-center tabular-nums font-bold text-blue-700">{fmt(totals.totalAmount)}</td>
                    <td className="px-3 py-2 text-center tabular-nums font-bold">100%</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </Section>

      {/* ───── Hourly stacked breakdown */}
      <Section title={trp("sections.byHour")} icon={Clock}>
        {isLoading ? <Skeleton className="h-32 w-full" /> : byHour.length === 0 ? (
          <EmptyText>{trp("empty.noActivity")}</EmptyText>
        ) : (
          <div>
            <div className="grid grid-cols-12 gap-1.5 mb-3">
              {hourGrid.hours.map(hour => {
                const hTotal = getHourTotal(hour);
                if (hTotal === 0) return (
                  <div key={hour} className="flex flex-col items-center gap-1 opacity-30">
                    <div className="text-[10px] tabular-nums text-muted-foreground">—</div>
                    <div className="w-full h-24 bg-muted/20 rounded" />
                    <div className="text-[10px] font-mono">{String(hour).padStart(2, "0")}</div>
                  </div>
                );
                const pct = hourGrid.maxAmount > 0 ? (hTotal / hourGrid.maxAmount) * 100 : 0;
                return (
                  <div key={hour} className="flex flex-col items-center gap-1">
                    <div className="text-[10px] tabular-nums text-muted-foreground">{fmt(hTotal)}</div>
                    <div className="w-full h-24 bg-muted/30 rounded relative overflow-hidden flex flex-col-reverse">
                      <div className="w-full flex flex-col-reverse" style={{ height: `${pct}%` }}>
                        {rows.map(r => {
                          const v = getHourValue(hour, r.method);
                          if (v === 0) return null;
                          const segPct = hTotal > 0 ? (v / hTotal) * 100 : 0;
                          return (
                            <div key={r.method} className={tone(r.method).bar}
                              style={{ height: `${segPct}%` }}
                              title={`${methodLabel(r.method, r.label)}: ${fmt(v)}`} />
                          );
                        })}
                      </div>
                    </div>
                    <div className="text-[10px] font-mono">{String(hour).padStart(2, "0")}</div>
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-3 pt-2 border-t">
              {rows.map(r => (
                <div key={r.method} className="flex items-center gap-1.5 text-xs">
                  <span className={`inline-block w-3 h-3 rounded ${tone(r.method).bar}`} />
                  <span>{methodLabel(r.method, r.label)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>

      {/* ───── By branch matrix */}
      <Section title={trp("sections.byBranch")} icon={Building2}>
        {isLoading ? <Skeleton className="h-32 w-full" /> : byBranch.length === 0 ? (
          <EmptyText>{trp("empty.noBranches")}</EmptyText>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[600px]">
              <thead className="bg-muted/40 border-b">
                <tr>
                  <th className={`px-3 py-2 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{trp("colBranch")}</th>
                  {rows.map(r => (
                    <th key={r.method} className="px-3 py-2 text-center font-semibold text-muted-foreground">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] border ${tone(r.method).badge}`}>
                        {methodLabel(r.method, r.label)}
                      </span>
                    </th>
                  ))}
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{trp("colTotal")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {byBranch.map((b, idx) => (
                  <tr key={`${b.branchId ?? "_none"}-${idx}`} className="hover:bg-muted/20">
                    <td className="px-3 py-2 font-medium">{pickName(b.branchNameAr, b.branchNameEn)}</td>
                    {rows.map(r => {
                      const cell = b.methods[r.method];
                      return (
                        <td key={r.method} className="px-3 py-2 text-center tabular-nums text-xs">
                          {cell ? (
                            <>
                              <div className="font-bold">{fmt(cell.amount)}</div>
                              <div className="text-[10px] text-muted-foreground">×{cell.count}</div>
                            </>
                          ) : <span className="text-muted-foreground/40">—</span>}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-center tabular-nums font-bold text-blue-700">{fmt(b.totalAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ───── Detailed Invoices — TREE VIEW (one line per invoice; expand to see items + summary) */}
      <Section title={tr("sections.invoices")} icon={FileText}>
        {isLoading ? <Skeleton className="h-32 w-full" /> : invoices.length === 0 ? (
          <EmptyText>{tr("empty.noInvoices")}</EmptyText>
        ) : (
          <div>
            {/* Toolbar: expand / collapse all */}
            <div className="flex items-center justify-between gap-2 flex-wrap mb-2 pb-2 border-b">
              <span className="text-[11px] text-muted-foreground">
                {tr("tree.invoicesCount", { n: invoices.length })}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setExpandedInv(Object.fromEntries(invoices.map(i => [i.id, true])))}
                  className="text-[11px] px-2 py-1 rounded border bg-card hover:bg-muted/30 inline-flex items-center gap-1"
                >
                  <ChevronDown className="h-3 w-3" /> {tr("tree.expandAll")}
                </button>
                <button
                  type="button"
                  onClick={() => setExpandedInv({})}
                  className="text-[11px] px-2 py-1 rounded border bg-card hover:bg-muted/30 inline-flex items-center gap-1"
                >
                  <ChevronUp className="h-3 w-3" /> {tr("tree.collapseAll")}
                </button>
              </div>
            </div>

            {/* Invoice tree — each invoice is a single horizontally-scrollable line */}
            <ul className="text-sm divide-y">
              {invoices.map(i => {
                const T = tone(i.paymentType);
                const isOpen = !!expandedInv[i.id];
                const invLines = linesByInvoice.get(i.id) ?? [];
                return (
                  <li key={i.id}>
                    {/* Parent node — single line, info-dense, hover highlight */}
                    <button
                      type="button"
                      onClick={() => setExpandedInv(p => ({ ...p, [i.id]: !p[i.id] }))}
                      className="group w-full flex items-center gap-2 py-2 px-2 text-start hover:bg-muted/30 rounded-sm"
                      aria-expanded={isOpen}
                      aria-label={isOpen ? tr("inv.collapse") : tr("inv.expand")}
                    >
                      {isOpen
                        ? <ChevronUp   className="h-3.5 w-3.5 text-muted-foreground shrink-0 transition" />
                        : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0 transition group-hover:text-foreground" />
                      }
                      <FileText className="h-3.5 w-3.5 text-blue-600 shrink-0" />
                      <span className="font-mono text-[11px] tabular-nums text-muted-foreground shrink-0">{i.time || "—"}</span>
                      <span className="font-bold text-[12px] tabular-nums shrink-0">{i.docNumber ?? `#${i.id}`}</span>
                      <span className="text-muted-foreground/60 text-[10px] shrink-0">·</span>
                      <span className="text-[12px] truncate min-w-0 flex-1">{pickName(i.customerNameAr, i.customerNameEn)}</span>
                      <span className="hidden sm:inline text-muted-foreground/60 text-[10px] shrink-0">·</span>
                      <span className="hidden sm:inline text-[11px] text-muted-foreground shrink-0">{pickName(i.branchNameAr, i.branchNameEn)}</span>
                      <span className="hidden md:inline text-muted-foreground/60 text-[10px] shrink-0">·</span>
                      <span className="hidden md:inline text-[11px] text-muted-foreground shrink-0">{pickName(i.salesRepNameAr, i.salesRepNameEn)}</span>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] border shrink-0 ${T.badge}`}>
                        {methodLabelByCode(i.paymentType)}
                      </span>
                      <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">×{i.lineCount}</span>
                      <span className="hidden md:inline text-[10px] text-muted-foreground tabular-nums shrink-0">{fmt(i.totalQty)} {tr("tree.qty")}</span>
                      <span className="text-[12px] font-bold text-blue-700 tabular-nums shrink-0 min-w-[5.5rem] text-end">{fmt(i.totalAmount)}</span>
                    </button>

                    {/* Children tree: indented with a vertical guide line; logical CSS so it works in RTL & LTR */}
                    {isOpen && (
                      <div className="ms-5 my-1 ps-3 border-s-2 border-dashed border-muted-foreground/25">
                        {/* Items leaf */}
                        {invLines.length > 0 && (
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-700 py-1">
                              <Package className="h-3 w-3" />
                              <span>{tr("tree.itemsLeaf")} <span className="text-muted-foreground font-normal">({invLines.length})</span></span>
                            </div>
                            <ul>
                              {invLines.map(ln => (
                                <li
                                  key={ln.lineId}
                                  className="flex items-center gap-2 py-1 px-2 text-[11px] hover:bg-muted/20 rounded-sm"
                                >
                                  <span className="text-muted-foreground/40 font-mono shrink-0">└</span>
                                  <span className="font-mono text-[10px] text-muted-foreground shrink-0 min-w-[4.5rem]">{ln.itemCode ?? "—"}</span>
                                  <span className="truncate min-w-0 flex-1">{ln.itemName}</span>
                                  <span className="text-muted-foreground/60 shrink-0">·</span>
                                  <span className="tabular-nums shrink-0">{fmt(ln.qty)}{ln.unit ? ` ${ln.unit}` : ""}</span>
                                  <span className="text-muted-foreground/60 shrink-0">@</span>
                                  <span className="tabular-nums text-muted-foreground shrink-0">{fmt(ln.unitPrice)}</span>
                                  {Number(ln.discount) > 0 && (
                                    <span className="tabular-nums text-rose-600 shrink-0">−{fmt(ln.discount)}</span>
                                  )}
                                  <span className="tabular-nums text-muted-foreground shrink-0 hidden md:inline">VAT {fmt(ln.vatRate)}%</span>
                                  <span className="tabular-nums font-bold shrink-0 min-w-[4.5rem] text-end">{fmt(ln.lineTotal)}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* Summary leaf — invoice totals on a single inline line */}
                        <div className="mt-1 pt-1 border-t border-dashed border-muted-foreground/15">
                          <div className="flex items-center gap-1.5 text-[11px] font-bold text-blue-700 py-1">
                            <CreditCard className="h-3 w-3" />
                            <span>{tr("tree.summaryLeaf")}</span>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 text-[11px]">
                            <span className="text-muted-foreground/40 font-mono shrink-0">└</span>
                            <span><span className="text-muted-foreground">{tr("tree.lineCount")}:</span> <b className="tabular-nums">{i.lineCount}</b></span>
                            <span><span className="text-muted-foreground">{tr("tree.totalQty")}:</span> <b className="tabular-nums">{fmt(i.totalQty)}</b></span>
                            <span><span className="text-muted-foreground">{tr("tree.subtotal")}:</span> <b className="tabular-nums">{fmt(i.subtotal)}</b></span>
                            <span><span className="text-muted-foreground">{tr("tree.discount")}:</span> <b className="tabular-nums text-rose-600">{fmt(i.discount)}</b></span>
                            <span><span className="text-muted-foreground">{tr("tree.vat")}:</span> <b className="tabular-nums">{fmt(i.vatAmount)}</b></span>
                            <span className="ms-auto"><span className="text-muted-foreground">{tr("tree.total")}:</span> <b className="tabular-nums text-blue-700">{fmt(i.totalAmount)}</b></span>
                          </div>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            {/* Grand totals footer — inline single line */}
            {totals && (
              <div className="mt-2 pt-2 border-t border-double flex flex-wrap items-center gap-x-4 gap-y-1 px-2 py-1 text-[12px] bg-muted/20 rounded-sm">
                <span className="font-bold text-foreground">{tr("totalLabel")}</span>
                <span><span className="text-muted-foreground">{tr("tree.lineCount")}:</span> <b className="tabular-nums">{totals.lineCount}</b></span>
                <span><span className="text-muted-foreground">{tr("tree.totalQty")}:</span> <b className="tabular-nums">{fmt(totals.totalQty)}</b></span>
                <span><span className="text-muted-foreground">{tr("tree.subtotal")}:</span> <b className="tabular-nums">{fmt(totals.subtotal)}</b></span>
                <span><span className="text-muted-foreground">{tr("tree.discount")}:</span> <b className="tabular-nums text-rose-700">{fmt(totals.discount)}</b></span>
                <span><span className="text-muted-foreground">{tr("tree.vat")}:</span> <b className="tabular-nums">{fmt(totals.vatAmount)}</b></span>
                <span className="ms-auto"><span className="text-muted-foreground">{tr("tree.total")}:</span> <b className="tabular-nums text-blue-700 text-[13px]">{fmt(totals.invoicesAmount)}</b></span>
              </div>
            )}
          </div>
        )}
      </Section>

      {/* ───── NEW: Items breakdown */}
      <Section title={tr("sections.byItem")} icon={Package}>
        {isLoading ? <Skeleton className="h-32 w-full" /> : byItem.length === 0 ? (
          <EmptyText>{tr("empty.noItems")}</EmptyText>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[700px]">
              <thead className="bg-muted/40 border-b">
                <tr>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground w-12">#</th>
                  <th className={`px-3 py-2 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("itm.code")}</th>
                  <th className={`px-3 py-2 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("itm.name")}</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{tr("itm.unit")}</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{tr("itm.qty")}</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{tr("itm.invoiceCount")}</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{tr("itm.totalSales")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {byItem.map((it, idx) => (
                  <tr key={`${it.itemId ?? "_n"}-${idx}`} className="hover:bg-muted/20">
                    <td className="px-3 py-2 text-center">
                      <span className="w-6 h-6 inline-flex items-center justify-center rounded-full bg-primary/10 text-primary text-[11px] font-bold tabular-nums">
                        {idx + 1}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{it.itemCode ?? "—"}</td>
                    <td className="px-3 py-2 font-medium">{it.itemName}</td>
                    <td className="px-3 py-2 text-center text-xs text-muted-foreground">{it.unit ?? "—"}</td>
                    <td className="px-3 py-2 text-center tabular-nums">{fmt(it.qty)}</td>
                    <td className="px-3 py-2 text-center tabular-nums text-xs">{it.invoiceCount}</td>
                    <td className="px-3 py-2 text-center tabular-nums font-bold text-blue-700">{fmt(it.totalSales)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ───── Top customers */}
      <Section title={trp("sections.topCustomers")} icon={Users}>
        {isLoading ? <Skeleton className="h-32 w-full" /> : topCustomers.length === 0 ? (
          <EmptyText>{trp("empty.noCustomers")}</EmptyText>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[600px]">
              <thead className="bg-muted/40 border-b">
                <tr>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground w-12">#</th>
                  <th className={`px-3 py-2 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{trp("colCustomer")}</th>
                  <th className={`px-3 py-2 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{trp("colMixUsed")}</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{trp("colTotal")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {topCustomers.map((c, idx) => (
                  <tr key={`${c.customerId ?? "_none"}-${idx}`} className="hover:bg-muted/20">
                    <td className="px-3 py-2 text-center">
                      <span className="w-6 h-6 inline-flex items-center justify-center rounded-full bg-primary/10 text-primary text-[11px] font-bold tabular-nums">
                        {idx + 1}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-medium">{pickName(c.customerNameAr, c.customerNameEn)}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(c.methods).map(([m, v]) => {
                          const label = rows.find(r => r.method === m)?.label;
                          return (
                            <span key={m} className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] border ${tone(m).badge}`}>
                              {methodLabel(m, label)} · {fmt(v.amount)}
                            </span>
                          );
                        })}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-center tabular-nums font-bold text-blue-700">{fmt(c.totalAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

const TONES: Record<string, string> = {
  primary: "from-blue-50 to-blue-100/40 border-blue-200 text-blue-700",
  success: "from-emerald-50 to-emerald-100/40 border-emerald-200 text-emerald-700",
  warning: "from-amber-50 to-amber-100/40 border-amber-200 text-amber-700",
  danger:  "from-rose-50 to-rose-100/40 border-rose-200 text-rose-700",
  info:    "from-sky-50 to-sky-100/40 border-sky-200 text-sky-700",
};

function KpiTile({
  icon: Icon, tone, label, value, hint,
}: { icon: any; tone: keyof typeof TONES; label: string; value: string; hint?: string }) {
  return (
    <div className={`rounded-xl border bg-gradient-to-br p-4 ${TONES[tone]}`}>
      <div className="flex items-start justify-between mb-2">
        <p className="text-xs font-medium opacity-90">{label}</p>
        <Icon className="h-4 w-4 opacity-70" />
      </div>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
      {hint && <p className="text-[11px] opacity-75 mt-1">{hint}</p>}
    </div>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: any; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b flex items-center gap-2 bg-muted/30">
        <Icon className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-bold">{title}</h2>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return <p className="text-center text-sm text-muted-foreground py-6">{children}</p>;
}
