import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("sales invoice and return posting stamp immutable line attribution", async () => {
  const source = await readFile(new URL("../src/routes/sales.ts", import.meta.url), "utf8");
  const invoiceStart = source.indexOf("async function postSalesInvoiceHandler");
  const returnStart = source.indexOf('router.patch("/sales-returns/:id/post"');
  assert.ok(invoiceStart > 0 && returnStart > invoiceStart);
  const invoiceHandler = source.slice(invoiceStart, returnStart);
  const returnEnd = source.indexOf('router.patch("/sales-returns/:id/unpost"', returnStart);
  const returnHandler = source.slice(returnStart, returnEnd > returnStart ? returnEnd : undefined);
  assert.match(invoiceHandler, /sourceLineId:\s*op\.sourceLineId/);
  assert.match(invoiceHandler, /writeSalesLineProductionAttributions\(\s*tx,\s*cid,\s*"sales_invoice"/s);
  assert.match(returnHandler, /sourceLineId:\s*line\.id/);
  assert.match(returnHandler, /writeSalesLineProductionAttributions\(\s*tx,\s*cid,\s*"sales_return"/s);
  assert.match(returnHandler, /db\.transaction\(async \(tx\)/);
  assert.match(returnHandler, /await upsertBalance\([\s\S]*?,\s*tx\)/);
  assert.match(returnHandler, /exchangeRate:\s*ret\.exchangeRate/);
  assert.match(returnHandler, /tx\.update\(salesReturnsTable\)[\s\S]*status:\s*"posted"/s);
  assert.doesNotMatch(returnHandler, /await db\.(insert|update|delete)\b/);
  assert.match(source, /snapshotKey:\s*`\$\{documentType\}:\$\{documentId\}:/);
});

test("attribution excludes stale repost snapshots and never silently costs unavailable history", async () => {
  const source = await readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8");
  const reportStart = source.indexOf('router.get("/reports/realized-product-profitability"');
  const reportEnd = source.indexOf("export async function productionOrderDetailHandler", reportStart);
  const report = source.slice(reportStart, reportEnd);
  assert.match(report, /innerJoin\(stockLedgerTable/);
  assert.match(report, /movementLedgerId/);
  assert.match(report, /unavailable_without_complete_immutable_stock_batch_source/);
  assert.match(report, /operatingCost/);
  assert.match(report, /financingCost/);
});

test("sales return no longer references an out-of-scope transaction variable", async () => {
  const source = await readFile(new URL("../src/routes/sales.ts", import.meta.url), "utf8");
  const returnStart = source.indexOf('router.patch("/sales-returns/:id/post"');
  const returnEnd = source.indexOf('router.patch("/sales-returns/:id/unpost"', returnStart);
  const handler = source.slice(returnStart, returnEnd > returnStart ? returnEnd : undefined);
  assert.doesNotMatch(handler, /getCustomerAccountId\([^;]+,\s*db\)/);
  assert.match(handler, /getCustomerAccountId\([^;]+,\s*tx\)/);
});

test("linked return cap counts free quantities and is rechecked under source-invoice lock", async () => {
  const source = await readFile(new URL("../src/routes/sales.ts", import.meta.url), "utf8");
  const validation = source.slice(
    source.indexOf("async function validateSalesReturnPayload"),
    source.indexOf('router.post("/sales-returns"', source.indexOf("async function validateSalesReturnPayload")),
  );
  const posting = source.slice(
    source.indexOf('router.patch("/sales-returns/:id/post"'),
    source.indexOf('router.patch("/sales-returns/:id/unpost"'),
  );
  assert.match(validation, /freeQty/);
  assert.match(validation, /\(Number\(l\.qty \|\| 0\) \+ Number\(l\.freeQty \|\| 0\)\)/);
  assert.match(posting, /salesInvoicesTable[\s\S]*?\.for\("update"\)/);
  assert.match(posting, /postedReturnRows/);
  assert.match(posting, /sourceInvoice[\s\S]*?remainingQty/);
  assert.match(posting, /Never hide a cap\/provenance failure/);
  assert.doesNotMatch(posting, /parts\.push\(\{ takeQty: remaining, costPrice: costUnit/);
});