import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { purchaseAnalyticsApi } from "@/lib/purchaseAnalyticsApi";
import { inventoryApi } from "@/lib/inventoryApi";
import { clothingVariantItemIds } from "@/lib/clothingStockReport";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import BranchFilter from "@/components/BranchFilter";
import ExportButtons from "@/components/ExportButtons";
import AdvancedReportGrid, { type GridColumn } from "@/components/auditGrid/AdvancedReportGrid";

type ClothingPurchaseReturnRow = {
  itemId: number;
  rowKey: string;
  itemCode: string;
  itemName: string;
  modelName: string;
  color: string;
  size: string;
  unit: string;
  currencyCode: string;
  returnedQty: number;
  totalReturns: number;
  returnCount: number;
};

export default function ClothingPurchaseReturnsReport() {
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

  const returnsQuery = useQuery({
    queryKey: ["clothing-purchase-returns-by-item", cid, from, to, branchId],
    queryFn: () => purchaseAnalyticsApi.returnsByItem(cid, from, to, branchId),
  });
  const itemsQuery = useQuery({
    queryKey: ["items", cid],
    queryFn: () => inventoryApi.getItems(cid),
  });

  const clothingIds = useMemo(() => clothingVariantItemIds(itemsQuery.data ?? []), [itemsQuery.data]);
  const itemById = useMemo(
    () => new Map<number, any>((itemsQuery.data ?? []).map((item: any) => [Number(item.id), item])),
    [itemsQuery.data],
  );
  const rows = useMemo<ClothingPurchaseReturnRow[]>(() => (returnsQuery.data ?? [])
    .filter((row) => row.itemId != null && clothingIds.has(Number(row.itemId)))
    .map((row) => {
      const itemId = Number(row.itemId);
      const item = itemById.get(itemId);
      const model = item?.parentItemId ? itemById.get(Number(item.parentItemId)) : null;
      const attributes = item?.variantAttributes ?? {};
      const modelName = pickName(model?.nameAr, model?.nameEn);
      return {
        itemId,
        rowKey: `${itemId}:${row.unit ?? ""}:${row.currencyCode}`,
        itemCode: item?.code ?? row.itemCode ?? "",
        itemName: pickName(item?.nameAr, item?.nameEn) || row.itemName,
        modelName,
        color: String(attributes["اللون"] ?? ""),
        size: String(attributes["المقاس"] ?? ""),
        unit: row.unit ?? (isRtl
          ? item?.unit?.nameAr ?? item?.unitNameAr
          : item?.unit?.nameEn ?? item?.unit?.nameAr ?? item?.unitNameAr) ?? "",
        currencyCode: row.currencyCode?.trim() ?? "",
        returnedQty: Number(row.returnedQty),
        totalReturns: Number(row.totalReturns),
        returnCount: row.returnCount,
      };
    }), [returnsQuery.data, clothingIds, itemById, isRtl]);

  const columns = useMemo<GridColumn<ClothingPurchaseReturnRow>[]>(() => [
    { key: "itemCode", label: t("inventoryReports.clothingPurchaseReturns.itemCode"), type: "text", value: row => row.itemCode, width: 125 },
    { key: "modelName", label: t("inventoryReports.clothingPurchaseReturns.model"), type: "text", value: row => row.modelName, width: 190 },
    { key: "color", label: t("inventoryReports.clothingPurchaseReturns.color"), type: "text", value: row => row.color, width: 115 },
    { key: "size", label: t("inventoryReports.clothingPurchaseReturns.size"), type: "text", value: row => row.size, width: 95 },
    { key: "unit", label: t("inventoryReports.clothingPurchaseReturns.unit"), type: "text", value: row => row.unit, width: 90 },
    { key: "returnedQty", label: t("inventoryReports.clothingPurchaseReturns.returnedQty"), type: "num", align: "end", value: row => row.returnedQty, render: row => fmtQty(row.returnedQty), width: 125 },
    { key: "totalReturns", label: t("inventoryReports.clothingPurchaseReturns.lineValue"), type: "num", align: "end", value: row => row.totalReturns, render: row => `${fmt(row.totalReturns)} ${row.currencyCode}`, width: 160 },
    { key: "currencyCode", label: t("inventoryReports.clothingPurchaseReturns.currency"), type: "text", value: row => row.currencyCode, width: 95 },
    { key: "returnCount", label: t("inventoryReports.clothingPurchaseReturns.returnCount"), type: "num", align: "end", value: row => row.returnCount, width: 110 },
  ], [t, fmt, fmtQty]);

  const exportColumns = [
    { key: "itemCode", header: t("inventoryReports.clothingPurchaseReturns.itemCode"), width: 16 },
    { key: "modelName", header: t("inventoryReports.clothingPurchaseReturns.model"), width: 26 },
    { key: "color", header: t("inventoryReports.clothingPurchaseReturns.color"), width: 16 },
    { key: "size", header: t("inventoryReports.clothingPurchaseReturns.size"), width: 12 },
    { key: "unit", header: t("inventoryReports.clothingPurchaseReturns.unit"), width: 12 },
    { key: "returnedQty", header: t("inventoryReports.clothingPurchaseReturns.returnedQty"), width: 16 },
    { key: "lineValue", header: t("inventoryReports.clothingPurchaseReturns.lineValue"), width: 18 },
    { key: "returnCount", header: t("inventoryReports.clothingPurchaseReturns.returnCount"), width: 14 },
  ];
  const exportRows = rows.map((row) => ({
    itemCode: row.itemCode,
    modelName: row.modelName,
    color: row.color,
    size: row.size,
    unit: row.unit,
    returnedQty: fmtQty(row.returnedQty),
    lineValue: `${fmt(row.totalReturns)} ${row.currencyCode}`,
    returnCount: row.returnCount,
  }));

  const units = new Set(rows.map((row) => row.unit));
  const currencies = new Set(rows.map((row) => row.currencyCode));
  const hasOneKnownUnit = units.size === 1 && !units.has("");
  const hasOneKnownCurrency = currencies.size === 1 && !currencies.has("");
  const quantitySummary = rows.length === 0
    ? "—"
    : hasOneKnownUnit
      ? `${fmtQty(rows.reduce((sum, row) => sum + row.returnedQty, 0))} ${Array.from(units)[0]}`
      : t("inventoryReports.clothingPurchaseReturns.mixedUnits");
  const valueSummary = rows.length === 0
    ? "—"
    : hasOneKnownCurrency
      ? `${fmt(rows.reduce((sum, row) => sum + row.totalReturns, 0))} ${Array.from(currencies)[0]}`
      : t("inventoryReports.clothingPurchaseReturns.mixedCurrencies");
  const loading = returnsQuery.isLoading || itemsQuery.isLoading;
  const loadError = returnsQuery.isError || itemsQuery.isError;
  const totalRow = rows.length > 0 ? {
    __label: t("inventoryReports.clothingPurchaseReturns.total"),
    returnedQty: hasOneKnownUnit
      ? `${fmtQty(rows.reduce((sum, row) => sum + row.returnedQty, 0))} ${Array.from(units)[0]}`
      : t("inventoryReports.clothingPurchaseReturns.mixedUnits"),
    totalReturns: hasOneKnownCurrency
      ? `${fmt(rows.reduce((sum, row) => sum + row.totalReturns, 0))} ${Array.from(currencies)[0]}`
      : t("inventoryReports.clothingPurchaseReturns.mixedCurrencies"),
  } : null;
  const title = t("inventoryReports.clothingPurchaseReturns.title");
  const subtitle = t("inventoryReports.clothingPurchaseReturns.subtitle");

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <RotateCcw className="h-6 w-6 text-orange-600" />{title}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={exportColumns}
          filename={`${t("inventoryReports.clothingPurchaseReturns.filename")}-${from}-${to}`}
          title={title}
          subtitle={`${subtitle} — ${from} / ${to}`}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-orange-200 bg-orange-50 p-3">
          <p className="text-[11px] text-orange-800">{t("inventoryReports.clothingPurchaseReturns.variantCount")}</p>
          <p className="mt-1 text-xl font-bold tabular-nums text-orange-900">{new Set(rows.map(row => row.itemId)).size}</p>
        </div>
        <div className="rounded-xl border bg-card p-3">
          <p className="text-[11px] text-muted-foreground">{t("inventoryReports.clothingPurchaseReturns.returnedQty")}</p>
          <p className="mt-1 text-xl font-bold tabular-nums">{quantitySummary}</p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3">
          <p className="text-[11px] text-rose-800">{t("inventoryReports.clothingPurchaseReturns.lineValue")}</p>
          <p className="mt-1 text-xl font-bold tabular-nums text-rose-900">{valueSummary}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label>{t("purchasingPages.common.fromDate")}</Label>
          <DateField value={from} onChange={(event) => setFrom(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("purchasingPages.common.toDate")}</Label>
          <DateField value={to} onChange={(event) => setTo(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("common.branch")}</Label>
          <BranchFilter value={branchId} onChange={setBranchId} />
        </div>
      </div>

      {loadError ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <span>{t("inventoryReports.clothingPurchaseReturns.loadError")}</span>
          <Button variant="outline" onClick={() => { void returnsQuery.refetch(); void itemsQuery.refetch(); }}>
            {t("inventoryReports.clothingPurchaseReturns.retry")}
          </Button>
        </div>
      ) : loading ? (
        <div className="space-y-2 rounded-xl border bg-card p-4">
          {[...Array(5)].map((_, index) => <Skeleton key={index} className="h-8 w-full" />)}
        </div>
      ) : (
        <AdvancedReportGrid
          slug="clothingPurchaseReturnsByVariantGrid"
          cid={cid}
          columns={columns}
          rowKey={(row) => row.rowKey}
          rows={rows}
          unitLabel={t("inventoryReports.clothingPurchaseReturns.rowUnit")}
          emptyMessage={t("inventoryReports.clothingPurchaseReturns.noData")}
          totalsRow={totalRow}
        />
      )}
    </div>
  );
}
