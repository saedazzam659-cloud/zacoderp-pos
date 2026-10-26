import assert from "node:assert/strict";
import { test } from "node:test";
import { processInvoiceBatchQueue } from "../src/lib/invoiceBatchQueue.js";

test("processes a 501-file batch with bounded concurrency and index-stable results", async () => {
  const entries = Array.from({ length: 501 }, (_, index) => ({ entry: index, index }));
  let active = 0;
  let peakActive = 0;
  let lastProgress = 0;

  const result = await processInvoiceBatchQueue(
    entries,
    async (entry) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      if (entry === 37) throw new Error("synthetic unreadable file");
      return `document-${entry}`;
    },
    { concurrency: 2, onProgress: (completed) => { lastProgress = completed; } },
  );

  assert.equal(result.successes.size, 500);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].entry, 37);
  assert.equal(result.failures[0].error, "synthetic unreadable file");
  assert.equal(peakActive, 2);
  assert.equal(lastProgress, 501);
  assert.deepEqual(
    entries.filter(({ index }) => index !== 37).map(({ index }) => result.successes.get(index)),
    entries.filter(({ index }) => index !== 37).map(({ entry }) => `document-${entry}`),
  );
});

test("stops claiming new files after a quota response and preserves in-flight successes", async () => {
  const entries = Array.from({ length: 501 }, (_, index) => ({ entry: index, index }));
  const invoked: number[] = [];
  const result = await processInvoiceBatchQueue(
    entries,
    async (entry) => {
      invoked.push(entry);
      if (entry === 1) await new Promise((resolve) => setTimeout(resolve, 20));
      else await new Promise((resolve) => setTimeout(resolve, 1));
      if (entry === 2) {
        const error: any = new Error("AI daily limit reached");
        error.status = 429;
        throw error;
      }
      return entry;
    },
    { concurrency: 2 },
  );

  assert.deepEqual(invoked, [0, 1, 2]);
  assert.equal(result.successes.get(0), 0);
  assert.equal(result.successes.get(1), 1);
  assert.equal(result.failures.length, 499);
  assert.equal(result.failures[0].entry, 2);
  assert.match(result.failures[0].error, /daily limit/);
  assert.equal(result.failures.at(-1)?.entry, 500);
  assert.match(result.failures.at(-1)?.error ?? "", /لم يبدأ تحويل هذا الملف بسبب حد الاستخدام/);
});
