import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const salesRoute = readFileSync(resolve(here, "../src/routes/sales.ts"), "utf8");

test("sales posting replaces restored foreign-company account ids", () => {
  assert.match(salesRoute, /restoredAccountCandidates/);
  assert.match(salesRoute, /eq\(accountsTable\.companyId, cid\)/);
  assert.match(salesRoute, /resolveRestoredAccount\("revenue"\)/);
  assert.match(salesRoute, /defaultIdByCode\.get\(defaultCodes\[role\]\)/);
  assert.match(salesRoute, /salesAccountId: salesAccId/);
  assert.match(salesRoute, /taxAccountId: taxAccId/);
});

test("journal creation rejects every account that is outside the current company", () => {
  const start = salesRoute.indexOf("async function createJournalEntry");
  const end = salesRoute.indexOf("async function getCustomerAccountId", start);
  const helper = salesRoute.slice(start, end);

  assert.match(helper, /eq\(accountsTable\.companyId, opts\.companyId\)/);
  assert.match(helper, /invalidAccountIds/);
  assert.match(helper, /توجد حسابات محاسبية مستعادة لا تخص الشركة الحالية/);
  assert.ok(
    helper.indexOf("invalidAccountIds") < helper.indexOf("executor.insert(journalEntriesTable)"),
    "account ownership must be checked before the journal header is inserted",
  );
});

test("credit sales repairs a restored customer ledger inside the posting transaction", () => {
  const start = salesRoute.indexOf("async function getCustomerAccountId");
  const end = salesRoute.indexOf("async function getCashBoxAccountId", start);
  const helper = salesRoute.slice(start, end);

  assert.match(helper, /eq\(accountsTable\.companyId, cid\)/);
  assert.match(helper, /ensureCustomerLedger\(cid, c\.nameAr, false, undefined, executor\)/);
  assert.match(helper, /set\(\{ accountId: repairedAccountId/);
  assert.match(salesRoute, /getCustomerAccountId\(cid, inv\.customerId, tx\)/);
});