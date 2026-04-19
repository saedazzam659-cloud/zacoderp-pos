/**
 * ZATCA UBL 2.1 XML Generator
 * Generates ZATCA-compliant invoice XML as per the e-invoicing requirements
 */

interface LineItem {
  id: number;
  description: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
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
  postalCode?: string | null;
  country?: string | null;
}

interface InvoiceData {
  invoiceNumber: string;
  invoiceType: string;
  issueDate: string;
  issueTime?: string;
  supplyDate?: string | null;
  currency: string;
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

function getInvoiceTypeCode(type: string): { typeCode: string; subTypeCode: string } {
  if (type === "simplified") {
    return { typeCode: "388", subTypeCode: "0200000" };
  }
  return { typeCode: "388", subTypeCode: "0100000" };
}

export function generateZatcaXml(data: InvoiceData): string {
  const { typeCode, subTypeCode } = getInvoiceTypeCode(data.invoiceType);
  const issueTime = data.issueTime ?? new Date().toISOString().split("T")[1]?.split(".")[0] ?? "00:00:00";

  const lineItemsXml = data.lineItems.map((item, idx) => {
    const taxableAmount = (Number(item.subtotal)).toFixed(2);
    return `
    <cac:InvoiceLine>
      <cbc:ID>${idx + 1}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="PCE">${Number(item.quantity).toFixed(4)}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${data.currency}">${taxableAmount}</cbc:LineExtensionAmount>
      <cac:TaxTotal>
        <cbc:TaxAmount currencyID="${data.currency}">${Number(item.vatAmount).toFixed(2)}</cbc:TaxAmount>
        <cbc:RoundingAmount currencyID="${data.currency}">${Number(item.total).toFixed(2)}</cbc:RoundingAmount>
      </cac:TaxTotal>
      <cac:Item>
        <cbc:Name>${xmlEscape(item.description)}</cbc:Name>
        <cac:ClassifiedTaxCategory>
          <cbc:ID>S</cbc:ID>
          <cbc:Percent>${Number(item.vatRate).toFixed(2)}</cbc:Percent>
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

  const customerXml = data.customer ? `
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="CRN">${xmlEscape(data.customer.crNumber)}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PostalAddress>
        <cbc:StreetName>${xmlEscape(data.customer.street)}</cbc:StreetName>
        <cbc:BuildingNumber>${xmlEscape(data.customer.buildingNumber)}</cbc:BuildingNumber>
        <cbc:CityName>${xmlEscape(data.customer.city)}</cbc:CityName>
        <cbc:PostalZone>${xmlEscape(data.customer.postalCode)}</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>${xmlEscape(data.customer.country ?? "SA")}</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${xmlEscape(data.customer.vatNumber)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${xmlEscape(data.customer.nameAr)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>` : `
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>غير محدد</cbc:RegistrationName>
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
        <!-- Digital signature placeholder -->
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
  <cbc:UUID>${xmlEscape(data.invoiceNumber)}</cbc:UUID>
  <cbc:IssueDate>${data.issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${issueTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${subTypeCode}">${typeCode}</cbc:InvoiceTypeCode>
  <cbc:Note languageID="ar">${xmlEscape(data.notes)}</cbc:Note>
  <cbc:DocumentCurrencyCode>${data.currency}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>${data.currency}</cbc:TaxCurrencyCode>

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
        <cbc:District>${xmlEscape(data.company.district)}</cbc:District>
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
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>

  ${customerXml}

  <cac:Delivery>
    <cbc:ActualDeliveryDate>${data.supplyDate ?? data.issueDate}</cbc:ActualDeliveryDate>
  </cac:Delivery>

  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${data.currency}">${Number(data.vatTotal).toFixed(2)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${data.currency}">${Number(data.subtotal).toFixed(2)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${data.currency}">${Number(data.vatTotal).toFixed(2)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>15.00</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
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
