import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateBatchPicks,
  allocateSelectedBatchPicks,
  type BatchRemaining,
} from "../src/lib/stockHelpers.ts";

function batches(): BatchRemaining[] {
  return [
    {
      batchNumber: "A",
      expiryDate: "2026-09-01",
      remaining: 5,
      inboundQty: 5,
      inboundCost: 50,
      earliestInDate: "2026-01-01",
    },
    {
      batchNumber: "B",
      expiryDate: "2026-10-01",
      remaining: 8,
      inboundQty: 8,
      inboundCost: 96,
      earliestInDate: "2026-02-01",
    },
  ];
}

test("repeated lines consume a preloaded batch plan only once", () => {
  const plan = batches();

  const first = allocateBatchPicks(plan, 3);
  const second = allocateBatchPicks(plan, 6);

  assert.deepEqual(first.map((pick) => [pick.batchNumber, pick.takeQty, pick.costPrice]), [
    ["A", 3, 10],
  ]);
  assert.deepEqual(second.map((pick) => [pick.batchNumber, pick.takeQty, pick.costPrice]), [
    ["A", 2, 10],
    ["B", 4, 12],
  ]);
  assert.equal(plan[0].remaining, 0);
  assert.equal(plan[1].remaining, 4);
});

test("aggregate batch plan rejects demand left after prior lines", () => {
  const plan = batches();
  allocateBatchPicks(plan, 9);

  assert.throws(
    () => allocateBatchPicks(plan, 5),
    /مطلوب 5، متاح 4/,
  );
});

test("manual allocation honors the selected lot and mutates the shared plan", () => {
  const plan = batches();

  const picks = allocateSelectedBatchPicks(plan, [
    { batchNumber: "B", expiryDate: "2026-10-01", qty: 6 },
  ], 6);

  assert.deepEqual(picks.map((pick) => [pick.batchNumber, pick.takeQty, pick.costPrice]), [
    ["B", 6, 12],
  ]);
  assert.equal(plan[0].remaining, 5);
  assert.equal(plan[1].remaining, 2);
});

test("manual allocations reject totals or lot quantities that no longer match stock", () => {
  assert.throws(
    () => allocateSelectedBatchPicks(batches(), [
      { batchNumber: "B", expiryDate: "2026-10-01", qty: 3 },
    ], 4),
    /مجموع كميات التشغيلات/,
  );
  assert.throws(
    () => allocateSelectedBatchPicks(batches(), [
      { batchNumber: "B", expiryDate: "2026-10-01", qty: 9 },
    ], 9),
    /لم تعد متاحة/,
  );
});