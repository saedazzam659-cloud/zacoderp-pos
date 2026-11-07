import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { persistedLineIdForSelectedItem } from "../src/lib/documentLineUnits.js";

const purchaseInvoiceForm = readFileSync(
  new URL("../src/pages/purchasing/PurchaseInvoiceForm.tsx", import.meta.url),
  "utf8",
);

test("purchase invoice item selection validates the persisted id against the selected item", () => {
  assert.match(purchaseInvoiceForm, /id: persistedLineIdForSelectedItem\(l, item\.id\)/);
});

test("changing a purchase invoice line to another item drops the old persisted line id", () => {
  const existingServiceLine = { id: 3581, itemId: "18", itemType: "service" };

  assert.equal(persistedLineIdForSelectedItem(existingServiceLine, "27"), undefined);
});

test("reselecting the same purchase invoice item preserves its persisted line id", () => {
  assert.equal(
    persistedLineIdForSelectedItem({ id: 3581, itemId: 18 }, "18"),
    3581,
  );
});

test("new purchase invoice lines do not acquire a persisted id", () => {
  assert.equal(persistedLineIdForSelectedItem({ itemId: "18" }, "18"), undefined);
});
