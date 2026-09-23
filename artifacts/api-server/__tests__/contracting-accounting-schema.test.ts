import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  contractingAccountingAuditTable,
  contractingAccountingSettlementsTable,
  contractingContractCreateIdempotencyTable,
  contractingMaterialMovementAllocationsTable,
  contractingMaterialMovementsTable,
} from "@workspace/db/schema";

function config(table: Parameters<typeof getTableConfig>[0]) {
  return getTableConfig(table);
}

function column(table: Parameters<typeof getTableConfig>[0], name: string) {
  const found = config(table).columns.find((candidate) => candidate.name === name);
  assert.ok(found, `${config(table).name}.${name} is missing`);
  return found;
}

function index(table: Parameters<typeof getTableConfig>[0], name: string) {
  const found = config(table).indexes.find((candidate) => candidate.config.name === name);
  assert.ok(found, `${config(table).name} index ${name} is missing`);
  return found;
}

function foreignKeyNames(table: Parameters<typeof getTableConfig>[0]) {
  return new Set(config(table).foreignKeys.map((foreignKey) => foreignKey.getName()));
}

function checkNames(table: Parameters<typeof getTableConfig>[0]) {
  return new Set(config(table).checks.map((checkConstraint) => checkConstraint.name));
}

test("contracting runtime tables are exported with their important DDL coverage", () => {
  assert.deepEqual(
    [
      config(contractingAccountingSettlementsTable).name,
      config(contractingMaterialMovementsTable).name,
      config(contractingMaterialMovementAllocationsTable).name,
      config(contractingAccountingAuditTable).name,
      config(contractingContractCreateIdempotencyTable).name,
    ],
    [
      "contracting_accounting_settlements",
      "contracting_material_movements",
      "contracting_material_movement_allocations",
      "contracting_accounting_audit",
      "contracting_contract_create_idempotency",
    ],
  );

  for (const [table, expected] of [
    [
      contractingMaterialMovementsTable,
      [
        ["qty", 30, 18],
        ["qty_base", 30, 18],
        ["unit_cost", 30, 18],
        ["total_cost", 60, 36],
      ],
    ],
    [
      contractingMaterialMovementAllocationsTable,
      [
        ["qty_base", 30, 18],
        ["unit_cost", 30, 18],
        ["total_cost", 60, 36],
      ],
    ],
    [
      contractingAccountingSettlementsTable,
      [
        ["amount", 18, 2],
        ["applied_amount", 18, 2],
      ],
    ],
  ] as const) {
    for (const [name, precision, scale] of expected) {
      const numericColumn = column(table, name);
      assert.equal(numericColumn.config.precision, precision, `${name} precision`);
      assert.equal(numericColumn.config.scale, scale, `${name} scale`);
    }
  }
});

test("contracting schema keeps self references, named checks, and settlement indexes", () => {
  const settlementFks = foreignKeyNames(contractingAccountingSettlementsTable);
  assert.ok(settlementFks.has("contracting_accounting_settlements_source_settlement_id_fkey"));
  const settlementSource = config(contractingAccountingSettlementsTable).foreignKeys.find(
    (foreignKey) => foreignKey.getName() === "contracting_accounting_settlements_source_settlement_id_fkey",
  );
  assert.ok(settlementSource);
  assert.equal(settlementSource.reference().foreignTable, contractingAccountingSettlementsTable);

  const movementFks = foreignKeyNames(contractingMaterialMovementsTable);
  assert.ok(movementFks.has("contracting_material_movements_source_movement_id_fkey"));
  assert.ok(movementFks.has("contracting_material_movements_owner_contract_id_fkey"));
  assert.ok(movementFks.has("contracting_material_movements_subcontractor_contract_id_fkey"));
  assert.ok(movementFks.has("contracting_material_movements_boq_line_id_fkey"));
  for (const name of ["owner_contract_id", "subcontractor_contract_id", "boq_line_id"]) {
    assert.equal(column(contractingMaterialMovementsTable, name).notNull, false);
  }
  const movementSource = config(contractingMaterialMovementsTable).foreignKeys.find(
    (foreignKey) => foreignKey.getName() === "contracting_material_movements_source_movement_id_fkey",
  );
  assert.ok(movementSource);
  assert.equal(movementSource.reference().foreignTable, contractingMaterialMovementsTable);

  const allocationFks = foreignKeyNames(contractingMaterialMovementAllocationsTable);
  assert.ok(allocationFks.has("contracting_material_movement_allocat_source_allocation_id_fkey"));
  const allocationSource = config(contractingMaterialMovementAllocationsTable).foreignKeys.find(
    (foreignKey) => foreignKey.getName() === "contracting_material_movement_allocat_source_allocation_id_fkey",
  );
  assert.ok(allocationSource);
  assert.equal(
    allocationSource.reference().foreignTable,
    contractingMaterialMovementAllocationsTable,
  );

  assert.deepEqual(
    [...checkNames(contractingAccountingSettlementsTable)].sort(),
    [
      "contracting_accounting_settlements_amount_check",
      "contracting_accounting_settlements_applied_amount_check",
      "contracting_settlement_direction_ck",
      "contracting_settlement_kind_ck",
      "contracting_settlement_payment_ck",
    ].sort(),
  );
  assert.deepEqual(
    [...checkNames(contractingMaterialMovementsTable)].sort(),
    [
      "contracting_material_movements_qty_check",
      "contracting_material_movements_qty_base_check",
      "contracting_material_movements_unit_cost_check",
      "contracting_material_movements_total_cost_check",
      "contracting_material_movements_contract_side_check",
    ].sort(),
  );
  assert.deepEqual(
    [...checkNames(contractingContractCreateIdempotencyTable)],
    ["contracting_contract_create_idempotency_operation_check"],
  );

  for (const name of [
    "contracting_settlements_project_idx",
    "contracting_settlements_bill_idx",
    "contracting_settlements_idempotency_idx",
    "ctg_advance_source_contract_idx",
    "ctg_advance_application_bill_idx",
  ]) {
    assert.ok(index(contractingAccountingSettlementsTable, name));
  }
  assert.ok(index(contractingContractCreateIdempotencyTable, "contracting_contract_create_idempotency_result_idx"));
  assert.ok(index(contractingMaterialMovementsTable, "contracting_material_contract_idx"));
});