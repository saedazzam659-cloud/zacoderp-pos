import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const salesDocument = readFileSync(
  new URL("../src/pages/sales/SalesDocumentForm.tsx", import.meta.url),
  "utf8",
);
const customerControl = readFileSync(
  new URL("../src/components/CustomerVatControl.tsx", import.meta.url),
  "utf8",
);
const purchaseOrder = readFileSync(
  new URL("../src/pages/purchasing/PurchaseOrderForm.tsx", import.meta.url),
  "utf8",
);
const supplierControl = readFileSync(
  new URL("../src/components/SupplierVatControl.tsx", import.meta.url),
  "utf8",
);

test("sales orders offer the same quick customer creation as quotations", () => {
  assert.match(salesDocument, /\(isQuotation \|\| isOrder\) && fp\.isVisible\("addCustomerTool"\)/);
  assert.match(salesDocument, /button-open-create-sales-order-customer/);
  assert.match(salesDocument, /hideAddButton=\{isQuotation \|\| isOrder\}/);
  assert.match(customerControl, /if \(cus\?\.id\) onCustomerChange\(String\(cus\.id\)\)/);
});

test("purchase orders can create and select a supplier beside the supplier picker", () => {
  assert.match(purchaseOrder, /button-open-create-purchase-order-supplier/);
  assert.match(purchaseOrder, /onSupplierChange=\{setSupplierId\}/);
  assert.match(purchaseOrder, /hideVatField\s+hideAddButton\s+addDialogOpen=\{quickSupplierDialogOpen\}/);
  assert.match(supplierControl, /addDialogOpen \?\? localOpen/);
  assert.match(supplierControl, /qc\.invalidateQueries\(\{ queryKey: \["suppliers"\] \}\)/);
  assert.match(supplierControl, /if \(sup\?\.id\) onSupplierChange\(String\(sup\.id\)\)/);
});