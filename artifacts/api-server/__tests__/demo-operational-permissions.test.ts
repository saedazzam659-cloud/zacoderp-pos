import assert from "node:assert/strict";
import test from "node:test";
import { effectiveDemoPermissions, isDemoOperationalRequest, canManageDemoOperationalSetting } from "../src/lib/demoOperationalPolicy.ts";
import { readFileSync } from "node:fs";
import { canAccessModule, requireAdminRole, hasDemoOperationalPrivilege } from "../src/middleware/permissions.ts";
import { canPostDoc, canUnpostDoc } from "../src/lib/postingRights.ts";

const original = { sales_invoices: { create: false }, users: { view: false } };
function demo(enabled: boolean, gates: Record<string, boolean> = {}) {
  return { id: 12, role: "user", companyId: 20, demoOperationalVerified: enabled,
    permissions: effectiveDemoPermissions(original, enabled), companyMenuPermissions: gates,
    postingPermissions: { sales: { post: false, unpost: false },
      goodsReceipt: { post: false, unpost: false }, goodsDelivery: { post: false, unpost: false } } };
}

test("normal and revoked sessions retain the original map without mutation", () => {
  assert.equal(effectiveDemoPermissions(original, false), original);
  assert.equal(canAccessModule(demo(false), "sales_invoices", "create"), false);
  assert.equal(canPostDoc(demo(false), "sales"), false);
  assert.deepEqual(original, { sales_invoices: { create: false }, users: { view: false } });
});

test("operational overlay permits invoices and receipt/delivery actions but respects company gates", () => {
  for (const action of ["create", "post", "unpost", "delete"] as const) {
    assert.equal(canAccessModule(demo(true), "sales_invoices", action), true);
    assert.equal(canAccessModule(demo(true, { sales_module: false }), "sales_invoices", action), false);
    assert.equal(canAccessModule(demo(true, { delivery_receipt_docs: true }), "delivery_receipt_docs", action), true);
    assert.equal(canAccessModule(demo(true, { delivery_receipt_docs: false }), "delivery_receipt_docs", action), false);
  }
  assert.equal(canPostDoc(demo(true), "sales"), true);
  assert.equal(canUnpostDoc(demo(true), "sales"), true);
  assert.equal(canPostDoc(demo(true), "goodsReceipt"), true);
  assert.equal(canPostDoc(demo(true, { sales_module: false }), "sales"), false);
  assert.equal(canPostDoc(demo(true, { inventory_reports: false }), "goodsReceipt"), false);
});

test("all existing identities consume the source toggle; revocation restores baseline", () => {
  for (const enabled of [true, false, true, false]) {
    for (const id of [12, 13, 14]) {
      const identity = { ...demo(enabled), id };
      assert.equal(canAccessModule(identity, "sales_invoices", "create"), enabled);
      assert.equal(identity.role, "user");
      assert.equal(identity.companyId, 20);
    }
  }
});

test("settings, users, unknown modules and admin role gates are never elevated", () => {
  const user = demo(true);
  for (const key of ["users", "general_settings", "company_profile", "hr_settings", "zatca_setup", "subscriptions", "unknown"]) {
    assert.equal(canAccessModule(user, key, "edit"), false, key);
    assert.equal(hasDemoOperationalPrivilege(user, key, "edit"), false, key);
  }
  let status = 0;
  let passed = false;
  const res = { status(code: number) { status = code; return this; }, json() {} };
  requireAdminRole({ authUser: user } as any, res as any, () => { passed = true; });
  assert.equal(status, 403);
  assert.equal(passed, false);
  assert.equal(user.role, "user");
});

test("mixed-module settings and unknown API trees cannot consume the overlay", () => {
  for (const path of ["/api/users/12", "/api/admin/companies/10", "/api/companies/10",
    "/api/production/manufacturing-settings", "/api/contracting/settings",
    "/api/simple-manufacturing/setup/accounting", "/api/hr/%73ettings",
    "/api/pos-terminals/1/users", "/api/subscriptions", "/api/new-module/action",
    "/api/hr/face/kiosk-tokens", "/api/hr/face/cameras"]) {
    assert.equal(isDemoOperationalRequest(path), false, path);
  }
  for (const path of ["/api/invoices", "/api/sales/sales-invoices/1/post",
    "/api/goods-receipts/2/post", "/api/goods-deliveries/3/post",
    "/api/delivery-receipt-documents/4/approve"]) {
    assert.equal(isDemoOperationalRequest(path), true, path);
  }
});

test("management guards reject self-grant, cross-tenant, shadow and ordinary-user writes", () => {
  const admin = { id: 1, role: "admin", companyId: 20 };
  const target = { id: 2, role: "user", companyId: 20, isDemoShadow: false, demoDeviceIsolation: true };
  assert.equal(canManageDemoOperationalSetting(admin, target, true), true);
  assert.equal(canManageDemoOperationalSetting(admin, target, false), true);
  assert.equal(canManageDemoOperationalSetting(admin, { ...target, id: 1 }, true), false);
  assert.equal(canManageDemoOperationalSetting(admin, { ...target, companyId: 21 }, true), false);
  assert.equal(canManageDemoOperationalSetting({ ...admin, role: "user" }, target, true), false);
  assert.equal(canManageDemoOperationalSetting(admin, { ...target, isDemoShadow: true }, true), false);
  assert.equal(canManageDemoOperationalSetting(admin, { ...target, demoDeviceIsolation: false }, true), false);
  assert.equal(canManageDemoOperationalSetting(admin, target, "true"), false);
  assert.equal(canManageDemoOperationalSetting({ ...admin, role: "superadmin", companyId: null }, target, true), true);
});

test("receipt and delivery create/post/unpost use warehouse gate and live effective rights", () => {
  for (const doc of ["goodsReceipt", "goodsDelivery"]) {
    assert.equal(canPostDoc(demo(true), doc), true);
    assert.equal(canUnpostDoc(demo(true), doc), true);
    assert.equal(canPostDoc(demo(false), doc), false);
    assert.equal(canUnpostDoc(demo(false), doc), false);
    assert.equal(canPostDoc(demo(true, { inventory_reports: false }), doc), false);
    assert.equal(canUnpostDoc(demo(true, { inventory_reports: false }), doc), false);
    assert.equal(canPostDoc({ ...demo(true, { inventory_reports: false }), postingPermissions: null }, doc), false);
  }
  for (const action of ["create", "post", "unpost"] as const) {
    assert.equal(canAccessModule(demo(true), "warehouses", action), true);
    assert.equal(canAccessModule(demo(true, { inventory_reports: false }), "warehouses", action), false);
  }
});

test("receipt/delivery UI preserves its existing flow while backend gates effective rights", () => {
  for (const [page, router, doc] of [
    ["GoodsReceipts", "goodsReceipts", "goodsReceipt"],
    ["GoodsDeliveries", "goodsDeliveries", "goodsDelivery"],
  ]) {
    const ui = readFileSync(new URL(`../../zatca-invoicing/src/pages/inventory/${page}.tsx`, import.meta.url), "utf8");
    const server = readFileSync(new URL(`../src/routes/${router}.ts`, import.meta.url), "utf8");
    assert.match(ui, /!isEdit && j\?\.id && \(j.status \?\? "draft"\) === "draft"/);
    assert.match(ui, /onClick=\{\(\) => postMut.mutate\(Number\(r.id\)\)\}/);
    assert.match(ui, /await gate\('print'\)/);
    assert.match(ui, /await gate\('export'\)/);
    assert.match(server, /pathRbac\(\[\s*\["\/", "warehouses"\]/);
    assert.ok(server.includes(`requirePostRight("${doc}")`));
    assert.ok(server.includes(`requireUnpostRight("${doc}")`));
  }
  const auth = readFileSync(new URL("../src/routes/auth.ts", import.meta.url), "utf8");
  assert.match(auth, /permissions: effectiveDemoPermissions/);
  assert.match(auth, /const liveAuthorization = await resolveBearerToken\(token, req.headers.cookie\)/);
  assert.match(auth, /permissions: liveAuthorization.user.permissions/);
  const sales = readFileSync(new URL("../src/routes/sales.ts", import.meta.url), "utf8");
  assert.match(sales, /\["\/sales-orders",\s*"sales_invoices"\]/);
});