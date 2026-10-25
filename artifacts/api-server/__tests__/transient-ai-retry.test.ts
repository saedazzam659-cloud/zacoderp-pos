import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithTransientAiRetry } from "../src/lib/transientAiRetry.js";

test("retries transient AI provider overload and returns the successful response", async () => {
  const statuses = [503, 503, 200];
  const waits: number[] = [];
  let calls = 0;

  const result = await fetchWithTransientAiRetry(
    async () => ({ ok: statuses[calls] === 200, status: statuses[calls++] }),
    async (milliseconds) => { waits.push(milliseconds); },
  );

  assert.equal(result.status, 200);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [800, 2_000]);
});

test("does not retry a non-transient provider error", async () => {
  let calls = 0;
  const result = await fetchWithTransientAiRetry(async () => {
    calls += 1;
    return { ok: false, status: 400 };
  }, async () => {
    assert.fail("unexpected retry delay");
  });

  assert.equal(result.status, 400);
  assert.equal(calls, 1);
});
