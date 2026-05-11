import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useSearch } from "wouter";
import { useFormatters } from "@/lib/format";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { SearchCombobox } from "@/components/ui/search-combobox";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import { FileText, Search, Printer, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

// Map a journal-entry row coming back from /account-statement to the URL of
// the document that produced it. Documents with a dedicated detail page
// (invoices, vouchers, production orders) deep-link straight to the row;
// modules whose UI only has a list view (returns, contracting bills, fixed
// assets, payroll, goods receipts/deliveries) link to the list page so the
// user lands inside the right module rather than on the raw JE. Anything we
// don't recognise — manual / opening / closing / depreciation re-runs / …
// — falls back to the journal-entry detail page, which renders cleanly for
// every entry type and is therefore the safe universal target.
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

  // Deep-link support: when navigated from another report (e.g. trial
  // balance drill-down or Income Statement row click) with
  // ?accountId=&fromDate=&toDate=&branchId=&costCenterId=, pre-fill the
  // form and auto-trigger the search so the statement is shown immediately.
  const searchString = useSearch();
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

  const EXPORT_COLS = [
    { key: "entryDate",   header: t("accountingReports.fromDate"), width: 14 },
    { key: "docNumber",   header: t("accountStatement.docNumber"), width: 14 },
    { key: "description", header: t("accountStatement.description"), width: 36 },
    { key: "debit",       header: t("accountingReports.debit"), width: 14 },
    { key: "credit",      header: t("accountingReports.credit"), width: 14 },
    { key: "balance",     header: t("accountingReports.balance"), width: 14 },
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

  const rows = data?.rows ?? [];
  const previousBalance = data?.previousBalance ?? 0;
  const previousDebit   = data?.previousDebit   ?? 0;
  const previousCredit  = data?.previousCredit  ?? 0;
  const selectedAccount = accounts.find((a: any) => String(a.id) === accountId);
  const accountDisplayName = selectedAccount ? (isRtl ? selectedAccount.nameAr : (selectedAccount.nameEn || selectedAccount.nameAr)) : "";
  const totalDebit  = rows.reduce((s, r) => s + (r.debit  || 0), 0);
  const totalCredit = rows.reduce((s, r) => s + (r.credit || 0), 0);
  // Closing balance = previous balance + period movements. When there
  // are no in-period rows, fall back to the previous balance itself
  // so the SAP-style brought-forward figure is still reflected.
  const finalBalance = rows.length > 0 ? rows[rows.length - 1].balance : previousBalance;

  // SAP-style brought-forward row prepended to the export so the
  // ledger starts with "رصيد ما قبل" mirroring the on-screen table.
  const previousBalanceRow = {
    entryDate:   fromDate || "",
    docNumber:   "",
    description: t("accountStatement.previousBalance"),
    debit:       fmt(previousDebit),
    credit:      fmt(previousCredit),
    balance:     `${fmt(Math.abs(previousBalance))} ${previousBalance >= 0 ? t("accountingReports.debit") : t("accountingReports.credit")}`,
  };
  const exportRows = [
    previousBalanceRow,
    ...rows.map((r: any) => ({
      entryDate:   r.entryDate,
      docNumber:   r.docNumber,
      description: r.description,
      debit:       fmt(r.debit),
      credit:      fmt(r.credit),
      balance:     fmt(r.balance),
    })),
  ];

  // Grand-totals row mirrored into the printed/exported tfoot so the
  // standard "الإجمالي" line appears at the bottom of the table.
  const exportTotalsRow = (!isLoading && rows.length > 0)
    ? {
        entryDate:   "",
        docNumber:   "",
        description: t("accountingReports.total"),
        debit:       fmt(totalDebit),
        credit:      fmt(totalCredit),
        balance:     `${fmt(Math.abs(finalBalance))} ${finalBalance >= 0 ? t("accountingReports.debit") : t("accountingReports.credit")}`,
      }
    : null;

  // Summary footer cards under the printed table (debit / credit / closing).
  const exportSummaryFooter = (!isLoading && rows.length > 0)
    ? [
        { label: t("accountingReports.debit"),   value: fmt(totalDebit),  tone: "debit"   as const },
        { label: t("accountingReports.credit"),  value: fmt(totalCredit), tone: "credit"  as const },
        { label: t("accountStatement.closingBalance"), value: `${fmt(Math.abs(finalBalance))} ${finalBalance >= 0 ? t("accountingReports.debit") : t("accountingReports.credit")}`, tone: "primary" as const },
      ]
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
                summaryFooter={exportSummaryFooter}
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
            <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("accountingReports.toDate")}</Label>
            <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} />
          </div>
          <div className="space-y-1.5 lg:col-span-2">
            <Label>{t("common.branch")}</Label>
            <BranchFilter value={branchId} onChange={setBranchId} />
          </div>
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
          {/* Account Info */}
          <div className="rounded-xl border bg-primary/5 p-4 flex flex-wrap gap-6">
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
                {fmt(Math.abs(finalBalance))} {finalBalance >= 0 ? t("accountingReports.debit") : t("accountingReports.credit")}
              </span>
            </div>
          </div>

          {/* Table */}
          <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/50 border-b">
                    <th className="text-start px-4 py-3 font-semibold text-muted-foreground">#</th>
                    <th className="text-start px-4 py-3 font-semibold text-muted-foreground">{t("accountingReports.fromDate")}</th>
                    <th className="text-start px-4 py-3 font-semibold text-muted-foreground">{t("accountStatement.docNumber")}</th>
                    <th className="text-start px-4 py-3 font-semibold text-muted-foreground">{t("accountStatement.description")}</th>
                    <th className="text-end px-4 py-3 font-semibold text-muted-foreground">{t("accountingReports.debit")}</th>
                    <th className="text-end px-4 py-3 font-semibold text-muted-foreground">{t("accountingReports.credit")}</th>
                    <th className="text-end px-4 py-3 font-semibold text-muted-foreground">{t("accountingReports.balance")}</th>
                  </tr>
                </thead>
                <tbody>
                  {/* SAP-style brought-forward row: shows the cumulative
                      balance up to the day before fromDate so the ledger
                      reads as a continuation of history, not from zero. */}
                  <tr className="bg-muted/20 border-b font-semibold">
                    <td className="px-4 py-2.5 text-muted-foreground text-xs">—</td>
                    <td className="px-4 py-2.5">{fromDate || "—"}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">—</td>
                    <td className="px-4 py-2.5 text-muted-foreground italic">{t("accountStatement.previousBalance")}</td>
                    <td className="px-4 py-2.5 text-end font-mono text-blue-700">
                      {previousDebit > 0 ? fmt(previousDebit) : ""}
                    </td>
                    <td className="px-4 py-2.5 text-end font-mono text-rose-700">
                      {previousCredit > 0 ? fmt(previousCredit) : ""}
                    </td>
                    <td className={cn("px-4 py-2.5 text-end font-mono",
                      previousBalance >= 0 ? "text-primary" : "text-destructive"
                    )}>
                      {fmt(Math.abs(previousBalance))}
                      <span className={cn("text-xs font-normal", isRtl ? "mr-1" : "ml-1")}>{previousBalance >= 0 ? t("accountingReports.debitShort") : t("accountingReports.creditShort")}</span>
                    </td>
                  </tr>
                  {rows.map((r, i) => {
                    const href = sourceLinkFor(r);
                    const label = r.docNumber || `JE-${r.entryId}`;
                    return (
                    <tr key={r.lineId} className="border-b hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-2.5 text-muted-foreground text-xs">{i + 1}</td>
                      <td className="px-4 py-2.5">{r.entryDate}</td>
                      <td className="px-4 py-2.5 font-mono text-xs font-semibold">
                        {href ? (
                          <Link
                            href={href}
                            className="inline-flex items-center gap-1 text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-primary/40 rounded"
                            data-testid={`link-source-${r.entryId}`}
                            title={t("accountStatement.openSource")}
                          >
                            {label}
                            <ExternalLink className="h-3 w-3 opacity-60" />
                          </Link>
                        ) : (
                          <span className="text-primary">{label}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground max-w-xs truncate">{r.description || "—"}</td>
                      <td className="px-4 py-2.5 text-end font-mono text-blue-700">
                        {r.debit > 0 ? fmt(r.debit) : ""}
                      </td>
                      <td className="px-4 py-2.5 text-end font-mono text-rose-700">
                        {r.credit > 0 ? fmt(r.credit) : ""}
                      </td>
                      <td className={cn("px-4 py-2.5 text-end font-mono font-semibold",
                        r.balance >= 0 ? "text-primary" : "text-destructive"
                      )}>
                        {fmt(Math.abs(r.balance))}
                        <span className={cn("text-xs font-normal", isRtl ? "mr-1" : "ml-1")}>{r.balance >= 0 ? t("accountingReports.debitShort") : t("accountingReports.creditShort")}</span>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-muted/50 font-semibold border-t-2">
                    <td colSpan={4} className="px-4 py-3 text-center">{t("accountingReports.total")}</td>
                    <td className="px-4 py-3 text-end font-mono text-blue-700">{fmt(totalDebit)}</td>
                    <td className="px-4 py-3 text-end font-mono text-rose-700">{fmt(totalCredit)}</td>
                    <td className={cn("px-4 py-3 text-end font-mono",
                      finalBalance >= 0 ? "text-primary" : "text-destructive"
                    )}>
                      {fmt(Math.abs(finalBalance))} {finalBalance >= 0 ? t("accountingReports.debit") : t("accountingReports.credit")}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
