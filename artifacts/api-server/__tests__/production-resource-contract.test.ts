import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { normalizeStageExecutionPayload } from "../src/lib/stageExecution.ts";

test("stage resource contract keeps work center optional and distinct from machine", () => {
  assert.deepEqual(
    normalizeStageExecutionPayload({ workCenterId: null, machineId: "12" }),
    { workCenterId: null, resourceId: 12 },
  );
  assert.deepEqual(
    normalizeStageExecutionPayload({ workCenterId: "4", resourceId: null }),
    { workCenterId: 4, resourceId: null },
  );
});

test("shared execution router exposes the scoped resource setup contract", async () => {
  const source = await readFile(
    new URL("../src/routes/production.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /productionExecutionRouter\.get\("\/orders\/:id\/resource-catalog"/);
  assert.match(source, /productionExecutionRouter\.post\("\/orders\/:id\/setup\/work-centers"/);
  assert.match(source, /productionExecutionRouter\.post\("\/orders\/:id\/setup\/machines"/);
  assert.match(source, /production-resource-fixed-asset/);
  assert.match(source, /pg_advisory_xact_lock/);
  assert.match(source, /fixedAssetsTable\.status, "active"/);
  assert.match(source, /fixedAssetsTable\.nameAr/);
  assert.match(source, /fixedAssetsTable\.code/);
  assert.doesNotMatch(source, /fixedAssetsTable\.purchaseValue[\s\S]*resource-catalog/);

  const catalogStart = source.indexOf('productionExecutionRouter.get("/orders/:id/resource-catalog"');
  const catalogEnd = source.indexOf('productionExecutionRouter.post("/orders/:id/setup/work-centers"', catalogStart);
  const resourceCatalog = source.slice(catalogStart, catalogEnd);
  assert.match(resourceCatalog, /eq\(fixedAssetsTable\.usedInManufacturing,\s*true\)/);
  assert.match(resourceCatalog, /assetId == null \|\| eligibleAssetIds\.has\(assetId\)/);
  assert.match(resourceCatalog, /linkedAssetIdSet\.has\(asset\.id\)/);

  const machineSetupStart = source.indexOf('productionExecutionRouter.post("/orders/:id/setup/machines"');
  const machineSetupEnd = source.indexOf('productionExecutionRouter.get("/orders/:id/stages"', machineSetupStart);
  const machineSetup = source.slice(machineSetupStart, machineSetupEnd);
  assert.match(machineSetup, /eq\(fixedAssetsTable\.usedInManufacturing,\s*true\)/);
});

test("new production orders copy linked machine and labor assignments from active routes", async () => {
  const source = await readFile(
    new URL("../src/routes/production.ts", import.meta.url),
    "utf8",
  );
  const automaticCopy = source.slice(
    source.indexOf("// ─── PHASE C: Auto-copy active production routing"),
    source.indexOf("routingLoaded = rs.length;", source.indexOf("// ─── PHASE C: Auto-copy active production routing")),
  );

  assert.match(automaticCopy, /resourceMode:\s*s\.resourceMode/);
  assert.match(automaticCopy, /resourceId:\s*s\.resourceId/);
  assert.match(automaticCopy, /workerCount:\s*s\.workerCount/);
  assert.match(automaticCopy, /workerEmployeeIds:\s*s\.workerEmployeeIds\s*\?\?\s*\[\]/);
});

test("manufacturing-enabled assets synchronize to one linked machine resource", async () => {
  const helper = await readFile(
    new URL("../src/lib/productionAssetResources.ts", import.meta.url),
    "utf8",
  );
  const assetsRoute = await readFile(
    new URL("../src/routes/fixed-assets.ts", import.meta.url),
    "utf8",
  );
  const simpleRoute = await readFile(
    new URL("../src/routes/simple-manufacturing.ts", import.meta.url),
    "utf8",
  );

  assert.match(helper, /pg_advisory_xact_lock/);
  assert.match(helper, /autoCreatedFromFixedAsset:\s*true/);
  assert.match(helper, /type:\s*"machine"/);
  assert.match(helper, /eq\(fixedAssetsTable\.usedInManufacturing,\s*true\)/);
  assert.match(assetsRoute, /ensureProductionMachineForAsset\(tx,\s*(?:created|updated)\)/);
  assert.match(simpleRoute, /backfillProductionMachinesForAssets\(cid,\s*manufacturingAssets\)/);
});

test("route resource estimates use employee payroll rates and stay read-only", async () => {
  const source = await readFile(
    new URL("../src/routes/simple-manufacturing.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf('router.get("/reports/resource-estimates"');
  const end = source.indexOf("export default router", start);
  const handler = source.slice(start, end);

  assert.ok(start >= 0);
  assert.match(handler, /payrollLinesTable\.employeeId/);
  assert.match(handler, /Number\(pay\.grossSalary\)\s*\/\s*\(\s*30\s*\*\s*Number\(contract\.workingHours\)\s*\)/);
  assert.match(handler, /productionOrderStagesTable\.expectedDurationMinutes/);
  assert.match(handler, /productionOrderStagesTable\.actualDurationMinutes/);
  assert.match(handler, /employeeHourlyRate\(employeeId,\s*actualPeriod\)/);
  assert.match(handler, /actualHours\s*\*\s*actualHourlyTotal/);
  assert.match(handler, /stage\.workerCount\s*===\s*ids\.length/);
  assert.match(handler, /fixed_hourly_rate/);
  assert.match(handler, /approvedOperatingHours/);
  assert.doesNotMatch(handler, /db\.(?:insert|update|delete)|\.insert\(|\.update\(|\.delete\(/);
});