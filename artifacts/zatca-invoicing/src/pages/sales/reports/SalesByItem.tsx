import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { salesAnalyticsApi } from "@/lib/salesAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import RegionFilter from "@/components/RegionFilter";
import { useTranslation } from "react-i18next";
import { Package, Search } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import { DateField } from "@/components/ui/date-field";

export default function SalesByItem() {
  const { fmt, fmtQty } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`salesReports.salesByItem.${k}`, opts) as string;
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [from, setFrom] = useState(firstDay);
  const [to, setTo] = useState(today);
  const [branchId, setBranchId] = useState<number | undefined>(undefined);
  const [regionId, setRegionId] = useState<number | undefined>(undefined);
  const [search, setSearch] = useState("");

  const EXPORT_COLS = [
    { key: "itemCode",     header: tr("exportColItemCode"),    width: 14 },
    { key: "itemName",     header: tr("exportColItemName"),    width: 30 },
    { key: "unit",         header: tr("exportColUnit"),        width: 10 },
    { key: "qty",          header: tr("exportColQty"),         width: 14 },
    { key: "totalSales",   header: tr("exportColTotalSales"),  width: 16 },
    { key: "invoiceCount", header: tr("exportColInvoiceCount"), width: 14 },
    { key: "share",        header: tr("exportColShare"),       width: 14 },
  ];

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["sales-by-item", cid, from, to, branchId, regionId],
    queryFn: () => salesAnalyticsApi.byItem(cid, from, to, branchId, regionId),
  });

  const filtered = (rows as any[]).filter(r =>
    !search || r.itemName?.toLowerCase().includes(search.toLowerCase()) || r.itemCode?.includes(search)
  );

  const grandSales = filtered.reduce((s, r) => s + r.totalSales, 0);
  const grandQty   = filtered.reduce((s, r) => s + r.qty, 0);

  const exportRows = filtered.map(r => ({
    itemCode:     r.itemCode ?? "",
    itemName:     r.itemName,
    unit:         r.unit ?? "",
    qty:          fmtQty(r.qty),
    totalSales:   fmt(r.totalSales),
    invoiceCount: r.invoiceCount,
    share:        grandSales > 0 ? `${((r.totalSales / grandSales) * 100).toFixed(2)}%` : "0%",
  }));

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Package className="h-6 w-6 text-primary" />{tr("title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`${tr("exportFilename")}-${from}-${to}`}
          title={tr("exportTitle")}
          subtitle={tr("exportSubtitle", { from, to, value: fmt(grandSales) })}
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border bg-purple-50 border-purple-200 p-3">
          <p className="text-[11px] text-purple-700">{tr("itemsSold")}</p>
          <p className="text-xl font-bold text-purple-700 tabular-nums mt-1">{filtered.length}</p>
        </div>
        <div className="rounded-xl border bg-card p-3">
          <p className="text-[11px] text-muted-foreground">{tr("totalQty")}</p>
          <p className="text-xl font-bold tabular-nums mt-1">{fmtQty(grandQty)}</p>
        </div>
        <div className="rounded-xl border bg-primary/5 border-primary/10 p-3">
          <p className="text-[11px] text-muted-foreground">{tr("totalValue")}</p>
          <p className="text-xl font-bold tabular-nums mt-1">{fmt(grandSales)}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="space-y-1.5">
          <Label>{t("salesReports.common.from")}</Label>
          <DateField value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("salesReports.common.to")}</Label>
          <DateField value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <BranchFilter value={branchId} onChange={setBranchId} />
        <RegionFilter value={regionId} onChange={setRegionId} />
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
          <table className="w-full text-sm min-w-[800px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className={`px-3 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colItem")}</th>
                <th className={`px-3 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground hidden sm:table-cell`}>{tr("colUnit")}</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground">{tr("colQty")}</th>
                <th className="px-3 py-3 text-center font-semibold text-blue-700">{tr("colTotalSales")}</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground hidden md:table-cell">{tr("colInvoiceCount")}</th>
                <th className={`px-3 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colShare")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(6)].map((_, i) => <tr key={i}><td colSpan={6} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : filtered.length === 0
                ? <tr><td colSpan={6} className="py-12 text-center text-muted-foreground">{tr("noRows")}</td></tr>
                : filtered.map((r: any, i: number) => {
                    const share = grandSales > 0 ? (r.totalSales / grandSales) * 100 : 0;
                    return (
                      <tr key={`${r.itemId ?? r.itemName}-${i}`} className="hover:bg-muted/20">
                        <td className="px-3 py-3">
                          <p className="font-medium text-sm">{r.itemName}</p>
                          {r.itemCode && <p className="text-[10px] text-muted-foreground font-mono">{r.itemCode}</p>}
                        </td>
                        <td className="px-3 py-3 hidden sm:table-cell text-xs text-muted-foreground">{r.unit ?? "—"}</td>
                        <td className="px-3 py-3 text-center tabular-nums text-sm">{fmtQty(r.qty)}</td>
                        <td className="px-3 py-3 text-center tabular-nums text-sm font-bold text-blue-600">{fmt(r.totalSales)}</td>
                        <td className="px-3 py-3 text-center tabular-nums text-xs hidden md:table-cell">{r.invoiceCount}</td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                              <div className="h-full bg-primary" style={{ width: `${Math.min(100, share)}%` }} />
                            </div>
                            <span className={`text-xs tabular-nums w-12 ${isRtl ? "text-left" : "text-right"}`}>{share.toFixed(1)}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
            </tbody>
            {!isLoading && filtered.length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td colSpan={2} className="px-3 py-3 text-xs font-bold">{tr("footerLabel")}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums">{fmtQty(grandQty)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-blue-700">{fmt(grandSales)}</td>
                  <td className="px-3 py-3 hidden md:table-cell"></td>
                  <td className="px-3 py-3 text-center font-bold">100%</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
