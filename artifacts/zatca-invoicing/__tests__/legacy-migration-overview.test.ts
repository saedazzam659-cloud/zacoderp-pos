import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("legacy migration overview states supported RAGM flows and incomplete transaction types", async () => {
  const source = await readFile(new URL("../src/pages/settings/DataImportExport.tsx", import.meta.url), "utf8");

  assert.match(source, /value="overview" data-testid="tab-legacy-migration-plan"/);
  assert.match(source, /Migrate company history from RAGM Cloud/);
  assert.match(source, /ترحيل تاريخ الشركة من RAGM Cloud/);
  assert.match(source, /سندات القبض والصرف/);
  assert.match(source, /الإشعارات المدينة والدائنة/);
  assert.match(source, /This flow does not import vouchers yet/);
  assert.match(source, /هذا المسار لا يستوردها بعد/);
  assert.match(source, /onOpenDocuments/);
  assert.match(source, /onOpenJournal/);
});
