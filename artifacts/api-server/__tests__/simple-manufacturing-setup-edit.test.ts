import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("compact BOM setup exposes a permission-gated in-place edit contract", async () => {
  const facade = await readFile(
    new URL("../src/routes/simple-manufacturing.ts", import.meta.url),
    "utf8",
  );
  assert.match(facade, /router\.post\("\/setup\/bom", edit,/);
  const start = facade.indexOf('router.patch("/setup/bom/:id"');
  const end = facade.indexOf('\nrouter.post("/setup/routing"', start);
  assert.ok(start >= 0 && end > start, "compact BOM edit route must be present");
  const editRoute = facade.slice(start, end);

  assert.match(editRoute, /router\.patch\("\/setup\/bom\/:id", edit,/);
  assert.match(editRoute, /normalizeSetupBom\(cid, req\.body\)/);
  assert.match(editRoute, /db\.transaction\(async \(tx\)/);
  assert.match(editRoute, /tx\.update\(bomTemplatesTable\)/);
  assert.match(editRoute, /tx\.delete\(bomTemplateLinesTable\)/);
  assert.match(editRoute, /tx\.insert\(bomTemplateLinesTable\)/);
  assert.doesNotMatch(editRoute, /insert\(bomTemplatesTable\)/, "editing must not create a second BOM header");
  assert.match(editRoute, /validateSetupBranch\(req, cid, req\.body\?\.branchId\)/);
  assert.match(editRoute, /outputQty: String\(normalized\.outputQty\)/);
  assert.match(editRoute, /outputUnitCode: normalized\.actualOutputCode/);
});

test("compact routing setup edits the same routing and rebuilds ordered stages atomically", async () => {
  const facade = await readFile(
    new URL("../src/routes/simple-manufacturing.ts", import.meta.url),
    "utf8",
  );
  assert.match(facade, /router\.post\("\/setup\/routing", edit,/);
  const start = facade.indexOf('router.patch("/setup/routing/:id"');
  const end = facade.indexOf("\nconst sourceCostHandler", start);
  assert.ok(start >= 0 && end > start, "compact routing edit route must be present");
  const editRoute = facade.slice(start, end);

  assert.match(editRoute, /router\.patch\("\/setup\/routing\/:id", edit,/);
  assert.match(editRoute, /normalizeSetupRouting\(cid, req\.body\)/);
  assert.match(editRoute, /tx\.update\(productionRoutingsTable\)/);
  assert.match(editRoute, /tx\.delete\(productionRoutingStagesTable\)/);
  assert.match(editRoute, /tx\.insert\(productionRoutingStagesTable\)/);
  assert.doesNotMatch(editRoute, /insert\(productionRoutingsTable\)/, "editing must not create a second routing header");
  assert.match(editRoute, /sequence: i \+ 1/, "stage order must be derived from submitted array order");
  assert.match(editRoute, /validateSetupBranch\(req, cid, req\.body\?\.branchId\)/);
  assert.match(editRoute, /productItemId: normalized\.productItemId/);
});

test("SimpleSetup opens the existing dialogs for double-click editing and sends stable ids", async () => {
  const [setup, controller] = await Promise.all([
    readFile(
      new URL("../../zatca-invoicing/src/pages/simple-manufacturing/SimpleSetup.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../zatca-invoicing/src/pages/SimpleManufacturing.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(setup, /onDoubleClick=\{\(\) => \{ if \(canEdit\) void openBomForEdit\(b\.id\); \}\}/);
  assert.match(setup, /onDoubleClick=\{\(\) => \{ if \(canEdit\) void openRoutingForEdit\(r\.id\); \}\}/);
  assert.match(setup, /id: editingBomId \?\? undefined/);
  assert.match(setup, /id: editingRoutingId \?\? undefined/);
  assert.match(controller, /setup\/bom\/\$\{Number\(data\.id\)\}/);
  assert.match(controller, /setup\/routing\/\$\{Number\(data\.id\)\}/);
  assert.match(controller, /method: data\.id \? "PATCH" : "POST"/);
});

test("Smart Manufacturing route setup saves machine power on the selected shared resource", async () => {
  const [facade, setup, controller, production] = await Promise.all([
    readFile(new URL("../src/routes/simple-manufacturing.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../../zatca-invoicing/src/pages/simple-manufacturing/SimpleSetup.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../zatca-invoicing/src/pages/SimpleManufacturing.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8"),
  ]);

  assert.match(facade, /router\.post\("\/setup\/machines", create,/);
  assert.match(facade, /router\.patch\("\/setup\/machines\/:id", edit,/);
  assert.match(facade, /electricityEnabled && !\(electricityKw && electricityKw > 0\)/);
  assert.match(facade, /effectiveBranchCondition\(\s*req,\s*productionResourcesTable\.branchId/);
  assert.match(setup, /إضافة آلة وقدرة/);
  assert.match(setup, /قدرة الآلة المحفوظة:/);
  assert.match(setup, /onSaveMachine\(/);
  assert.match(setup, /resourceId: String\(machineId\)/);
  assert.match(controller, /setup\/machines\/\$\{Number\(data\.id\)\}/);
  assert.match(controller, /setup\/machines"/);

  const automaticCopyStart = production.indexOf("// ─── PHASE C: Auto-copy active production routing");
  const automaticCopyEnd = production.indexOf("routingLoaded = rs.length;", automaticCopyStart);
  const automaticCopy = production.slice(automaticCopyStart, automaticCopyEnd);
  assert.match(automaticCopy, /resourceId:\s*s\.resourceId/);
});