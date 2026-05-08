import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@/lib/format";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
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
    { key: "openDebit",   header: `${t("trialBalance.openingBalance")} - ${t("accountingReports.debit")}`, width: 16 },
    { key: "openCredit",  header: `${t("trialBalance.openingBalance")} - ${t("accountingReports.credit")}`, width: 16 },
    { key: "totalDebit",  header: `${t("trialBalance.periodBalance")} - ${t("accountingReports.debit")}`, width: 16 },
    { key: "totalCredit", header: `${t("trialBalance.periodBalance")} - ${t("accountingReports.credit")}`, width: 16 },
    { key: "closeDebit",  header: `${t("trialBalance.closingBalance")} - ${t("accountingReports.debit")}`, width: 16 },
    { key: "closeCredit", header: `${t("trialBalance.closingBalance")} - ${t("accountingReports.credit")}`, width: 16 },
  ];

  const today = new Date().toISOString().slice(0, 10);
  const firstOfYear = today.slice(0, 4) + "-01-01";

  const [fromDate, setFromDate] = useState(firstOfYear);
  const [toDate, setToDate]     = useState(today);
  const [branchId, setBranchId] = useState<number | undefined>(undefined);
  const [searched, setSearched] = useState(false);

  const { data: rows = [], isLoading, refetch } = useQuery<any[]>({
    queryKey: ["trial-balance", cid, fromDate, toDate, branchId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cid)     params.set("companyId", String(cid));
      if (fromDate) params.set("fromDate", fromDate);
      if (toDate)   params.set("toDate", toDate);
      if (branchId !== undefined) params.set("branchId", String(branchId));
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
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 items-end">
          <div className="space-y-1.5">
            <Label>{t("accountingReports.fromDate")}</Label>
            <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("accountingReports.toDate")}</Label>
            <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} />
          </div>
          <BranchFilter value={branchId} onChange={setBranchId} />
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
                  <th className="text-start px-4 py-3 font-semibold text-muted-foreground border-b">{t("accountingReports.type")}</th>

                  {/* gutter before opening group */}
                  <th className="w-1 p-0 bg-gradient-to-b from-amber-200 to-amber-400 border-b border-amber-300" />
                  <th className="text-center px-2 py-3 font-semibold text-amber-700 bg-amber-50 border-b-2 border-amber-300" colSpan={2}>
                    {t("trialBalance.openingBalance")}
                  </th>
                  {/* gutter between opening & period */}
                  <th className="w-1 p-0 bg-gradient-to-b from-amber-300 to-slate-300 border-b border-slate-300" />

                  <th className="text-center px-2 py-3 font-semibold text-slate-700 bg-slate-50 border-b-2 border-slate-300" colSpan={2}>
                    {t("trialBalance.periodBalance")}
                  </th>

                  {/* gutter between period & closing */}
                  <th className="w-1 p-0 bg-gradient-to-b from-slate-300 to-emerald-300 border-b border-emerald-300" />
                  <th className="text-center px-2 py-3 font-semibold text-emerald-700 bg-emerald-50 border-b-2 border-emerald-300" colSpan={2}>
                    {t("trialBalance.closingBalance")}
                  </th>
                  {/* gutter after closing group */}
                  <th className="w-1 p-0 bg-gradient-to-b from-emerald-400 to-emerald-200 border-b border-emerald-300" />
                </tr>
                <tr className="bg-muted/30 text-xs">
                  <th colSpan={3} className="border-b" />

                  <th className="w-1 p-0 bg-amber-100 border-b" />
                  <th className="text-end px-4 py-2 font-semibold text-blue-700 bg-amber-50/60 border-b">{t("accountingReports.debit")}</th>
                  <th className="text-end px-4 py-2 font-semibold text-rose-700 bg-amber-50/60 border-b">{t("accountingReports.credit")}</th>
                  <th className="w-1 p-0 bg-slate-100 border-b" />

                  <th className="text-end px-4 py-2 font-semibold text-blue-700 bg-slate-50/60 border-b">{t("accountingReports.debit")}</th>
                  <th className="text-end px-4 py-2 font-semibold text-rose-700 bg-slate-50/60 border-b">{t("accountingReports.credit")}</th>

                  <th className="w-1 p-0 bg-emerald-100 border-b" />
                  <th className="text-end px-4 py-2 font-semibold text-blue-700 bg-emerald-50/60 border-b">{t("accountingReports.debit")}</th>
                  <th className="text-end px-4 py-2 font-semibold text-rose-700 bg-emerald-50/60 border-b">{t("accountingReports.credit")}</th>
                  <th className="w-1 p-0 bg-emerald-100 border-b" />
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const op = r.openingBalance ?? 0;
                  const cl = r.closingBalance ?? 0;
                  return (
                    <tr key={r.id} className="hover:bg-muted/30 transition-colors group">
                      <td className="px-4 py-2.5 font-mono text-xs text-primary border-b">{r.code}</td>
                      <td className="px-4 py-2.5 border-b">{isRtl ? r.nameAr : (r.nameEn || r.nameAr)}</td>
                      <td className="px-4 py-2.5 text-muted-foreground text-xs border-b">{TYPE_LABELS[r.accountType] ?? r.accountType}</td>

                      <td className="w-1 p-0 bg-amber-200/70 border-b border-amber-200 group-hover:bg-amber-300" />
                      <td className="px-4 py-2.5 text-end font-mono text-blue-700 bg-amber-50/40 border-b">{op > 0 ? fmt(op) : ""}</td>
                      <td className="px-4 py-2.5 text-end font-mono text-rose-700 bg-amber-50/40 border-b">{op < 0 ? fmt(-op) : ""}</td>
                      <td className="w-1 p-0 bg-slate-200/70 border-b border-slate-200 group-hover:bg-slate-300" />

                      <td className="px-4 py-2.5 text-end font-mono text-blue-700 bg-slate-50/40 border-b">{fmt(r.totalDebit)}</td>
                      <td className="px-4 py-2.5 text-end font-mono text-rose-700 bg-slate-50/40 border-b">{fmt(r.totalCredit)}</td>

                      <td className="w-1 p-0 bg-emerald-200/70 border-b border-emerald-200 group-hover:bg-emerald-300" />
                      <td className="px-4 py-2.5 text-end font-mono text-blue-700 bg-emerald-50/40 border-b">{cl > 0 ? fmt(cl) : ""}</td>
                      <td className="px-4 py-2.5 text-end font-mono text-rose-700 bg-emerald-50/40 border-b">{cl < 0 ? fmt(-cl) : ""}</td>
                      <td className="w-1 p-0 bg-emerald-200/70 border-b border-emerald-200 group-hover:bg-emerald-300" />
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-muted/60 font-bold text-sm">
                  <td colSpan={3} className="px-4 py-3 border-t-2 border-slate-400">{t("accountingReports.total")}</td>

                  <td className="w-1 p-0 bg-gradient-to-t from-amber-300 to-amber-400 border-t-2 border-amber-400" />
                  <td className="px-4 py-3 text-end font-mono text-blue-700 bg-amber-100/70 border-t-2 border-amber-400">{fmtAbs(openDrTot)}</td>
                  <td className="px-4 py-3 text-end font-mono text-rose-700 bg-amber-100/70 border-t-2 border-amber-400">{fmtAbs(openCrTot)}</td>
                  <td className="w-1 p-0 bg-gradient-to-t from-amber-300 via-slate-300 to-slate-400 border-t-2 border-slate-400" />

                  <td className="px-4 py-3 text-end font-mono text-blue-700 bg-slate-100/70 border-t-2 border-slate-400">{fmtAbs(totalDr)}</td>
                  <td className="px-4 py-3 text-end font-mono text-rose-700 bg-slate-100/70 border-t-2 border-slate-400">{fmtAbs(totalCr)}</td>

                  <td className="w-1 p-0 bg-gradient-to-t from-slate-300 via-emerald-300 to-emerald-400 border-t-2 border-emerald-400" />
                  <td className="px-4 py-3 text-end font-mono text-blue-700 bg-emerald-100/70 border-t-2 border-emerald-400">{fmtAbs(closeDrTot)}</td>
                  <td className="px-4 py-3 text-end font-mono text-rose-700 bg-emerald-100/70 border-t-2 border-emerald-400">{fmtAbs(closeCrTot)}</td>
                  <td className="w-1 p-0 bg-gradient-to-t from-emerald-300 to-emerald-400 border-t-2 border-emerald-400" />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
