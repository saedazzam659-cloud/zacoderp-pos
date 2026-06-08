/**
 * Map a stored invoice row (+ its lines, company, customer) into the
 * `InvoiceData` shape the ZATCA UBL generator expects.
 *
 * This is the SINGLE mapping used by every real-invoice ZATCA path — issue-time
 * storage, manual compliance check, and live clearance/reporting — so the XML
 * (and therefore the hash) is byte-identical no matter which route builds it.
 * Without one shared mapper the compliance-test document and the live document
 * could diverge and produce two different hashes for "the same" invoice.
 */
import type {
  invoicesTable,
  invoiceLineItemsTable,
  companiesTable,
  customersTable,
} from "@workspace/db";
import type { InvoiceData } from "./zatca-xml.js";

type InvoiceRow = typeof invoicesTable.$inferSelect;
type LineRow = typeof invoiceLineItemsTable.$inferSelect;
type CompanyRow = typeof companiesTable.$inferSelect;
type CustomerRow = typeof customersTable.$inferSelect;

export interface ZatcaChainParams {
  /** ICV — the monotonic per-company invoice counter value. */
  invoiceCounterValue: number;
  /** PIH — the previous invoice's (correct, empty-QR) hash, or the genesis hash. */
  previousInvoiceHash: string;
  /** cbc:IssueTime (HH:MM:SS). Defaults to the current wall-clock time. */
  issueTime?: string;
}

/**
 * Build the QR-less `InvoiceData` for a stored invoice. The caller passes the
 * result to `buildSignedZatcaInvoice`, which always forces an empty QR placeholder.
 */
export function invoiceRowToZatcaData(
  invoice: InvoiceRow,
  lineItems: LineRow[],
  company: CompanyRow | null,
  customer: CustomerRow | null,
  chain: ZatcaChainParams,
): Omit<InvoiceData, "qrCode"> {
  return {
    invoiceNumber: invoice.invoiceNumber,
    invoiceType: invoice.invoiceType,
    issueDate: invoice.issueDate,
    issueTime: chain.issueTime ?? new Date().toTimeString().split(" ")[0],
    supplyDate: invoice.supplyDate,
    currency: invoice.currency,
    paymentMethod: invoice.paymentMethod ?? "10",
    subtotal: invoice.subtotal,
    discountTotal: invoice.discountTotal,
    vatTotal: invoice.vatTotal,
    grandTotal: invoice.grandTotal,
    notes: invoice.notes,
    invoiceCounterValue: chain.invoiceCounterValue,
    previousInvoiceHash: chain.previousInvoiceHash,
    lineItems: lineItems.map((li) => ({
      id: li.id,
      description: li.description,
      quantity: li.quantity,
      unitCode: li.unitCode ?? "PCE",
      unitPrice: li.unitPrice,
      discountAmount: li.discountAmount,
      taxCategory: li.taxCategory ?? "S",
      vatRate: li.vatRate,
      vatAmount: li.vatAmount,
      subtotal: li.subtotal,
      total: li.total,
    })),
    company: company ?? {
      nameAr: "غير محدد",
      vatNumber: "",
      crNumber: "",
      street: "",
      buildingNumber: "",
      city: "",
      postalCode: "",
      country: "SA",
    },
    customer: invoice.buyerName
      ? {
          nameAr: invoice.buyerName,
          vatNumber: invoice.buyerVatNumber,
          crNumber: invoice.buyerCrNumber,
          street: invoice.buyerStreet,
          buildingNumber: invoice.buyerBuildingNumber,
          district: invoice.buyerDistrict,
          city: invoice.buyerCity,
          postalCode: invoice.buyerPostalCode,
          country: invoice.buyerCountry ?? "SA",
        }
      : customer ?? null,
  };
}
