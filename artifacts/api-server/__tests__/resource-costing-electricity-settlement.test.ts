import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  isMachineElectricityAllocation,
  machineElectricityEstimate,
  requireSingleMachineElectricityAllocation,
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

test("v1 route freezes source-linked kWh evidence and settles it with existing driver reconciliation", async () => {
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
  assert.match(freeze, /accountingTreatment: "estimate_evidence_only/);
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