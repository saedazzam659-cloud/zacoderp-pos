import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("simple cost drilldown keeps the shared lifecycle response contract", async () => {
  const [facade, production] = await Promise.all([
    readFile(new URL("../src/routes/simple-manufacturing.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8"),
  ]);

  assert.match(
    facade,
    /router\.get\("\/orders\/:id\/cost-drilldown", view, productionCostDrilldownHandler\)/,
    "the compact facade must use the canonical cost response rather than a placeholder",
  );
  assert.match(
    facade,
    /productionCostDrilldownHandler/,
    "the shared handler must be imported by the compact facade",
  );
  assert.match(
    facade,
    /router\.get\("\/orders\/:id\/issue-preview", view, productionIssuePreviewHandler\)/,
    "the compact lifecycle route must expose the read-only stock preview",
  );

  const start = production.indexOf("export async function productionCostDrilldownHandler(");
  const end = production.indexOf('\nrouter.get("/orders/:id/cost-drilldown"', start);
  assert.ok(start >= 0 && end > start, "canonical cost drilldown handler must be present");
  const handler = production.slice(start, end);

  for (const field of [
    "totals: { standard, actual, variance",
    "trace: {",
    "materials:",
    "labor: { amount:",
    "overhead: { amount:",
    "stageWaste",
    "wasteSummary:",
    "financialCostStatus:",
    "quality:",
  ]) {
    assert.match(handler, new RegExp(field.replace(/[{}]/g, "\\$&")));
  }
  assert.doesNotMatch(
    facade,
    /trace:\s*\{\s*allocations,\s*materials:\s*\[\],\s*stages:\s*\[\],\s*waste:/,
    "simple must not return the old partial trace that crashed on trace.labor.amount",
  );
});

test("simple wizard scaling is based on the recipe output quantity", async () => {
  const production = await readFile(
    new URL("../src/routes/production.ts", import.meta.url),
    "utf8",
  );
  const wizardStart = production.indexOf("export async function productionWizardHandler(");
  const wizardEnd = production.indexOf("\nrouter.post(\"/orders/wizard\"", wizardStart);
  assert.ok(wizardStart >= 0 && wizardEnd > wizardStart);
  const wizard = production.slice(wizardStart, wizardEnd);

  assert.match(wizard, /const recipeOutputQty = num\(tmpl\.outputQty\)/);
  assert.match(wizard, /const scale = plannedQty \/ recipeOutputQty/);
  assert.doesNotMatch(
    wizard,
    /plannedQty \/ Math\.max\(num\(tmpl\.outputQty, 1\)/,
    "invalid output quantities must not be replaced with an arbitrary one-unit fallback",
  );
});