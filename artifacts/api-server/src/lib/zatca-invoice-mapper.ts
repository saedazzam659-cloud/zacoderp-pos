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
import { createHash } from "node:crypto";

/**
 * ZATCA requires the submission `uuid` (and the matching <cbc:UUID> embedded in
 * the signed XML) to be a valid GUID. The human invoice number ("160") is NOT a
 * valid UUID, so the live clearance gateway rejects it with
 * "UUID format in the API body is not valid".
 *
 * The UUID is part of the hashed/signed XML, and the PIH chain links each
 * invoice to the PERSISTED hash of the previous one. Issue-time hashing and
 * live-submit hashing therefore MUST agree on the UUID, and retries must reuse
 * the same value — so this is DETERMINISTIC (derived from the immutable
 * company + invoice-number identity), never random. It yields a format-valid
 * RFC-4122 v5-style GUID with no schema change.
 */
export function zatcaDocumentUuid(companyId: number, invoiceNumber: string): string {
  const digest = createHash("sha256")
    .update(`zatca:${companyId}:${invoiceNumber}`)
    .digest();
  const b = Buffer.from(digest.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC-4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

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
