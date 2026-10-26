import assert from "node:assert/strict";
import test from "node:test";
import { parseRagmCloudSalesInvoicePdf, type RagmPdfTextItem } from "./historicalRagmPdfParser.ts";

function sampleItems(): RagmPdfTextItem[] {
  const text = (value: string, x: number, y: number): RagmPdfTextItem => ({
    page: 1, text: value, x, y, width: value.length * 5,
  });
  return [
    text("Invoice No", 307, 586), text("2611840", 418, 586),
    text("Account No", 42, 586), text("1105060293", 152, 586),
    text("Date", 307, 603), text("29.09.2026", 435, 603), text("05:13 PM", 392, 603),
    text("Customer", 45, 603), text("عميل تجريبي", 150, 603),
    text("Item Code", 44, 485), text("ITEM DESCRIPTION", 115, 485),
    text("Unit Price", 266, 485), text("QUANTITY", 305, 485),
    text("AMOUNT", 407, 485), text("Vat", 448, 485),
    text("Vat Amount", 468, 485), text("TOTAL", 522, 485),
    text("232", 57, 469), text("Item A", 100, 463), text("Carton", 232, 463),
    text("200.00", 274, 463), text("15.00", 320, 463), text("0.0", 357, 463),
    text("0.0000", 380, 463), text("3,000.00", 408, 463), text("15%", 447, 463),
    text("450.00", 477, 463), text("3,450.00", 519, 463),
    text("228", 57, 440), text("Item B", 100, 434), text("Carton", 232, 434),
    text("145.00", 274, 434), text("10.00", 320, 434), text("0.0", 357, 434),
    text("0.0000", 380, 434), text("1,450.00", 408, 434), text("15%", 447, 434),
    text("217.50", 477, 434), text("1,667.50", 519, 434),
    text("Subtotal", 407, 400), text("4,450.00", 514, 403),
    text("Discount Amount", 407, 381), text("0.00", 514, 384),
    text("Net VAT Excluded", 339, 362), text("4,450.00", 514, 364),
    text("VAT Amount", 339, 342), text("667.50", 514, 346),
    text("Included VAT Net", 339, 324), text("5,117.50", 511, 327),
    text("﷼سعودي", 240, 326),
  ];
}

test("converts the RAGM Cloud text layout into normalized invoice rows", () => {
  const rows = parseRagmCloudSalesInvoicePdf(sampleItems());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source_doc_number, "2611840");
  assert.equal(rows[0].document_date, "2026-09-29");
  assert.equal(rows[0].party_code, "1105060293");
  assert.equal(rows[0].currency_code, "SAR");
  assert.equal(rows[0].exchange_rate, "1");
  assert.equal(rows[0].line_total, "3000.00");
  assert.equal(rows[0].total_amount, "5117.50");
  assert.equal(rows[1].line_total, "1450.00");
  assert.equal(rows[0].payment_type, "");
});

test("refuses PDFs that do not match the selected RAGM Cloud layout", () => {
  assert.throws(
    () => parseRagmCloudSalesInvoicePdf([{ page: 1, text: "Invoice", x: 0, y: 0, width: 40 }]),
    /لا يطابق قالب/,
  );
});

test("rejects inconsistent printed line and invoice totals", () => {
  const items = sampleItems();
  const total = items.find((item) => item.text === "5,117.50");
  if (total) total.text = "5,100.00";
  assert.throws(
    () => parseRagmCloudSalesInvoicePdf(items),
    /إجماليات السطور لا تتطابق/,
  );
});
