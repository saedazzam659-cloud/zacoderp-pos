import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const protection = readFileSync(
  new URL("../src/lib/sequenceProtection.ts", import.meta.url),
  "utf8",
);
const adminRoute = readFileSync(
  new URL("../src/routes/admin.ts", import.meta.url),
  "utf8",
);
const companyDetails = readFileSync(
  new URL("../../zatca-invoicing/src/pages/CompanyDetails.tsx", import.meta.url),
  "utf8",
);

test("retroactive sequence protection backfills every mapped numbered table", () => {
  assert.match(protection, /\["journal_entries",\s*"doc_number"\]/);
  assert.match(protection, /zacode_backfill_sequence_protection\(target_company_id INTEGER\)/);
  assert.match(protection, /SELECT \* FROM \(VALUES\s+\$\{targetValues\}/);
  assert.match(protection, /NULLIF\(BTRIM\(%I::TEXT\), ''''\) IS NOT NULL/);
  assert.match(protection, /NOT COALESCE\(is_sequence_protected, FALSE\)/);
  assert.match(protection, /GET DIAGNOSTICS protected_rows = ROW_COUNT/);
});

test("activation and numbered-row writes serialize around one atomic backfill", () => {
  const activation = protection.slice(
    protection.indexOf("export async function setCompanySequenceProtectionEnabled"),
    protection.indexOf("/**\n * Install an additive marker"),
  );
  assert.ok(activation.indexOf("pg_advisory_xact_lock") < activation.indexOf(".set({ sequenceProtectionEnabled: enabled })"));
  assert.ok(activation.indexOf(".set({ sequenceProtectionEnabled: enabled })") < activation.indexOf("zacode_backfill_sequence_protection"));
  assert.match(protection, /pg_advisory_xact_lock\(\$\{SEQUENCE_PROTECTION_LOCK_NAMESPACE\}, company_id_value\)/);
  assert.match(protection, /pg_advisory_xact_lock\(\$\{SEQUENCE_PROTECTION_LOCK_NAMESPACE\}, previous_company_id\)/);
  assert.match(protection, /IF issued_number IS DISTINCT FROM previous_number\s+OR company_id_value IS DISTINCT FROM previous_company_id THEN/);
});

test("SuperAdmin route and company screen report the retroactive sweep", () => {
  assert.match(adminRoute, /import \{ setCompanySequenceProtectionEnabled \} from "\.\.\/lib\/sequenceProtection\.js"/);
  assert.match(adminRoute, /setCompanySequenceProtectionEnabled\(companyId, req\.body\.enabled\)/);
  assert.match(adminRoute, /protectedExistingRecords: updated\.protectedExistingRecords/);
  assert.match(companyDetails, /السجلات المرقمة الموجودة فوراً، بما فيها المسودات وقيود اليومية/);
  assert.match(companyDetails, /protectedExistingRecords/);
});