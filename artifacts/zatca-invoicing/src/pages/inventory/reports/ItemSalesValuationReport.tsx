import { useMemo, useState } from "react";
import { localizedName } from "@/lib/localizedName";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchCombobox } from "@/components/ui/search-combobox";
import ExportButtons from "@/components/ExportButtons";
import { ReceiptText, Filter, X, Coins, BadgePercent, Tags } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFmt } from "@/hooks/use-fmt";
import { DateField } from "@/components/ui/date-field";
import AdvancedReportGrid, { type GridColumn } from "@/components/auditGrid/AdvancedReportGrid";
import { InventoryBrandFilter, filterItemsForInventoryBrand, filterRowsForInventoryBrand, useInventoryReportBrandOptions } from "@/components/InventoryBrandFilter";
import { clothingVariantItemIds } from "@/lib/clothingStockReport";

const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

type Basis = "cost" | "excl_vat" | "incl_vat";

const BASIS_META: Record<Basis, { labelKey: string; descKey: string; icon: any; color: string; chip: string }> = {
  cost:     { labelKey: "inventoryReports.itemSalesValuation.basisCostLabel",    descKey: "inventoryReports.itemSalesValuation.basisCostDesc",    icon: Coins,        color: "from-indigo-50 to-indigo-100/40 text-indigo-700 border-indigo-200", chip: "bg-indigo-600 hover:bg-indigo-700" },
  excl_vat: { labelKey: "inventoryReports.itemSalesValuation.basisExclVatLabel", descKey: "inventoryReports.itemSalesValuation.basisExclVatDesc", icon: BadgePercent, color: "from-sky-50 to-sky-100/40 text-sky-700 border-sky-200", chip: "bg-sky-600 hover:bg-sky-700" },
  incl_vat: { labelKey: "inventoryReports.itemSalesValuation.basisInclVatLabel", descKey: "inventoryReports.itemSalesValuation.basisInclVatDesc", icon: Tags,         color: "from-purple-50 to-purple-100/40 text-purple-700 border-purple-200", chip: "bg-purple-600 hover:bg-purple-700" },
};

type Filters = {
  from: string; to: string;
  warehouseId: string; customerId: string; itemId: string; branchId: string; brandId: string;
};

export default function ItemSalesValuationReport({ clothingOnly = false }: { clothingOnly?: boolean }) {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const pickName = (ar?: string | null, en?: string | null) => localizedName(ar, en, isRtl ? "ar" : "en");
  const { fmt, fmtQty } = useFmt();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const brandOptions = useInventoryReportBrandOptions(cid);

  const EXPORT_COLS = [
    { key: "itemCode",      header: t("inventoryReports.itemSalesValuation.cols.itemCode"),      width: 16 },
    { key: "itemNameAr",    header: t("inventoryReports.itemSalesValuation.cols.itemName"),      width: 30 },
    ...(clothingOnly ? [
      { key: "clothingModelName", header: t("inventoryReports.clothingSales.model"), width: 24 },
      { key: "color", header: t("inventoryReports.clothingSales.color"), width: 16 },
      { key: "size", header: t("inventoryReports.clothingSales.size"), width: 12 },
      { key: "grossMargin", header: t("inventoryReports.clothingSales.grossMargin"), width: 18 },
    ] : []),
    { key: "unitName",      header: t("inventoryReports.itemSalesValuation.cols.unit"),          width: 12 },
    { key: "soldQty",       header: t("inventoryReports.itemSalesValuation.cols.soldQty"),       width: 14 },
    { key: "soldValue",     header: t("inventoryReports.itemSalesValuation.cols.soldValue"),     width: 18 },
    { key: "returnedQty",   header: t("inventoryReports.itemSalesValuation.cols.returnedQty"),   width: 14 },
    { key: "returnedValue", header: t("inventoryReports.itemSalesValuation.cols.returnedValue"), width: 18 },
    { key: "netQty",        header: t("inventoryReports.itemSalesValuation.cols.netQty"),        width: 14 },
    { key: "netValue",      header: t("inventoryReports.itemSalesValuation.cols.netValue"),      width: 18 },
  ];

  const today    = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const empty: Filters = { from: firstDay, to: today, warehouseId: "", customerId: "", itemId: "", branchId: "", brandId: "" };
  const [filters, setFilters] = useState<Filters>(empty);
  const [applied, setApplied] = useState<Filters>(empty);
  const [basis,   setBasis]   = useState<Basis>("cost");

  // Lookups
  const { data: items = [] }      = useQuery({ queryKey: ["items", cid],      queryFn: () => inventoryApi.getItems(cid) });
  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses", cid], queryFn: () => inventoryApi.getWarehouses(cid) });
  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ["customers", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/customers?companyId=${cid}` : `${API}/api/customers`;
      const r = await fetch(url, { headers: authHeaders() });
      if (!r.ok) return [];
      return r.json();
    },
  });
  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["org-branches", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/org/branches?companyId=${cid}` : `${API}/api/org/branches`;
      const r = await fetch(url, { headers: authHeaders() });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const { data: rows = [], isLoading, isFetching } = useQuery({
    queryKey: ["item-sales-valuation", cid, applied, basis],
    queryFn: () => {
      const params: Record<string, string> = { basis };
      if (cid)                 params.companyId   = String(cid);
      if (applied.from)        params.from        = applied.from;
      if (applied.to)          params.to          = applied.to;
      if (applied.warehouseId) params.warehouseId = applied.warehouseId;
      if (applied.customerId)  params.customerId  = applied.customerId;
      if (applied.itemId)      params.itemId      = applied.itemId;
      if (applied.branchId)    params.branchId    = applied.branchId;
      return inventoryApi.getItemSalesValuationReport(params);
    },
  });
  const marginQuery = useQuery({
    queryKey: ["clothing-sales-margin", cid, applied],
    enabled: clothingOnly,
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (cid) params.companyId = String(cid);
      if (applied.from) params.from = applied.from;
      if (applied.to) params.to = applied.to;
      if (applied.warehouseId) params.warehouseId = applied.warehouseId;
      if (applied.customerId) params.customerId = applied.customerId;
      if (applied.itemId) params.itemId = applied.itemId;
      if (applied.branchId) params.branchId = applied.branchId;
      const [revenueRows, costRows] = await Promise.all([
        inventoryApi.getItemSalesValuationReport({ ...params, basis: "excl_vat" }),
        inventoryApi.getItemSalesValuationReport({ ...params, basis: "cost" }),
      ]);
      const costByItemId = new Map(costRows.map((row) => [Number(row.itemId), Number(row.netValue)]));
      return revenueRows.map((row) => ({
        itemId: Number(row.itemId),
        grossMargin: costByItemId.has(Number(row.itemId))
          ? Number(row.netValue) - (costByItemId.get(Number(row.itemId)) ?? 0)
          : null,
      }));
    },
  });

  const itemById = useMemo(() => new Map<number, any>((items as any[]).map((item) => [Number(item.id), item])), [items]);
  const clothingIds = useMemo(
    () => clothingVariantItemIds(items as any[]),
    [items],
  );
  const clothingDetails = useMemo(() => {
    const details = new Map<number, { modelName: string; color: string; size: string }>();
    for (const id of clothingIds) {
      const item = itemById.get(id);
      const model = item?.parentItemId ? itemById.get(Number(item.parentItemId)) : null;
      if (!item || !model) continue;
      details.set(id, {
        modelName: String(model.nameAr ?? model.nameEn ?? ""),
        color: String(item.variantAttributes?.["اللون"] ?? ""),
        size: String(item.variantAttributes?.["المقاس"] ?? ""),
      });
    }
    return details;
  }, [clothingIds, itemById]);
  const marginByItemId = new Map((marginQuery.data ?? []).map((row) => [row.itemId, row.grossMargin]));
  const brandFilteredRows = filterRowsForInventoryBrand(rows as any[], applied.brandId, brandOptions);
  const filteredRows = brandFilteredRows
    .filter((row: any) => !clothingOnly || clothingIds.has(Number(row.itemId)))
    .map((row: any) => clothingOnly
      ? {
        ...row,
        ...clothingDetails.get(Number(row.itemId)),
        grossMargin: marginByItemId.get(Number(row.itemId)) ?? null,
      }
      : row);
  const filteredItems = filterItemsForInventoryBrand(items as any[], filters.brandId, brandOptions)
    .filter((item: any) => !clothingOnly || clothingIds.has(Number(item.id)));
  const totals = filteredRows.reduce(
    (acc, r) => {
      acc.soldQty       += Number(r.soldQty)       || 0;
      acc.soldValue     += Number(r.soldValue)     || 0;
      acc.returnedQty   += Number(r.returnedQty)   || 0;
      acc.returnedValue += Number(r.returnedValue) || 0;
      acc.netQty        += Number(r.netQty)        || 0;
      acc.netValue      += Number(r.netValue)      || 0;
      return acc;
    },
    { soldQty: 0, soldValue: 0, returnedQty: 0, returnedValue: 0, netQty: 0, netValue: 0 },
  );
  const totalGrossMargin = filteredRows.reduce(
    (total: number, row: any) => total + (typeof row.grossMargin === "number" ? row.grossMargin : 0),
    0,
  );

  const exportRows = filteredRows.map(r => ({
    itemCode:      r.itemCode ?? "",
    itemNameAr:    clothingOnly
      ? `${r.clothingModelName ?? ""} — ${r.color || "—"} — ${r.size || "—"}`
      : pickName(r.itemNameAr, r.itemNameEn),
    clothingModelName: r.clothingModelName ?? "",
    color: r.color ?? "",
    size: r.size ?? "",
    grossMargin: typeof r.grossMargin === "number" ? fmt(r.grossMargin) : "—",
    unitName:      pickName(r.unitName, r.unitNameEn),
    soldQty:       fmtQty(r.soldQty),
    soldValue:     fmt(r.soldValue),
    returnedQty:   fmtQty(r.returnedQty),
    returnedValue: fmt(r.returnedValue),
    netQty:        fmtQty(r.netQty),
    netValue:      fmt(r.netValue),
  }));

  const totalsRow = {
    itemCode: t("inventoryReports.itemSalesValuation.total"), itemNameAr: "", unitName: "",
    soldQty:       fmtQty(totals.soldQty),
    soldValue:     fmt(totals.soldValue),
    returnedQty:   fmtQty(totals.returnedQty),
    returnedValue: fmt(totals.returnedValue),
    netQty:        fmtQty(totals.netQty),
    netValue:      fmt(totals.netValue),
    grossMargin: clothingOnly ? fmt(totalGrossMargin) : "",
  };

  const gridColumns = useMemo<GridColumn<any>[]>(() => [
    {
      key: "item",
      label: t("inventoryReports.common.item"),
      type: "text",
      width: 240,
      value: r => clothingOnly
        ? `${r.clothingModelName ?? ""} ${r.color ?? ""} ${r.size ?? ""} ${r.itemCode ?? ""}`
        : `${pickName(r.itemNameAr, r.itemNameEn)} ${r.itemCode ?? ""}`,
      render: r => (
        <div>
          <p className="font-medium text-sm">{clothingOnly ? (r.clothingModelName || pickName(r.itemNameAr, r.itemNameEn) || "—") : (pickName(r.itemNameAr, r.itemNameEn) || "—")}</p>
          <p className="text-[10px] text-muted-foreground">
            {clothingOnly
              ? `${r.color || "—"} / ${r.size || "—"} · `
              : ""}
            <span className="font-mono">{r.itemCode}</span>
          </p>
        </div>
      ),
    },
    {
      key: "unit",
      label: t("inventoryReports.itemSalesValuation.cols.unit"),
      type: "text",
      width: 125,
      className: "text-xs text-muted-foreground",
      value: r => pickName(r.unitName, r.unitNameEn),
      render: r => pickName(r.unitName, r.unitNameEn) || "—",
    },
    {
      key: "soldQty",
      label: t("inventoryReports.itemSalesValuation.cols.soldQty"),
      type: "num",
      align: "center",
      width: 130,
      className: "tabular-nums",
      value: r => Number(r.soldQty),
      render: r => fmtQty(r.soldQty),
      totalable: true,
    },
    {
      key: "soldValue",
      label: t("inventoryReports.itemSalesValuation.cols.soldValue"),
      type: "num",
      align: "center",
      width: 155,
      className: "tabular-nums text-blue-700 font-medium",
      value: r => Number(r.soldValue),
      render: r => fmt(r.soldValue),
      totalable: true,
    },
    {
      key: "returnedQty",
      label: t("inventoryReports.itemSalesValuation.cols.returnedQty"),
      type: "num",
      align: "center",
      width: 145,
      className: "tabular-nums",
      value: r => Number(r.returnedQty),
      render: r => fmtQty(r.returnedQty),
      totalable: true,
    },
    {
      key: "returnedValue",
      label: t("inventoryReports.itemSalesValuation.cols.returnedValue"),
      type: "num",
      align: "center",
      width: 170,
      className: "tabular-nums text-amber-700 font-medium",
      value: r => Number(r.returnedValue),
      render: r => fmt(r.returnedValue),
      totalable: true,
    },
    {
      key: "netQty",
      label: t("inventoryReports.itemSalesValuation.cols.netQty"),
      type: "num",
      align: "center",
      width: 130,
      className: "tabular-nums text-emerald-700 font-bold",
      value: r => Number(r.netQty),
      render: r => fmtQty(r.netQty),
      totalable: true,
    },
    {
      key: "netValue",
      label: t("inventoryReports.itemSalesValuation.cols.netValue"),
      type: "num",
      align: "center",
      width: 155,
      className: "tabular-nums text-emerald-700 font-bold",
      value: r => Number(r.netValue),
      render: r => fmt(r.netValue),
      totalable: true,
    },
    ...(clothingOnly ? [{
      key: "grossMargin",
      label: t("inventoryReports.clothingSales.grossMargin"),
      type: "num" as const,
      align: "center" as const,
      width: 175,
      className: "tabular-nums text-violet-700 font-semibold",
      value: (r: any) => r.grossMargin == null ? 0 : Number(r.grossMargin),
      render: (r: any) => r.grossMargin == null ? "—" : fmt(r.grossMargin),
    }] : []),
  ], [t, isRtl, fmt, fmtQty, clothingOnly]);

  const apply = () => setApplied(filters);
  const reset = () => { setFilters(empty); setApplied(empty); };
  const hasAnyFilter =
    !!applied.warehouseId || !!applied.customerId || !!applied.itemId || !!applied.branchId || !!applied.brandId;

  const whMap   = new Map<number, any>((warehouses as any[]).map(w => [w.id, w]));
  const cusMap  = new Map<number, any>((customers as any[]).map(c => [c.id, c]));
  const brMap   = new Map<number, any>((branches as any[]).map(b => [b.id, b]));
  const appliedItem = applied.itemId      ? itemById.get(Number(applied.itemId))      : null;
  const appliedWh   = applied.warehouseId ? whMap.get(Number(applied.warehouseId))   : null;
  const appliedCus  = applied.customerId  ? cusMap.get(Number(applied.customerId))   : null;
  const appliedBr   = applied.branchId    ? brMap.get(Number(applied.branchId))      : null;
  const appliedBrand = applied.brandId ? brandOptions.find(option => String(option.brandId) === applied.brandId) : null;

  const basisLabel = t(BASIS_META[basis].labelKey);

  const subtitle = [
    t("inventoryReports.itemSalesValuation.subtitleBasis", { value: basisLabel }),
    t("inventoryReports.itemSalesValuation.subtitlePeriod", { from: applied.from, to: applied.to }),
    appliedWh  && t("inventoryReports.itemSalesValuation.subtitleWarehouse", { value: pickName(appliedWh.nameAr, appliedWh.nameEn) || appliedWh.name }),
    appliedCus && t("inventoryReports.itemSalesValuation.subtitleCustomer", { value: pickName(appliedCus.nameAr, appliedCus.nameEn) || appliedCus.name }),
    appliedItem && t("inventoryReports.itemSalesValuation.subtitleItem", { value: pickName(appliedItem.nameAr, appliedItem.nameEn) || appliedItem.code }),
    appliedBr  && t("inventoryReports.itemSalesValuation.subtitleBranch", { value: pickName(appliedBr.nameAr, appliedBr.nameEn) || appliedBr.name }),
    appliedBrand && `${t("inventoryReports.common.brand")}: ${pickName(appliedBrand.nameAr, appliedBrand.nameEn) || appliedBrand.code}`,
  ].filter(Boolean).join("  •  ");

  const BasisIcon = BASIS_META[basis].icon;

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ReceiptText className="h-6 w-6 text-teal-600" />
            {clothingOnly ? t("inventoryReports.clothingSales.title") : t("inventoryReports.itemSalesValuation.title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {clothingOnly ? t("inventoryReports.clothingSales.subtitle") : t("inventoryReports.itemSalesValuation.subtitle")}
          </p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={EXPORT_COLS}
          filename={`${clothingOnly ? t("inventoryReports.clothingSales.exportFilename") : t("inventoryReports.itemSalesValuation.exportFilename")}-${basis}-${applied.from}_${applied.to}`}
          title={`${clothingOnly ? t("inventoryReports.clothingSales.title") : t("inventoryReports.itemSalesValuation.title")} — ${basisLabel}`}
          subtitle={subtitle}
          totalsRow={totalsRow}
          disabled={filteredRows.length === 0}
        />
      </div>

      {/* Basis toggle — the star feature */}
      <div className="rounded-2xl border bg-gradient-to-br from-slate-50 to-slate-100/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div>
            <p className="text-xs text-muted-foreground">{t("inventoryReports.itemSalesValuation.basisSectionTitle")}</p>
            <p className="text-sm font-bold flex items-center gap-2 mt-0.5">
              <BasisIcon className="h-4 w-4 text-primary" /> {basisLabel}
            </p>
            <p className="text-[11px] text-muted-foreground mt-1">{t(BASIS_META[basis].descKey)}</p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {(Object.keys(BASIS_META) as Basis[]).map(k => {
            const Meta = BASIS_META[k];
            const Icon = Meta.icon;
            const active = basis === k;
            return (
              <button
                key={k}
                onClick={() => setBasis(k)}
                className={cn(
                  "rounded-xl border p-3 text-right transition-all",
                  active
                    ? "ring-2 ring-offset-1 ring-primary bg-white shadow-sm"
                    : "bg-white/60 hover:bg-white hover:shadow-sm border-muted",
                )}
              >
                <Icon className={cn("h-5 w-5 mb-1.5", active ? "text-primary" : "text-muted-foreground")} />
                <p className="text-xs font-bold">{t(Meta.labelKey)}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">{t(Meta.descKey)}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Filter card */}
      <div className="rounded-2xl border bg-gradient-to-br from-teal-50/60 to-emerald-50/30 p-5 space-y-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold flex items-center gap-2 text-teal-700">
            <Filter className="h-4 w-4" /> {t("inventoryReports.common.filters")}
          </h3>
          {hasAnyFilter && (
            <Button size="sm" variant="ghost" className="text-xs h-7" onClick={reset}>
              <X className="h-3 w-3 ml-1" /> {t("inventoryReports.itemSalesValuation.clearFilters")}
            </Button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("inventoryReports.common.from")}</Label>
            <DateField value={filters.from} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("inventoryReports.common.to")}</Label>
            <DateField value={filters.to} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("inventoryReports.common.warehouse")}</Label>
            <SearchCombobox
              items={[{ value: "", label: t("inventoryReports.common.allWarehouses") }, ...(warehouses as any[]).map(w => ({ value: String(w.id), label: `${pickName(w.nameAr, w.nameEn) || w.name} — ${w.code ?? ""}` }))]}
              value={filters.warehouseId}
              onValueChange={v => setFilters(f => ({ ...f, warehouseId: v }))}
              placeholder={t("inventoryReports.common.allWarehouses")}
            />
          </div>
          <InventoryBrandFilter
            options={brandOptions}
            value={filters.brandId}
            onChange={value => setFilters(f => ({ ...f, brandId: value, itemId: "" }))}
          />
          <div className="space-y-1.5">
            <Label className="text-xs">{t("inventoryReports.itemSalesValuation.branch")}</Label>
            <SearchCombobox
              items={[{ value: "", label: t("inventoryReports.itemSalesValuation.allBranches") }, ...(branches as any[]).map(b => ({ value: String(b.id), label: pickName(b.nameAr, b.nameEn) || b.name || "" }))]}
              value={filters.branchId}
              onValueChange={v => setFilters(f => ({ ...f, branchId: v }))}
              placeholder={t("inventoryReports.itemSalesValuation.allBranches")}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("inventoryReports.itemSalesValuation.customer")}</Label>
            <SearchCombobox
              items={[{ value: "", label: t("inventoryReports.itemSalesValuation.allCustomers") }, ...(customers as any[]).map(c => ({ value: String(c.id), label: `${pickName(c.nameAr, c.nameEn) || c.name || ""} ${c.code ? `— ${c.code}` : ""}` }))]}
              value={filters.customerId}
              onValueChange={v => setFilters(f => ({ ...f, customerId: v }))}
              placeholder={t("inventoryReports.itemSalesValuation.allCustomers")}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("inventoryReports.common.item")}</Label>
            <SearchCombobox
              items={[{ value: "", label: clothingOnly ? t("inventoryReports.clothingSales.allVariants") : t("inventoryReports.itemSalesValuation.allItems") }, ...filteredItems.map(i => ({ value: String(i.id), label: `${pickName(i.nameAr, i.nameEn) || i.code} ${i.code ? `— ${i.code}` : ""}` }))]}
              value={filters.itemId}
              onValueChange={v => setFilters(f => ({ ...f, itemId: v }))}
              placeholder={t("inventoryReports.itemSalesValuation.allItems")}
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-2 flex items-end">
            <Button onClick={apply} className={cn("w-full text-white", BASIS_META[basis].chip)}>
              <Filter className="h-4 w-4 ml-2" /> {t("inventoryReports.itemSalesValuation.showReport")}
            </Button>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className={`grid grid-cols-1 ${clothingOnly ? "sm:grid-cols-4" : "sm:grid-cols-3"} gap-4`}>
        <div className="rounded-xl border bg-blue-50 border-blue-200 p-4">
          <p className="text-xs text-blue-700">{t("inventoryReports.itemSalesValuation.cols.soldValue")}</p>
          <p className="text-2xl font-bold text-blue-700 tabular-nums mt-1">{fmt(totals.soldValue)}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">{t("inventoryReports.itemSalesValuation.qtyLabel", { value: fmtQty(totals.soldQty) })}</p>
        </div>
        <div className="rounded-xl border bg-amber-50 border-amber-200 p-4">
          <p className="text-xs text-amber-700">{t("inventoryReports.itemSalesValuation.cols.returnedValue")}</p>
          <p className="text-2xl font-bold text-amber-700 tabular-nums mt-1">{fmt(totals.returnedValue)}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">{t("inventoryReports.itemSalesValuation.qtyLabel", { value: fmtQty(totals.returnedQty) })}</p>
        </div>
        <div className="rounded-xl border bg-emerald-50 border-emerald-200 p-4">
          <p className="text-xs text-emerald-700">{t("inventoryReports.itemSalesValuation.cols.netValue")}</p>
          <p className="text-2xl font-bold text-emerald-700 tabular-nums mt-1">{fmt(totals.netValue)}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">{t("inventoryReports.itemSalesValuation.netQtyLabel", { value: fmtQty(totals.netQty) })}</p>
        </div>
        {clothingOnly && (
          <div className="rounded-xl border border-violet-200 bg-violet-50 p-4">
            <p className="text-xs text-violet-800">{t("inventoryReports.clothingSales.grossMargin")}</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-violet-900">
              {marginQuery.isLoading || marginQuery.isFetching ? "…" : marginQuery.isError ? "—" : fmt(totalGrossMargin)}
            </p>
            <p className="mt-1 text-[10px] text-violet-800">{t("inventoryReports.clothingSales.marginMethod")}</p>
          </div>
        )}
      </div>

      {clothingOnly && marginQuery.isError && (
        <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          {t("inventoryReports.clothingSales.marginUnavailable")}
        </div>
      )}

      {/* Results table */}
      <div className="w-full min-w-0 overflow-hidden rounded-xl">
        {(isLoading || isFetching || (clothingOnly && (marginQuery.isLoading || marginQuery.isFetching))) ? (
          <div className="space-y-2 rounded-xl border bg-card p-4">
            {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        ) : (
          <AdvancedReportGrid
            slug="itemSalesValuationReportGrid"
            cid={cid}
            columns={gridColumns}
            rowKey={(row: any) => row.itemId}
            rows={filteredRows}
            unitLabel={isRtl ? "صنف" : "item"}
            emptyMessage={t("inventoryReports.itemSalesValuation.noData")}
            totalsRow={filteredRows.length > 0 ? {
              __label: t("inventoryReports.itemSalesValuation.total"),
              soldQty: fmtQty(totals.soldQty),
              soldValue: fmt(totals.soldValue),
              returnedQty: fmtQty(totals.returnedQty),
              returnedValue: fmt(totals.returnedValue),
              netQty: fmtQty(totals.netQty),
              netValue: fmt(totals.netValue),
            } : null}
          />
        )}
      </div>
    </div>
  );
}
