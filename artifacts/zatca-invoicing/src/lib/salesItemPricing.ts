/**
 * The item editor's sale price is the visible/catalog price for the base unit.
 * Alternate units keep their own prices from the item-unit table.
 */
export function resolveSalesItemUnitPrice(item: any, unitRow: any): string {
  const itemPrice = item?.salePrice ?? item?.sellPrice ?? item?.price;
  const hasItemSalePrice = itemPrice != null
    && itemPrice !== ""
    && Number.isFinite(Number(itemPrice))
    && Number(itemPrice) > 0;

  if (unitRow?.isBase && hasItemSalePrice) return String(itemPrice);
  return String(unitRow?.salePrice ?? itemPrice ?? "0");
}
