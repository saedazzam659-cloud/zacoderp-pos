import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useSearch, useLocation } from "wouter";
import { useFormatters } from "@/lib/format";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { SearchCombobox } from "@/components/ui/search-combobox";
import ExportButtons from "@/components/ExportButtons";
import { useFmt } from "@/hooks/use-fmt";
import BranchFilter from "@/components/BranchFilter";
import CostCenterFilter from "@/components/CostCenterFilter";
import AdvancedReportGrid, { type GridColumn } from "@/components/auditGrid/AdvancedReportGrid";
import AccountStatementView from "@/components/AccountStatementView";
import { FileText, Search, Printer, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { DateField } from "@/components/ui/date-field";

// Map a journal-entry row coming back from /account-statement to the URL of
// the document that produced it. Documents with a dedicated detail page
// (invoices, vouchers, production orders) deep-link straight to the row;
// modules whose UI only has a list view (returns, contracting bills, fixed
// assets, payroll, goods receipts/deliveries) link to the list page so the
// user lands inside the right module rather than on the raw JE. Anything we
// don't recognise — manual / opening / closing / depreciation re-runs / …
// — falls back to the journal-entry detail page, which renders cleanly for
// every entry type and is therefore the safe universal target.
/** Map a journal-entry `entryType` to a human-readable Arabic category for
 *  the "نوع الوثيقة" column. Mirrors the customer/supplier-statement
 *  document-source mapping, but extended to cover every entry type that
 *  can appear in the general account ledger (FA, payroll, contracting,
 *  inventory, POS, closing entries, …). Unknown / null types fall back
 *  to "قيد عام" — a safe label for manual JEs created from the journal-
 *  entry form (whose `entryType` is "general"). */
const ENTRY_TYPE_LABEL: Record<string, string> = {
  sales_invoice:             "فاتورة مبيعات",
  sales_return:              "مرتجع مبيعات",
  purchase_invoice:          "فاتورة مشتريات",
  purchase_return:           "مرتجع مشتريات",
  receipt:                   "سند قبض",
  receipt_cash:              "سند قبض نقدي",
  receipt_bank:              "سند قبض بنكي",
  payment:                   "سند صرف",
  payment_cash:              "سند صرف نقدي",
  payment_bank:              "سند صرف بنكي",
  account_note_customer_credit: "إشعار دائن (عميل)",
  account_note_customer_debit:  "إشعار مدين (عميل)",
  account_note_supplier_credit: "إشعار دائن (مورد)",
  account_note_supplier_debit:  "إشعار مدين (مورد)",
  credit_note:               "إشعار دائن",
  debit_note:                "إشعار مدين",
  sister_transfer:           "تحويل لشركة شقيقة",
  sister_transfer_return:    "مرتجع تحويل شركة شقيقة",
  sister_settlement:         "تسوية شركة شقيقة",
  opening:                   "رصيد افتتاحي",
  pos_sale:                  "بيع نقاط بيع",
  pos_return:                "مرتجع نقاط بيع",
  payroll_run:               "مسير رواتب",
  employee_loan:             "سلفة موظف",
  eos_payment:               "تسوية نهاية خدمة",
  fa_acquisition:            "اقتناء أصل ثابت",
  fa_depreciation:           "إهلاك أصول ثابتة",
  fa_disposal:               "استبعاد أصل ثابت",
  contracting_outgoing_bill: "مستخلص صادر",
  contracting_incoming_bill: "مستخلص وارد",
  stock_adjustment:          "تسوية مخزون",
  stock_transfer:            "تحويل مخزون",
  goods_receipt:             "إذن استلام بضاعة",
  goods_delivery:            "إذن تسليم بضاعة",
  trial_balance_adjustment:  "تسوية ميزان المراجعة",
  adjustment_prepaid:        "تسوية مصروف مدفوع مقدماً",
  adjustment_accrued:        "تسوية مصروف مستحق",
  lc_funding:                "تمويل اعتماد مستندي",
  lc_expense_payment:        "دفع مصروف اعتماد",
  production_issue:          "صرف إنتاج",
  production_issue_reversal: "عكس صرف إنتاج",
  production_receipt:        "استلام إنتاج",
  closing_revenue:           "إقفال إيرادات",
  closing_expense:           "إقفال مصروفات",
  closing_transfer_profit:   "ترحيل أرباح",
  closing_transfer_loss:     "ترحيل خسائر",
  general:                   "قيد عام",
  manual:                    "قيد يدوي",
};
function docTypeFor(row: any): string {
  const k = row?.entryType;
  if (!k) return "قيد عام";
  return ENTRY_TYPE_LABEL[k] ?? "قيد عام";
}

/** Soft color theme per category so the on-screen pill is visually
 *  distinguishable at a glance (sales = sky, purchasing = amber,
 *  cash = emerald, FA = violet, payroll = rose, opening/closing = slate). */
function docTypeTone(row: any): { ring: string; bg: string; text: string; code: string } {
  const k = row?.entryType ?? "";
  // Revenue-side documents (sales / POS / outgoing contracting bill) → sky
  if (k.startsWith("sales") || k === "pos_sale" || k === "pos_return" || k === "contracting_outgoing_bill")
    return { ring: "border-sky-200",     bg: "from-sky-50 to-cyan-50",        text: "text-sky-800",     code: "bg-sky-100 text-sky-700" };
  // Cost-side documents (purchases / incoming contracting bill / LC) → amber
  if (k.startsWith("purchase") || k === "contracting_incoming_bill" || k === "lc_funding" || k === "lc_expense_payment")
    return { ring: "border-amber-200",   bg: "from-amber-50 to-orange-50",    text: "text-amber-800",   code: "bg-amber-100 text-amber-700" };
  if (k === "receipt" || k === "payment" || k.startsWith("receipt_") || k.startsWith("payment_"))
    return { ring: "border-emerald-200", bg: "from-emerald-50 to-teal-50",    text: "text-emerald-800", code: "bg-emerald-100 text-emerald-700" };
  // Credit / debit notes (إشعارات دائنة/مدينة) → indigo
  if (k.startsWith("account_note") || k === "credit_note" || k === "debit_note")
    return { ring: "border-indigo-200",  bg: "from-indigo-50 to-blue-50",     text: "text-indigo-800",  code: "bg-indigo-100 text-indigo-700" };
  // Sister-company movements → cyan
  if (k.startsWith("sister_"))
    return { ring: "border-cyan-200",    bg: "from-cyan-50 to-sky-50",        text: "text-cyan-800",    code: "bg-cyan-100 text-cyan-700" };
  if (k.startsWith("fa_"))
    return { ring: "border-violet-200",  bg: "from-violet-50 to-fuchsia-50",  text: "text-violet-800",  code: "bg-violet-100 text-violet-700" };
  if (k === "payroll_run" || k === "employee_loan" || k === "eos_payment")
    return { ring: "border-rose-200",    bg: "from-rose-50 to-pink-50",       text: "text-rose-800",    code: "bg-rose-100 text-rose-700" };
  // Inventory & production movements → teal
  if (k.startsWith("stock_") || k.startsWith("production_") || k === "goods_receipt" || k === "goods_delivery")
    return { ring: "border-teal-200",    bg: "from-teal-50 to-cyan-50",       text: "text-teal-800",    code: "bg-teal-100 text-teal-700" };
  if (k === "opening" || k.startsWith("closing_") || k.startsWith("adjustment_") || k === "trial_balance_adjustment")
    return { ring: "border-slate-300",   bg: "from-slate-50 to-zinc-50",      text: "text-slate-700",   code: "bg-slate-200 text-slate-700" };
  return { ring: "border-slate-200",     bg: "from-slate-50 to-slate-100",    text: "text-slate-700",   code: "bg-slate-100 text-slate-700" };
}

function sourceLinkFor(row: any): string | null {
  switch (row.entryType) {
    // ── detail-page targets ──────────────────────────────────────────────
    case "sales_invoice":
      if (row.salesInvoiceId)    return `/sales/invoices/${row.salesInvoiceId}`;
      break;
    case "purchase_invoice":
      if (row.purchaseInvoiceId) return `/purchasing/invoices/${row.purchaseInvoiceId}`;
      break;
    case "receipt":
      if (row.receiptVoucherId)  return `/cash/receipt-vouchers/${row.receiptVoucherId}`;
      break;
    case "payment":
      if (row.paymentVoucherId)  return `/cash/payment-vouchers/${row.paymentVoucherId}`;
      break;

    // ── list-page targets (no detail screen exists for these modules) ───
    case "sales_return":
      if (row.salesReturnId)             return `/sales/returns`;
      break;
    case "purchase_return":
      if (row.purchaseReturnId)          return `/purchasing/returns`;
      break;
    case "contracting_outgoing_bill":
    case "contracting_incoming_bill":
      if (row.contractingProgressBillId) return `/contracting/bills`;
      break;
    case "fa_acquisition":
      if (row.fixedAssetId)              return `/fixed-assets/assets`;
      break;
    case "fa_depreciation":
      if (row.faDepreciationRunId)       return `/fixed-assets/depreciation`;
      break;
    case "fa_disposal":
      if (row.faDisposalId)              return `/fixed-assets/disposals`;
      break;
    case "payroll_run":
    case "employee_loan":
    case "eos_payment":
      if (row.payrollRunId)              return `/hr/payroll`;
      break;
    case "stock_adjustment":
      if (row.goodsReceiptId)            return `/inventory/goods-receipts`;
      if (row.goodsDeliveryId)           return `/inventory/goods-deliveries`;
      break;
    case "stock_transfer":
      return `/inventory/transfers`;
  }
  if (row.entryId) {
    return `/accounting/journals/${row.entryId}`;
  }
  return null;
}

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function AccountStatement() {
  const { user, token } = useAuth() as any;
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const { dp } = useFmt();
  // Excel number format honouring the company's decimal-places setting so the
  // money columns are written as REAL numbers (summable) yet display nicely.
  const moneyFmt = dp > 0 ? `#,##0.${"0".repeat(dp)}` : "#,##0";
  const { toast } = useToast();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}` };

  const today = new Date().toISOString().slice(0, 10);
  const firstOfMonth = today.slice(0, 8) + "01";

  const [accountId, setAccountId] = useState("");
  const [fromDate, setFromDate]   = useState(firstOfMonth);
  const [toDate, setToDate]       = useState(today);
  const [branchId, setBranchId]   = useState<number | undefined>(undefined);
  // Cost-center scope is now multi-valued so deep-links from the
  // Income Statement (which can carry multiple selected centres as
  // a CSV) preserve the full filter. Single-id deep-links keep working
  // because a single number parses to a one-element array.
  const [costCenterIds, setCostCenterIds] = useState<number[]>([]);
  const ccCsv = costCenterIds.length ? [...costCenterIds].sort((a, b) => a - b).join(",") : "";
  const [searched, setSearched]   = useState(false);
  // Mirrors the customer/supplier-statement toggle: when off, the brought-
  // forward row is hidden and running balances start from zero so the user
  // sees pure period-only movement. Applied to screen, exports, and print.
  const [withOpening, setWithOpening] = useState(true);

  // Deep-link support: when navigated from another report (e.g. trial
  // balance drill-down or Income Statement row click) with
  // ?accountId=&fromDate=&toDate=&branchId=&costCenterId=, pre-fill the
  // form and auto-trigger the search so the statement is shown immediately.
  const searchString = useSearch();
  const [, setLocation] = useLocation();
  useEffect(() => {
    if (!searchString) return;
    const params = new URLSearchParams(searchString);
    const a = params.get("accountId");
    const f = params.get("fromDate");
    const tt = params.get("toDate");
    const b = params.get("branchId");
    const cc = params.get("costCenterId");
    if (a) setAccountId(a);
    if (f) setFromDate(f);
    if (tt) setToDate(tt);
    if (b) setBranchId(Number(b));
    if (cc) {
      // Accept both shapes: "3" (legacy single) and "3,7,12" (multi).
      const ids = cc.split(",").map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
      if (ids.length) setCostCenterIds(ids);
    }
    if (a) setSearched(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchString]);

  // Mirror filter state into the URL once the user has run a search, so
  // navigating away (e.g. clicking a JE link → /accounting/journals/:id)
  // and then hitting browser-back returns to this page WITH the same
  // account/period/branch/cost-centers — the read-from-URL effect above
  // re-hydrates state and the query auto-refires. We use `replace: true`
  // so each filter tweak doesn't pollute browser history; only the JE
  // navigation creates a forward history entry.
  useEffect(() => {
    if (!searched || !accountId) return;
    const next = new URLSearchParams();
    next.set("accountId", accountId);
    if (fromDate) next.set("fromDate", fromDate);
    if (toDate)   next.set("toDate", toDate);
    if (branchId) next.set("branchId", String(branchId));
    if (ccCsv)    next.set("costCenterId", ccCsv);
    const nextStr = next.toString();
    const currentStr = new URLSearchParams(searchString || "").toString();
    if (nextStr !== currentStr) {
      setLocation(`/accounting/reports/account-statement?${nextStr}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searched, accountId, fromDate, toDate, branchId, ccCsv]);

  // Cost-center column is shown only when the user has explicitly
  // picked one or more cost centers in the filter. The default
  // "all" view stays uncluttered (matches the original layout).
  const showCostCenterCol = costCenterIds.length > 0;
  const EXPORT_COLS = [
    { key: "docType",     header: "نوع الوثيقة", width: 20 },
    { key: "entryDate",   header: t("accountingReports.fromDate"), width: 14 },
    { key: "docNumber",   header: t("accountStatement.docNumber"), width: 14 },
    { key: "description", header: t("accountStatement.description"), width: 36 },
    ...(showCostCenterCol
      ? [{ key: "costCenter", header: t("accountingReports.costCenter", { defaultValue: "مركز التكلفة" }), width: 22 }]
      : []),
    { key: "debit",       header: t("accountingReports.debit"), width: 14, numFmt: moneyFmt },
    { key: "credit",      header: t("accountingReports.credit"), width: 14, numFmt: moneyFmt },
    { key: "balance",     header: t("accountingReports.balance"), width: 14, numFmt: moneyFmt },
  ];

  const { data: accounts = [] } = useQuery<any[]>({
    queryKey: ["accounts", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/accounts?companyId=${cid}` : `${API}/api/accounts`;
      const res = await fetch(url, { headers });
      return res.json();
    },
    enabled: !!user,
  });

  type StatementResponse = {
    previousBalance: number;
    previousDebit:   number;
    previousCredit:  number;
    rows: any[];
  };
  const { data, isLoading, refetch } = useQuery<StatementResponse>({
    queryKey: ["account-statement", cid, accountId, fromDate, toDate, branchId, ccCsv],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cid)       params.set("companyId", String(cid));
      if (accountId) params.set("accountId", accountId);
      if (fromDate)  params.set("fromDate", fromDate);
      if (toDate)    params.set("toDate", toDate);
      if (branchId)  params.set("branchId", String(branchId));
      if (ccCsv)     params.set("costCenterId", ccCsv);
      const res = await fetch(`${API}/api/accounting-reports/account-statement?${params}`, { headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      return res.json();
    },
    enabled: searched && !!accountId,
  });

  const rawRows = data?.rows ?? [];
  const apiPreviousBalance = data?.previousBalance ?? 0;
  const apiPreviousDebit   = data?.previousDebit   ?? 0;
  const apiPreviousCredit  = data?.previousCredit  ?? 0;
  // Effective opening values respect the "تضمين الرصيد الافتتاحي" toggle.
  // When OFF, the brought-forward row is hidden AND the running balance per
  // row is recomputed starting from zero (= r.balance − apiPreviousBalance)
  // so the screen, exports, and print all show period-only movement.
  const effectivePreviousBalance = withOpening ? apiPreviousBalance : 0;
  const effectivePreviousDebit   = withOpening ? apiPreviousDebit   : 0;
  const effectivePreviousCredit  = withOpening ? apiPreviousCredit  : 0;
  const rows = useMemo(
    () => withOpening
      ? rawRows
      : rawRows.map((r: any) => ({ ...r, balance: (r.balance ?? 0) - apiPreviousBalance })),
    [rawRows, withOpening, apiPreviousBalance],
  );
  // Backwards-compat aliases (kept so the brought-forward JSX/exports below
  // keep reading the same names without per-site edits).
  const previousBalance = effectivePreviousBalance;
  const previousDebit   = effectivePreviousDebit;
  const previousCredit  = effectivePreviousCredit;
  const selectedAccount = accounts.find((a: any) => String(a.id) === accountId);
  const accountDisplayName = selectedAccount ? (isRtl ? selectedAccount.nameAr : (selectedAccount.nameEn || selectedAccount.nameAr)) : "";
  const totalDebit  = rows.reduce((s: number, r: any) => s + (r.debit  || 0), 0);
  const totalCredit = rows.reduce((s: number, r: any) => s + (r.credit || 0), 0);
  // Closing balance = previous balance + period movements. When there
  // are no in-period rows, fall back to the previous balance itself
  // so the SAP-style brought-forward figure is still reflected.
  const finalBalance = rows.length > 0 ? rows[rows.length - 1].balance : previousBalance;

  // SAP-style brought-forward row prepended to the export so the
  // ledger starts with "رصيد ما قبل" mirroring the on-screen table.
  const previousBalanceRow = {
    docType:     "رصيد افتتاحي",
    entryDate:   fromDate || "",
    docNumber:   "",
    description: t("accountStatement.previousBalance"),
    debit:       previousDebit  || "",
    credit:      previousCredit || "",
    balance:     `${fmt(Math.abs(previousBalance))} ${previousBalance >= 0 ? t("accountingReports.debitShort") : t("accountingReports.creditShort")}`,
  };
  const exportRows = [
    ...(withOpening ? [previousBalanceRow] : []),
    ...rows.map((r: any) => ({
      docType:     docTypeFor(r),
      entryDate:   r.entryDate,
      docNumber:   r.docNumber,
      description: r.description,
      ...(showCostCenterCol ? {
        costCenter: r.costCenterCode
          ? `${r.costCenterCode} — ${isRtl ? (r.costCenterNameAr ?? "") : (r.costCenterNameEn ?? r.costCenterNameAr ?? "")}`.trim()
          : "—",
      } : {}),
      debit:       r.debit  || "",
      credit:      r.credit || "",
      balance:     r.balance,
    })),
  ];

  // Grand-totals row mirrored into the printed/exported tfoot so the
  // standard "الإجمالي" line appears at the bottom of the table.
  const exportTotalsRow = (!isLoading && rows.length > 0)
    ? {
        docType:     "",
        entryDate:   "",
        docNumber:   "",
        description: t("accountingReports.total"),
        debit:       totalDebit,
        credit:      totalCredit,
        balance:     `${fmt(Math.abs(finalBalance))} ${finalBalance >= 0 ? t("accountingReports.debitShort") : t("accountingReports.creditShort")}`,
      }
    : null;

  function handleSearch() {
    if (!accountId) { toast({ title: t("accountStatement.selectAccountFirst"), variant: "destructive" }); return; }
    setSearched(true);
    refetch();
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="h-6 w-6 text-primary" />
            {t("accountStatement.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("accountStatement.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          {(rows.length > 0 || previousBalance !== 0) && (
            <>
              <ExportButtons
                rows={exportRows}
                columns={EXPORT_COLS}
                filename={`${t("accountStatement.filename_prefix")}-${selectedAccount?.code ?? ""}-${fromDate}`}
                title={t("accountStatement.title_with", { name: accountDisplayName, from: fromDate, to: toDate })}
                totalsRow={exportTotalsRow}
              />
              <Button variant="outline" size="sm" className="gap-2 print:hidden" onClick={() => window.print()}>
                <Printer className="h-4 w-4" />{t("accountingReports.print")}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 items-end">
          <div className="space-y-1.5 lg:col-span-2">
            <Label>{t("accountStatement.account")} *</Label>
            <SearchCombobox
              items={[
                ...accounts
                  .filter((a: any) => a.isPosting)
                  .map((a: any) => ({ value: String(a.id), label: `${a.code} — ${isRtl ? a.nameAr : (a.nameEn || a.nameAr)}`, badge: a.code, badgeClass: "bg-muted text-muted-foreground border" }))
              ]}
              value={accountId}
              onValueChange={setAccountId}
              placeholder={t("accountStatement.selectAccount")}
              searchPlaceholder={t("accountStatement.searchByCodeOrName")}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("accountingReports.fromDate")}</Label>
            <DateField value={fromDate} onChange={e => setFromDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("accountingReports.toDate")}</Label>
            <DateField value={toDate} onChange={e => setToDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("common.branch")}</Label>
            <BranchFilter value={branchId} onChange={setBranchId} />
          </div>
          <div className="space-y-1.5">
            <CostCenterFilter value={costCenterIds} onChange={setCostCenterIds} />
          </div>
        </div>
        {/* Opening-balance toggle — identical UX to the customer/supplier
            statement screens. Default on (carries forward the previous
            balance); off shows period-only movement. */}
        <div className="flex items-center gap-2 mt-4">
          <input
            id="as-with-opening"
            type="checkbox"
            className="h-4 w-4"
            checked={withOpening}
            onChange={e => setWithOpening(e.target.checked)}
            data-testid="checkbox-with-opening"
          />
          <Label htmlFor="as-with-opening" className="cursor-pointer text-sm font-normal">
            {isRtl ? "تضمين الرصيد الافتتاحي" : "Include opening balance"}
          </Label>
        </div>
        <div className="mt-4 flex justify-end">
          <Button className="gap-2" onClick={handleSearch} disabled={isLoading}>
            <Search className="h-4 w-4" />
            {isLoading ? t("accountingReports.loading") : t("accountingReports.show_account_statement")}
          </Button>
        </div>
      </div>

      {/* Results */}
      {searched && !isLoading && rows.length === 0 && previousBalance === 0 && (
        <div className="rounded-xl border bg-card p-12 text-center text-muted-foreground">
          {t("accountStatement.noMovements")}
        </div>
      )}

      {searched && (rows.length > 0 || previousBalance !== 0) && (
        <>
          {/* Account Info (screen only — the print uses the unified
              AccountStatementView header instead). */}
          <div className="rounded-xl border bg-primary/5 p-4 flex flex-wrap gap-6 print:hidden">
            <div>
              <span className="text-xs text-muted-foreground block">{t("accountStatement.account")}</span>
              <span className="font-semibold">{selectedAccount?.code} — {accountDisplayName}</span>
            </div>
            <div>
              <span className="text-xs text-muted-foreground block">{t("accountStatement.period")}</span>
              <span className="font-semibold">{t("accountStatement.periodFromTo", { from: fromDate, to: toDate })}</span>
            </div>
            <div className={isRtl ? "mr-auto" : "ml-auto"}>
              <span className="text-xs text-muted-foreground block">{t("accountStatement.closingBalance")}</span>
              <span className={cn("font-bold text-lg", finalBalance >= 0 ? "text-primary" : "text-destructive")}>
                {fmt(Math.abs(finalBalance))} {finalBalance >= 0 ? t("accountingReports.debitShort") : t("accountingReports.creditShort")}
              </span>
            </div>
          </div>

          {/* ── Interactive grid (screen only) ─────────────────────────
              Same AdvancedReportGrid used on customer/supplier statements,
              so all the advanced features come for free: column chooser
              with drag-reorder + visibility, per-column AND/OR filter
              popovers, 3-state header sort, optional grouping with
              subtotals, conditional formatting rules, header/footer
              color themes, sticky header, page-size, and per-tenant
              persistence (slug "accountStatementGrid"). */}
          <div className="print:hidden">
            <AdvancedReportGrid
              slug="accountStatementGrid"
              cid={cid}
              rowKey={(r: any, i) => r.lineId ?? i}
              rows={rows}
              unitLabel="حركة"
              emptyMessage={t("accountStatement.noMovements") as string}
              leadingRows={withOpening ? [{
                __className: "bg-amber-50/40 font-semibold",
                docType: (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-gradient-to-l from-slate-50 to-zinc-50 px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-sm">
                    رصيد افتتاحي
                  </span>
                ),
                entryDate:   fromDate || "—",
                docNumber:   <span className="text-muted-foreground">—</span>,
                description: <span className="italic text-muted-foreground">{t("accountStatement.previousBalance")}</span>,
                costCenter:  <span className="text-xs text-muted-foreground">—</span>,
                debit:       <span className="font-mono text-blue-700">{previousDebit  > 0 ? fmt(previousDebit)  : ""}</span>,
                credit:      <span className="font-mono text-rose-700">{previousCredit > 0 ? fmt(previousCredit) : ""}</span>,
                balance: (
                  <span className={cn("font-mono", previousBalance >= 0 ? "text-primary" : "text-destructive")}>
                    {fmt(Math.abs(previousBalance))}
                    <span className={cn("text-xs font-normal", isRtl ? "mr-1" : "ml-1")}>
                      {previousBalance >= 0 ? t("accountingReports.debitShort") : t("accountingReports.creditShort")}
                    </span>
                  </span>
                ),
              }] : []}
              totalsRow={rows.length > 0 ? {
                __label: <span>{t("accountingReports.total")}</span>,
                debit:   <span className="font-mono text-blue-700">{fmt(totalDebit)}</span>,
                credit:  <span className="font-mono text-rose-700">{fmt(totalCredit)}</span>,
                balance: (
                  <span className={cn("font-mono font-semibold", finalBalance >= 0 ? "text-primary" : "text-destructive")}>
                    {fmt(Math.abs(finalBalance))}
                    <span className={cn("text-xs font-normal", isRtl ? "mr-1" : "ml-1")}>
                      {finalBalance >= 0 ? t("accountingReports.debitShort") : t("accountingReports.creditShort")}
                    </span>
                  </span>
                ),
              } : null}
              columns={[
                { key: "docType",   label: "نوع الوثيقة", type: "text",
                  value: (r: any) => docTypeFor(r),
                  render: (r: any) => {
                    const tone = docTypeTone(r);
                    return (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border bg-gradient-to-l px-2.5 py-1 text-xs font-medium shadow-sm whitespace-nowrap",
                          tone.ring, tone.bg, tone.text,
                        )}
                        data-testid={`cell-doctype-${r.lineId}`}
                        title={r.entryType ?? "general"}
                      >
                        {docTypeFor(r)}
                      </span>
                    );
                  },
                },
                { key: "entryDate", label: t("accountingReports.fromDate"), type: "text",
                  className: "font-mono tabular-nums text-slate-600",
                  value: (r: any) => r.entryDate,
                },
                { key: "docNumber", label: t("accountStatement.docNumber"), type: "text",
                  className: "font-mono tabular-nums",
                  value: (r: any) => r.docNumber ?? `JE-${r.entryId}`,
                  render: (r: any) => {
                    const href = sourceLinkFor(r);
                    const label = r.docNumber || `JE-${r.entryId}`;
                    return href ? (
                      <Link
                        href={href}
                        className="inline-flex items-center gap-1 text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-primary/40 rounded font-semibold"
                        data-testid={`link-source-${r.entryId}`}
                        title={t("accountStatement.openSource") as string}
                      >
                        {label}
                        <ExternalLink className="h-3 w-3 opacity-60" />
                      </Link>
                    ) : <span className="text-primary font-semibold">{label}</span>;
                  },
                },
                { key: "description", label: t("accountStatement.description"), type: "text",
                  className: "text-muted-foreground",
                  value: (r: any) => r.description ?? "",
                  render: (r: any) => <span className="max-w-xs truncate inline-block align-middle">{r.description || "—"}</span>,
                },
                ...(showCostCenterCol ? [{
                  key: "costCenter", label: t("accountingReports.costCenter", { defaultValue: "مركز التكلفة" }) as string, type: "text" as const,
                  value: (r: any) => r.costCenterCode
                    ? `${r.costCenterCode} ${isRtl ? (r.costCenterNameAr ?? "") : (r.costCenterNameEn ?? r.costCenterNameAr ?? "")}`.trim()
                    : "",
                  render: (r: any) => r.costCenterCode ? (
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-gradient-to-l from-violet-50 to-fuchsia-50 px-2.5 py-1 text-xs font-medium text-violet-800 shadow-sm"
                      title={isRtl ? (r.costCenterNameAr ?? "") : (r.costCenterNameEn ?? r.costCenterNameAr ?? "")}
                      data-testid={`cell-costcenter-${r.lineId}`}
                    >
                      <span className="font-mono text-[10px] rounded bg-violet-100 px-1 py-0.5 text-violet-700">{r.costCenterCode}</span>
                      <span className="truncate max-w-[140px]">
                        {isRtl ? (r.costCenterNameAr ?? "") : (r.costCenterNameEn ?? r.costCenterNameAr ?? "")}
                      </span>
                    </span>
                  ) : <span className="text-xs text-muted-foreground">—</span>,
                }] : []),
                { key: "debit", label: t("accountingReports.debit"), type: "num",
                  align: "end", totalable: true,
                  className: "font-mono tabular-nums",
                  value: (r: any) => r.debit ?? 0,
                  render: (r: any) => <span className="text-blue-700">{r.debit > 0 ? fmt(r.debit) : ""}</span>,
                },
                { key: "credit", label: t("accountingReports.credit"), type: "num",
                  align: "end", totalable: true,
                  className: "font-mono tabular-nums",
                  value: (r: any) => r.credit ?? 0,
                  render: (r: any) => <span className="text-rose-700">{r.credit > 0 ? fmt(r.credit) : ""}</span>,
                },
                { key: "balance", label: t("accountingReports.balance"), type: "num",
                  align: "end",
                  className: "font-mono tabular-nums font-semibold",
                  value: (r: any) => r.balance ?? 0,
                  render: (r: any) => (
                    <span className={cn(r.balance >= 0 ? "text-primary" : "text-destructive")}>
                      {fmt(Math.abs(r.balance))}
                      <span className={cn("text-xs font-normal", isRtl ? "mr-1" : "ml-1")}>
                        {r.balance >= 0 ? t("accountingReports.debitShort") : t("accountingReports.creditShort")}
                      </span>
                    </span>
                  ),
                },
              ]}
            />
          </div>

          {/* ── Unified printable statement (print/PDF only) ───────────
              All four statements (customer / supplier / general-accounts /
              sister-company) now share the SAME paper layout via
              AccountStatementView so window.print() output is consistent.
              The رقم القيد column is intentionally omitted from print. */}
          <div className="hidden print:block">
            <AccountStatementView
              mode="general"
              company={user?.company ?? null}
              account={{
                code: selectedAccount?.code ?? null,
                nameAr: selectedAccount?.nameAr ?? null,
                nameEn: selectedAccount?.nameEn ?? null,
                level: selectedAccount?.level ?? null,
              }}
              from={fromDate}
              to={toDate}
              opening={previousBalance}
              lines={rows.map((r: any) => ({
                id: r.entryId,
                journalEntryId: r.entryId,
                date: r.entryDate,
                docType: docTypeFor(r),
                type: docTypeFor(r),
                docNumber: r.docNumber || `JE-${r.entryId}`,
                docHref: sourceLinkFor(r) || undefined,
                journalEntryNumber: r.docNumber,
                description: r.description || "",
                debit: r.debit ?? 0,
                credit: r.credit ?? 0,
                balance: r.balance ?? 0,
              }))}
              totals={{ debit: totalDebit, credit: totalCredit }}
              closing={finalBalance}
            />
          </div>
        </>
      )}
    </div>
  );
}
