import assert from "node:assert/strict";
import { test } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import { generateZatcaXml, type InvoiceData, type PrepaymentAdjustment } from "../src/lib/zatca-xml.js";

const invoice = (overrides: Partial<InvoiceData> = {}): InvoiceData => ({
  invoiceNumber: "INV-1",
  invoiceType: "standard",
  issueDate: "2025-01-31",
  issueTime: "12:00:00",
  currency: "SAR",
  subtotal: "200.00",
  discountTotal: "0.00",
  vatTotal: "30.00",
  grandTotal: "230.00",
  invoiceCounterValue: 1,
  previousInvoiceHash: "hash",
  qrCode: "",
  company: {
    nameAr: "Supplier", vatNumber: "300000000000003", crNumber: "1234567890",
    street: "Street", buildingNumber: "100", city: "Riyadh",
    postalCode: "12345", country: "SA",
  },
  lineItems: [{
    id: 1, description: "Supply", quantity: "1", unitPrice: "200",
    discountAmount: "0", taxCategory: "S", vatRate: "15",
    subtotal: "200", vatAmount: "30", total: "230",
  }],
  ...overrides,
});

const adjustment = (overrides: Partial<PrepaymentAdjustment> = {}): PrepaymentAdjustment => ({
  invoiceNumber: "ADV&<1>",
  invoiceIssueDate: "2025-01-01",
  invoiceIssueTime: "08:30:45",
  taxableAmount: "86.96",
  taxAmount: "13.04",
  taxCategory: "S",
  taxPercent: "15",
  ...overrides,
});

function parse(xml: string): Element {
  const errors: string[] = [];
  const doc = new DOMParser({ onError: (level, message) => errors.push(`${level}: ${message}`) })
    .parseFromString(xml, "application/xml");
  assert.deepEqual(errors, []);
  return doc.documentElement;
}

function children(node: Element, name: string): Element[] {
  return Array.from(node.childNodes).filter((child): child is Element =>
    child.nodeType === 1 && (child as Element).localName === name);
}

function child(node: Element, name: string): Element {
  const found = children(node, name);
  assert.equal(found.length, 1, `expected one direct ${name} under ${node.localName}`);
  return found[0];
}

function text(node: Element, name: string): string {
  return child(node, name).textContent ?? "";
}

test("absent optional fields preserve existing 388/381/383 invoice bytes and payment flags", () => {
  for (const documentType of ["invoice", "credit", "debit"] as const) {
    const original = invoice({ documentType, invoiceType: "simplified", paymentMethod: "48" });
    const xml = generateZatcaXml(original);
    assert.equal(xml, generateZatcaXml({ ...original, prepaymentInvoice: false, prepaymentAdjustments: [] }));
    assert.match(xml, new RegExp(`<cbc:InvoiceTypeCode name="0200000">${{
      invoice: "388", credit: "381", debit: "383",
    }[documentType]}</cbc:InvoiceTypeCode>`));
    assert.match(xml, /<cbc:PaymentMeansCode>48<\/cbc:PaymentMeansCode>/);
    assert.match(xml, /<cbc:PrepaidAmount currencyID="SAR">0.00<\/cbc:PrepaidAmount>/);
  }
});

test("386 advance works for standard and simplified but never changes normal amounts", () => {
  for (const invoiceType of ["standard", "simplified"]) {
    const root = parse(generateZatcaXml(invoice({ invoiceType, prepaymentInvoice: true })));
    const type = child(root, "InvoiceTypeCode");
    assert.equal(type.textContent, "386");
    assert.equal(type.getAttribute("name"), invoiceType === "standard" ? "0100000" : "0200000");
    assert.equal(text(child(root, "LegalMonetaryTotal"), "PayableAmount"), "230.00");
    assert.equal(text(child(root, "PaymentMeans"), "PaymentMeansCode"), "10");
  }
});

test("BT-113 sums KSA-31/32 across zero-principal lines, without double-counting document VAT", () => {
  for (const invoiceType of ["standard", "simplified"]) {
    const root = parse(generateZatcaXml(invoice({
      invoiceType,
      prepaymentAdjustments: [
        adjustment(),
        adjustment({
          invoiceNumber: "ADV-2", invoiceIssueDate: "2020-06-30",
          taxableAmount: "50", taxAmount: "2.50", taxPercent: "5",
        }),
        adjustment({
          invoiceNumber: "ADV-3", taxableAmount: "40", taxAmount: "0",
          taxCategory: "E", taxPercent: "0",
        }),
      ],
    })));
    assert.equal(child(root, "InvoiceTypeCode").textContent, "388");
    const totals = child(root, "LegalMonetaryTotal");
    assert.equal(text(totals, "PrepaidAmount"), "192.50");
    assert.equal(text(totals, "PayableAmount"), "37.50");
    assert.equal(text(totals, "TaxInclusiveAmount"), "230.00");
    assert.equal(text(child(root, "TaxTotal"), "TaxAmount"), "30.00");
    assert.equal(children(child(root, "TaxTotal"), "TaxSubtotal").length, 1);
    const lines = children(root, "InvoiceLine");
    assert.equal(lines.length, 4);
    for (const [i, line] of lines.slice(1).entries()) {
      assert.equal(text(line, "ID"), String(i + 2));
      assert.equal(text(line, "InvoicedQuantity"), "0.00");
      assert.equal(text(line, "LineExtensionAmount"), "0.00");
      const reference = child(line, "DocumentReference");
      assert.equal(text(reference, "ID"), ["ADV&<1>", "ADV-2", "ADV-3"][i]);
      assert.equal(text(reference, "IssueDate"), i === 1 ? "2020-06-30" : "2025-01-01");
      assert.equal(text(reference, "IssueTime"), "08:30:45");
      assert.equal(text(reference, "DocumentTypeCode"), "386");
      const lineTax = child(line, "TaxTotal");
      assert.equal(text(lineTax, "TaxAmount"), "0.00");
      assert.equal(text(lineTax, "RoundingAmount"), "0.00");
      const subtotal = child(lineTax, "TaxSubtotal");
      assert.equal(text(subtotal, "TaxableAmount"), ["86.96", "50.00", "40.00"][i]);
      assert.equal(text(subtotal, "TaxAmount"), ["13.04", "2.50", "0.00"][i]);
      assert.equal(text(child(subtotal, "TaxCategory"), "ID"), i === 2 ? "E" : "S");
      assert.equal(text(child(subtotal, "TaxCategory"), "Percent"), ["15.00", "5.00", "0.00"][i]);
      assert.equal(text(child(line, "Price"), "PriceAmount"), "0.00");
      assert.equal(text(child(line, "Item"), "Name"), "Prepayment adjustment");
      assert.equal(text(child(child(line, "Item"), "ClassifiedTaxCategory"), "ID"), i === 2 ? "E" : "S");
      for (const name of ["LineExtensionAmount", "TaxAmount", "RoundingAmount", "TaxableAmount", "PriceAmount"]) {
        const elements = Array.from(line.getElementsByTagName("*")).filter(el => el.localName === name);
        for (const el of elements) assert.equal(el.getAttribute("currencyID"), "SAR", name);
      }
    }
  }
});

test("full prepayment permits zero payable and zero-rated advance", () => {
  const root = parse(generateZatcaXml(invoice({
    grandTotal: "100.00",
    prepaymentAdjustments: [adjustment({
      invoiceNumber: "ADV-Z", taxableAmount: "100", taxAmount: "0",
      taxCategory: "Z", taxPercent: "0",
    })],
  })));
  assert.equal(text(child(root, "LegalMonetaryTotal"), "PayableAmount"), "0.00");
  assert.equal(text(child(root, "LegalMonetaryTotal"), "PrepaidAmount"), "100.00");
});

test("rejects incompatible document kinds, invalid references, categories, rates and arithmetic", () => {
  assert.throws(() => generateZatcaXml(invoice({ prepaymentInvoice: "true" as never })), /expected a boolean/);
  assert.throws(() => generateZatcaXml(invoice({ documentType: "credit", prepaymentInvoice: true })), /ordinary standard or simplified/);
  assert.throws(() => generateZatcaXml(invoice({ invoiceType: "other", prepaymentInvoice: true })), /ordinary standard or simplified/);
  assert.throws(() => generateZatcaXml(invoice({ documentType: "debit", prepaymentAdjustments: [adjustment()] })), /ordinary invoices/);
  assert.throws(() => generateZatcaXml(invoice({ prepaymentInvoice: true, prepaymentAdjustments: [adjustment()] })), /cannot adjust/);
  assert.throws(() => generateZatcaXml(invoice({ prepaymentAdjustments: null as never })), /expected an array/);
  const bad = (overrides: Partial<PrepaymentAdjustment>) =>
    generateZatcaXml(invoice({ prepaymentAdjustments: [adjustment(overrides)] }));
  for (const overrides of [
    { invoiceNumber: "" }, { invoiceIssueDate: "" }, { invoiceIssueDate: "2025-02-30" },
    { invoiceIssueTime: "25:00:00" }, { taxableAmount: "-1" },
    { taxableAmount: "86.961" }, { taxableAmount: "0" }, { taxAmount: "-1" },
    { taxAmount: "13.05" }, { taxCategory: "X" as "S" },
    { taxCategory: "E" as const, taxPercent: "15" }, { taxPercent: "20" },
    { taxPercent: "15.001" },
  ]) {
    assert.throws(() => bad(overrides), /prepayment/i, JSON.stringify(overrides));
  }
  assert.throws(() => generateZatcaXml(invoice({
    grandTotal: "99.99", prepaymentAdjustments: [adjustment()],
  })), /exceeds invoice gross/);
});