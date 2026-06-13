// Cross-screen "return-from-invoice" prefill bus.
//
// The back-office sales/purchase invoice lists open the matching return screen
// (via PosShell's setView) prefilled from the source document. Because each
// admin screen is a SEPARATE PosShell view that mounts fresh on navigation, a
// tiny module-level singleton is the simplest hand-off: the invoice screen
// `set*`s the payload, navigates, and the return screen `take*`s it ONCE on
// mount (take clears it so a later manual "+ مرتجع" opens blank).
import type { SalesLine, PurchaseLine, PaymentMethod } from "./accounting";

export type SalesReturnPrefill = {
  invoiceId: number;
  customerId: number | null;
  paymentMethod: PaymentMethod;
  warehouseId: number | null;
  lines: SalesLine[];
};

export type PurchaseReturnPrefill = {
  purchaseId: number;
  supplierId: number;
  warehouseId: number | null;
  lines: PurchaseLine[];
};

let salesPrefill: SalesReturnPrefill | null = null;
let purchasePrefill: PurchaseReturnPrefill | null = null;

export function setSalesReturnPrefill(p: SalesReturnPrefill): void { salesPrefill = p; }
export function takeSalesReturnPrefill(): SalesReturnPrefill | null {
  const p = salesPrefill; salesPrefill = null; return p;
}

export function setPurchaseReturnPrefill(p: PurchaseReturnPrefill): void { purchasePrefill = p; }
export function takePurchaseReturnPrefill(): PurchaseReturnPrefill | null {
  const p = purchasePrefill; purchasePrefill = null; return p;
}
