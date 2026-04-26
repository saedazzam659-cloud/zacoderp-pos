import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { cashAnalyticsApi } from "@/lib/cashAnalyticsApi";
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

export default function CashBoxStatement() {
  const { fmt } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [filters, setFilters] = useState<{ from: string; to: string; cashBoxId: string; branchId?: number }>({ from: firstDay, to: today, cashBoxId: "", branchId: undefined });
  const [applied, setApplied] = useState<{ from: string; to: string; cashBoxId: string; branchId?: number }>({ from: firstDay, to: today, cashBoxId: "", branchId: undefined });

  const TYPE_LABEL: Record<string, string> = {
    receipt:      t("cashReports.cashBoxStatement.type.receipt"),
    payment:      t("cashReports.cashBoxStatement.type.payment"),
    transfer_in:  t("cashReports.cashBoxStatement.type.transfer_in"),
    transfer_out: t("cashReports.cashBoxStatement.type.transfer_out"),
  };

  const COLS = [
    { key: "date",        header: t("cashReports.common.date"),         width: 14 },
    { key: "type",        header: t("cashReports.common.movementType"), width: 14 },
    { key: "docNumber",   header: t("cashReports.common.docNumber"),    width: 16 },
    { key: "description", header: t("cashReports.common.description"),  width: 28 },
    { key: "debit",       header: t("cashReports.common.income"),       width: 14 },
    { key: "credit",      header: t("cashReports.common.outcome"),      width: 14 },
    { key: "balance",     header: t("cashReports.common.balance"),      width: 16 },
  ];

  const { data: boxes = [] } = useQuery({
    queryKey: ["cash-boxes", cid],
    queryFn: async () => {
      const r = await fetch(cid ? `${API}/api/cash-boxes?companyId=${cid}` : `${API}/api/cash-boxes`, { headers: authHeaders() });
      return r.json();
    },
  });

  const { data, isLoading } = useQuery({
    queryKey: ["cash-box-statement", cid, applied],
    enabled: !!applied.cashBoxId,
    queryFn: () => cashAnalyticsApi.cashBoxStatement(cid, Number(applied.cashBoxId), applied.from, applied.to, applied.branchId),
  });

  const box = (boxes as any[]).find(b => String(b.id) === applied.cashBoxId);
  const boxLabel = box ? (isRtl ? (box.nameAr ?? box.nameEn) : (box.nameEn ?? box.nameAr)) : "";

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
    ...(applied.cashBoxId ? [{
      date: applied.from, type: "—", docNumber: "—", description: t("cashReports.common.openingBalance"),
      debit: data?.opening && data.opening > 0 ? fmt(data.opening) : "",
      credit: data?.opening && data.opening < 0 ? fmt(-data.opening) : "",
      balance: fmt(data?.opening ?? 0),
    }] : []),
    ...augmented.map(l => ({
      date: l.date,
      type: TYPE_LABEL[l.type] ?? l.type,
      docNumber: l.docNumber ?? "—",
      description: l.description,
      debit: l.debit ? fmt(l.debit) : "",
      credit: l.credit ? fmt(l.credit) : "",
      balance: fmt(l.balance),
    })),
  ];

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FileText className="h-6 w-6 text-primary" />{t("cashReports.cashBoxStatement.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("cashReports.cashBoxStatement.subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={COLS}
          filename={`${t("cashReports.cashBoxStatement.filename")}-${boxLabel}-${applied.from}-${applied.to}`}
          title={t("cashReports.cashBoxStatement.exportTitle")}
          subtitle={box ? `${boxLabel}  |  ${applied.from} → ${applied.to}` : t("cashReports.cashBoxStatement.selectCashBox")}
        />
      </div>

      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("cashReports.common.filtersStatement")}</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="space-y-1.5">
            <Label>{t("cashReports.cashBoxStatement.selectCashBoxLabel")} <span className="text-red-500">*</span></Label>
            <SearchCombobox
              items={(boxes as any[]).map(b => ({ value: String(b.id), label: isRtl ? (b.nameAr ?? b.nameEn) : (b.nameEn ?? b.nameAr), labelEn: b.nameEn }))}
              value={filters.cashBoxId}
              onValueChange={v => setFilters(p => ({ ...p, cashBoxId: v }))}
              placeholder={t("cashReports.cashBoxStatement.selectCashBoxPh")}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("cashReports.common.fromDate")}</Label>
            <Input type="date" value={filters.from} onChange={e => setFilters(p => ({ ...p, from: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("cashReports.common.toDate")}</Label>
            <Input type="date" value={filters.to} onChange={e => setFilters(p => ({ ...p, to: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("common.branch")}</Label>
            <BranchFilter value={filters.branchId} onChange={v => setFilters(p => ({ ...p, branchId: v }))} />
          </div>
        </div>
        <div className="flex justify-end mt-4">
          <Button size="sm" onClick={() => setApplied({ ...filters })} disabled={!filters.cashBoxId} className="gap-2">
            <Search className="h-3.5 w-3.5" />{t("cashReports.common.showStatement")}
          </Button>
        </div>
      </div>

      {applied.cashBoxId && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="rounded-xl border bg-card p-4">
            <p className="text-xs text-muted-foreground">{t("cashReports.common.openingBalance")}</p>
            <p className="text-xl font-bold tabular-nums mt-1">{fmt(data?.opening ?? 0)}</p>
          </div>
          <div className="rounded-xl border bg-emerald-50 border-emerald-200 p-4">
            <p className="text-xs text-emerald-700">{t("cashReports.common.totalIn")}</p>
            <p className="text-xl font-bold text-emerald-700 tabular-nums mt-1">{fmt(totals.debit)}</p>
          </div>
          <div className="rounded-xl border bg-rose-50 border-rose-200 p-4">
            <p className="text-xs text-rose-700">{t("cashReports.common.totalOut")}</p>
            <p className="text-xl font-bold text-rose-700 tabular-nums mt-1">{fmt(totals.credit)}</p>
          </div>
          <div className="rounded-xl border bg-primary/5 border-primary/10 p-4">
            <p className="text-xs text-muted-foreground">{t("cashReports.common.closingBalance")}</p>
            <p className="text-xl font-bold tabular-nums mt-1">{fmt(closing)}</p>
          </div>
        </div>
      )}

      {applied.cashBoxId ? (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[700px]">
              <thead className="bg-muted/50 border-b">
                <tr>
                  <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{t("cashReports.common.date")}</th>
                  <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{t("cashReports.common.movementType")}</th>
                  <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{t("cashReports.common.docNumber")}</th>
                  <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{t("cashReports.common.description")}</th>
                  <th className="px-4 py-3 text-center font-semibold text-emerald-700">{t("cashReports.common.income")}</th>
                  <th className="px-4 py-3 text-center font-semibold text-rose-700">{t("cashReports.common.outcome")}</th>
                  <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{t("cashReports.common.balance")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                <tr className="bg-muted/20">
                  <td className="px-4 py-3 tabular-nums text-xs text-muted-foreground">{applied.from}</td>
                  <td className="px-4 py-3 text-xs italic text-muted-foreground" colSpan={3}>{t("cashReports.common.openingBalance")}</td>
                  <td className="px-4 py-3 text-center tabular-nums text-xs">{(data?.opening ?? 0) > 0 ? fmt(data!.opening) : "—"}</td>
                  <td className="px-4 py-3 text-center tabular-nums text-xs">{(data?.opening ?? 0) < 0 ? fmt(-(data!.opening)) : "—"}</td>
                  <td className="px-4 py-3 text-center tabular-nums text-sm font-bold">{fmt(data?.opening ?? 0)}</td>
                </tr>
                {isLoading
                  ? [...Array(5)].map((_, i) => <tr key={i}><td colSpan={7} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                  : augmented.length === 0
                  ? <tr><td colSpan={7} className="py-12 text-center text-muted-foreground">{t("cashReports.cashBoxStatement.noTx")}</td></tr>
                  : augmented.map((l, idx) => (
                      <tr key={idx} className="hover:bg-muted/20">
                        <td className="px-4 py-3 tabular-nums text-xs text-muted-foreground">{l.date}</td>
                        <td className="px-4 py-3 text-xs">{TYPE_LABEL[l.type] ?? l.type}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground font-mono">{l.docNumber ?? "—"}</td>
                        <td className="px-4 py-3 text-xs">{l.description}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-sm font-bold text-emerald-600">{l.debit ? fmt(l.debit) : "—"}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-sm font-bold text-rose-600">{l.credit ? fmt(l.credit) : "—"}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-sm font-bold">{fmt(l.balance)}</td>
                      </tr>
                    ))}
              </tbody>
              {!isLoading && augmented.length > 0 && (
                <tfoot className="bg-muted/30 border-t">
                  <tr>
                    <td colSpan={4} className="px-4 py-3 text-xs font-semibold text-muted-foreground">{t("cashReports.common.totalRow")}</td>
                    <td className="px-4 py-3 text-center font-bold tabular-nums text-emerald-700">{fmt(totals.debit)}</td>
                    <td className="px-4 py-3 text-center font-bold tabular-nums text-rose-700">{fmt(totals.credit)}</td>
                    <td className="px-4 py-3 text-center font-bold tabular-nums">{fmt(closing)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border bg-card p-12 text-center text-muted-foreground">
          <FileText className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p>{t("cashReports.cashBoxStatement.selectFirst")}</p>
        </div>
      )}
    </div>
  );
}
