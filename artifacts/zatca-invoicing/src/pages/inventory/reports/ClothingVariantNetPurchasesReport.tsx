import { useMemo, useState } from "react";
import { localizedName } from "@/lib/localizedName";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { purchaseAnalyticsApi } from "@/lib/purchaseAnalyticsApi";
import { inventoryApi } from "@/lib/inventoryApi";
import { clothingVariantItemIds } from "@/lib/clothingStockReport";
import { useTranslation } from "react-i18next";
import { ArrowLeftRight } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import BranchFilter from "@/components/BranchFilter";
import ExportButtons from "@/components/ExportButtons";
import AdvancedReportGrid, { type GridColumn } from "@/components/auditGrid/AdvancedReportGrid";

type ClothingVariantNetRow = {
  itemId: number;
  rowKey: string;
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

export default function ClothingVariantNetPurchasesReport() {
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
    queryKey: ["clothing-variant-net-purchases", cid, from, to, branchId],
    queryFn: () => purchaseAnalyticsApi.variantNetByItem(cid, from, to, branchId),
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
  const rows = useMemo<ClothingVariantNetRow[]>(() => (activityQuery.data ?? [])
    .filter((row) => row.itemId != null && clothingIds.has(Number(row.itemId)))
    .map((row) => {
      const itemId = Number(row.itemId);
      const item = itemById.get(itemId);
      const model = item?.parentItemId ? itemById.get(Number(item.parentItemId)) : null;
      const attributes = item?.variantAttributes ?? {};
      return {
        itemId,
        rowKey: `${itemId}:${row.unit ?? ""}:${row.currencyCode}`,
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
    }), [activityQuery.data, clothingIds, itemById, isRtl]);

  const columns = useMemo<GridColumn<ClothingVariantNetRow>[]>(() => [
    { key: "itemCode", label: t("inventoryReports.clothingVariantNetPurchases.itemCode"), type: "text", value: row => row.itemCode, width: 125 },
    { key: "modelName", label: t("inventoryReports.clothingVariantNetPurchases.model"), type: "text", value: row => row.modelName, width: 190 },
    { key: "color", label: t("inventoryReports.clothingVariantNetPurchases.color"), type: "text", value: row => row.color, width: 115 },
    { key: "size", label: t("inventoryReports.clothingVariantNetPurchases.size"), type: "text", value: row => row.size, width: 95 },
    { key: "unit", label: t("inventoryReports.clothingVariantNetPurchases.unit"), type: "text", value: row => row.unit, width: 90 },
    { key: "purchasedQty", label: t("inventoryReports.clothingVariantNetPurchases.purchasedQty"), type: "num", align: "end", value: row => row.purchasedQty, render: row => fmtQty(row.purchasedQty), width: 130 },
    { key: "returnedQty", label: t("inventoryReports.clothingVariantNetPurchases.returnedQty"), type: "num", align: "end", value: row => row.returnedQty, render: row => fmtQty(row.returnedQty), width: 130 },
    { key: "netQty", label: t("inventoryReports.clothingVariantNetPurchases.netQty"), type: "num", align: "end", value: row => row.netQty, render: row => fmtQty(row.netQty), width: 130 },
    { key: "purchaseValue", label: t("inventoryReports.clothingVariantNetPurchases.purchaseValue"), type: "num", align: "end", value: row => row.purchaseValue, render: row => `${fmt(row.purchaseValue)} ${row.currencyCode}`, width: 165 },
    { key: "returnValue", label: t("inventoryReports.clothingVariantNetPurchases.returnValue"), type: "num", align: "end", value: row => row.returnValue, render: row => `${fmt(row.returnValue)} ${row.currencyCode}`, width: 165 },
    { key: "netValue", label: t("inventoryReports.clothingVariantNetPurchases.netValue"), type: "num", align: "end", value: row => row.netValue, render: row => `${fmt(row.netValue)} ${row.currencyCode}`, width: 165 },
    { key: "currencyCode", label: t("inventoryReports.clothingVariantNetPurchases.currency"), type: "text", value: row => row.currencyCode, width: 95 },
    { key: "invoiceCount", label: t("inventoryReports.clothingVariantNetPurchases.invoiceCount"), type: "num", align: "end", value: row => row.invoiceCount, width: 115 },
    { key: "returnCount", label: t("inventoryReports.clothingVariantNetPurchases.returnCount"), type: "num", align: "end", value: row => row.returnCount, width: 115 },
  ], [t, fmt, fmtQty]);

  const units = new Set(rows.map((row) => row.unit));
  const currencies = new Set(rows.map((row) => row.currencyCode));
  const hasOneKnownUnit = units.size === 1 && !units.has("");
  const hasOneKnownCurrency = currencies.size === 1 && !currencies.has("");
  const netQtySummary = rows.length === 0
    ? "—"
    : hasOneKnownUnit
      ? `${fmtQty(rows.reduce((sum, row) => sum + row.netQty, 0))} ${Array.from(units)[0]}`
      : t("inventoryReports.clothingVariantNetPurchases.mixedUnits");
  const netValueSummary = rows.length === 0
    ? "—"
    : hasOneKnownCurrency
      ? `${fmt(rows.reduce((sum, row) => sum + row.netValue, 0))} ${Array.from(currencies)[0]}`
      : t("inventoryReports.clothingVariantNetPurchases.mixedCurrencies");
  const totalRow = rows.length > 0 ? {
    __label: t("inventoryReports.clothingVariantNetPurchases.total"),
    purchasedQty: hasOneKnownUnit
      ? `${fmtQty(rows.reduce((sum, row) => sum + row.purchasedQty, 0))} ${Array.from(units)[0]}`
      : t("inventoryReports.clothingVariantNetPurchases.mixedUnits"),
    returnedQty: hasOneKnownUnit
      ? `${fmtQty(rows.reduce((sum, row) => sum + row.returnedQty, 0))} ${Array.from(units)[0]}`
      : t("inventoryReports.clothingVariantNetPurchases.mixedUnits"),
    netQty: hasOneKnownUnit
      ? `${fmtQty(rows.reduce((sum, row) => sum + row.netQty, 0))} ${Array.from(units)[0]}`
      : t("inventoryReports.clothingVariantNetPurchases.mixedUnits"),
    purchaseValue: hasOneKnownCurrency
      ? `${fmt(rows.reduce((sum, row) => sum + row.purchaseValue, 0))} ${Array.from(currencies)[0]}`
      : t("inventoryReports.clothingVariantNetPurchases.mixedCurrencies"),
    returnValue: hasOneKnownCurrency
      ? `${fmt(rows.reduce((sum, row) => sum + row.returnValue, 0))} ${Array.from(currencies)[0]}`
      : t("inventoryReports.clothingVariantNetPurchases.mixedCurrencies"),
    netValue: hasOneKnownCurrency
      ? `${fmt(rows.reduce((sum, row) => sum + row.netValue, 0))} ${Array.from(currencies)[0]}`
      : t("inventoryReports.clothingVariantNetPurchases.mixedCurrencies"),
  } : null;

  const exportColumns = [
    { key: "itemCode", header: t("inventoryReports.clothingVariantNetPurchases.itemCode"), width: 16 },
    { key: "modelName", header: t("inventoryReports.clothingVariantNetPurchases.model"), width: 26 },
    { key: "color", header: t("inventoryReports.clothingVariantNetPurchases.color"), width: 16 },
    { key: "size", header: t("inventoryReports.clothingVariantNetPurchases.size"), width: 12 },
    { key: "unit", header: t("inventoryReports.clothingVariantNetPurchases.unit"), width: 12 },
    { key: "purchasedQty", header: t("inventoryReports.clothingVariantNetPurchases.purchasedQty"), width: 16 },
    { key: "returnedQty", header: t("inventoryReports.clothingVariantNetPurchases.returnedQty"), width: 16 },
    { key: "netQty", header: t("inventoryReports.clothingVariantNetPurchases.netQty"), width: 16 },
    { key: "purchaseValue", header: t("inventoryReports.clothingVariantNetPurchases.purchaseValue"), width: 18 },
    { key: "returnValue", header: t("inventoryReports.clothingVariantNetPurchases.returnValue"), width: 18 },
    { key: "netValue", header: t("inventoryReports.clothingVariantNetPurchases.netValue"), width: 18 },
    { key: "invoiceCount", header: t("inventoryReports.clothingVariantNetPurchases.invoiceCount"), width: 14 },
    { key: "returnCount", header: t("inventoryReports.clothingVariantNetPurchases.returnCount"), width: 14 },
  ];
  const exportRows = rows.map((row) => ({
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
    invoiceCount: row.invoiceCount,
    returnCount: row.returnCount,
  }));

  const loading = activityQuery.isLoading || itemsQuery.isLoading;
  const loadError = activityQuery.isError || itemsQuery.isError;
  const title = t("inventoryReports.clothingVariantNetPurchases.title");
  const subtitle = t("inventoryReports.clothingVariantNetPurchases.subtitle");

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <ArrowLeftRight className="h-6 w-6 text-indigo-600" />{title}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={exportColumns}
          filename={`${t("inventoryReports.clothingVariantNetPurchases.filename")}-${from}-${to}`}
          title={title}
          subtitle={`${subtitle} — ${from} / ${to}`}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div data-testid="metric-clothing-net-variant-count" className="rounded-xl border border-indigo-200 bg-indigo-50 p-3">
          <p className="text-[11px] text-indigo-800">{t("inventoryReports.clothingVariantNetPurchases.variantCount")}</p>
          <p className="mt-1 text-xl font-bold tabular-nums text-indigo-900">{new Set(rows.map(row => row.itemId)).size}</p>
        </div>
        <div data-testid="metric-clothing-net-quantity" className="rounded-xl border bg-card p-3">
          <p className="text-[11px] text-muted-foreground">{t("inventoryReports.clothingVariantNetPurchases.netQty")}</p>
          <p className="mt-1 text-xl font-bold tabular-nums">{netQtySummary}</p>
        </div>
        <div data-testid="metric-clothing-net-value" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
          <p className="text-[11px] text-emerald-800">{t("inventoryReports.clothingVariantNetPurchases.netValue")}</p>
          <p className="mt-1 text-xl font-bold tabular-nums text-emerald-900">{netValueSummary}</p>
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
          <span>{t("inventoryReports.clothingVariantNetPurchases.loadError")}</span>
          <Button variant="outline" onClick={() => { void activityQuery.refetch(); void itemsQuery.refetch(); }}>
            {t("inventoryReports.clothingVariantNetPurchases.retry")}
          </Button>
        </div>
      ) : loading ? (
        <div className="space-y-2 rounded-xl border bg-card p-4">
          {[...Array(5)].map((_, index) => <Skeleton key={index} className="h-8 w-full" />)}
        </div>
      ) : (
        <AdvancedReportGrid
          slug="clothingVariantNetPurchasesGrid"
          cid={cid}
          columns={columns}
          rowKey={(row) => row.rowKey}
          rows={rows}
          unitLabel={t("inventoryReports.clothingVariantNetPurchases.rowUnit")}
          emptyMessage={t("inventoryReports.clothingVariantNetPurchases.noData")}
          totalsRow={totalRow}
        />
      )}
    </div>
  );
}
