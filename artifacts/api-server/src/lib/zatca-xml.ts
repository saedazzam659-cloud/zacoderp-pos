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

interface InvoiceData {
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
): { typeCode: string; subTypeCode: string } {
  // ZATCA InvoiceTypeCode: 388 tax invoice, 381 credit note, 383 debit note.
  const typeCode = documentType === "credit" ? "381" : documentType === "debit" ? "383" : "388";
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

export function generateZatcaXml(data: InvoiceData): string {
  const documentType = data.documentType ?? "invoice";
  const { typeCode, subTypeCode } = getInvoiceTypeCode(data.invoiceType, documentType);
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
      ${data.customer.vatNumber ? `
      <cac:PartyIdentification>
        <cbc:ID schemeID="TIN">${xmlEscape(data.customer.vatNumber)}</cbc:ID>
      </cac:PartyIdentification>` : ""}
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
    <cbc:PrepaidAmount currencyID="${data.currency}">0.00</cbc:PrepaidAmount>
    <cbc:PayableAmount currencyID="${data.currency}">${Number(data.grandTotal).toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  ${lineItemsXml}
</Invoice>`;
}

import { createHash } from "crypto";

export function hashXml(xmlContent: string): string {
  return createHash("sha256").update(xmlContent, "utf8").digest("base64");
}
