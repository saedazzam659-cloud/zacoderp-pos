import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { carryForwardAnnualSequenceNumber } from "../src/lib/sequences.js";

const root = resolve(import.meta.dirname, "../../..");
const sequenceApi = readFileSync(resolve(root, "artifacts/api-server/src/routes/sequences.ts"), "utf8");
const sequenceLibrary = readFileSync(resolve(root, "artifacts/api-server/src/lib/sequences.ts"), "utf8");
const adminSequenceReset = readFileSync(resolve(root, "artifacts/api-server/src/routes/admin-sequence-reset.ts"), "utf8");
const companyDefaults = readFileSync(resolve(root, "artifacts/api-server/src/lib/newCompanyDefaults.ts"), "utf8");
const companyTemplate = readFileSync(resolve(root, "artifacts/api-server/src/lib/companyTemplate.ts"), "utf8");
const sequenceSchema = readFileSync(resolve(root, "lib/db/src/schema/sequences.ts"), "utf8");
const sequenceUi = readFileSync(resolve(root, "artifacts/zatca-invoicing/src/pages/settings/Sequences.tsx"), "utf8");
const arabicLocale = readFileSync(resolve(root, "artifacts/zatca-invoicing/src/i18n/locales/ar.json"), "utf8");

test("annual reset is opt-in across new sequence creation paths", () => {
  assert.match(companyDefaults, /annualReset:\s*false/);
  assert.match(companyTemplate, /annualReset:\s*false/);
  assert.match(sequenceApi, /annualReset:\s*req\.body\.annualReset === true/);
  assert.match(sequenceApi, /annualReset:\s*false/);
  assert.match(sequenceSchema, /annualReset:\s*boolean\("annual_reset"\)\.notNull\(\)\.default\(false\)/);
  assert.match(sequenceUi, /annualReset:\s*false/);
  assert.match(sequenceUi, /r\.annualReset \?\? false/);
  assert.match(arabicLocale, /خيار إضافي غير مفعّل افتراضيًا/);
});

test("turning annual reset off carries forward the highest saved number", () => {
  assert.equal(carryForwardAnnualSequenceNumber(1, 1, 84, 83), 84);
  assert.equal(carryForwardAnnualSequenceNumber(1, 90, 84, 89), 90);
  assert.equal(carryForwardAnnualSequenceNumber(1, 1, null, 105), 106);
  assert.match(sequenceApi, /existing\.annualReset === true && !merged\.annualReset && !merged\.monthlyReset/);
  assert.match(sequenceLibrary, /hasAnnualSequenceCounters\(tx, seq\.id\)/);
  assert.match(sequenceApi, /hasAnnualSequenceCounters\(db, seq\.id\)/);
  assert.match(sequenceLibrary, /counterBranchKey = 0/);
  assert.match(sequenceApi, /counterBranchKey = 0/);
});

test("bulk disable previews every configured database and preserves unsafe cases", () => {
  assert.match(adminSequenceReset, /agentInstancesTable\.dbStatus/);
  assert.match(adminSequenceReset, /runWithExternalDb\(context/);
  assert.match(adminSequenceReset, /WHERE s\.annual_reset = TRUE/);
  assert.match(adminSequenceReset, /c\.deleted_at IS NULL/);
  assert.match(adminSequenceReset, /FOR UPDATE OF s/);
  assert.match(adminSequenceReset, /candidate\.nextNumber > candidate\.endNumber/);
  assert.match(adminSequenceReset, /SET annual_reset = FALSE/);
  assert.match(adminSequenceReset, /current_number = \$\{nextNumber\}/);
  assert.match(adminSequenceReset, /fiscal_year_sequence_policy:%/);
  assert.match(adminSequenceReset, /Preflight every database before the first write/);
});

test("SuperAdmin can review and disable annual reset for one company and database scope", () => {
  assert.match(adminSequenceReset, /router\.get\("\/companies\/:id\/preview"/);
  assert.match(adminSequenceReset, /router\.post\("\/companies\/:id\/disable"/);
  assert.match(adminSequenceReset, /getCompanyDatabaseScope\(req\)/);
  assert.match(adminSequenceReset, /getCandidates\(database, false, companyId\)/);
  assert.match(adminSequenceReset, /getCandidates\(tx, true, companyId\)/);
  assert.match(adminSequenceReset, /key LIKE \$\{`fiscal_year_sequence_policy:\$\{companyId\}:%`\}/);
  assert.match(adminSequenceReset, /action: "disable_annual_reset_company"/);
  assert.match(adminSequenceReset, /AND s\.company_id = \$\{companyId\}/);

  const companiesUi = readFileSync(resolve(root, "artifacts/zatca-invoicing/src/pages/Companies.tsx"), "utf8");
  assert.match(companiesUi, /button-company-annual-reset-/);
  assert.match(companiesUi, /companies\/\$\{target\.id\}\/preview/);
  assert.match(companiesUi, /companies\/\$\{annualResetCompanyTarget\.id\}\/disable/);
  assert.match(companiesUi, /status-company-annual-reset-preview/);
  assert.match(companiesUi, /button-apply-company-annual-sequence-reset/);
});
