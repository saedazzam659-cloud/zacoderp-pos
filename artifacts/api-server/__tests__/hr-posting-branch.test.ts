import test from "node:test";
import assert from "node:assert/strict";
import { resolveHrPostingBranch } from "../src/lib/hrPostingBranch.ts";

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