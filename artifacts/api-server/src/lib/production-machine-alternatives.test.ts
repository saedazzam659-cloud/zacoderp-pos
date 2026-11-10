import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMachineResourceIds,
  normalizePrimaryMachineId,
  orderMachineStageSnapshot,
} from "./production-machine-alternatives.js";

test("legacy single-machine routes normalize to one alternative without changing their primary", () => {
  const machineResourceIds = normalizeMachineResourceIds(null, "7");
  assert.deepEqual(machineResourceIds, [7]);
  assert.equal(normalizePrimaryMachineId("7", machineResourceIds), 7);
  assert.deepEqual(orderMachineStageSnapshot({
    resourceId: 7,
    machineSelectionEnabled: false,
  }), {
    machineResourceIds: [7],
    machineSelectionEnabled: false,
    resourceId: 7,
  });
});

test("enabled alternatives are copied to order stages unselected for one-machine execution", () => {
  assert.deepEqual(orderMachineStageSnapshot({
    resourceId: 12,
    machineResourceIds: [12, 15, 15],
    machineSelectionEnabled: true,
  }), {
    machineResourceIds: [12, 15],
    machineSelectionEnabled: true,
    resourceId: null,
  });
});

test("disabled alternatives keep the selected primary machine fixed", () => {
  assert.deepEqual(orderMachineStageSnapshot({
    resourceId: 15,
    machineResourceIds: [12, 15],
    machineSelectionEnabled: false,
  }), {
    machineResourceIds: [12, 15],
    machineSelectionEnabled: false,
    resourceId: 15,
  });
});

test("invalid machine IDs fail closed rather than being silently discarded", () => {
  assert.throws(() => normalizeMachineResourceIds([2, "invalid"]));
});
