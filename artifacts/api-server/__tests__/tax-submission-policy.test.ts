import { test } from "node:test";
import assert from "node:assert/strict";
import { mayRetryTaxSubmission } from "../src/lib/taxSubmissionPolicy.ts";

test("tax submissions retry only after a provider rejection and an explicit retry request", () => {
  for (const status of ["submitting", "processing", "submitted", "unknown"]) {
    assert.equal(mayRetryTaxSubmission(status, true), false, `${status} must remain protected from duplicate sends`);
    assert.equal(mayRetryTaxSubmission(status, false), false);
  }
  assert.equal(mayRetryTaxSubmission("rejected", false), false);
  assert.equal(mayRetryTaxSubmission("rejected", true), true);
});