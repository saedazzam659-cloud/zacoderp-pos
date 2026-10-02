import { test } from "node:test";
import assert from "node:assert/strict";

import { sequenceProtectionErrorResponse } from "../src/lib/sequenceProtectionErrors.ts";

test("sequence-protected delete errors return friendly English without SQL", () => {
  const wrapped = new Error('Failed query: delete from "purchase_invoices"');
  wrapped.cause = Object.assign(new Error("protected document"), {
    code: "P0001",
    detail: "SEQUENCE_PROTECTED_DELETE",
  });

  const response = sequenceProtectionErrorResponse(wrapped, "en-US,en;q=0.9");

  assert.equal(response?.code, "SEQUENCE_PROTECTED_DELETE");
  assert.equal(response?.errorTitle, "This document is protected");
  assert.match(response?.errorDescription ?? "", /cannot be deleted/);
  assert.doesNotMatch(response?.error ?? "", /Failed query|purchase_invoices/i);
});

test("sequence-protected delete errors return Arabic when the UI is Arabic", () => {
  const response = sequenceProtectionErrorResponse(
    Object.assign(new Error("protected"), {
      code: "P0001",
      detail: "SEQUENCE_PROTECTED_DELETE",
    }),
    "ar",
  );

  assert.equal(response?.code, "SEQUENCE_PROTECTED_DELETE");
  assert.equal(response?.errorTitle, "هذا المستند محمي");
  assert.match(response?.errorDescription ?? "", /رقمًا تسلسليًا محميًا/);
});

test("unrelated database failures are not mislabeled as sequence protection", () => {
  const unrelated = new Error("delete failed");
  unrelated.cause = Object.assign(new Error("foreign key violation"), {
    code: "23503",
    detail: "Some unrelated constraint",
  });

  assert.equal(sequenceProtectionErrorResponse(unrelated, "en"), null);
});

test("nested protected-number changes are recognized independently", () => {
  const wrapped = new Error("query wrapper");
  wrapped.cause = Object.assign(new Error("driver wrapper"), {
    cause: Object.assign(new Error("database error"), {
      code: "P0001",
      detail: "SEQUENCE_PROTECTED_NUMBER_CHANGE",
    }),
  });

  const response = sequenceProtectionErrorResponse(wrapped, "en");
  assert.equal(response?.code, "SEQUENCE_PROTECTED_NUMBER_CHANGE");
  assert.equal(response?.errorTitle, "The document number is protected");
});