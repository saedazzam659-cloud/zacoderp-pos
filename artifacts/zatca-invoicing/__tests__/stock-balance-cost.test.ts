import assert from "node:assert/strict";
import { test } from "node:test";

import { summarizeStockBalances } from "../src/lib/stockBalanceCost.ts";

test("item average cost matches total value divided by stock quantity", () => {
  const summary = summarizeStockBalances([{ qty: "29446.00", avgCost: "0.0141" }]);

  assert.equal(summary.quantity, 29446);
  assert.ok(Math.abs(summary.inventoryValue - 415.1886) < 1e-9);
  assert.ok(Math.abs(summary.avgCost - 0.0141) < 1e-12);
});

test("multiple warehouse balances use a quantity-weighted average", () => {
  const summary = summarizeStockBalances([
    { qty: "10", avgCost: "2" },
    { qty: "30", avgCost: "4" },
  ]);

  assert.equal(summary.quantity, 40);
  assert.equal(summary.inventoryValue, 140);
  assert.equal(summary.avgCost, 3.5);
});

test("a single zero-quantity balance keeps its stored average cost", () => {
  const summary = summarizeStockBalances([{ qty: "0", avgCost: "0.0141" }]);

  assert.equal(summary.quantity, 0);
  assert.equal(summary.inventoryValue, 0);
  assert.equal(summary.avgCost, 0.0141);
});
