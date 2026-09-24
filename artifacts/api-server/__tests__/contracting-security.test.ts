import { test } from "node:test";
import assert from "node:assert/strict";

import {
  contractingBranchAllowed,
  contractingLoadError,
  contractingMutationAction,
  contractingWarehouseAllowed,
  contractingWarehouseError,
} from "../src/lib/contracting-security.ts";

test("legacy contracting mutations map to granular actions", () => {
  assert.equal(contractingMutationAction("POST"), "create");
  assert.equal(contractingMutationAction("put"), "edit");
  assert.equal(contractingMutationAction("PATCH"), "edit");
  assert.equal(contractingMutationAction("DELETE"), "delete");
  assert.equal(contractingMutationAction("GET"), null);
});

test("restricted users cannot use an unassigned project as a central fallback", () => {
  const user = { role: "user", viewAllBranches: false, branchIds: [7] } as const;
  assert.equal(contractingBranchAllowed(user, 7), true);
  assert.equal(contractingBranchAllowed(user, 8), false);
  assert.equal(contractingBranchAllowed(user, null), false);
  assert.equal(contractingBranchAllowed(
    { role: "admin", viewAllBranches: false, branchIds: [] },
    null,
  ), true);
});

test("warehouse options stay on the project's branch or shared company scope", () => {
  assert.equal(contractingWarehouseAllowed(7, 7), true);
  assert.equal(contractingWarehouseAllowed(7, 8), false);
  assert.equal(contractingWarehouseAllowed(7, null), true);
  assert.equal(contractingWarehouseAllowed(null, null), true);
  assert.equal(contractingWarehouseAllowed(null, 7), false);
  assert.equal(contractingWarehouseError(null, 7), "يجب تحديد فرع المشروع قبل اختيار مخزن مرتبط بفرع");
  assert.equal(contractingWarehouseError(7, 8), "المخزن لا يتبع فرع المشروع");
  assert.equal(contractingWarehouseError(null, null), null);
});

test("contracting read errors are actionable without leaking driver SQL", () => {
  const missingColumn = Object.assign(new Error("SELECT secret FROM private_table"), { code: "42703" });
  const nested = Object.assign(new Error("Failed query: SELECT secret"), { cause: missingColumn });
  const schemaMessage = contractingLoadError(nested, "تعذر تحميل الموارد");
  assert.match(schemaMessage, /إصدار النظام وقاعدة البيانات/);
  assert.doesNotMatch(schemaMessage, /SELECT|secret|private_table/i);
  const permissionMessage = contractingLoadError({ code: "42501", message: "permission denied for relation secrets" }, "تعذر تحميل الموارد");
  assert.match(permissionMessage, /صلاحيات قاعدة البيانات/);
  assert.doesNotMatch(permissionMessage, /secrets/);
  const genericMessage = contractingLoadError(new Error("password=supersecret"), "تعذر تحميل الموارد");
  assert.match(genericMessage, /تواصل مع مسؤول النظام/);
  assert.doesNotMatch(genericMessage, /supersecret/);
});