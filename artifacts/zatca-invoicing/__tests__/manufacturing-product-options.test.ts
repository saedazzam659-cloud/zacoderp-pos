import test from "node:test";
import assert from "node:assert/strict";
import { manufacturingProducts } from "../src/pages/simple-manufacturing/productOptions";
import type { Catalog } from "../src/pages/simple-manufacturing/types";

test("configured outputs remain selectable across inventory classifications", () => {
  const catalog = {
    items: [
      { id: 1, nameAr: "تمر", code: "1", itemNature: "raw" },
      { id: 2, nameAr: "معمول بالتمر", code: "2", itemNature: "merchandise" },
      { id: 3, nameAr: "منتج", code: "3", itemNature: "finished" },
      { id: 4, nameAr: "منتج قالب", code: "4", itemNature: "raw" },
    ],
    bomTemplates: [{ productItemId: 2 }],
    routings: [{ productItemId: 2 }],
    templates: [{ configuration: { productItemId: 4 } }, { configuration: { productItemId: 999 } }],
  } as Catalog;
  assert.deepEqual(manufacturingProducts(catalog).map(item => item.id), [2, 3, 4]);
  assert.deepEqual(manufacturingProducts(catalog, "1").map(item => item.id), [1, 2, 3, 4]);
});