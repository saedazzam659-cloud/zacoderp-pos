import assert from "node:assert/strict";
import test from "node:test";
import {
  allocatePendingUtilityAvailableAmount,
  assertPostedCompletedSettlementEntries,
  assertPendingUtilityClaimSnapshot,
  assertPendingUtilityFinishedGoodsFacts,
  pendingUtilityBlocksOrderTransition,
  pendingUtilityLifecycleAttempt,
  pendingUtilitySnapshot,
} from "../src/lib/pendingUtilitySettlement.js";

test("pending utility allocation is deterministic by frozen stage ID and cent-exact", () => {
  const allocations = allocatePendingUtilityAvailableAmount(100.01, [
    { stageResourceCostId: 30, orderId: 3, kwh: 1 },
    { stageResourceCostId: 10, orderId: 1, kwh: 1 },
    { stageResourceCostId: 20, orderId: 2, kwh: 1 },
  ]);
  assert.deepEqual(allocations, [
    { stageResourceCostId: 10, orderId: 1, kwh: 1, allocatedAmount: 33.34 },
    { stageResourceCostId: 20, orderId: 2, kwh: 1, allocatedAmount: 33.34 },
    { stageResourceCostId: 30, orderId: 3, kwh: 1, allocatedAmount: 33.33 },
  ]);
  assert.equal(allocations.reduce((sum, row) => sum + row.allocatedAmount, 0), 100.01);
});

test("pending utility allocation rejects duplicate or invalid frozen stage evidence", () => {
  assert.throws(() => allocatePendingUtilityAvailableAmount(10, [
    { stageResourceCostId: 7, orderId: 1, kwh: 1 },
    { stageResourceCostId: 7, orderId: 2, kwh: 2 },
  ]), /مكررة أو غير صالحة/);
  assert.throws(() => allocatePendingUtilityAvailableAmount(10, [
    { stageResourceCostId: 8, orderId: 1, kwh: 0 },
  ]), /مكررة أو غير صالحة/);
});

test("claim validation detects stale amount/source/stage rows before posting", () => {
  const proposal = {
    sourceRecordId: 71,
    allocations: [
      { stageResourceCostId: 5, orderId: 9, kwh: 2, allocatedAmount: 12.34 },
    ],
  };
  assert.doesNotThrow(() => assertPendingUtilityClaimSnapshot([{
    stageResourceCostId: 5, sourceType: "purchase_invoice", sourceRecordId: 71, allocatedAmount: "12.34",
  }], proposal));
  assert.throws(() => assertPendingUtilityClaimSnapshot([{
    stageResourceCostId: 5, sourceType: "purchase_invoice", sourceRecordId: 71, allocatedAmount: "12.35",
  }], proposal), /لا تطابق اللقطة المجمدة/);
  assert.throws(() => assertPendingUtilityClaimSnapshot([{
    stageResourceCostId: 6, sourceType: "purchase_invoice", sourceRecordId: 71, allocatedAmount: "12.34",
  }], proposal), /لا تطابق اللقطة المجمدة/);
});

test("completed FG destination requires original provenance and all units isolated/on hand", () => {
  const valid = {
    orderNumber: "PRD-1", productItemId: 4, finishedWarehouseId: 8,
    finishedGoodsAccountId: 12, batchNumber: "B-1", producedQty: "5",
    receiptQty: "5", balanceQty: "5",
  };
  assert.doesNotThrow(() => assertPendingUtilityFinishedGoodsFacts(valid));
  assert.throws(() => assertPendingUtilityFinishedGoodsFacts({
    ...valid, hasDownstreamConsumption: true,
  }), /است.?هلكت أو بيعت/);
  assert.throws(() => assertPendingUtilityFinishedGoodsFacts({
    ...valid, balanceQty: "6",
  }), /لا يمكن عزل كامل/);
  assert.throws(() => assertPendingUtilityFinishedGoodsFacts({
    ...valid, receiptQty: undefined,
  }), /غير قابلة للإثبات/);
});

test("only the explicit utility snapshot shape activates the special lifecycle", () => {
  assert.equal(pendingUtilitySnapshot([{
    utilityPendingSettlement: true,
    sourceType: "purchase_invoice",
    sourceRecordId: 71,
    allocations: [],
  }])?.sourceRecordId, 71);
  assert.equal(pendingUtilitySnapshot([{
    sourceType: "purchase_invoice", sourceRecordId: 71, allocations: [],
  }]), null);
});

test("a reversed utility close keeps immutable history and receives a new attempt key", () => {
  const base = "production_pending_utility_close:1:2:2026-08:purchase_invoice:71:9";
  assert.deepEqual(pendingUtilityLifecycleAttempt(base, []), {
    sourceKey: `${base}:attempt:1`, reuseActive: false,
  });
  assert.deepEqual(pendingUtilityLifecycleAttempt(base, [{
    sourceKey: `${base}:attempt:1`, status: "posted",
  }]), {
    sourceKey: `${base}:attempt:1`, reuseActive: true,
  });
  assert.deepEqual(pendingUtilityLifecycleAttempt(base, [{
    sourceKey: `${base}:attempt:1`, status: "reversed",
  }]), {
    sourceKey: `${base}:attempt:2`, reuseActive: false,
  });
});

test("active utility claims block destination-changing order transitions", () => {
  assert.equal(pendingUtilityBlocksOrderTransition("completed"), true);
  assert.equal(pendingUtilityBlocksOrderTransition("cancelled"), true);
  assert.equal(pendingUtilityBlocksOrderTransition("reversed"), true);
  assert.equal(pendingUtilityBlocksOrderTransition("quality_check"), false);
});

test("completed utility settlement rejects draft issue or receipt journals", () => {
  const postedIssue = { entryType: "production_issue", status: "posted" };
  const postedReceipt = { entryType: "production_receipt", status: "posted" };
  assert.doesNotThrow(() => assertPostedCompletedSettlementEntries("PRD-1", postedIssue, postedReceipt));
  assert.throws(() => assertPostedCompletedSettlementEntries(
    "PRD-1", postedIssue, { ...postedReceipt, status: "draft" },
  ), /يجب أن يكون قيدا الصرف والاستلام الأصليان مرحّلين/);
});