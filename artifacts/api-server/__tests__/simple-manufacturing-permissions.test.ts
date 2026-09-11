import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  canAccessModule,
  companyAllowsModule,
} from "../src/middleware/permissions.ts";
import {
  canPostDoc,
  canUnpostDoc,
} from "../src/lib/postingRights.ts";
import { normalizeCompanyMenuPermissions } from "../src/lib/menuPermissionCatalog.ts";

function user(
  companyMenuPermissions: Record<string, boolean>,
  permissions: Record<string, Record<string, boolean>>,
) {
  return {
    id: 1,
    role: "user",
    companyId: 10,
    companyMenuPermissions,
    permissions,
  };
}

test("simple-only tenants can use the facade but not advanced production", () => {
  const u = user(
    { simple_manufacturing: true, production: false },
    { simple_manufacturing: { view: true, create: true, post: true } },
  );
  assert.equal(companyAllowsModule(u, "simple_manufacturing"), true);
  assert.equal(canAccessModule(u, "simple_manufacturing", "view"), true);
  assert.equal(canAccessModule(u, "simple_manufacturing", "create"), true);
  assert.equal(canAccessModule(u, "production", "view"), false);
});

test("advanced-only and neither tenants do not inherit the facade", () => {
  const advanced = user(
    { production: true, simple_manufacturing: false },
    { production: { view: true, create: true } },
  );
  assert.equal(canAccessModule(advanced, "production", "view"), true);
  assert.equal(canAccessModule(advanced, "simple_manufacturing", "view"), false);

  const neither = user(
    { production: false, simple_manufacturing: false },
    { production: { view: true }, simple_manufacturing: { view: true } },
  );
  assert.equal(canAccessModule(neither, "production", "view"), false);
  assert.equal(canAccessModule(neither, "simple_manufacturing", "view"), false);
});

test("simple action grants remain independent, including explicit unpost denial", () => {
  const u = user(
    { simple_manufacturing: true },
    { simple_manufacturing: { view: true, create: true, post: true, unpost: false } },
  );
  assert.equal(canAccessModule(u, "simple_manufacturing", "view"), true);
  assert.equal(canAccessModule(u, "simple_manufacturing", "create"), true);
  assert.equal(canAccessModule(u, "simple_manufacturing", "delete"), false);
  assert.equal(canAccessModule(u, "simple_manufacturing", "unpost"), false);
});

test("simple posting rights use the facade key and preserve allow-by-default", () => {
  assert.equal(canPostDoc({ role: "user", postingPermissions: { simple_manufacturing: { post: false } } }, "simple_manufacturing"), false);
  assert.equal(canUnpostDoc({ role: "user", postingPermissions: { simple_manufacturing: { unpost: false } } }, "simple_manufacturing"), false);
  assert.equal(canPostDoc({ role: "user", postingPermissions: {} }, "simple_manufacturing"), true);
});

test("normalizing a legacy company menu materializes simple manufacturing OFF", () => {
  assert.deepEqual(
    JSON.parse(normalizeCompanyMenuPermissions('{"production":true}')),
    { production: true, simple_manufacturing: false },
  );
  assert.deepEqual(
    JSON.parse(normalizeCompanyMenuPermissions('{"simple_manufacturing":true}')),
    { simple_manufacturing: true },
  );
});

test("simple facade exposes only explicit lifecycle endpoints under simple action gates", async () => {
  const [facade, production] = await Promise.all([
    readFile(new URL("../src/routes/simple-manufacturing.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8"),
  ]);
  assert.match(facade, /router\.use\(commercialLifecycleRouter\)/);
  assert.match(facade, /requireModulePermission\("simple_manufacturing"\)/);
  assert.match(facade, /const view = requirePermission\("simple_manufacturing", "view"\)/);
  assert.match(facade, /const post = requirePermission\("simple_manufacturing", "post"\)/);
  assert.match(facade, /const unpost = requirePermission\("simple_manufacturing", "unpost"\)/);
  assert.doesNotMatch(facade, /router\.use\(\s*productionRouter/);
  assert.match(production, /function lifecycleModuleKey\(\): "production" \| "simple_manufacturing"/);
  assert.match(production, /getContextModuleKey\(\) === "simple_manufacturing"/);
  assert.match(production, /eq\(productionOrdersTable\.companyId, cid\)/);
});

test("simple accounting setup exposes active posting asset and expense accounts and preserves existing settings", async () => {
  const [facade, production] = await Promise.all([
    readFile(new URL("../src/routes/simple-manufacturing.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8"),
  ]);
  assert.match(
    facade,
    /router\.put\("\/setup\/accounting", edit/,
    "account setup must use the simple module edit gate",
  );
  assert.match(
    facade,
    /eq\(accountsTable\.isActive, true\)[\s\S]*?eq\(accountsTable\.isPosting, true\)[\s\S]*?eq\(accountsTable\.accountType, "asset"\)/,
    "catalog must filter eligible asset accounts before applying the limit",
  );
  assert.match(
    facade,
    /eq\(accountsTable\.accountType, "expense"\)/,
    "catalog must expose active posting expense accounts for waste",
  );
  assert.match(
    facade,
    /accounts:\s*\[\.\.\.accounts,\s*\.\.\.wasteAccounts\]/,
    "the catalog must keep asset and waste account options in one response",
  );
  assert.match(facade, /onConflictDoUpdate\(\{/);
  assert.match(facade, /defaultWipAccountId/);
  assert.match(facade, /defaultRawInventoryAccountId/);
  assert.match(facade, /defaultFinishedGoodsAccountId/);
  assert.match(facade, /defaultWasteAccountId/);
  assert.match(
    facade,
    /const expectedType = wasteId === id \? "expense" : "asset"/,
    "setup must distinguish the waste expense from the three asset defaults",
  );
  assert.match(
    facade,
    /row\?\.accountType !== expectedType/,
    "setup must reject an account with the wrong category",
  );
  assert.match(
    production,
    /async function validateExpenseAccount\([\s\S]*?accountType !== "expense"/,
    "canonical production account validation must keep waste expense-only",
  );
});

test("simple status hydration is branch-scoped, status-guarded, and coalescing", async () => {
  const facade = await readFile(new URL("../src/routes/simple-manufacturing.ts", import.meta.url), "utf8");
  const start = facade.indexOf('router.post("/orders/:id/status"');
  const end = facade.indexOf("\nfor (const [operation, status]", start);
  assert.ok(start >= 0 && end > start, "compact status wrapper must be present");
  const hydration = facade.slice(start, end);
  assert.match(hydration, /if \(branchResult\.cond\) updateConditions\.push\(branchResult\.cond\)/);
  assert.match(
    hydration,
    /if \(target === "approved" \|\| target === "in_production" \|\|\s*target === "quality_check" \|\|\s*target === "completed"\)/,
    "hydration must run before QA and completion retries",
  );
  assert.match(
    hydration,
    /if \(order\.status === "draft" \|\| order\.status === "approved" \|\|\s*order\.status === "in_production" \|\|\s*order\.status === "quality_check"\)/,
    "hydration may fill a missing default through quality, but not after completion",
  );
  assert.match(
    hydration,
    /inArray\(productionOrdersTable\.status, \["draft", "approved", "in_production", "quality_check"\]\)/,
    "status guard must include pre-completion retries without allowing completed rows",
  );
  assert.match(hydration, /sql`coalesce\(\$\{productionOrdersTable\.wipAccountId\}/);
  assert.match(hydration, /sql`coalesce\(\$\{productionOrdersTable\.rawInventoryAccountId\}/);
  assert.match(hydration, /sql`coalesce\(\$\{productionOrdersTable\.finishedGoodsAccountId\}/);
  assert.match(hydration, /sql`coalesce\(\$\{productionOrdersTable\.wasteAccountId\}/);
  assert.match(
    hydration,
    /wipAccountId: productionOrdersTable\.wipAccountId[\s\S]*?wasteAccountId: productionOrdersTable\.wasteAccountId/,
    "hydration must read all core account overrides before applying defaults",
  );
});

test("simple lifecycle actions cannot complete directly and simple order navigation stays on the facade", async () => {
  const [list, app, detail] = await Promise.all([
    readFile(
      new URL("../../zatca-invoicing/src/pages/simple-manufacturing/SimpleList.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../../zatca-invoicing/src/App.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../../zatca-invoicing/src/pages/ProductionOrderDetail.tsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(list, /in_production:\s*"quality_check"/);
  assert.doesNotMatch(list, /in_production:\s*"completed"/);
  assert.doesNotMatch(
    list,
    /onChangeStatus\(\s*selectedOrder,\s*["']completed["']\s*\)/,
    "the compact list must not bypass quality check with a direct completion action",
  );
  assert.match(list, /quality_check:\s*null/);
  assert.match(list, /simple-manufacturing\/orders\/\$\{selectedOrder\.id\}/);

  assert.match(
    app,
    /PermRoute path="\/simple-manufacturing\/orders"[\s\S]*?Redirect to="\/simple-manufacturing"/,
    "legacy simple order-list URL must redirect to the compact hub",
  );
  assert.match(
    app,
    /PermRoute path="\/production\/orders\/:id"[\s\S]*?component=\{ProductionOrderDetail\}/,
    "advanced production detail route must remain unchanged",
  );
  assert.match(detail, /const listRoute = simpleFacade \? routePrefix : `\$\{routePrefix\}\/orders`/);
  assert.match(detail, /<Link href=\{listRoute\}>/);
});