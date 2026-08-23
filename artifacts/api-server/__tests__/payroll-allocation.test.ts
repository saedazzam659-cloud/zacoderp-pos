import test from "node:test";
import assert from "node:assert/strict";
import { allocationBuckets, allocateComponentBySnapshots, assignmentsOverlap, assignmentRepresentedBySnapshot } from "../src/lib/payrollAllocation.ts";

test("allocates calendar days across a mid-month transfer with exact cents", () => {
  const rows = allocationBuckets([
    { projectId: 10, costCenterId: 1, effectiveFrom: "2026-02-01", effectiveTo: "2026-02-14" },
    { projectId: 20, costCenterId: 2, effectiveFrom: "2026-02-15", effectiveTo: null },
  ], "2026-02-01", "2026-02-28", 1000);
  assert.deepEqual(rows.map(r => [r.projectId, r.days, r.allocatedAmount]), [[10, 14, "500.00"], [20, 14, "500.00"]]);
  assert.equal(rows.reduce((sum, r) => sum + Number(r.allocatedAmount), 0), 1000);
});

test("keeps unassigned days and rounding remainder reconciled", () => {
  const rows = allocationBuckets([
    { projectId: 4, costCenterId: null, effectiveFrom: "2026-01-31", effectiveTo: "2026-02-01" },
    { projectId: 5, costCenterId: 9, effectiveFrom: "2026-02-28", effectiveTo: null },
  ], "2026-02-01", "2026-02-28", 100.01);
  assert.deepEqual(rows.map(r => r.days), [1, 26, 1]);
  assert.equal(rows.reduce((sum, r) => sum + Number(r.allocatedAmount), 0).toFixed(2), "100.01");
});

test("handles first-day, last-day, multiple transfers, and no assignment", () => {
  const firstLast = allocationBuckets([
    { projectId: 1, costCenterId: 1, effectiveFrom: "2026-02-01", effectiveTo: "2026-02-01" },
    { projectId: 2, costCenterId: 2, effectiveFrom: "2026-02-28", effectiveTo: null },
  ], "2026-02-01", "2026-02-28", 280);
  assert.deepEqual(firstLast.map(r => [r.projectId, r.days]), [[1, 1], [null, 26], [2, 1]]);
  const transfers = allocationBuckets([
    { projectId: 1, costCenterId: 1, effectiveFrom: "2026-02-01", effectiveTo: "2026-02-09" },
    { projectId: 2, costCenterId: 2, effectiveFrom: "2026-02-10", effectiveTo: "2026-02-19" },
    { projectId: 3, costCenterId: 3, effectiveFrom: "2026-02-20", effectiveTo: null },
  ], "2026-02-01", "2026-02-28", 100);
  assert.equal(transfers.reduce((n, r) => n + Number(r.allocatedAmount), 0).toFixed(2), "100.00");
  assert.deepEqual(allocationBuckets([], "2026-02-01", "2026-02-28", 100), [{
    date: "2026-02-01", projectId: null, costCenterId: null, periodStart: "2026-02-01", periodEnd: "2026-02-28", days: 28, allocatedAmount: "100.00",
  }]);
});

test("detects assignment overlap and protects posted snapshot history", () => {
  assert.equal(assignmentsOverlap(
    { effectiveFrom: "2026-02-01", effectiveTo: "2026-02-10" },
    { effectiveFrom: "2026-02-10", effectiveTo: null },
  ), true);
  assert.equal(assignmentsOverlap(
    { effectiveFrom: "2026-02-01", effectiveTo: "2026-02-09" },
    { effectiveFrom: "2026-02-10", effectiveTo: null },
  ), false);
  assert.equal(assignmentRepresentedBySnapshot(
    { projectId: 1, costCenterId: 9, effectiveFrom: "2026-02-01", effectiveTo: null },
    { projectId: 1, costCenterId: 9, periodStart: "2026-02-01", periodEnd: "2026-02-28", runStatus: "posted" },
  ), true);
});

test("splits salary and allowance components independently without cent drift", () => {
  const snapshots = [{ days: 1, costCenterId: 10 }, { days: 26, costCenterId: null }, { days: 1, costCenterId: 20 }];
  const salary = allocateComponentBySnapshots(100.01, snapshots);
  const allowances = allocateComponentBySnapshots(10.03, snapshots);
  assert.equal(salary.reduce((n, row) => n + row.amount, 0).toFixed(2), "100.01");
  assert.equal(allowances.reduce((n, row) => n + row.amount, 0).toFixed(2), "10.03");
  assert.equal(salary[1].costCenterId, null, "unassigned allocation stays without a cost center");
});