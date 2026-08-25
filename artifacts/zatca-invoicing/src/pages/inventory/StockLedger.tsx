import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
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
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(25);

  const { data: items = [] }      = useQuery({ queryKey: ["items", cid],      queryFn: () => inventoryApi.getItems(cid) });
  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses", cid], queryFn: () => inventoryApi.getWarehouses(cid) });
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
    return params;
  };
  const emptyLedgerPage = {
    rows: [] as any[],
    total: 0,
    page: 1,
    pageSize,
    pageCount: 1,
    summary: { opening: 0, totalIn: 0, totalOut: 0, final: 0 },
  };
  const { data: ledgerPage = emptyLedgerPage, isLoading } = useQuery({
    queryKey: ["stock-ledger", cid, applied, page, pageSize],
    queryFn: () => inventoryApi.getLedgerPage(ledgerParams(page, pageSize)),
  });
  const rows = ledgerPage.rows;

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

  const toExportRow = (r: any) => ({
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

  const gridColumns = useMemo<GridColumn<any>[]>(() => [
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
      key: "item",
      label: tr("colItem"),
      type: "text",
      width: 230,
      value: r => `${pickName(r.item?.nameAr, r.item?.nameEn)} ${r.item?.code ?? ""}`,
      render: r => (
        <>
          <p className="font-medium text-xs">{pickName(r.item?.nameAr, r.item?.nameEn) || "—"}</p>
          <p className="text-[10px] text-muted-foreground font-mono">{r.item?.code}</p>
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
      label: isRtl ? "رقم الدفعة" : "Batch No.",
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
  ], [t, isRtl, fmt, fmtQty]);

  return (
    <div className="w-full min-w-0 max-w-none space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><BookOpen className="h-6 w-6 text-primary" />{tr("title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          loadRows={loadAllExportRows}
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
          <Button size="sm" onClick={() => { setPage(1); setApplied({ ...filters }); }} className="gap-2">
            <Search className="h-3.5 w-3.5" />{t("inventoryReports.common.show") as string}
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="w-full min-w-0 overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="px-4 py-3 border-b bg-muted/20 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{isLoading ? "..." : `${ledgerPage.total} ${isRtl ? "حركة" : "movements"}`}</span>
          <span className="text-xs text-muted-foreground">{applied.from} → {applied.to}</span>
        </div>
        {isLoading ? (
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
            emptyMessage={tr("noMoves")}
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
