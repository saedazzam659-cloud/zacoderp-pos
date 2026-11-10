import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("web quotations accept zero-priced services only through the company setting", async () => {
  const source = await readFile(new URL("../src/routes/sales.ts", import.meta.url), "utf8");
  const createStart = source.indexOf('router.post("/sales-quotations"');
  const updateStart = source.indexOf('router.put("/sales-quotations/:id"');
  const statusStart = source.indexOf('router.patch("/sales-quotations/:id/status"');

  assert.notEqual(createStart, -1);
  assert.notEqual(updateStart, -1);
  assert.notEqual(statusStart, -1);
  assert.match(source.slice(createStart, updateStart),
    /enforceServiceZeroPriceSetting\(req, res, cid, lines, "عرض السعر"\)/);
  assert.match(source.slice(updateStart, statusStart),
    /enforceServiceZeroPriceSetting\(req, res, cid, lines, "عرض السعر"\)/);
});

test("zero-priced service sales invoices are rejected at posting, before stock mutation", async () => {
  const source = await readFile(new URL("../src/routes/sales.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function postSalesInvoiceHandler(");
  const end = source.indexOf('router.patch(\n  "/sales-invoices/:id/post"', start);
  const handler = source.slice(start, end);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(handler, /typeById\.get\(Number\(line\.itemId\)\) === "service"/);
  assert.match(handler, /Number\(line\.unitPrice\) === 0/);
  assert.match(handler, /ZERO_PRICE_SERVICE_INVOICE_DRAFT_ONLY/);
});
