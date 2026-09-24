import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const project = readFileSync(new URL("../src/pages/ContractingProjectDetail.tsx", import.meta.url), "utf8");
const accounting = readFileSync(new URL("../src/components/ContractingAccountingPanel.tsx", import.meta.url), "utf8");

test("bill edit exposes unapprove for eligible approved/posted statuses, not a manual status transition", () => {
  assert.match(project, /editingBillId && \["approved", "posted", "partially_paid", "paid"\]\.includes\(String\(editing\.status\)\)/);
  assert.match(project, /!editing\.reversalJournalEntryId && canUnapprove/);
  assert.match(project, /data-testid="button-unapprove-contracting-bill"/);
  assert.match(project, /\/unapprove`, \{\s*method: "POST"/);
  assert.match(project, /\/api\/contracting\/bills\/\$\{bill\.id\}\/unapprove/);
  assert.match(project, /disabled: \["approved","posted","partially_paid","paid"\]\.includes\(x\)/);
});

test("unapprove respects granular contracting and document unpost permissions", () => {
  assert.match(project, /contractingPermissions\?\.cancel === true/);
  assert.match(project, /contractingPermissions\?\.cancel === undefined && contractingPermissions\?\.unpost === true/);
  assert.match(project, /postingPermissions\?\.\[direction === "incoming" \? "ctgIncomingBill" : "ctgOutgoingBill"\]\?\.unpost !== false/);
  assert.match(accounting, /canUnapprove && \(user\?\.role === "admin"/);
});

test("both entry points explain safe draft-JE cancellation and surface server dependency errors", () => {
  assert.match(project, /إذا كان مسودة فسيُلغى بأمان دون قيد عكسي/);
  assert.match(accounting, /وإن كان مسودة فسيُلغى دون قيد عكسي/);
  assert.match(project, /result\.originalJournalEntryId/);
  assert.doesNotMatch(project, /\/api\/journal-entries\/\$\{bill\.journalEntryId\}/);
  assert.match(project, /result\.error \|\| `تعذر فك الاعتماد/);
  assert.match(accounting, /if \(!response\.ok\) throw new Error\(data\.error/);
  assert.match(project, /setEditing\(null\);\s*await load\(\)/);
  assert.match(accounting, /await reload\(\)/);
});