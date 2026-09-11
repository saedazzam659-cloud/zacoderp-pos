import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("packaging specifications use versioned approval and test gates", async () => {
  const [route, schema] = await Promise.all([
    readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../lib/db/src/schema/production.ts", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /packagingSpecificationsTable/);
  assert.match(schema, /packagingSpecificationVersionsTable/);
  assert.match(schema, /packagingSpecificationApprovalsTable/);
  assert.match(schema, /packagingSpecificationTestsTable/);
  assert.match(route, /\/packaging\/specifications/);
  assert.match(route, /\/packaging\/versions\/:id\/tests/);
  assert.match(route, /tests\.some\(\(test\) => test\.result !== "pass"\)/);
  assert.match(route, /status:\s*"approved"/);
});

test("packaging tables are created before generic strict schema inspection", async () => {
  const source = await readFile(new URL("../src/lib/ensureSchema.ts", import.meta.url), "utf8");
  for (const table of [
    "packaging_specifications",
    "packaging_specification_versions",
    "packaging_specification_approvals",
    "packaging_specification_tests",
  ]) {
    assert.match(source, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  const ddl = source.indexOf("packaging specification workflow tables");
  const bootstrap = source.indexOf("await ensurePayrollAllocationSchema");
  const inspection = source.indexOf("await ensureColumns");
  assert.ok(ddl >= 0 && ddl < bootstrap);
  assert.ok(bootstrap >= 0 && bootstrap < inspection);
});

test("warranty claims require a complete return attribution and expose repair state", async () => {
  const source = await readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8");
  assert.match(source, /WARRANTY_REPAIR_STATUSES/);
  assert.match(source, /returnAttributions/);
  assert.match(source, /matchingReturnLines/);
  assert.match(source, /currentAttributions/);
  assert.match(source, /row\.productionOrderId !== orderId/);
  assert.match(source, /مرتجع البيع/);
  assert.match(source, /technicianUserId/);
  assert.match(source, /repairNotes/);
});

test("returned operating and financing layers reverse exactly once", async () => {
  const source = await readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8");
  assert.match(source, /summarizeOperatingFinancing\(returnAttributions, 1\)/);
  assert.match(source, /saleLayers\.operating - returnLayers\.operating/);
  assert.match(source, /saleLayers\.financing - returnLayers\.financing/);
});