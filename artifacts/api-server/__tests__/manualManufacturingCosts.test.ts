import test from "node:test";
import assert from "node:assert/strict";
import {
  manualCostEntries,
  manualCostTotal,
  sanitizeManufacturingCostConfiguration,
  validateManufacturingCostConfiguration,
} from "../src/lib/manualManufacturingCosts.js";

test("normalizes manual amounts to cents and keeps non-manual amounts out", () => {
  const config = sanitizeManufacturingCostConfiguration({
    payroll: {
      mode: "manual",
      amount: "12.345",
      description: "  فريق الإنتاج  ",
      counterpartAccountId: "42",
    },
    fixed_asset_depreciation: { mode: "linked", amount: "9.99" },
  });

  assert.equal(config.payroll.amount, 12.35);
  assert.equal(config.payroll.description, "فريق الإنتاج");
  assert.equal(config.payroll.counterpartAccountId, 42);
  assert.equal(config.fixed_asset_depreciation.amount, 9.99);
  assert.deepEqual(manualCostEntries({ costConfiguration: config }), [{
    category: "payroll",
    amount: 12.35,
    description: "فريق الإنتاج",
    counterpartAccountId: 42,
  }]);
  assert.equal(manualCostTotal({ costConfiguration: config }), 12.35);
});

test("permits an explicitly empty configuration for an executable order", () => {
  const config = validateManufacturingCostConfiguration({}, true);
  assert.deepEqual(manualCostEntries({ costConfiguration: config }), []);
  assert.equal(manualCostTotal({ costConfiguration: config }), 0);
});

test("rejects manual/linked mixing and incomplete positive manual costs", () => {
  assert.throws(
    () => validateManufacturingCostConfiguration({
      payroll: { mode: "linked", amount: 1 },
    }, true),
    /المبلغ اليدوي لا يُقبل/,
  );
  assert.throws(
    () => validateManufacturingCostConfiguration({
      payroll: { mode: "manual", amount: 10, description: "أجور" },
    }, true),
    /حساباً مقابلاً/,
  );
});