import assert from "node:assert/strict";
import test from "node:test";
import { printAuditPageIfNothingSelected } from "../src/lib/auditPagePrint.ts";

test("no-selection audit print invokes current-page printing exactly once", () => {
  let calls = 0;
  const handled = printAuditPageIfNothingSelected(0, () => { calls += 1; });
  assert.equal(handled, true);
  assert.equal(calls, 1);
});

test("selected invoice printing stays on the dedicated invoice path", () => {
  let calls = 0;
  const handled = printAuditPageIfNothingSelected(2, () => { calls += 1; });
  assert.equal(handled, false);
  assert.equal(calls, 0);
});