import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("simple manufacturing reconfiguration keeps the order and replaces only an untouched snapshot", async () => {
  const [facade, production] = await Promise.all([
    readFile(new URL("../src/routes/simple-manufacturing.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8"),
  ]);

  assert.match(facade, /router\.patch\("\/orders\/:id\/wizard", edit,/);
  const start = production.indexOf("export async function productionWizardHandler(");
  const end = production.indexOf('\nrouter.post("/orders/wizard"', start);
  assert.ok(start >= 0 && end > start);
  const handler = production.slice(start, end);

  for (const guard of [
    '["draft", "approved"]',
    "productionCostAllocationsTable",
    "productionStageResourceCostsTable",
    "stockLedgerTable",
    "productionQualityChecksTable",
    "productionWasteRecordsTable",
    "productionDowntimeEventsTable",
  ]) {
    assert.ok(handler.includes(guard), `reconfiguration must check ${guard}`);
  }
  assert.match(handler, /tx\.update\(productionOrdersTable\)\.set\(orderValues\)/);
  assert.match(handler, /tx\.delete\(productionOrderStagesTable\)/);
  assert.match(handler, /tx\.delete\(productionOrderItemsTable\)/);
  assert.match(handler, /eventType: editing \? "wizard_reconfigured" : "wizard_created"/);
});
