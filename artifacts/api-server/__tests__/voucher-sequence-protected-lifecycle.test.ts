import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const receiptRoute = readFileSync(
  new URL("../src/routes/receipt-vouchers.ts", import.meta.url),
  "utf8",
);
const paymentRoute = readFileSync(
  new URL("../src/routes/payment-vouchers.ts", import.meta.url),
  "utf8",
);
const cashSchema = readFileSync(
  new URL("../../../lib/db/src/schema/cash.ts", import.meta.url),
  "utf8",
);

for (const [name, route, entryType] of [
  ["receipt", receiptRoute, "receipt"],
  ["payment", paymentRoute, "payment"],
] as const) {
  test(`${name} voucher retains and rebuilds protected source entries`, () => {
    assert.match(route, /draftLinkedSourceJournalEntry/);
    assert.match(route, /getLinkedSourceJournalEntry/);
    assert.match(route, /replaceLinkedSourceJournalEntry/);
    assert.match(route, new RegExp(`entryType: "${entryType}"`));
    assert.match(route, /!!v\.isSequenceProtected \|\| !!linkedEntry\?\.isSequenceProtected/);
    assert.match(route, /\.set\(retainJournal \? \{ status: "draft" \} : \{ status: "draft", journalEntryId: null \}\)/);
    assert.match(route, /entryId: v\.journalEntryId/);
    assert.match(route, /lines: jeLines/);
  });
}

test("receipt and payment voucher schemas carry their sequence-protection marker", () => {
  assert.equal(
    (cashSchema.match(/isSequenceProtected: boolean\("is_sequence_protected"\)/g) ?? []).length,
    2,
  );
});