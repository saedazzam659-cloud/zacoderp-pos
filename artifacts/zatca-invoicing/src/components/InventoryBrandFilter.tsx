import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { inventoryApi } from "@/lib/inventoryApi";

export type InventoryReportBrandOption = {
  brandId: number;
  code: string | null;
  nameAr: string | null;
  nameEn: string | null;
  itemIds: number[];
};

export function useInventoryReportBrandOptions(companyId?: number) {
  const { data = [] } = useQuery({
    queryKey: ["inventory-report-brand-options", companyId],
    queryFn: () => inventoryApi.getInventoryReportBrandOptions(companyId),
    enabled: companyId != null,
    staleTime: 60_000,
  });
  return data as InventoryReportBrandOption[];
}

export function InventoryBrandFilter({
  options,
  value,
  onChange,
  className = "",
}: {
  options: InventoryReportBrandOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  if (options.length === 0) return null;

  const isRtl = i18n.language === "ar";
  return (
    <div className={`space-y-1.5 ${className}`}>
      <Label>{t("inventoryReports.common.brand")}</Label>
      <select
        aria-label={t("inventoryReports.common.brand")}
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
        value={value}
        onChange={event => onChange(event.target.value)}
      >
        <option value="">{t("inventoryReports.common.allBrands")}</option>
        {options.map(brand => {
          const name = isRtl
            ? brand.nameAr || brand.nameEn || brand.code || `#${brand.brandId}`
            : brand.nameEn || brand.nameAr || brand.code || `#${brand.brandId}`;
          return (
            <option key={brand.brandId} value={String(brand.brandId)}>
              {name}{brand.code ? ` (${brand.code})` : ""}
            </option>
          );
        })}
      </select>
      <p className="text-[11px] leading-snug text-muted-foreground">
        {t("inventoryReports.common.brandFilterItemLevelHint")}
      </p>
    </div>
  );
}

export function filterItemsForInventoryBrand<T extends { id: number | string }>(
  items: T[],
  brandId: string,
  options: InventoryReportBrandOption[],
): T[] {
  if (!brandId) return items;
  const brand = options.find(option => String(option.brandId) === brandId);
  if (!brand) return [];
  const itemIds = new Set(brand.itemIds.map(Number));
  return items.filter(item => itemIds.has(Number(item.id)));
}

export function filterRowsForInventoryBrand<T>(
  rows: T[],
  brandId: string,
  options: InventoryReportBrandOption[],
): T[] {
  if (!brandId) return rows;
  const brand = options.find(option => String(option.brandId) === brandId);
  if (!brand) return [];
  const itemIds = new Set(brand.itemIds.map(Number));
  return rows.filter(row => {
    const value = row as any;
    const itemId = value?.item?.id ?? value?.itemId;
    return itemId != null && itemIds.has(Number(itemId));
  });
}
