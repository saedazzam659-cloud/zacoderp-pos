import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { salesAnalyticsApi } from "@/lib/salesAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import { useTranslation } from "react-i18next";
import { useFmt } from "@/hooks/use-fmt";
import {
  Sun, FileText, Wallet, Banknote, CreditCard, Package, Users,
  RotateCcw, Receipt, TrendingUp, Clock, Building2, UserCheck, PieChart,
} from "lucide-react";

const STATUS_TONE: Record<string, string> = {
  posted:    "bg-emerald-50 text-emerald-700 border-emerald-200",
  draft:     "bg-amber-50 text-amber-700 border-amber-200",
  cancelled: "bg-rose-50 text-rose-700 border-rose-200",
};

const PAYMENT_TONE: Record<string, string> = {
  cash:   "bg-emerald-50 text-emerald-700 border-emerald-200",
  bank:   "bg-sky-50 text-sky-700 border-sky-200",
  credit: "bg-amber-50 text-amber-700 border-amber-200",
};

export default function DailyReport() {
  const { fmt } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const isAr  = isRtl;
  const tr = (k: string, opts?: any) => t(`salesReports.dailyReport.${k}`, opts) as string;
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);

  const [date, setDate] = useState(today);
  const [branchId, setBranchId] = useState<number | undefined>(undefined);

  const { data, isLoading } = useQuery({
    queryKey: ["sales-daily-report", cid, date, branchId],
    queryFn: () => salesAnalyticsApi.dailyReport(cid, date, branchId),
  });

  const summary = data?.summary;
  const invoices = data?.invoices ?? [];
  const topItems = data?.topItems ?? [];
  const topCustomers = data?.topCustomers ?? [];
  const byRep = data?.byRep ?? [];
  const byBranch = data?.byBranch ?? [];
  const byHour = data?.byHour ?? [];
  const receipts = data?.receipts ?? [];

  const pickName = (ar: string | null | undefined, en: string | null | undefined) =>
    isAr ? (ar || en || "—") : (en || ar || "—");

  // ─────────── Hour-chart geometry
  const maxHourAmount = Math.max(0, ...byHour.map(h => h.totalAmount));

  // ─────────── Export rows (invoices)
  const EXPORT_COLS = useMemo(() => ([
    { key: "docNumber",    header: tr("colInvoice"),     width: 16 },
    { key: "time",         header: tr("colTime"),        width: 8  },
    { key: "customer",     header: tr("colCustomer"),    width: 28 },
    { key: "rep",          header: tr("colRep"),         width: 18 },
    { key: "branch",       header: tr("colBranch"),      width: 14 },
    { key: "lineCount",    header: tr("colLines"),       width: 8  },
    { key: "subtotal",     header: tr("colSubtotal"),    width: 14 },
    { key: "discount",     header: tr("colDiscount"),    width: 12 },
    { key: "vatAmount",    header: tr("colVat"),         width: 12 },
    { key: "totalAmount",  header: tr("colTotal"),       width: 14 },
    { key: "paymentType",  header: tr("colPayment"),     width: 10 },
    { key: "status",       header: tr("colStatus"),      width: 10 },
  ]), [t, isAr]);

  const exportRows = invoices.map(i => ({
    docNumber:   i.docNumber ?? `#${i.id}`,
    time:        i.time,
    customer:    pickName(i.customerNameAr, i.customerNameEn),
    rep:         pickName(i.salesRepNameAr, i.salesRepNameEn),
    branch:      pickName(i.branchNameAr, i.branchNameEn),
    lineCount:   i.lineCount,
    subtotal:    fmt(i.subtotal),
    discount:    fmt(i.discount),
    vatAmount:   fmt(i.vatAmount),
    totalAmount: fmt(i.totalAmount),
    paymentType: tr(`payment.${i.paymentType}`),
    status:      tr(`status.${i.status}`),
  }));

  // ─────────── Grand-totals row appended to the export.
  // Mirrors the on-screen <tfoot> in the invoices table (subtotal,
  // VAT, discount, total + invoice count + total line count) so the
  // printed/exported file isn't missing the bottom-line numbers when
  // a manager takes it out of the SPA. We pull from `summary` (the
  // server-aggregated totals) rather than re-summing client-side so
  // the totals always match the KPI tiles regardless of pagination.
  const exportTotalsRow: Record<string, unknown> | null = (!isLoading && summary && invoices.length > 0)
    ? {
        docNumber:   tr("totalLabel"),
        time:        "",
        customer:    tr("totalInvoicesShort", { n: summary.invoiceCount ?? invoices.length }),
        rep:         "",
        branch:      "",
        lineCount:   summary.lineCount ?? "",
        subtotal:    fmt(summary.subtotal ?? 0),
        discount:    fmt(summary.discount ?? 0),
        vatAmount:   fmt(summary.vatAmount ?? 0),
        totalAmount: fmt(summary.totalAmount ?? 0),
        paymentType: "",
        status:      "",
      }
    : null;

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      {/* ───── Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Sun className="h-6 w-6 text-primary" />
            {tr("title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`${tr("exportFilename")}-${date}`}
          title={tr("exportTitle")}
          subtitle={tr("exportSubtitle", { date, value: fmt(summary?.totalAmount ?? 0) })}
          totalsRow={exportTotalsRow}
        />
      </div>

      {/* ───── Filters */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label>{tr("date")}</Label>
          <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("common.branch")}</Label>
          <BranchFilter value={branchId} onChange={setBranchId} />
        </div>
        <div className="space-y-1.5">
          <Label className="invisible">.</Label>
          <button
            type="button"
            className="w-full h-10 rounded-md border bg-card hover:bg-muted/30 text-sm"
            onClick={() => setDate(today)}
          >
            {tr("backToToday")}
          </button>
        </div>
      </div>

      {/* ───── KPI Tiles (top row) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiTile
          icon={FileText} tone="primary"
          label={tr("kpi.invoices")}
          value={isLoading ? "…" : String(summary?.invoiceCount ?? 0)}
          hint={tr("kpi.customersCount", { n: summary?.customerCount ?? 0 })}
        />
        <KpiTile
          icon={TrendingUp} tone="success"
          label={tr("kpi.totalSales")}
          value={isLoading ? "…" : fmt(summary?.totalAmount ?? 0)}
          hint={tr("kpi.netAfterReturns", { v: fmt(summary?.netSales ?? 0) })}
        />
        <KpiTile
          icon={Receipt} tone="warning"
          label={tr("kpi.vat")}
          value={isLoading ? "…" : fmt(summary?.vatAmount ?? 0)}
          hint={tr("kpi.subtotalLabel", { v: fmt(summary?.subtotal ?? 0) })}
        />
        <KpiTile
          icon={RotateCcw} tone="danger"
          label={tr("kpi.returns")}
          value={isLoading ? "…" : fmt(summary?.returnAmount ?? 0)}
          hint={tr("kpi.returnsCount", { n: summary?.returnCount ?? 0 })}
        />
      </div>

      {/* ───── KPI Tiles (second row — payment breakdown) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiTile
          icon={Wallet} tone="success"
          label={tr("kpi.cashSales")}
          value={isLoading ? "…" : fmt(summary?.cashAmount ?? 0)}
          hint={tr("kpi.invoicesCount", { n: summary?.cashCount ?? 0 })}
        />
        <KpiTile
          icon={Banknote} tone="info"
          label={tr("kpi.bankSales")}
          value={isLoading ? "…" : fmt(summary?.bankAmount ?? 0)}
          hint={tr("kpi.invoicesCount", { n: summary?.bankCount ?? 0 })}
        />
        <KpiTile
          icon={CreditCard} tone="warning"
          label={tr("kpi.creditSales")}
          value={isLoading ? "…" : fmt(summary?.creditAmount ?? 0)}
          hint={tr("kpi.invoicesCount", { n: summary?.creditCount ?? 0 })}
        />
        <KpiTile
          icon={Receipt} tone="primary"
          label={tr("kpi.receipts")}
          value={isLoading ? "…" : fmt(summary?.receiptsAmount ?? 0)}
          hint={tr("kpi.receiptsCount", { n: summary?.receiptsCount ?? 0 })}
        />
      </div>

      {/* ───── Average + lines + qty (mini stats) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MiniStat label={tr("mini.avgInvoice")}  value={isLoading ? "…" : fmt(summary?.avgInvoice ?? 0)} />
        <MiniStat label={tr("mini.discount")}    value={isLoading ? "…" : fmt(summary?.discount ?? 0)} />
        <MiniStat label={tr("mini.totalLines")}  value={isLoading ? "…" : String(summary?.lineCount ?? 0)} />
        <MiniStat label={tr("mini.totalQty")}    value={isLoading ? "…" : fmt(summary?.totalQty ?? 0)} />
      </div>

      {/* ───── Hourly chart */}
      <Section title={tr("sections.byHour")} icon={Clock}>
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : byHour.length === 0 ? (
          <EmptyText>{tr("empty.noActivity")}</EmptyText>
        ) : (
          <div className="grid grid-cols-12 gap-1.5">
            {byHour.map(h => {
              const pct = maxHourAmount > 0 ? (h.totalAmount / maxHourAmount) * 100 : 0;
              return (
                <div key={h.hour} className="flex flex-col items-center gap-1">
                  <div className="text-[10px] tabular-nums text-muted-foreground">{fmt(h.totalAmount)}</div>
                  <div className="w-full h-24 bg-muted/30 rounded relative overflow-hidden flex items-end">
                    <div className="w-full bg-blue-500/80" style={{ height: `${pct}%` }} title={`${h.invoiceCount} | ${fmt(h.totalAmount)}`} />
                  </div>
                  <div className="text-[10px] font-mono">{String(h.hour).padStart(2, "0")}</div>
                  <div className="text-[10px] text-muted-foreground">×{h.invoiceCount}</div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* ───── Two columns: top items / top customers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section title={tr("sections.topItems")} icon={Package}>
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : topItems.length === 0 ? (
            <EmptyText>{tr("empty.noItems")}</EmptyText>
          ) : (
            <RankList
              rows={topItems.slice(0, 10).map((it, idx) => ({
                rank: idx + 1,
                name: it.itemName + (it.itemCode ? ` · ${it.itemCode}` : ""),
                hint: tr("rank.qtyHint", { qty: fmt(it.qty), n: it.invoiceCount }),
                value: fmt(it.totalSales),
              }))}
            />
          )}
        </Section>

        <Section title={tr("sections.topCustomers")} icon={Users}>
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : topCustomers.length === 0 ? (
            <EmptyText>{tr("empty.noCustomers")}</EmptyText>
          ) : (
            <RankList
              rows={topCustomers.slice(0, 10).map((c, idx) => ({
                rank: idx + 1,
                name: pickName(c.customerNameAr, c.customerNameEn),
                hint: tr("rank.invoicesHint", { n: c.invoiceCount }),
                value: fmt(c.totalSales),
              }))}
            />
          )}
        </Section>
      </div>

      {/* ───── Two columns: by rep / by branch */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section title={tr("sections.byRep")} icon={UserCheck}>
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : byRep.length === 0 ? (
            <EmptyText>{tr("empty.noReps")}</EmptyText>
          ) : (
            <RankList
              rows={byRep.map((r, idx) => ({
                rank: idx + 1,
                name: pickName(r.salesRepNameAr, r.salesRepNameEn),
                hint: tr("rank.invoicesHint", { n: r.invoiceCount }),
                value: fmt(r.totalSales),
              }))}
            />
          )}
        </Section>

        <Section title={tr("sections.byBranch")} icon={Building2}>
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : byBranch.length === 0 ? (
            <EmptyText>{tr("empty.noBranches")}</EmptyText>
          ) : (
            <RankList
              rows={byBranch.map((b, idx) => ({
                rank: idx + 1,
                name: pickName(b.branchNameAr, b.branchNameEn),
                hint: tr("rank.invoicesHint", { n: b.invoiceCount }),
                value: fmt(b.totalSales),
              }))}
            />
          )}
        </Section>
      </div>

      {/* ───── Sales by payment method (breakdown table) */}
      <Section title={tr("sections.byPayment")} icon={PieChart}>
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (() => {
          const total = Number(summary?.totalAmount ?? 0);
          const rows = [
            {
              key:    "cash" as const,
              label:  tr("payment.cash"),
              count:  summary?.cashCount  ?? 0,
              amount: Number(summary?.cashAmount  ?? 0),
            },
            {
              key:    "bank" as const,
              label:  tr("payment.bank"),
              count:  summary?.bankCount  ?? 0,
              amount: Number(summary?.bankAmount  ?? 0),
            },
            {
              key:    "credit" as const,
              label:  tr("payment.credit"),
              count:  summary?.creditCount ?? 0,
              amount: Number(summary?.creditAmount ?? 0),
            },
          ];
          const totalCount = rows.reduce((s, r) => s + r.count, 0);
          if (totalCount === 0) return <EmptyText>{tr("empty.noPayments")}</EmptyText>;
          return (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[480px]">
                <thead className="bg-muted/40 border-b">
                  <tr>
                    <th className={`px-3 py-2 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>
                      {tr("byPayment.colMethod")}
                    </th>
                    <th className="px-3 py-2 text-center font-semibold text-muted-foreground">
                      {tr("byPayment.colCount")}
                    </th>
                    <th className="px-3 py-2 text-center font-semibold text-muted-foreground">
                      {tr("byPayment.colAmount")}
                    </th>
                    <th className="px-3 py-2 text-center font-semibold text-muted-foreground">
                      {tr("byPayment.colPercent")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map(r => {
                    const pct = total > 0 ? (r.amount / total) * 100 : 0;
                    return (
                      <tr key={r.key} className="hover:bg-muted/20">
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] border ${PAYMENT_TONE[r.key] ?? ""}`}>
                            {r.label}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-center tabular-nums">{r.count}</td>
                        <td className="px-3 py-2 text-center tabular-nums font-bold">{fmt(r.amount)}</td>
                        <td className="px-3 py-2 text-center">
                          <div className="flex items-center gap-2 justify-center">
                            <div className="w-24 h-2 bg-muted/40 rounded overflow-hidden">
                              <div
                                className={
                                  r.key === "cash"   ? "h-full bg-emerald-500/80" :
                                  r.key === "bank"   ? "h-full bg-sky-500/80"     :
                                                       "h-full bg-amber-500/80"
                                }
                                style={{ width: `${Math.min(100, pct)}%` }}
                              />
                            </div>
                            <span className="tabular-nums text-xs text-muted-foreground w-10 text-right">
                              {pct.toFixed(1)}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-muted/30 border-t">
                  <tr>
                    <td className="px-3 py-2 text-xs font-bold">{tr("byPayment.totalLabel")}</td>
                    <td className="px-3 py-2 text-center tabular-nums font-bold">{totalCount}</td>
                    <td className="px-3 py-2 text-center tabular-nums font-bold text-blue-700">{fmt(total)}</td>
                    <td className="px-3 py-2 text-center tabular-nums font-bold">100%</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          );
        })()}
      </Section>

      {/* ───── Receipts list (cash collected today) */}
      <Section title={tr("sections.receipts")} icon={Receipt}>
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : receipts.length === 0 ? (
          <EmptyText>{tr("empty.noReceipts")}</EmptyText>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[600px]">
              <thead className="bg-muted/40 border-b">
                <tr>
                  <th className={`px-3 py-2 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colReceiptCode")}</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{tr("colTime")}</th>
                  <th className={`px-3 py-2 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colEntity")}</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{tr("colPayment")}</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{tr("colAmount")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {receipts.map(r => (
                  <tr key={r.id} className="hover:bg-muted/20">
                    <td className="px-3 py-2 font-mono text-xs">{r.code}</td>
                    <td className="px-3 py-2 text-center font-mono text-xs">{r.time}</td>
                    <td className="px-3 py-2">{r.entityName ?? "—"}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] border ${PAYMENT_TONE[r.paymentType] ?? ""}`}>
                        {tr(`payment.${r.paymentType}`)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center font-bold tabular-nums text-emerald-700">{fmt(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ───── Full invoices list */}
      <Section title={tr("sections.invoices")} icon={FileText}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[1000px]">
            <thead className="bg-muted/40 border-b">
              <tr>
                <th className={`px-3 py-2 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colInvoice")}</th>
                <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{tr("colTime")}</th>
                <th className={`px-3 py-2 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colCustomer")}</th>
                <th className={`px-3 py-2 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground hidden lg:table-cell`}>{tr("colRep")}</th>
                <th className="px-3 py-2 text-center font-semibold text-muted-foreground hidden lg:table-cell">{tr("colLines")}</th>
                <th className="px-3 py-2 text-center font-semibold text-muted-foreground hidden md:table-cell">{tr("colSubtotal")}</th>
                <th className="px-3 py-2 text-center font-semibold text-muted-foreground hidden md:table-cell">{tr("colVat")}</th>
                <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{tr("colTotal")}</th>
                <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{tr("colPayment")}</th>
                <th className="px-3 py-2 text-center font-semibold text-muted-foreground">{tr("colStatus")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(6)].map((_, i) => (
                    <tr key={i}><td colSpan={10} className="px-3 py-2"><Skeleton className="h-6 w-full" /></td></tr>
                  ))
                : invoices.length === 0
                ? <tr><td colSpan={10} className="py-12 text-center text-muted-foreground">{tr("empty.noInvoices")}</td></tr>
                : invoices.map(i => (
                    <tr key={i.id} className="hover:bg-muted/20">
                      <td className="px-3 py-2 font-mono text-xs font-semibold">{i.docNumber ?? `#${i.id}`}</td>
                      <td className="px-3 py-2 text-center font-mono text-xs">{i.time}</td>
                      <td className="px-3 py-2">{pickName(i.customerNameAr, i.customerNameEn)}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground hidden lg:table-cell">
                        {pickName(i.salesRepNameAr, i.salesRepNameEn) === "—" ? "—" : pickName(i.salesRepNameAr, i.salesRepNameEn)}
                      </td>
                      <td className="px-3 py-2 text-center hidden lg:table-cell">{i.lineCount}</td>
                      <td className="px-3 py-2 text-center tabular-nums text-xs hidden md:table-cell">{fmt(i.subtotal)}</td>
                      <td className="px-3 py-2 text-center tabular-nums text-xs hidden md:table-cell">{fmt(i.vatAmount)}</td>
                      <td className="px-3 py-2 text-center tabular-nums font-bold">{fmt(i.totalAmount)}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] border ${PAYMENT_TONE[i.paymentType] ?? ""}`}>
                          {tr(`payment.${i.paymentType}`)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] border ${STATUS_TONE[i.status] ?? ""}`}>
                          {tr(`status.${i.status}`)}
                        </span>
                      </td>
                    </tr>
                  ))}
            </tbody>
            {!isLoading && invoices.length > 0 && summary && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td colSpan={5} className="px-3 py-2 text-xs font-bold">{tr("footerLabel")}</td>
                  <td className="px-3 py-2 text-center tabular-nums font-bold hidden md:table-cell">{fmt(summary.subtotal)}</td>
                  <td className="px-3 py-2 text-center tabular-nums font-bold hidden md:table-cell">{fmt(summary.vatAmount)}</td>
                  <td className="px-3 py-2 text-center tabular-nums font-bold text-blue-700">{fmt(summary.totalAmount)}</td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
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

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-lg font-bold tabular-nums mt-0.5">{value}</p>
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

function RankList({ rows }: { rows: Array<{ rank: number; name: string; hint?: string; value: string }> }) {
  return (
    <div className="space-y-1.5">
      {rows.map(r => (
        <div key={r.rank} className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-muted/30">
          <span className="w-6 h-6 inline-flex items-center justify-center rounded-full bg-primary/10 text-primary text-[11px] font-bold tabular-nums">
            {r.rank}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{r.name}</p>
            {r.hint && <p className="text-[10px] text-muted-foreground">{r.hint}</p>}
          </div>
          <span className="text-sm font-bold tabular-nums">{r.value}</span>
        </div>
      ))}
    </div>
  );
}
