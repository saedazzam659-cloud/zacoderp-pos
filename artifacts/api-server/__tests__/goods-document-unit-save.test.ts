import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  resolveItemUnitConversion,
  resolveItemUnitConversions,
  UnitConversionError,
} from "../src/lib/unitConversion.js";
import { itemsTable, itemUnitPricesTable, unitsTable } from "@workspace/db";
import { goodsDocumentError } from "../../zatca-invoicing/src/lib/goodsDocumentError.js";

function executorFor(item: any, rows: any[], owned: number[] = []) {
  const results = [[item], rows, owned.map(id => ({ id }))];
  return { select: () => ({ from: () => ({ where: async () => results.shift() }) }) };
}

test("omitted unit resolves the sole owned active unrooted legacy mapping", async () => {
  const resolved = await resolveItemUnitConversion({
    companyId: 1, itemId: 42,
    executor: executorFor({ id: 42, unitId: null }, [{
      unitId: 7, referenceUnitId: null, isBase: false,
      isActive: true, relationFactor: "12", legacyConversionConflict: true,
    }], [7]),
  });
  assert.equal(resolved.unitId, 7);
  assert.equal(resolved.baseUnitId, 7);
  assert.equal(resolved.factor, "1");
});

test("missing configuration and foreign mapping still fail without invented factors", async () => {
  for (const [rows, owned, code] of [
    [[], [], "MISSING_BASE"],
    [[{ unitId: 7, referenceUnitId: null, isActive: true }], [], "UNIT_NOT_FOUND"],
    [[{ unitId: 7, referenceUnitId: null, isActive: false }], [7], "AMBIGUOUS_BASE"],
  ] as const) {
    await assert.rejects(resolveItemUnitConversion({
      companyId: 1, itemId: 42,
      executor: executorFor({ id: 42, unitId: null }, [...rows], [...owned]),
    }), (error: unknown) => error instanceof UnitConversionError && error.code === code);
  }
});

test("purchase-line unit resolution batches shared database reads", async () => {
  let queryCount = 0;
  const executor = {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => {
          queryCount += 1;
          if (table === itemsTable) {
            return [
              { id: 42, companyId: 1, unitId: 7 },
              { id: 43, companyId: 1, unitId: 8 },
            ];
          }
          if (table === itemUnitPricesTable) {
            return [
              { itemId: 42, unitId: 7, referenceUnitId: null, isBase: true, isActive: true, relationFactor: "1" },
              { itemId: 43, unitId: 8, referenceUnitId: null, isBase: true, isActive: true, relationFactor: "1" },
            ];
          }
          if (table === unitsTable) {
            return [
              { id: 7, companyId: 1, code: "EA" },
              { id: 8, companyId: 1, code: "BOX" },
            ];
          }
          throw new Error("Unexpected table in unit-conversion batch");
        },
      }),
    }),
  };

  const resolved = await resolveItemUnitConversions([
    { companyId: 1, itemId: 42, unitId: 7 },
    { companyId: 1, itemId: 43, unitId: 8 },
    { companyId: 1, itemId: 42, unitId: 7 },
  ], executor);

  assert.deepEqual(resolved.map((row) => row.factor), ["1", "1", "1"]);
  assert.equal(queryCount, 3);
});

test("Arabic unit errors identify the item and transport errors never expose SQL", () => {
  const t = () => "حدد الوحدة الأساسية في بيانات الصنف";
  assert.match(goodsDocumentError(new Error(JSON.stringify({
    code: "MISSING_BASE", details: { itemName: "صنف 42" },
  })), t, true), /صنف 42/);
  for (const message of ["Failed to fetch", "insert into goods_receipts", '{"error":"SQL query فشل"}']) {
    assert.equal(goodsDocumentError(new Error(message), t, true), "تعذر إتمام العملية. تحقق من الاتصال وأعد المحاولة.");
  }
});

test("receipt and delivery saves resolve within the same transaction and retain retry identity", () => {
  for (const [route, page, linesTable] of [
    ["goodsReceipts", "GoodsReceipts", "goodsReceiptLinesTable"],
    ["goodsDeliveries", "GoodsDeliveries", "goodsDeliveryLinesTable"],
  ]) {
    const source = readFileSync(new URL(`../src/routes/${route}.ts`, import.meta.url), "utf8");
    const create = source.slice(source.indexOf('router.post("/"'), source.indexOf('router.put("/:id"'));
    assert.match(create, /db\.transaction\(async \(tx\)/);
    assert.ok(create.includes(`insertGoodsDocumentLines(tx, ${linesTable}, mappedLines, lines)`));
    assert.match(create, /lines,\s*\[\],\s*tx,/);
    assert.match(create, /code: e.code, details: e.details/);
    const ui = readFileSync(new URL(`../../zatca-invoicing/src/pages/inventory/${page}.tsx`, import.meta.url), "utf8");
    assert.match(ui, /savedDraftId.current \?\? editingId/);
    assert.ok(ui.indexOf("savedDraftId.current = j.id") < ui.indexOf('/${j.id}/post'));
    assert.ok(ui.indexOf("savedLineIds.get(line._id)") < ui.indexOf('/${j.id}/post'));
    assert.match(ui, /clientLineId: l\._id/);
    assert.match(ui, /if \(saveLock.current\) return/);
  }
});