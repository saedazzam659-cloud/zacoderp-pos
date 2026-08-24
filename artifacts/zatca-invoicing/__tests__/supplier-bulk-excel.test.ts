import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSupplierBulkExcelRows,
  SUPPLIER_BULK_EXCEL_HEADERS,
} from "../src/lib/supplierBulkExcel.ts";

test("supplier bulk Excel normalizer drops only completely empty rows", () => {
  const rows = normalizeSupplierBulkExcelRows([
    {},
    { code: "", nameAr: "   " },
    { code: "SUP-1", nameAr: "المورد الأول" },
    null,
    ["not", "a", "row"],
    { nameAr: "المورد الثاني", creditLimit: 0 },
  ]);

  assert.deepEqual(rows, [
    { code: "SUP-1", nameAr: "المورد الأول" },
    { nameAr: "المورد الثاني", creditLimit: 0 },
  ]);
});

test("supplier bulk Excel template keeps the matching and master-data columns", () => {
  assert.deepEqual(SUPPLIER_BULK_EXCEL_HEADERS.slice(0, 6), [
    "id",
    "code",
    "nameAr",
    "nameEn",
    "vatNumber",
    "crNumber",
  ]);
  assert.ok(SUPPLIER_BULK_EXCEL_HEADERS.includes("creditLimit"));
});