import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@/lib/format";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { SearchCombobox } from "@/components/ui/search-combobox";
import ExportButtons from "@/components/ExportButtons";
import { FileText, Search, Printer } from "lucide-react";
import { cn } from "@/lib/utils";

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
  const [searched, setSearched]   = useState(false);

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

  const { data: rows = [], isLoading, refetch } = useQuery<any[]>({
    queryKey: ["account-statement", cid, accountId, fromDate, toDate],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cid)       params.set("companyId", String(cid));
      if (accountId) params.set("accountId", accountId);
      if (fromDate)  params.set("fromDate", fromDate);
      if (toDate)    params.set("toDate", toDate);
      const res = await fetch(`${API}/api/accounting-reports/account-statement?${params}`, { headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      return res.json();
    },
    enabled: searched && !!accountId,
  });

  const selectedAccount = accounts.find((a: any) => String(a.id) === accountId);
  const accountDisplayName = selectedAccount ? (isRtl ? selectedAccount.nameAr : (selectedAccount.nameEn || selectedAccount.nameAr)) : "";
  const totalDebit  = rows.reduce((s, r) => s + (r.debit  || 0), 0);
  const totalCredit = rows.reduce((s, r) => s + (r.credit || 0), 0);
  const finalBalance = rows.length > 0 ? rows[rows.length - 1].balance : 0;

  const exportRows = rows.map((r: any) => ({
    entryDate:   r.entryDate,
    docNumber:   r.docNumber,
    description: r.description,
    debit:       fmt(r.debit),
    credit:      fmt(r.credit),
    balance:     fmt(r.balance),
  }));

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
          {rows.length > 0 && (
            <>
              <ExportButtons
                rows={exportRows}
                columns={EXPORT_COLS}
                filename={`${t("accountStatement.filename_prefix")}-${selectedAccount?.code ?? ""}-${fromDate}`}
                title={t("accountStatement.title_with", { name: accountDisplayName, from: fromDate, to: toDate })}
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
        </div>
        <div className="mt-4 flex justify-end">
          <Button className="gap-2" onClick={handleSearch} disabled={isLoading}>
            <Search className="h-4 w-4" />
            {isLoading ? t("accountingReports.loading") : t("accountingReports.show_account_statement")}
          </Button>
        </div>
      </div>

      {/* Results */}
      {searched && !isLoading && rows.length === 0 && (
        <div className="rounded-xl border bg-card p-12 text-center text-muted-foreground">
          {t("accountStatement.noMovements")}
        </div>
      )}

      {rows.length > 0 && (
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
                  {rows.map((r, i) => (
                    <tr key={r.lineId} className="border-b hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-2.5 text-muted-foreground text-xs">{i + 1}</td>
                      <td className="px-4 py-2.5">{r.entryDate}</td>
                      <td className="px-4 py-2.5 font-mono text-xs font-semibold text-primary">{r.docNumber}</td>
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
                  ))}
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
