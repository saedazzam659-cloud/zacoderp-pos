import assert from "node:assert/strict";
import test from "node:test";
import { clothingVariantItemIds, mapClothingStockRows } from "../src/lib/clothingStockReport.js";

test("selects only variants whose root model has the clothing module tag", () => {
  const ids = clothingVariantItemIds([
    { id: 1, tags: "ملابس وأحذية" },
    { id: 2, parentItemId: 1 },
    { id: 3, tags: "أدوات" },
    { id: 4, parentItemId: 3 },
  ]);

  assert.deepEqual([...ids], [2]);
});

test("maps only variants whose parent is a clothing model and keeps warehouse valuation", () => {
  const rows = mapClothingStockRows(
    [
      { id: 1, code: "SH-1", nameAr: "قميص", tags: "ملابس وأحذية" },
      {
        id: 2,
        code: "SH-1-N-L",
        nameAr: "قميص — كحلي — L",
        barcode: "C001",
        parentItemId: 1,
        variantAttributes: { اللون: "كحلي", المقاس: "L" },
      },
      { id: 3, code: "IT-1", nameAr: "صنف عادي", tags: null },
      { id: 4, code: "IT-1-RED", nameAr: "أحمر", parentItemId: 3 },
    ],
    [
      { itemId: 2, qty: "3", avgCost: "12.50", warehouseId: 8, warehouse: { nameAr: "المستودع الرئيسي" } },
      { itemId: 4, qty: "9", avgCost: "2.00", warehouseId: 8, warehouse: { nameAr: "المستودع الرئيسي" } },
      { itemId: 1, qty: "1", avgCost: "20.00", warehouseId: 8 },
    ],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].modelNameAr, "قميص");
  assert.equal(rows[0].color, "كحلي");
  assert.equal(rows[0].size, "L");
  assert.equal(rows[0].warehouseNameAr, "المستودع الرئيسي");
  assert.equal(rows[0].qty, 3);
  assert.equal(rows[0].inventoryValue, 37.5);
});
