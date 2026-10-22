import { useMemo, useState } from "react";
import { localizedName } from "@/lib/localizedName";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi, type StockLedgerRow } from "@/lib/inventoryApi";
import { Link } from "wouter";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import { BookOpen, Search, Filter } from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { useFmt } from "@/hooks/use-fmt";
import { DateField } from "@/components/ui/date-field";
import { TablePagination, type PageSize } from "@/components/TablePagination";
import AdvancedReportGrid, { type GridColumn } from "@/components/auditGrid/AdvancedReportGrid";
import {
  InventoryBrandFilter,
  filterItemsForInventoryBrand,
  useInventoryReportBrandOptions,
} from "@/components/InventoryBrandFilter";
import { clothingVariantItemIds } from "@/lib/clothingStockReport";

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

// Only destinations that exist in App.tsx. List-only screens intentionally use
// the collection route; never append an ID to a route without a detail screen.
const SOURCE_ROUTES: Record<string, (id: number) => string> = {
  sales_invoice: id => `/sales/invoices/${id}`,
  purchase_invoice: id => `/purchasing/invoices/${id}`,
  sales_return: () => "/sales/returns",
  purchase_return: () => "/purchasing/returns",
  transfer: () => "/inventory/transfers",
  adjustment: () => "/inventory/adjustments",
  count: () => "/inventory/counts",
  goods_receipt: () => "/inventory/goods-receipts",
  goods_delivery: () => "/inventory/goods-deliveries",
  production_order: id => `/production/orders/${id}`,
  production_order_reversal: id => `/production/orders/${id}`,
  production_order_cancel: id => `/production/orders/${id}`,
  sister_transfer: id => `/inventory/sister-transfers/${id}`,
  sister_return: id => `/inventory/sister-returns/${id}`,
};

const SOURCE_LABELS: Record<string, [string, string]> = {
  sales_invoice: ["فاتورة بيع", "Sales invoice"],
  purchase_invoice: ["فاتورة شراء", "Purchase invoice"],
  sales_return: ["مرتجع بيع", "Sales return"],
  purchase_return: ["مرتجع شراء", "Purchase return"],
  transfer: ["تحويل مخزون", "Stock transfer"],
  adjustment: ["تسوية مخزون", "Stock adjustment"],
  count: ["جرد مخزون", "Stock count"],
  goods_receipt: ["إذن استلام", "Goods receipt"],
  goods_delivery: ["إذن تسليم", "Goods delivery"],
  production_order: ["أمر إنتاج", "Production order"],
  production_order_reversal: ["عكس أمر إنتاج", "Production reversal"],
  production_order_cancel: ["إلغاء أمر إنتاج", "Production cancellation"],
  sister_transfer: ["تحويل شركة شقيقة", "Sister transfer"],
  sister_return: ["مرتجع شركة شقيقة", "Sister return"],
  opening_balance: ["رصيد افتتاحي", "Opening balance"],
};

export default function StockLedger({ clothingOnly = false }: { clothingOnly?: boolean }) {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`inventoryReports.stockLedger.${k}`, opts) as string;
  const pickName = (ar?: string | null, en?: string | null) => localizedName(ar, en, isRtl ? "ar" : "en");
  const txLabel = (txType: string) => {
    const v = t(`inventoryReports.stockLedger.txType.${txType}`, { defaultValue: "" }) as string;
    return v || txType;
  };

  const { fmt, fmtQty } = useFmt();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [filters, setFilters] = useState({ from: firstDay, to: today, itemId: "", warehouseId: "", brandId: "" });
  const [applied, setApplied] = useState({ from: firstDay, to: today, itemId: "", warehouseId: "", brandId: "" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(25);

  const itemsQuery = useQuery({ queryKey: ["items", cid], queryFn: () => inventoryApi.getItems(cid) });
  const warehousesQuery = useQuery({ queryKey: ["warehouses", cid], queryFn: () => inventoryApi.getWarehouses(cid) });
  const items = itemsQuery.data ?? [];
  const warehouses = warehousesQuery.data ?? [];
  const brandOptions = useInventoryReportBrandOptions(cid);
  const clothingIds = useMemo(
    () => clothingOnly ? clothingVariantItemIds(items as any[]) : null,
    [clothingOnly, items],
  );
  const itemById = useMemo(
    () => new Map<number, any>((items as any[]).map((item) => [Number(item.id), item])),
    [items],
  );
  const filteredItems = filterItemsForInventoryBrand(items as any[], filters.brandId, brandOptions)
    .filter((item: any) => !clothingOnly || clothingIds?.has(Number(item.id)));
  const selectedItem = clothingOnly
    ? itemById.get(Number(applied.itemId))
    : undefined;
  const selectedModel = selectedItem?.parentItemId
    ? itemById.get(Number(selectedItem.parentItemId))
    : undefined;
  const selectedAttributes = selectedItem?.variantAttributes ?? {};
  const selectedModelName = pickName(selectedModel?.nameAr, selectedModel?.nameEn);
  const selectedColor = String(selectedAttributes["اللون"] ?? "");
  const selectedSize = String(selectedAttributes["المقاس"] ?? "");
  const awaitingVariant = clothingOnly && !applied.itemId;
  const ledgerParams = (pageNumber: number, size: number) => {
    const params: Record<string, string> = {
      page: String(pageNumber),
      pageSize: String(size),
    };
    if (cid)                   params.companyId   = String(cid);
    if (applied.from)          params.from        = applied.from;
    if (applied.to)            params.to          = applied.to;
    if (applied.itemId)        params.itemId      = applied.itemId;
    if (applied.warehouseId)   params.warehouseId = applied.warehouseId;
    if (applied.brandId)       params.brandId     = applied.brandId;
    return params;
  };
  const emptyLedgerPage = {
    rows: [] as StockLedgerRow[],
    total: 0,
    page: 1,
    pageSize,
    pageCount: 1,
    summary: { opening: 0, totalIn: 0, totalOut: 0, final: 0 },
  };
  const { data: ledgerPage = emptyLedgerPage, isLoading } = useQuery({
    queryKey: ["stock-ledger", cid, applied, page, pageSize],
    queryFn: () => inventoryApi.getLedgerPage(ledgerParams(page, pageSize)),
    enabled: !awaitingVariant,
  });
  const rows = ledgerPage.rows;
  const sourceLabel = (r: StockLedgerRow) => {
    const type = r.refType ?? r.txType;
    const name = SOURCE_LABELS[type]?.[isRtl ? 0 : 1] ?? type.replaceAll("_", " ");
    const number = r.documentNumber || (r.refId != null && r.refId > 0 ? `#${r.refId}` : "");
    return number ? `${name} ${number}` : name;
  };
  const sourcePath = (r: StockLedgerRow) =>
    r.refType && r.refId != null && r.refId > 0 ? SOURCE_ROUTES[r.refType]?.(r.refId) : undefined;

  const EXPORT_COLS = [
    { key: "txDate",       header: tr("exportDate"),       width: 14 },
    { key: "txType",       header: tr("exportTxType"),     width: 18 },
    { key: "source",       header: isRtl ? "المستند المصدر" : "Source document", width: 26 },
    ...(clothingOnly ? [
      { key: "modelName", header: t("inventoryReports.clothingVariantLedger.model"), width: 24 },
      { key: "color", header: t("inventoryReports.clothingVariantLedger.color"), width: 16 },
      { key: "size", header: t("inventoryReports.clothingVariantLedger.size"), width: 12 },
    ] : []),
    { key: "itemCode",     header: tr("exportItemCode"),   width: 16 },
    ...(!clothingOnly ? [{ key: "itemName", header: tr("exportItemName"), width: 30 }] : []),
    { key: "warehouseName",header: tr("exportWarehouse"),  width: 22 },
    { key: "qty",          header: tr("exportQty"),        width: 14 },
    { key: "costPrice",    header: tr("exportCostPrice"),  width: 16 },
    { key: "totalCost",    header: tr("exportTotalCost"),  width: 18 },
    { key: "batchNumber",  header: isRtl ? "رقم التشغيلة" : "Batch No.", width: 16 },
    { key: "expiryDate",   header: isRtl ? "تاريخ الانتهاء" : "Expiry Date", width: 16 },
  ];

  const toExportRow = (r: StockLedgerRow) => ({
    txDate:        r.txDate,
    txType:        txLabel(r.txType),
    source:        sourceLabel(r),
    itemCode:      r.item?.code ?? "",
    itemName:      pickName(r.item?.nameAr, r.item?.nameEn),
    modelName:     selectedModelName,
    color:         selectedColor,
    size:          selectedSize,
    warehouseName: pickName(r.warehouse?.nameAr, r.warehouse?.nameEn),
    qty:           fmtQty(r.qty),
    costPrice:     fmt(r.costPrice),
    totalCost:     fmt(r.totalCost),
    batchNumber:   r.batchNumber ?? "",
    expiryDate:    r.expiryDate  ?? "",
  });
  const exportRows = rows.map(toExportRow);
  const loadAllExportRows = async () => {
    const first = await inventoryApi.getLedgerPage(ledgerParams(1, 1000));
    const remaining = first.pageCount > 1
      ? await Promise.all(
          Array.from(
            { length: first.pageCount - 1 },
            (_, index) => inventoryApi.getLedgerPage(ledgerParams(index + 2, 1000)),
          ),
        )
      : [];
    return [first, ...remaining].flatMap(result => result.rows).map(toExportRow);
  };

  const gridColumns = useMemo<GridColumn<StockLedgerRow>[]>(() => [
    {
      key: "txDate",
      label: tr("colDate"),
      type: "text",
      width: 110,
      className: "tabular-nums text-xs text-muted-foreground",
      value: r => r.txDate,
    },
    {
      key: "txType",
      label: tr("colTxType"),
      type: "text",
      width: 135,
      value: r => txLabel(r.txType),
      render: r => (
        <span className={cn(
          "text-[10px] font-medium rounded-full px-2 py-0.5",
          TX_TYPE_COLOR[r.txType] ?? "bg-slate-50 text-slate-600",
        )}>
          {txLabel(r.txType)}
        </span>
      ),
    },
    {
      key: "source",
      label: isRtl ? "المستند المصدر" : "Source document",
      type: "text",
      width: 205,
      className: "text-xs",
      value: r => sourceLabel(r),
      render: r => {
        const label = sourceLabel(r);
        const path = sourcePath(r);
        return path ? (
          <Link href={path} className="text-primary hover:underline font-medium" data-testid={`link-stock-source-${r.id}`}>
            {label}
          </Link>
        ) : <span data-testid={`text-stock-source-${r.id}`}>{label}</span>;
      },
    },
    {
      key: "item",
      label: clothingOnly ? t("inventoryReports.clothingVariantLedger.model") : tr("colItem"),
      type: "text",
      width: 230,
      value: r => clothingOnly
        ? `${selectedModelName} ${selectedColor} ${selectedSize} ${r.item?.code ?? ""}`
        : `${pickName(r.item?.nameAr, r.item?.nameEn)} ${r.item?.code ?? ""}`,
      render: r => (
        <>
          <p className="font-medium text-xs">{(clothingOnly ? selectedModelName : pickName(r.item?.nameAr, r.item?.nameEn)) || "—"}</p>
          <p className="text-[10px] text-muted-foreground">
            <span className="font-mono">{r.item?.code}</span>
            {clothingOnly && ` · ${selectedColor || "—"} / ${selectedSize || "—"}`}
          </p>
        </>
      ),
    },
    {
      key: "warehouse",
      label: tr("colWarehouse"),
      type: "text",
      width: 170,
      className: "text-xs text-muted-foreground",
      value: r => pickName(r.warehouse?.nameAr, r.warehouse?.nameEn),
      render: r => pickName(r.warehouse?.nameAr, r.warehouse?.nameEn) || "—",
    },
    {
      key: "qty",
      label: tr("colQty"),
      type: "num",
      align: "center",
      width: 105,
      className: "tabular-nums text-sm font-bold",
      value: r => Number(r.qty),
      render: r => (
        <span className={Number(r.qty) >= 0 ? "text-green-600" : "text-red-600"}>
          {Number(r.qty) >= 0 ? "+" : ""}{fmtQty(r.qty)}
        </span>
      ),
    },
    {
      key: "costPrice",
      label: tr("colCostPrice"),
      type: "num",
      align: "center",
      width: 115,
      className: "tabular-nums text-xs",
      value: r => Number(r.costPrice),
      render: r => fmt(r.costPrice),
    },
    {
      key: "totalCost",
      label: tr("colTotalCost"),
      type: "num",
      align: "center",
      width: 120,
      className: "tabular-nums text-xs",
      value: r => Number(r.totalCost),
      render: r => fmt(r.totalCost),
    },
    {
      key: "balanceQty",
      label: isRtl ? "رصيد الكمية" : "Balance Qty",
      type: "num",
      align: "center",
      width: 115,
      className: "tabular-nums text-xs font-medium",
      value: r => Number(r.balanceQty),
      render: r => fmtQty(r.balanceQty),
    },
    {
      key: "batchNumber",
      label: isRtl ? "رقم التشغيلة" : "Batch No.",
      type: "text",
      align: "center",
      width: 115,
      className: "font-mono text-[11px]",
      value: r => r.batchNumber,
      render: r => r.batchNumber ?? <span className="text-muted-foreground/40">—</span>,
    },
    {
      key: "expiryDate",
      label: isRtl ? "تاريخ الانتهاء" : "Expiry",
      type: "text",
      align: "center",
      width: 115,
      className: "tabular-nums text-[11px]",
      value: r => r.expiryDate,
      render: r => r.expiryDate ?? <span className="text-muted-foreground/40">—</span>,
    },
  ], [t, isRtl, fmt, fmtQty, clothingOnly, selectedModelName, selectedColor, selectedSize]);

  const reportTitle = clothingOnly
    ? t("inventoryReports.clothingVariantLedger.title")
    : tr("title");
  const reportSubtitle = clothingOnly
    ? t("inventoryReports.clothingVariantLedger.subtitle")
    : tr("subtitle");

  return (
    <div className="w-full min-w-0 max-w-none space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><BookOpen className="h-6 w-6 text-primary" />{reportTitle}</h1>
          <p className="text-muted-foreground text-sm mt-1">{reportSubtitle}</p>
        </div>
        {!awaitingVariant && (
          <ExportButtons
            rows={exportRows}
            loadRows={loadAllExportRows}
            columns={EXPORT_COLS}
            filename={`${clothingOnly ? t("inventoryReports.clothingVariantLedger.exportFilename") : tr("exportFilename")}-${applied.from}-${applied.to}`}
            title={clothingOnly ? reportTitle : tr("exportTitle")}
            subtitle={tr("exportSubtitleRange", { from: applied.from, to: applied.to })}
          />
        )}
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
            <Label>{clothingOnly ? t("inventoryReports.clothingVariantLedger.variant") : t("inventoryReports.common.item") as string}</Label>
            <SearchCombobox
              items={[
                { value: "", label: clothingOnly
                  ? t("inventoryReports.clothingVariantLedger.selectVariant")
                  : (isRtl ? "كل الأصناف" : "All Items") },
                ...filteredItems.map((it: any) => {
                  const model = clothingOnly && it.parentItemId ? itemById.get(Number(it.parentItemId)) : null;
                  const attributes = it.variantAttributes ?? {};
                  return {
                    value: String(it.id),
                    code: it.code,
                    label: clothingOnly
                      ? `${pickName(model?.nameAr, model?.nameEn) || pickName(it.nameAr, it.nameEn)} — ${String(attributes["اللون"] ?? "—")} — ${String(attributes["المقاس"] ?? "—")}`
                      : pickName(it.nameAr, it.nameEn),
                    labelEn: it.nameEn,
                  };
                }),
              ]}
              value={filters.itemId}
              onValueChange={v => setFilters(p => ({ ...p, itemId: v }))}
              placeholder={clothingOnly
                ? t("inventoryReports.clothingVariantLedger.selectVariant")
                : (isRtl ? "كل الأصناف" : "All Items")}
            />
          </div>
          <InventoryBrandFilter
            options={brandOptions}
            value={filters.brandId}
            onChange={v => setFilters(p => ({ ...p, brandId: v, itemId: "" }))}
          />
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
          <Button size="sm" onClick={() => { setPage(1); setApplied({ ...filters }); }} className="gap-2">
            <Search className="h-3.5 w-3.5" />{t("inventoryReports.common.show") as string}
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="w-full min-w-0 overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="px-4 py-3 border-b bg-muted/20 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{isLoading ? "..." : awaitingVariant ? "" : `${ledgerPage.total} ${isRtl ? "حركة" : "movements"}`}</span>
          <span className="text-xs text-muted-foreground">{applied.from} → {applied.to}</span>
        </div>
        {awaitingVariant ? (
          <p className="p-6 text-center text-sm text-muted-foreground">{t("inventoryReports.clothingVariantLedger.selectVariantHint")}</p>
        ) : isLoading ? (
          <div className="space-y-2 p-4">
            {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        ) : (
          <AdvancedReportGrid
            slug="stockLedgerGrid"
            cid={cid}
            columns={gridColumns}
            rowKey={(row: any) => row.id}
            rows={rows}
            paginate={false}
            unitLabel={isRtl ? "حركة" : "movement"}
            emptyMessage={clothingOnly ? t("inventoryReports.clothingVariantLedger.noMoves") : tr("noMoves")}
          />
        )}
        {!isLoading && rows.length > 0 && (
          <TablePagination
            page={page}
            pageSize={pageSize}
            pageCount={ledgerPage.pageCount}
            total={ledgerPage.total}
            onPageChange={setPage}
            onPageSizeChange={(nextSize) => {
              setPageSize(nextSize);
              setPage(1);
            }}
            pageSizeOptions={[10, 25, 50, 100, 1000]}
            itemLabel={isRtl ? "حركة" : "movement"}
            className="border-t border-border/80 bg-gradient-to-b from-muted/20 to-muted/40 px-3 py-3"
          />
        )}
      </div>
    </div>
  );
}
