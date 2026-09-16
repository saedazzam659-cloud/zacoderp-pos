import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/components/ContractingAccountingPanel.tsx", import.meta.url),
  "utf8",
);

test("posted bill receipt/payment settlements expose a confirmed reversal action", () => {
  assert.match(source, /async function reverseSettlement\(settlement: Settlement\)/);
  assert.match(source, /window\.confirm\(/);
  assert.match(source, /\/api\/contracting\/settlements\/\$\{settlement\.id\}\/reverse/);
  assert.match(source, /\["bill_receipt", "bill_payment"\]\.includes\(row\.kind\) && row\.status === "posted"/);
  assert.match(source, /button-reverse-settlement-\$\{row\.id\}/);
});

test("reversal refreshes the settlement and bill projections", () => {
  assert.match(source, /await reload\(\)/);
  assert.match(source, /row\.status === "reversed"/);
  assert.match(source, /reversal_journal_entry_id/);
});