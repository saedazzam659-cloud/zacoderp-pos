// Client wrappers for the offline purchasing-analytics datasets (تقارير المشتريات).
// Mirror of salesReports.ts: the Rust side returns filtered raw rows; the report
// pages group them by period / item / supplier client-side. Each wrapper
// degrades to an empty array in a plain browser context (no Tauri) so the
// screens render cleanly during UI development.

import { invoke } from "./tauri-shim";

function hasTauri(): boolean {
  return typeof window !== "undefined" &&
    (("__TAURI_INTERNALS__" in window) || ("__TAURI__" in window));
}

export type PurchaseInvoiceReportRow = {
  id: number;
  invoiceNo: string;
  invoiceDate: string;
  supplierId: number | null;
  supplierName: string | null;
  paymentMethod: string;
  subtotal: number;
  vatTotal: number;
  grandTotal: number;
  lineCount: number;
};

export type PurchaseLineReportRow = {
  purchaseId: number;
  invoiceNo: string;
  invoiceDate: string;
  supplierId: number | null;
  supplierName: string | null;
  itemId: number;
  itemCode: string | null;
  itemName: string;
  qty: number;
  unitCost: number;
  lineTotal: number;
  vatRate: number;
};

export type PurchaseReturnReportRow = {
  id: number;
  returnNo: string;
  returnDate: string;
  supplierId: number | null;
  supplierName: string | null;
  subtotal: number;
  vatTotal: number;
  grandTotal: number;
};

export type PurchaseReportFilter = {
  fromDate?: string | null;
  toDate?: string | null;
  branchId?: number | null;
  supplierId?: number | null;
};

export async function reportPurchaseInvoices(filter: PurchaseReportFilter = {}): Promise<PurchaseInvoiceReportRow[]> {
  if (!hasTauri()) return [];
  return await invoke<PurchaseInvoiceReportRow[]>("report_purchase_invoices", {
    fromDate: filter.fromDate ?? null,
    toDate: filter.toDate ?? null,
    branchId: filter.branchId ?? null,
    supplierId: filter.supplierId ?? null,
  });
}

export async function reportPurchaseInvoiceLines(
  filter: Omit<PurchaseReportFilter, "supplierId"> = {},
): Promise<PurchaseLineReportRow[]> {
  if (!hasTauri()) return [];
  return await invoke<PurchaseLineReportRow[]>("report_purchase_invoice_lines", {
    fromDate: filter.fromDate ?? null,
    toDate: filter.toDate ?? null,
    branchId: filter.branchId ?? null,
  });
}

export async function reportPurchaseReturns(filter: PurchaseReportFilter = {}): Promise<PurchaseReturnReportRow[]> {
  if (!hasTauri()) return [];
  return await invoke<PurchaseReturnReportRow[]>("report_purchase_returns", {
    fromDate: filter.fromDate ?? null,
    toDate: filter.toDate ?? null,
    branchId: filter.branchId ?? null,
    supplierId: filter.supplierId ?? null,
  });
}
