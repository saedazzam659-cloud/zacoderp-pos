import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@/lib/format";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import ExportButtons from "@/components/ExportButtons";
import { TrendingUp, Search, Printer } from "lucide-react";
import { cn } from "@/lib/utils";

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
  const [searched, setSearched] = useState(false);

  const { data, isLoading, refetch } = useQuery<any>({
    queryKey: ["income-statement", cid, fromDate, toDate],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cid) params.set("companyId", String(cid));
      params.set("fromDate", fromDate);
      params.set("toDate", toDate);
      const res = await fetch(`${API}/api/accounting-reports/income-statement?${params}`, { headers });
      return res.json();
    },
    enabled: searched,
  });

  const netIncome = data?.netIncome ?? 0;
  const isProfit  = netIncome >= 0;

  const exportRows = data ? [
    ...(data.revenues ?? []).filter((r: any) => r.totalCredit !== r.totalDebit).map((r: any) =>
      ({ section: t("incomeStatement.revenues"), code: r.code, name: isRtl ? r.nameAr : (r.nameEn || r.nameAr), amount: fmt(r.totalCredit - r.totalDebit) })),
    { section: "", code: "", name: t("incomeStatement.totalRevenues"), amount: fmt(data.totalRevenue) },
    ...(data.expenses ?? []).filter((r: any) => r.totalDebit !== r.totalCredit).map((r: any) =>
      ({ section: t("incomeStatement.expenses"), code: r.code, name: isRtl ? r.nameAr : (r.nameEn || r.nameAr), amount: fmt(r.totalDebit - r.totalCredit) })),
    { section: "", code: "", name: t("incomeStatement.totalExpenses"), amount: fmt(data.totalExpenses) },
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

      {/* Filters */}
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
          <div className="space-y-1.5">
            <Label>{t("accountingReports.fromDate")}</Label>
            <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("accountingReports.toDate")}</Label>
            <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} />
          </div>
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
            {(data.revenues ?? []).filter((r: any) => r.totalCredit !== r.totalDebit).length === 0 && (
              <div className="px-5 py-4 text-center text-muted-foreground text-sm">{t("incomeStatement.noRevenues")}</div>
            )}
            {(data.revenues ?? []).filter((r: any) => r.totalCredit !== r.totalDebit).map((r: any) => (
              <div key={r.id} className="flex items-center justify-between px-5 py-2.5 border-b hover:bg-muted/30">
                <div>
                  <span className={cn("text-xs text-muted-foreground font-mono", isRtl ? "ml-2" : "mr-2")}>{r.code}</span>
                  <span className="text-sm">{isRtl ? r.nameAr : (r.nameEn || r.nameAr)}</span>
                </div>
                <span className="font-mono text-sm font-semibold text-green-700">
                  {fmt(r.totalCredit - r.totalDebit)}
                </span>
              </div>
            ))}
            <div className="bg-green-50 flex items-center justify-between px-5 py-3 font-bold text-green-800">
              <span>{t("incomeStatement.totalRevenues")}</span>
              <span className="font-mono">{fmt(data.totalRevenue)}</span>
            </div>
          </div>

          {/* Expenses */}
          <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
            <div className="bg-rose-50 text-rose-800 px-5 py-3 font-bold text-base border-b">
              {t("incomeStatement.expenses")}
            </div>
            {(data.expenses ?? []).filter((r: any) => r.totalDebit !== r.totalCredit).length === 0 && (
              <div className="px-5 py-4 text-center text-muted-foreground text-sm">{t("incomeStatement.noExpenses")}</div>
            )}
            {(data.expenses ?? []).filter((r: any) => r.totalDebit !== r.totalCredit).map((r: any) => (
              <div key={r.id} className="flex items-center justify-between px-5 py-2.5 border-b hover:bg-muted/30">
                <div>
                  <span className={cn("text-xs text-muted-foreground font-mono", isRtl ? "ml-2" : "mr-2")}>{r.code}</span>
                  <span className="text-sm">{isRtl ? r.nameAr : (r.nameEn || r.nameAr)}</span>
                </div>
                <span className="font-mono text-sm font-semibold text-rose-700">
                  {fmt(r.totalDebit - r.totalCredit)}
                </span>
              </div>
            ))}
            <div className="bg-rose-50 flex items-center justify-between px-5 py-3 font-bold text-rose-800">
              <span>{t("incomeStatement.totalExpenses")}</span>
              <span className="font-mono">{fmt(data.totalExpenses)}</span>
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
