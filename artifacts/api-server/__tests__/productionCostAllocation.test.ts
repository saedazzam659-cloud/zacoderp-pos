import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateToSourceAccounts,
  assertAllocationCapacity,
  calculateFormulaAllocation,
  calculateSourceAllocation,
} from "../src/lib/productionCostAllocation.js";

test("calculates a rounded immutable source share", () => {
  assert.equal(calculateSourceAllocation(1234.56, 12.5), 154.32);
  assert.equal(calculateSourceAllocation(10, 100), 10);
});

test("rejects invalid percentages", () => {
  assert.throws(() => calculateSourceAllocation(100, 0));
  assert.throws(() => calculateSourceAllocation(100, 100.01));
});

test("dedup capacity guard permits exact exhaustion and rejects over-allocation", () => {
  assert.doesNotThrow(() => assertAllocationCapacity(1000, 600, 400));
  assert.throws(() => assertAllocationCapacity(1000, 600, 400.01));
});

test("reclassification split preserves the allocated total after rounding", () => {
  assert.deepEqual(allocateToSourceAccounts(100, [
    { accountId: 10, weight: 2 },
    { accountId: 11, weight: 1 },
  ]), [
    { accountId: 10, amount: 66.67 },
    { accountId: 11, amount: 33.33 },
  ]);
  assert.throws(() => allocateToSourceAccounts(10, []), /source expense accounts/);
});

test("formula allocation derives hours, fixed-rate, and quantity amounts", () => {
  assert.equal(calculateFormulaAllocation("operating_hours", 12_000, 20, 200), 1_200);
  assert.equal(calculateFormulaAllocation("fixed_hourly_rate", 10_000, 8, 37.5), 300);
  assert.equal(calculateFormulaAllocation("production_quantity", 5_000, 25, 1_000), 125);
});

test("final execution hours derive immutable delta targets from one approved source basis", () => {
  // 10,000 source pool / approved company-wide 200 hour denominator.
  // Three completed orders consume 20h, 30h and 10h respectively.
  const targets = [20, 30, 10].map((hours) =>
    calculateFormulaAllocation("operating_hours", 10_000, hours, 200));
  assert.deepEqual(targets, [1_000, 1_500, 500]);
  // Repeating finalization reads the same frozen numerator/denominator and
  // hence has no new delta to journal.
  assert.deepEqual(targets, [1_000, 1_500, 500]);
});

test("formula allocation rejects invalid approved inputs", () => {
  assert.throws(() => calculateFormulaAllocation("operating_hours", 100, 2, 0));
  assert.throws(() => calculateFormulaAllocation("production_quantity", 100, 0, 20));
});