import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { mobilePermAllowed } from "../src/lib/mobilePerms.ts";
import { mobileFallbackKey } from "../src/middleware/permissions.ts";

const ordinary = "customer_statement_view";
const detailed = "customer_statement_detailed_view";

test("customer statement mobile fallback is independent and confined to exactly two read routes", () => {
  assert.equal(mobileFallbackKey("sales_reports", "view", "/customer-statement"), ordinary);
  assert.equal(mobileFallbackKey("sales_reports", "view", "/sales-analytics/customer-statement"), ordinary);
  assert.equal(mobileFallbackKey("sales_reports", "view", "/customer-statement-detailed"), detailed);
  assert.equal(mobileFallbackKey("sales_reports", "view", "/sales-analytics/customer-statement-detailed"), detailed);
  for (const path of ["/", "/sales-by-customer", "/customer-statement/other", "/customer-statement-detailed/other"]) {
    assert.equal(mobileFallbackKey("sales_reports", "view", path), undefined);
  }
  assert.equal(mobileFallbackKey("sales_reports", "edit", "/customer-statement"), undefined);
  assert.equal(mobileFallbackKey("sales_invoices", "view", "/sales-invoices"), "invoices_view");
});

test("explicit mobile denial does not spill between statements; legacy null stays allowed in restriction only", () => {
  const user = { role: "user", mobilePermissions: { [ordinary]: false, [detailed]: true } };
  assert.equal(mobilePermAllowed(user, ordinary), false);
  assert.equal(mobilePermAllowed(user, detailed), true);
  assert.equal(mobilePermAllowed({ role: "user", mobilePermissions: null }, ordinary), true);
  assert.equal(mobilePermAllowed({ role: "admin", mobilePermissions: { [ordinary]: false } }, ordinary), true);
  const middleware = readFileSync(new URL("../src/middleware/permissions.ts", import.meta.url), "utf8");
  assert.match(middleware, /if \(row\.mobilePermissions == null\) return false;/);
  assert.match(middleware, /row\.sessionChannel !== "mobile"/);
});

test("both mounted routes restrict mobile before any financial query and have separate Users controls", () => {
  const routes = readFileSync(new URL("../src/routes/sales-analytics.ts", import.meta.url), "utf8");
  const users = readFileSync(new URL("../../zatca-invoicing/src/pages/Users.tsx", import.meta.url), "utf8");
  assert.ok(routes.indexOf("router.use(extractAuth)") < routes.indexOf('router.get("/customer-statement"'));
  for (const [path, key] of [["/customer-statement", ordinary], ["/customer-statement-detailed", detailed]]) {
    const block = routes.slice(routes.indexOf(`router.get("${path}"`));
    assert.match(block.slice(0, 400), new RegExp(`requireMobilePerm\\(req, res, cid, "${key}"`));
    assert.ok(block.indexOf(`requireMobilePerm(req, res, cid, "${key}"`) < block.indexOf("db.select("));
    assert.match(users, new RegExp(`key: "${key}"`));
  }
});

test("statement response exposes only tenant- and branch-scoped linked account header fields", () => {
  const routes = readFileSync(new URL("../src/routes/sales-analytics.ts", import.meta.url), "utf8");
  const helper = routes.slice(routes.indexOf("async function customerStatementAccount("), routes.indexOf("// These sources are already represented"));
  for (const column of ["code", "nameAr", "nameEn", "level"]) {
    assert.match(helper, new RegExp(`${column}: accountsTable\\.${column}`));
  }
  assert.match(helper, /eq\(customersTable\.accountId, accountsTable\.id\)/);
  assert.match(helper, /eq\(accountsTable\.companyId, cid\)/);
  assert.match(helper, /eq\(customersTable\.companyId, cid\)/);
  assert.match(helper, /eq\(customersTable\.id, customerId\)/);
  assert.match(helper, /branchScopeSpread\(req, customersTable\.branchId\)/);
  assert.match(helper, /return account \?\? null/);
  assert.equal((routes.match(/res\.json\(\{ opening, lines, account: await customerStatementAccount\(req, cid, ccid\) \}\)/g) ?? []).length, 2);
  assert.equal((routes.match(/res\.json\(\{ opening: 0, lines: \[\], excluded: true/g) ?? []).length, 2);
});