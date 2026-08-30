import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const purchasingRoute = readFileSync(
  new URL("../src/routes/purchasing.ts", import.meta.url),
  "utf8",
);

function routeSource(startMarker: string, endMarker: string): string {
  const start = purchasingRoute.indexOf(startMarker);
  const end = purchasingRoute.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing route marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing route end marker: ${endMarker}`);
  return purchasingRoute.slice(start, end);
}

test("purchase invoice create skips restored numbers and filters header accounts", () => {
  const source = routeSource(
    'router.post("/purchase-invoices"',
    'router.put("/purchase-invoices/:id"',
  );

  assert.match(source, /allocateInvoiceNumber/);
  assert.match(source, /assertPurchaseWriteReferences\(cid/);
  assert.match(source, /eq\(purchaseInvoicesTable\.companyId, cid\)/);
  assert.match(source, /eq\(purchaseInvoicesTable\.docNumber, fromSeq\)/);
  assert.match(source, /skipped >= 999/);
  assert.match(source, /eq\(accountsTable\.companyId, cid\)/);
  assert.match(source, /inventoryAccountId: validAccount\(inventoryAccountId\)/);
  assert.match(source, /insertPurchaseInvoiceWithSerialRepair/);
  assert.match(source, /purchase invoice create failed/);
  assert.match(source, /purchasingWriteError\(e, "فاتورة الشراء"\)/);
});

test("purchase return create has equivalent restored-data protections", () => {
  const source = routeSource(
    'router.post("/purchase-returns"',
    'router.put("/purchase-returns/:id"',
  );

  assert.match(source, /allocateReturnNumber/);
  assert.match(source, /assertPurchaseWriteReferences\(cid/);
  assert.match(source, /eq\(purchaseReturnsTable\.companyId, cid\)/);
  assert.match(source, /eq\(purchaseReturnsTable\.docNumber, fromSeq\)/);
  assert.match(source, /skipped >= 999/);
  assert.match(source, /eq\(accountsTable\.companyId, cid\)/);
  assert.match(source, /taxAccountId:\s+validReturnAccount\(taxAccountId\)/);
  assert.match(source, /insertPurchaseReturnWithSerialRepair/);
  assert.match(source, /purchase return create failed/);
});

test("purchase order conversion preserves invoice sequence policy without swallowing failures", () => {
  const source = routeSource(
    'router.post("/purchase-orders/:id/convert"',
    'router.delete("/purchase-orders/:id"',
  );

  assert.match(source, /const pType = ord\.paymentType \|\| "credit"/);
  assert.match(source, /nextSequenceForPayment\(cid, "purchase_invoice", pType/);
  assert.match(source, /branchId: ord\.branchId \?\? null/);
  assert.match(source, /docDate:\s+ord\.orderDate \?\? null/);
  assert.match(source, /eq\(purchaseInvoicesTable\.docNumber, invDocNumber\)/);
  assert.match(source, /catch \(seqErr: any\)/);
  assert.match(source, /catch \(seqErr: any\) \{\s*throw Object\.assign/);
  assert.doesNotMatch(source, /catch \(seqErr: any\) \{\s*res\.status/);
  assert.doesNotMatch(source, /catch\s*\{\s*invDocNumber = null/);
  assert.match(source, /insertPurchaseInvoiceWithSerialRepair/);
  assert.match(source, /purchase order conversion failed/);
});

test("purchase order conversion atomically locks and converts one source order", () => {
  const source = routeSource(
    'router.post("/purchase-orders/:id/convert"',
    'router.delete("/purchase-orders/:id"',
  );

  assert.match(source, /db\.transaction\(async \(tx\)/);
  assert.match(source, /FROM purchase_orders[\s\S]*FOR UPDATE/);
  assert.match(source, /assertPurchaseWriteReferences\(cid,[\s\S]*supplierId: ord\.supplierId/);
  assert.match(source, /tx\.insert\(purchaseInvoiceLinesTable\)/);
  assert.match(source, /eq\(purchaseOrdersTable\.status, "confirmed"\)/);
  assert.match(source, /isNull\(purchaseOrdersTable\.convertedInvoiceId\)/);
  assert.ok(
    source.indexOf("tx.insert(purchaseInvoiceLinesTable)") < source.indexOf("tx.update(purchaseOrdersTable)"),
    "lines must be inserted before the order transition in the same transaction",
  );
});

test("purchase validation rejects cross-company business references but leaves header GL healing separate", () => {
  const start = purchasingRoute.indexOf("async function assertPurchaseWriteReferences");
  const end = purchasingRoute.indexOf("// ─── Journal entry helper", start);
  const source = purchasingRoute.slice(start, end);

  for (const tenantTable of [
    "suppliersTable",
    "branchesTable",
    "cashBoxesTable",
    "bankAccountsTable",
    "lettersOfCreditTable",
    "taxesTable",
    "purchaseInvoicesTable",
    "itemsTable",
    "unitsTable",
    "warehousesTable",
    "accountsTable",
  ]) {
    assert.match(source, new RegExp(`${tenantTable}\\.companyId`));
  }
  assert.match(source, /eq\(costCentersTable\.companyId, cid\)/);
  assert.match(source, /status: 400/);
  assert.match(source, /لا يخص الشركة الحالية أو غير موجود/);
  assert.doesNotMatch(source, /inventoryAccountId|taxAccountId|discountAccountId/);
});

test("purchase header inserts lock before repairing only the relevant serial and hide SQL errors", () => {
  assert.match(purchasingRoute, /isPrimaryKeyCollision\(error\)/);
  assert.match(purchasingRoute, /executor\.transaction\(async \(insertTx: any\)/);
  assert.match(purchasingRoute, /LOCK TABLE purchase_invoices IN EXCLUSIVE MODE/);
  assert.match(purchasingRoute, /pg_get_serial_sequence\('purchase_invoices', 'id'\)/);
  assert.match(purchasingRoute, /ALTER SEQUENCE %s OWNED BY purchase_invoices\.id/);
  assert.match(purchasingRoute, /LOCK TABLE purchase_returns IN EXCLUSIVE MODE/);
  assert.match(purchasingRoute, /pg_get_serial_sequence\('purchase_returns', 'id'\)/);
  assert.match(purchasingRoute, /ALTER SEQUENCE %s OWNED BY purchase_returns\.id/);
  assert.doesNotMatch(purchasingRoute, /SELECT setval\(/);
  assert.match(purchasingRoute, /if \(code\) \{[\s\S]*خطأ في قاعدة البيانات/);
  assert.match(purchasingRoute, /safeWriteErrorMessage\(error/);
});