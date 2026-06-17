// Client wrappers for the offline sales-analytics datasets (تقارير المبيعات).
// The Rust side returns filtered raw rows; the report pages group them by
// period / item / customer client-side. Each wrapper degrades to an empty
// array in a plain browser context (no Tauri) so the screens render cleanly
// during UI development.

import { invoke } from "./tauri-shim";

function hasTauri(): boolean {
  return typeof window !== "undefined" &&
    (("__TAURI_INTERNALS__" in window) || ("__TAURI__" in window));
}

export type SalesInvoiceReportRow = {
  id: number;
  invoiceNo: string;
  invoiceDate: string;
  customerId: number | null;
  customerName: string | null;
  paymentMethod: string;
  subtotal: number;
  vatTotal: number;
  grandTotal: number;
  lineCount: number;
};

export type SalesLineReportRow = {
  invoiceId: number;
  invoiceNo: string;
  invoiceDate: string;
  customerId: number | null;
  customerName: string | null;
  itemId: number;
  itemCode: string | null;
  itemName: string;
  qty: number;
  unitPrice: number;
  unitCost: number;
  lineTotal: number;
  vatRate: number;
  freeQty: number;
};

export type SalesReturnLineReportRow = {
  returnId: number;
  returnNo: string;
  returnDate: string;
  customerId: number | null;
  customerName: string | null;
  itemId: number;
  itemCode: string | null;
  itemName: string;
  qty: number;
  unitPrice: number;
  unitCost: number;
  lineTotal: number;
  vatRate: number;
  freeQty: number;
};

export type SalesReturnReportRow = {
  id: number;
  returnNo: string;
  returnDate: string;
  customerId: number | null;
  customerName: string | null;
  subtotal: number;
  vatTotal: number;
  grandTotal: number;
};

export type SalesReportFilter = {
  fromDate?: string | null;
  toDate?: string | null;
  branchId?: number | null;
  customerId?: number | null;
};

export async function reportSalesInvoices(filter: SalesReportFilter = {}): Promise<SalesInvoiceReportRow[]> {
  if (!hasTauri()) return [];
  return await invoke<SalesInvoiceReportRow[]>("report_sales_invoices", {
    fromDate: filter.fromDate ?? null,
    toDate: filter.toDate ?? null,
    branchId: filter.branchId ?? null,
    customerId: filter.customerId ?? null,
  });
}

export async function reportSalesInvoiceLines(
  filter: Omit<SalesReportFilter, "customerId"> = {},
): Promise<SalesLineReportRow[]> {
  if (!hasTauri()) return [];
  return await invoke<SalesLineReportRow[]>("report_sales_invoice_lines", {
    fromDate: filter.fromDate ?? null,
    toDate: filter.toDate ?? null,
    branchId: filter.branchId ?? null,
  });
}

export async function reportSalesReturns(filter: SalesReportFilter = {}): Promise<SalesReturnReportRow[]> {
  if (!hasTauri()) return [];
  return await invoke<SalesReturnReportRow[]>("report_sales_returns", {
    fromDate: filter.fromDate ?? null,
    toDate: filter.toDate ?? null,
    branchId: filter.branchId ?? null,
    customerId: filter.customerId ?? null,
  });
}

export async function reportSalesReturnLines(
  filter: Omit<SalesReportFilter, "customerId"> = {},
): Promise<SalesReturnLineReportRow[]> {
  if (!hasTauri()) return [];
  return await invoke<SalesReturnLineReportRow[]>("report_sales_return_lines", {
    fromDate: filter.fromDate ?? null,
    toDate: filter.toDate ?? null,
    branchId: filter.branchId ?? null,
  });
}
