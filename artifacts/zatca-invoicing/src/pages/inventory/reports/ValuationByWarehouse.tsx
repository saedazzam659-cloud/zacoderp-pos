import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Skeleton } from "@/components/ui/skeleton";
import ExportButtons from "@/components/ExportButtons";
import { Wallet } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import AdvancedReportGrid, { type GridColumn } from "@/components/auditGrid/AdvancedReportGrid";

export default function ValuationByWarehouse() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const pickName = (ar?: string | null, en?: string | null) => (isRtl ? (ar ?? en) : (en ?? ar)) ?? "";
  const { fmt, fmtQty, fmtVal } = useFmt();
  const { user } = useAuth();

  const EXPORT_COLS = [
    { key: "warehouseCode", header: t("inventoryReports.valuation.cols.warehouseCode"), width: 14 },
    { key: "warehouseName", header: t("inventoryReports.common.warehouse"),             width: 28 },
    { key: "itemCount",     header: t("inventoryReports.valuation.cols.itemCount"),      width: 14 },
    { key: "totalQty",      header: t("inventoryReports.valuation.cols.totalQty"),       width: 16 },
    { key: "totalValue",    header: t("inventoryReports.valuation.cols.totalValue"),     width: 18 },
    { key: "share",         header: t("inventoryReports.valuation.cols.share"),          width: 16 },
  ];
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const { data: warehouses = [] } = useQuery({
    queryKey: ["warehouses", cid],
    queryFn: () => inventoryApi.getWarehouses(cid),
  });
  const { data: balances = [], isLoading } = useQuery({
    queryKey: ["stock-balance-all", cid],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (cid) params.companyId = String(cid);
      return inventoryApi.getBalance(params);
    },
  });

  // Group balances by warehouse
  type Agg = { whId: number; itemCount: number; totalQty: number; totalValue: number };
  const aggMap: Record<number, Agg> = {};
  (balances as any[]).forEach((b: any) => {
    const id = Number(b.warehouseId);
    if (!aggMap[id]) aggMap[id] = { whId: id, itemCount: 0, totalQty: 0, totalValue: 0 };
    if (Number(b.qty) !== 0) aggMap[id].itemCount += 1;
    aggMap[id].totalQty += Number(b.qty);
    aggMap[id].totalValue += Number(b.qty) * Number(b.avgCost);
  });

  const rows = (warehouses as any[]).map((w: any) => {
    const a = aggMap[w.id] ?? { whId: w.id, itemCount: 0, totalQty: 0, totalValue: 0 };
    return { ...w, ...a };
  });

  const grandValue = rows.reduce((s, r) => s + r.totalValue, 0);
  const grandQty   = rows.reduce((s, r) => s + r.totalQty, 0);
  const grandItems = rows.reduce((s, r) => s + r.itemCount, 0);

  const exportRows = rows.map((r: any) => ({
    warehouseCode: r.code ?? "",
    warehouseName: pickName(r.nameAr, r.nameEn),
    itemCount:     r.itemCount,
    totalQty:      fmtQty(r.totalQty),
    totalValue:    fmt(r.totalValue),
    share:         grandValue > 0 ? `${((r.totalValue / grandValue) * 100).toFixed(2)}%` : "0%",
  }));

  const gridColumns = useMemo<GridColumn<any>[]>(() => [
    {
      key: "warehouse",
      label: t("inventoryReports.common.warehouse"),
      type: "text",
      width: 280,
      value: r => `${pickName(r.nameAr, r.nameEn)} ${r.code ?? ""}`,
      render: r => (
        <>
          <p className="font-medium text-sm">{pickName(r.nameAr, r.nameEn) || "—"}</p>
          <p className="text-[10px] text-muted-foreground font-mono">{r.code}</p>
        </>
      ),
    },
    {
      key: "itemCount",
      label: t("inventoryReports.valuation.cols.itemCount"),
      type: "num",
      align: "center",
      width: 140,
      className: "tabular-nums",
      value: r => Number(r.itemCount),
      render: r => r.itemCount,
    },
    {
      key: "totalQty",
      label: t("inventoryReports.valuation.cols.totalQty"),
      type: "num",
      align: "center",
      width: 150,
      className: "tabular-nums",
      value: r => Number(r.totalQty),
      render: r => fmtQty(r.totalQty),
    },
    {
      key: "totalValue",
      label: t("inventoryReports.valuation.cols.totalValue"),
      type: "num",
      align: "center",
      width: 170,
      className: "tabular-nums font-semibold",
      value: r => Number(r.totalValue),
      render: r => fmt(r.totalValue),
    },
    {
      key: "share",
      label: t("inventoryReports.valuation.cols.share"),
      type: "num",
      align: "center",
      width: 210,
      value: r => grandValue > 0 ? (r.totalValue / grandValue) * 100 : 0,
      render: r => {
        const share = grandValue > 0 ? (r.totalValue / grandValue) * 100 : 0;
        return (
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-primary" style={{ width: `${Math.min(100, share)}%` }} />
            </div>
            <span className="text-xs tabular-nums w-12 text-left">{share.toFixed(1)}%</span>
          </div>
        );
      },
    },
  ], [grandValue, isRtl, t, fmt, fmtQty]);

  return (
    <div className="w-full min-w-0 max-w-none space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Wallet className="h-6 w-6 text-primary" />{t("inventoryReports.valuation.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("inventoryReports.valuation.subtitle")}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`${t("inventoryReports.valuation.exportFilename")}-${new Date().toISOString().slice(0, 10)}`}
          title={t("inventoryReports.valuation.exportTitle")}
          subtitle={t("inventoryReports.valuation.exportSubtitle", { value: fmt(grandValue) })}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-primary/5 border-primary/10 p-4">
          <p className="text-xs text-muted-foreground">{t("inventoryReports.valuation.cards.totalValue")}</p>
          <p className="text-2xl font-bold tabular-nums mt-1">{fmtVal(grandValue)}</p>
          <p className="text-xs text-muted-foreground">{t("inventoryReports.valuation.cards.sar")}</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">{t("inventoryReports.valuation.cards.totalQty")}</p>
          <p className="text-2xl font-bold tabular-nums mt-1">{fmtQty(grandQty)}</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">{t("inventoryReports.valuation.cards.itemsInWarehouses")}</p>
          <p className="text-2xl font-bold tabular-nums mt-1">{grandItems}</p>
        </div>
      </div>

      <div className="w-full min-w-0 overflow-hidden rounded-xl shadow-sm">
        {isLoading ? (
          <div className="space-y-2 rounded-xl border bg-card p-4">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        ) : (
          <AdvancedReportGrid
            slug="inventoryValuationByWarehouseGrid"
            cid={cid}
            columns={gridColumns}
            rowKey={(row: any) => row.id}
            rows={rows}
            unitLabel={isRtl ? "مستودع" : "warehouse"}
            emptyMessage={t("inventoryReports.valuation.empty")}
            totalsRow={rows.length > 0 ? {
              __label: t("inventoryReports.valuation.grandTotal"),
              itemCount: grandItems,
              totalQty: fmtQty(grandQty),
              totalValue: fmt(grandValue),
              share: "100%",
            } : null}
          />
        )}
      </div>
    </div>
  );
}
