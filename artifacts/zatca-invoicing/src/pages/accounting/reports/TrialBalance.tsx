import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@/lib/format";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import ExportButtons from "@/components/ExportButtons";
import { Scale, Search, Printer } from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function TrialBalance() {
  const { user, token } = useAuth() as any;
  const { t } = useTranslation();
  const { fmt: fmtRaw, isRtl } = useFormatters();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}` };

  const fmt    = (n: number) => n === 0 ? "" : fmtRaw(n);
  const fmtAbs = (n: number) => fmtRaw(Math.abs(n));

  const TYPE_LABELS: Record<string, string> = {
    asset: t("accountingReports.typeAsset"),
    liability: t("accountingReports.typeLiability"),
    equity: t("accountingReports.typeEquity"),
    revenue: t("accountingReports.typeRevenue"),
    expense: t("accountingReports.typeExpense"),
  };

  const EXPORT_COLS = [
    { key: "code",        header: t("accountingReports.code"),       width: 12 },
    { key: "nameAr",      header: t("accountingReports.accountName"), width: 36 },
    { key: "accountType", header: t("accountingReports.type"),        width: 14 },
    { key: "totalDebit",  header: `${t("accountingReports.totalMovements")} - ${t("accountingReports.debit")}`, width: 16 },
    { key: "totalCredit", header: `${t("accountingReports.totalMovements")} - ${t("accountingReports.credit")}`, width: 16 },
    { key: "balDebit",    header: `${t("accountingReports.balance")} ${t("accountingReports.debit")}`, width: 16 },
    { key: "balCredit",   header: `${t("accountingReports.balance")} ${t("accountingReports.credit")}`, width: 16 },
  ];

  const today = new Date().toISOString().slice(0, 10);
  const firstOfYear = today.slice(0, 4) + "-01-01";

  const [fromDate, setFromDate] = useState(firstOfYear);
  const [toDate, setToDate]     = useState(today);
  const [searched, setSearched] = useState(false);

  const { data: rows = [], isLoading, refetch } = useQuery<any[]>({
    queryKey: ["trial-balance", cid, fromDate, toDate],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cid)     params.set("companyId", String(cid));
      if (fromDate) params.set("fromDate", fromDate);
      if (toDate)   params.set("toDate", toDate);
      const res = await fetch(`${API}/api/accounting-reports/trial-balance?${params}`, { headers });
      return res.json();
    },
    enabled: searched,
    select: (data) => data.filter((r: any) => r.totalDebit > 0 || r.totalCredit > 0),
  });

  const totalDr  = rows.reduce((s, r) => s + r.totalDebit,  0);
  const totalCr  = rows.reduce((s, r) => s + r.totalCredit, 0);
  const balDrTot = rows.reduce((s, r) => s + Math.max(0,  r.balance), 0);
  const balCrTot = rows.reduce((s, r) => s + Math.max(0, -r.balance), 0);

  const exportRows = rows.map((r: any) => ({
    code:        r.code,
    nameAr:      isRtl ? r.nameAr : (r.nameEn || r.nameAr),
    accountType: TYPE_LABELS[r.accountType] ?? r.accountType,
    totalDebit:  r.totalDebit  > 0 ? fmtAbs(r.totalDebit)  : "",
    totalCredit: r.totalCredit > 0 ? fmtAbs(r.totalCredit) : "",
    balDebit:    r.balance > 0 ? fmtAbs(r.balance) : "",
    balCredit:   r.balance < 0 ? fmtAbs(r.balance) : "",
  }));

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
        <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
          {/* Balance indicator */}
          <div className={cn(
            "flex items-center justify-between px-5 py-2.5 text-sm font-semibold border-b",
            Math.abs(totalDr - totalCr) < 0.01 ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
          )}>
            <span>{t("trialBalance.balanceCheck")}</span>
            <span>
              {Math.abs(totalDr - totalCr) < 0.01
                ? t("trialBalance.balanced")
                : t("trialBalance.diff", { diff: fmtAbs(totalDr - totalCr) })}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b">
                  <th className="text-start px-4 py-3 font-semibold text-muted-foreground">{t("accountingReports.code")}</th>
                  <th className="text-start px-4 py-3 font-semibold text-muted-foreground">{t("accountingReports.accountName")}</th>
                  <th className="text-start px-4 py-3 font-semibold text-muted-foreground">{t("accountingReports.type")}</th>
                  <th className="text-center px-2 py-3 font-semibold text-muted-foreground" colSpan={2}>
                    {t("trialBalance.totalMovements")}
                  </th>
                  <th className="text-center px-2 py-3 font-semibold text-muted-foreground" colSpan={2}>
                    {t("trialBalance.balances")}
                  </th>
                </tr>
                <tr className="bg-muted/30 border-b text-xs">
                  <th colSpan={3} />
                  <th className="text-end px-4 py-2 font-semibold text-blue-700">{t("accountingReports.debit")}</th>
                  <th className="text-end px-4 py-2 font-semibold text-rose-700">{t("accountingReports.credit")}</th>
                  <th className="text-end px-4 py-2 font-semibold text-blue-700">{t("accountingReports.debit")}</th>
                  <th className="text-end px-4 py-2 font-semibold text-rose-700">{t("accountingReports.credit")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className="border-b hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-2.5 font-mono text-xs text-primary">{r.code}</td>
                    <td className="px-4 py-2.5">{isRtl ? r.nameAr : (r.nameEn || r.nameAr)}</td>
                    <td className="px-4 py-2.5 text-muted-foreground text-xs">{TYPE_LABELS[r.accountType] ?? r.accountType}</td>
                    <td className="px-4 py-2.5 text-end font-mono text-blue-700">{fmt(r.totalDebit)}</td>
                    <td className="px-4 py-2.5 text-end font-mono text-rose-700">{fmt(r.totalCredit)}</td>
                    <td className="px-4 py-2.5 text-end font-mono text-blue-700">{r.balance > 0 ? fmt(r.balance) : ""}</td>
                    <td className="px-4 py-2.5 text-end font-mono text-rose-700">{r.balance < 0 ? fmt(-r.balance) : ""}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-muted/60 font-bold border-t-2 text-sm">
                  <td colSpan={3} className="px-4 py-3">{t("accountingReports.total")}</td>
                  <td className="px-4 py-3 text-end font-mono text-blue-700">{fmtAbs(totalDr)}</td>
                  <td className="px-4 py-3 text-end font-mono text-rose-700">{fmtAbs(totalCr)}</td>
                  <td className="px-4 py-3 text-end font-mono text-blue-700">{fmtAbs(balDrTot)}</td>
                  <td className="px-4 py-3 text-end font-mono text-rose-700">{fmtAbs(balCrTot)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
