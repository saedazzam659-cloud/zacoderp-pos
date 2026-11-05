export type RestaurantOrderPricingLine = {
  menuItemId?: number;
  erpItemId?: number | null;
  qty: string | number;
  price: string | number;
  vatIncluded?: boolean | null;
  vatRate?: string | number | null;
  modifiers?: Array<{
    itemId?: number;
    price?: string | number;
    consumptionQtyPerSelection?: string | number;
    vatRate?: string | number | null;
    vatIncluded?: boolean | null;
  }> | null;
};

export function calculateRestaurantOrderTotals(lines: RestaurantOrderPricingLine[]) {
  const groups = new Map<string, { qty: number; grossUnitPrice: number; rate: number }>();
  const addLine = (
    line: Pick<RestaurantOrderPricingLine, "menuItemId" | "erpItemId" | "qty" | "price" | "vatIncluded" | "vatRate">,
  ) => {
    const rawRate = line.vatRate == null || String(line.vatRate).trim() === ""
      ? Number.NaN
      : Number(line.vatRate);
    const rate = Number.isFinite(rawRate) && rawRate >= 0 ? rawRate : 15;
    const price = Number(line.price);
    const grossUnitPrice = Number((line.vatIncluded === false
      ? price * (1 + rate / 100)
      : price).toFixed(4));
    const itemKey = line.erpItemId != null ? `erp:${line.erpItemId}` : `menu:${line.menuItemId ?? "unknown"}`;
    const key = `${itemKey}:${rate}:${grossUnitPrice.toFixed(4)}`;
    const current = groups.get(key);
    if (current) current.qty += Number(line.qty);
    else groups.set(key, { qty: Number(line.qty), grossUnitPrice, rate });
  };
  for (const line of lines) {
    addLine(line);
    for (const modifier of line.modifiers ?? []) {
      if (!modifier.itemId || modifier.price == null) continue;
      const consumptionQty = Number(modifier.consumptionQtyPerSelection ?? 1);
      if (!Number.isFinite(consumptionQty) || consumptionQty <= 0) continue;
      addLine({
        menuItemId: line.menuItemId,
        erpItemId: modifier.itemId,
        qty: Number((Number(line.qty) * consumptionQty).toFixed(4)),
        price: Number((Number(modifier.price) / consumptionQty).toFixed(4)),
        vatIncluded: modifier.vatIncluded ?? line.vatIncluded,
        vatRate: modifier.vatRate,
      });
    }
  }

  let subtotal = 0;
  let vatAmount = 0;
  let total = 0;
  for (const line of groups.values()) {
    const lineGross = Number((line.qty * line.grossUnitPrice).toFixed(2));
    const lineNet = Number((lineGross / (1 + line.rate / 100)).toFixed(2));
    subtotal += lineNet;
    vatAmount += lineGross - lineNet;
    total += lineGross;
  }
  return {
    subtotal: subtotal.toFixed(2),
    vatAmount: vatAmount.toFixed(2),
    total: total.toFixed(2),
  };
}
