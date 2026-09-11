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