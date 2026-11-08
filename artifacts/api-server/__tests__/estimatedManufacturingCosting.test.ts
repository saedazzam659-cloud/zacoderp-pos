import assert from "node:assert/strict";
import test from "node:test";
import { allocateEstimatedManufacturingPool } from "../src/lib/estimatedManufacturingCosting.js";

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
