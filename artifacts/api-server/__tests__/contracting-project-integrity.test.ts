import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  contractingContractBoqLinesTable,
  contractingProgressBillsTable,
  contractingProjectsTable,
} from "@workspace/db/schema";

const integritySource = readFileSync(
  new URL("../src/lib/contracting-integrity.ts", import.meta.url),
  "utf8",
);
const ensureSchemaSource = readFileSync(
  new URL("../src/lib/ensureSchema.ts", import.meta.url),
  "utf8",
);

function config(table: Parameters<typeof getTableConfig>[0]) {
  return getTableConfig(table);
}

test("project hierarchy is exported as a tenant-safe restrictive self reference", () => {
  const project = config(contractingProjectsTable);
  assert.ok(project.columns.some((column) => column.name === "parent_id"));
  assert.ok(project.indexes.some((index) => index.config.name === "ctg_proj_parent_idx"));
  assert.ok(project.foreignKeys.some((fk) => fk.getName() === "ctg_proj_parent_company_fk"));
  assert.ok(project.checks.some((check) => check.name === "ctg_proj_not_own_parent_ck"));
});

test("bills and BOQ expose exact-side and project-contract database constraints", () => {
  const bill = config(contractingProgressBillsTable);
  assert.ok(bill.checks.some((check) => check.name === "ctg_bill_exact_direction_contract_ck"));
  assert.deepEqual(
    bill.foreignKeys
      .map((fk) => fk.getName())
      .filter((name) => name.startsWith("ctg_bill_"))
      .sort(),
    ["ctg_bill_owner_contract_project_fk", "ctg_bill_subcontract_project_fk"],
  );

  const boq = config(contractingContractBoqLinesTable);
  assert.ok(boq.checks.some((check) => check.name === "ctg_boq_exact_direction_contract_ck"));
  for (const name of [
    "ctg_boq_owner_contract_project_fk",
    "ctg_boq_subcontract_project_fk",
    "ctg_boq_source_owner_project_item_fk",
  ]) {
    assert.ok(boq.foreignKeys.some((fk) => fk.getName() === name), name);
  }
});

test("shared reconciliation backfills only unique candidates and defers legacy validation", () => {
  assert.match(integritySource, /HAVING count\(\*\) = 1|1 = \(SELECT count\(\*\)/);
  assert.match(integritySource, /deferredValidation: invalid\.length > 0/);
  assert.match(integritySource, /NOT VALID/);
  assert.match(integritySource, /VALIDATE CONSTRAINT ctg_bill_exact_direction_contract_ck/);
  assert.match(integritySource, /progress_bill_contract/);
  assert.match(integritySource, /boq_source_owner/);
  assert.match(integritySource, /ADD COLUMN IF NOT EXISTS legacy_contract_link_pending BOOLEAN/);
  assert.match(integritySource, /SET legacy_contract_link_pending = TRUE/);
  assert.match(integritySource, /candidate\.legacy_contract_link_pending IS NULL/);
  assert.doesNotMatch(integritySource, /NOT COALESCE\(candidate\.legacy_contract_link_pending/);
  assert.match(integritySource, /ALTER COLUMN legacy_contract_link_pending SET NOT NULL/);
  assert.doesNotMatch(integritySource, /INSERT INTO contracting_(?:projects|owner_contracts|sub_contracts)/);

  const activeRunHealStart = ensureSchemaSource.lastIndexOf("async function runHeal(");
  const shared = ensureSchemaSource.slice(
    activeRunHealStart,
    ensureSchemaSource.indexOf("export async function ensureInvoiceCreateIdempotencySchema"),
  );
  assert.ok(
    shared.indexOf("await ensureContractingProjectIntegrity()")
      > shared.indexOf("await ensureContractingBillDetailsTables()"),
  );
  assert.ok(
    shared.indexOf("await ensureContractingAccountingTables()")
      > shared.indexOf("await ensureContractingBillDetailsTables()"),
  );
  assert.ok(
    shared.indexOf("await ensureContractingAccountingTables()")
      < shared.indexOf("await ensureContractingProjectIntegrity()"),
  );
  assert.ok(
    shared.indexOf("await ensureContractingProjectIntegrity()")
      > shared.indexOf("const r = await ensureColumns("),
  );
});

test("database guards cover cycles, branch visibility, contractor mismatch and owner source mapping", () => {
  assert.match(integritySource, /WITH RECURSIVE ancestors/);
  assert.match(integritySource, /pg_advisory_xact_lock\(20831, NEW\.company_id\)/);
  assert.doesNotMatch(integritySource, /WITH RECURSIVE ancestors[\s\S]{0,300}UNION ALL/);
  assert.match(integritySource, /project hierarchy cycle is not allowed/);
  assert.match(integritySource, /branch visibility/);
  assert.match(integritySource, /incoming bill contractor must match its project subcontract/);
  assert.match(integritySource, /source owner BOQ line must own the same project work item/);
});

test("request path caches migration per datasource and uses read-only scoped diagnostics", () => {
  assert.match(integritySource, /WeakMap<object, Promise<ContractingIntegrityDiagnostics>>/);
  assert.match(integritySource, /getActiveExternalDb/);
  assert.match(integritySource, /getContractingIntegrityDiagnostics\(/);
  assert.match(integritySource, /b\.company_id = \$\{companyId\}/);
  assert.match(integritySource, /b\.project_id IN \(\$\{visibleSql\}\)/);
});