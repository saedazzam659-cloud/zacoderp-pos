import assert from "node:assert/strict";
import test from "node:test";
import { nextStockAverageCost } from "../src/lib/stockHelpers.js";
import {
  negativeStockCostAdjustment,
  planNegativeStockCoverage,
  returnCostAdjustmentPerUnit,
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
