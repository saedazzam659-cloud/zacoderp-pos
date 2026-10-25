import assert from "node:assert/strict";
import test from "node:test";
import {
  convertLinkedPurchaseOrderCsv,
  convertLinkedSalesInvoiceCsv,
  isInvoiceHeaderCsv,
  isInvoiceItemsCsv,
  isPurchaseOrderHeaderCsv,
} from "../src/lib/historicalInvoiceCsvAdapter";

const invoices = [
  "InvoiceNo,ClientNo,Date,CurrencyCode,ClientBusinessName,SummaryTotal,SummaryPaid,SummaryDiscount,PaymentStatus",
  "00001,0007,2026-07-25,SAR,عميل تجريبي,11.50,0,0,Unpaid",
].join("\n");

const items = [
  "no,item,description,unit_price,quantity,subtotal,subtotal_without_tax,tax1_name,tax1_value,tax1_amount,tax2_name,tax2_value,tax2_amount",
  '?00001,"صنف تجريبي","وصف",10,1,11.50,10,VAT,15,1.50," "," ",0',
].join("\n");

test("recognizes and converts linked invoice and item CSV exports", () => {
  assert.equal(isInvoiceHeaderCsv(invoices), true);
  assert.equal(isInvoiceItemsCsv(items), true);
  const converted = convertLinkedSalesInvoiceCsv(invoices, items);
  assert.equal(converted.rows.length, 1);
  assert.equal(converted.rows[0].source_doc_number, "00001");
  assert.equal(converted.rows[0].party_code, "0007");
  assert.equal(converted.rows[0].item_name, "صنف تجريبي");
  assert.equal(converted.rows[0].payment_type, "credit");
  assert.equal(converted.rows[0].price_includes_vat, "false");
  assert.equal(converted.warnings.length, 0);
});

test("rejects unpaired or financially inconsistent rows instead of dropping data", () => {
  assert.throws(
    () => convertLinkedSalesInvoiceCsv(invoices, items.replace("11.50,10,VAT", "9.00,10,VAT")),
    /إجمالي سطور فاتورة المبيعات/,
  );
  assert.throws(
    () => convertLinkedSalesInvoiceCsv(invoices, items.replace("?00001", "?99999")),
    /تعذر ربط الملفين/,
  );
});

test("repairs a legacy item row split inside its quoted description", () => {
  const splitInvoices = [
    "InvoiceNo,ClientNo,Date,CurrencyCode,ClientBusinessName,SummaryTotal,SummaryPaid,SummaryDiscount,PaymentStatus",
    "00002,0007,2026-07-25,SAR,عميل تجريبي,374.98,0,0,Unpaid",
  ].join("\n");
  const splitItems = [
    "no,item,description,unit_price,quantity,subtotal,subtotal_without_tax,tax1_name,tax1_value,tax1_amount,tax2_name,tax2_value,tax2_amount",
    '"00002,""صنف أول"","" "",52.17,2,119.991,104.34,VAT,15.0000,15.651,"" "","" "",0"',
    '"00002,""صنف ثان"",""وصف منقسم"',
    '",73.91,3,254.9895,221.73,VAT,15.0000,33.2595, "","" "",0"',
  ].join("\n");
  const converted = convertLinkedSalesInvoiceCsv(splitInvoices, splitItems);
  assert.equal(converted.rows.length, 2);
  assert.equal(converted.rows[1].item_name, "صنف ثان");
});

test("converts linked purchase-order exports to operational purchase-order rows", () => {
  const purchaseHeaders = [
    "PurchaseOrderNo,SupplierNo,Date,CurrencyCode,SupplierBusinessName,SummaryTotal,SummaryPaid,SummaryDiscount,PaymentStatus",
    "PO-100,0007,2026-08-06,SAR,مورد تجريبي,115.00,115.00,0,Paid",
  ].join("\n");
  const purchaseItems = [
    "no,item,description,unit_price,quantity,subtotal,subtotal_without_tax,tax1_name,tax1_value,tax1_amount,tax2_name,tax2_value,tax2_amount",
    '"PO-100,""صنف مشتريات"",""وصف"",100,1,115,100,VAT,15,15,"" "","" "",0"',
  ].join("\n");

  assert.equal(isPurchaseOrderHeaderCsv(purchaseHeaders), true);
  const converted = convertLinkedPurchaseOrderCsv(purchaseHeaders, purchaseItems);
  assert.equal(converted.rows.length, 1);
  assert.equal(converted.rows[0].source_doc_number, "PO-100");
  assert.equal(converted.rows[0].party_code, "0007");
  assert.equal(converted.rows[0].item_name, "صنف مشتريات");
  assert.equal(converted.rows[0].payment_type, "");
  assert.equal(converted.rows[0].line_total, "115");
  assert.equal(converted.warnings.length, 2);
  assert.match(converted.warnings[0], /أوامر شراء فقط/);
  assert.match(converted.warnings[1], /تم تجاهل حقول PaymentStatus/);
});
