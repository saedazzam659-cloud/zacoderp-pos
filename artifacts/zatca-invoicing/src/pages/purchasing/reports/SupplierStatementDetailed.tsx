import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { purchaseAnalyticsApi, type SupplierStatementDetailedRow } from "@/lib/purchaseAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchCombobox } from "@/components/ui/search-combobox";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import { useTranslation } from "react-i18next";
import { FileText, Search, Filter, ChevronDown, ChevronRight } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";

const API = import.meta.env.VITE_API_URL ?? "";
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

const COL_COUNT = 8;

export default function SupplierStatementDetailed() {
  const { fmt } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`purchasingReports.supplierStatementDetailed.${k}`, opts) as string;
  const pickName = (ar?: string, en?: string) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [filters, setFilters] = useState<{ from: string; to: string; supplierId: string; branchId?: number }>({ from: firstDay, to: today, supplierId: "", branchId: undefined });
  const [applied, setApplied] = useState<{ from: string; to: string; supplierId: string; branchId?: number }>({ from: firstDay, to: today, supplierId: "", branchId: undefined });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (key: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const TYPE_LABEL: Record<string, string> = {
    invoice: tr("type.invoice"),
    return:  tr("type.return"),
    payment: tr("type.payment"),
  };

  // Tiny inline badge that flags the source document's payment method
  // (cash / bank / credit). Only shown for invoice/return rows so users
  // can immediately tell which transactions are A/P-affecting and which
  // self-settled at point of purchase.
  const PaymentBadge = ({ pt }: { pt: string | null | undefined }) => {
    if (!pt) return null;
    const label = pt === "credit" ? tr("payCredit") : pt === "bank" ? tr("payBank") : tr("payCash");
    const cls   = pt === "credit"
      ? "bg-orange-50 text-orange-700 border-orange-200"
      : pt === "bank"
        ? "bg-indigo-50 text-indigo-700 border-indigo-200"
        : "bg-slate-100 text-slate-700 border-slate-200";
    return (
      <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold ${cls} ${isRtl ? "mr-2" : "ml-2"}`}>
        {label}
      </span>
    );
  };

  const EXPORT_COLS = [
    { key: "date",        header: tr("colDate"),        width: 14 },
    { key: "type",        header: tr("colType"),        width: 14 },
    { key: "docNumber",   header: tr("colDoc"),         width: 16 },
    { key: "description", header: tr("colDescription"), width: 30 },
    { key: "debit",       header: tr("colDebit"),       width: 14 },
    { key: "credit",      header: tr("colCredit"),      width: 14 },
    { key: "balance",     header: tr("colBalance"),     width: 16 },
  ];

  const { data: suppliers = [] } = useQuery({
    queryKey: ["suppliers", cid],
    queryFn: async () => {
      const r = await fetch(cid ? `${API}/api/suppliers?companyId=${cid}` : `${API}/api/suppliers`, { headers: authHeaders() });
      return r.json();
    },
  });

  const { data, isLoading } = useQuery({
    queryKey: ["supplier-statement-detailed", cid, applied],
    enabled: !!applied.supplierId,
    queryFn: () => purchaseAnalyticsApi.supplierStatementDetailed(cid, Number(applied.supplierId), applied.from, applied.to, applied.branchId),
  });

  const supplier = (suppliers as any[]).find(s => String(s.id) === applied.supplierId);
  const supplierLabel = supplier ? pickName(supplier.nameAr, supplier.nameEn) : "";

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
      date: applied.from, type: "—", docNumber: "—", description: tr("openingRow"),
      debit: data?.opening && data.opening < 0 ? fmt(-data.opening) : "",
      credit: data?.opening && data.opening > 0 ? fmt(data.opening) : "",
      balance: fmt(data?.opening ?? 0),
    }] : []),
    ...augmented.flatMap(l => {
      const parent = {
        date:        l.date,
        type:        TYPE_LABEL[l.type] ?? l.type,
        docNumber:   l.docNumber ?? "—",
        description: l.description,
        debit:       l.debit ? fmt(l.debit) : "",
        credit:      l.credit ? fmt(l.credit) : "",
        balance:     fmt(l.balance),
      };
      const detailRows: any[] = [];
      if ((l.type === "invoice" || l.type === "return") && l.lines && l.lines.length > 0) {
        for (const ln of l.lines) {
          detailRows.push({
            date: "", type: "", docNumber: "",
            description: `   • ${ln.itemCode ? `[${ln.itemCode}] ` : ""}${ln.itemName} — ${tr("lineQty")}: ${fmt(ln.qty)} ${ln.unit ?? ""} × ${fmt(ln.unitPrice)}${ln.discount ? `, ${tr("lineDiscount")}: ${fmt(ln.discount)}` : ""}, ${tr("lineVatAmount")}: ${fmt(ln.vatAmount)} (${fmt(ln.vatRate)}%), ${tr("lineTotal")}: ${fmt(ln.lineTotal)}`,
            debit: "", credit: "", balance: "",
          });
        }
      } else if (l.type === "payment" && l.meta) {
        const m = l.meta;
        const parts: string[] = [];
        if (m.paymentType) parts.push(`${tr("voucherPaymentType")}: ${m.paymentType}`);
        if (m.cashBoxName) parts.push(`${tr("voucherCashBox")}: ${m.cashBoxName}`);
        if (m.bankAccountName) parts.push(`${tr("voucherBank")}: ${m.bankAccountName}`);
        if (m.refNumber) parts.push(`${tr("voucherRef")}: ${m.refNumber}`);
        if (m.description) parts.push(`${tr("voucherDescription")}: ${m.description}`);
        if (parts.length > 0) {
          detailRows.push({
            date: "", type: "", docNumber: "",
            description: `   • ${parts.join(" | ")}`,
            debit: "", credit: "", balance: "",
          });
        }
      }
      return [parent, ...detailRows];
    }),
  ];

  const renderInvoiceLines = (row: SupplierStatementDetailedRow) => {
    const lines = row.lines ?? [];
    const lineVatTotal = lines.reduce((s, ln) => s + (ln.vatAmount || 0), 0);
    const lineDiscountTotal = lines.reduce((s, ln) => s + (ln.discount || 0), 0);
    return (
      <div className="bg-muted/10 px-4 py-3">
        <div className="text-xs font-semibold text-muted-foreground mb-2">{tr("linesTitle")}</div>
        <div className="overflow-x-auto rounded border bg-background">
          <table className="w-full text-xs min-w-[800px]">
            <thead className="bg-muted/40 border-b">
              <tr>
                <th className={`px-2 py-1.5 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("lineCode")}</th>
                <th className={`px-2 py-1.5 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("lineName")}</th>
                <th className={`px-2 py-1.5 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("lineUnit")}</th>
                <th className="px-2 py-1.5 text-center font-semibold text-muted-foreground">{tr("lineQty")}</th>
                <th className="px-2 py-1.5 text-center font-semibold text-muted-foreground">{tr("linePrice")}</th>
                <th className="px-2 py-1.5 text-center font-semibold text-muted-foreground">{tr("lineDiscount")}</th>
                <th className="px-2 py-1.5 text-center font-semibold text-muted-foreground">{tr("lineVatRate")}</th>
                <th className="px-2 py-1.5 text-center font-semibold text-muted-foreground">{tr("lineVatAmount")}</th>
                <th className="px-2 py-1.5 text-center font-semibold text-muted-foreground">{tr("lineNet")}</th>
                <th className="px-2 py-1.5 text-center font-semibold text-muted-foreground">{tr("lineTotal")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {lines.length === 0 ? (
                <tr><td colSpan={10} className="px-2 py-3 text-center text-muted-foreground">—</td></tr>
              ) : lines.map((ln, i) => (
                <tr key={i} className="hover:bg-muted/20">
                  <td className="px-2 py-1.5 font-mono text-muted-foreground">{ln.itemCode ?? "—"}</td>
                  <td className="px-2 py-1.5">{ln.itemName}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">{ln.unit ?? "—"}</td>
                  <td className="px-2 py-1.5 text-center tabular-nums">{fmt(ln.qty)}</td>
                  <td className="px-2 py-1.5 text-center tabular-nums">{fmt(ln.unitPrice)}</td>
                  <td className="px-2 py-1.5 text-center tabular-nums">{ln.discount ? fmt(ln.discount) : "—"}</td>
                  <td className="px-2 py-1.5 text-center tabular-nums">{fmt(ln.vatRate)}%</td>
                  <td className="px-2 py-1.5 text-center tabular-nums">{fmt(ln.vatAmount)}</td>
                  <td className="px-2 py-1.5 text-center tabular-nums">{fmt(ln.netAmount)}</td>
                  <td className="px-2 py-1.5 text-center tabular-nums font-bold">{fmt(ln.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
            {lines.length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td colSpan={5} className={`px-2 py-1.5 font-semibold text-muted-foreground ${isRtl ? "text-right" : "text-left"}`}></td>
                  <td className="px-2 py-1.5 text-center tabular-nums font-bold">{fmt(lineDiscountTotal)}</td>
                  <td colSpan={1}></td>
                  <td className="px-2 py-1.5 text-center tabular-nums font-bold">{fmt(lineVatTotal)}</td>
                  <td className="px-2 py-1.5 text-center"></td>
                  <td className="px-2 py-1.5 text-center tabular-nums font-bold">{fmt(row.debit || row.credit)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    );
  };

  const renderPaymentMeta = (row: SupplierStatementDetailedRow) => {
    const m = row.meta;
    if (!m) return <div className="bg-muted/10 px-4 py-3 text-xs text-muted-foreground">—</div>;
    const Cell = ({ label, value }: { label: string; value: string | null }) =>
      value ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
          <span className="text-xs font-medium">{value}</span>
        </div>
      ) : null;
    return (
      <div className="bg-muted/10 px-4 py-3">
        <div className="text-xs font-semibold text-muted-foreground mb-2">{tr("voucherTitle")}</div>
        <div className="rounded border bg-background p-3 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          <Cell label={tr("voucherPaymentType")} value={m.paymentType} />
          <Cell label={tr("voucherCashBox")} value={m.cashBoxName} />
          <Cell label={tr("voucherBank")} value={m.bankAccountName} />
          <Cell label={tr("voucherRef")} value={m.refNumber} />
          <Cell label={tr("voucherDescription")} value={m.description} />
        </div>
      </div>
    );
  };

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
          filename={`${tr("filename")}-${supplierLabel || "supplier"}-${applied.from}-${applied.to}`}
          title={tr("exportTitle")}
          subtitle={supplier ? `${supplierLabel}  |  ${applied.from} → ${applied.to}` : tr("selectSupplier")}
        />
      </div>

      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{tr("filtersTitle")}</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="space-y-1.5">
            <Label>{tr("supplier")} <span className="text-red-500">*</span></Label>
            <SearchCombobox
              items={(suppliers as any[]).map(s => ({ value: String(s.id), label: pickName(s.nameAr, s.nameEn), labelEn: s.nameEn }))}
              value={filters.supplierId}
              onValueChange={v => setFilters(p => ({ ...p, supplierId: v }))}
              placeholder={tr("supplierPh")}
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
          <Button size="sm" onClick={() => { setApplied({ ...filters }); setExpanded(new Set()); }} disabled={!filters.supplierId} className="gap-2">
            <Search className="h-3.5 w-3.5" />{tr("show")}
          </Button>
        </div>
      </div>

      {applied.supplierId && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="rounded-xl border bg-card p-4">
            <p className="text-xs text-muted-foreground">{tr("openingBalance")}</p>
            <p className="text-xl font-bold tabular-nums mt-1">{fmt(data?.opening ?? 0)}</p>
          </div>
          <div className="rounded-xl border bg-blue-50 border-blue-200 p-4">
            <p className="text-xs text-blue-700">{tr("totalDebitDesc")}</p>
            <p className="text-xl font-bold text-blue-700 tabular-nums mt-1">{fmt(totals.debit)}</p>
          </div>
          <div className="rounded-xl border bg-emerald-50 border-emerald-200 p-4">
            <p className="text-xs text-emerald-700">{tr("totalCreditDesc")}</p>
            <p className="text-xl font-bold text-emerald-700 tabular-nums mt-1">{fmt(totals.credit)}</p>
          </div>
          <div className="rounded-xl border bg-primary/5 border-primary/10 p-4">
            <p className="text-xs text-muted-foreground">{tr("finalBalanceDesc")}</p>
            <p className="text-xl font-bold tabular-nums mt-1">{fmt(closing)}</p>
          </div>
        </div>
      )}

      {applied.supplierId ? (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[800px]">
              <thead className="bg-muted/50 border-b">
                <tr>
                  <th className="px-2 py-3 w-10"></th>
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
                <tr className="bg-muted/20">
                  <td className="px-2 py-3"></td>
                  <td className="px-4 py-3 tabular-nums text-xs text-muted-foreground">{applied.from}</td>
                  <td className="px-4 py-3 text-xs italic text-muted-foreground" colSpan={3}>{tr("openingRow")}</td>
                  <td className="px-4 py-3 text-center tabular-nums text-xs">{(data?.opening ?? 0) < 0 ? fmt(-(data!.opening)) : "—"}</td>
                  <td className="px-4 py-3 text-center tabular-nums text-xs">{(data?.opening ?? 0) > 0 ? fmt(data!.opening) : "—"}</td>
                  <td className="px-4 py-3 text-center tabular-nums text-sm font-bold">{fmt(data?.opening ?? 0)}</td>
                </tr>
                {isLoading ? (
                  [...Array(5)].map((_, i) => <tr key={i}><td colSpan={COL_COUNT} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                ) : augmented.length === 0 ? (
                  <tr><td colSpan={COL_COUNT} className="py-12 text-center text-muted-foreground">{tr("noTx")}</td></tr>
                ) : (
                  augmented.map((l, idx) => {
                    const key = `${l.type}-${l.id}-${idx}`;
                    const isOpen = expanded.has(key);
                    return (
                      <Fragment key={key}>
                        <tr
                          className="hover:bg-muted/20 cursor-pointer"
                          onClick={() => toggle(key)}
                        >
                          <td className="px-2 py-3 text-center text-muted-foreground">
                            {isOpen ? <ChevronDown className="h-4 w-4 inline" /> : <ChevronRight className={`h-4 w-4 inline ${isRtl ? "rotate-180" : ""}`} />}
                          </td>
                          <td className="px-4 py-3 tabular-nums text-xs text-muted-foreground">{l.date}</td>
                          <td className="px-4 py-3 text-xs">{TYPE_LABEL[l.type] ?? l.type}</td>
                          <td className="px-4 py-3 text-xs text-muted-foreground font-mono">{l.docNumber ?? "—"}</td>
                          <td className="px-4 py-3 text-xs">
                            {l.description}
                            {(l.type === "invoice" || l.type === "return") && <PaymentBadge pt={l.paymentType} />}
                          </td>
                          <td className="px-4 py-3 text-center tabular-nums text-sm font-bold text-blue-600">{l.debit ? fmt(l.debit) : "—"}</td>
                          <td className="px-4 py-3 text-center tabular-nums text-sm font-bold text-emerald-600">{l.credit ? fmt(l.credit) : "—"}</td>
                          <td className="px-4 py-3 text-center tabular-nums text-sm font-bold">{fmt(l.balance)}</td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={COL_COUNT} className="p-0">
                              {l.type === "payment" ? renderPaymentMeta(l) : renderInvoiceLines(l)}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
              {!isLoading && augmented.length > 0 && (
                <tfoot className="bg-muted/30 border-t">
                  <tr>
                    <td colSpan={5} className="px-4 py-3 text-xs font-semibold text-muted-foreground">{tr("totalLabel")}</td>
                    <td className="px-4 py-3 text-center font-bold tabular-nums text-blue-700">{fmt(totals.debit)}</td>
                    <td className="px-4 py-3 text-center font-bold tabular-nums text-emerald-700">{fmt(totals.credit)}</td>
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
          <p>{tr("selectSupplierFirst")}</p>
        </div>
      )}
    </div>
  );
}
