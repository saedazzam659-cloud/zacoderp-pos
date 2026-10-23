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