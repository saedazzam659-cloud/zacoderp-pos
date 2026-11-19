import type { BrandDiscountType, ItemBrandLink } from "./brands";

export type PriceChangeDirection = "increase" | "decrease";
export type PriceChangeBasis = "percent" | "amount";

export function calculateBrandSalePrice(
  currentPrice: number,
  direction: PriceChangeDirection,
  basis: PriceChangeBasis,
  value: number,
): number {
  const price = Number.isFinite(currentPrice) ? Math.max(0, currentPrice) : 0;
  const adjustment = Number.isFinite(value) ? Math.max(0, value) : 0;
  const delta = basis === "percent" ? price * adjustment / 100 : adjustment;
  return Math.max(0, direction === "increase" ? price + delta : price - delta);
}

export function calculateBrandNetPrice(
  salePrice: number,
  discountType?: BrandDiscountType | null,
  discountValue?: number | null,
): number {
  const price = Number.isFinite(salePrice) ? Math.max(0, salePrice) : 0;
  const value = Number.isFinite(Number(discountValue)) ? Math.max(0, Number(discountValue)) : 0;
  if (!discountType || discountType === "none" || value === 0) return price;
  if (discountType === "percent") return price * (1 - Math.min(100, value) / 100);
  return Math.max(0, price - value);
}

/** Returns line-discount fields for the existing invoice discount calculator. */
export function brandDiscountForLine(
  link: Pick<ItemBrandLink, "discountType" | "discountValue">,
  quantity: number,
): { disc: number; discType: "percent" | "value" } | null {
  const value = Math.max(0, Number(link.discountValue) || 0);
  if (!value || !link.discountType || link.discountType === "none") return null;
  return {
    disc: link.discountType === "amount" ? value * Math.max(0, quantity) : value,
    discType: link.discountType === "amount" ? "value" : "percent",
  };
}

