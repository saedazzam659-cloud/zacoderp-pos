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