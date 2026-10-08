import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultInvoicePercentages,
  invoicePercentagesFromAmounts,
  isInvoicePercentageTotalValid,
} from "../src/lib/cashInvoiceAllocations.js";

test("default allocation percentages follow each invoice's remaining balance", () => {
  const percentages = defaultInvoicePercentages(["1", "2", "3"], (id) => ({
    "1": 70,
    "2": 20,
    "3": 10,
  })[id] ?? 0);

  assert.deepEqual(percentages, {
    "1": "70.000000",
    "2": "20.000000",
    "3": "10.000000",
  });
  assert.equal(isInvoicePercentageTotalValid(["1", "2", "3"], percentages), true);
});

test("reopened allocations hydrate from their saved amounts", () => {
  const percentages = invoicePercentagesFromAmounts(["5", "6"], [
    { invoiceId: 5, amount: "1.00" },
    { invoiceId: 6, amount: "2.00" },
  ]);

  assert.deepEqual(percentages, {
    "5": "33.333333",
    "6": "66.666667",
  });
});

test("small balances retain a proportional nonzero share instead of rounding up to 0.01 percent", () => {
  const percentages = defaultInvoicePercentages(["small", "large"], (id) => id === "small" ? 0.01 : 1000);
  assert.equal(percentages.small, "0.001000");
  assert.equal(isInvoicePercentageTotalValid(["small", "large"], percentages), true);
});

test("invalid edited percentages are rejected unless they total 100 percent", () => {
  assert.equal(isInvoicePercentageTotalValid(["1", "2"], { "1": "40", "2": "60" }), true);
  assert.equal(isInvoicePercentageTotalValid(["1", "2"], { "1": "40", "2": "59.99" }), false);
  assert.equal(isInvoicePercentageTotalValid(["1", "2"], { "1": "0", "2": "100" }), false);
});
