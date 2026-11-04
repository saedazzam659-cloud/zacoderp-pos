import type { CreateInvoiceLine, ROrderItem } from "./api";

type RestaurantPricingItem = Pick<
  ROrderItem,
  "erpItemId" | "erpItemType" | "erpVatRate" | "vatIncluded" | "nameSnapshot" | "qty" | "price"
>;

export function buildRestaurantInvoicePricing(
  items: RestaurantPricingItem[],
  warehouseId: number | null,
): {
  lines: CreateInvoiceLine[];
  subtotal: number;
  vatAmount: number;
  totalAmount: number;
} {
  const grouped = new Map<string, {
    itemId: number;
    itemType: "stock" | "service";
    itemName: string;
    qty: number;
    grossUnitPrice: number;
    vatRate: number;
  }>();

  for (const item of items) {
    const itemId = Number(item.erpItemId);
    const itemType = item.erpItemType;
    if (!Number.isInteger(itemId) || itemId <= 0 || (itemType !== "stock" && itemType !== "service")) {
      throw new Error("اربط كل صنف مطعم بصنف مخزون أو خدمة من إعدادات المطعم قبل الفوترة");
    }
    const qty = Number(item.qty);
    const price = Number(item.price);
    const configuredRate = item.erpVatRate == null ? Number.NaN : Number(item.erpVatRate);
    const vatRate = Number.isFinite(configuredRate) && configuredRate >= 0 ? configuredRate : 15;
    // Normalize mixed menu price settings to the VAT-inclusive basis expected
    // by the sales invoice header, retaining each ERP item's own VAT rate.
    const grossUnitPrice = Number((item.vatIncluded === false
      ? price * (1 + vatRate / 100)
      : price).toFixed(4));
    const key = `erp:${itemId}:${vatRate}:${grossUnitPrice.toFixed(4)}`;
    const current = grouped.get(key);
    if (current) current.qty += qty;
    else grouped.set(key, { itemId, itemType, itemName: item.nameSnapshot, qty, grossUnitPrice, vatRate });
  }

  let subtotal = 0;
  let vatAmount = 0;
  const lines: CreateInvoiceLine[] = [...grouped.values()].map(line => {
    const lineGross = Number((line.qty * line.grossUnitPrice).toFixed(2));
    const lineNet = Number((lineGross / (1 + line.vatRate / 100)).toFixed(2));
    subtotal += lineNet;
    vatAmount += lineGross - lineNet;
    return {
      itemId: line.itemId,
      itemName: line.itemName,
      qty: line.qty,
      unitPrice: line.grossUnitPrice,
      discount: 0,
      vatRate: line.vatRate,
      lineTotal: lineGross,
      warehouseId: line.itemType === "stock" ? warehouseId ?? undefined : undefined,
    };
  });

  const roundedSubtotal = Number(subtotal.toFixed(2));
  const roundedVat = Number(vatAmount.toFixed(2));
  return {
    lines,
    subtotal: roundedSubtotal,
    vatAmount: roundedVat,
    totalAmount: Number((roundedSubtotal + roundedVat).toFixed(2)),
  };
}
