import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { purchaseAnalyticsApi } from "@/lib/purchaseAnalyticsApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import BranchFilter from "@/components/BranchFilter";
import { useTranslation } from "react-i18next";
import { Package, Search } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import { DateField } from "@/components/ui/date-field";
import { inventoryApi } from "@/lib/inventoryApi";
import { clothingVariantItemIds } from "@/lib/clothingStockReport";

export default function PurchasesByItem({ clothingOnly = false }: { clothingOnly?: boolean }) {
  const { fmt, fmtQty } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const pickName = (ar?: string | null, en?: string | null) => (isRtl ? (ar ?? en) : (en ?? ar)) ?? "";
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [from, setFrom] = useState(firstDay);
  const [to, setTo] = useState(today);
  const [branchId, setBranchId] = useState<number | undefined>(undefined);
  const [search, setSearch] = useState("");

  const EXPORT_COLS = [
    { key: "itemCode",       header: t("purchasingReports.byItem.itemCode"),       width: 14 },
    { key: "itemName",       header: t("purchasingReports.byItem.itemName"),       width: 30 },
    ...(clothingOnly ? [
      { key: "modelName", header: t("inventoryReports.clothingPurchases.model"), width: 24 },
      { key: "color", header: t("inventoryReports.clothingPurchases.color"), width: 16 },
      { key: "size", header: t("inventoryReports.clothingPurchases.size"), width: 12 },
    ] : []),
    { key: "unit",           header: t("purchasingReports.byItem.unit"),           width: 10 },
    { key: "qty",            header: t("purchasingReports.byItem.qty"),            width: 14 },
    { key: "totalPurchases", header: t("purchasingReports.byItem.totalPurchases"), width: 16 },
    { key: "invoiceCount",   header: t("purchasingReports.byItem.invoiceCount"),   width: 14 },
    { key: "share",          header: t("purchasingReports.byItem.share"),          width: 14 },
  ];

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["purchases-by-item", cid, from, to, branchId],
    queryFn: () => purchaseAnalyticsApi.byItem(cid, from, to, branchId),
  });

  const itemsQuery = useQuery({
    queryKey: ["items", cid],
    queryFn: () => inventoryApi.getItems(cid),
    enabled: clothingOnly,
  });
  const clothingIds = useMemo(() => clothingVariantItemIds(itemsQuery.data ?? []), [itemsQuery.data]);
  const itemById = useMemo(
    () => new Map<number, any>((itemsQuery.data ?? []).map((item: any) => [Number(item.id), item])),
    [itemsQuery.data],
  );
  const enrichedRows = (rows as any[])
    .filter((row) => !clothingOnly || clothingIds.has(Number(row.itemId)))
    .map((row) => {
      const item = itemById.get(Number(row.itemId));
      const model = item?.parentItemId ? itemById.get(Number(item.parentItemId)) : null;
      const attributes = item?.variantAttributes ?? {};
      return {
        ...row,
        modelName: pickName(model?.nameAr, model?.nameEn),
        color: String(attributes["اللون"] ?? ""),
        size: String(attributes["المقاس"] ?? ""),
      };
    });
  const filtered = enrichedRows.filter(r =>
    !search || r.itemName?.includes(search) || r.itemName?.toLowerCase().includes(search.toLowerCase())
      || r.itemCode?.includes(search) || r.modelName?.includes(search) || r.color?.includes(search) || r.size?.includes(search)
  );

  const reportTitle = clothingOnly ? t("inventoryReports.clothingPurchases.title") : t("purchasingReports.byItem.title");
  const reportSubtitle = clothingOnly ? t("inventoryReports.clothingPurchases.subtitle") : t("purchasingReports.byItem.subtitle");
  const loading = isLoading || (clothingOnly && itemsQuery.isLoading);
  const grandPurchases = filtered.reduce((s, r) => s + r.totalPurchases, 0);
  const grandQty       = filtered.reduce((s, r) => s + r.qty, 0);

  const exportRows = filtered.map(r => ({
    itemCode:       r.itemCode ?? "",
    itemName:       clothingOnly ? `${r.modelName} — ${r.color || "—"} — ${r.size || "—"}` : r.itemName,
    modelName:      r.modelName ?? "",
    color:          r.color ?? "",
    size:           r.size ?? "",
    unit:           r.unit ?? "",
    qty:            fmtQty(r.qty),
    totalPurchases: fmt(r.totalPurchases),
    invoiceCount:   r.invoiceCount,
    share:          grandPurchases > 0 ? `${((r.totalPurchases / grandPurchases) * 100).toFixed(2)}%` : "0%",
  }));

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><Package className="h-6 w-6 text-primary" />{reportTitle}</h1>
            <p className="text-muted-foreground text-sm mt-1">{reportSubtitle}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`${clothingOnly ? t("inventoryReports.clothingPurchases.filename") : t("purchasingReports.byItem.filename")}-${from}-${to}`}
          title={clothingOnly ? reportTitle : t("purchasingReports.byItem.exportTitle")}
          subtitle={clothingOnly ? `${reportSubtitle} — ${from} / ${to}` : t("purchasingReports.byItem.subtitleTotal", { from, to, total: fmt(grandPurchases) })}
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border bg-purple-50 border-purple-200 p-3">
          <p className="text-[11px] text-purple-700">{t("purchasingReports.byItem.itemsCount")}</p>
          <p className="text-xl font-bold text-purple-700 tabular-nums mt-1">{filtered.length}</p>
        </div>
        <div className="rounded-xl border bg-card p-3">
          <p className="text-[11px] text-muted-foreground">{t("purchasingReports.byItem.totalQty")}</p>
          <p className="text-xl font-bold tabular-nums mt-1">{fmtQty(grandQty)}</p>
        </div>
        <div className="rounded-xl border bg-primary/5 border-primary/10 p-3">
          <p className="text-[11px] text-muted-foreground">{t("purchasingReports.byItem.totalValue")}</p>
          <p className="text-xl font-bold tabular-nums mt-1">{fmt(grandPurchases)}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="space-y-1.5">
          <Label>{t("purchasingPages.common.fromDate")}</Label>
          <DateField value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("purchasingPages.common.toDate")}</Label>
          <DateField value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("common.branch")}</Label>
          <BranchFilter value={branchId} onChange={setBranchId} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label>{t("purchasingReports.byItem.search")}</Label>
          <div className="relative">
            <Search className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground`} />
            <Input className={isRtl ? "pr-9" : "pl-9"} placeholder={t("purchasingReports.byItem.searchPh")} value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      {clothingOnly && itemsQuery.isError && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
          {t("inventoryReports.clothingPurchases.loadError")}
          <button type="button" className="ms-3 font-semibold underline" onClick={() => void itemsQuery.refetch()}>
            {t("inventoryReports.clothingPurchases.retry")}
          </button>
        </div>
      )}

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[800px]">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className={`px-3 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{t("purchasingReports.byItem.item")}</th>
                <th className={`px-3 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground hidden sm:table-cell`}>{t("purchasingReports.byItem.unit")}</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground">{t("purchasingReports.byItem.qtyShort")}</th>
                <th className="px-3 py-3 text-center font-semibold text-blue-700">{t("purchasingReports.byItem.totalPurchases")}</th>
                <th className="px-3 py-3 text-center font-semibold text-muted-foreground hidden md:table-cell">{t("purchasingReports.byItem.invoiceCount")}</th>
                <th className={`px-3 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{t("purchasingReports.byItem.share")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {loading
                ? [...Array(6)].map((_, i) => <tr key={i}><td colSpan={6} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
                : filtered.length === 0
                ? <tr><td colSpan={6} className="py-12 text-center text-muted-foreground">{t("purchasingReports.byItem.noData")}</td></tr>
                : filtered.map((r: any, i: number) => {
                    const share = grandPurchases > 0 ? (r.totalPurchases / grandPurchases) * 100 : 0;
                    return (
                      <tr key={`${r.itemId ?? r.itemName}-${i}`} className="hover:bg-muted/20">
                        <td className="px-3 py-3">
                          <p className="font-medium text-sm">{clothingOnly ? (r.modelName || r.itemName) : r.itemName}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {clothingOnly ? `${r.color || "—"} / ${r.size || "—"} · ` : ""}
                            {r.itemCode && <span className="font-mono">{r.itemCode}</span>}
                          </p>
                        </td>
                        <td className="px-3 py-3 hidden sm:table-cell text-xs text-muted-foreground">{r.unit ?? "—"}</td>
                        <td className="px-3 py-3 text-center tabular-nums text-sm">{fmtQty(r.qty)}</td>
                        <td className="px-3 py-3 text-center tabular-nums text-sm font-bold text-blue-600">{fmt(r.totalPurchases)}</td>
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
            {!loading && filtered.length > 0 && (
              <tfoot className="bg-muted/30 border-t">
                <tr>
                  <td colSpan={2} className="px-3 py-3 text-xs font-bold">{t("purchasingReports.byItem.total")}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums">{fmtQty(grandQty)}</td>
                  <td className="px-3 py-3 text-center font-bold tabular-nums text-blue-700">{fmt(grandPurchases)}</td>
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
