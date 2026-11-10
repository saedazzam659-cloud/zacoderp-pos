import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateEstimatedManufacturingPool,
  allocateEstimatedManufacturingPoolByActualDriver,
  summarizeEstimatedStageDrivers,
} from "../src/lib/estimatedManufacturingCosting.js";

test("splits a monthly pool by percentage and preserves every cent", () => {
  const result = allocateEstimatedManufacturingPool({
    estimatedAmount: 1000,
    basis: "percentage",
    denominator: null,
    allocations: [
      { orderId: 1, driverValue: 33.3333 },
      { orderId: 2, driverValue: 33.3333 },
      { orderId: 3, driverValue: 33.3334 },
    ],
  });
  assert.deepEqual(result.map((row) => row.allocatedAmount), [333.33, 333.33, 333.34]);
  assert.equal(result.reduce((sum, row) => sum + row.allocatedAmount, 0), 1000);
});

test("splits a measured driver only when order facts equal the manual denominator", () => {
  const result = allocateEstimatedManufacturingPool({
    estimatedAmount: 900,
    basis: "labor_hours",
    denominator: 30,
    allocations: [
      { orderId: 10, driverValue: 10 },
      { orderId: 11, driverValue: 20 },
    ],
  });
  assert.deepEqual(result.map((row) => row.allocatedAmount), [300, 600]);
});

test("manual allocations must reconcile exactly to the pool amount", () => {
  const result = allocateEstimatedManufacturingPool({
    estimatedAmount: 125,
    basis: "manual",
    denominator: null,
    allocations: [
      { orderId: 20, driverValue: 50 },
      { orderId: 21, driverValue: 75 },
    ],
  });
  assert.deepEqual(result.map((row) => row.allocatedAmount), [50, 75]);
  assert.throws(() => allocateEstimatedManufacturingPool({
    estimatedAmount: 125,
    basis: "manual",
    denominator: null,
    allocations: [{ orderId: 20, driverValue: 50 }],
  }), /يجب أن يساوي مجموع التوزيعات اليدوية/);
});

test("rejects percentage pools that do not total 100 percent", () => {
  assert.throws(() => allocateEstimatedManufacturingPool({
    estimatedAmount: 100,
    basis: "percentage",
    denominator: null,
    allocations: [
      { orderId: 30, driverValue: 40 },
      { orderId: 31, driverValue: 59.99 },
    ],
  }), /يجب أن يساوي مجموع نسب الأوامر 100%/);
});

test("applies the frozen hourly rate to actual usage and reports planned-hour variance", () => {
  const result = allocateEstimatedManufacturingPoolByActualDriver({
    estimatedAmount: 12_000,
    denominator: 600,
    allocations: [
      { orderId: 1, plannedDriverValue: 120, actualDriverValue: 150 },
      { orderId: 2, plannedDriverValue: 480, actualDriverValue: 450 },
    ],
  });

  assert.equal(result.rate, 20);
  assert.deepEqual(result.rows.map((row) => row.appliedAmount), [3_000, 9_000]);
  assert.deepEqual(result.rows.map((row) => row.usageVarianceDriver), [30, -30]);
  assert.deepEqual(result.rows.map((row) => row.usageVarianceAmount), [600, -600]);
  assert.equal(result.appliedAmount, 12_000);
  assert.equal(result.usageVarianceAmount, 0);
});

test("keeps the saved hourly rate when actual use exceeds the denominator", () => {
  const result = allocateEstimatedManufacturingPoolByActualDriver({
    estimatedAmount: 1_000,
    denominator: 100,
    allocations: [{ orderId: 1, plannedDriverValue: 100, actualDriverValue: 120 }],
  });

  assert.equal(result.rate, 10);
  assert.equal(result.appliedAmount, 1_200);
  assert.equal(result.rows[0].appliedAmount, 1_200);
  assert.equal(result.usageVarianceAmount, 200);
});

test("converts shared stage duration into actual labor person-hours by worker count", () => {
  const summaries = summarizeEstimatedStageDrivers("labor_hours", "2026-10", [{
    orderId: 11,
    stageId: 51,
    stageName: "التجميع",
    status: "done",
    resourceMode: "labor",
    actualDurationMinutes: 90,
    expectedDurationMinutes: 60,
    workerCount: 3,
    workerEmployeeIds: [1, 2, 3],
    completedAt: "2026-10-20T12:00:00.000Z",
  }]);
  assert.deepEqual(summaries.get(11), {
    orderId: 11,
    plannedDriverValue: 3,
    actualDriverValue: 4.5,
    stages: [{
      stageId: 51,
      stageName: "التجميع",
      plannedDriverValue: 3,
      actualDriverValue: 4.5,
      actualDurationMinutes: 90,
      workerCount: 3,
    }],
  });
});

test("attributes actual stage hours to the completion month", () => {
  const summaries = summarizeEstimatedStageDrivers("machine_hours", "2026-11", [{
    orderId: 12,
    stageId: 52,
    stageName: "التشغيل",
    status: "done",
    resourceMode: "machine",
    actualDurationMinutes: 120,
    expectedDurationMinutes: 100,
    workerCount: 1,
    workerEmployeeIds: [],
    completedAt: "2026-11-02T08:00:00.000Z",
  }]);
  assert.equal(summaries.get(12)?.actualDriverValue, 2);
  assert.equal(summarizeEstimatedStageDrivers("machine_hours", "2026-10", [{
    orderId: 12,
    stageId: 52,
    stageName: "التشغيل",
    status: "done",
    resourceMode: "machine",
    actualDurationMinutes: 120,
    expectedDurationMinutes: 100,
    workerCount: 1,
    workerEmployeeIds: [],
    completedAt: "2026-11-02T08:00:00.000Z",
  }]).size, 0);
});
