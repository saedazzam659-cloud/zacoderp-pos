import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { purchaseAnalyticsApi } from "@/lib/purchaseAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchCombobox } from "@/components/ui/search-combobox";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import AccountStatementView from "@/components/AccountStatementView";
import { useTranslation } from "react-i18next";
import { FileText, Search, Filter } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";

const API = import.meta.env.VITE_API_URL ?? "";
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

export default function SupplierStatement() {
  const { fmt } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [filters, setFilters] = useState<{ from: string; to: string; supplierId: string; branchId?: number }>({ from: firstDay, to: today, supplierId: "", branchId: undefined });
  const [applied, setApplied] = useState<{ from: string; to: string; supplierId: string; branchId?: number }>({ from: firstDay, to: today, supplierId: "", branchId: undefined });

  const TYPE_LABEL: Record<string, string> = {
    invoice: t("purchasingReports.supplierStatement.type.invoice"),
    return:  t("purchasingReports.supplierStatement.type.return"),
    payment: t("purchasingReports.supplierStatement.type.payment"),
  };

  const EXPORT_COLS = [
    { key: "date",        header: t("purchasingPages.common.date"),         width: 14 },
    { key: "type",        header: t("purchasingPages.common.movementType"), width: 14 },
    { key: "docNumber",   header: t("purchasingPages.common.docNumber"),    width: 16 },
    { key: "description", header: t("purchasingPages.common.description"),  width: 24 },
    { key: "debit",       header: t("purchasingPages.common.debit"),        width: 14 },
    { key: "credit",      header: t("purchasingPages.common.credit"),       width: 14 },
    { key: "balance",     header: t("purchasingPages.common.balance"),      width: 16 },
  ];

  const { data: suppliers = [] } = useQuery({
    queryKey: ["suppliers", cid],
    queryFn: async () => {
      const r = await fetch(cid ? `${API}/api/suppliers?companyId=${cid}` : `${API}/api/suppliers`, { headers: authHeaders() });
      return r.json();
    },
  });

  const { data, isLoading } = useQuery({
    queryKey: ["supplier-statement", cid, applied],
    enabled: !!applied.supplierId,
    queryFn: () => purchaseAnalyticsApi.supplierStatement(cid, Number(applied.supplierId), applied.from, applied.to, applied.branchId),
  });

  const supplier = (suppliers as any[]).find(s => String(s.id) === applied.supplierId);
  const supplierLabel = supplier ? (isRtl ? (supplier.nameAr ?? supplier.nameEn) : (supplier.nameEn ?? supplier.nameAr)) : "";

  const augmented = useMemo(() => {
    const opening = data?.opening ?? 0;
    let bal = opening;
    return (data?.lines ?? []).map(l => {
      bal += l.credit - l.debit;
      return { ...l, balance: bal };
    });
  }, [data]);

  const totals = augmented.reduce((s, l) => ({ debit: s.debit + l.debit, credit: s.credit + l.credit }), { debit: 0, credit: 0 });
  const closing = (data?.opening ?? 0) + totals.credit - totals.debit;

  const exportRows = [
    ...(applied.supplierId ? [{
      date: applied.from, type: "—", docNumber: "—", description: t("purchasingPages.common.openingBalance"),
      debit: data?.opening && data.opening < 0 ? fmt(-data.opening) : "",
      credit: data?.opening && data.opening > 0 ? fmt(data.opening) : "",
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

  // Grand-totals row mirrored into the printed/exported tfoot so the
  // standard "الإجمالي" line appears at the bottom of the table.
  const exportTotalsRow = (applied.supplierId && !isLoading && augmented.length > 0)
    ? {
        date:        "",
        type:        "",
        docNumber:   "",
        description: t("purchasingPages.common.total"),
        debit:       fmt(totals.debit),
        credit:      fmt(totals.credit),
        balance:     fmt(closing),
      }
    : null;

  // Summary footer cards (opening / debit / credit / closing) for the printed view —
  // labels mirror the on-screen KPI cards above the table.
  const exportSummaryFooter = (applied.supplierId && !isLoading)
    ? [
        { label: t("purchasingReports.supplierStatement.openingBalance"),  value: fmt(data?.opening ?? 0), tone: "default" as const },
        { label: t("purchasingReports.supplierStatement.totalDebitDesc"),  value: fmt(totals.debit),       tone: "debit"   as const },
        { label: t("purchasingReports.supplierStatement.totalCreditDesc"), value: fmt(totals.credit),      tone: "credit"  as const },
        { label: t("purchasingReports.supplierStatement.finalBalanceDesc"), value: fmt(closing),           tone: "primary" as const },
      ]
    : null;

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FileText className="h-6 w-6 text-primary" />{t("purchasingReports.supplierStatement.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("purchasingReports.supplierStatement.subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`${t("purchasingReports.supplierStatement.filename")}-${supplierLabel}-${applied.from}-${applied.to}`}
          title={t("purchasingReports.supplierStatement.exportTitle")}
          subtitle={supplier ? `${supplierLabel}  |  ${applied.from} → ${applied.to}` : t("purchasingReports.supplierStatement.selectSupplier")}
          totalsRow={exportTotalsRow}
          summaryFooter={exportSummaryFooter}
        />
      </div>

      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("purchasingReports.supplierStatement.filtersTitle")}</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="space-y-1.5">
            <Label>{t("purchasingReports.supplierStatement.supplier")} <span className="text-red-500">*</span></Label>
            <SearchCombobox
              items={(suppliers as any[]).map(s => ({ value: String(s.id), label: isRtl ? (s.nameAr ?? s.nameEn) : (s.nameEn ?? s.nameAr), labelEn: s.nameEn }))}
              value={filters.supplierId}
              onValueChange={v => setFilters(p => ({ ...p, supplierId: v }))}
              placeholder={t("purchasingReports.supplierStatement.supplierPh")}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("purchasingPages.common.fromDate")}</Label>
            <Input type="date" value={filters.from} onChange={e => setFilters(p => ({ ...p, from: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("purchasingPages.common.toDate")}</Label>
            <Input type="date" value={filters.to} onChange={e => setFilters(p => ({ ...p, to: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("common.branch")}</Label>
            <BranchFilter value={filters.branchId} onChange={(v) => setFilters(p => ({ ...p, branchId: v }))} />
          </div>
        </div>
        <div className="flex justify-end mt-4">
          <Button size="sm" onClick={() => setApplied({ ...filters })} disabled={!filters.supplierId} className="gap-2">
            <Search className="h-3.5 w-3.5" />{t("purchasingPages.common.showStatement")}
          </Button>
        </div>
      </div>

      {applied.supplierId && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="rounded-xl border bg-card p-4">
            <p className="text-xs text-muted-foreground">{t("purchasingReports.supplierStatement.openingBalance")}</p>
            <p className="text-xl font-bold tabular-nums mt-1">{fmt(data?.opening ?? 0)}</p>
          </div>
          <div className="rounded-xl border bg-blue-50 border-blue-200 p-4">
            <p className="text-xs text-blue-700">{t("purchasingReports.supplierStatement.totalDebitDesc")}</p>
            <p className="text-xl font-bold text-blue-700 tabular-nums mt-1">{fmt(totals.debit)}</p>
          </div>
          <div className="rounded-xl border bg-emerald-50 border-emerald-200 p-4">
            <p className="text-xs text-emerald-700">{t("purchasingReports.supplierStatement.totalCreditDesc")}</p>
            <p className="text-xl font-bold text-emerald-700 tabular-nums mt-1">{fmt(totals.credit)}</p>
          </div>
          <div className="rounded-xl border bg-primary/5 border-primary/10 p-4">
            <p className="text-xs text-muted-foreground">{t("purchasingReports.supplierStatement.finalBalanceDesc")}</p>
            <p className="text-xl font-bold tabular-nums mt-1">{fmt(closing)}</p>
          </div>
        </div>
      )}

      {applied.supplierId ? (
        isLoading ? (
          <div className="rounded-xl border bg-card p-6 space-y-3">
            {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        ) : (
          <AccountStatementView
            mode="supplier"
            company={user?.company ?? null}
            account={{
              code: supplier?.code || (supplier ? `SUP-${String(supplier.id).padStart(6, "0")}` : null),
              nameAr: supplier?.nameAr,
              nameEn: supplier?.nameEn,
              legalName: supplier?.nameEn || supplier?.nameAr,
              level: 5,
            }}
            from={applied.from}
            to={applied.to}
            opening={data?.opening ?? 0}
            lines={augmented.map(l => ({
              date: l.date,
              type: TYPE_LABEL[l.type] ?? l.type,
              docNumber: l.docNumber,
              description: l.description,
              debit: l.debit,
              credit: l.credit,
              balance: l.balance,
            }))}
            totals={totals}
            closing={closing}
          />
        )
      ) : (
        <div className="rounded-xl border bg-card p-12 text-center text-muted-foreground">
          <FileText className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p>{t("purchasingReports.supplierStatement.selectSupplierFirst")}</p>
        </div>
      )}
    </div>
  );
}
