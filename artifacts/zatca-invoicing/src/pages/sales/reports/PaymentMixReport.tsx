import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import {
  salesAnalyticsApi,
  type PaymentMixReport as PaymentMixReportData,
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
  CreditCard, FileText, Receipt, Building2, Users, Clock,
  Sparkles, Loader2, AlertTriangle, CheckCircle2, Lightbulb,
} from "lucide-react";
import { DateField } from "@/components/ui/date-field";

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

export default function PaymentMixReport() {
  const { fmt } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const isAr  = isRtl;
  const tr = (k: string, opts?: any) => t(`salesReports.paymentMix.${k}`, opts) as string;
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);

  const [date, setDate] = useState(today);
  const [branchId, setBranchId] = useState<number | undefined>(undefined);
  const [insights, setInsights] = useState<PaymentMixAiInsights | null>(null);
  const [insightsError, setInsightsError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["payment-mix-report", cid, date, branchId],
    queryFn: () => salesAnalyticsApi.paymentMixReport(cid, date, branchId),
  });

  // Reset AI panel whenever the report inputs change.
  function resetInsights() {
    setInsights(null);
    setInsightsError(null);
  }

  const aiMutation = useMutation({
    mutationFn: async () => {
      if (!data) throw new Error("no data");
      return salesAnalyticsApi.paymentMixAiInsights({
        ...data,
        language: isAr ? "ar" : "en",
      });
    },
    onSuccess: (res) => { setInsights(res); setInsightsError(null); },
    onError:   (err: any) => { setInsightsError(err?.message ?? "AI error"); setInsights(null); },
  });

  const totals = data?.totals;
  const rows   = data?.rows   ?? [];
  const byHour = data?.byHour ?? [];
  const byBranch = data?.byBranch ?? [];
  const topCustomers = data?.topCustomers ?? [];
  const total = Number(totals?.totalAmount ?? 0);

  const pickName = (ar: string | null | undefined, en: string | null | undefined) =>
    isAr ? (ar || en || "—") : (en || ar || "—");
  const methodLabel = (m: string, label?: { ar: string; en: string }) =>
    isAr ? (label?.ar ?? m) : (label?.en ?? m);

  // ─── Hour grid (hour x method) for the stacked-bar style chart
  const hourGrid = useMemo(() => {
    const hours = Array.from({ length: 24 }, (_, i) => i);
    const maxAmount = Math.max(0, ...byHour.map(h => h.amount));
    return { hours, maxAmount };
  }, [byHour]);

  const getHourValue = (hour: number, method: string) =>
    byHour.find(h => h.hour === hour && h.method === method)?.amount ?? 0;
  const getHourTotal = (hour: number) =>
    byHour.filter(h => h.hour === hour).reduce((s, h) => s + h.amount, 0);

  // ─── Export rows: method-level breakdown
  const EXPORT_COLS = useMemo(() => ([
    { key: "method",         header: tr("colMethod"),       width: 18 },
    { key: "invoiceCount",   header: tr("colInvoiceCount"), width: 12 },
    { key: "invoicesAmount", header: tr("colInvoicesAmt"),  width: 14 },
    { key: "receiptCount",   header: tr("colReceiptCount"), width: 12 },
    { key: "receiptsAmount", header: tr("colReceiptsAmt"),  width: 14 },
    { key: "totalAmount",    header: tr("colTotal"),        width: 14 },
    { key: "share",          header: tr("colShare"),        width: 10 },
  ]), [t, isAr]);

  const exportRows = rows.map(r => {
    const share = total > 0 ? (r.totalAmount / total) * 100 : 0;
    return {
      method:         methodLabel(r.method, r.label),
      invoiceCount:   r.invoiceCount,
      invoicesAmount: fmt(r.invoicesAmount),
      receiptCount:   r.receiptCount,
      receiptsAmount: fmt(r.receiptsAmount),
      totalAmount:    fmt(r.totalAmount),
      share:          `${share.toFixed(1)}%`,
    };
  });

  const exportTotalsRow: Record<string, unknown> | null = (!isLoading && totals && rows.length > 0)
    ? {
        method:         tr("totalLabel"),
        invoiceCount:   totals.invoiceCount,
        invoicesAmount: fmt(totals.invoicesAmount),
        receiptCount:   totals.receiptCount,
        receiptsAmount: fmt(totals.receiptsAmount),
        totalAmount:    fmt(totals.totalAmount),
        share:          "100%",
      }
    : null;

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      {/* ───── Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CreditCard className="h-6 w-6 text-primary" />
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
          <DateField
            value={date}
            onChange={e => { setDate(e.target.value); resetInsights(); }}
          />
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
        <KpiTile
          icon={CreditCard} tone="primary"
          label={tr("kpi.totalAmount")}
          value={isLoading ? "…" : fmt(total)}
          hint={tr("kpi.totalHint", { n: totals?.methodsCount ?? 0 })}
        />
        <KpiTile
          icon={FileText} tone="success"
          label={tr("kpi.invoicesAmount")}
          value={isLoading ? "…" : fmt(totals?.invoicesAmount ?? 0)}
          hint={tr("kpi.invoicesCount", { n: totals?.invoiceCount ?? 0 })}
        />
        <KpiTile
          icon={Receipt} tone="warning"
          label={tr("kpi.receiptsAmount")}
          value={isLoading ? "…" : fmt(totals?.receiptsAmount ?? 0)}
          hint={tr("kpi.receiptsCount", { n: totals?.receiptCount ?? 0 })}
        />
        <KpiTile
          icon={Building2} tone="info"
          label={tr("kpi.branchesActive")}
          value={isLoading ? "…" : String(byBranch.length)}
          hint={tr("kpi.customersHint", { n: topCustomers.length })}
        />
      </div>

      {/* ───── AI Insights panel */}
      <Section title={tr("sections.ai")} icon={Sparkles}>
        {!insights && !aiMutation.isPending && !insightsError && (
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <p className="text-sm text-muted-foreground">
              {!rows.length && !isLoading ? tr("ai.noDataHint") : tr("ai.idleText")}
            </p>
            <button
              type="button"
              disabled={isLoading}
              onClick={() => aiMutation.mutate()}
              title={!rows.length && !isLoading ? tr("ai.noDataHint") : ""}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white text-sm font-bold shadow hover:opacity-90 disabled:opacity-50"
            >
              <Sparkles className="h-4 w-4" /> {tr("ai.cta")}
            </button>
          </div>
        )}

        {aiMutation.isPending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {tr("ai.loading")}
          </div>
        )}

        {insightsError && (
          <div className="flex items-center justify-between gap-4 flex-wrap rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
            <span>{tr("ai.errorPrefix")} {insightsError}</span>
            <button
              type="button"
              onClick={() => aiMutation.mutate()}
              className="px-3 py-1 rounded border border-rose-300 bg-white hover:bg-rose-100 text-xs font-bold"
            >
              {tr("ai.retry")}
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
                    <CheckCircle2 className="h-4 w-4" /> {tr("ai.highlights")}
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
                    <AlertTriangle className="h-4 w-4" /> {tr("ai.concerns")}
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
                  <Lightbulb className="h-4 w-4" /> {tr("ai.recommendation")}
                </h4>
                <p className="text-sm text-sky-900">{insights.recommendation}</p>
              </div>
            )}
            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => aiMutation.mutate()}
                className="text-xs px-3 py-1 rounded border bg-card hover:bg-muted/30"
              >
                {tr("ai.regenerate")}
              </button>
            </div>
          </div>
        )}
      </Section>

      {/* ───── Methods breakdown table */}
      <Section title={tr("sections.methods")} icon={CreditCard}>
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : rows.length === 0 ? (
          <EmptyText>{tr("empty.noData")}</EmptyText>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[760px]">
              <thead className="bg-muted/40 border-b">
                <tr>
                  <th className={`px-3 py-2 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colMethod")}</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{tr("colInvoiceCount")}</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{tr("colInvoicesAmt")}</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{tr("colReceiptCount")}</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{tr("colReceiptsAmt")}</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{tr("colTotal")}</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{tr("colShare")}</th>
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
      <Section title={tr("sections.byHour")} icon={Clock}>
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : byHour.length === 0 ? (
          <EmptyText>{tr("empty.noActivity")}</EmptyText>
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
                            <div
                              key={r.method}
                              className={tone(r.method).bar}
                              style={{ height: `${segPct}%` }}
                              title={`${methodLabel(r.method, r.label)}: ${fmt(v)}`}
                            />
                          );
                        })}
                      </div>
                    </div>
                    <div className="text-[10px] font-mono">{String(hour).padStart(2, "0")}</div>
                  </div>
                );
              })}
            </div>
            {/* Legend */}
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
      <Section title={tr("sections.byBranch")} icon={Building2}>
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : byBranch.length === 0 ? (
          <EmptyText>{tr("empty.noBranches")}</EmptyText>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[600px]">
              <thead className="bg-muted/40 border-b">
                <tr>
                  <th className={`px-3 py-2 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colBranch")}</th>
                  {rows.map(r => (
                    <th key={r.method} className="px-3 py-2 text-center font-semibold text-muted-foreground">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] border ${tone(r.method).badge}`}>
                        {methodLabel(r.method, r.label)}
                      </span>
                    </th>
                  ))}
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{tr("colTotal")}</th>
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

      {/* ───── Top customers (mix breakdown) */}
      <Section title={tr("sections.topCustomers")} icon={Users}>
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : topCustomers.length === 0 ? (
          <EmptyText>{tr("empty.noCustomers")}</EmptyText>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[600px]">
              <thead className="bg-muted/40 border-b">
                <tr>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground w-12">#</th>
                  <th className={`px-3 py-2 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colCustomer")}</th>
                  <th className={`px-3 py-2 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colMixUsed")}</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{tr("colTotal")}</th>
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

// ─────────── Helper components

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
