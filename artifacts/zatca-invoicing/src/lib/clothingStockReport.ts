export type ClothingStockItem = {
  id: number;
  code?: string | null;
  nameAr?: string | null;
  nameEn?: string | null;
  barcode?: string | null;
  parentItemId?: number | null;
  tags?: string | string[] | null;
  variantAttributes?: Record<string, unknown> | null;
  unit?: { nameAr?: string | null; nameEn?: string | null } | null;
  unitNameAr?: string | null;
};

export type ClothingStockBalance = {
  itemId: number;
  qty?: number | string | null;
  avgCost?: number | string | null;
  warehouseId?: number | null;
  warehouse?: { id?: number | null; nameAr?: string | null; nameEn?: string | null } | null;
  unit?: { nameAr?: string | null; nameEn?: string | null } | null;
};

export type ClothingStockReportRow = {
  itemId: number;
  code: string;
  nameAr: string;
  barcode: string;
  modelId: number;
  modelCode: string;
  modelNameAr: string;
  color: string;
  size: string;
  unitNameAr: string;
  warehouseId: number | null;
  warehouseNameAr: string;
  qty: number;
  avgCost: number;
  inventoryValue: number;
};

const CLOTHING_TAG = "ملابس وأحذية";

function isClothingModel(tags: ClothingStockItem["tags"]): boolean {
  const values = Array.isArray(tags) ? tags : String(tags ?? "").split(",");
  return values.some((tag) => tag.trim() === CLOTHING_TAG);
}

function finiteNumber(value: number | string | null | undefined): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

export function clothingVariantItemIds(items: ClothingStockItem[]): Set<number> {
  const clothingModelIds = new Set(
    items
      .filter((item) => !item.parentItemId && isClothingModel(item.tags))
      .map((item) => Number(item.id)),
  );
  return new Set(
    items
      .filter((item) => item.parentItemId && clothingModelIds.has(Number(item.parentItemId)))
      .map((item) => Number(item.id)),
  );
}

export function mapClothingStockRows(
  items: ClothingStockItem[],
  balances: ClothingStockBalance[],
): ClothingStockReportRow[] {
  const itemsById = new Map(items.map((item) => [Number(item.id), item]));
  const clothingVariantIds = clothingVariantItemIds(items);

  return balances.flatMap((balance) => {
    const item = itemsById.get(Number(balance.itemId));
    if (!item || !clothingVariantIds.has(Number(item.id)) || !item.parentItemId) return [];

    const model = itemsById.get(Number(item.parentItemId));
    if (!model) return [];

    const qty = finiteNumber(balance.qty);
    const avgCost = finiteNumber(balance.avgCost);
    const attributes = item.variantAttributes ?? {};
    return [{
      itemId: Number(item.id),
      code: String(item.code ?? ""),
      nameAr: String(item.nameAr ?? ""),
      barcode: String(item.barcode ?? ""),
      modelId: Number(model.id),
      modelCode: String(model.code ?? ""),
      modelNameAr: String(model.nameAr ?? ""),
      color: String(attributes["اللون"] ?? ""),
      size: String(attributes["المقاس"] ?? ""),
      unitNameAr: String(balance.unit?.nameAr ?? item.unit?.nameAr ?? item.unitNameAr ?? ""),
      warehouseId: balance.warehouseId == null ? null : Number(balance.warehouseId),
      warehouseNameAr: String(balance.warehouse?.nameAr ?? balance.warehouse?.nameEn ?? ""),
      qty,
      avgCost,
      inventoryValue: qty * avgCost,
    }];
  }).sort((a, b) =>
    a.modelNameAr.localeCompare(b.modelNameAr, "ar")
      || a.code.localeCompare(b.code)
      || a.warehouseNameAr.localeCompare(b.warehouseNameAr, "ar"),
  );
}
