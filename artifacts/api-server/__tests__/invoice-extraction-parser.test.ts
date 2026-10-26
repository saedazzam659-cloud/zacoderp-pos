import assert from "node:assert/strict";
import test from "node:test";
import { parseInvoiceExtractionRows } from "../src/lib/invoiceExtractionParser.ts";

test("parses normalized invoice rows from plain JSON and preserves extracted strings", () => {
  const rows = parseInvoiceExtractionRows(JSON.stringify({
    rows: [{ source_doc_number: "  INV-1 ", item_code: 23, qty: "2", unknown: "ignored" }],
  }));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_doc_number, "INV-1");
  assert.equal(rows[0].item_code, "23");
  assert.equal(rows[0].qty, "2");
  assert.equal("unknown" in rows[0], false);
});

test("accepts fenced or surrounded JSON returned by the extraction model", () => {
  const rows = parseInvoiceExtractionRows(
    'Result:\n```json\n{"rows":[{"source_doc_number":"INV-2","item_name":"Tea"}]}\n```\nDone.',
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_doc_number, "INV-2");
  assert.equal(rows[0].item_name, "Tea");
});

test("rejects invalid JSON and filters rows without invoice or item identifiers", () => {
  assert.deepEqual(parseInvoiceExtractionRows("not JSON"), []);
  assert.deepEqual(parseInvoiceExtractionRows('{"rows":[{},{"qty":"2"}]}'), []);
});
