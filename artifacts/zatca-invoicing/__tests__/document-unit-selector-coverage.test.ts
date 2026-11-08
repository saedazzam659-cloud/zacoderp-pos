import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const linkedUnitForms = [
  "purchasing/PurchaseInvoiceForm.tsx",
  "purchasing/PurchaseOrderForm.tsx",
  "purchasing/PurchaseReturns.tsx",
  "inventory/GoodsReceipts.tsx",
  "inventory/GoodsDeliveries.tsx",
  "sales/SalesReturns.tsx",
  "sales/SalesDocumentForm.tsx",
];

test("document unit selectors use item-owned choices instead of the global catalog", () => {
  for (const path of linkedUnitForms) {
    const source = readFileSync(new URL(`../src/pages/${path}`, import.meta.url), "utf8");
    assert.match(source, /documentItemUnitOptions|salesLineUnitOptions/, path);
    assert.doesNotMatch(source, /catalogUnitsWithHistoricalSelection/, path);
  }
});

test("stock adjustment and transfer default to the item's base, not the first linked row", () => {
  for (const path of ["inventory/StockAdjustment.tsx", "inventory/StockTransfer.tsx"]) {
    const source = readFileSync(new URL(`../src/pages/${path}`, import.meta.url), "utf8");
    assert.match(source, /defaultDocumentUnitId/, path);
    assert.doesNotMatch(source, /ups\[0\]/, path);
  }
});
