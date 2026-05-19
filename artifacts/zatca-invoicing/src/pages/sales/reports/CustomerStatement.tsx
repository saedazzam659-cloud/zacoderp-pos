import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { salesAnalyticsApi } from "@/lib/salesAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchCombobox } from "@/components/ui/search-combobox";
import StatementExportButtons from "@/components/StatementExportButtons";
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

  const [filters, setFilters] = useState<{ from: string; to: string; customerId: string; branchId?: number; withOpening: boolean }>({ from: firstDay, to: today, customerId: "", branchId: undefined, withOpening: true });
  const [applied, setApplied] = useState<{ from: string; to: string; customerId: string; branchId?: number; withOpening: boolean }>({ from: firstDay, to: today, customerId: "", branchId: undefined, withOpening: true });

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
  // not from the customer record. The customer's own nameEn still drives the
  // new "الاسم اللاتيني" row.
  const { data: linkedAccount } = useQuery<any>({
    queryKey: ["account", customer?.accountId],
    enabled: !!customer?.accountId,
    queryFn: async () => {
      const r = await fetch(`${API}/api/accounts/${customer!.accountId}`, { headers: authHeaders() });
      return r.json();
    },
  });
  const acctView = {
    code:      linkedAccount?.code ?? null,
    nameAr:    linkedAccount?.nameAr ?? null,
    nameEn:    linkedAccount?.nameEn ?? null,
    legalName: customer?.nameEn ?? null,
    level:     linkedAccount?.level ?? null,
  };

  const TYPE_LABEL: Record<string, string> = {
    invoice: tr("typeInvoice"),
    return:  tr("typeReturn"),
    receipt: tr("typeReceipt"),
  };

  // When the user toggles "بدون رصيد افتتاحي" we treat opening as 0 in every
  // downstream calculation (running balance, summary cards, exports, printable
  // view). Applied via the same Show button as other filters.
  const effectiveOpening = applied.withOpening ? (data?.opening ?? 0) : 0;

  const augmented = useMemo(() => {
    let bal = effectiveOpening;
    return (data?.lines ?? []).map(l => {
      bal += l.debit - l.credit;
      return { ...l, balance: bal };
    });
  }, [data, effectiveOpening]);

  const totals = augmented.reduce((s, l) => ({ debit: s.debit + l.debit, credit: s.credit + l.credit }), { debit: 0, credit: 0 });
  const closing = effectiveOpening + totals.debit - totals.credit;

  const customerLabel = customer ? pickName(customer.nameAr, customer.nameEn) : "";

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FileText className="h-6 w-6 text-primary" />{tr("title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("subtitle")}</p>
        </div>
        <StatementExportButtons
          mode="customer"
          company={(user?.company as any) ?? null}
          account={acctView}
          from={applied.from}
          to={applied.to}
          opening={effectiveOpening}
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
          filename={`${tr("exportFilename")}-${customerLabel || "customer"}-${applied.from}-${applied.to}`}
          disabled={!applied.customerId || isLoading}
          branchName={branchName}
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
        {/* Opening-balance toggle: lets the user view the account either
            with the carried-forward opening balance (default) or as a
            period-only movement view starting from zero. */}
        <div className="flex items-center gap-2 mt-4">
          <input
            id="cs-with-opening"
            type="checkbox"
            className="h-4 w-4"
            checked={filters.withOpening}
            onChange={e => setFilters(p => ({ ...p, withOpening: e.target.checked }))}
          />
          <Label htmlFor="cs-with-opening" className="cursor-pointer text-sm font-normal">
            {isRtl ? "تضمين الرصيد الافتتاحي" : "Include opening balance"}
          </Label>
        </div>
        <div className="flex justify-end mt-4">
          <Button size="sm" onClick={() => setApplied({ ...filters })} disabled={!filters.customerId} className="gap-2">
            <Search className="h-3.5 w-3.5" />{tr("show")}
          </Button>
        </div>
      </div>

      {/* Summary */}
      {applied.customerId && (
        <div className={`grid grid-cols-2 ${applied.withOpening ? "md:grid-cols-4" : "md:grid-cols-3"} gap-4`}>
          {applied.withOpening && (
            <div className="rounded-xl border bg-card p-4">
              <p className="text-xs text-muted-foreground">{tr("opening")}</p>
              <p className={`text-xl font-bold tabular-nums mt-1 ${(data?.opening ?? 0) >= 0 ? "" : "text-emerald-600"}`}>{fmt(data?.opening ?? 0)}</p>
            </div>
          )}
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

      {/* Statement document (printable, classic accounting layout) */}
      {applied.customerId ? (
        isLoading ? (
          <div className="rounded-xl border bg-card p-6 space-y-3">
            {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        ) : (
          <AccountStatementView
            mode="customer"
            company={user?.company ?? null}
            account={acctView}
            from={applied.from}
            to={applied.to}
            branchName={branchName}
            opening={effectiveOpening}
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
          <p>{tr("selectCustomerPrompt")}</p>
        </div>
      )}
    </div>
  );
}
