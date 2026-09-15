import { test } from "node:test";
import assert from "node:assert/strict";

import {
  contractingBranchAllowed,
  contractingMutationAction,
  contractingWarehouseAllowed,
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
});

test("warehouse options stay on the project's branch or shared company scope", () => {
  assert.equal(contractingWarehouseAllowed(7, 7), true);
  assert.equal(contractingWarehouseAllowed(7, 8), false);
  assert.equal(contractingWarehouseAllowed(7, null), true);
  assert.equal(contractingWarehouseAllowed(null, null), false);
});