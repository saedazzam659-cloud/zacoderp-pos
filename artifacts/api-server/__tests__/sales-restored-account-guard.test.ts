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

test("sales creation tolerates stale restored counters and account overrides", () => {
  assert.match(salesRoute, /for \(let skipped = 0; fromSeq != null; skipped \+= 1\)/);
  assert.match(salesRoute, /eq\(salesInvoicesTable\.docNumber, fromSeq\)/);
  assert.match(salesRoute, /fromSeq = await allocateSequenceNumber\(\)/);
  assert.match(salesRoute, /validAccountIds/);
  assert.match(salesRoute, /eq\(accountsTable\.companyId, cid\)/);
  assert.match(salesRoute, /pg_get_serial_sequence\('sales_invoices', 'id'\)/);
});

test("sales creation unwraps database causes instead of returning the full SQL query", () => {
  assert.match(salesRoute, /postgresErrorField\(error, "code"\)/);
  assert.match(salesRoute, /Failed query:/);
  assert.match(salesRoute, /salesInvoiceWriteError\(e\)/);
  assert.match(salesRoute, /sales invoice create failed/);
});

test("sales-return creation has the same post-restore protections", () => {
  assert.match(salesRoute, /allocateReturnNumber/);
  assert.match(salesRoute, /eq\(salesReturnsTable\.docNumber, fromSeq\)/);
  assert.match(salesRoute, /validReturnAccountIds/);
  assert.match(salesRoute, /pg_get_serial_sequence\('sales_returns', 'id'\)/);
  assert.match(salesRoute, /salesReturnWriteError\(e\)/);
  assert.match(salesRoute, /sales return create failed/);
});