import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { purchaseAnalyticsApi } from "@/lib/purchaseAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchCombobox } from "@/components/ui/search-combobox";
import StatementExportButtons from "@/components/StatementExportButtons";
import StatementColumnChooser, { useStatementVisibleCols } from "@/components/StatementColumnChooser";
import BranchFilter from "@/components/BranchFilter";
import { useBranches } from "@/hooks/useBranches";
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

  const [filters, setFilters] = useState<{ from: string; to: string; supplierId: string; branchId?: number; withOpening: boolean }>({ from: firstDay, to: today, supplierId: "", branchId: undefined, withOpening: true });
  const [applied, setApplied] = useState<{ from: string; to: string; supplierId: string; branchId?: number; withOpening: boolean }>({ from: firstDay, to: today, supplierId: "", branchId: undefined, withOpening: true });

  // Column visibility for table + exports (persisted separately from
  // customer statement so the two pages can have different layouts).
  const [visibleCols, setVisibleCols] = useStatementVisibleCols("supplier");

  const TYPE_LABEL: Record<string, string> = {
    invoice: t("purchasingReports.supplierStatement.type.invoice"),
    return:  t("purchasingReports.supplierStatement.type.return"),
    payment: t("purchasingReports.supplierStatement.type.payment"),
  };

  /** Supplier-side "نوع الوثيقة" — full categorical label for the new column.
   *  Distinct from TYPE_LABEL (which is just the generic word). */
  const DOC_TYPE_LABEL: Record<string, string> = {
    invoice: "فاتورة مشتريات",
    return:  "مرتجع مشتريات",
    payment: "سند صرف",
  };

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

  // Resolve the selected branch's display name (Arabic preferred in RTL).
  // `undefined` => "all branches" filter => no branch row is rendered/printed.
  const { data: branches = [] } = useBranches();
  const selectedBranch = applied.branchId != null
    ? branches.find(b => b.id === applied.branchId)
    : undefined;
  const branchName = selectedBranch
    ? (isRtl
        ? (selectedBranch.nameAr || selectedBranch.nameEn || selectedBranch.code)
        : (selectedBranch.nameEn || selectedBranch.nameAr || selectedBranch.code))
    : null;

  // Fetch the linked chart-of-accounts row so the printout's "رمز الحساب" /
  // "اسم الحساب" / "مستوى الحساب" come from the GL account (per user spec),
  // not from the supplier record. The supplier's own nameEn drives the new
  // "الاسم اللاتيني" row.
  const { data: linkedAccount } = useQuery<any>({
    queryKey: ["account", supplier?.accountId],
    enabled: !!supplier?.accountId,
    queryFn: async () => {
      const r = await fetch(`${API}/api/accounts/${supplier!.accountId}`, { headers: authHeaders() });
      return r.json();
    },
  });
  const acctView = {
    code:      linkedAccount?.code ?? null,
    nameAr:    linkedAccount?.nameAr ?? null,
    nameEn:    linkedAccount?.nameEn ?? null,
    legalName: supplier?.nameEn ?? null,
    level:     linkedAccount?.level ?? null,
  };

  // Toggle: include carried-forward opening balance, or show period-only
  // movement starting from zero. Affects running balance, summary cards,
  // printable view and all exports. Applied via the same Show button as
  // other filters.
  const effectiveOpening = applied.withOpening ? (data?.opening ?? 0) : 0;

  const augmented = useMemo(() => {
    let bal = effectiveOpening;
    return (data?.lines ?? []).map(l => {
      bal += l.credit - l.debit;
      return { ...l, balance: bal };
    });
  }, [data, effectiveOpening]);

  const totals = augmented.reduce((s, l) => ({ debit: s.debit + l.debit, credit: s.credit + l.credit }), { debit: 0, credit: 0 });
  const closing = effectiveOpening + totals.credit - totals.debit;

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FileText className="h-6 w-6 text-primary" />{t("purchasingReports.supplierStatement.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("purchasingReports.supplierStatement.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <StatementColumnChooser value={visibleCols} onChange={setVisibleCols} />
          <StatementExportButtons
            mode="supplier"
            company={(user?.company as any) ?? null}
            account={acctView}
            from={applied.from}
            to={applied.to}
            opening={effectiveOpening}
            lines={augmented.map(l => ({
              date: l.date,
              docType: DOC_TYPE_LABEL[l.type] ?? (TYPE_LABEL[l.type] ?? l.type),
              type: TYPE_LABEL[l.type] ?? l.type,
              docNumber: l.docNumber,
              description: l.description,
              debit: l.debit,
              credit: l.credit,
              balance: l.balance,
            }))}
            totals={totals}
            closing={closing}
            filename={`${t("purchasingReports.supplierStatement.filename")}-${supplierLabel}-${applied.from}-${applied.to}`}
            disabled={!applied.supplierId || isLoading}
            branchName={branchName}
            visibleCols={visibleCols}
          />
        </div>
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
        {/* Opening-balance toggle: lets the user view the supplier account
            with the carried-forward opening balance (default) or as a
            period-only movement view starting from zero. */}
        <div className="flex items-center gap-2 mt-4">
          <input
            id="ss-with-opening"
            type="checkbox"
            className="h-4 w-4"
            checked={filters.withOpening}
            onChange={e => setFilters(p => ({ ...p, withOpening: e.target.checked }))}
          />
          <Label htmlFor="ss-with-opening" className="cursor-pointer text-sm font-normal">
            {isRtl ? "تضمين الرصيد الافتتاحي" : "Include opening balance"}
          </Label>
        </div>
        <div className="flex justify-end mt-4">
          <Button size="sm" onClick={() => setApplied({ ...filters })} disabled={!filters.supplierId} className="gap-2">
            <Search className="h-3.5 w-3.5" />{t("purchasingPages.common.showStatement")}
          </Button>
        </div>
      </div>

      {applied.supplierId && (
        <div className={`grid grid-cols-2 ${applied.withOpening ? "md:grid-cols-4" : "md:grid-cols-3"} gap-4`}>
          {applied.withOpening && (
            <div className="rounded-xl border bg-card p-4">
              <p className="text-xs text-muted-foreground">{t("purchasingReports.supplierStatement.openingBalance")}</p>
              <p className="text-xl font-bold tabular-nums mt-1">{fmt(data?.opening ?? 0)}</p>
            </div>
          )}
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

      {/* Column-visibility chooser — sits right above the table so it stays
          visible even after the user scrolls past the page header. Hidden in
          print output. */}
      {applied.supplierId && !isLoading && (
        <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2 print:hidden">
          <p className="text-xs text-muted-foreground">
            تحكم في الأعمدة الظاهرة في الجدول والطباعة و Excel و PDF
          </p>
          <StatementColumnChooser value={visibleCols} onChange={setVisibleCols} />
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
            account={acctView}
            from={applied.from}
            to={applied.to}
            branchName={branchName}
            opening={effectiveOpening}
            visibleCols={visibleCols}
            lines={augmented.map(l => ({
              date: l.date,
              docType: DOC_TYPE_LABEL[l.type] ?? (TYPE_LABEL[l.type] ?? l.type),
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
