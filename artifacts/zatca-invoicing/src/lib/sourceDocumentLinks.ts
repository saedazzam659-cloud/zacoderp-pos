/**
 * Routes journal rows to their originating document. Keep this independent of
 * React so accounting reports and the journal register cannot drift apart.
 */
export function sourceDocumentUrl(
  entryType: string | null | undefined,
  sourceId: number | string | null | undefined,
): string | null {
  const id = Number(sourceId);
  const hasSourceId = Number.isSafeInteger(id) && id > 0;

  switch (entryType ?? "") {
    case "sales_invoice":
      return hasSourceId ? `/sales/invoices/${id}` : "/sales/invoices";
    case "purchase_invoice":
      return hasSourceId ? `/purchasing/invoices/${id}` : "/purchasing/invoices";
    case "sales_return":
      return hasSourceId ? `/sales/returns?edit=${id}&view=1` : "/sales/returns";
    case "purchase_return":
      return hasSourceId ? `/purchasing/returns?edit=${id}&view=1` : "/purchasing/returns";
    case "customer_settlement":
      return "/sales/settlements";
    case "supplier_settlement":
      return "/purchasing/settlements";
    case "receipt":
    case "receipt_voucher":
      return "/cash/receipt-vouchers";
    case "payment":
    case "payment_voucher":
      return "/cash/payment-vouchers";
    case "stock_transfer":
      return "/inventory/transfers";
    case "stock_adjustment":
      return "/inventory/adjustments";
    case "payroll_run":
      return "/hr/payroll";
    case "employee_loan":
      return "/hr/loans";
    case "eos_payment":
      return "/hr/end-of-service";
    default:
      return null;
  }
}