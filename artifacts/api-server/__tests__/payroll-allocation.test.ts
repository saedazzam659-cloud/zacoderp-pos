import test from "node:test";
import assert from "node:assert/strict";
import { allocationBuckets, allocateComponentBySnapshots, assignmentsOverlap, assignmentRepresentedBySnapshot, assignmentCloseConflictsWithSnapshot } from "../src/lib/payrollAllocation.ts";
import { missingPayrollExpenseMappings, payrollExpenseComponents, payrollExpenseTotals } from "../src/lib/payrollExpenseComponents.ts";
import { calculatePayrollLineTotals } from "../src/lib/payrollCalculations.ts";

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
    projectId: null, costCenterId: null, salaryAllocationPct: 100, provisionAllocationPct: 100,
    periodStart: "2026-02-01", periodEnd: "2026-02-28", days: 28, allocatedAmount: "100.00",
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

test("splits each payroll expense onto its own account and identifies only missing active components", () => {
  const lines = [
    {
      basicSalary: "2500.00",
      absenceDeduction: "100.00",
      housingAllow: "600.00",
      transportAllow: "300.00",
      otherAllow: "100.00",
      overtimeAmount: "75.00",
      bonusAmount: "200.00",
    },
    { basicSalary: "1000.00", housingAllow: "0", transportAllow: "0", otherAllow: "0", overtimeAmount: "0", bonusAmount: "0" },
  ];
  assert.deepEqual(payrollExpenseComponents(lines[0]).map(({ accountKey, amount }) => [accountKey, amount]), [
    ["salariesExpense", 2400],
    ["housingAllowanceExpense", 600],
    ["transportAllowanceExpense", 300],
    ["allowancesExpense", 100],
    ["overtimeExpense", 75],
    ["bonusExpense", 200],
  ]);
  assert.deepEqual(payrollExpenseTotals(lines), {
    salariesExpense: 3400,
    housingAllowanceExpense: 600,
    transportAllowanceExpense: 300,
    allowancesExpense: 100,
    overtimeExpense: 75,
    bonusExpense: 200,
  });
  assert.deepEqual(missingPayrollExpenseMappings(lines, {
    salariesExpense: 1,
    housingAllowanceExpense: null,
    transportAllowanceExpense: 3,
    allowancesExpense: 4,
    overtimeExpense: null,
    bonusExpense: null,
  }).map(({ key, amount }) => [key, amount]), [
    ["housingAllowanceExpense", 600],
    ["overtimeExpense", 75],
    ["bonusExpense", 200],
  ]);
});

test("includes a one-time bonus in gross and net without changing deductions", () => {
  assert.deepEqual(calculatePayrollLineTotals({
    basicSalary: "2000.00",
    housingAllow: "300.00",
    transportAllow: "100.00",
    otherAllow: "50.00",
    overtimeAmount: "75.00",
    bonusAmount: "250.00",
    totalDeductions: "400.00",
  }), { grossSalary: 2775, netSalary: 2375 });
});

test("supports separate salary and provision ratios across multiple cost centers", () => {
  const snapshots = allocationBuckets([
    { projectId: null, costCenterId: 10, effectiveFrom: "2026-02-01", effectiveTo: "2026-02-28", salaryAllocationPct: 60, provisionAllocationPct: 20 },
    { projectId: null, costCenterId: 20, effectiveFrom: "2026-02-01", effectiveTo: "2026-02-28", salaryAllocationPct: 40, provisionAllocationPct: 80 },
  ], "2026-02-01", "2026-02-28", 1000);
  assert.equal(snapshots.length, 2, "daily allocations coalesce to two immutable period snapshots");
  assert.equal(snapshots.reduce((n, row) => n + Number(row.allocatedAmount), 0).toFixed(2), "1000.00");
  const salaryByCenter = new Map<number | null, number>();
  for (const row of allocateComponentBySnapshots(1000, snapshots)) {
    salaryByCenter.set(row.costCenterId, (salaryByCenter.get(row.costCenterId) ?? 0) + row.amount);
  }
  const provisionByCenter = new Map<number | null, number>();
  for (const row of allocateComponentBySnapshots(500, snapshots, "provision")) {
    provisionByCenter.set(row.costCenterId, (provisionByCenter.get(row.costCenterId) ?? 0) + row.amount);
  }
  assert.equal(salaryByCenter.get(10), 600);
  assert.equal(salaryByCenter.get(20), 400);
  assert.equal(provisionByCenter.get(10), 100);
  assert.equal(provisionByCenter.get(20), 400);
});

test("rejects incomplete overlapping allocation percentages", () => {
  assert.throws(() => allocationBuckets([
    { projectId: null, costCenterId: 10, effectiveFrom: "2026-02-01", effectiveTo: "2026-02-28", salaryAllocationPct: 60, provisionAllocationPct: 20 },
    { projectId: null, costCenterId: 20, effectiveFrom: "2026-02-01", effectiveTo: "2026-02-28", salaryAllocationPct: 40, provisionAllocationPct: 70 },
  ], "2026-02-01", "2026-02-28", 1000), /100%/);
});

test("allows a future assignment after frozen payroll, but not inside a frozen period", () => {
  const assignment = { projectId: 1, costCenterId: 9, effectiveFrom: "2026-01-01", effectiveTo: null };
  const snapshots = [{ projectId: 1, costCenterId: 9, periodStart: "2026-08-01", periodEnd: "2026-08-31" }];
  assert.equal(assignmentCloseConflictsWithSnapshot(assignment, "2026-09-01", snapshots), false);
  assert.equal(assignmentCloseConflictsWithSnapshot(assignment, "2026-08-20", snapshots), true);
});