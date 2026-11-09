import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const apiSource = readFileSync(resolve(import.meta.dirname, "../src/routes/admin.ts"), "utf8");
const uiSource = readFileSync(resolve(import.meta.dirname, "../../zatca-invoicing/src/pages/Companies.tsx"), "utf8");
const routeStart = apiSource.indexOf('router.post("/companies/:id/journal-sequence-control/gap-fill"');
const routeEnd = apiSource.indexOf("// PUT /api/admin/companies/:id/journal-sequence-control", routeStart);
const gapFillRoute = apiSource.slice(routeStart, routeEnd);

test("SuperAdmin gap-fill restores requested journal numbers as atomic empty drafts", () => {
  assert.notEqual(routeStart, -1);
  assert.match(gapFillRoute, /requireSuperAdmin/);
  assert.match(gapFillRoute, /runWithAgentScope\(req, res/);
  assert.match(gapFillRoute, /rawDocNumbers\.length > 50/);
  assert.match(gapFillRoute, /assertWritableForDate\(companyId, entryDate, tx\)/);
  assert.match(gapFillRoute, /pg_advisory_xact_lock\(\$\{companyId\}, 1001\)/);
  assert.match(gapFillRoute, /ensureJournalNumberClaimsTable\(tx\)/);
  assert.match(gapFillRoute, /SELECT ref_table, ref_id[\s\S]*FOR UPDATE/);
  assert.match(gapFillRoute, /UPDATE journal_number_claims[\s\S]*ref_table = 'journal_entries', ref_id = 'gap_fill'/);
  assert.match(gapFillRoute, /يوجد قيد فعلي بالرقم/);
  assert.match(gapFillRoute, /recoveredClaimNumbers/);
  assert.match(gapFillRoute, /recoveredClaimSources/);
  assert.match(gapFillRoute, /ON CONFLICT \(company_id, doc_number\) DO NOTHING/);
  assert.match(gapFillRoute, /entryType: "general"/);
  assert.match(gapFillRoute, /status: "draft"/);
  assert.match(gapFillRoute, /sequenceCounterChanged: false/);
  assert.doesNotMatch(gapFillRoute, /UPDATE sequence_counters|UPDATE sequences/);
  assert.match(gapFillRoute, /await db\.transaction\(async \(tx\)/);
});

test("Companies UI separates gap restoration from existing-entry correction", () => {
  assert.match(uiSource, /استرجاع الأرقام المفقودة/);
  assert.match(uiSource, /QYD\/10\/3178\\nQYD\/10\/3179/);
  assert.match(uiSource, /journal-sequence-control\/gap-fill/);
  assert.match(uiSource, /لم يتغير العداد/);
  assert.match(uiSource, /حتى لو كان الحجز من عملية أو قيد سابق/);
  assert.match(uiSource, /تصحيح الرقم الموجود يظل للقيود الخاطئة فقط/);
});
