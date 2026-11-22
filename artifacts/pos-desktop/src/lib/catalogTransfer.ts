import type { ItemBrandView } from "./brands";
import type { ItemUnit } from "./items";

export type CatalogTransferBrandLink = Omit<
  ItemBrandView,
  "id" | "brandId" | "brandNameAr" | "brandNameEn" | "brandCode"
> & {
  brandCode: string;
  brandNameAr: string;
  brandNameEn?: string | null;
};

export type CatalogTransferUnit = Omit<ItemUnit, "id" | "barcode"> & { barcode?: string | null };

export function isIndependentSkuVariant(row: {
  variantGroupName?: string | null;
  variantLabel?: string | null;
  code?: string | null;
  barcode?: string | null;
  isCatalogTransfer?: boolean;
}): boolean {
  const hasStableIdentity = !!(row.code?.trim() || row.barcode?.trim());
  return hasStableIdentity && (
    (!!row.variantGroupName?.trim() && !!row.variantLabel?.trim())
    || row.isCatalogTransfer === true
  );
}

function optionalText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("النص المتوقع غير صالح.");
  return value;
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("القيمة الرقمية غير صالحة.");
  return parsed;
}

export function serializeBrandLinks(links: ItemBrandView[]): string {
  const transferLinks: CatalogTransferBrandLink[] = links.map((link) => ({
    brandCode: link.brandCode,
    brandNameAr: link.brandNameAr,
    brandNameEn: link.brandNameEn ?? null,
    barcode: link.barcode ?? null,
    partNumber: link.partNumber ?? null,
    supplierCode: link.supplierCode ?? null,
    purchaseUnit: link.purchaseUnit ?? null,
    purchaseCost: link.purchaseCost ?? null,
    lastPurchaseCost: link.lastPurchaseCost ?? null,
    avgCost: link.avgCost ?? null,
    salePrice1: link.salePrice1 ?? null,
    salePrice2: link.salePrice2 ?? null,
    salePrice3: link.salePrice3 ?? null,
    minSalePrice: link.minSalePrice ?? null,
    profitMargin: link.profitMargin ?? null,
    discountType: link.discountType ?? "none",
    discountValue: link.discountValue ?? null,
    countryOfOrigin: link.countryOfOrigin ?? null,
    warrantyPeriod: link.warrantyPeriod ?? null,
    status: link.status,
    notes: link.notes ?? null,
  }));
  return JSON.stringify(transferLinks);
}

export function parseBrandLinksJson(raw: string): CatalogTransferBrandLink[] {
  if (!raw.trim()) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error("بيانات العلامات التجارية يجب أن تكون قائمة.");
  const codes = new Set<string>();
  const names = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`بيانات العلامة التجارية رقم ${index + 1} غير صالحة.`);
    }
    const row = entry as Record<string, unknown>;
    const brandCode = optionalText(row.brandCode)?.trim() ?? "";
    const brandNameAr = optionalText(row.brandNameAr)?.trim() ?? "";
    if (!brandNameAr) throw new Error(`اسم العلامة التجارية رقم ${index + 1} مطلوب.`);
    const normalizedCode = brandCode.toLowerCase();
    const normalizedName = brandNameAr.replace(/\s+/g, " ").toLowerCase();
    if ((normalizedCode && codes.has(normalizedCode)) || names.has(normalizedName)) {
      throw new Error("يوجد تكرار لعلامة تجارية داخل بيانات الصنف.");
    }
    if (normalizedCode) codes.add(normalizedCode);
    names.add(normalizedName);
    const status = row.status === "inactive" ? "inactive" : row.status === "active" || row.status == null ? "active" : null;
    if (!status) throw new Error(`حالة العلامة التجارية رقم ${index + 1} غير صالحة.`);
    const discountType = row.discountType === "percent" || row.discountType === "amount" || row.discountType === "none"
      ? row.discountType
      : row.discountType == null ? "none" : null;
    if (!discountType) throw new Error(`نوع الخصم للعلامة رقم ${index + 1} غير صالح.`);
    return {
      brandCode,
      brandNameAr,
      brandNameEn: optionalText(row.brandNameEn),
      barcode: optionalText(row.barcode),
      partNumber: optionalText(row.partNumber),
      supplierCode: optionalText(row.supplierCode),
      purchaseUnit: optionalText(row.purchaseUnit),
      purchaseCost: optionalNumber(row.purchaseCost),
      lastPurchaseCost: optionalNumber(row.lastPurchaseCost),
      avgCost: optionalNumber(row.avgCost),
      salePrice1: optionalNumber(row.salePrice1),
      salePrice2: optionalNumber(row.salePrice2),
      salePrice3: optionalNumber(row.salePrice3),
      minSalePrice: optionalNumber(row.minSalePrice),
      profitMargin: optionalNumber(row.profitMargin),
      discountType,
      discountValue: optionalNumber(row.discountValue),
      countryOfOrigin: optionalText(row.countryOfOrigin),
      warrantyPeriod: optionalText(row.warrantyPeriod),
      status,
      notes: optionalText(row.notes),
    };
  });
}

export function serializeSalesUnits(units: ItemUnit[] | null | undefined): string {
  return JSON.stringify((units ?? []).map(({ name, factor, price, barcode }) => ({
    name,
    factor,
    price,
    barcode: barcode ?? null,
  })));
}

export function parseSalesUnitsJson(raw: string): CatalogTransferUnit[] {
  if (!raw.trim()) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error("بيانات وحدات البيع يجب أن تكون قائمة.");
  const barcodes = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`وحدة البيع رقم ${index + 1} غير صالحة.`);
    }
    const row = entry as Record<string, unknown>;
    const name = optionalText(row.name)?.trim() ?? "";
    const factor = Number(row.factor);
    const price = Number(row.price);
    const barcode = optionalText(row.barcode);
    if (!name || !Number.isFinite(factor) || factor <= 0 || row.price == null || row.price === "" || !Number.isFinite(price) || price < 0) {
      throw new Error(`بيانات وحدة البيع رقم ${index + 1} غير مكتملة أو غير صالحة.`);
    }
    const normalizedBarcode = barcode?.trim();
    if (normalizedBarcode && barcodes.has(normalizedBarcode)) throw new Error("باركود وحدات البيع مكرر داخل بيانات الصنف.");
    if (normalizedBarcode) barcodes.add(normalizedBarcode);
    return { name, factor, price, barcode };
  });
}
