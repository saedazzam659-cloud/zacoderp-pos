import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { cashAnalyticsApi, type StatementLine } from "@/lib/cashAnalyticsApi";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchCombobox } from "@/components/ui/search-combobox";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import { useTranslation } from "react-i18next";
import { Banknote, Search, Filter } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import { DateField } from "@/components/ui/date-field";
import AdvancedReportGrid, { type GridColumn } from "@/components/auditGrid/AdvancedReportGrid";

type StatementRow = StatementLine & { balance: number };

const API = import.meta.env.VITE_API_URL ?? "";
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

export default function BankAccountStatement() {
  const { fmt } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const [, navigate] = useLocation();
  const tr = (k: string, opts?: any) => t(`cashReports.bankStatement.${k}`, opts) as string;
  const trc = (k: string, opts?: any) => t(`cashReports.common.${k}`, opts) as string;
  const pickName = (r: { nameAr?: string | null; nameEn?: string | null } | undefined) =>
    !r ? "" : (isRtl ? (r.nameAr ?? r.nameEn ?? "") : (r.nameEn ?? r.nameAr ?? ""));
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const TYPE_LABEL: Record<string, string> = {
    receipt:      tr("type.receipt"),
    payment:      tr("type.payment"),
    transfer_in:  tr("type.transfer_in"),
    transfer_out: tr("type.transfer_out"),
  };

  const COLS = [
    { key: "date",        header: trc("date"),        width: 14 },
    { key: "type",        header: trc("movementType"), width: 18 },
    { key: "docNumber",   header: trc("docNumber"),    width: 16 },
    { key: "description", header: trc("description"),  width: 28 },
    { key: "debit",       header: trc("income"),       width: 14 },
    { key: "credit",      header: trc("outcome"),      width: 14 },
    { key: "balance",     header: trc("balance"),      width: 16 },
  ];

  const [filters, setFilters] = useState<{ from: string; to: string; bankAccountId: string; branchId?: number }>({ from: firstDay, to: today, bankAccountId: "", branchId: undefined });
  const [applied, setApplied] = useState<{ from: string; to: string; bankAccountId: string; branchId?: number }>({ from: firstDay, to: today, bankAccountId: "", branchId: undefined });

  const { data: banks = [] } = useQuery({
    queryKey: ["bank-accounts", cid],
    queryFn: async () => {
      const r = await fetch(cid ? `${API}/api/bank-accounts?companyId=${cid}` : `${API}/api/bank-accounts`, { headers: authHeaders() });
      return r.json();
    },
  });

  const { data, isLoading } = useQuery({
    queryKey: ["bank-statement", cid, applied],
    enabled: !!applied.bankAccountId,
    queryFn: () => cashAnalyticsApi.bankStatement(cid, Number(applied.bankAccountId), applied.from, applied.to, applied.branchId),
  });

  const bank = (banks as any[]).find(b => String(b.id) === applied.bankAccountId);

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

  const dash = trc("noneCharDash");

  // Double-click a row → open the underlying source document in edit mode.
  // Transfers have no per-id edit form, so they land on the transfers list.
  const openSource = (l: StatementRow) => {
    if (l.type === "receipt")      navigate(`/cash/receipt-vouchers/${l.id}`);
    else if (l.type === "payment") navigate(`/cash/payment-vouchers/${l.id}`);
    else                           navigate(`/cash/transfers`);
  };

  const gridColumns: GridColumn<StatementRow>[] = [
    { key: "date",        label: trc("date"),         type: "text", value: l => l.date,
      className: "tabular-nums text-xs text-muted-foreground" },
    { key: "type",        label: trc("movementType"), type: "text",
      value: l => TYPE_LABEL[l.type] ?? l.type },
    { key: "docNumber",   label: trc("docNumber"),    type: "text",
      value: l => l.docNumber ?? dash, className: "font-mono text-xs text-muted-foreground" },
    { key: "description", label: trc("description"),  type: "text", value: l => l.description },
    { key: "debit",       label: trc("income"),       type: "num", align: "center", totalable: true,
      value: l => l.debit, render: l => <span className="font-bold text-emerald-600 tabular-nums">{l.debit ? fmt(l.debit) : dash}</span> },
    { key: "credit",      label: trc("outcome"),      type: "num", align: "center", totalable: true,
      value: l => l.credit, render: l => <span className="font-bold text-rose-600 tabular-nums">{l.credit ? fmt(l.credit) : dash}</span> },
    { key: "balance",     label: trc("balance"),      type: "num", align: "center",
      value: l => l.balance, render: l => <span className="font-bold tabular-nums">{fmt(l.balance)}</span> },
  ];

  const exportRows = [
    ...(applied.bankAccountId ? [{
      date: applied.from, type: dash, docNumber: dash, description: trc("openingBalance"),
      debit: data?.opening && data.opening > 0 ? fmt(data.opening) : "",
      credit: data?.opening && data.opening < 0 ? fmt(-data.opening) : "",
      balance: fmt(data?.opening ?? 0),
    }] : []),
    ...augmented.map(l => ({
      date: l.date,
      type: TYPE_LABEL[l.type] ?? l.type,
      docNumber: l.docNumber ?? dash,
      description: l.description,
      debit: l.debit ? fmt(l.debit) : "",
      credit: l.credit ? fmt(l.credit) : "",
      balance: fmt(l.balance),
    })),
  ];

  // Grand-totals row mirrored into the printed/exported tfoot so the
  // standard "الإجمالي" line appears at the bottom of the table.
  const exportTotalsRow = (applied.bankAccountId && !isLoading && augmented.length > 0)
    ? {
        date:        "",
        type:        "",
        docNumber:   "",
        description: trc("totalRow"),
        debit:       fmt(totals.debit),
        credit:      fmt(totals.credit),
        balance:     fmt(closing),
      }
    : null;

  // Summary footer cards (opening / income / outcome / closing) for the printed view.
  const exportSummaryFooter = (applied.bankAccountId && !isLoading)
    ? [
        { label: trc("openingBalance"), value: fmt(data?.opening ?? 0), tone: "default" as const },
        { label: trc("totalIn"),        value: fmt(totals.debit),       tone: "credit"  as const },
        { label: trc("totalOut"),       value: fmt(totals.credit),      tone: "debit"   as const },
        { label: trc("closingBalance"), value: fmt(closing),            tone: "primary" as const },
      ]
    : null;

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Banknote className="h-6 w-6 text-primary" />{tr("title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={COLS}
          filename={`${tr("filename")}-${pickName(bank) || ""}-${applied.from}-${applied.to}`}
          title={tr("exportTitle")}
          subtitle={bank ? `${pickName(bank)}  |  ${applied.from} → ${applied.to}` : tr("selectBankPh")}
          totalsRow={exportTotalsRow}
          summaryFooter={exportSummaryFooter}
        />
      </div>

      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{trc("filtersStatement")}</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="space-y-1.5">
            <Label>{tr("selectBankLabel")} <span className="text-red-500">*</span></Label>
            <SearchCombobox
              items={(banks as any[]).map(b => ({ value: String(b.id), label: b.nameAr, labelEn: b.nameEn }))}
              value={filters.bankAccountId}
              onValueChange={v => setFilters(p => ({ ...p, bankAccountId: v }))}
              placeholder={tr("selectBankPh")}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{trc("fromDate")}</Label>
            <DateField value={filters.from} onChange={e => setFilters(p => ({ ...p, from: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>{trc("toDate")}</Label>
            <DateField value={filters.to} onChange={e => setFilters(p => ({ ...p, to: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("common.branch")}</Label>
            <BranchFilter value={filters.branchId} onChange={v => setFilters(p => ({ ...p, branchId: v }))} />
          </div>
        </div>
        <div className="flex justify-end mt-4">
          <Button size="sm" onClick={() => setApplied({ ...filters })} disabled={!filters.bankAccountId} className="gap-2">
            <Search className="h-3.5 w-3.5" />{trc("showStatement")}
          </Button>
        </div>
      </div>

      {applied.bankAccountId && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="rounded-xl border bg-card p-4">
            <p className="text-xs text-muted-foreground">{trc("openingBalance")}</p>
            <p className="text-xl font-bold tabular-nums mt-1">{fmt(data?.opening ?? 0)}</p>
          </div>
          <div className="rounded-xl border bg-emerald-50 border-emerald-200 p-4">
            <p className="text-xs text-emerald-700">{trc("totalIn")}</p>
            <p className="text-xl font-bold text-emerald-700 tabular-nums mt-1">{fmt(totals.debit)}</p>
          </div>
          <div className="rounded-xl border bg-rose-50 border-rose-200 p-4">
            <p className="text-xs text-rose-700">{trc("totalOut")}</p>
            <p className="text-xl font-bold text-rose-700 tabular-nums mt-1">{fmt(totals.credit)}</p>
          </div>
          <div className="rounded-xl border bg-primary/5 border-primary/10 p-4">
            <p className="text-xs text-muted-foreground">{trc("closingBalance")}</p>
            <p className="text-xl font-bold tabular-nums mt-1">{fmt(closing)}</p>
          </div>
        </div>
      )}

      {applied.bankAccountId ? (
        <>
          {/* Interactive grid (screen only). Double-click a row → source doc. */}
          <div className="print:hidden">
            {isLoading ? (
              <div className="rounded-xl border bg-card p-4 space-y-2">
                {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}
              </div>
            ) : (
              <AdvancedReportGrid
                slug="bankAccountStatementGrid"
                cid={cid}
                columns={gridColumns}
                rowKey={(l, i) => `${l.type}-${l.id}-${i}`}
                rows={augmented}
                onRowDoubleClick={openSource}
                unitLabel={t("cashReports.common.movementUnit", "حركة")}
                emptyMessage={tr("noTx")}
                leadingRows={[{
                  date: applied.from,
                  type: trc("openingBalance"),
                  debit: (data?.opening ?? 0) > 0 ? fmt(data!.opening) : dash,
                  credit: (data?.opening ?? 0) < 0 ? fmt(-(data!.opening)) : dash,
                  balance: <span className="font-bold tabular-nums">{fmt(data?.opening ?? 0)}</span>,
                }]}
                totalsRow={augmented.length > 0 ? {
                  __label: trc("totalRow"),
                  debit: <span className="text-emerald-700">{fmt(totals.debit)}</span>,
                  credit: <span className="text-rose-700">{fmt(totals.credit)}</span>,
                  balance: fmt(closing),
                } : null}
              />
            )}
          </div>

        {/* Static table (print only). */}
        <div className="rounded-xl border bg-card overflow-hidden hidden print:block">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[700px]">
              <thead className="bg-muted/50 border-b">
                <tr>
                  <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{trc("date")}</th>
                  <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{trc("movementType")}</th>
                  <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{trc("docNumber")}</th>
                  <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{trc("description")}</th>
                  <th className="px-4 py-3 text-center font-semibold text-emerald-700">{trc("income")}</th>
                  <th className="px-4 py-3 text-center font-semibold text-rose-700">{trc("outcome")}</th>
                  <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{trc("balance")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                <tr className="bg-muted/20">
                  <td className="px-4 py-3 tabular-nums text-xs text-muted-foreground">{applied.from}</td>
                  <td className="px-4 py-3 text-xs italic text-muted-foreground" colSpan={3}>{trc("openingBalance")}</td>
                  <td className="px-4 py-3 text-center tabular-nums text-xs">{(data?.opening ?? 0) > 0 ? fmt(data!.opening) : dash}</td>
                  <td className="px-4 py-3 text-center tabular-nums text-xs">{(data?.opening ?? 0) < 0 ? fmt(-(data!.opening)) : dash}</td>
                  <td className="px-4 py-3 text-center tabular-nums text-sm font-bold">{fmt(data?.opening ?? 0)}</td>
                </tr>
                {isLoading
                  ? [...Array(5)].map((_, i) => <tr key={i}><td colSpan={7} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                  : augmented.length === 0
                  ? <tr><td colSpan={7} className="py-12 text-center text-muted-foreground">{tr("noTx")}</td></tr>
                  : augmented.map((l, idx) => (
                      <tr key={idx} className="hover:bg-muted/20">
                        <td className="px-4 py-3 tabular-nums text-xs text-muted-foreground">{l.date}</td>
                        <td className="px-4 py-3 text-xs">{TYPE_LABEL[l.type] ?? l.type}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground font-mono">{l.docNumber ?? dash}</td>
                        <td className="px-4 py-3 text-xs">{l.description}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-sm font-bold text-emerald-600">{l.debit ? fmt(l.debit) : dash}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-sm font-bold text-rose-600">{l.credit ? fmt(l.credit) : dash}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-sm font-bold">{fmt(l.balance)}</td>
                      </tr>
                    ))}
              </tbody>
              {!isLoading && augmented.length > 0 && (
                <tfoot className="bg-muted/30 border-t">
                  <tr>
                    <td colSpan={4} className="px-4 py-3 text-xs font-semibold text-muted-foreground">{trc("totalRow")}</td>
                    <td className="px-4 py-3 text-center font-bold tabular-nums text-emerald-700">{fmt(totals.debit)}</td>
                    <td className="px-4 py-3 text-center font-bold tabular-nums text-rose-700">{fmt(totals.credit)}</td>
                    <td className="px-4 py-3 text-center font-bold tabular-nums">{fmt(closing)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
        </>
      ) : (
        <div className="rounded-xl border bg-card p-12 text-center text-muted-foreground">
          <Banknote className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p>{tr("selectFirst")}</p>
        </div>
      )}
    </div>
  );
}
