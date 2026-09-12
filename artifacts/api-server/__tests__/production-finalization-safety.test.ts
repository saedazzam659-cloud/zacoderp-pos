import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TransactionFailure, transactionFailureResponse } from "../src/lib/transactionFailure.js";

test("source allocation save uses its transaction and includes unreversed driver capacity", async () => {
  const source = await readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8");
  const start = source.indexOf("for (const a of requested)");
  const end = source.indexOf("snapshots.push(", start);
  assert.ok(start > 0 && end > start);
  const save = source.slice(start, end);
  assert.doesNotMatch(save, /\bq\.select|\brange\.|\ballocationRows\b/);
  assert.match(save, /usedDeltas[\s\S]*?await tx\.select/);
  assert.match(save, /isNull\(productionDriverReconciliationsTable\.reversalJournalEntryId\)/);
  assert.match(save, /assertAllocationCapacity\(source\.sourceAmount, num\(used\?\.amount\) \+ num\(usedDeltas\?\.amount\), amount\)/);
});

test("overhead closure counts each active driver delta without mutating planned allocations", async () => {
  const source = await readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function buildOverheadClosureSnapshot");
  const end = source.indexOf("const journalIds = sourceJournalIds", start);
  const closure = source.slice(start, end);
  assert.match(closure, /inArray\(productionDriverReconciliationsTable\.baseAllocationId, allocationIds\)/);
  assert.match(closure, /isNull\(productionDriverReconciliationsTable\.reversalJournalEntryId\)/);
  assert.match(closure, /current\.amount = round2[\s\S]*?driverDeltaByAllocation\.get\(Number\(row\.allocationId\)\)/);
  assert.doesNotMatch(closure, /row\.allocatedAmount\s*=/);
});

test("driver reconciliation reads wizard formula snapshots with legacy compatibility", async () => {
  const source = await readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8");
  const wizard = source.slice(source.indexOf("export async function productionWizardHandler"),
    source.indexOf("async function reconcileFinalStageDrivers"));
  const reconciliation = source.slice(source.indexOf("async function reconcileFinalStageDrivers"),
    source.indexOf("function productionStatusPermission"));
  assert.match(wizard, /formulaNumerator:/);
  assert.match(wizard, /formulaDenominator:/);
  assert.match(reconciliation, /meta\.formulaNumerator \?\? meta\.numerator/);
  assert.match(reconciliation, /meta\.formulaDenominator \?\? meta\.denominatorOrRate/);
});

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
  assert.match(reconciliation, /!\["done", "skipped"\]\.includes\(stage\.status\)/);
  assert.doesNotMatch(reconciliation, /!\["completed", "skipped"\]\.includes\(stage\.status\)/);
  assert.match(reconciliation, /if \(lines\.length > 0\) \{[\s\S]*?if \(Math\.abs\(net\) >= 0\.005\)/);
  assert.match(reconciliation, /journalId = await createJournalEntry\([\s\S]*?dx: tx/);
});