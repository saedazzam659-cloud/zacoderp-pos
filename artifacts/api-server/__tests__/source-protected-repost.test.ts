import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const accountNotesRoute = readFileSync(
  new URL("../src/routes/account-notes.ts", import.meta.url),
  "utf8",
);
const employeesRoute = readFileSync(
  new URL("../src/routes/employees.ts", import.meta.url),
  "utf8",
);
const employeeCustodiesRoute = readFileSync(
  new URL("../src/routes/employee-custodies.ts", import.meta.url),
  "utf8",
);
const hrJournals = readFileSync(
  new URL("../src/lib/hr-journals.ts", import.meta.url),
  "utf8",
);

test("account-note protected unpost retains and drafts the linked entry, then rebuilds it", () => {
  assert.match(accountNotesRoute, /draftLinkedSourceJournalEntry\(\s*tx, cid, current\.journalEntryId/);
  assert.match(accountNotesRoute, /replaceLinkedSourceJournalEntry\(tx, \{/);
  assert.match(accountNotesRoute, /sequenceProtected: !!\(n as any\)\.isSequenceProtected/);
  assert.match(accountNotesRoute, /retainLinkedEntry \? \{ journalEntryId: null \} : \{\}/);
});

test("payroll protected unpost retains postedJournalId and repost rebuilds that same JE", () => {
  assert.match(employeesRoute, /buildPayrollJournal\(cid, id, tx, run\.postedJournalId\)/);
  assert.match(employeesRoute, /draftLinkedSourceJournalEntry\(tx, cid, run\.postedJournalId, "payroll_run"\)/);
  assert.match(employeesRoute, /retainLinkedEntry \? \{ postedJournalId: null \} : \{\}/);
  assert.match(hrJournals, /replaceLinkedSourceJournalEntry\(dx, \{/);
  assert.match(hrJournals, /entryId: retainedEntry\.id/);
});

test("payroll payment unpay drafts protected entries and repay rebuilds the retained payment JE", () => {
  assert.match(employeesRoute, /draftLinkedSourceJournalEntry\(tx, cid, run\.paymentJournalId, "payroll_payment"\)/);
  assert.match(employeesRoute, /buildPayrollPaymentJournal\(cid, id, payDate, source, tx, run\.paymentJournalId\)/);
  assert.match(employeesRoute, /paymentJournalId: null/);
  assert.match(hrJournals, /entryType: "payroll_payment"/);
  assert.match(hrJournals, /entryId: retainedEntry\.id/);
});

test("custody settlement deletion refuses protected linked journal entries", () => {
  assert.match(employeeCustodiesRoute, /linkedEntry as any\)\?\.isSequenceProtected/);
  assert.match(employeeCustodiesRoute, /لا يمكن حذف التسوية لأن القيد المحاسبي المرتبط محمي/);
  assert.match(employeeCustodiesRoute, /status: 409/);
});