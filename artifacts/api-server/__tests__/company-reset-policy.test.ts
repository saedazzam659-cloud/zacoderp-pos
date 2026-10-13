import test from "node:test";
import assert from "node:assert/strict";
import { canSkipMissingResetTable } from "../src/lib/companyResetPolicy.js";

test("a missing optional reset table is skipped only when it is not present", () => {
  assert.equal(canSkipMissingResetTable("integration_invoice_queue", false), true);
  assert.equal(canSkipMissingResetTable("integration_invoice_queue", true), false);
});

test("a missing required reset table is never silently skipped", () => {
  assert.equal(canSkipMissingResetTable("sales_invoices", false), false);
});
