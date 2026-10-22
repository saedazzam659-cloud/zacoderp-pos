import { useMemo, useState } from "react";
import { localizedName } from "@/lib/localizedName";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { purchaseAnalyticsApi } from "@/lib/purchaseAnalyticsApi";
import { inventoryApi } from "@/lib/inventoryApi";
import { clothingVariantItemIds } from "@/lib/clothingStockReport";
import { useTranslation } from "react-i18next";
import { Truck } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import BranchFilter from "@/components/BranchFilter";
import ExportButtons from "@/components/ExportButtons";
import AdvancedReportGrid, { type GridColumn } from "@/components/auditGrid/AdvancedReportGrid";

type ClothingSupplierNetRow = {
  rowKey: string;
  supplierId: number | null;
  supplierName: string;
  itemId: number;
  itemCode: string;
  modelName: string;
  color: string;
  size: string;
  unit: string;
  currencyCode: string;
  purchasedQty: number;
  purchaseValue: number;
  invoiceCount: number;
  returnedQty: number;
  returnValue: number;
  returnCount: number;
  netQty: number;
  netValue: number;
};

export default function ClothingVariantSupplierNetPurchasesReport() {
  const { fmt, fmtQty } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const pickName = (ar?: string | null, en?: string | null) => localizedName(ar, en, isRtl ? "ar" : "en");
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const [from, setFrom] = useState(firstDay);
  const [to, setTo] = useState(today);
  const [branchId, setBranchId] = useState<number | undefined>(undefined);

  const activityQuery = useQuery({
    queryKey: ["clothing-variant-net-purchases-by-supplier", cid, from, to, branchId],
    queryFn: () => purchaseAnalyticsApi.variantNetBySupplier(cid, from, to, branchId),
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
  const rows = useMemo<ClothingSupplierNetRow[]>(() => (activityQuery.data ?? [])
    .filter((row) => row.itemId != null && clothingIds.has(Number(row.itemId)))
    .map((row) => {
      const itemId = Number(row.itemId);
      const item = itemById.get(itemId);
      const model = item?.parentItemId ? itemById.get(Number(item.parentItemId)) : null;
      const attributes = item?.variantAttributes ?? {};
      return {
        rowKey: `${row.supplierId ?? "none"}:${itemId}:${row.unit ?? ""}:${row.currencyCode}`,
        supplierId: row.supplierId,
        supplierName: pickName(row.supplierNameAr, row.supplierNameEn)
          || t("inventoryReports.clothingVariantSupplierNetPurchases.unassignedSupplier"),
        itemId,
        itemCode: item?.code ?? row.itemCode ?? "",
        modelName: pickName(model?.nameAr, model?.nameEn) || pickName(item?.nameAr, item?.nameEn) || row.itemName,
        color: String(attributes["اللون"] ?? ""),
        size: String(attributes["المقاس"] ?? ""),
        unit: row.unit ?? (isRtl
          ? item?.unit?.nameAr ?? item?.unitNameAr
          : item?.unit?.nameEn ?? item?.unit?.nameAr ?? item?.unitNameAr) ?? "",
        currencyCode: row.currencyCode.trim(),
        purchasedQty: Number(row.purchasedQty),
        purchaseValue: Number(row.purchaseValue),
        invoiceCount: row.invoiceCount,
        returnedQty: Number(row.returnedQty),
        returnValue: Number(row.returnValue),
        returnCount: row.returnCount,
        netQty: Number(row.netQty),
        netValue: Number(row.netValue),
      };
    }), [activityQuery.data, clothingIds, itemById, isRtl, t]);

  const columns = useMemo<GridColumn<ClothingSupplierNetRow>[]>(() => [
    { key: "supplierName", label: t("inventoryReports.clothingVariantSupplierNetPurchases.supplier"), type: "text", value: row => row.supplierName, width: 190 },
    { key: "itemCode", label: t("inventoryReports.clothingVariantSupplierNetPurchases.itemCode"), type: "text", value: row => row.itemCode, width: 120 },
    { key: "modelName", label: t("inventoryReports.clothingVariantSupplierNetPurchases.model"), type: "text", value: row => row.modelName, width: 180 },
    { key: "color", label: t("inventoryReports.clothingVariantSupplierNetPurchases.color"), type: "text", value: row => row.color, width: 110 },
    { key: "size", label: t("inventoryReports.clothingVariantSupplierNetPurchases.size"), type: "text", value: row => row.size, width: 90 },
    { key: "unit", label: t("inventoryReports.clothingVariantSupplierNetPurchases.unit"), type: "text", value: row => row.unit, width: 85 },
    { key: "purchasedQty", label: t("inventoryReports.clothingVariantSupplierNetPurchases.purchasedQty"), type: "num", align: "end", value: row => row.purchasedQty, render: row => fmtQty(row.purchasedQty), width: 130 },
    { key: "returnedQty", label: t("inventoryReports.clothingVariantSupplierNetPurchases.returnedQty"), type: "num", align: "end", value: row => row.returnedQty, render: row => fmtQty(row.returnedQty), width: 130 },
    { key: "netQty", label: t("inventoryReports.clothingVariantSupplierNetPurchases.netQty"), type: "num", align: "end", value: row => row.netQty, render: row => fmtQty(row.netQty), width: 125 },
    { key: "purchaseValue", label: t("inventoryReports.clothingVariantSupplierNetPurchases.purchaseValue"), type: "num", align: "end", value: row => row.purchaseValue, render: row => `${fmt(row.purchaseValue)} ${row.currencyCode}`, width: 160 },
    { key: "returnValue", label: t("inventoryReports.clothingVariantSupplierNetPurchases.returnValue"), type: "num", align: "end", value: row => row.returnValue, render: row => `${fmt(row.returnValue)} ${row.currencyCode}`, width: 155 },
    { key: "netValue", label: t("inventoryReports.clothingVariantSupplierNetPurchases.netValue"), type: "num", align: "end", value: row => row.netValue, render: row => `${fmt(row.netValue)} ${row.currencyCode}`, width: 155 },
    { key: "currencyCode", label: t("inventoryReports.clothingVariantSupplierNetPurchases.currency"), type: "text", value: row => row.currencyCode, width: 90 },
    { key: "invoiceCount", label: t("inventoryReports.clothingVariantSupplierNetPurchases.invoiceCount"), type: "num", align: "end", value: row => row.invoiceCount, width: 120 },
    { key: "returnCount", label: t("inventoryReports.clothingVariantSupplierNetPurchases.returnCount"), type: "num", align: "end", value: row => row.returnCount, width: 120 },
  ], [t, fmt, fmtQty]);

  const units = new Set(rows.map(row => row.unit));
  const currencies = new Set(rows.map(row => row.currencyCode));
  const hasOneKnownUnit = units.size === 1 && !units.has("");
  const hasOneKnownCurrency = currencies.size === 1 && !currencies.has("");
  const netQtySummary = rows.length === 0
    ? "—"
    : hasOneKnownUnit
      ? `${fmtQty(rows.reduce((sum, row) => sum + row.netQty, 0))} ${Array.from(units)[0]}`
      : t("inventoryReports.clothingVariantSupplierNetPurchases.mixedUnits");
  const netValueSummary = rows.length === 0
    ? "—"
    : hasOneKnownCurrency
      ? `${fmt(rows.reduce((sum, row) => sum + row.netValue, 0))} ${Array.from(currencies)[0]}`
      : t("inventoryReports.clothingVariantSupplierNetPurchases.mixedCurrencies");
  const totalRow = rows.length > 0 ? {
    __label: t("inventoryReports.clothingVariantSupplierNetPurchases.total"),
    purchasedQty: hasOneKnownUnit
      ? `${fmtQty(rows.reduce((sum, row) => sum + row.purchasedQty, 0))} ${Array.from(units)[0]}`
      : t("inventoryReports.clothingVariantSupplierNetPurchases.mixedUnits"),
    returnedQty: hasOneKnownUnit
      ? `${fmtQty(rows.reduce((sum, row) => sum + row.returnedQty, 0))} ${Array.from(units)[0]}`
      : t("inventoryReports.clothingVariantSupplierNetPurchases.mixedUnits"),
    netQty: netQtySummary,
    purchaseValue: hasOneKnownCurrency
      ? `${fmt(rows.reduce((sum, row) => sum + row.purchaseValue, 0))} ${Array.from(currencies)[0]}`
      : t("inventoryReports.clothingVariantSupplierNetPurchases.mixedCurrencies"),
    returnValue: hasOneKnownCurrency
      ? `${fmt(rows.reduce((sum, row) => sum + row.returnValue, 0))} ${Array.from(currencies)[0]}`
      : t("inventoryReports.clothingVariantSupplierNetPurchases.mixedCurrencies"),
    netValue: netValueSummary,
  } : null;

  const exportColumns = [
    { key: "supplierName", header: t("inventoryReports.clothingVariantSupplierNetPurchases.supplier"), width: 24 },
    { key: "itemCode", header: t("inventoryReports.clothingVariantSupplierNetPurchases.itemCode"), width: 16 },
    { key: "modelName", header: t("inventoryReports.clothingVariantSupplierNetPurchases.model"), width: 24 },
    { key: "color", header: t("inventoryReports.clothingVariantSupplierNetPurchases.color"), width: 16 },
    { key: "size", header: t("inventoryReports.clothingVariantSupplierNetPurchases.size"), width: 12 },
    { key: "unit", header: t("inventoryReports.clothingVariantSupplierNetPurchases.unit"), width: 12 },
    { key: "purchasedQty", header: t("inventoryReports.clothingVariantSupplierNetPurchases.purchasedQty"), width: 16 },
    { key: "returnedQty", header: t("inventoryReports.clothingVariantSupplierNetPurchases.returnedQty"), width: 16 },
    { key: "netQty", header: t("inventoryReports.clothingVariantSupplierNetPurchases.netQty"), width: 16 },
    { key: "purchaseValue", header: t("inventoryReports.clothingVariantSupplierNetPurchases.purchaseValue"), width: 18 },
    { key: "returnValue", header: t("inventoryReports.clothingVariantSupplierNetPurchases.returnValue"), width: 18 },
    { key: "netValue", header: t("inventoryReports.clothingVariantSupplierNetPurchases.netValue"), width: 18 },
    { key: "currencyCode", header: t("inventoryReports.clothingVariantSupplierNetPurchases.currency"), width: 12 },
    { key: "invoiceCount", header: t("inventoryReports.clothingVariantSupplierNetPurchases.invoiceCount"), width: 16 },
    { key: "returnCount", header: t("inventoryReports.clothingVariantSupplierNetPurchases.returnCount"), width: 16 },
  ];
  const exportRows = rows.map(row => ({
    supplierName: row.supplierName,
    itemCode: row.itemCode,
    modelName: row.modelName,
    color: row.color,
    size: row.size,
    unit: row.unit,
    purchasedQty: fmtQty(row.purchasedQty),
    returnedQty: fmtQty(row.returnedQty),
    netQty: fmtQty(row.netQty),
    purchaseValue: `${fmt(row.purchaseValue)} ${row.currencyCode}`,
    returnValue: `${fmt(row.returnValue)} ${row.currencyCode}`,
    netValue: `${fmt(row.netValue)} ${row.currencyCode}`,
    currencyCode: row.currencyCode,
    invoiceCount: row.invoiceCount,
    returnCount: row.returnCount,
  }));

  const loading = activityQuery.isLoading || itemsQuery.isLoading;
  const loadError = activityQuery.isError || itemsQuery.isError;
  const title = t("inventoryReports.clothingVariantSupplierNetPurchases.title");
  const subtitle = t("inventoryReports.clothingVariantSupplierNetPurchases.subtitle");

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Truck className="h-6 w-6 text-blue-600" />{title}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={exportColumns}
          filename={`${t("inventoryReports.clothingVariantSupplierNetPurchases.filename")}-${from}-${to}`}
          title={title}
          subtitle={`${subtitle} — ${from} / ${to}`}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div data-testid="metric-clothing-supplier-count" className="rounded-xl border border-blue-200 bg-blue-50 p-3">
          <p className="text-[11px] text-blue-800">{t("inventoryReports.clothingVariantSupplierNetPurchases.supplierCount")}</p>
          <p className="mt-1 text-xl font-bold tabular-nums text-blue-900">{new Set(rows.map(row => row.supplierId ?? "unassigned")).size}</p>
        </div>
        <div data-testid="metric-clothing-supplier-net-quantity" className="rounded-xl border bg-card p-3">
          <p className="text-[11px] text-muted-foreground">{t("inventoryReports.clothingVariantSupplierNetPurchases.netQty")}</p>
          <p className="mt-1 text-xl font-bold tabular-nums">{netQtySummary}</p>
        </div>
        <div data-testid="metric-clothing-supplier-net-value" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
          <p className="text-[11px] text-emerald-800">{t("inventoryReports.clothingVariantSupplierNetPurchases.netValue")}</p>
          <p className="mt-1 text-xl font-bold tabular-nums text-emerald-900">{netValueSummary}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label>{t("purchasingPages.common.fromDate")}</Label>
          <DateField value={from} onChange={event => setFrom(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("purchasingPages.common.toDate")}</Label>
          <DateField value={to} onChange={event => setTo(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("common.branch")}</Label>
          <BranchFilter value={branchId} onChange={setBranchId} />
        </div>
      </div>

      {loadError ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <span>{t("inventoryReports.clothingVariantSupplierNetPurchases.loadError")}</span>
          <Button variant="outline" onClick={() => { void activityQuery.refetch(); void itemsQuery.refetch(); }}>
            {t("inventoryReports.clothingVariantSupplierNetPurchases.retry")}
          </Button>
        </div>
      ) : loading ? (
        <div className="space-y-2 rounded-xl border bg-card p-4">
          {[...Array(5)].map((_, index) => <Skeleton key={index} className="h-8 w-full" />)}
        </div>
      ) : (
        <AdvancedReportGrid
          slug="clothingVariantSupplierNetPurchasesGrid"
          cid={cid}
          columns={columns}
          rowKey={row => row.rowKey}
          rows={rows}
          unitLabel={t("inventoryReports.clothingVariantSupplierNetPurchases.rowUnit")}
          emptyMessage={t("inventoryReports.clothingVariantSupplierNetPurchases.noData")}
          totalsRow={totalRow}
        />
      )}
    </div>
  );
}
