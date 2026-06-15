import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import { BookOpen, Search, Filter } from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { useFmt } from "@/hooks/use-fmt";
import { DateField } from "@/components/ui/date-field";

const TX_TYPE_COLOR: Record<string, string> = {
  transfer_out: "bg-orange-50 text-orange-700",
  transfer_in:  "bg-blue-50 text-blue-700",
  adjustment:   "bg-purple-50 text-purple-700",
  count_adj:    "bg-indigo-50 text-indigo-700",
  sale:         "bg-red-50 text-red-600",
  purchase:     "bg-green-50 text-green-700",
  opening:      "bg-slate-50 text-slate-600",
  return_in:    "bg-teal-50 text-teal-700",
  return_out:   "bg-pink-50 text-pink-700",
};

export default function StockLedger() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`inventoryReports.stockLedger.${k}`, opts) as string;
  const pickName = (ar?: string | null, en?: string | null) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");
  const txLabel = (txType: string) => {
    const v = t(`inventoryReports.stockLedger.txType.${txType}`, { defaultValue: "" }) as string;
    return v || txType;
  };

  const { fmt, fmtQty } = useFmt();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [filters, setFilters] = useState({ from: firstDay, to: today, itemId: "", warehouseId: "" });
  const [applied, setApplied] = useState({ from: firstDay, to: today, itemId: "", warehouseId: "" });

  const { data: items = [] }      = useQuery({ queryKey: ["items", cid],      queryFn: () => inventoryApi.getItems(cid) });
  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses", cid], queryFn: () => inventoryApi.getWarehouses(cid) });
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["stock-ledger", cid, applied],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (cid)               params.companyId   = String(cid);
      if (applied.from)      params.from        = applied.from;
      if (applied.to)        params.to          = applied.to;
      if (applied.itemId)    params.itemId      = applied.itemId;
      if (applied.warehouseId) params.warehouseId = applied.warehouseId;
      return inventoryApi.getLedger(params);
    },
  });

  const EXPORT_COLS = [
    { key: "txDate",       header: tr("exportDate"),       width: 14 },
    { key: "txType",       header: tr("exportTxType"),     width: 18 },
    { key: "itemCode",     header: tr("exportItemCode"),   width: 16 },
    { key: "itemName",     header: tr("exportItemName"),   width: 30 },
    { key: "warehouseName",header: tr("exportWarehouse"),  width: 22 },
    { key: "qty",          header: tr("exportQty"),        width: 14 },
    { key: "costPrice",    header: tr("exportCostPrice"),  width: 16 },
    { key: "totalCost",    header: tr("exportTotalCost"),  width: 18 },
    { key: "batchNumber",  header: isRtl ? "رقم الدفعة" : "Batch No.", width: 16 },
    { key: "expiryDate",   header: isRtl ? "تاريخ الانتهاء" : "Expiry Date", width: 16 },
  ];

  const exportRows = rows.map((r: any) => ({
    txDate:        r.txDate,
    txType:        txLabel(r.txType),
    itemCode:      r.item?.code ?? "",
    itemName:      pickName(r.item?.nameAr, r.item?.nameEn),
    warehouseName: pickName(r.warehouse?.nameAr, r.warehouse?.nameEn),
    qty:           fmtQty(r.qty),
    costPrice:     fmt(r.costPrice),
    totalCost:     fmt(r.totalCost),
    batchNumber:   r.batchNumber ?? "",
    expiryDate:    r.expiryDate  ?? "",
  }));

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><BookOpen className="h-6 w-6 text-primary" />{tr("title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`${tr("exportFilename")}-${applied.from}-${applied.to}`}
          title={tr("exportTitle")}
          subtitle={tr("exportSubtitleRange", { from: applied.from, to: applied.to })}
        />
      </div>

      {/* Filters */}
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("inventoryReports.common.filters") as string}</h2>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="space-y-1.5">
            <Label>{t("inventoryReports.common.from") as string}</Label>
            <DateField value={filters.from} onChange={e => setFilters(p => ({ ...p, from: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("inventoryReports.common.to") as string}</Label>
            <DateField value={filters.to} onChange={e => setFilters(p => ({ ...p, to: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("inventoryReports.common.item") as string}</Label>
            <SearchCombobox
              items={[{ value: "", label: isRtl ? "كل الأصناف" : "All Items" }, ...(items as any[]).map((it: any) => ({ value: String(it.id), code: it.code, label: pickName(it.nameAr, it.nameEn), labelEn: it.nameEn }))]}
              value={filters.itemId}
              onValueChange={v => setFilters(p => ({ ...p, itemId: v }))}
              placeholder={isRtl ? "كل الأصناف" : "All Items"}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("inventoryReports.common.warehouse") as string}</Label>
            <SearchCombobox
              items={[{ value: "", label: t("inventoryReports.common.allWarehouses") as string }, ...(warehouses as any[]).map((w: any) => ({ value: String(w.id), code: w.code, label: pickName(w.nameAr, w.nameEn) }))]}
              value={filters.warehouseId}
              onValueChange={v => setFilters(p => ({ ...p, warehouseId: v }))}
              placeholder={t("inventoryReports.common.allWarehouses") as string}
            />
          </div>
        </div>
        <div className="flex justify-end mt-4">
          <Button size="sm" onClick={() => setApplied({ ...filters })} className="gap-2">
            <Search className="h-3.5 w-3.5" />{t("inventoryReports.common.show") as string}
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/20 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{isLoading ? "..." : `${rows.length} ${isRtl ? "حركة (آخر 500)" : "movements (last 500)"}`}</span>
          <span className="text-xs text-muted-foreground">{applied.from} → {applied.to}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colDate")}</th>
                <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colTxType")}</th>
                <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colItem")}</th>
                <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colWarehouse")}</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{tr("colQty")}</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{tr("colCostPrice")}</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{tr("colTotalCost")}</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{isRtl ? "رصيد الكمية" : "Balance Qty"}</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{isRtl ? "رقم الدفعة" : "Batch No."}</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{isRtl ? "تاريخ الانتهاء" : "Expiry"}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? [...Array(8)].map((_, i) => <tr key={i}><td colSpan={10} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : rows.length === 0
                ? <tr><td colSpan={10} className="py-12 text-center text-muted-foreground"><BookOpen className="h-8 w-8 mx-auto mb-2 opacity-30" />{tr("noMoves")}</td></tr>
                : rows.map((r: any) => {
                    const color = TX_TYPE_COLOR[r.txType] ?? "bg-slate-50 text-slate-600";
                    return (
                      <tr key={r.id} className="hover:bg-muted/20">
                        <td className="px-4 py-3 tabular-nums text-xs text-muted-foreground">{r.txDate}</td>
                        <td className="px-4 py-3">
                          <span className={cn("text-[10px] font-medium rounded-full px-2 py-0.5", color)}>{txLabel(r.txType)}</span>
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-xs">{pickName(r.item?.nameAr, r.item?.nameEn) || "—"}</p>
                          <p className="text-[10px] text-muted-foreground font-mono">{r.item?.code}</p>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{pickName(r.warehouse?.nameAr, r.warehouse?.nameEn) || "—"}</td>
                        <td className={cn("px-4 py-3 text-center tabular-nums text-sm font-bold", Number(r.qty) >= 0 ? "text-green-600" : "text-red-600")}>
                          {Number(r.qty) >= 0 ? "+" : ""}{fmtQty(r.qty)}
                        </td>
                        <td className="px-4 py-3 text-center tabular-nums text-xs">{fmt(r.costPrice)}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-xs">{fmt(r.totalCost)}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-xs font-medium">{fmtQty(r.balanceQty)}</td>
                        <td className="px-4 py-3 text-center font-mono text-[11px]">{r.batchNumber ?? <span className="text-muted-foreground/40">—</span>}</td>
                        <td className="px-4 py-3 text-center tabular-nums text-[11px]">{r.expiryDate ?? <span className="text-muted-foreground/40">—</span>}</td>
                      </tr>
                    );
                  })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
