import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TransactionFailure, transactionFailureResponse } from "../src/lib/transactionFailure.js";

test("validation rejection throws so transaction rolls back and preserves HTTP details", async () => {
  let committed = false;
  let rolledBack = false;
  const payload = { error: "Missing waste account", code: "WASTE_ACCOUNT_REQUIRED" };
  const fakeTransaction = async () => {
    try {
      const res = transactionFailureResponse();
      res.status(400).json(payload);
      committed = true;
    } catch (error) {
      rolledBack = true;
      throw error;
    }
  };
  await assert.rejects(fakeTransaction(), (e: unknown) =>
    e instanceof TransactionFailure && e.status === 400 && e.payload === payload);
  assert.equal(committed, false);
  assert.equal(rolledBack, true);
});

test("status rejection is transaction-local; balanced zero-net source transfers still create a JE", async () => {
  const source = await readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("export async function productionStatusHandler"));
  assert.match(handler, /db\.transaction\(async \(tx\) => \{[\s\S]*?const res = transactionFailureResponse\(\)/);
  assert.match(handler, /e instanceof TransactionFailure[\s\S]*?res\.status\(e\.status\)\.json\(e\.payload\)/);
  const reconciliation = source.slice(source.indexOf("async function reconcileFinalStageDrivers"), source.indexOf("function productionStatusPermission"));
  assert.match(reconciliation, /if \(lines\.length > 0\) \{[\s\S]*?if \(Math\.abs\(net\) >= 0\.005\)/);
  assert.match(reconciliation, /journalId = await createJournalEntry\([\s\S]*?dx: tx/);
});