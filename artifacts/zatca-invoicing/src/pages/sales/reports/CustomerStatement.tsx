import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { salesAnalyticsApi } from "@/lib/salesAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchCombobox } from "@/components/ui/search-combobox";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import { useTranslation } from "react-i18next";
import { FileText, Search, Filter } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";

const API = import.meta.env.VITE_API_URL ?? "";
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

export default function CustomerStatement() {
  const { fmt } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`salesReports.customerStatement.${k}`, opts) as string;
  const pickName = (ar?: string, en?: string) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [filters, setFilters] = useState<{ from: string; to: string; customerId: string; branchId?: number }>({ from: firstDay, to: today, customerId: "", branchId: undefined });
  const [applied, setApplied] = useState<{ from: string; to: string; customerId: string; branchId?: number }>({ from: firstDay, to: today, customerId: "", branchId: undefined });

  const { data: customers = [] } = useQuery({
    queryKey: ["customers", cid],
    queryFn: async () => {
      const r = await fetch(cid ? `${API}/api/customers?companyId=${cid}` : `${API}/api/customers`, { headers: authHeaders() });
      return r.json();
    },
  });

  const { data, isLoading } = useQuery({
    queryKey: ["customer-statement", cid, applied],
    enabled: !!applied.customerId,
    queryFn: () => salesAnalyticsApi.customerStatement(cid, Number(applied.customerId), applied.from, applied.to, applied.branchId),
  });

  const customer = (customers as any[]).find(c => String(c.id) === applied.customerId);

  const TYPE_LABEL: Record<string, string> = {
    invoice: tr("typeInvoice"),
    return:  tr("typeReturn"),
    receipt: tr("typeReceipt"),
  };

  const EXPORT_COLS = [
    { key: "date",        header: tr("exportColDate"),    width: 14 },
    { key: "type",        header: tr("exportColType"),    width: 14 },
    { key: "docNumber",   header: tr("exportColDoc"),     width: 16 },
    { key: "description", header: tr("exportColDesc"),    width: 24 },
    { key: "debit",       header: tr("exportColDebit"),   width: 14 },
    { key: "credit",      header: tr("exportColCredit"),  width: 14 },
    { key: "balance",     header: tr("exportColBalance"), width: 16 },
  ];

  const augmented = useMemo(() => {
    const opening = data?.opening ?? 0;
    let bal = opening;
    return (data?.lines ?? []).map(l => {
      bal += l.debit - l.credit;
      return { ...l, balance: bal };
    });
  }, [data]);

  const totals = augmented.reduce((s, l) => ({ debit: s.debit + l.debit, credit: s.credit + l.credit }), { debit: 0, credit: 0 });
  const closing = (data?.opening ?? 0) + totals.debit - totals.credit;

  const exportRows = [
    ...(applied.customerId ? [{
      date: applied.from, type: "—", docNumber: "—", description: tr("openingRow"),
      debit: data?.opening && data.opening > 0 ? fmt(data.opening) : "",
      credit: data?.opening && data.opening < 0 ? fmt(-data.opening) : "",
      balance: fmt(data?.opening ?? 0),
    }] : []),
    ...augmented.map(l => ({
      date:        l.date,
      type:        TYPE_LABEL[l.type] ?? l.type,
      docNumber:   l.docNumber ?? "—",
      description: l.description,
      debit:       l.debit ? fmt(l.debit) : "",
      credit:      l.credit ? fmt(l.credit) : "",
      balance:     fmt(l.balance),
    })),
  ];

  const customerLabel = customer ? pickName(customer.nameAr, customer.nameEn) : "";

  // ─── Grand-totals row (printed at the bottom of the table tfoot)
  // Mirrors the on-screen tfoot so the printed/exported file shows
  // the standard "الإجمالي" line right under the last entry.
  const exportTotalsRow = (applied.customerId && !isLoading && augmented.length > 0)
    ? {
        date:        "",
        type:        "",
        docNumber:   "",
        description: tr("totalLabel"),
        debit:       fmt(totals.debit),
        credit:      fmt(totals.credit),
        balance:     fmt(closing),
      }
    : null;

  // ─── Summary footer cards under the table for the printed view.
  // Classic Arabic accounting footer: previous balance | movement
  // (debit/credit) | closing balance — same numbers as the on-screen
  // KPI cards but rendered inline with the table so they sit on the
  // same printed page as the data they summarize.
  const exportSummaryFooter = (applied.customerId && !isLoading)
    ? [
        { label: tr("opening"),     value: fmt(data?.opening ?? 0), tone: "default" as const },
        { label: tr("totalDebit"),  value: fmt(totals.debit),       tone: "debit"   as const },
        { label: tr("totalCredit"), value: fmt(totals.credit),      tone: "credit"  as const },
        { label: tr("closing"),     value: fmt(closing),            tone: "primary" as const },
      ]
    : null;

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FileText className="h-6 w-6 text-primary" />{tr("title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`${tr("exportFilename")}-${customerLabel || "customer"}-${applied.from}-${applied.to}`}
          title={tr("exportTitle")}
          subtitle={customer ? `${customerLabel}  |  ${applied.from} → ${applied.to}` : tr("exportSubtitlePick")}
          totalsRow={exportTotalsRow}
          summaryFooter={exportSummaryFooter}
        />
      </div>

      {/* Filters */}
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{tr("filtersTitle")}</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="space-y-1.5">
            <Label>{tr("customerLabel")} <span className="text-red-500">*</span></Label>
            <SearchCombobox
              items={(customers as any[]).map(c => ({ value: String(c.id), label: pickName(c.nameAr, c.nameEn), labelEn: c.nameEn }))}
              value={filters.customerId}
              onValueChange={v => setFilters(p => ({ ...p, customerId: v }))}
              placeholder={tr("selectCustomer")}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("salesReports.common.from")}</Label>
            <Input type="date" value={filters.from} onChange={e => setFilters(p => ({ ...p, from: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("salesReports.common.to")}</Label>
            <Input type="date" value={filters.to} onChange={e => setFilters(p => ({ ...p, to: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("common.branch")}</Label>
            <BranchFilter value={filters.branchId} onChange={(v) => setFilters(p => ({ ...p, branchId: v }))} />
          </div>
        </div>
        <div className="flex justify-end mt-4">
          <Button size="sm" onClick={() => setApplied({ ...filters })} disabled={!filters.customerId} className="gap-2">
            <Search className="h-3.5 w-3.5" />{tr("show")}
          </Button>
        </div>
      </div>

      {/* Summary */}
      {applied.customerId && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="rounded-xl border bg-card p-4">
            <p className="text-xs text-muted-foreground">{tr("opening")}</p>
            <p className={`text-xl font-bold tabular-nums mt-1 ${(data?.opening ?? 0) >= 0 ? "" : "text-emerald-600"}`}>{fmt(data?.opening ?? 0)}</p>
          </div>
          <div className="rounded-xl border bg-blue-50 border-blue-200 p-4">
            <p className="text-xs text-blue-700">{tr("totalDebit")}</p>
            <p className="text-xl font-bold text-blue-700 tabular-nums mt-1">{fmt(totals.debit)}</p>
          </div>
          <div className="rounded-xl border bg-emerald-50 border-emerald-200 p-4">
            <p className="text-xs text-emerald-700">{tr("totalCredit")}</p>
            <p className="text-xl font-bold text-emerald-700 tabular-nums mt-1">{fmt(totals.credit)}</p>
          </div>
          <div className="rounded-xl border bg-primary/5 border-primary/10 p-4">
            <p className="text-xs text-muted-foreground">{tr("closing")}</p>
            <p className={`text-xl font-bold tabular-nums mt-1 ${closing >= 0 ? "" : "text-emerald-600"}`}>{fmt(closing)}</p>
          </div>
        </div>
      )}

      {/* Table */}
      {applied.customerId ? (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[700px]">
              <thead className="bg-muted/50 border-b">
                <tr>
                  <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colDate")}</th>
                  <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colType")}</th>
                  <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colDoc")}</th>
                  <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colDescription")}</th>
                  <th className="px-4 py-3 text-center font-semibold text-blue-700">{tr("colDebit")}</th>
                  <th className="px-4 py-3 text-center font-semibold text-emerald-700">{tr("colCredit")}</th>
                  <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{tr("colBalance")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {/* Opening */}
                <tr className="bg-muted/20">
                  <td className="px-4 py-3 tabular-nums text-xs text-muted-foreground">{applied.from}</td>
                  <td className="px-4 py-3 text-xs italic text-muted-foreground" colSpan={3}>{tr("openingRow")}</td>
                  <td className="px-4 py-3 text-center tabular-nums text-xs">{(data?.opening ?? 0) > 0 ? fmt(data!.opening) : "—"}</td>
                  <td className="px-4 py-3 text-center tabular-nums text-xs">{(data?.opening ?? 0) < 0 ? fmt(-(data!.opening)) : "—"}</td>
                  <td className="px-4 py-3 text-center tabular-nums text-sm font-bold">{fmt(data?.opening ?? 0)}</td>
                </tr>
                {isLoading
                  ? [...Array(5)].map((_, i) => <tr key={i}><td colSpan={7} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                  : augmented.length === 0
                  ? <tr><td colSpan={7} className="py-12 text-center text-muted-foreground">{tr("noRows")}</td></tr>
                  : augmented.map((l, idx) => (
                      <tr key={idx} className="hover:bg-muted/20">
                        <td className="px-4 py-3 tabular-nums text-xs text-muted-foreground">{l.date}</td>
                        <td className="px-4 py-3 text-xs">{TYPE_LABEL[l.type] ?? l.type}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground font-mono">{l.docNumber ?? "—"}</td>
                        <td className="px-4 py-3 text-xs">{l.description}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-sm font-bold text-blue-600">{l.debit ? fmt(l.debit) : "—"}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-sm font-bold text-emerald-600">{l.credit ? fmt(l.credit) : "—"}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-sm font-bold">{fmt(l.balance)}</td>
                      </tr>
                    ))}
              </tbody>
              {!isLoading && augmented.length > 0 && (
                <tfoot className="bg-muted/30 border-t">
                  <tr>
                    <td colSpan={4} className="px-4 py-3 text-xs font-semibold text-muted-foreground">{tr("totalLabel")}</td>
                    <td className="px-4 py-3 text-center font-bold tabular-nums text-blue-700">{fmt(totals.debit)}</td>
                    <td className="px-4 py-3 text-center font-bold tabular-nums text-emerald-700">{fmt(totals.credit)}</td>
                    <td className="px-4 py-3 text-center font-bold tabular-nums">{fmt(closing)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {/* Account summary footer — classic Arabic accounting bar:
              previous balance | debit movement | credit movement | closing.
              Mirrors what gets printed at the bottom of the PDF/Print view
              so the user sees the same recap on screen and on paper. */}
          {!isLoading && (
            <div className="border-t bg-gradient-to-r from-slate-50 to-slate-100/60 px-4 py-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
                <div className="rounded-lg border bg-white px-3 py-2.5 text-center">
                  <div className="text-[10px] text-muted-foreground mb-1 font-medium">{tr("opening")}</div>
                  <div className="text-base font-bold tabular-nums text-slate-800" dir="ltr">{fmt(data?.opening ?? 0)}</div>
                </div>
                <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2.5 text-center">
                  <div className="text-[10px] text-blue-700 mb-1 font-medium">{tr("totalDebit")}</div>
                  <div className="text-base font-bold tabular-nums text-blue-700" dir="ltr">{fmt(totals.debit)}</div>
                </div>
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-center">
                  <div className="text-[10px] text-emerald-700 mb-1 font-medium">{tr("totalCredit")}</div>
                  <div className="text-base font-bold tabular-nums text-emerald-700" dir="ltr">{fmt(totals.credit)}</div>
                </div>
                <div className="rounded-lg border border-green-300 bg-green-50 px-3 py-2.5 text-center">
                  <div className="text-[10px] text-green-800 mb-1 font-medium">{tr("closing")}</div>
                  <div className="text-base font-bold tabular-nums text-green-800" dir="ltr">{fmt(closing)}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-xl border bg-card p-12 text-center text-muted-foreground">
          <FileText className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p>{tr("selectCustomerPrompt")}</p>
        </div>
      )}
    </div>
  );
}
