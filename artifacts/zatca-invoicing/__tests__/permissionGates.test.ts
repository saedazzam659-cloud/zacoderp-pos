import assert from "node:assert/strict";
import test from "node:test";

import {
  companyExplicitlyEnablesModule,
  companyAllowsPermissionModule,
} from "../src/lib/companyModuleGate.ts";
import {
  PERMISSION_MODULES,
} from "../src/lib/permissions.ts";
import {
  companyAllowsPermissionGroup,
  GROUP_COMPANY_MENU_KEYS,
  GROUP_USER_PERMISSION_KEYS,
  userAllowsPermissionGroup,
} from "../src/lib/permissionGroupPolicy.ts";

test("purchasing company gate is independent from granular user keys", () => {
  const menuPermissions = {
    purchases_module: true,
    purchases_reports: false,
    suppliers: false,
  };

  assert.equal(
    companyAllowsPermissionModule(menuPermissions, "suppliers"),
    true,
  );
  assert.equal(
    userAllowsPermissionGroup(
      { role: "user", permissions: { suppliers: { view: true } } },
      ["suppliers", "purchase_invoices", "purchase_returns"],
    ),
    true,
  );
});

test("a disabled company module remains the upper permission bound", () => {
  assert.equal(
    companyAllowsPermissionModule(
      { purchases_module: false },
      "purchase_invoices",
    ),
    false,
  );
  assert.equal(
    companyAllowsPermissionModule({ maintenance: false }, "maintenance"),
    false,
  );
});

test("legacy child flags cannot override an explicit company-module disable", () => {
  const menuPermissions = {
    purchases_module: false,
    purchases_reports: false,
    suppliers: true,
  };

  assert.equal(
    companyAllowsPermissionGroup(menuPermissions, "purchasing"),
    false,
  );
  assert.deepEqual(
    GROUP_COMPANY_MENU_KEYS.purchasing,
    ["purchases_module", "purchases_reports"],
  );
});

test("report-only inventory users keep the Inventory navigation group", () => {
  assert.ok(GROUP_USER_PERMISSION_KEYS.inventory.includes("inventory_reports"));
  assert.equal(
    userAllowsPermissionGroup(
      {
        role: "user",
        permissions: { inventory_reports: { view: true } },
      },
      GROUP_USER_PERMISSION_KEYS.inventory,
    ),
    true,
  );
});

test("accounting-maintenance-only users keep the Accounting navigation group", () => {
  assert.ok(
    GROUP_USER_PERMISSION_KEYS.accounting.includes("accounting_maintenance"),
  );
  assert.equal(
    userAllowsPermissionGroup(
      {
        role: "user",
        permissions: { accounting_maintenance: { view: true } },
      },
      GROUP_USER_PERMISSION_KEYS.accounting,
    ),
    true,
  );
});

test("cash and banks are a separate user-permission group", () => {
  const cashKeys = new Set([
    "cash_boxes",
    "bank_accounts",
    "receipt_vouchers",
    "payment_vouchers",
  ]);
  const cashModules = PERMISSION_MODULES.filter(m => cashKeys.has(m.key));

  assert.equal(cashModules.length, cashKeys.size);
  assert.ok(cashModules.every(m => m.group === "perms.groups.cash"));
  assert.ok(
    PERMISSION_MODULES
      .filter(m => m.group === "perms.groups.accounting")
      .every(m => !cashKeys.has(m.key)),
  );
});

test("customer and supplier note permissions follow their company modules", () => {
  assert.equal(
    companyAllowsPermissionModule({ sales_module: false }, "customer_notes"),
    false,
  );
  assert.equal(
    companyAllowsPermissionModule(
      { purchases_module: false },
      "supplier_notes",
    ),
    false,
  );
});

test("legacy defaults and locked defaults remain unchanged", () => {
  assert.equal(companyAllowsPermissionModule({}, "cash_boxes"), true);
  assert.equal(companyAllowsPermissionModule({}, "office"), false);
});

test("optional ZATCA prompts require the module to be explicitly enabled", () => {
  assert.equal(
    companyExplicitlyEnablesModule({ company: { menuPermissions: {} } }, "zatca_setup"),
    false,
  );
  assert.equal(
    companyExplicitlyEnablesModule({ company: { menuPermissions: { zatca: true } } }, "zatca_setup"),
    true,
  );
  assert.equal(
    companyExplicitlyEnablesModule({ company: { menuPermissions: "{\"zatca\":false}" } }, "zatca_setup"),
    false,
  );
});