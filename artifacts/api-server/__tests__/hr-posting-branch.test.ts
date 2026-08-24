import test from "node:test";
import assert from "node:assert/strict";
import {
  isHrPostingBranchBackfill,
  resolveHrPostingBranch,
} from "../src/lib/hrPostingBranch.ts";

test("HR cash posting falls back to the selected bank or cash-box branch", () => {
  assert.equal(resolveHrPostingBranch(null, 11, null), 11);
  assert.equal(resolveHrPostingBranch(undefined, 7, undefined), 7);
  // Custody records intentionally prefer their selected payment source over
  // the employee fallback, matching the posting-branch policy for this flow.
  assert.equal(resolveHrPostingBranch(null, 11, 8), 11);
});

test("document branch remains authoritative when it exists", () => {
  assert.equal(resolveHrPostingBranch(3, 11, 8), 3);
  assert.equal(resolveHrPostingBranch(null, null, 8), 8);
  assert.equal(resolveHrPostingBranch(null, null, null), null);
});

test("legacy branchless HR source invalidates its old branch-0 reservation once", () => {
  assert.equal(isHrPostingBranchBackfill(null, 11), true);
  assert.equal(isHrPostingBranchBackfill(undefined, 8), true);
  assert.equal(isHrPostingBranchBackfill(11, 11), false);
  assert.equal(isHrPostingBranchBackfill(null, null), false);
});