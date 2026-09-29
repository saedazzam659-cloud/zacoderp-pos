import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateExpense, cents, returnedCostShare, type ExpenseRow, type ExpenseLine } from "../src/lib/documentExpenseAllocation.js";
const lines: ExpenseLine[] = [
  { lineId: 1, itemId: 1, description: "A", quantity: 1, value: 3 },
  { lineId: 2, itemId: 2, description: "B", quantity: 2, value: 2 },
  { lineId: 3, itemId: 3, description: "C", quantity: 3, value: 1 },
];
const row: ExpenseRow = { description: "Freight", amount: 10, treatment: "capitalized", allocationMethod: "value", allocations: [], reference: "", costCenterId: null };
test("value and quantity conserve every cent with deterministic remainder", () => {
  assert.deepEqual(allocateExpense(row, lines).map(a => a.amount), [5, 3.33, 1.67]);
  assert.deepEqual(allocateExpense({ ...row, allocationMethod: "quantity" }, lines).map(a => a.amount), [1.67, 3.33, 5]);
  for (let amount = 1; amount < 300; amount++) {
    assert.equal(allocateExpense({ ...row, amount: amount / 100 }, lines).reduce((s, a) => s + cents(a.amount), 0), amount);
  }
});
test("manual must conserve cents and reference distinct current document lines", () => {
  const manual: ExpenseRow = { ...row, allocationMethod: "manual", allocations: [{ lineId: 1, amount: 4 }, { lineId: 2, amount: 6 }] };
  assert.deepEqual(allocateExpense(manual, lines), manual.allocations);
  assert.throws(() => allocateExpense({ ...manual, amount: 9 }, lines));
  assert.throws(() => allocateExpense({ ...manual, allocations: [{ lineId: 99, amount: 10 }] }, lines));
  assert.throws(() => allocateExpense({ ...manual, allocations: [{ lineId: 1, amount: 5 }, { lineId: 1, amount: 5 }] }, lines));
});
test("period costs allocate nothing; invalid amounts and absent bases fail", () => {
  assert.deepEqual(allocateExpense({ ...row, treatment: "period" }, []), []);
  assert.throws(() => allocateExpense(row, []));
  assert.throws(() => allocateExpense(row, lines.map(l => ({ ...l, value: 0 }))));
  for (const amount of [0, -1, NaN, Infinity, 1.001]) assert.throws(() => allocateExpense({ ...row, amount }, lines));
});
test("successive partial returns conserve even a single cent", () => {
  assert.deepEqual([0, 1, 2].map(prior => returnedCostShare(0.01, 3, prior, 1)), [0, 0.01, 0]);
  for (let amount = 1; amount < 300; amount++) {
    assert.equal([0, 1, 2, 3, 4, 5, 6].reduce((sum, prior) => sum + cents(returnedCostShare(amount / 100, 7, prior, 1)), 0), amount);
  }
  assert.throws(() => returnedCostShare(10, 2, 1, 2));
});