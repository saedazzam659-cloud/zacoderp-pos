import assert from "node:assert/strict";
import test from "node:test";
import {
  DocumentMutationAdmissionError,
  DocumentMutationAdmissionGate,
} from "../src/lib/document-mutation-admission.js";

test("document mutation admission hands a released slot to the oldest waiter", async () => {
  const gate = new DocumentMutationAdmissionGate(1, 100, 2);
  const releaseFirst = await gate.acquire();
  let secondAcquired = false;
  const secondPromise = gate.acquire().then((release) => {
    secondAcquired = true;
    return release;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.active, 1);
  assert.equal(gate.queued, 1);
  assert.equal(secondAcquired, false);

  releaseFirst();
  const releaseSecond = await secondPromise;
  assert.equal(gate.active, 1);
  assert.equal(gate.queued, 0);
  releaseSecond();
  assert.equal(gate.active, 0);
});

test("timed-out admission rejects with retryable 503 without consuming a slot", async () => {
  const gate = new DocumentMutationAdmissionGate(1, 10, 1);
  const release = await gate.acquire();

  await assert.rejects(
    gate.acquire(),
    (error: unknown) => error instanceof DocumentMutationAdmissionError && error.status === 503,
  );
  assert.equal(gate.active, 1);
  assert.equal(gate.queued, 0);

  release();
  const releaseAgain = await gate.acquire();
  releaseAgain();
  assert.equal(gate.active, 0);
});

test("duplicate release calls cannot create extra admission capacity", async () => {
  const gate = new DocumentMutationAdmissionGate(1, 100, 1);
  const release = await gate.acquire();
  release();
  release();
  assert.equal(gate.active, 0);

  const releaseNext = await gate.acquire();
  assert.equal(gate.active, 1);
  releaseNext();
});

test("zero admission capacity rejects immediately instead of deadlocking a one-client pool", async () => {
  const gate = new DocumentMutationAdmissionGate(0, 100, 1);
  await assert.rejects(
    gate.acquire(),
    (error: unknown) => error instanceof DocumentMutationAdmissionError && error.status === 503,
  );
  assert.equal(gate.active, 0);
  assert.equal(gate.queued, 0);
});
