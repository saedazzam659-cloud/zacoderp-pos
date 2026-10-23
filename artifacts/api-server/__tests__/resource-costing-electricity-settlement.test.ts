import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  isMachineElectricityAllocation,
  machineElectricityEstimate,
  provisionalResourceReceiptBalance,
  requireSingleMachineElectricityAllocation,
  settleProvisionalResourceCost,
  splitProvisionalResourceSettlement,
  summarizeStageResourceCosts,
} from "../src/lib/resourceCosting.js";

const electricityAllocation = {
  id: 91,
  sourceType: "purchase_invoice",
  sourceRecordId: 72,
  snapshotMeta: {
    includeInManufacturing: true,
    costType: "electricity",
    industrialDriver: "machine_hours",
  },
};

test("machine electricity uses the posted industrial allocation, never a tariff pseudo-source", () => {
  assert.equal(isMachineElectricityAllocation(electricityAllocation), true);
  assert.deepEqual(requireSingleMachineElectricityAllocation([electricityAllocation]), electricityAllocation);
  assert.deepEqual(machineElectricityEstimate(12.5, 2.4, 0.18), {
    kwh: 30,
    amount: 5.4,
  });
});

test("machine electricity rejects ambiguous, excluded, or non-machine-hour utility sources", () => {
  assert.throws(
    () => requireSingleMachineElectricityAllocation([]),
    /فاتورة كهرباء صناعية مرحّلاً واحداً/,
  );
  assert.throws(
    () => requireSingleMachineElectricityAllocation([
      electricityAllocation,
      { ...electricityAllocation, id: 92, sourceRecordId: 73 },
    ]),
    /فاتورة كهرباء صناعية مرحّلاً واحداً/,
  );
  assert.equal(isMachineElectricityAllocation({
    ...electricityAllocation,
    snapshotMeta: { ...electricityAllocation.snapshotMeta, industrialDriver: "labor_hours" },
  }), false);
  assert.equal(isMachineElectricityAllocation({
    ...electricityAllocation,
    snapshotMeta: { ...electricityAllocation.snapshotMeta, includeInManufacturing: false },
  }), false);
  assert.throws(() => machineElectricityEstimate(0, 2, 0.18), /قدرة kW/);
});

test("actual utility settlement clears provisional accrual and capitalizes only the delta", () => {
  assert.equal(provisionalResourceReceiptBalance(5_000, 500), 5_500);
  assert.deepEqual(settleProvisionalResourceCost(550, 500), {
    actualAmount: 550, accruedAmount: 500, deltaAmount: 50,
  });
  assert.deepEqual(settleProvisionalResourceCost(450, 500), {
    actualAmount: 450, accruedAmount: 500, deltaAmount: -50,
  });
  assert.throws(() => settleProvisionalResourceCost(550, -1), /غير صالح/);
});

test("utility delta follows frozen FG and abnormal-waste receipt allocation", () => {
  assert.deepEqual(splitProvisionalResourceSettlement(550, 500, 900, 100), {
    actualAmount: 550, accruedAmount: 500, deltaAmount: 50,
    finishedGoodsDelta: 45, abnormalWasteDelta: 5,
  });
  assert.deepEqual(splitProvisionalResourceSettlement(450, 500, 900, 100), {
    actualAmount: 450, accruedAmount: 500, deltaAmount: -50,
    finishedGoodsDelta: -45, abnormalWasteDelta: -5,
  });
});

test("stage cost summary distinguishes estimates from calculated source costs", () => {
  assert.deepEqual(summarizeStageResourceCosts([
    { amount: "24.50", snapshot: { pendingSourceSettlement: true } },
    { amount: "3.25", snapshot: { pendingUtilitySettlement: true } },
  ]), { status: "pending", amount: 27.75, provisionalEstimate: 27.75 });
  assert.deepEqual(summarizeStageResourceCosts([
    { amount: "18.00", snapshot: { costStatus: "provisional_prior_period_rate" } },
  ]), { status: "review", amount: 18, provisionalEstimate: 18 });
  assert.deepEqual(summarizeStageResourceCosts([
    { amount: "12.00", snapshot: { costStatus: "calculated_from_linked_payroll_source" } },
  ]), { status: "calculated", amount: 12, provisionalEstimate: 0 });
  assert.deepEqual(summarizeStageResourceCosts([]), {
    status: "not_calculated", amount: 0, provisionalEstimate: 0,
  });
});

test("v1 route freezes source-linked kWh evidence and provisional pending utility accrual facts", async () => {
  const source = await readFile(
    new URL("../src/routes/production.ts", import.meta.url),
    "utf8",
  );
  const freezeStart = source.indexOf("async function freezeStageResourceCosts");
  const reconcileStart = source.indexOf("async function reconcileFinalStageDrivers");
  const reconcileEnd = source.indexOf("function productionStatusPermission", reconcileStart);
  assert.ok(freezeStart >= 0 && reconcileStart >= 0 && reconcileEnd > reconcileStart);

  const freeze = source.slice(freezeStart);
  assert.match(freeze, /requireSingleMachineElectricityAllocation/);
  assert.match(freeze, /machineElectricityEstimate\(kw, hours, tariff\)/);
  assert.match(freeze, /pendingUtilitySettlement: electricityAllocation == null/);
  assert.match(freeze, /sourceAllocationId: electricityAllocation\?\.id \?\? null/);
  assert.match(freeze, /provisionalAccrualAccountId: electricityAllocation \? null : order\.overheadAccountId/);
  assert.match(freeze, /provisional_wip_accrual_cleared_by_actual_utility_source/);
  assert.match(freeze, /sourceType: "pending_payroll"/);
  assert.match(freeze, /sourceType: "pending_fixed_asset_depreciation"/);
  assert.match(source, /"pending_machine_electricity"[\s\S]*"pending_payroll"[\s\S]*"pending_fixed_asset_depreciation"/);
  assert.doesNotMatch(freeze, /sourceType: "machine_electricity_tariff"/);

  const reconciliation = source.slice(reconcileStart, reconcileEnd);
  assert.match(reconciliation, /meta\.industrialDriver === "machine_hours"/);
  assert.match(reconciliation, /meta\.costType === "electricity"/);
  assert.match(reconciliation, /resourceHoursByAllocationId\.has\(Number\(allocation\.id\)\)/);
  assert.match(reconciliation, /productionDriverReconciliationsTable/);
  assert.match(reconciliation, /entryType: "production_driver_reconciliation"/);
  assert.match(source, /updates\.actualCost = String\(wipBalance\)/);
});

test("both facades advertise the source-settled v1 capability", async () => {
  const [production, simple] = await Promise.all([
    readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/simple-manufacturing.ts", import.meta.url), "utf8"),
  ]);
  for (const route of [production, simple]) {
    assert.match(route, /ready: true/);
    assert.match(route, /electricitySettlement: "posted_industrial_source_driver_reconciliation"/);
    assert.doesNotMatch(route, /RESOURCE_COSTING_ELECTRICITY_SETTLEMENT_UNAVAILABLE/);
  }
});