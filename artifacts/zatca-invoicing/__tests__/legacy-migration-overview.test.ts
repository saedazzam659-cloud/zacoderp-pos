import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("legacy migration overview links the supported RAGM transaction import flows", async () => {
  const source = await readFile(new URL("../src/pages/settings/DataImportExport.tsx", import.meta.url), "utf8");

  assert.match(source, /value="overview" data-testid="tab-legacy-migration-plan"/);
  assert.match(source, /Migrate company history from RAGM Cloud/);
  assert.match(source, /ترحيل تاريخ الشركة من RAGM Cloud/);
  assert.match(source, /سندات القبض والصرف/);
  assert.match(source, /الإشعارات المدينة والدائنة/);
  assert.match(source, /Each voucher can link to one posted invoice/);
  assert.match(source, /استورد السندات من Excel أو CSV/);
  assert.match(source, /onOpenDocuments/);
  assert.match(source, /onOpenJournal/);
  assert.match(source, /onOpenCashNotes/);
  assert.match(source, /value="cash-notes" data-testid="tab-historical-cash-notes"/);
});

test("historical voucher and note imports use existing post routes and annual sequence preflight", async () => {
  const source = await readFile(new URL("../src/pages/settings/HistoricalCashNotesMigration.tsx", import.meta.url), "utf8");
  const sequenceTypes = await readFile(new URL("../../../lib/db/src/schema/sequences.ts", import.meta.url), "utf8");

  assert.match(source, /\/api\/receipt-vouchers/);
  assert.match(source, /\/api\/payment-vouchers/);
  assert.match(source, /\/api\/account-notes/);
  assert.match(source, /preflightPostedSequences/);
  assert.match(source, /checkbox-post-historical-financial/);
  assert.match(source, /legacy_ragmcloud/);
  assert.match(source, /RAGM:\$\{sourceNumber\}/);
  assert.match(source, /salesInvoiceId/);
  assert.match(source, /purchaseInvoiceId/);
  assert.match(sequenceTypes, /account_note_customer_debit/);
  assert.match(sequenceTypes, /account_note_supplier_credit/);
});
