/**
 * Gateway Invoice → UBL + TLV QR builder.
 *
 * Adapts the lean `canonicalJson` we persist in gateway_invoices (single
 * line, minimal seller/buyer fields) to the richer `InvoiceData` shape
 * expected by generateZatcaXml(), then produces the TLV QR base64 from
 * the same data so the two stay in lock-step.
 *
 * Used by:
 *   • submit-batch (Phase 1B) — pre-build UBL + QR at insert time so the
 *     viewer/PDF/ZATCA-POST never have to re-derive them.
 *   • POST /:id/invoices/:invId/submit-zatca — re-runs builder for any row
 *     missing ublXml/qrTlv before calling ZATCA HTTP.
 */
import { generateZatcaXml } from "./zatca-xml.js";
import { generateZatcaQr } from "./zatca-tlv.js";
import { createHash } from "crypto";

export interface GatewayCanonical {
  seller?: { name?: string | null; vat?: string | null };
  buyer?:  { name?: string | null; vat?: string | null };
  invoice: {
    number: string;
    type?: string;
    flow?: "standard" | "simplified";
    issueDate: string;
    issueTime?: string;
    currency?: string;
    icv: number;
    pih: string;
  };
  line: {
    item: string;
    qty: number;
    unitPrice: number;
    vatRate: number;
    vatCategory?: string;
    totalExclVat: number;
    vatAmount: number;
    totalInclVat: number;
  };
  egs?: { serial?: string | null; vat?: string };
}

export interface GatewayClientLite {
  nameAr: string;
  nameEn?: string | null;
  vatNumber: string;
  crNumber?: string | null;
  addressAr?: string | null;
  city?: string | null;
}

export interface BuiltInvoiceArtifacts {
  ublXml: string;
  qrTlv: string;
  invoiceHash: string;
}

export function buildUblForGatewayInvoice(
  canonical: GatewayCanonical,
  client: GatewayClientLite,
): BuiltInvoiceArtifacts {
  const flow = canonical.invoice.flow ?? "simplified";
  const currency = canonical.invoice.currency ?? "SAR";
  const issueTime = canonical.invoice.issueTime ?? "00:00:00";

  // ZATCA TLV QR is built from issuance timestamp (ISO 8601) + totals
  // exactly as displayed on the invoice — keep them in sync with the UBL.
  const isoTs = `${canonical.invoice.issueDate}T${issueTime}Z`;
  const qrTlv = generateZatcaQr({
    sellerName:       canonical.seller?.name || client.nameAr,
    vatNumber:        canonical.seller?.vat  || client.vatNumber,
    invoiceTimestamp: isoTs,
    invoiceTotal:     canonical.line.totalInclVat.toFixed(2),
    vatAmount:        canonical.line.vatAmount.toFixed(2),
  });

  const ublXml = generateZatcaXml({
    invoiceNumber: canonical.invoice.number,
    invoiceType:   flow,
    issueDate:     canonical.invoice.issueDate,
    issueTime,
    supplyDate:    canonical.invoice.issueDate,
    currency,
    paymentMethod: "10",
    subtotal:      canonical.line.totalExclVat.toFixed(2),
    discountTotal: "0.00",
    vatTotal:      canonical.line.vatAmount.toFixed(2),
    grandTotal:    canonical.line.totalInclVat.toFixed(2),
    notes:         null,
    invoiceCounterValue: canonical.invoice.icv,
    previousInvoiceHash: canonical.invoice.pih,
    qrCode:        qrTlv,
    lineItems: [
      {
        id: 1,
        description:    canonical.line.item,
        quantity:       String(canonical.line.qty),
        unitCode:       "PCE",
        unitPrice:      String(canonical.line.unitPrice),
        discountAmount: "0",
        taxCategory:    canonical.line.vatCategory ?? "S",
        vatRate:        String(canonical.line.vatRate),
        vatAmount:      String(canonical.line.vatAmount),
        subtotal:       String(canonical.line.totalExclVat),
        total:          String(canonical.line.totalInclVat),
      },
    ],
    company: {
      nameAr:         canonical.seller?.name || client.nameAr,
      nameEn:         client.nameEn ?? null,
      vatNumber:      canonical.seller?.vat  || client.vatNumber,
      crNumber:       client.crNumber || "0000000000",
      street:         client.addressAr || "غير محدد",
      buildingNumber: "0000",
      city:           client.city || "الرياض",
      district:       null,
      postalCode:     "00000",
      country:        "SA",
    },
    customer: canonical.buyer?.name
      ? {
          nameAr:         canonical.buyer.name,
          vatNumber:      canonical.buyer.vat ?? null,
          crNumber:       null,
          street:         null,
          buildingNumber: null,
          city:           null,
          district:       null,
          postalCode:     null,
          country:        "SA",
        }
      : null,
  });

  // Same hashing strategy as submit-batch (sha256 of canonical JSON in
  // hex). We don't switch to XML hashing until full XAdES signing lands.
  const invoiceHash = createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");

  return { ublXml, qrTlv, invoiceHash };
}
