import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("resource costing remains opt-in, source-backed, and stage-duration driven", async () => {
  const [schema, route, execution] = await Promise.all([
    readFile(new URL("../../../lib/db/src/schema/production.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/stageExecution.ts", import.meta.url), "utf8"),
  ]);

  assert.match(schema, /resourceCostingVersion: integer\("resource_costing_version"\)/);
  assert.match(schema, /productionStageResourceCostsTable/);
  assert.match(schema, /componentDedup: uniqueIndex\("prod_stage_resource_cost_component_source_uniq"\)/);
  assert.match(schema, /actualDurationMinutes: integer\("actual_duration_minutes"\)/);
  assert.match(schema, /electricityTariffPerKwh/);

  assert.match(execution, /resourceMode\?: "labor" \| "machine" \| "both"/);
  assert.match(route, /if \(Number\(order\.resourceCostingVersion\) < 1\) return;/);
  assert.match(route, /hours = num\(stage\.actualDurationMinutes\) \/ 60/);
  assert.match(route, /personHours = hours \* workers/);
  assert.match(route, /actual_duration_hours_times_worker_count/);
  assert.match(route, /actualLaborPersonHours/);
  assert.match(route, /kw \* hours \* tariff/);
  assert.match(route, /fixed_asset_depreciation/);
  assert.match(route, /تكاليف موارد المرحلة مجمّدة/);
  assert.match(route, /productionStageResourceCostsTable\)\.values\(rows\)\s*\.onConflictDoNothing\(\)/);
  assert.match(route, /RESOURCE_COSTING_ELECTRICITY_SETTLEMENT_UNAVAILABLE/);
});