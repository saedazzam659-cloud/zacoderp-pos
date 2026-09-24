import assert from "node:assert/strict";
import { test } from "node:test";
import { DOCUMENT_TYPES } from "../../zatca-invoicing/src/config/accountingMappings.js";
import { DEFAULT_CHART_OF_ACCOUNTS } from "../src/lib/defaultChartOfAccounts.js";
import {
  CONTRACTING_ACCOUNTS, CONTRACTING_ROLES, MANUFACTURING_ACCOUNTS,
  MANUFACTURING_FIELDS, OPTIONAL_MODULE_ACCOUNT_CODES, accountingModulesFromMenu,
  isOptionalModuleTemplateMapping, missingContractingRoles, missingManufacturingFields, canRollbackFreshCompany,
} from "../src/lib/optionalModuleAccounting.js";

test("contracting mapping catalog includes every exposed role and no duplicate", () => {
  const configured = DOCUMENT_TYPES.filter((d) => d.key.startsWith("contracting_"))
    .flatMap((d) => d.roles.map((r) => `${d.key}:${r.key}`)).sort();
  const seeded = CONTRACTING_ROLES.map(([doc, role]) => `${doc}:${role}`).sort();
  assert.deepEqual(seeded, configured);
  assert.equal(new Set(seeded).size, seeded.length);
});

test("optional codes have valid typed parents and never collide with commercial codes", () => {
  const base = new Map(DEFAULT_CHART_OF_ACCOUNTS.map((a) => [a.code, a]));
  const optional = [...CONTRACTING_ACCOUNTS, ...MANUFACTURING_ACCOUNTS];
  const byCode = new Map(optional.map((a) => [a.code, a]));
  assert.equal(byCode.size, optional.length);
  for (const a of optional) {
    assert.equal(base.has(a.code), false, a.code);
    const parent = base.get(a.parent);
    assert.ok(parent && parent.accountType === a.type && !parent.isPosting, a.code);
  }
  for (const [, , code] of CONTRACTING_ROLES) {
    const account = byCode.get(code) ?? base.get(code);
    assert.ok(account, code);
    if ("isPosting" in account!) assert.equal(account.isPosting, true, code);
  }
  for (const code of Object.values(MANUFACTURING_FIELDS)) assert.ok(byCode.has(code), code);
});

test("only explicit true grants optional module defaults", () => {
  assert.deepEqual(accountingModulesFromMenu('{"contracting":false,"production":1,"simple_manufacturing":true}'),
    { contracting: false, production: false, simple_manufacturing: true });
  assert.deepEqual(accountingModulesFromMenu(null), {});
});

test("new-company industry/template optional rows are deferred to the module seeder", () => {
  for (const [documentType] of CONTRACTING_ROLES) assert.equal(isOptionalModuleTemplateMapping(documentType), true);
  assert.equal(isOptionalModuleTemplateMapping("sales_invoice"), false);
  assert.equal(isOptionalModuleTemplateMapping("manufacturing_issue"), true);
  assert.equal(isOptionalModuleTemplateMapping("production_completion"), true);
  for (const code of Object.values(MANUFACTURING_FIELDS)) assert.equal(OPTIONAL_MODULE_ACCOUNT_CODES.has(code), true);
  assert.equal(OPTIONAL_MODULE_ACCOUNT_CODES.has("11031"), false);
});

test("repeated activation preserves existing mapping rows and filled manufacturing settings", () => {
  const existing = CONTRACTING_ROLES.map(([documentType, roleKey]) => ({ documentType, roleKey }));
  assert.deepEqual(missingContractingRoles(existing), []);
  // An intentionally blank mapping is still existing: the seeder cannot fill it.
  assert.equal(missingContractingRoles([existing[0]]).some(([d, k]) =>
    d === existing[0].documentType && k === existing[0].roleKey), false);
  assert.deepEqual(missingManufacturingFields(Object.fromEntries(
    Object.keys(MANUFACTURING_FIELDS).map((key) => [key, 42]),
  )), {});
  assert.equal(missingManufacturingFields({ defaultWipAccountId: 42 }).defaultWipAccountId, undefined);
  assert.deepEqual(Object.keys(missingManufacturingFields(null)).sort(), Object.keys(MANUFACTURING_FIELDS).sort());
});

test("fresh-company compensation refuses unrelated or used companies", () => {
  const created = { id: 91, code: "ZTC-91", createdAt: new Date("2026-01-01T00:00:00Z") };
  assert.equal(canRollbackFreshCompany(created, created, false), true);
  assert.equal(canRollbackFreshCompany({ ...created, id: 90 }, created, false), false);
  assert.equal(canRollbackFreshCompany({ ...created, code: "CUSTOM" }, created, false), false);
  assert.equal(canRollbackFreshCompany({ ...created, createdAt: new Date("2025-01-01") }, created, false), false);
  assert.equal(canRollbackFreshCompany(created, created, true), false);
});