import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  defaultDocumentUnitId,
  documentItemUnitOptions,
  persistedLineIdForSelectedItem,
} from "../src/lib/documentLineUnits.js";

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

test("purchase unit options include the saved base even when only alternate links are stored", () => {
  const baseUnit = { id: 3, nameAr: "قطعة", isActive: true };
  const linkedBox = {
    unitId: 4,
    isBase: false,
    isActive: true,
    referenceUnitId: 3,
    conversionFactor: "12",
    unit: { id: 4, nameAr: "كرتونة", isActive: true },
  };

  assert.equal(defaultDocumentUnitId([linkedBox], 3), "3");
  assert.deepEqual(
    documentItemUnitOptions([linkedBox], 3, [baseUnit, linkedBox.unit], ""),
    [
      {
        unitId: 3,
        conversionFactor: "1",
        isBase: true,
        isActive: true,
        unit: baseUnit,
      },
      linkedBox,
    ],
  );
});

test("purchase line defaults to the item's saved base unit", () => {
  const base = { unitId: 3, isBase: true, isActive: true, referenceUnitId: null };
  const box = { unitId: 4, isBase: false, isActive: true, referenceUnitId: 3 };

  assert.equal(defaultDocumentUnitId([base, box], 3), "3");
});

test("purchase forms never offer an unrelated catalog unit as a new item unit", () => {
  const base = { id: 3, nameAr: "قطعة", isActive: true };
  const unrelated = { id: 8, nameAr: "لتر", isActive: true };

  assert.deepEqual(
    documentItemUnitOptions([], 3, [base, unrelated], ""),
    [{
      unitId: 3,
      conversionFactor: "1",
      isBase: true,
      isActive: true,
      unit: base,
    }],
  );
});

test("an unlinked unit on an old purchase line remains visible but disabled", () => {
  const currentHistoricalUnit = { id: 9, nameAr: "وحدة قديمة", isActive: true };
  const options = documentItemUnitOptions([], 3, [currentHistoricalUnit], 9);

  assert.equal(options.at(-1)?.unitId, 9);
  assert.equal(options.at(-1)?.historicalOnly, true);
});

test("purchase invoice unit selectors use item-specific choices", () => {
  assert.match(purchaseInvoiceForm, /documentItemUnitOptions\(itemUnits, item\?\.unitId, units, l\.unitId\)/);
  assert.doesNotMatch(purchaseInvoiceForm, /catalogUnitsWithHistoricalSelection\(units, l\.unitId\)/);
});
