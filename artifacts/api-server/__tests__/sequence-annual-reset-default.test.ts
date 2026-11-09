import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { carryForwardAnnualSequenceNumber } from "../src/lib/sequences.js";

const root = resolve(import.meta.dirname, "../../..");
const sequenceApi = readFileSync(resolve(root, "artifacts/api-server/src/routes/sequences.ts"), "utf8");
const sequenceLibrary = readFileSync(resolve(root, "artifacts/api-server/src/lib/sequences.ts"), "utf8");
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
