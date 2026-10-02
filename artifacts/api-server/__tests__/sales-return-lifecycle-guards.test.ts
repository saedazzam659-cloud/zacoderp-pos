import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("linked sales returns require a posted source invoice when saved", async () => {
  const source = await readFile(new URL("../src/routes/sales.ts", import.meta.url), "utf8");
  const validationStart = source.indexOf("async function validateSalesReturnPayload");
  const postStart = source.indexOf('router.post("/sales-returns"', validationStart);
  const putStart = source.indexOf('router.put("/sales-returns/:id"', postStart);
  assert.ok(validationStart > 0 && postStart > validationStart && putStart > postStart);

  const validation = source.slice(validationStart, postStart);
  const create = source.slice(postStart, putStart);
  const updateEnd = source.indexOf('"/sales-returns/:id/post"', putStart);
  const update = source.slice(putStart, updateEnd);

  assert.match(validation, /readSalesReturnSourceInvoice\(db,\s*ctx\.cid,\s*invId\)/);
  assert.match(validation, /sourceInvoice\.status !== "posted"/);
  assert.match(create, /readSalesReturnSourceInvoice\(tx,\s*cid,\s*Number\(invoiceId\),\s*true\)/);
  assert.ok(
    create.indexOf('readSalesReturnSourceInvoice(tx, cid, Number(invoiceId), true)')
      < create.indexOf("insertTx.insert(salesReturnsTable)"),
    "the source invoice is rechecked under a row lock before inserting the return",
  );
  assert.match(update, /validateSalesReturnPayload\(res,\s*req\.body,\s*\{\s*cid,\s*excludeReturnId:\s*id\s*\}\)/);
});

test("posted linked returns must be unposted before their source invoice", async () => {
  const source = await readFile(new URL("../src/routes/sales.ts", import.meta.url), "utf8");
  const invoiceUnpostStart = source.indexOf('router.patch("/sales-invoices/:id/unpost"');
  const invoiceUnpostEnd = source.indexOf('router.delete("/sales-invoices/:id"', invoiceUnpostStart);
  const returnUnpostStart = source.indexOf('router.patch("/sales-returns/:id/unpost"');
  const returnUnpostEnd = source.indexOf('router.delete("/sales-returns/:id"', returnUnpostStart);
  assert.ok(invoiceUnpostStart > 0 && invoiceUnpostEnd > invoiceUnpostStart);
  assert.ok(returnUnpostStart > 0 && returnUnpostEnd > returnUnpostStart);

  const invoiceUnpost = source.slice(invoiceUnpostStart, invoiceUnpostEnd);
  const returnUnpost = source.slice(returnUnpostStart, returnUnpostEnd);
  assert.match(invoiceUnpost, /eq\(salesReturnsTable\.invoiceId,\s*id\)[\s\S]*?eq\(salesReturnsTable\.status,\s*"posted"\)/);
  assert.match(invoiceUnpost, /فك ترحيل المرتجع أولاً/);
  assert.match(returnUnpost, /sourceInvoice\.status !== "posted"/);
  assert.match(returnUnpost, /status:\s*"draft"/);
  assert.doesNotMatch(returnUnpost, /invoiceId:\s*null/);
});