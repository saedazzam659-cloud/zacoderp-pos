import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/lib/ensureSchema.ts", import.meta.url), "utf8");
const activeRunHealStart = source.lastIndexOf("async function runHeal(");
const shared = source.slice(activeRunHealStart, source.indexOf("export async function ensureInvoiceCreateIdempotencySchema"));
const required = [
  "contracting_settings",
  "contracting_bill_lines",
  "contracting_bill_deductions",
  "contracting_bill_penalties",
  "contracting_bill_attachments",
  "contracting_bill_workflow_events",
];
const detailTables = required.filter((table) => table !== "contracting_settings");

test("contracting tables are created in the shared pass before strict validation", () => {
  const settingsCreate = shared.indexOf("await ensureContractingSettingsTable()");
  const create = shared.indexOf("await ensureContractingBillDetailsTables()");
  const validate = shared.indexOf("const r = await ensureColumns(");
  assert.ok(settingsCreate >= 0 && create > settingsCreate && validate > create);
  assert.ok(shared.indexOf("await ensureContractingCostCenterCompatibility()") < create);
});

test("contracting integrity prerequisites precede column heal and validation follows it", () => {
  const prerequisite = shared.indexOf("await ensureContractingProjectIntegrityPrerequisites()");
  const columnHeal = shared.indexOf("const r = await ensureColumns(");
  const validation = shared.indexOf("await ensureContractingProjectIntegrity()");
  assert.ok(prerequisite >= 0 && prerequisite < columnHeal && columnHeal < validation);
});

test("startup, manual upgrade and request readiness all use the shared pass", () => {
  for (const name of ["ensureSchemaUpToDate", "runSchemaHealOnActiveDb", "runAgentRequestSchemaHealOnActiveDb"]) {
    const start = source.search(new RegExp(`export (?:async )?function ${name}\\(`));
    assert.ok(start >= 0);
    const next = source.indexOf("\nexport ", start + 1);
    const body = source.slice(start, next < 0 ? undefined : next);
    assert.match(body, /(?:await|return) runHeal\(/, name);
    for (const table of required) assert.ok(!body.includes(`"${table}"`), `${table} must not be optional`);
  }
});

test("required contracting tables have additive DDL and no cross-database promise cache", () => {
  const settings = readFileSync(new URL("../src/lib/contracting-settings.ts", import.meta.url), "utf8");
  assert.match(settings, /CREATE TABLE IF NOT EXISTS contracting_settings/);
  assert.match(settings, /getActiveExternalDb/);
  assert.match(settings, /WeakMap/);
  assert.doesNotMatch(settings, /\bsettingsTablePromise\b/);
  assert.doesNotMatch(settings, /\b(?:DROP|TRUNCATE)\s+(?:TABLE|INDEX|TYPE)\b|\bDELETE\s+FROM\b/i);

  const service = readFileSync(new URL("../src/lib/contracting-bill-details-service.ts", import.meta.url), "utf8");
  const start = service.indexOf("export function ensureContractingBillDetailsTables");
  const end = service.indexOf("\nasync function ", start);
  const ddl = service.slice(start, end);
  for (const table of detailTables) assert.ok(ddl.includes(`CREATE TABLE IF NOT EXISTS ${table}`), table);
  assert.doesNotMatch(ddl, /\b(?:tablesReady|healPromise)\b/);
});

test("guarantee runtime DDL creates all external-agent composite targets first", () => {
  const storage = readFileSync(new URL("../src/lib/contracting-guarantees-storage.ts", import.meta.url), "utf8");
  const tenderCreate = storage.indexOf("CREATE TABLE IF NOT EXISTS contracting_tenders");
  assert.ok(tenderCreate > 0);
  for (const prerequisite of [
    "ctg_proj_company_id_id_uq",
    "ctg_oc_company_project_id_uq",
    "ctg_sc_company_project_id_uq",
    "bank_accounts_company_id_id_uq",
    "customers_company_id_id_uq",
  ]) {
    assert.ok(storage.indexOf(`CREATE UNIQUE INDEX IF NOT EXISTS ${prerequisite}`) < tenderCreate, prerequisite);
  }
  assert.ok(storage.indexOf("ctg_tender_company_project_id_uq") < storage.indexOf("ctg_guarantee_tender_project_fk"));
  assert.ok(storage.indexOf("ctg_guarantee_company_project_id_uq") < storage.indexOf("ctg_guarantee_parent_project_fk"));
});