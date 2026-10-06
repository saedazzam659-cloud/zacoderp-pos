import assert from "node:assert/strict";
import test from "node:test";
import { normalizeZatcaStatus } from "../src/lib/zatca-status.js";

test("accepted ZATCA verdicts render as approved across invoice grids", () => {
  for (const status of ["approved", "accepted", "cleared", "reported", "REPORTED_WITH_WARNINGS"]) {
    assert.equal(normalizeZatcaStatus(status), "approved");
  }
});

test("rejected and pending ZATCA verdicts keep their grid status", () => {
  assert.equal(normalizeZatcaStatus("rejected"), "rejected");
  assert.equal(normalizeZatcaStatus("pending"), "pending");
  assert.equal(normalizeZatcaStatus(null), null);
  assert.equal(normalizeZatcaStatus("unexpected"), null);
});
