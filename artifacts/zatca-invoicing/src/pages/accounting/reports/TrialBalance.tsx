import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { useFormatters } from "@/lib/format";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import CostCenterFilter from "@/components/CostCenterFilter";
import AdvancedReportGrid, { type GridColumn } from "@/components/auditGrid/AdvancedReportGrid";
import {
  Scale, Search, Printer, Eye, ExternalLink, Loader2, AlertCircle, FileText,
  Columns3, RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DateField } from "@/components/ui/date-field";

// ─── Column visibility model ───────────────────────────────────────────
type ColKey = "type" | "openDr" | "openCr" | "periodDr" | "periodCr" | "closeDr" | "closeCr";
const COL_DEFAULTS: Record<ColKey, boolean> = {
  type: true, openDr: true, openCr: true,
  periodDr: true, periodCr: true, closeDr: true, closeCr: true,
};
const COL_STORAGE_KEY = "trial-balance:visible-cols:v1";

// Map a journal-entry row coming back from /account-statement to the URL of
// the document that produced it.
function sourceLinkFor(row: any): string | null {
  if (row.entryType === "sales_invoice" && row.salesInvoiceId)       return `/sales/invoices/${row.salesInvoiceId}`;
  if (row.entryType === "purchase_invoice" && row.purchaseInvoiceId) return `/purchasing/invoices/${row.purchaseInvoiceId}`;
  if (row.entryId) return `/accounting/journals/${row.entryId}`;
  return null;
}

const ENTRY_TYPE_LABELS: Record<string, { ar: string; color: string }> = {
  sales_invoice:    { ar: "فاتورة بيع",    color: "bg-emerald-100 text-emerald-700" },
  purchase_invoice: { ar: "فاتورة شراء",   color: "bg-blue-100 text-blue-700" },
  sales_return:     { ar: "مرتجع بيع",     color: "bg-amber-100 text-amber-700" },
  purchase_return:  { ar: "مرتجع شراء",    color: "bg-amber-100 text-amber-700" },
  payment_voucher:  { ar: "سند صرف",       color: "bg-rose-100 text-rose-700" },
  receipt_voucher:  { ar: "سند قبض",       color: "bg-emerald-100 text-emerald-700" },
  general:          { ar: "قيد يدوي",      color: "bg-slate-100 text-slate-700" },
  payroll:          { ar: "رواتب",          color: "bg-violet-100 text-violet-700" },
  pos_session:      { ar: "نقطة بيع",      color: "bg-emerald-100 text-emerald-700" },
  production_issue: { ar: "إصدار إنتاج",    color: "bg-blue-100 text-blue-700" },
  production_receipt: { ar: "استلام إنتاج", color: "bg-blue-100 text-blue-700" },
};

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function TrialBalance() {
  const { user, token } = useAuth() as any;
  const { t } = useTranslation();
  const { fmt: fmtRaw, isRtl } = useFormatters();
  const { toast } = useToast();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}` };

  // ── Column visibility (Excel-style show/hide) ─────────────────────────
  // Persisted in localStorage so user's column layout survives reloads.
  const [visibleCols, setVisibleCols] = useState<Record<ColKey, boolean>>(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(COL_STORAGE_KEY) : null;
      if (raw) return { ...COL_DEFAULTS, ...JSON.parse(raw) };
    } catch { /* ignore corrupt storage */ }
    return COL_DEFAULTS;
  });
  useEffect(() => {
    try { window.localStorage.setItem(COL_STORAGE_KEY, JSON.stringify(visibleCols)); } catch { /* noop */ }
  }, [visibleCols]);
  const toggleCol = (k: ColKey) => setVisibleCols(prev => ({ ...prev, [k]: !prev[k] }));
  const resetCols = () => setVisibleCols(COL_DEFAULTS);
  const hiddenCount = (Object.keys(COL_DEFAULTS) as ColKey[]).filter(k => !visibleCols[k]).length;

  // Group visibility — gutters & group header collapse when both sides off
  const showOpening = visibleCols.openDr  || visibleCols.openCr;
  const showPeriod  = visibleCols.periodDr || visibleCols.periodCr;
  const showClosing = visibleCols.closeDr  || visibleCols.closeCr;

  // Hide a column from the table header via double-click (Excel-style)
  const hideCol = (k: ColKey, label: string) => {
    setVisibleCols(prev => ({ ...prev, [k]: false }));
    toast({
      title: `تم إخفاء العمود: ${label}`,
      description: "يمكنك إعادة إظهار الأعمدة من زر «الأعمدة».",
    });
  };

  const fmt    = (n: number) => n === 0 ? "" : fmtRaw(n);
  const fmtAbs = (n: number) => fmtRaw(Math.abs(n));

  const TYPE_LABELS: Record<string, string> = {
    asset: t("accountingReports.typeAsset"),
    liability: t("accountingReports.typeLiability"),
    equity: t("accountingReports.typeEquity"),
    revenue: t("accountingReports.typeRevenue"),
    expense: t("accountingReports.typeExpense"),
  };

  // Export columns mirror the on-screen visibility so Excel/PDF reflect
  // exactly what the user sees.
  const ALL_EXPORT_COLS = [
    { key: "code",        header: t("accountingReports.code"),       width: 12, colKey: null as ColKey | null },
    { key: "nameAr",      header: t("accountingReports.accountName"), width: 36, colKey: null },
    { key: "accountType", header: t("accountingReports.type"),        width: 14, colKey: "type" as ColKey },
    { key: "openDebit",   header: `${t("trialBalance.openingBalance")} - ${t("accountingReports.debit")}`, width: 16, colKey: "openDr" as ColKey },
    { key: "openCredit",  header: `${t("trialBalance.openingBalance")} - ${t("accountingReports.credit")}`, width: 16, colKey: "openCr" as ColKey },
    { key: "totalDebit",  header: `${t("trialBalance.periodBalance")} - ${t("accountingReports.debit")}`, width: 16, colKey: "periodDr" as ColKey },
    { key: "totalCredit", header: `${t("trialBalance.periodBalance")} - ${t("accountingReports.credit")}`, width: 16, colKey: "periodCr" as ColKey },
    { key: "closeDebit",  header: `${t("trialBalance.closingBalance")} - ${t("accountingReports.debit")}`, width: 16, colKey: "closeDr" as ColKey },
    { key: "closeCredit", header: `${t("trialBalance.closingBalance")} - ${t("accountingReports.credit")}`, width: 16, colKey: "closeCr" as ColKey },
  ];
  const EXPORT_COLS = ALL_EXPORT_COLS
    .filter(c => c.colKey === null || visibleCols[c.colKey])
    .map(({ key, header, width }) => ({ key, header, width }));

  // Labels for the column popover + double-click toast
  const COL_LABELS: Record<ColKey, string> = {
    type:     t("accountingReports.type"),
    openDr:   `${t("trialBalance.openingBalance")} – ${t("accountingReports.debit")}`,
    openCr:   `${t("trialBalance.openingBalance")} – ${t("accountingReports.credit")}`,
    periodDr: `${t("trialBalance.periodBalance")} – ${t("accountingReports.debit")}`,
    periodCr: `${t("trialBalance.periodBalance")} – ${t("accountingReports.credit")}`,
    closeDr:  `${t("trialBalance.closingBalance")} – ${t("accountingReports.debit")}`,
    closeCr:  `${t("trialBalance.closingBalance")} – ${t("accountingReports.credit")}`,
  };

  const today = new Date().toISOString().slice(0, 10);
  const firstOfYear = today.slice(0, 4) + "-01-01";

  const [fromDate, setFromDate] = useState(firstOfYear);
  const [toDate, setToDate]     = useState(today);
  const [branchId, setBranchId] = useState<number | undefined>(undefined);
  const [costCenterIds, setCostCenterIds] = useState<number[]>([]);
  const [searched, setSearched] = useState(false);
  const [drillRow, setDrillRow] = useState<any | null>(null);

  // Stable serialised key (sorted) so identical multi-selections in any
  // order reuse the same React-Query cache entry. Mirrors the Income
  // Statement / Account Statement convention.
  const ccCsv = costCenterIds.length ? [...costCenterIds].sort((a, b) => a - b).join(",") : "";

  const { data: rows = [], isLoading, refetch } = useQuery<any[]>({
    queryKey: ["trial-balance", cid, fromDate, toDate, branchId, ccCsv],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cid)     params.set("companyId", String(cid));
      if (fromDate) params.set("fromDate", fromDate);
      if (toDate)   params.set("toDate", toDate);
      if (branchId !== undefined) params.set("branchId", String(branchId));
      if (ccCsv)    params.set("costCenterId", ccCsv);
      const res = await fetch(`${API}/api/accounting-reports/trial-balance?${params}`, { headers });
      return res.json();
    },
    enabled: searched,
    // Show any account that had movement OR carried an opening/closing
    // balance — pure-zero rows are hidden so the report stays compact.
    select: (data) => data.filter((r: any) =>
      r.totalDebit > 0 || r.totalCredit > 0 ||
      (r.openingBalance ?? 0) !== 0 || (r.closingBalance ?? 0) !== 0
    ),
  });

  // Period movement totals (must match: ΣDr === ΣCr for a balanced book)
  const totalDr  = rows.reduce((s, r) => s + (r.totalDebit  || 0), 0);
  const totalCr  = rows.reduce((s, r) => s + (r.totalCredit || 0), 0);
  // Opening + closing balance totals (sum of positive vs negative sides)
  const openDrTot  = rows.reduce((s, r) => s + Math.max(0,  r.openingBalance ?? 0), 0);
  const openCrTot  = rows.reduce((s, r) => s + Math.max(0, -(r.openingBalance ?? 0)), 0);
  const closeDrTot = rows.reduce((s, r) => s + Math.max(0,  r.closingBalance ?? 0), 0);
  const closeCrTot = rows.reduce((s, r) => s + Math.max(0, -(r.closingBalance ?? 0)), 0);

  const exportRows = rows.map((r: any) => ({
    code:        r.code,
    nameAr:      isRtl ? r.nameAr : (r.nameEn || r.nameAr),
    accountType: TYPE_LABELS[r.accountType] ?? r.accountType,
    openDebit:   (r.openingBalance ?? 0) > 0 ? fmtAbs(r.openingBalance) : "",
    openCredit:  (r.openingBalance ?? 0) < 0 ? fmtAbs(r.openingBalance) : "",
    totalDebit:  r.totalDebit  > 0 ? fmtAbs(r.totalDebit)  : "",
    totalCredit: r.totalCredit > 0 ? fmtAbs(r.totalCredit) : "",
    closeDebit:  (r.closingBalance ?? 0) > 0 ? fmtAbs(r.closingBalance) : "",
    closeCredit: (r.closingBalance ?? 0) < 0 ? fmtAbs(r.closingBalance) : "",
  }));

  // ── Flat columns for the advanced grid (on-screen view) ───────────────
  // The grid carries the same feature set as the Account Statement: a
  // global search box that scans every column (so the account CODE and
  // NAME are both searchable), per-column AND/OR filters, 3-state sort,
  // drag-reorder, optional grouping with subtotals, conditional
  // formatting, header/footer color themes, and pagination — all
  // persisted per-tenant under the "trialBalanceGrid" slug. Column
  // visibility honours the same «الأعمدة» popover that drives export +
  // print, so the three stay perfectly in sync.
  const TYPE_TONE: Record<string, string> = {
    asset:     "border-sky-200 bg-sky-50 text-sky-700",
    liability: "border-amber-200 bg-amber-50 text-amber-700",
    equity:    "border-violet-200 bg-violet-50 text-violet-700",
    revenue:   "border-emerald-200 bg-emerald-50 text-emerald-700",
    expense:   "border-rose-200 bg-rose-50 text-rose-700",
  };
  const numCol = (
    key: string, label: string, get: (r: any) => number, tone: "dr" | "cr",
  ): GridColumn<any> => ({
    key, label, type: "num", align: "end", totalable: true,
    className: "font-mono tabular-nums",
    value: (r) => get(r),
    render: (r) => {
      const v = get(r);
      if (!(v > 0)) return <span className="text-muted-foreground/40">—</span>;
      return (
        <button
          type="button"
          onClick={() => setDrillRow(r)}
          title="اعرض حركات هذا الحساب خلال الفترة"
          className={cn(
            "font-mono hover:underline decoration-dotted underline-offset-4 focus:outline-none focus:ring-2 focus:ring-primary/40 rounded transition-colors",
            tone === "dr" ? "text-blue-700 hover:text-blue-900" : "text-rose-700 hover:text-rose-900",
          )}
        >
          {fmtAbs(v)}
        </button>
      );
    },
  });
  const gridColumns: GridColumn<any>[] = [
    { key: "code", label: t("accountingReports.code"), type: "text",
      className: "font-mono text-xs",
      value: (r) => r.code,
      render: (r) => (
        <button
          type="button"
          onClick={() => setDrillRow(r)}
          className="inline-flex items-center gap-1.5 text-primary font-mono hover:underline focus:outline-none focus:ring-2 focus:ring-primary/40 rounded"
          title="اعرض حركات هذا الحساب خلال الفترة"
        >
          {r.code}
          <Eye className="h-3 w-3 opacity-40" />
        </button>
      ),
    },
    { key: "name", label: t("accountingReports.accountName"), type: "text",
      value: (r) => isRtl ? r.nameAr : (r.nameEn || r.nameAr),
      render: (r) => (
        <button
          type="button"
          onClick={() => setDrillRow(r)}
          className="text-start hover:text-primary hover:underline decoration-dotted underline-offset-4"
        >
          {isRtl ? r.nameAr : (r.nameEn || r.nameAr)}
        </button>
      ),
    },
    ...(visibleCols.type ? [{
      key: "type", label: t("accountingReports.type"), type: "text" as const,
      value: (r: any) => TYPE_LABELS[r.accountType] ?? r.accountType,
      render: (r: any) => (
        <span className={cn(
          "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
          TYPE_TONE[r.accountType] ?? "border-slate-200 bg-slate-50 text-slate-700",
        )}>
          {TYPE_LABELS[r.accountType] ?? r.accountType}
        </span>
      ),
    }] : []),
    ...(visibleCols.openDr   ? [numCol("openDr",   COL_LABELS.openDr,   (r) => Math.max(0,  r.openingBalance ?? 0), "dr")] : []),
    ...(visibleCols.openCr   ? [numCol("openCr",   COL_LABELS.openCr,   (r) => Math.max(0, -(r.openingBalance ?? 0)), "cr")] : []),
    ...(visibleCols.periodDr ? [numCol("periodDr", COL_LABELS.periodDr, (r) => r.totalDebit  ?? 0, "dr")] : []),
    ...(visibleCols.periodCr ? [numCol("periodCr", COL_LABELS.periodCr, (r) => r.totalCredit ?? 0, "cr")] : []),
    ...(visibleCols.closeDr  ? [numCol("closeDr",  COL_LABELS.closeDr,  (r) => Math.max(0,  r.closingBalance ?? 0), "dr")] : []),
    ...(visibleCols.closeCr  ? [numCol("closeCr",  COL_LABELS.closeCr,  (r) => Math.max(0, -(r.closingBalance ?? 0)), "cr")] : []),
  ];

  const gridTotalsRow = rows.length > 0 ? {
    __label: <span>{t("accountingReports.total")}</span>,
    ...(visibleCols.openDr   ? { openDr:   <span className="font-mono text-blue-700">{fmtAbs(openDrTot)}</span> } : {}),
    ...(visibleCols.openCr   ? { openCr:   <span className="font-mono text-rose-700">{fmtAbs(openCrTot)}</span> } : {}),
    ...(visibleCols.periodDr ? { periodDr: <span className="font-mono text-blue-700">{fmtAbs(totalDr)}</span> } : {}),
    ...(visibleCols.periodCr ? { periodCr: <span className="font-mono text-rose-700">{fmtAbs(totalCr)}</span> } : {}),
    ...(visibleCols.closeDr  ? { closeDr:  <span className="font-mono text-blue-700">{fmtAbs(closeDrTot)}</span> } : {}),
    ...(visibleCols.closeCr  ? { closeCr:  <span className="font-mono text-rose-700">{fmtAbs(closeCrTot)}</span> } : {}),
  } : null;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Scale className="h-6 w-6 text-primary" />
            {t("trialBalance.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("trialBalance.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          {rows.length > 0 && (
            <>
              {/* Excel-style column visibility manager */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-2 relative no-print">
                    <Columns3 className="h-4 w-4" />
                    الأعمدة
                    {hiddenCount > 0 && (
                      <span className="absolute -top-1 -end-1 h-4 min-w-4 px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center">
                        {hiddenCount}
                      </span>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 p-0">
                  <div className="px-3 py-2.5 border-b flex items-center justify-between bg-muted/40">
                    <p className="text-xs font-semibold">إظهار/إخفاء الأعمدة</p>
                    <button
                      type="button"
                      className="text-[11px] text-primary hover:underline inline-flex items-center gap-1"
                      onClick={resetCols}
                    >
                      <RotateCcw className="h-3 w-3" /> إعادة تعيين
                    </button>
                  </div>
                  <div className="p-2 max-h-72 overflow-y-auto space-y-0.5">
                    <ColCheckRow label={COL_LABELS.type}     checked={visibleCols.type}     onToggle={() => toggleCol("type")} dot="slate" />
                    <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wide text-amber-700 font-semibold">{t("trialBalance.openingBalance")}</div>
                    <ColCheckRow label={COL_LABELS.openDr}   checked={visibleCols.openDr}   onToggle={() => toggleCol("openDr")}   dot="blue" />
                    <ColCheckRow label={COL_LABELS.openCr}   checked={visibleCols.openCr}   onToggle={() => toggleCol("openCr")}   dot="rose" />
                    <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wide text-slate-700 font-semibold">{t("trialBalance.periodBalance")}</div>
                    <ColCheckRow label={COL_LABELS.periodDr} checked={visibleCols.periodDr} onToggle={() => toggleCol("periodDr")} dot="blue" />
                    <ColCheckRow label={COL_LABELS.periodCr} checked={visibleCols.periodCr} onToggle={() => toggleCol("periodCr")} dot="rose" />
                    <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wide text-emerald-700 font-semibold">{t("trialBalance.closingBalance")}</div>
                    <ColCheckRow label={COL_LABELS.closeDr}  checked={visibleCols.closeDr}  onToggle={() => toggleCol("closeDr")}  dot="blue" />
                    <ColCheckRow label={COL_LABELS.closeCr}  checked={visibleCols.closeCr}  onToggle={() => toggleCol("closeCr")}  dot="rose" />
                  </div>
                  <div className="px-3 py-2 text-[10px] text-muted-foreground border-t bg-muted/20 leading-relaxed">
                    💡 نصيحة: استخدم زر «الأعمدة» لإظهار أو إخفاء أي عمود. يمكنك كذلك البحث والترتيب والتجميع والتنسيق الشرطي من شريط أدوات الجدول.
                  </div>
                </PopoverContent>
              </Popover>
              <ExportButtons rows={exportRows} columns={EXPORT_COLS}
                filename={`${t("trialBalance.filename_prefix")}-${fromDate}-${toDate}`}
                title={t("trialBalance.title_with", { from: fromDate, to: toDate })} />
              <Button variant="outline" size="sm" className="gap-2" onClick={() => window.print()}>
                <Printer className="h-4 w-4" />{t("accountingReports.print")}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 items-end">
          <div className="space-y-1.5">
            <Label>{t("accountingReports.fromDate")}</Label>
            <DateField value={fromDate} onChange={e => setFromDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("accountingReports.toDate")}</Label>
            <DateField value={toDate} onChange={e => setToDate(e.target.value)} />
          </div>
          <BranchFilter value={branchId} onChange={setBranchId} />
          <CostCenterFilter value={costCenterIds} onChange={setCostCenterIds} />
          <Button className="gap-2" onClick={() => { setSearched(true); refetch(); }} disabled={isLoading}>
            <Search className="h-4 w-4" />
            {isLoading ? t("accountingReports.loading") : t("accountingReports.show_trial_balance")}
          </Button>
        </div>
      </div>

      {searched && !isLoading && rows.length === 0 && (
        <div className="rounded-xl border bg-card p-12 text-center text-muted-foreground">
          {t("accountingReports.noEntriesInPeriod")}
        </div>
      )}

      {rows.length > 0 && (
        <>
          {/* Balance indicator */}
          <div className={cn(
            "rounded-xl border flex items-center justify-between px-5 py-2.5 text-sm font-semibold shadow-sm",
            Math.abs(totalDr - totalCr) < 0.01 ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200"
          )}>
            <span>{t("trialBalance.balanceCheck")}</span>
            <span>
              {Math.abs(totalDr - totalCr) < 0.01
                ? t("trialBalance.balanced")
                : t("trialBalance.diff", { diff: fmtAbs(totalDr - totalCr) })}
            </span>
          </div>

          {/* ── Interactive advanced grid (screen only) — same red-box
              feature set as the Account Statement. Global search covers
              the account CODE and NAME; drill-down opens on the code/name
              cell. A static grouped table is kept below for print/PDF. */}
          <div className="print:hidden">
            <AdvancedReportGrid
              slug="trialBalanceGrid"
              cid={cid}
              rowKey={(r: any) => r.id}
              rows={rows}
              unitLabel="حساب"
              emptyMessage={t("accountingReports.noEntriesInPeriod") as string}
              columns={gridColumns}
              totalsRow={gridTotalsRow}
            />
          </div>

          {/* ── Classic printable grouped table (print/PDF only) ───────── */}
          <div className="hidden print:block rounded-xl border bg-card overflow-hidden shadow-sm">

          {/* ── Group separators ──
              Three balance groups are visually distinguished by:
              1. A colored top border on the group header (amber / slate / emerald)
              2. A subtle tinted background that runs continuously through
                 the body rows, footer, and both DR/CR sub-columns of the group
              3. A 3px colored vertical "gutter" column (`<td className="w-1 ...">`)
                 on each side of the group — replaces the harsh red borders
                 the user complained about and gives a soft, consistent gap
              The DR sub-column reads left→right blue; the CR reads rose. */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-separate border-spacing-0">
              <thead>
                <tr className="bg-muted/50">
                  <th className="text-start px-4 py-3 font-semibold text-muted-foreground border-b">{t("accountingReports.code")}</th>
                  <th className="text-start px-4 py-3 font-semibold text-muted-foreground border-b">{t("accountingReports.accountName")}</th>
                  {visibleCols.type && (
                    <th
                      className="text-start px-4 py-3 font-semibold text-muted-foreground border-b cursor-pointer select-none hover:bg-muted/80 transition-colors"
                      title="انقر مزدوجًا لإخفاء العمود"
                      onDoubleClick={() => hideCol("type", COL_LABELS.type)}
                    >{t("accountingReports.type")}</th>
                  )}

                  {/* opening group */}
                  {showOpening && (
                    <>
                      <th className="w-1 p-0 bg-gradient-to-b from-amber-200 to-amber-400 border-b border-amber-300" />
                      <th
                        className="text-center px-2 py-3 font-semibold text-amber-700 bg-amber-50 border-b-2 border-amber-300"
                        colSpan={(visibleCols.openDr ? 1 : 0) + (visibleCols.openCr ? 1 : 0)}
                      >
                        {t("trialBalance.openingBalance")}
                      </th>
                    </>
                  )}
                  {(showOpening || showPeriod) && (
                    <th className="w-1 p-0 bg-gradient-to-b from-amber-300 to-slate-300 border-b border-slate-300" />
                  )}

                  {showPeriod && (
                    <th
                      className="text-center px-2 py-3 font-semibold text-slate-700 bg-slate-50 border-b-2 border-slate-300"
                      colSpan={(visibleCols.periodDr ? 1 : 0) + (visibleCols.periodCr ? 1 : 0)}
                    >
                      {t("trialBalance.periodBalance")}
                    </th>
                  )}

                  {(showPeriod || showClosing) && (
                    <th className="w-1 p-0 bg-gradient-to-b from-slate-300 to-emerald-300 border-b border-emerald-300" />
                  )}
                  {showClosing && (
                    <>
                      <th
                        className="text-center px-2 py-3 font-semibold text-emerald-700 bg-emerald-50 border-b-2 border-emerald-300"
                        colSpan={(visibleCols.closeDr ? 1 : 0) + (visibleCols.closeCr ? 1 : 0)}
                      >
                        {t("trialBalance.closingBalance")}
                      </th>
                      <th className="w-1 p-0 bg-gradient-to-b from-emerald-400 to-emerald-200 border-b border-emerald-300" />
                    </>
                  )}
                </tr>
                <tr className="bg-muted/30 text-xs">
                  <th colSpan={2 + (visibleCols.type ? 1 : 0)} className="border-b" />

                  {showOpening && <th className="w-1 p-0 bg-amber-100 border-b" />}
                  {visibleCols.openDr && (
                    <th
                      className="text-end px-4 py-2 font-semibold text-blue-700 bg-amber-50/60 border-b cursor-pointer select-none hover:bg-amber-100 transition-colors"
                      title="انقر مزدوجًا لإخفاء العمود"
                      onDoubleClick={() => hideCol("openDr", COL_LABELS.openDr)}
                    >{t("accountingReports.debit")}</th>
                  )}
                  {visibleCols.openCr && (
                    <th
                      className="text-end px-4 py-2 font-semibold text-rose-700 bg-amber-50/60 border-b cursor-pointer select-none hover:bg-amber-100 transition-colors"
                      title="انقر مزدوجًا لإخفاء العمود"
                      onDoubleClick={() => hideCol("openCr", COL_LABELS.openCr)}
                    >{t("accountingReports.credit")}</th>
                  )}
                  {(showOpening || showPeriod) && <th className="w-1 p-0 bg-slate-100 border-b" />}

                  {visibleCols.periodDr && (
                    <th
                      className="text-end px-4 py-2 font-semibold text-blue-700 bg-slate-50/60 border-b cursor-pointer select-none hover:bg-slate-100 transition-colors"
                      title="انقر مزدوجًا لإخفاء العمود"
                      onDoubleClick={() => hideCol("periodDr", COL_LABELS.periodDr)}
                    >{t("accountingReports.debit")}</th>
                  )}
                  {visibleCols.periodCr && (
                    <th
                      className="text-end px-4 py-2 font-semibold text-rose-700 bg-slate-50/60 border-b cursor-pointer select-none hover:bg-slate-100 transition-colors"
                      title="انقر مزدوجًا لإخفاء العمود"
                      onDoubleClick={() => hideCol("periodCr", COL_LABELS.periodCr)}
                    >{t("accountingReports.credit")}</th>
                  )}

                  {(showPeriod || showClosing) && <th className="w-1 p-0 bg-emerald-100 border-b" />}
                  {visibleCols.closeDr && (
                    <th
                      className="text-end px-4 py-2 font-semibold text-blue-700 bg-emerald-50/60 border-b cursor-pointer select-none hover:bg-emerald-100 transition-colors"
                      title="انقر مزدوجًا لإخفاء العمود"
                      onDoubleClick={() => hideCol("closeDr", COL_LABELS.closeDr)}
                    >{t("accountingReports.debit")}</th>
                  )}
                  {visibleCols.closeCr && (
                    <th
                      className="text-end px-4 py-2 font-semibold text-rose-700 bg-emerald-50/60 border-b cursor-pointer select-none hover:bg-emerald-100 transition-colors"
                      title="انقر مزدوجًا لإخفاء العمود"
                      onDoubleClick={() => hideCol("closeCr", COL_LABELS.closeCr)}
                    >{t("accountingReports.credit")}</th>
                  )}
                  {showClosing && <th className="w-1 p-0 bg-emerald-100 border-b" />}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const op = r.openingBalance ?? 0;
                  const cl = r.closingBalance ?? 0;
                  return (
                    <tr
                      key={r.id}
                      className="hover:bg-primary/5 transition-colors group cursor-pointer"
                      onClick={() => setDrillRow(r)}
                      title="اعرض حركات هذا الحساب خلال الفترة"
                    >
                      <td className="px-4 py-2.5 font-mono text-xs text-primary border-b">
                        <span className="inline-flex items-center gap-1.5">
                          {r.code}
                          <Eye className="h-3 w-3 text-primary/30 group-hover:text-primary transition-colors no-print" />
                        </span>
                      </td>
                      <td className="px-4 py-2.5 border-b group-hover:text-primary group-hover:underline decoration-dotted underline-offset-4">
                        {isRtl ? r.nameAr : (r.nameEn || r.nameAr)}
                      </td>
                      {visibleCols.type && (
                        <td className="px-4 py-2.5 text-muted-foreground text-xs border-b">{TYPE_LABELS[r.accountType] ?? r.accountType}</td>
                      )}

                      {showOpening && <td className="w-1 p-0 bg-amber-200/70 border-b border-amber-200 group-hover:bg-amber-300" />}
                      {visibleCols.openDr && <td className="px-4 py-2.5 text-end font-mono text-blue-700 bg-amber-50/40 border-b">{op > 0 ? fmt(op) : ""}</td>}
                      {visibleCols.openCr && <td className="px-4 py-2.5 text-end font-mono text-rose-700 bg-amber-50/40 border-b">{op < 0 ? fmt(-op) : ""}</td>}
                      {(showOpening || showPeriod) && <td className="w-1 p-0 bg-slate-200/70 border-b border-slate-200 group-hover:bg-slate-300" />}

                      {visibleCols.periodDr && <td className="px-4 py-2.5 text-end font-mono text-blue-700 bg-slate-50/40 border-b">{fmt(r.totalDebit)}</td>}
                      {visibleCols.periodCr && <td className="px-4 py-2.5 text-end font-mono text-rose-700 bg-slate-50/40 border-b">{fmt(r.totalCredit)}</td>}

                      {(showPeriod || showClosing) && <td className="w-1 p-0 bg-emerald-200/70 border-b border-emerald-200 group-hover:bg-emerald-300" />}
                      {visibleCols.closeDr && <td className="px-4 py-2.5 text-end font-mono text-blue-700 bg-emerald-50/40 border-b">{cl > 0 ? fmt(cl) : ""}</td>}
                      {visibleCols.closeCr && <td className="px-4 py-2.5 text-end font-mono text-rose-700 bg-emerald-50/40 border-b">{cl < 0 ? fmt(-cl) : ""}</td>}
                      {showClosing && <td className="w-1 p-0 bg-emerald-200/70 border-b border-emerald-200 group-hover:bg-emerald-300" />}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-muted/60 font-bold text-sm">
                  <td colSpan={2 + (visibleCols.type ? 1 : 0)} className="px-4 py-3 border-t-2 border-slate-400">{t("accountingReports.total")}</td>

                  {showOpening && <td className="w-1 p-0 bg-gradient-to-t from-amber-300 to-amber-400 border-t-2 border-amber-400" />}
                  {visibleCols.openDr && <td className="px-4 py-3 text-end font-mono text-blue-700 bg-amber-100/70 border-t-2 border-amber-400">{fmtAbs(openDrTot)}</td>}
                  {visibleCols.openCr && <td className="px-4 py-3 text-end font-mono text-rose-700 bg-amber-100/70 border-t-2 border-amber-400">{fmtAbs(openCrTot)}</td>}
                  {(showOpening || showPeriod) && <td className="w-1 p-0 bg-gradient-to-t from-amber-300 via-slate-300 to-slate-400 border-t-2 border-slate-400" />}

                  {visibleCols.periodDr && <td className="px-4 py-3 text-end font-mono text-blue-700 bg-slate-100/70 border-t-2 border-slate-400">{fmtAbs(totalDr)}</td>}
                  {visibleCols.periodCr && <td className="px-4 py-3 text-end font-mono text-rose-700 bg-slate-100/70 border-t-2 border-slate-400">{fmtAbs(totalCr)}</td>}

                  {(showPeriod || showClosing) && <td className="w-1 p-0 bg-gradient-to-t from-slate-300 via-emerald-300 to-emerald-400 border-t-2 border-emerald-400" />}
                  {visibleCols.closeDr && <td className="px-4 py-3 text-end font-mono text-blue-700 bg-emerald-100/70 border-t-2 border-emerald-400">{fmtAbs(closeDrTot)}</td>}
                  {visibleCols.closeCr && <td className="px-4 py-3 text-end font-mono text-rose-700 bg-emerald-100/70 border-t-2 border-emerald-400">{fmtAbs(closeCrTot)}</td>}
                  {showClosing && <td className="w-1 p-0 bg-gradient-to-t from-emerald-300 to-emerald-400 border-t-2 border-emerald-400" />}
                </tr>
              </tfoot>
            </table>
          </div>
          </div>
        </>
      )}

      {/* ── DRILL-DOWN MODAL ─────────────────────────────────────────────── */}
      <AccountLedgerDialog
        open={!!drillRow}
        onOpenChange={(v) => { if (!v) setDrillRow(null); }}
        account={drillRow}
        fromDate={fromDate}
        toDate={toDate}
        branchId={branchId}
        token={token}
        cid={cid}
        isRtl={isRtl}
        fmtRaw={fmtRaw}
      />
    </div>
  );
}

// ─── Column-visibility checkbox row used in the «الأعمدة» popover ───────
function ColCheckRow({
  label, checked, onToggle, dot,
}: { label: string; checked: boolean; onToggle: () => void; dot: "blue" | "rose" | "slate" }) {
  const dotClass = dot === "blue"  ? "bg-blue-500"
                 : dot === "rose"  ? "bg-rose-500"
                 :                    "bg-slate-400";
  return (
    <label className="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-muted/60 cursor-pointer text-sm">
      <Checkbox checked={checked} onCheckedChange={onToggle} />
      <span className={cn("inline-block w-1.5 h-1.5 rounded-full", dotClass)} />
      <span className="flex-1">{label}</span>
    </label>
  );
}

// ─── Drill-down ledger dialog ────────────────────────────────────────────
interface LedgerRow {
  lineId: number; entryId: number; entryType: string;
  docNumber: string | null; entryDate: string; description: string | null;
  debit: number; credit: number; balance: number;
  salesInvoiceId: number | null; purchaseInvoiceId: number | null;
}
interface LedgerResp {
  previousBalance: number;
  previousDebit: number;
  previousCredit: number;
  rows: LedgerRow[];
}

function AccountLedgerDialog({
  open, onOpenChange, account, fromDate, toDate, branchId, token, cid, isRtl, fmtRaw,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  account: any | null;
  fromDate: string;
  toDate: string;
  branchId: number | undefined;
  token: string | null;
  cid: number | undefined;
  isRtl: boolean;
  fmtRaw: (n: number) => string;
}) {
  const fmt = (n: number) => Number(n || 0) === 0 ? "" : fmtRaw(Number(n));
  const fmtAbs = (n: number) => fmtRaw(Math.abs(Number(n || 0)));

  const { data, isLoading, error } = useQuery<LedgerResp>({
    queryKey: ["trial-balance-drill", cid, account?.id, fromDate, toDate, branchId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cid)       params.set("companyId", String(cid));
      params.set("accountId", String(account.id));
      if (fromDate)  params.set("fromDate", fromDate);
      if (toDate)    params.set("toDate", toDate);
      if (branchId !== undefined) params.set("branchId", String(branchId));
      const r = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/accounting-reports/account-statement?${params}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        credentials: "include",
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? "تعذر جلب الحركات");
      return r.json();
    },
    enabled: !!account && open,
  });

  const ledgerRows = data?.rows ?? [];
  const totalDr = useMemo(() => ledgerRows.reduce((s, r) => s + Number(r.debit  || 0), 0), [ledgerRows]);
  const totalCr = useMemo(() => ledgerRows.reduce((s, r) => s + Number(r.credit || 0), 0), [ledgerRows]);
  const closing = ledgerRows.length > 0 ? ledgerRows[ledgerRows.length - 1].balance : (data?.previousBalance ?? 0);
  const accountName = account ? (isRtl ? account.nameAr : (account.nameEn || account.nameAr)) : "";

  const fullStatementHref = account
    ? `/accounting/reports/account-statement?accountId=${account.id}&fromDate=${fromDate}&toDate=${toDate}${branchId !== undefined ? `&branchId=${branchId}` : ""}`
    : "#";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[88vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <FileText className="h-5 w-5 text-primary" />
            حركات الحساب:
            <span className="font-mono text-sm text-primary">{account?.code}</span>
            <span className="text-primary">{accountName}</span>
          </DialogTitle>
          <DialogDescription className="text-xs flex items-center gap-3">
            <span>من {fromDate} إلى {toDate}</span>
            <span>·</span>
            <span>{ledgerRows.length} حركة</span>
            {account && (
              <>
                <span>·</span>
                <Link
                  href={fullStatementHref}
                  className="text-primary hover:underline inline-flex items-center gap-1 cursor-pointer"
                  onClick={() => onOpenChange(false)}
                >
                  فتح كشف الحساب الكامل <ExternalLink className="h-3 w-3" />
                </Link>
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* KPI strip */}
        {data && (
          <div className="grid grid-cols-4 gap-3 px-1">
            <div className="rounded-lg border bg-amber-50/60 dark:bg-amber-950/20 p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">رصيد ما قبل</p>
              <p className="text-lg font-bold tabular-nums text-amber-700 dark:text-amber-400">
                {fmtAbs(data.previousBalance)} <span className="text-[10px] font-normal">{data.previousBalance >= 0 ? "مدين" : "دائن"}</span>
              </p>
            </div>
            <div className="rounded-lg border bg-blue-50/60 dark:bg-blue-950/20 p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">إجمالي مدين الفترة</p>
              <p className="text-lg font-bold tabular-nums text-blue-700 dark:text-blue-400">{fmtAbs(totalDr)}</p>
            </div>
            <div className="rounded-lg border bg-rose-50/60 dark:bg-rose-950/20 p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">إجمالي دائن الفترة</p>
              <p className="text-lg font-bold tabular-nums text-rose-700 dark:text-rose-400">{fmtAbs(totalCr)}</p>
            </div>
            <div className="rounded-lg border bg-emerald-50/60 dark:bg-emerald-950/20 p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">رصيد الإقفال</p>
              <p className="text-lg font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                {fmtAbs(closing)} <span className="text-[10px] font-normal">{Number(closing) >= 0 ? "مدين" : "دائن"}</span>
              </p>
            </div>
          </div>
        )}

        {/* Ledger list */}
        <div className="flex-1 overflow-y-auto rounded-lg border">
          {isLoading && (
            <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
              <Loader2 className="h-5 w-5 animate-spin" /> جارِ التحميل...
            </div>
          )}
          {error && (
            <div className="flex items-center gap-2 p-4 text-destructive text-sm">
              <AlertCircle className="h-4 w-4" /> {(error as Error).message}
            </div>
          )}
          {!isLoading && !error && ledgerRows.length === 0 && (
            <p className="text-center text-sm text-muted-foreground py-12">
              لا توجد حركات على هذا الحساب خلال الفترة.
            </p>
          )}
          {!isLoading && ledgerRows.length > 0 && (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/80 backdrop-blur z-10">
                <tr className="text-xs text-muted-foreground">
                  <th className="px-3 py-2 text-right font-semibold">النوع</th>
                  <th className="px-3 py-2 text-right font-semibold">رقم المستند</th>
                  <th className="px-3 py-2 text-right font-semibold">التاريخ</th>
                  <th className="px-3 py-2 text-right font-semibold">البيان</th>
                  <th className="px-3 py-2 text-left font-semibold w-24">مدين</th>
                  <th className="px-3 py-2 text-left font-semibold w-24">دائن</th>
                  <th className="px-3 py-2 text-left font-semibold w-28">الرصيد</th>
                  <th className="w-12 px-2 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {data && Math.abs(Number(data.previousBalance)) > 0.005 && (
                  <tr className="border-t border-border/40 bg-amber-50/40 dark:bg-amber-950/10">
                    <td className="px-3 py-2.5" colSpan={3}>
                      <span className="inline-block px-2 py-0.5 rounded text-[11px] font-medium bg-amber-100 text-amber-800">رصيد سابق</span>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground italic">رصيد ما قبل الفترة</td>
                    <td className="px-3 py-2.5 text-left font-mono tabular-nums text-xs text-blue-700">{fmt(data.previousDebit)}</td>
                    <td className="px-3 py-2.5 text-left font-mono tabular-nums text-xs text-rose-700">{fmt(data.previousCredit)}</td>
                    <td className="px-3 py-2.5 text-left font-mono tabular-nums text-xs font-semibold">
                      {fmtAbs(data.previousBalance)} {data.previousBalance >= 0 ? "م" : "د"}
                    </td>
                    <td />
                  </tr>
                )}
                {ledgerRows.map((r) => {
                  const meta = ENTRY_TYPE_LABELS[r.entryType] ?? { ar: r.entryType, color: "bg-gray-100 text-gray-700" };
                  const link = sourceLinkFor(r);
                  return (
                    <tr key={r.lineId} className="border-t border-border/40 hover:bg-muted/30">
                      <td className="px-3 py-2.5">
                        <span className={cn("inline-block px-2 py-0.5 rounded text-[11px] font-medium", meta.color)}>{meta.ar}</span>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs">{r.docNumber ?? `#${r.entryId}`}</td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground tabular-nums">{r.entryDate}</td>
                      <td className="px-3 py-2.5 truncate max-w-[260px]">{r.description ?? <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-3 py-2.5 text-left font-mono tabular-nums text-xs text-blue-700">{fmt(r.debit)}</td>
                      <td className="px-3 py-2.5 text-left font-mono tabular-nums text-xs text-rose-700">{fmt(r.credit)}</td>
                      <td className="px-3 py-2.5 text-left font-mono tabular-nums text-xs font-semibold">
                        {fmtAbs(r.balance)} <span className="text-muted-foreground text-[10px]">{r.balance >= 0 ? "م" : "د"}</span>
                      </td>
                      <td className="px-2 py-2.5 text-center">
                        {link && (
                          <Link
                            href={link}
                            className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-primary/10 text-primary cursor-pointer"
                            title="فتح المستند"
                            onClick={() => onOpenChange(false)}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="sticky bottom-0 bg-slate-100 dark:bg-slate-800/80 backdrop-blur font-bold">
                <tr className="border-t-2 border-slate-400">
                  <td className="px-3 py-2.5" colSpan={4}>الإجمالي</td>
                  <td className="px-3 py-2.5 text-left font-mono tabular-nums text-blue-700">{fmtAbs(totalDr)}</td>
                  <td className="px-3 py-2.5 text-left font-mono tabular-nums text-rose-700">{fmtAbs(totalCr)}</td>
                  <td className="px-3 py-2.5 text-left font-mono tabular-nums">
                    {fmtAbs(closing)} <span className="text-muted-foreground text-[10px] font-normal">{Number(closing) >= 0 ? "م" : "د"}</span>
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
