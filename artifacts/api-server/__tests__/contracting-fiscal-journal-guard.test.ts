import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FISCAL_ADVANCE_JE_TYPE, isFiscalAdvanceJournalLocked } from "../src/lib/contracting-fiscal-journal-guard.js";

test("accepted 386 journal stays locked by entry type or authoritative source link",()=>{
  assert.equal(isFiscalAdvanceJournalLocked(FISCAL_ADVANCE_JE_TYPE,false),true);
  assert.equal(isFiscalAdvanceJournalLocked("general",true),true);
  assert.equal(isFiscalAdvanceJournalLocked("general",false),false);
});

test("generic journal mutation and rescue paths use fiscal source protection",()=>{
  const route=readFileSync(new URL("../src/routes/journalEntries.ts",import.meta.url),"utf8");
  assert.match(route,/const LOCKED_ENTRY_TYPES = \[[\s\S]*?FISCAL_ADVANCE_JE_TYPE/);
  assert.match(route,/async function ensureNotLocked[\s\S]*?hasFiscalAdvanceSource\(id,cid\)/);
  assert.match(route,/router\.put\("\/:id"[\s\S]*?ensureNotLocked\(id, cid\)/);
  assert.match(route,/router\.post\("\/:id\/unpost"[\s\S]*?ensureNotLocked\(id, cid\)/);
  assert.match(route,/router\.delete\("\/:id"[\s\S]*?ensureNotLocked\(id, cid\)/);
  assert.match(route,/router\.post\("\/:id\/convert-to-general"[\s\S]*?isFiscalAdvanceJournalLocked\(et,await hasFiscalAdvanceSource\(id,cid\)\)/);
  assert.match(route,/router\.post\("\/:id\/post"[\s\S]*?isFiscalAdvanceJournalLocked\(existing\.entryType,await hasFiscalAdvanceSource\(id,cid\)\)/);
});

test("issued 388 locks source bill corrections and ordinary bills need no 386 application",()=>{
  const fiscal=readFileSync(new URL("../src/lib/contracting-fiscal-service.ts",import.meta.url),"utf8");
  const accounting=readFileSync(new URL("../src/lib/contracting-accounting-service.ts",import.meta.url),"utf8");
  assert.doesNotMatch(fiscal,/if \(!applications\.length\) fail/);
  assert.match(fiscal,/const adjustments=\[\.\.\.grouped\.values\(\)\]/);
  assert.match(fiscal,/vat !== \(base \* 15n \+ 50n\) \/ 100n/);
  for (const name of ["unapproveBill","createPostedCorrection","billMutationGuard"]) {
    const section=accounting.split(`export async function ${name}(`)[1];
    assert.ok(section,`${name} must exist`);
    assert.match(section.slice(0,4200),/contracting_fiscal_invoices/,`${name} must guard issued fiscal source`);
  }
});