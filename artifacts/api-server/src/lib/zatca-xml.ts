/**
 * ZATCA UBL 2.1 XML Generator
 * Generates ZATCA-compliant invoice XML as per the e-invoicing requirements
 * Supports: Standard (B2B clearance) and Simplified (B2C reporting)
 * Payment means: UN/ECE 4461 codes (10=Cash, 30=BankTransfer, 42=BankAccount, 48=Card)
 * Tax categories: S=Standard(15%), Z=Zero-rated(0%), E=Exempt(0%)
 */

interface LineItem {
  id: number;
  description: string;
  quantity: string;
  unitCode?: string;
  unitPrice: string;
  discountAmount: string;
  taxCategory?: string;
  vatRate: string;
  vatAmount: string;
  subtotal: string;
  total: string;
}

interface Company {
  nameAr: string;
  nameEn?: string | null;
  vatNumber: string;
  crNumber: string;
  street: string;
  buildingNumber: string;
  city: string;
  district?: string | null;
  postalCode: string;
  country: string;
}

interface Customer {
  nameAr: string;
  vatNumber?: string | null;
  crNumber?: string | null;
  street?: string | null;
  buildingNumber?: string | null;
  city?: string | null;
  district?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export interface PrepaymentAdjustment {
  /** BT-1 of the already-issued 386 prepayment invoice (KSA-26). */
  invoiceNumber: string;
  invoiceIssueDate: string;
  invoiceIssueTime: string;
  /** KSA-31 and KSA-32, in the final invoice's currency. */
  taxableAmount: string;
  taxAmount: string;
  /** KSA-33 and KSA-34; historic 5% standard-rated advances are supported. */
  taxCategory: "S" | "Z" | "E" | "O";
  taxPercent: string;
}

export interface InvoiceData {
  invoiceNumber: string;
  invoiceType: string;
  // Optional explicit document UUID (a GUID). When omitted, falls back to the
  // invoice number — preserving the historical real-invoice behaviour. ZATCA
  // requires the submission `uuid` to equal the document's cbc:UUID.
  uuid?: string;
  // Document kind: tax invoice (388), credit note (381), or debit note (383).
  // Defaults to "invoice"; credit/debit notes additionally require a
  // billingReferenceId (the corrected invoice) + an instructionNote (reason).
  documentType?: "invoice" | "credit" | "debit";
  /** Issue a 386 advance invoice rather than a 388 tax invoice. Not for credit/debit notes. */
  prepaymentInvoice?: boolean;
  /** Advances already invoiced as 386, adjusted against this ordinary 388 invoice. */
  prepaymentAdjustments?: PrepaymentAdjustment[];
  billingReferenceId?: string | null;
  instructionNote?: string | null;
  issueDate: string;
  issueTime?: string;
  supplyDate?: string | null;
  currency: string;
  paymentMethod?: string | null;
  subtotal: string;
  discountTotal: string;
  vatTotal: string;
  grandTotal: string;
  notes?: string | null;
  invoiceCounterValue: number;
  previousInvoiceHash: string;
  qrCode: string;
  lineItems: LineItem[];
  company: Company;
  customer?: Customer | null;
}

function xmlEscape(str: string | null | undefined): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getInvoiceTypeCode(
  type: string,
  documentType: "invoice" | "credit" | "debit" = "invoice",
  prepaymentInvoice = false,
): { typeCode: string; subTypeCode: string } {
  // ZATCA InvoiceTypeCode: 388 tax invoice, 386 advance, 381 credit, 383 debit.
  const typeCode = documentType === "credit" ? "381" : documentType === "debit" ? "383" : prepaymentInvoice ? "386" : "388";
  const subTypeCode = type === "simplified" ? "0200000" : "0100000";
  return { typeCode, subTypeCode };
}

/**
 * Resolve ZATCA tax category details
 * S  = Standard rate (15%)
 * Z  = Zero rated goods/services (0%)
 * E  = Exempt from VAT (0%)
 * O  = Outside scope of VAT (0%) — used for special cases
 */
function getTaxCategory(category?: string, vatRate?: string): {
  id: string;
  percent: string;
  exemptionReason?: string;
} {
  switch (category) {
    case "Z":
      return { id: "Z", percent: "0.00" };
    case "E":
      return { id: "E", percent: "0.00", exemptionReason: "Exempt from VAT" };
    case "O":
      return { id: "O", percent: "0.00", exemptionReason: "Not subject to VAT" };
    default:
      return { id: "S", percent: Number(vatRate ?? 15).toFixed(2) };
  }
}

// Validate advance-specific money as integer cents; do not silently round source
// amounts or accept NaN/Infinity/extra fractional digits in a signed document.
function prepaymentCents(value: string, field: string): number {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new Error(`Invalid prepayment ${field}: expected a non-negative amount with at most two decimals`);
  }
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new Error(`Invalid prepayment ${field}: amount out of range`);
  return cents;
}

function prepaymentReference(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) {
    throw new Error(`Invalid prepayment ${field}: reference is required and must be XML-safe`);
  }
  return value;
}

function prepaymentDate(value: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Invalid prepayment invoiceIssueDate");
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new Error("Invalid prepayment invoiceIssueDate");
  }
  return value;
}

function prepaymentTime(value: string): string {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?$/.test(value)) {
    throw new Error("Invalid prepayment invoiceIssueTime");
  }
  return value;
}

function prepaymentPercent(value: string, category: string): number {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new Error("Invalid prepayment taxPercent");
  }
  const rate = Number(value);
  if (category === "S" ? rate !== 5 && rate !== 15 : rate !== 0) {
    throw new Error(`Invalid prepayment taxPercent for category ${category}`);
  }
  return rate;
}

function buildPrepaymentAdjustments(data: InvoiceData): { prepaidCents: number; linesXml: string } {
  const adjustments = data.prepaymentAdjustments;
  if (adjustments === undefined) return { prepaidCents: 0, linesXml: "" };
  if (!Array.isArray(adjustments)) throw new Error("Invalid prepaymentAdjustments: expected an array");
  if (adjustments.length && (data.documentType ?? "invoice") !== "invoice") {
    throw new Error("Prepayment adjustments are only supported on ordinary invoices");
  }
  if (adjustments.length && data.prepaymentInvoice) {
    throw new Error("A 386 prepayment invoice cannot adjust earlier prepayments");
  }
  if (adjustments.length && !["standard", "simplified"].includes(data.invoiceType)) {
    throw new Error("Prepayment adjustments require a standard or simplified invoice");
  }
  if (!adjustments.length) return { prepaidCents: 0, linesXml: "" };
  if (!/^[A-Z]{3}$/.test(data.currency)) throw new Error("Invalid prepayment invoice currency");

  let prepaidCents = 0;
  const linesXml = adjustments.map((adjustment, index) => {
    if (!adjustment || typeof adjustment !== "object") throw new Error("Invalid prepayment adjustment");
    const invoiceNumber = prepaymentReference(adjustment.invoiceNumber, "invoiceNumber");
    const issueDate = prepaymentDate(adjustment.invoiceIssueDate);
    const issueTime = prepaymentTime(adjustment.invoiceIssueTime);
    const category = adjustment.taxCategory;
    if (!["S", "Z", "E", "O"].includes(category)) {
      throw new Error(`Invalid prepayment taxCategory: ${String(category)}`);
    }
    const rate = prepaymentPercent(adjustment.taxPercent, category);
    const taxable = prepaymentCents(adjustment.taxableAmount, "taxableAmount");
    const tax = prepaymentCents(adjustment.taxAmount, "taxAmount");
    if (taxable === 0) throw new Error("Invalid prepayment taxableAmount: must be positive");
    if (tax !== Math.round(taxable * rate / 100)) {
      throw new Error("Invalid prepayment taxAmount: does not match rounded taxableAmount × taxPercent");
    }
    prepaidCents += taxable + tax;
    if (!Number.isSafeInteger(prepaidCents)) throw new Error("Invalid prepayment amount: out of range");
    const currency = xmlEscape(data.currency);
    const amount = (cents: number) => (cents / 100).toFixed(2);
    const percent = rate.toFixed(2);
    return `
     <cac:InvoiceLine>
       <cbc:ID>${data.lineItems.length + index + 1}</cbc:ID>
       <cbc:InvoicedQuantity unitCode="PCE">0.00</cbc:InvoicedQuantity>
       <cbc:LineExtensionAmount currencyID="${currency}">0.00</cbc:LineExtensionAmount>
       <cac:DocumentReference>
         <cbc:ID>${xmlEscape(invoiceNumber)}</cbc:ID>
         <cbc:IssueDate>${issueDate}</cbc:IssueDate>
         <cbc:IssueTime>${issueTime}</cbc:IssueTime>
         <cbc:DocumentTypeCode>386</cbc:DocumentTypeCode>
       </cac:DocumentReference>
       <cac:TaxTotal>
         <cbc:TaxAmount currencyID="${currency}">0.00</cbc:TaxAmount>
         <cbc:RoundingAmount currencyID="${currency}">0.00</cbc:RoundingAmount>
         <cac:TaxSubtotal>
           <cbc:TaxableAmount currencyID="${currency}">${amount(taxable)}</cbc:TaxableAmount>
           <cbc:TaxAmount currencyID="${currency}">${amount(tax)}</cbc:TaxAmount>
           <cac:TaxCategory>
             <cbc:ID>${category}</cbc:ID>
             <cbc:Percent>${percent}</cbc:Percent>
             <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
           </cac:TaxCategory>
         </cac:TaxSubtotal>
       </cac:TaxTotal>
       <cac:Item>
         <cbc:Name>Prepayment adjustment</cbc:Name>
         <cac:ClassifiedTaxCategory>
           <cbc:ID>${category}</cbc:ID>
           <cbc:Percent>${percent}</cbc:Percent>
           <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
         </cac:ClassifiedTaxCategory>
       </cac:Item>
       <cac:Price>
         <cbc:PriceAmount currencyID="${currency}">0.00</cbc:PriceAmount>
       </cac:Price>
     </cac:InvoiceLine>`;
  }).join("");
  return { prepaidCents, linesXml };
}

export function generateZatcaXml(data: InvoiceData): string {
  const documentType = data.documentType ?? "invoice";
  if (data.prepaymentInvoice !== undefined && typeof data.prepaymentInvoice !== "boolean") {
    throw new Error("Invalid prepaymentInvoice: expected a boolean");
  }
  if (data.prepaymentInvoice && (documentType !== "invoice" || !["standard", "simplified"].includes(data.invoiceType))) {
    throw new Error("A 386 prepayment invoice must be an ordinary standard or simplified invoice");
  }
  const { prepaidCents, linesXml: prepaymentLinesXml } = buildPrepaymentAdjustments(data);
  const invoiceGrossCents = prepaidCents ? prepaymentCents(data.grandTotal, "grandTotal") : 0;
  if (prepaidCents > invoiceGrossCents) throw new Error("Prepayment amount exceeds invoice gross total");
  const { typeCode, subTypeCode } = getInvoiceTypeCode(data.invoiceType, documentType, data.prepaymentInvoice);
  const issueTime = data.issueTime ?? new Date().toISOString().split("T")[1]?.split(".")[0] ?? "00:00:00";
  const paymentMeansCode = data.paymentMethod ?? "10";
  const documentUuid = data.uuid ?? data.invoiceNumber;

  // Credit/debit notes must reference the corrected invoice (cac:BillingReference,
  // before cac:AdditionalDocumentReference per the UBL element sequence) and carry
  // a reason. Tax invoices (388) emit neither — keeping their output unchanged.
  const billingReferenceXml = documentType !== "invoice" && data.billingReferenceId ? `
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${xmlEscape(data.billingReferenceId)}</cbc:ID>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>` : "";
  const instructionNoteXml = documentType !== "invoice" ? `
    <cbc:InstructionNote>${xmlEscape(data.instructionNote ?? "تصحيح فاتورة")}</cbc:InstructionNote>` : "";

  // Aggregate tax by category for TaxTotal/TaxSubtotal
  const taxByCategory = new Map<string, { taxable: number; tax: number; rate: number }>();
  for (const item of data.lineItems) {
    const cat = item.taxCategory ?? "S";
    const existing = taxByCategory.get(cat) ?? { taxable: 0, tax: 0, rate: Number(item.vatRate ?? 15) };
    taxByCategory.set(cat, {
      taxable: existing.taxable + Number(item.subtotal),
      tax: existing.tax + Number(item.vatAmount),
      rate: Number(item.vatRate ?? 15),
    });
  }

  const taxSubtotalsXml = Array.from(taxByCategory.entries()).map(([cat, vals]) => {
    const tc = getTaxCategory(cat, String(vals.rate));
    return `
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${data.currency}">${vals.taxable.toFixed(2)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${data.currency}">${vals.tax.toFixed(2)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>${tc.id}</cbc:ID>
        <cbc:Percent>${tc.percent}</cbc:Percent>
        ${tc.exemptionReason ? `<cbc:TaxExemptionReason>${tc.exemptionReason}</cbc:TaxExemptionReason>` : ""}
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`;
  }).join("");

  const lineItemsXml = data.lineItems.map((item, idx) => {
    const taxableAmount = Number(item.subtotal).toFixed(2);
    const tc = getTaxCategory(item.taxCategory, item.vatRate);
    return `
    <cac:InvoiceLine>
      <cbc:ID>${idx + 1}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="${item.unitCode ?? "PCE"}">${Number(item.quantity).toFixed(4)}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${data.currency}">${taxableAmount}</cbc:LineExtensionAmount>
      <cac:TaxTotal>
        <cbc:TaxAmount currencyID="${data.currency}">${Number(item.vatAmount).toFixed(2)}</cbc:TaxAmount>
        <cbc:RoundingAmount currencyID="${data.currency}">${Number(item.total).toFixed(2)}</cbc:RoundingAmount>
      </cac:TaxTotal>
      <cac:Item>
        <cbc:Name>${xmlEscape(item.description)}</cbc:Name>
        <cac:ClassifiedTaxCategory>
          <cbc:ID>${tc.id}</cbc:ID>
          <cbc:Percent>${tc.percent}</cbc:Percent>
          <cac:TaxScheme>
            <cbc:ID>VAT</cbc:ID>
          </cac:TaxScheme>
        </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="${data.currency}">${Number(item.unitPrice).toFixed(2)}</cbc:PriceAmount>
        <cac:AllowanceCharge>
          <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
          <cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason>
          <cbc:Amount currencyID="${data.currency}">${Number(item.discountAmount).toFixed(2)}</cbc:Amount>
        </cac:AllowanceCharge>
      </cac:Price>
    </cac:InvoiceLine>`;
  }).join("");

  // Customer party XML — B2B requires full data, B2C minimal
  const isB2B = data.invoiceType === "standard";
  const customerXml = data.customer ? `
  <cac:AccountingCustomerParty>
    <cac:Party>
      ${data.customer.crNumber ? `
      <cac:PartyIdentification>
        <cbc:ID schemeID="CRN">${xmlEscape(data.customer.crNumber)}</cbc:ID>
      </cac:PartyIdentification>` : ""}
      <cac:PostalAddress>
        <cbc:StreetName>${xmlEscape(data.customer.street ?? "")}</cbc:StreetName>
        <cbc:BuildingNumber>${xmlEscape(data.customer.buildingNumber ?? "")}</cbc:BuildingNumber>
        <cbc:CityName>${xmlEscape(data.customer.city ?? "")}</cbc:CityName>
        <cbc:PostalZone>${xmlEscape(data.customer.postalCode ?? "")}</cbc:PostalZone>
        ${data.customer.district ? `<cbc:CountrySubentity>${xmlEscape(data.customer.district)}</cbc:CountrySubentity>` : ""}
        <cac:Country>
          <cbc:IdentificationCode>${xmlEscape(data.customer.country ?? "SA")}</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      ${data.customer.vatNumber ? `
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${xmlEscape(data.customer.vatNumber)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>` : ""}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${xmlEscape(data.customer.nameAr)}</cbc:RegistrationName>
        ${data.customer.crNumber ? `<cbc:CompanyID>${xmlEscape(data.customer.crNumber)}</cbc:CompanyID>` : ""}
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>` : `
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${isB2B ? "غير محدد" : "عميل أفراد"}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
  xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"
  xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2"
  xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2"
  xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2"
  xmlns:xades="http://uri.etsi.org/01903/v1.3.2#"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#">

  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>
      <ext:ExtensionContent>
        <sig:UBLDocumentSignatures>
          <sac:SignatureInformation>
            <cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>
            <sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:1</sbc:ReferencedSignatureID>
          </sac:SignatureInformation>
        </sig:UBLDocumentSignatures>
      </ext:ExtensionContent>
    </ext:UBLExtension>
  </ext:UBLExtensions>

  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${xmlEscape(data.invoiceNumber)}</cbc:ID>
  <cbc:UUID>${xmlEscape(documentUuid)}</cbc:UUID>
  <cbc:IssueDate>${data.issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${issueTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${subTypeCode}">${typeCode}</cbc:InvoiceTypeCode>
  <cbc:Note languageID="ar">${xmlEscape(data.notes)}</cbc:Note>
  <cbc:DocumentCurrencyCode>${data.currency}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>${data.currency}</cbc:TaxCurrencyCode>
${billingReferenceXml}
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${data.invoiceCounterValue}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${data.previousInvoiceHash}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>QR</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${data.qrCode}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>

  <cac:Signature>
    <cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>
    <cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod>
  </cac:Signature>

  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="CRN">${xmlEscape(data.company.crNumber)}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PostalAddress>
        <cbc:StreetName>${xmlEscape(data.company.street)}</cbc:StreetName>
        <cbc:BuildingNumber>${xmlEscape(data.company.buildingNumber)}</cbc:BuildingNumber>
        <cbc:CityName>${xmlEscape(data.company.city)}</cbc:CityName>
        <cbc:PostalZone>${xmlEscape(data.company.postalCode)}</cbc:PostalZone>
        ${data.company.district ? `<cbc:CountrySubentity>${xmlEscape(data.company.district)}</cbc:CountrySubentity>` : ""}
        <cac:Country>
          <cbc:IdentificationCode>${xmlEscape(data.company.country)}</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${xmlEscape(data.company.vatNumber)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${xmlEscape(data.company.nameAr)}</cbc:RegistrationName>
        <cbc:CompanyID>${xmlEscape(data.company.crNumber)}</cbc:CompanyID>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>

  ${customerXml}

  <cac:Delivery>
    <cbc:ActualDeliveryDate>${data.supplyDate ?? data.issueDate}</cbc:ActualDeliveryDate>
  </cac:Delivery>

  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>${paymentMeansCode}</cbc:PaymentMeansCode>${instructionNoteXml}
  </cac:PaymentMeans>

  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${data.currency}">${Number(data.vatTotal).toFixed(2)}</cbc:TaxAmount>
    ${taxSubtotalsXml}
  </cac:TaxTotal>

  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${data.currency}">${Number(data.subtotal).toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${data.currency}">${(Number(data.subtotal) - Number(data.discountTotal)).toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${data.currency}">${Number(data.grandTotal).toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="${data.currency}">${Number(data.discountTotal).toFixed(2)}</cbc:AllowanceTotalAmount>
    <cbc:PrepaidAmount currencyID="${data.currency}">${prepaidCents ? (prepaidCents / 100).toFixed(2) : "0.00"}</cbc:PrepaidAmount>
    <cbc:PayableAmount currencyID="${data.currency}">${prepaidCents ? ((invoiceGrossCents - prepaidCents) / 100).toFixed(2) : Number(data.grandTotal).toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  ${lineItemsXml}${prepaymentLinesXml}
</Invoice>`;
}

import { createHash } from "crypto";
import { canonicalizeInvoiceForHash } from "./zatca-c14n.js";

/**
 * Reference#1 ("invoiceSignedData") DigestValue.
 *
 * ZATCA recomputes this over the CANONICAL form of the invoice with its three
 * enveloped-signature transforms applied (remove UBLExtensions / cac:Signature /
 * the QR AdditionalDocumentReference), NOT over the raw string. Hashing the raw
 * string is exactly what produced `invalid-invoice-hash` during the compliance
 * test. Pass the EMPTY-QR UBL — the QR node is stripped by the transform anyway,
 * so the hash is stable across QR injection.
 */
export function hashXml(xmlContent: string): string {
  const canonical = canonicalizeInvoiceForHash(xmlContent);
  return createHash("sha256").update(canonical, "utf8").digest("base64");
}
