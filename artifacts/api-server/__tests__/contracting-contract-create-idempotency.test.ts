import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  contractCreateFingerprint,
  parseContractCreateIdempotencyKey,
} from "../src/lib/contracting-contract-create-idempotency.ts";

test("contract create request keys accept the form field or Idempotency-Key header", () => {
  assert.equal(
    parseContractCreateIdempotencyKey({ body: { clientRequestId: "web-form-key" } }),
    "web-form-key",
  );
  assert.equal(
    parseContractCreateIdempotencyKey({ body: { idempotencyKey: " form-key " } }),
    "form-key",
  );
  assert.equal(
    parseContractCreateIdempotencyKey({
      body: {},
      get: (name) => name === "Idempotency-Key" ? "header-key" : undefined,
    }),
    "header-key",
  );
  assert.throws(
    () => parseContractCreateIdempotencyKey({ body: {} }),
    (error: any) => error.status === 400,
  );
});

test("both web contract forms retain and send a create key and block concurrent saves", () => {
  const source = readFileSync(new URL("../../zatca-invoicing/src/pages/ContractingProjectDetail.tsx", import.meta.url), "utf8");
  for (const name of ["OwnerContractTab", "SubContractsTab"]) {
    const form = source.split(`function ${name}(`)[1]?.split("\nfunction ")[0];
    assert.ok(form, `${name} exists`);
    assert.match(form, /if \(saveInFlight\.current\) return/);
    assert.match(form, /createRequestId\.current \?\?= crypto\.randomUUID\(\)/);
    assert.match(form, /JSON\.stringify\(isEdit \? editing : \{ \.\.\.editing, clientRequestId: createRequestId\.current \}\)/);
    assert.match(form, /<Button disabled=\{saving\} onClick=\{save\}>/);
  }
});

test("contract create fingerprints are stable for reordered top-level fields", () => {
  const left = contractCreateFingerprint({
    operation: "owner_contract_create",
    projectId: 7,
    contractNumber: "OC-1",
    nested: { value: 3 },
  });
  const right = contractCreateFingerprint({
    nested: { value: 3 },
    contractNumber: "OC-1",
    projectId: 7,
    operation: "owner_contract_create",
  });
  const changed = contractCreateFingerprint({
    operation: "owner_contract_create",
    projectId: 7,
    contractNumber: "OC-2",
    nested: { value: 3 },
  });
  assert.equal(left, right);
  assert.notEqual(left, changed);
});