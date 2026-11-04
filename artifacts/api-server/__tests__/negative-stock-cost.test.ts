import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { nextStockAverageCost } from "../src/lib/stockHelpers.js";
import {
  negativeStockCostAdjustment,
  planNegativeStockCoverage,
  returnCostAdjustmentPerUnit,
  untrackedNegativeStockEstimate,
} from "../src/lib/negativeStockCost.js";

test("a receipt clears a negative balance before setting the remaining WAC", () => {
  assert.equal(nextStockAverageCost(-4, 0, 10, 5), 5);
});

test("a partial receipt keeps the unresolved negative layer cost", () => {
  assert.equal(nextStockAverageCost(-4, 3.25, 2, 8), 3.25);
});

test("positive inventory continues to use weighted-average cost", () => {
  assert.equal(nextStockAverageCost(6, 3, 4, 5), 3.8);
});

test("a receipt exactly clearing the negative balance does not invent stock value", () => {
  assert.equal(nextStockAverageCost(-4, 3.25, 4, 8), 3.25);
});

test("a purchase receipt covers pending layers in FIFO order without over-allocation", () => {
  assert.deepEqual(planNegativeStockCoverage([
    { id: 3, quantity: "2" },
    { id: 8, quantity: "4" },
  ], 3), [
    { layerId: 3, quantity: 2 },
    { layerId: 8, quantity: 1 },
  ]);
});

test("cost settlement and returns preserve the signed per-unit adjustment", () => {
  const totalAdjustment = negativeStockCostAdjustment(4, 7, 5);
  assert.equal(totalAdjustment, 15);
  assert.equal(returnCostAdjustmentPerUnit(totalAdjustment, 10), 1.5);
  assert.equal(negativeStockCostAdjustment(7, 4, 5), -15);
  assert.equal(returnCostAdjustmentPerUnit(15, 0), 0);
});

test("legacy preview separates tracked layers and never estimates negative value", () => {
  assert.deepEqual(untrackedNegativeStockEstimate(-9, 4, 7), {
    negativeQuantity: 9,
    untrackedQuantity: 5,
    estimatedValue: 35,
  });
  assert.deepEqual(untrackedNegativeStockEstimate(-2, 5, 7), {
    negativeQuantity: 2,
    untrackedQuantity: 0,
    estimatedValue: 0,
  });
  assert.deepEqual(untrackedNegativeStockEstimate(-3, 0, -1), {
    negativeQuantity: 3,
    untrackedQuantity: 3,
    estimatedValue: 0,
  });
});

test("legacy preview is company/branch scoped and read-only", async () => {
  const source = await readFile(new URL("../src/routes/sales.ts", import.meta.url), "utf8");
  const start = source.indexOf('"/sales-invoices/negative-stock-cost-preview"');
  const end = source.indexOf('router.get("/sales-invoices"', start);
  assert.ok(start > 0 && end > start);
  const route = source.slice(start, end);
  assert.match(route, /requirePermission\("sales_invoices",\s*"view"\)/);
  assert.match(route, /eq\(stockBalanceTable\.companyId,\s*cid\)/);
  assert.match(route, /branchScopeSpread\(req,\s*warehousesTable\.branchId/);
  assert.match(route, /readOnly:\s*true/);
  assert.doesNotMatch(route, /\.insert\(|\.update\(|\.delete\(/);
});
