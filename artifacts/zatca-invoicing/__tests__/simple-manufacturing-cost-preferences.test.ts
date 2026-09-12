import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SIMPLE_MANUFACTURING_COST_MODES,
  sanitizeSimpleManufacturingCostModes,
  serializeSimpleManufacturingCostModes,
  simpleManufacturingCostPrefsScreen,
} from "../src/pages/simple-manufacturing/costPreferences";

test("cost mode preferences keep only safe category modes", () => {
  const payload = serializeSimpleManufacturingCostModes({
    payroll: "linked",
    fixed_asset_depreciation: "manual",
    prepaid_amortization: "invalid",
    sourceRecordId: 123,
    amount: 999,
    costPeriod: "2026-09",
  });

  assert.deepEqual(payload, {
    version: 1,
    modes: {
      payroll: "linked",
      fixed_asset_depreciation: "manual",
      prepaid_amortization: "none",
    },
  });
  assert.equal("sourceRecordId" in payload.modes, false);
  assert.equal("amount" in payload.modes, false);
  assert.equal("costPeriod" in payload.modes, false);
});

test("invalid or missing durable values fall back to safe defaults", () => {
  assert.deepEqual(
    sanitizeSimpleManufacturingCostModes({
      modes: { payroll: "manual", fixed_asset_depreciation: "unknown" },
    }),
    {
      ...DEFAULT_SIMPLE_MANUFACTURING_COST_MODES,
      payroll: "manual",
    },
  );
});

test("preference screen key is scoped by user and effective tenant", () => {
  assert.equal(
    simpleManufacturingCostPrefsScreen(7, 42),
    "simpleManufacturingWizardCostModes:7:42",
  );
  assert.equal(simpleManufacturingCostPrefsScreen(7, null), null);
});