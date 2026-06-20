import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { useFormatters } from "@/lib/format";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import CostCenterFilter from "@/components/CostCenterFilter";
import AccountParentFilter from "@/components/AccountParentFilter";
import AccountLevelFilter from "@/components/AccountLevelFilter";
import { useAccountTree } from "@/hooks/useAccountTree";
import { descendantIds, matchesAccountFilters, type AccountLevelMode } from "@/lib/accountTree";
import { TrendingUp, Search, Printer, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { DateField } from "@/components/ui/date-field";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function IncomeStatement() {
  const { user, token } = useAuth() as any;
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}` };

  const today = new Date().toISOString().slice(0, 10);
  const firstOfYear = today.slice(0, 4) + "-01-01";
  const [fromDate, setFromDate] = useState(firstOfYear);
  const [toDate, setToDate]     = useState(today);
  const [branchId, setBranchId] = useState<number | undefined>(undefined);
  const [costCenterIds, setCostCenterIds] = useState<number[]>([]);
  const [searched, setSearched] = useState(false);
  const [showZero, setShowZero] = useState(false);
  const [accountParentIds, setAccountParentIds] = useState<number[]>([]);
  const [levelMode, setLevelMode] = useState<AccountLevelMode>("all");
  const { tree } = useAccountTree();

  // Stable serialised key for React-Query so identical selections (in
  // any order) reuse the same cache entry. Sort numerically before
  // joining; the backend doesn't care about order.
  const ccCsv = costCenterIds.length ? [...costCenterIds].sort((a, b) => a - b).join(",") : "";

  const { data, isLoading, refetch } = useQuery<any>({
    queryKey: ["income-statement", cid, fromDate, toDate, branchId, ccCsv],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cid) params.set("companyId", String(cid));
      params.set("fromDate", fromDate);
      params.set("toDate", toDate);
      if (branchId) params.set("branchId", String(branchId));
      if (ccCsv) params.set("costCenterId", ccCsv);
      const res = await fetch(`${API}/api/accounting-reports/income-statement?${params}`, { headers });
      return res.json();
    },
    enabled: searched,
  });

  // Client-side filtering (zero gate + parent/level). Totals are
  // RECOMPUTED from the filtered rows so the displayed totals + net income
  // always match the visible lines. With no parent/level filter and zeros
  // hidden, these sums equal the backend totals (zero-net rows add 0).
  const parentDescendants = useMemo(() => descendantIds(tree, accountParentIds), [tree, accountParentIds]);
  const filterGroup = (arr: any[] | undefined) =>
    (arr ?? []).filter((r: any) => {
      if (!showZero && r.totalCredit === r.totalDebit) return false;
      return matchesAccountFilters(Number(r.id), tree, { parentDescendants, levelMode });
    });
  const shownRevenues = useMemo(() => filterGroup(data?.revenues), [data, showZero, parentDescendants, levelMode, tree]);
  const shownExpenses = useMemo(() => filterGroup(data?.expenses), [data, showZero, parentDescendants, levelMode, tree]);

  const totalRevenue  = shownRevenues.reduce((s, r) => s + (r.totalCredit - r.totalDebit), 0);
  const totalExpenses = shownExpenses.reduce((s, r) => s + (r.totalDebit - r.totalCredit), 0);
  const netIncome = totalRevenue - totalExpenses;
  const isProfit  = netIncome >= 0;

  // Build the deep-link href to the Account Statement (ledger) page,
  // pre-filtered to the same date range / branch / cost-center the user
  // is currently viewing on the Income Statement. Clicking any account row
  // opens its full transaction ledger filtered to the exact same context.
  const drillHref = (accountId: number) => {
    const qs = new URLSearchParams();
    qs.set("accountId", String(accountId));
    qs.set("fromDate", fromDate);
    qs.set("toDate", toDate);
    if (branchId) qs.set("branchId", String(branchId));
    if (ccCsv)    qs.set("costCenterId", ccCsv);
    return `/accounting/reports/account-statement?${qs.toString()}`;
  };

  const exportRows = data ? [
    ...shownRevenues.map((r: any) =>
      ({ section: t("incomeStatement.revenues"), code: r.code, name: isRtl ? r.nameAr : (r.nameEn || r.nameAr), amount: fmt(r.totalCredit - r.totalDebit) })),
    { section: "", code: "", name: t("incomeStatement.totalRevenues"), amount: fmt(totalRevenue) },
    ...shownExpenses.map((r: any) =>
      ({ section: t("incomeStatement.expenses"), code: r.code, name: isRtl ? r.nameAr : (r.nameEn || r.nameAr), amount: fmt(r.totalDebit - r.totalCredit) })),
    { section: "", code: "", name: t("incomeStatement.totalExpenses"), amount: fmt(totalExpenses) },
    { section: "", code: "", name: isProfit ? t("incomeStatement.netProfit") : t("incomeStatement.netLoss"), amount: fmt(Math.abs(netIncome)) },
  ] : [];

  const exportCols = [
    { key: "section", header: t("accountingReports.section"), width: 16 },
    { key: "code",    header: t("accountingReports.code"),    width: 12 },
    { key: "name",    header: t("accountingReports.item"),    width: 40 },
    { key: "amount",  header: t("accountingReports.amount"),  width: 18 },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <TrendingUp className="h-6 w-6 text-primary" />
            {t("incomeStatement.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("incomeStatement.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          {data && (
            <>
              <ExportButtons rows={exportRows} columns={exportCols}
                filename={`${t("incomeStatement.filename_prefix")}-${fromDate}-${toDate}`}
                title={t("incomeStatement.title_with", { from: fromDate, to: toDate })} />
              <Button variant="outline" size="sm" className="gap-2" onClick={() => window.print()}>
                <Printer className="h-4 w-4" />{t("accountingReports.print")}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Filters — 5-col grid on lg so date range + branch + cost-center
          + the action button all line up cleanly. Cost-center filter is
          a visual twin of the branch filter (same Select/Label idiom). */}
      <div className="rounded-xl border bg-card p-4 shadow-sm space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 items-end">
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
          <AccountParentFilter value={accountParentIds} onChange={setAccountParentIds} />
          <AccountLevelFilter value={levelMode} onChange={setLevelMode} />
        </div>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <Checkbox checked={showZero} onCheckedChange={(c) => setShowZero(c === true)} />
            {t("accountingReports.showZeroAccounts", "عرض الحسابات الصفرية")}
          </label>
          <Button className="gap-2" onClick={() => { setSearched(true); refetch(); }} disabled={isLoading}>
            <Search className="h-4 w-4" />
            {isLoading ? t("accountingReports.loading") : t("accountingReports.show_income_statement")}
          </Button>
        </div>
      </div>

      {searched && data && (
        <div className="space-y-5">
          {/* Revenues */}
          <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
            <div className="bg-green-50 text-green-800 px-5 py-3 font-bold text-base border-b">
              {t("incomeStatement.revenues")}
            </div>
            {shownRevenues.length === 0 && (
              <div className="px-5 py-4 text-center text-muted-foreground text-sm">{t("incomeStatement.noRevenues")}</div>
            )}
            {shownRevenues.map((r: any) => (
              <Link
                key={r.id}
                href={drillHref(r.id)}
                title={t("accountStatement.openLedger", "فتح كشف حساب لهذا البند")}
                className="group flex items-center justify-between px-5 py-2.5 border-b hover:bg-green-50/60 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <ExternalLink className="h-3.5 w-3.5 text-muted-foreground/0 group-hover:text-green-700 transition-colors shrink-0" />
                  <span className={cn("text-xs text-muted-foreground font-mono", isRtl ? "ml-2" : "mr-2")}>{r.code}</span>
                  <span className="text-sm group-hover:text-green-800 group-hover:underline underline-offset-4 decoration-green-400 truncate">
                    {isRtl ? r.nameAr : (r.nameEn || r.nameAr)}
                  </span>
                </div>
                <span className="font-mono text-sm font-semibold text-green-700">
                  {fmt(r.totalCredit - r.totalDebit)}
                </span>
              </Link>
            ))}
            <div className="bg-green-50 flex items-center justify-between px-5 py-3 font-bold text-green-800">
              <span>{t("incomeStatement.totalRevenues")}</span>
              <span className="font-mono">{fmt(totalRevenue)}</span>
            </div>
          </div>

          {/* Expenses */}
          <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
            <div className="bg-rose-50 text-rose-800 px-5 py-3 font-bold text-base border-b">
              {t("incomeStatement.expenses")}
            </div>
            {shownExpenses.length === 0 && (
              <div className="px-5 py-4 text-center text-muted-foreground text-sm">{t("incomeStatement.noExpenses")}</div>
            )}
            {shownExpenses.map((r: any) => (
              <Link
                key={r.id}
                href={drillHref(r.id)}
                title={t("accountStatement.openLedger", "فتح كشف حساب لهذا البند")}
                className="group flex items-center justify-between px-5 py-2.5 border-b hover:bg-rose-50/60 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <ExternalLink className="h-3.5 w-3.5 text-muted-foreground/0 group-hover:text-rose-700 transition-colors shrink-0" />
                  <span className={cn("text-xs text-muted-foreground font-mono", isRtl ? "ml-2" : "mr-2")}>{r.code}</span>
                  <span className="text-sm group-hover:text-rose-800 group-hover:underline underline-offset-4 decoration-rose-400 truncate">
                    {isRtl ? r.nameAr : (r.nameEn || r.nameAr)}
                  </span>
                </div>
                <span className="font-mono text-sm font-semibold text-rose-700">
                  {fmt(r.totalDebit - r.totalCredit)}
                </span>
              </Link>
            ))}
            <div className="bg-rose-50 flex items-center justify-between px-5 py-3 font-bold text-rose-800">
              <span>{t("incomeStatement.totalExpenses")}</span>
              <span className="font-mono">{fmt(totalExpenses)}</span>
            </div>
          </div>

          {/* Net Income */}
          <div className={cn(
            "rounded-xl border-2 px-6 py-5 flex items-center justify-between shadow-sm",
            isProfit
              ? "border-green-300 bg-green-50"
              : "border-red-300 bg-red-50"
          )}>
            <div>
              <div className={cn("text-lg font-bold", isProfit ? "text-green-800" : "text-red-800")}>
                {isProfit ? t("incomeStatement.netProfit") : t("incomeStatement.netLoss")}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {t("accountStatement.periodFromTo", { from: fromDate, to: toDate })}
              </div>
            </div>
            <div className={cn("text-2xl font-bold font-mono", isProfit ? "text-green-700" : "text-red-700")}>
              {fmt(Math.abs(netIncome))}
            </div>
          </div>
        </div>
      )}

      {searched && !isLoading && !data && (
        <div className="rounded-xl border bg-card p-12 text-center text-muted-foreground">
          {t("accountingReports.noDataInPeriod")}
        </div>
      )}
    </div>
  );
}
