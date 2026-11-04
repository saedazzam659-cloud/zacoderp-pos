import assert from "node:assert/strict";
import test from "node:test";
import { nextStockAverageCost } from "../src/lib/stockHelpers.js";

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
