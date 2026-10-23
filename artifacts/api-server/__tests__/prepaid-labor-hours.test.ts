import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { calculateFormulaAllocation } from "../src/lib/productionCostAllocation.ts";

test("monthly prepaid cost uses labor-hour share and follows actual hours", () => {
  assert.equal(calculateFormulaAllocation("operating_hours", 1200, 18, 240), 90);
  assert.equal(calculateFormulaAllocation("operating_hours", 1200, 24, 240), 120);
});

test("prepaid amortization labor-hour method is exposed and reconciled from actual labor hours", async () => {
  const [production, adjustments, schema] = await Promise.all([
    readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/adjustments.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/ensureSchema.ts", import.meta.url), "utf8"),
  ]);

  assert.match(production, /manufacturingAllocationMethod, "labor_hours"[\s\S]*?approvedManufacturingHours/);
  assert.match(production, /source\.sourceType === "prepaid_amortization" && method === "labor_hours"/);
  assert.match(production, /industrialDriver: "labor_hours"/);
  assert.match(production, /meta\.industrialDriver === "labor_hours"[\s\S]*?actualLaborPersonHours/);
  assert.match(adjustments, /manufacturingAllocationMethod === "labor_hours"/);
  assert.match(adjustments, /approvedManufacturingHours/);
  assert.match(schema, /approved_manufacturing_hours NUMERIC\(14,4\)/);
});
