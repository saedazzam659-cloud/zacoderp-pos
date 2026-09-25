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

test("agent BOQ creation precedes bill/accounting dependencies and strict validation", () => {
  const boq = shared.indexOf("if (getActiveExternalDb()) await ensureContractingBoqTables()");
  const billDetails = shared.indexOf("await ensureContractingBillDetailsTables()");
  const accounting = shared.indexOf("await ensureContractingAccountingTables()");
  const validate = shared.indexOf("const r = await ensureColumns(");
  assert.ok(boq > 0 && boq < billDetails && billDetails < accounting && accounting < validate);
  const earlierPass = source.slice(source.indexOf("async function runHeal("), activeRunHealStart);
  assert.match(earlierPass, /if \(getActiveExternalDb\(\)\) await ensureContractingBoqTables\(\)/);
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
  for (const column of [
    "quoted_unit_price_snapshot", "quoted_vat_percent_snapshot",
    "quoted_price_includes_vat_snapshot", "quoted_price_components_snapshot",
  ]) assert.ok(ddl.includes(`ADD COLUMN IF NOT EXISTS ${column}`), column);
  assert.doesNotMatch(ddl, /\b(?:tablesReady|healPromise)\b/);
});

test("BOQ draft saves, read projections and approval share extended quoted-price snapshots", () => {
  const service = readFileSync(new URL("../src/lib/contracting-bill-details-service.ts", import.meta.url), "utf8");
  const approval = readFileSync(new URL("../src/lib/contracting-boq-recertification.ts", import.meta.url), "utf8");
  assert.match(service, /quotedPriceComponents: terms\.quotedPriceComponents/);
  assert.match(service, /quotedBoqComponentsNet\(terms\.quantity, terms\.quotedPriceComponents\)/);
  assert.match(service, /quotedPriceComponentsSnapshot: terms\.quotedPriceComponents/);
  assert.match(approval, /quotedPriceComponents: terms\.quotedPriceComponents/);
  assert.match(approval, /quotedBoqComponentsNet\(terms\.quantity, terms\.quotedPriceComponents\)/);
  assert.match(approval, /quotedPriceComponentsSnapshot: terms\.quotedPriceComponents/);
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

test("WBS actual-cost reads do not perform central DDL", () => {
  const service = readFileSync(new URL("../src/lib/contracting-cost-allocation-service.ts", import.meta.url), "utf8");
  const start = service.indexOf("async function contractingExecutionActualCosts(");
  const end = service.indexOf("const eventsResult = await db.execute(", start);
  const readiness = service.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(readiness, /if \(getActiveExternalDb\(\)\) \{\s*await Promise\.all\(\[\s*ensureContractingCostAllocationTables\(\),\s*ensureContractingAccountingTables\(\)/);
});

test("contracting read middleware also guards central tender/guarantee reads during background reconciliation", () => {
  const routes = readFileSync(new URL("../src/routes/contracting.ts", import.meta.url), "utf8");
  const start = routes.indexOf("router.use(async (req, res, next) => {");
  const end = routes.indexOf("// The old router only checked", start);
  const readiness = routes.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(readiness, /if \(getActiveExternalDb\(\)\) \{\s*await ensureContractingBoqTables\(\);\s*await ensureContractingProjectIntegrity\(\);\s*await ensureContractingExecutionSchema\(\);\s*await ensureContractingGuaranteeTables\(\);/);
  assert.match(readiness, /else if \(req\.path\.startsWith\("\/tenders"\) \|\| req\.path\.startsWith\("\/guarantees"\)/);
});