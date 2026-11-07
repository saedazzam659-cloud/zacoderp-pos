import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("linked payroll preview allocates by planned labor person-hours", async () => {
  const wizard = await readFile(
    new URL("../src/pages/simple-manufacturing/SimpleWizard.tsx", import.meta.url),
    "utf8",
  );

  const payrollBranchStart = wizard.indexOf('} else if (source.sourceType === "payroll")');
  const payrollBranchEnd = wizard.indexOf(
    '} else if (source.sourceType === "fixed_asset_depreciation"',
    payrollBranchStart,
  );

  assert.ok(payrollBranchStart >= 0 && payrollBranchEnd > payrollBranchStart);
  assert.match(
    wizard.slice(payrollBranchStart, payrollBranchEnd),
    /sourceAmount \* plannedLaborPersonHours \/ denominator/,
  );
  assert.match(
    wizard,
    /source\.sourceType === "payroll"\s*\?\s*plannedLaborPersonHours/,
    "the displayed allocation driver must match the payroll preview formula",
  );
});
