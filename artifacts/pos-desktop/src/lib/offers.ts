// Client wrapper for offers (العروض الترويجية) management commands.
// Tauri-only: standalone mode is the entry point. Browser-dev preview
// returns empty arrays / throws clear errors.
//
// LIMITATION: this is management/CRUD only. The sale-time matching engine
// (applying offers automatically on the register) is NOT wired into the
// offline SalesScreen — that screen does not exist in pos-desktop today.

import { invoke } from "./tauri-shim";

function hasTauri(): boolean {
  return typeof window !== "undefined" &&
    (("__TAURI_INTERNALS__" in window) || ("__TAURI__" in window));
}
function notImpl(): never { throw new Error("هذه الميزة متاحة في تطبيق سطح المكتب فقط"); }

export type OfferDiscountType = "percentage_total" | "fixed_total" | "buy_x_get_y" | "line_pricing";
export type OfferStatus = "draft" | "active" | "expired";
export type OfferScope = "all" | "specific";

export type OfferItemRow = {
  itemId: number;
  itemName?: string | null;
  price?: number | null;
  discount?: number | null;
  qty?: number | null;
};

export type OfferRow = {
  id: number;
  offerNumber: string;
  nameAr: string;
  description: string | null;
  discountType: OfferDiscountType;
  discountValue: number;
  buyQty: number;
  getQty: number;
  getDiscountPercent: number;
  priority: number;
  status: OfferStatus;
  startDate: string | null;
  expiryDate: string | null;
  minPurchase: number;
  maxUses: number | null;
  maxUsesPerCustomer: number | null;
  timesUsed: number;
  stackable: boolean;
  couponCode: string | null;
  applyTo: string;
  customerScope: OfferScope;
  itemsScope: OfferScope;
  salesRepScope: OfferScope;
  customerIds: number[];
  salesRepIds: number[];
  items: OfferItemRow[];
};

export type OfferInput = {
  nameAr: string;
  description?: string | null;
  discountType: OfferDiscountType;
  discountValue: number;
  buyQty: number;
  getQty: number;
  getDiscountPercent: number;
  priority: number;
  startDate?: string | null;
  expiryDate?: string | null;
  minPurchase: number;
  maxUses?: number | null;
  maxUsesPerCustomer?: number | null;
  stackable: boolean;
  couponCode?: string | null;
  applyTo: string;
  customerScope: OfferScope;
  itemsScope: OfferScope;
  salesRepScope: OfferScope;
  customerIds: number[];
  salesRepIds: number[];
  items: OfferItemRow[];
};

export async function listOffers(): Promise<OfferRow[]> {
  if (!hasTauri()) return [];
  return await invoke<OfferRow[]>("offers_list");
}
export async function getOffer(id: number): Promise<OfferRow> {
  if (!hasTauri()) notImpl();
  return await invoke<OfferRow>("offer_get", { id });
}
export async function createOffer(input: OfferInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("offer_create", { input });
}
export async function updateOffer(id: number, input: OfferInput): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("offer_update", { id, input });
}
export async function setOfferStatus(id: number, status: OfferStatus): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("offer_set_status", { id, status });
}
export async function deleteOffer(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("offer_delete", { id });
}
