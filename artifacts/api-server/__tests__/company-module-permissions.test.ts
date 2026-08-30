import assert from "node:assert/strict";
import test from "node:test";

import {
  canAccessModule,
  companyAllowsModule,
} from "../src/middleware/permissions.ts";

function userWith(
  companyMenuPermissions: Record<string, boolean>,
  permissions: Record<string, Record<string, boolean>> = {},
) {
  return {
    role: "user",
    companyMenuPermissions,
    permissions,
  };
}

test("sales module disable blocks customer notes even with a user grant", () => {
  const user = userWith(
    { sales_module: false },
    { customer_notes: { view: true } },
  );

  assert.equal(companyAllowsModule(user, "customer_notes"), false);
  assert.equal(canAccessModule(user, "customer_notes", "view"), false);
});

test("purchases module disable blocks supplier notes even with a user grant", () => {
  const user = userWith(
    { purchases_module: false },
    { supplier_notes: { view: true } },
  );

  assert.equal(companyAllowsModule(user, "supplier_notes"), false);
  assert.equal(canAccessModule(user, "supplier_notes", "view"), false);
});

test("enabled purchasing module and supplier view grant allow supplier notes", () => {
  const user = userWith(
    { purchases_module: true },
    { supplier_notes: { view: true } },
  );

  assert.equal(canAccessModule(user, "supplier_notes", "view"), true);
});

test("demo analytics is default-off and needs an explicit company enablement", () => {
  const user = userWith(
    {},
    { demo_analytics: { view: true } },
  );
  assert.equal(companyAllowsModule(user, "demo_analytics"), false);
  assert.equal(canAccessModule(user, "demo_analytics", "view"), false);

  user.companyMenuPermissions.demo_analytics = true;
  assert.equal(companyAllowsModule(user, "demo_analytics"), true);
  assert.equal(canAccessModule(user, "demo_analytics", "view"), true);
});