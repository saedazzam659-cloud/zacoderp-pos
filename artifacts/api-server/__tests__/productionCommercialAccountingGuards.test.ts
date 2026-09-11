import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const production = await readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8");
const purchasing = await readFile(new URL("../src/routes/purchasing.ts", import.meta.url), "utf8");
const schema = await readFile(new URL("../src/lib/ensureSchema.ts", import.meta.url), "utf8");

test("commercial fact keys exclude posting date and support immutable reversal generations", () => {
  const key = production.slice(production.indexOf("function canonicalFactKey("), production.indexOf("function sourceKeyGeneration("));
  assert.match(key, /new Set\(sourceIds\)/);
  assert.match(key, /period\.from/);
  assert.doesNotMatch(key, /postingDate|req\.body/);
  assert.match(production, /latestGeneration\.row\.status !== "reversed"/);
  assert.match(production, /priorFrom <= to && from <= priorTo/);
  assert.match(production, /latestGeneration\.generation \+ 1/);
});

test("royalty clearing requires an exact accrual binding and posts through the transaction", () => {
  assert.match(purchasing, /accrual\.settlementId == null \|\| Number\(accrual\.settlementId\) !== id/);
  assert.match(purchasing, /existing\.sourceKey !== expectedSourceKey/);
  const clearing = purchasing.slice(purchasing.indexOf('entryType: "production_royalty_settlement_clearing"'));
  const lines = clearing.slice(0, clearing.indexOf("const [posted]"));
  assert.match(lines, /status: "posted"/);
  assert.match(lines, /dx: tx/);
  assert.match(lines, /accountId: accruedLiabilityAccountId,\s*debit:/);
  assert.match(lines, /accountId: supplierApAccountId,\s*credit:/);
  assert.match(purchasing, /entryType: "production_royalty_settlement_reversal"/);
});

test("legacy settlement action is rejected and linkage columns have additive migrations", () => {
  assert.match(production, /if \(req\.body\?\.settle === true\)/);
  assert.match(schema, /ADD COLUMN IF NOT EXISTS journal_entry_id INTEGER/);
  assert.match(schema, /ADD COLUMN IF NOT EXISTS reversal_journal_entry_id INTEGER/);
  assert.match(schema, /supplier_settlements_journal_entry_id_fkey/);
  assert.match(schema, /supplier_settlements_reversal_journal_entry_id_fkey/);
});