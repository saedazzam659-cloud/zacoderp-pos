import { useMemo, useState, Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchCombobox } from "@/components/ui/search-combobox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import ExportButtons from "@/components/ExportButtons";
import { useTranslation } from "react-i18next";
import {
  CreditCard, Search, Filter, ChevronDown, ChevronUp,
  Wallet, Receipt, FileText, TrendingUp, Banknote, Layers,
} from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
function authH(): Record<string, string> {
  const t = localStorage.getItem("zatca_token");
  return t ? { Authorization: `Bearer ${t}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

type Transfer = {
  entryId: number; date: string; amount: number;
  sourceType: "bank" | "cash" | null;
  sourceNameAr: string | null;
  sourceNameEn: string | null;
  sourceBankName: string | null;
};
type LcRow = {
  id: number;
  lcNumber: string;
  lcDate: string;
  supplierId: number | null;
  supplierNameAr: string | null;
  supplierNameEn: string | null;
  bankName: string | null;
  currencyCode: string;
  exchangeRate: string;
  totalAmount: string;
  totalAmountBase: string;
  totalExpensesBase: string;
  remainingBase: string;
  usedAmount: string;
  usedBaseFromInvoices: number;
  status: "open" | "partial" | "closed";
  notes: string | null;
  invoiceCount: number;
  fundingTransfers: Transfer[];
  expenses: Array<{
    id: number; expenseType: string; amount: string; currencyCode: string;
    exchangeRate: string; amountBase: string; notes: string | null;
    fundingTransfers: Transfer[];
  }>;
  invoices: Array<{
    id: number; docNumber: string | null; invoiceDate: string; status: string;
    totalAmount: string; vatAmount: string; totalExpensesLoaded: string;
    currencyCode: string; exchangeRate: string;
    totalBase: number; vatBase: number; expensesLoadedBase: number; goodsBase: number;
  }>;
};

function transferLabel(tr: Transfer, isRtl: boolean): string {
  const name = isRtl ? (tr.sourceNameAr ?? tr.sourceNameEn) : (tr.sourceNameEn ?? tr.sourceNameAr);
  if (!name) return "—";
  if (tr.sourceType === "bank" && tr.sourceBankName) return `${name} (${tr.sourceBankName})`;
  return name;
}
function transfersJoined(list: Transfer[] | undefined, isRtl: boolean): string {
  if (!list || list.length === 0) return "—";
  return Array.from(new Set(list.map(t => transferLabel(t, isRtl)))).join(" • ");
}

export default function LcStatement() {
  const { fmt } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: Record<string, unknown>) => t(`purchasingReports.lcStatement.${k}`, opts) as string;
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const today = new Date().toISOString().slice(0, 10);
  const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);

  const [filters, setFilters] = useState<{ from: string; to: string; supplierId: string; status: string }>({
    from: yearStart, to: today, supplierId: "all", status: "all",
  });
  const [applied, setApplied] = useState<typeof filters>(filters);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const STATUS_MAP: Record<string, { label: string; cls: string }> = {
    open:    { label: tr("stOpen"),    cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    partial: { label: tr("stPartial"), cls: "bg-amber-50 text-amber-700 border-amber-200" },
    closed:  { label: tr("stClosed"),  cls: "bg-muted text-muted-foreground border-border" },
  };

  const { data: suppliers = [] } = useQuery<any[]>({
    queryKey: ["suppliers-mini", cid],
    queryFn: async () => {
      const r = await fetch(cid ? `${API}/api/suppliers?companyId=${cid}` : `${API}/api/suppliers`, { headers: authH() });
      return r.json();
    },
  });

  const { data, isLoading } = useQuery<{ rows: LcRow[]; summary: any; baseCurrency: string }>({
    queryKey: ["lc-statement", cid, applied],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (cid) qs.set("companyId", String(cid));
      if (applied.from) qs.set("from", applied.from);
      if (applied.to)   qs.set("to",   applied.to);
      if (applied.supplierId && applied.supplierId !== "all") qs.set("supplierId", applied.supplierId);
      if (applied.status && applied.status !== "all")         qs.set("status",     applied.status);
      const r = await fetch(`${API}/api/purchasing/letters-of-credit/statement?${qs}`, { headers: authH() });
      return r.json();
    },
  });

  const rows = data?.rows ?? [];
  const summary = data?.summary;
  const baseCcy = data?.baseCurrency ?? "SAR";
  const ccyLabel = (c: string) => c === baseCcy ? c : `${c} → ${baseCcy}`;

  const supplierLabel = (lc: LcRow) => {
    if (!lc.supplierId) return tr("noSupplier");
    return isRtl ? (lc.supplierNameAr ?? lc.supplierNameEn ?? `#${lc.supplierId}`) : (lc.supplierNameEn ?? lc.supplierNameAr ?? `#${lc.supplierId}`);
  };

  // Export rows: flatten LC + expenses + invoices into one CSV/XLSX file.
  const exportRows = useMemo(() => {
    const out: any[] = [];
    for (const lc of rows) {
      out.push({
        lcNumber:    lc.lcNumber,
        lcDate:      lc.lcDate,
        supplier:    supplierLabel(lc),
        bank:        lc.bankName ?? "—",
        fundedFrom:  transfersJoined(lc.fundingTransfers, isRtl),
        currency:    lc.currencyCode,
        rate:        lc.exchangeRate,
        total:       fmt(Number(lc.totalAmount)),
        totalBase:   fmt(Number(lc.totalAmountBase)),
        expenses:    fmt(Number(lc.totalExpensesBase)),
        used:        fmt(Number(lc.usedAmount)),
        remaining:   fmt(Number(lc.remainingBase)),
        invoices:    lc.invoiceCount,
        status:      STATUS_MAP[lc.status]?.label ?? lc.status,
      });
    }
    return out;
  }, [rows, isRtl, fmt]);

  const EXPORT_COLS = [
    { key: "lcNumber",  header: tr("col.lcNumber"),  width: 16 },
    { key: "lcDate",    header: tr("col.lcDate"),    width: 14 },
    { key: "supplier",  header: tr("col.supplier"),  width: 28 },
    { key: "bank",      header: tr("col.bank"),      width: 18 },
    { key: "fundedFrom",header: tr("col.fundedFrom"),width: 24 },
    { key: "currency",  header: tr("col.currency"),  width: 10 },
    { key: "rate",      header: tr("col.rate"),      width: 10 },
    { key: "total",     header: tr("col.total"),     width: 14 },
    { key: "totalBase", header: tr("col.totalBase"), width: 14 },
    { key: "expenses",  header: tr("col.expenses"),  width: 14 },
    { key: "used",      header: tr("col.used"),      width: 14 },
    { key: "remaining", header: tr("col.remaining"), width: 14 },
    { key: "invoices",  header: tr("col.invoices"),  width: 10 },
    { key: "status",    header: tr("col.status"),    width: 12 },
  ];

  const totalsRow = summary && rows.length > 0 ? {
    lcNumber: "", lcDate: "", supplier: "", bank: "", fundedFrom: "", currency: "", rate: "",
    total: "", totalBase: fmt(summary.totalBase), expenses: fmt(summary.expensesBase),
    used: fmt(summary.usedBase), remaining: fmt(summary.remainingBase),
    invoices: String(summary.invoiceCount ?? 0),
    status: t("purchasingPages.common.total"),
  } : null;

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CreditCard className="h-6 w-6 text-primary" />{tr("title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`${tr("filename")}-${applied.from}-${applied.to}`}
          title={tr("title")}
          subtitle={`${applied.from} → ${applied.to}`}
          totalsRow={totalsRow}
        />
      </div>

      {/* Filters */}
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{tr("filtersTitle")}</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <div className="space-y-1.5">
            <Label>{t("purchasingPages.common.fromDate")}</Label>
            <Input type="date" value={filters.from} onChange={e => setFilters(p => ({ ...p, from: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("purchasingPages.common.toDate")}</Label>
            <Input type="date" value={filters.to} onChange={e => setFilters(p => ({ ...p, to: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>{tr("supplier")}</Label>
            <SearchCombobox
              items={[
                { value: "all", label: tr("allSuppliers") },
                ...suppliers.map(s => ({ value: String(s.id), label: isRtl ? (s.nameAr ?? s.nameEn) : (s.nameEn ?? s.nameAr), labelEn: s.nameEn })),
              ]}
              value={filters.supplierId}
              onValueChange={v => setFilters(p => ({ ...p, supplierId: v }))}
              placeholder={tr("supplierPh")}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{tr("status")}</Label>
            <Select value={filters.status} onValueChange={v => setFilters(p => ({ ...p, status: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tr("allStatuses")}</SelectItem>
                <SelectItem value="open">{tr("stOpen")}</SelectItem>
                <SelectItem value="partial">{tr("stPartial")}</SelectItem>
                <SelectItem value="closed">{tr("stClosed")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <Button size="sm" onClick={() => setApplied({ ...filters })} className="w-full gap-2">
              <Search className="h-3.5 w-3.5" />{tr("show")}
            </Button>
          </div>
        </div>
      </div>

      {/* KPI summary */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <KpiCard icon={Layers}    tone="primary" label={tr("kpi.count")}     value={String(summary.count ?? 0)} sub={tr("kpi.countSub", { count: summary.invoiceCount ?? 0 })} />
          <KpiCard icon={Wallet}    tone="sky"     label={tr("kpi.totalBase")}  value={fmt(summary.totalBase)}     sub={baseCcy} />
          <KpiCard icon={Receipt}   tone="amber"   label={tr("kpi.expenses")}   value={fmt(summary.expensesBase)}  sub={baseCcy} />
          <KpiCard icon={Banknote}  tone="indigo"  label={tr("kpi.used")}       value={fmt(summary.usedBase)}      sub={baseCcy} />
          <KpiCard icon={TrendingUp} tone="emerald" label={tr("kpi.remaining")} value={fmt(summary.remainingBase)} sub={baseCcy} />
        </div>
      )}

      {/* Table */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[1100px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-3 py-3 w-8" />
                <th className={`px-3 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("col.lcNumber")}</th>
                <th className={`px-3 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("col.lcDate")}</th>
                <th className={`px-3 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("col.supplier")}</th>
                <th className={`px-3 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("col.bank")}</th>
                <th className={`px-3 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-emerald-700`}>{tr("col.fundedFrom")}</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground">{tr("col.currency")}</th>
                <th className="px-3 py-3 text-center font-semibold text-sky-700">{tr("col.totalBase")}</th>
                <th className="px-3 py-3 text-center font-semibold text-amber-700">{tr("col.expenses")}</th>
                <th className="px-3 py-3 text-center font-semibold text-indigo-700">{tr("col.used")}</th>
                <th className="px-3 py-3 text-center font-semibold text-emerald-700">{tr("col.remaining")}</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground">{tr("col.invoices")}</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground">{tr("col.status")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(5)].map((_, i) => <tr key={i}><td colSpan={13} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : rows.length === 0
                ? <tr><td colSpan={13} className="py-12 text-center text-muted-foreground">{tr("noData")}</td></tr>
                : rows.map(lc => {
                    const expanded = expandedId === lc.id;
                    return (
                      <Fragment key={lc.id}>
                        <tr className={cn("hover:bg-muted/30 cursor-pointer", expanded && "bg-muted/40")} onClick={() => setExpandedId(expanded ? null : lc.id)}>
                          <td className="px-3 py-3 text-center text-muted-foreground">
                            {expanded ? <ChevronUp className="h-4 w-4 inline" /> : <ChevronDown className="h-4 w-4 inline" />}
                          </td>
                          <td className="px-3 py-3 font-mono font-semibold">{lc.lcNumber}</td>
                          <td className="px-3 py-3 text-xs tabular-nums text-muted-foreground">{lc.lcDate}</td>
                          <td className="px-3 py-3">{supplierLabel(lc)}</td>
                          <td className="px-3 py-3 text-xs text-muted-foreground">{lc.bankName ?? "—"}</td>
                          <td className="px-3 py-3 text-xs text-emerald-700">
                            {lc.fundingTransfers && lc.fundingTransfers.length > 0
                              ? <span className="inline-flex items-center gap-1"><Banknote className="h-3 w-3" />{transfersJoined(lc.fundingTransfers, isRtl)}</span>
                              : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="px-3 py-3 text-center text-xs text-muted-foreground tabular-nums">{ccyLabel(lc.currencyCode)}</td>
                          <td className="px-3 py-3 text-center font-bold tabular-nums text-sky-700">{fmt(Number(lc.totalAmountBase))}</td>
                          <td className="px-3 py-3 text-center font-bold tabular-nums text-amber-700">{fmt(Number(lc.totalExpensesBase))}</td>
                          <td className="px-3 py-3 text-center font-bold tabular-nums text-indigo-700">{fmt(Number(lc.usedAmount))}</td>
                          <td className="px-3 py-3 text-center font-bold tabular-nums text-emerald-700">{fmt(Number(lc.remainingBase))}</td>
                          <td className="px-3 py-3 text-center text-xs">
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted/60">
                              <FileText className="h-3 w-3" />{lc.invoiceCount}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-center">
                            <span className={cn("inline-block px-2 py-0.5 rounded-full text-xs border", STATUS_MAP[lc.status]?.cls)}>
                              {STATUS_MAP[lc.status]?.label ?? lc.status}
                            </span>
                          </td>
                        </tr>
                        {expanded && (
                          <tr className="bg-muted/10">
                            <td colSpan={13} className="px-4 py-4">
                              <LcDetail lc={lc} fmt={fmt} tr={tr} isRtl={isRtl} baseCcy={baseCcy} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
            </tbody>
            {!isLoading && rows.length > 0 && summary && (
              <tfoot className="bg-muted/40 border-t-2">
                <tr>
                  <td colSpan={7} className="px-3 py-3 text-sm font-semibold">{t("purchasingPages.common.total")}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-sky-700">{fmt(summary.totalBase)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-amber-700">{fmt(summary.expensesBase)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-indigo-700">{fmt(summary.usedBase)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-emerald-700">{fmt(summary.remainingBase)}</td>
                  <td className="px-3 py-3 text-center text-xs">{summary.invoiceCount ?? 0}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

function KpiCard({ icon: Icon, tone, label, value, sub }: { icon: any; tone: "primary"|"sky"|"amber"|"indigo"|"emerald"; label: string; value: string; sub?: string }) {
  const TONES: Record<string, string> = {
    primary:  "bg-primary/5 border-primary/20 text-primary",
    sky:      "bg-sky-50 border-sky-200 text-sky-700",
    amber:    "bg-amber-50 border-amber-200 text-amber-700",
    indigo:   "bg-indigo-50 border-indigo-200 text-indigo-700",
    emerald:  "bg-emerald-50 border-emerald-200 text-emerald-700",
  };
  return (
    <div className={cn("rounded-xl border p-4", TONES[tone])}>
      <div className="flex items-center gap-2 text-xs opacity-90">
        <Icon className="h-4 w-4" />{label}
      </div>
      <p className="text-2xl font-bold tabular-nums mt-1.5">{value}</p>
      {sub && <p className="text-[10px] opacity-70 mt-0.5">{sub}</p>}
    </div>
  );
}

function LcDetail({ lc, fmt, tr, isRtl, baseCcy }: { lc: LcRow; fmt: (n: any) => string; tr: (k: string) => string; isRtl: boolean; baseCcy: string }) {
  return (
    <div className="space-y-4">
      {/* Expenses */}
      <div className="rounded-lg border bg-background overflow-hidden">
        <div className="px-3 py-2 bg-amber-50 border-b text-amber-800 text-xs font-semibold flex items-center gap-2">
          <Receipt className="h-3.5 w-3.5" />{tr("expensesTitle")}
          <span className="ms-auto opacity-70">{lc.expenses.length}</span>
        </div>
        {lc.expenses.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground text-center">{tr("noExpenses")}</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-muted/30">
              <tr>
                <th className={`px-3 py-2 ${isRtl ? "text-right" : "text-left"}`}>{tr("col.expenseType")}</th>
                <th className="px-3 py-2 text-center">{tr("col.amount")}</th>
                <th className="px-3 py-2 text-center">{tr("col.currency")}</th>
                <th className="px-3 py-2 text-center">{tr("col.rate")}</th>
                <th className="px-3 py-2 text-center">{tr("col.amountBase")} ({baseCcy})</th>
                <th className={`px-3 py-2 ${isRtl ? "text-right" : "text-left"} text-emerald-700`}>{tr("col.paidFrom")}</th>
                <th className={`px-3 py-2 ${isRtl ? "text-right" : "text-left"}`}>{tr("col.notes")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {lc.expenses.map(e => (
                <tr key={e.id}>
                  <td className="px-3 py-1.5 font-medium">{e.expenseType}</td>
                  <td className="px-3 py-1.5 text-center tabular-nums">{fmt(Number(e.amount))}</td>
                  <td className="px-3 py-1.5 text-center text-muted-foreground">{e.currencyCode}</td>
                  <td className="px-3 py-1.5 text-center tabular-nums text-muted-foreground">{e.exchangeRate}</td>
                  <td className="px-3 py-1.5 text-center font-bold tabular-nums text-amber-700">{fmt(Number(e.amountBase))}</td>
                  <td className="px-3 py-1.5 text-emerald-700">
                    {e.fundingTransfers && e.fundingTransfers.length > 0
                      ? <span className="inline-flex items-center gap-1"><Banknote className="h-3 w-3" />{transfersJoined(e.fundingTransfers, isRtl)}</span>
                      : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground">{e.notes ?? "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-muted/30 border-t">
              <tr>
                <td colSpan={4} className="px-3 py-2 font-semibold">{tr("totalExpenses")}</td>
                <td className="px-3 py-2 text-center font-bold tabular-nums text-amber-700">{fmt(Number(lc.totalExpensesBase))}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {/* Linked invoices */}
      <div className="rounded-lg border bg-background overflow-hidden">
        <div className="px-3 py-2 bg-indigo-50 border-b text-indigo-800 text-xs font-semibold flex items-center gap-2">
          <FileText className="h-3.5 w-3.5" />{tr("invoicesTitle")}
          <span className="ms-auto opacity-70">{lc.invoices.length}</span>
        </div>
        {lc.invoices.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground text-center">{tr("noInvoices")}</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-muted/30">
              <tr>
                <th className={`px-3 py-2 ${isRtl ? "text-right" : "text-left"}`}>{tr("col.docNumber")}</th>
                <th className={`px-3 py-2 ${isRtl ? "text-right" : "text-left"}`}>{tr("col.invoiceDate")}</th>
                <th className="px-3 py-2 text-center">{tr("col.invStatus")}</th>
                <th className="px-3 py-2 text-center">{tr("col.invTotal")}</th>
                <th className="px-3 py-2 text-center">{tr("col.invVat")}</th>
                <th className="px-3 py-2 text-center">{tr("col.invExpenses")}</th>
                <th className="px-3 py-2 text-center">{tr("col.invGoods")} ({baseCcy})</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {lc.invoices.map(i => (
                <tr key={i.id} className={cn(i.status !== "posted" && "opacity-60")}>
                  <td className="px-3 py-1.5 font-mono font-semibold">{i.docNumber ?? `#${i.id}`}</td>
                  <td className="px-3 py-1.5 tabular-nums text-muted-foreground">{i.invoiceDate}</td>
                  <td className="px-3 py-1.5 text-center text-[10px] uppercase">{i.status}</td>
                  <td className="px-3 py-1.5 text-center tabular-nums">{fmt(Number(i.totalAmount))} {i.currencyCode}</td>
                  <td className="px-3 py-1.5 text-center tabular-nums">{fmt(i.vatBase)}</td>
                  <td className="px-3 py-1.5 text-center tabular-nums">{fmt(i.expensesLoadedBase)}</td>
                  <td className="px-3 py-1.5 text-center font-bold tabular-nums text-indigo-700">{fmt(i.goodsBase)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-muted/30 border-t">
              <tr>
                <td colSpan={6} className="px-3 py-2 font-semibold">{tr("totalGoodsPosted")}</td>
                <td className="px-3 py-2 text-center font-bold tabular-nums text-indigo-700">{fmt(lc.usedBaseFromInvoices)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {lc.notes && (
        <div className="rounded-lg border bg-muted/20 p-3 text-xs">
          <span className="font-semibold">{tr("notes")}: </span>{lc.notes}
        </div>
      )}
    </div>
  );
}
