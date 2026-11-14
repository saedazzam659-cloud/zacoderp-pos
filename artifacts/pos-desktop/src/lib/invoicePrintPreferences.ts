import type { PrintKind } from "./invoicePrint";

const LS_AUTO_PRINT_SALES_INVOICES = "pos_desktop_peripherals_auto_print_sales_invoices";
const LS_AUTO_PRINT_SALES_INVOICE_FORMAT = "pos_desktop_peripherals_auto_print_sales_invoice_format";

export function getSalesInvoiceAutoPrintEnabled(): boolean {
  return localStorage.getItem(LS_AUTO_PRINT_SALES_INVOICES) === "true";
}

export function setSalesInvoiceAutoPrintEnabled(enabled: boolean): void {
  localStorage.setItem(LS_AUTO_PRINT_SALES_INVOICES, enabled ? "true" : "false");
}

export function getSalesInvoiceAutoPrintFormat(): PrintKind {
  return localStorage.getItem(LS_AUTO_PRINT_SALES_INVOICE_FORMAT) === "thermal" ? "thermal" : "a4";
}

export function setSalesInvoiceAutoPrintFormat(format: PrintKind): void {
  localStorage.setItem(LS_AUTO_PRINT_SALES_INVOICE_FORMAT, format);
}
