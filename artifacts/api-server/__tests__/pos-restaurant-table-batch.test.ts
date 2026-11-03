import { test } from "node:test";
import assert from "node:assert/strict";
import { generateRestaurantTables } from "../src/lib/posRestaurantTableBatch.ts";

test("generates default-style table labels and skips existing numbers", () => {
  const rows = generateRestaurantTables({
    count: 4,
    startNumber: 1,
    codePrefix: "T",
    namePrefix: "طاولة",
  }, ["T01", "t02", "T04"]);

  assert.deepEqual(rows.map(({ code, nameAr }) => [code, nameAr]), [
    ["T03", "طاولة 3"],
    ["T05", "طاولة 5"],
    ["T06", "طاولة 6"],
    ["T07", "طاولة 7"],
  ]);
});

test("rejects invalid batch sizes and unsafe labels", () => {
  const base = { count: 10, startNumber: 1, codePrefix: "T", namePrefix: "طاولة" };
  assert.throws(() => generateRestaurantTables({ ...base, count: 0 }, []), /بين 1 و100/);
  assert.throws(() => generateRestaurantTables({ ...base, count: 101 }, []), /بين 1 و100/);
  assert.throws(() => generateRestaurantTables({ ...base, codePrefix: "T 1" }, []), /بادئة الرمز/);
});
