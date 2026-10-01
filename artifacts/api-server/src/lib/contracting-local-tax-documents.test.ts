import test from "node:test";
import assert from "node:assert/strict";
import {
  buildJordanUblInvoiceXml,
  type TaxInvoiceSnapshot,
} from "./taxInvoiceDocuments.js";

function jordanSnapshot(
  lines: TaxInvoiceSnapshot["lines"],
  totals = { subtotal: "150.00", vatAmount: "21.00", totalAmount: "171.00" },
): TaxInvoiceSnapshot {
  return {
    invoice: {
      id: 7,
      docNumber: "OWNER-7",
      invoiceDate: "2026-10-02",
      postedAt: "2026-10-02T12:00:00.000Z",
      status: "posted",
      paymentType: null,
      currencyCode: "JOD",
      exchangeRate: "1",
      subtotal: totals.subtotal,
      vatAmount: totals.vatAmount,
      discountAmount: "0.00",
      totalAmount: totals.totalAmount,
      priceIncludesVat: false,
    },
    company: {
      country: "JO",
      nameAr: "شركة الاختبار",
      nameEn: "Test Company",
      vatNumber: "123456789",
      crNumber: "CR-7",
      city: "Amman",
      district: null,
      street: "Main Street",
      buildingNumber: "10",
      postalCode: "11111",
      additionalNumber: null,
      phone: null,
    },
    customer: {
      nameAr: "المالك",
      nameEn: "Owner",
      vatNumber: "987654321",
      crNumber: null,
      country: "JO",
      city: "Amman",
      district: null,
      street: "Owner Street",
      buildingNumber: "20",
      postalCode: "22222",
    },
    lines,
  };
}

test("Jordan preview uses explicit provider item, unit, and tax-category mappings", () => {
  const xml = buildJordanUblInvoiceXml(jordanSnapshot([
    {
      itemName: "Concrete works",
      itemCode: "JO-ITEM-1",
      unit: "EA",
      qty: "1",
      unitPrice: "100.00",
      discount: "0",
      discountAmount: "0.00",
      vatRate: "16.00",
      providerMapping: {
        providerItemCode: "JO-ITEM-1",
        providerUnitCode: "MTR",
        providerTaxCategoryCode: "S",
      },
    },
    {
      itemName: "Survey works",
      itemCode: "JO-ITEM-2",
      unit: "EA",
      qty: "1",
      unitPrice: "50.00",
      discount: "0",
      discountAmount: "0.00",
      vatRate: "10.00",
      providerMapping: {
        providerItemCode: "JO-ITEM-2",
        providerUnitCode: "DAY",
        providerTaxCategoryCode: "ZR",
      },
    },
  ]), "123e4567-e89b-12d3-a456-426614174000");

  assert.match(xml, /unitCode="MTR"/);
  assert.match(xml, /unitCode="DAY"/);
  assert.match(xml, /<cbc:ID>JO-ITEM-1<\/cbc:ID>/);
  assert.match(xml, /<cbc:ID>ZR<\/cbc:ID>/);
  assert.match(xml, /<cbc:Percent>10<\/cbc:Percent>/);
});

test("Jordan preview keeps the default 16% constraint when a line has no explicit mapping", () => {
  assert.throws(() => buildJordanUblInvoiceXml(jordanSnapshot([{
    itemName: "Unmapped line",
    itemCode: "ITEM",
    unit: "EA",
    qty: "1",
    unitPrice: "100.00",
    discount: "0",
    discountAmount: "0.00",
    vatRate: "10.00",
  }], { subtotal: "100.00", vatAmount: "10.00", totalAmount: "110.00" })), /16%/);
});