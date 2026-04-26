import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { salesAnalyticsApi } from "@/lib/salesAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import { Users, Search } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import { useTranslation } from "react-i18next";

export default function SalesByCustomer() {
  const { fmt } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`salesReports.salesByCustomer.${k}`, opts) as string;
  const pickName = (ar?: string, en?: string) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [from, setFrom] = useState(firstDay);
  const [to, setTo] = useState(today);
  const [branchId, setBranchId] = useState<number | undefined>(undefined);
  const [search, setSearch] = useState("");

  const EXPORT_COLS = [
    { key: "customerName", header: tr("exportColCustomer"),    width: 30 },
    { key: "invoiceCount", header: tr("exportColInvoiceCount"), width: 14 },
    { key: "subtotal",     header: tr("exportColSubtotal"),    width: 16 },
    { key: "vatAmount",    header: tr("exportColVat"),         width: 14 },
    { key: "totalSales",   header: tr("exportColTotalSales"),  width: 16 },
    { key: "totalReturns", header: tr("exportColReturns"),     width: 14 },
    { key: "netSales",     header: tr("exportColNetSales"),    width: 18 },
    { key: "totalPaid",    header: tr("exportColCollected"),   width: 14 },
  ];

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["sales-by-customer", cid, from, to, branchId],
    queryFn: () => salesAnalyticsApi.byCustomer(cid, from, to, branchId),
  });

  const filtered = (rows as any[]).filter(r => !search || r.customerNameAr?.includes(search) || r.customerNameEn?.toLowerCase().includes(search.toLowerCase()));

  const totals = filtered.reduce((s, r) => ({
    invoiceCount: s.invoiceCount + r.invoiceCount,
    subtotal: s.subtotal + r.subtotal,
    vatAmount: s.vatAmount + r.vatAmount,
    totalSales: s.totalSales + r.totalSales,
    totalReturns: s.totalReturns + r.totalReturns,
    netSales: s.netSales + r.netSales,
    totalPaid: s.totalPaid + r.totalPaid,
  }), { invoiceCount: 0, subtotal: 0, vatAmount: 0, totalSales: 0, totalReturns: 0, netSales: 0, totalPaid: 0 });

  const exportRows = filtered.map(r => ({
    customerName: pickName(r.customerNameAr, r.customerNameEn),
    invoiceCount: r.invoiceCount,
    subtotal:     fmt(r.subtotal),
    vatAmount:    fmt(r.vatAmount),
    totalSales:   fmt(r.totalSales),
    totalReturns: fmt(r.totalReturns),
    netSales:     fmt(r.netSales),
    totalPaid:    fmt(r.totalPaid),
  }));

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Users className="h-6 w-6 text-primary" />{tr("title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`${tr("exportFilename")}-${from}-${to}`}
          title={tr("exportTitle")}
          subtitle={tr("exportSubtitle", { from, to })}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl border bg-blue-50 border-blue-200 p-3">
          <p className="text-[11px] text-blue-700">{tr("invoiceCount")}</p>
          <p className="text-xl font-bold text-blue-700 tabular-nums mt-1">{totals.invoiceCount}</p>
        </div>
        <div className="rounded-xl border bg-emerald-50 border-emerald-200 p-3">
          <p className="text-[11px] text-emerald-700">{tr("netSales")}</p>
          <p className="text-xl font-bold text-emerald-700 tabular-nums mt-1">{fmt(totals.netSales)}</p>
        </div>
        <div className="rounded-xl border bg-amber-50 border-amber-200 p-3">
          <p className="text-[11px] text-amber-700">{tr("returns")}</p>
          <p className="text-xl font-bold text-amber-700 tabular-nums mt-1">{fmt(totals.totalReturns)}</p>
        </div>
        <div className="rounded-xl border bg-primary/5 border-primary/10 p-3">
          <p className="text-[11px] text-muted-foreground">{tr("collected")}</p>
          <p className="text-xl font-bold tabular-nums mt-1">{fmt(totals.totalPaid)}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="space-y-1.5">
          <Label>{t("salesReports.common.from")}</Label>
          <Input type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("salesReports.common.to")}</Label>
          <Input type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("common.branch")}</Label>
          <BranchFilter value={branchId} onChange={setBranchId} />
        </div>
        <div className="space-y-1.5">
          <Label>{tr("search")}</Label>
          <div className="relative">
            <Search className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground`} />
            <Input className={isRtl ? "pr-9" : "pl-9"} placeholder={tr("searchPh")} value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className={`px-3 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colCustomer")}</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground">{tr("colInvoiceCount")}</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground hidden md:table-cell">{tr("colSubtotal")}</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground hidden lg:table-cell">{tr("colVat")}</th>
                <th className="px-3 py-3 text-center font-semibold text-blue-700">{tr("colTotalSales")}</th>
                <th className="px-3 py-3 text-center font-semibold text-amber-700">{tr("colReturns")}</th>
                <th className="px-3 py-3 text-center font-semibold text-emerald-700">{tr("colNetSales")}</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground">{tr("colCollected")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(6)].map((_, i) => <tr key={i}><td colSpan={8} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : filtered.length === 0
                ? <tr><td colSpan={8} className="py-12 text-center text-muted-foreground">{tr("noRows")}</td></tr>
                : filtered.map((r: any, i: number) => (
                    <tr key={r.customerId ?? `null-${i}`} className="hover:bg-muted/20">
                      <td className="px-3 py-3">
                        <p className="font-medium text-sm">{pickName(r.customerNameAr, r.customerNameEn)}</p>
                        {(isRtl ? r.customerNameEn : r.customerNameAr) && <p className="text-[10px] text-muted-foreground">{isRtl ? r.customerNameEn : r.customerNameAr}</p>}
                      </td>
                      <td className="px-3 py-3 text-center tabular-nums text-sm">{r.invoiceCount}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-xs hidden md:table-cell">{fmt(r.subtotal)}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-xs hidden lg:table-cell">{fmt(r.vatAmount)}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-sm font-semibold text-blue-600">{fmt(r.totalSales)}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-xs text-amber-600">{r.totalReturns ? fmt(r.totalReturns) : "—"}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-sm font-bold text-emerald-700">{fmt(r.netSales)}</td>
                      <td className="px-3 py-3 text-center tabular-nums text-xs">{fmt(r.totalPaid)}</td>
                    </tr>
                  ))}
            </tbody>
            {!isLoading && filtered.length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td className="px-3 py-3 text-xs font-bold">{tr("footerLabel")}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums">{totals.invoiceCount}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums hidden md:table-cell">{fmt(totals.subtotal)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums hidden lg:table-cell">{fmt(totals.vatAmount)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-blue-700">{fmt(totals.totalSales)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-amber-700">{fmt(totals.totalReturns)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-emerald-700">{fmt(totals.netSales)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums">{fmt(totals.totalPaid)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
