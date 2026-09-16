import assert from "node:assert/strict";
import test from "node:test";
import {
  retryableCreateAttempt,
  shouldRetainCreateAttemptAfterFailure,
} from "../src/lib/contractingSaveRetry.ts";

test("an unchanged contracting create retry keeps its idempotency claim", () => {
  const payload = { billDate: "2026-03-01", direction: "outgoing", ownerContractId: 301, grossAmount: "2500" };
  const first = retryableCreateAttempt(payload, null);
  const replay = retryableCreateAttempt({ grossAmount: "2500", ownerContractId: 301, direction: "outgoing", billDate: "2026-03-01" }, first);

  assert.match(first.idempotencyKey, /^contracting-bill-/);
  assert.equal(replay.idempotencyKey, first.idempotencyKey);
  assert.equal(replay.payloadSignature, first.payloadSignature);
});

test("a changed create payload gets a fresh idempotency claim", () => {
  const first = retryableCreateAttempt({ billDate: "2026-03-01", grossAmount: "2500" }, null);
  const changed = retryableCreateAttempt({ billDate: "2026-03-01", grossAmount: "2600" }, first);

  assert.notEqual(changed.idempotencyKey, first.idempotencyKey);
});

test("gateway errors preserve a create claim while business errors release it", () => {
  assert.equal(shouldRetainCreateAttemptAfterFailure(502), true);
  assert.equal(shouldRetainCreateAttemptAfterFailure(504), true);
  assert.equal(shouldRetainCreateAttemptAfterFailure(422), false);
  assert.equal(shouldRetainCreateAttemptAfterFailure(undefined, new TypeError("network failed")), true);
});