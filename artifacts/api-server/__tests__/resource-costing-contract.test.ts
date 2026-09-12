import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("resource costing is opt-in, source-settled, and stage-duration driven", async () => {
  const [schema, route, execution, resourceCosting] = await Promise.all([
    readFile(new URL("../../../lib/db/src/schema/production.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/stageExecution.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/resourceCosting.ts", import.meta.url), "utf8"),
  ]);

  assert.match(schema, /resourceCostingVersion: integer\("resource_costing_version"\)/);
  assert.match(schema, /productionStageResourceCostsTable/);
  assert.match(schema, /componentDedup: uniqueIndex\("prod_stage_resource_cost_component_source_uniq"\)/);
  assert.match(schema, /actualDurationMinutes: integer\("actual_duration_minutes"\)/);
  assert.match(schema, /electricityTariffPerKwh/);
  assert.match(schema, /fixedAssetId: integer\("fixed_asset_id"\)\.references/);

  assert.match(execution, /resourceMode\?: "labor" \| "machine" \| "both"/);
  assert.match(route, /if \(Number\(order\.resourceCostingVersion\) < 1\) return;/);
  assert.match(route, /hours = num\(stage\.actualDurationMinutes\) \/ 60/);
  assert.match(route, /personHours = hours \* workers/);
  assert.match(route, /actual_duration_hours_times_worker_count/);
  assert.match(route, /actualLaborPersonHours/);
  assert.match(resourceCosting, /kw \* hours/);
  assert.match(resourceCosting, /requireSingleMachineElectricityAllocation/);
  assert.match(route, /pendingUtilitySettlement: electricityAllocation == null/);
  assert.match(route, /electricitySettlement: "posted_industrial_source_driver_reconciliation"/);
  assert.match(route, /fixed_asset_depreciation/);
  assert.match(route, /تكاليف موارد المرحلة مجمّدة/);
  assert.match(route, /productionStageResourceCostsTable\)\.values\(rows\)\s*\.onConflictDoNothing\(\)/);
  // Resource master CRUD must persist the machine accounting relationship,
  // not hide it in a UI-only field or unvalidated JSON metadata.
  assert.match(route, /function resourceElectricityConfig/);
  assert.match(route, /eq\(fixedAssetsTable\.companyId, companyId\)/);
  assert.match(route, /type !== "machine"/);
  assert.match(route, /fixedAssetId: config\.fixedAssetId/);
  assert.match(route, /electricityEnabled: config\.electricityEnabled/);
  assert.match(route, /electricityKw: config\.electricityKw/);
  assert.doesNotMatch(route, /RESOURCE_COSTING_ELECTRICITY_SETTLEMENT_UNAVAILABLE/);
});