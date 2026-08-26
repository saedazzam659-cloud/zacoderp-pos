import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";

import {
  buildStockAdjustmentWorkbook,
  normalizeWorkbookNumber,
  parseStockAdjustmentRows,
  STOCK_ADJUSTMENT_HEADERS,
} from "../src/lib/stockAdjustmentWorkbook.ts";

const items = [
  { id: 10, code: "ITEM-10", nameAr: "الصنف الأول", unitId: 1, costPrice: "12.5" },
  { id: 20, code: "ITEM-20", nameAr: "الصنف الثاني", unitId: 1, costPrice: "7" },
];
const units = [{ id: 1, code: "EA", nameAr: "وحدة" }];

test("normalizes Arabic and grouped workbook numbers", () => {
  assert.equal(normalizeWorkbookNumber("١٬٢٣٤٫٥"), 1234.5);
  assert.equal(normalizeWorkbookNumber("1,234.50"), 1234.5);
});

test("template preserves item order and includes stable hidden identifiers", () => {
  const wb = buildStockAdjustmentWorkbook(items, units);
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: "" });
  assert.deepEqual(rows.map(row => row[STOCK_ADJUSTMENT_HEADERS.itemId]), [10, 20]);
  assert.equal(wb.Sheets[wb.SheetNames[0]]["!cols"]?.[0]?.hidden, true);
});

test("parser ignores zero template rows and imports editable non-zero rows", () => {
  const result = parseStockAdjustmentRows([
    {
      [STOCK_ADJUSTMENT_HEADERS.itemId]: 10,
      [STOCK_ADJUSTMENT_HEADERS.itemCode]: "ITEM-10",
      [STOCK_ADJUSTMENT_HEADERS.qty]: 0,
      [STOCK_ADJUSTMENT_HEADERS.costPrice]: 12.5,
    },
    {
      [STOCK_ADJUSTMENT_HEADERS.itemId]: 20,
      [STOCK_ADJUSTMENT_HEADERS.itemCode]: "ITEM-20",
      [STOCK_ADJUSTMENT_HEADERS.unitId]: 1,
      [STOCK_ADJUSTMENT_HEADERS.qty]: "−٣",
      [STOCK_ADJUSTMENT_HEADERS.costPrice]: "٧",
      [STOCK_ADJUSTMENT_HEADERS.notes]: "تالف",
    },
  ], items, units);

  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.lines, [{
    itemId: "20",
    unitId: "1",
    qty: "-3",
    costPrice: "7",
    notes: "تالف",
    conversionFactor: "1",
  }]);
});

test("parser rejects duplicate and unknown items without partial apply", () => {
  const result = parseStockAdjustmentRows([
    { itemCode: "ITEM-10", qty: 2, costPrice: 1 },
    { itemCode: "ITEM-10", qty: 3, costPrice: 1 },
    { itemCode: "MISSING", qty: 1, costPrice: 1 },
  ], items, units);
  assert.deepEqual(result.issues.map(issue => issue.code), ["duplicate_item", "unknown_item"]);
});

test("parser rejects a row whose hidden item id and visible code disagree", () => {
  const result = parseStockAdjustmentRows([{
    itemId: 10,
    itemCode: "ITEM-20",
    qty: 1,
    costPrice: 1,
  }], items, units);
  assert.deepEqual(result.issues.map(issue => issue.code), ["item_identity_mismatch"]);
  assert.deepEqual(result.lines, []);
});