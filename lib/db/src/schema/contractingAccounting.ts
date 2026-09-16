import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { bankAccountsTable, cashBoxesTable } from "./cash";
import {
  contractingOwnerContractsTable,
  contractingProgressBillsTable,
  contractingProjectsTable,
  contractingResourcesTable,
  contractingSubContractsTable,
} from "./contracting";
import { branchesTable } from "./branches";
import { companiesTable } from "./companies";
import { journalEntriesTable } from "./journalEntries";
import {
  itemsTable,
  stockLedgerTable,
  unitsTable,
  warehousesTable,
} from "./inventory";
import { usersTable } from "./users";

// These tables are provisioned by the contracting accounting storage layer.
// Keep this schema in lockstep with that additive DDL: publish must treat the
// runtime tables as existing schema, rather than trying to remove them.

export const contractingAccountingSettlementsTable = pgTable(
  "contracting_accounting_settlements",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    projectId: integer("project_id").notNull(),
    billId: integer("bill_id"),
    ownerContractId: integer("owner_contract_id"),
    subcontractorContractId: integer("subcontractor_contract_id"),
    kind: text("kind").notNull(),
    direction: text("direction").notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    appliedAmount: numeric("applied_amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),
    settlementDate: date("settlement_date").notNull(),
    paymentType: text("payment_type"),
    cashBoxId: integer("cash_box_id"),
    bankAccountId: integer("bank_account_id"),
    journalEntryId: integer("journal_entry_id"),
    sourceSettlementId: integer("source_settlement_id"),
    idempotencyKey: text("idempotency_key"),
    idempotencyPayloadHash: text("idempotency_payload_hash"),
    applicationOrigin: text("application_origin").notNull().default("manual"),
    reversalJournalEntryId: integer("reversal_journal_entry_id"),
    status: text("status").notNull().default("posted"),
    notes: text("notes"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "contracting_accounting_settlements_company_id_fkey",
      columns: [t.companyId],
      foreignColumns: [companiesTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "contracting_accounting_settlements_project_id_fkey",
      columns: [t.projectId],
      foreignColumns: [contractingProjectsTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_accounting_settlements_bill_id_fkey",
      columns: [t.billId],
      foreignColumns: [contractingProgressBillsTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_accounting_settlements_owner_contract_id_fkey",
      columns: [t.ownerContractId],
      foreignColumns: [contractingOwnerContractsTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_accounting_settlemen_subcontractor_contract_id_fkey",
      columns: [t.subcontractorContractId],
      foreignColumns: [contractingSubContractsTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_accounting_settlements_cash_box_id_fkey",
      columns: [t.cashBoxId],
      foreignColumns: [cashBoxesTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_accounting_settlements_bank_account_id_fkey",
      columns: [t.bankAccountId],
      foreignColumns: [bankAccountsTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_accounting_settlements_journal_entry_id_fkey",
      columns: [t.journalEntryId],
      foreignColumns: [journalEntriesTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_accounting_settlements_source_settlement_id_fkey",
      columns: [t.sourceSettlementId],
      foreignColumns: [t.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_accounting_settlemen_reversal_journal_entry_id_fkey",
      columns: [t.reversalJournalEntryId],
      foreignColumns: [journalEntriesTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_accounting_settlements_created_by_fkey",
      columns: [t.createdBy],
      foreignColumns: [usersTable.id],
    }).onDelete("set null"),
    check(
      "contracting_accounting_settlements_amount_check",
      sql`${t.amount} > 0`,
    ),
    check(
      "contracting_accounting_settlements_applied_amount_check",
      sql`${t.appliedAmount} >= 0`,
    ),
    check(
      "contracting_settlement_kind_ck",
      sql`${t.kind} IN ('advance_receipt','advance_payment','advance_application',
        'retention_receipt','retention_payment','bill_receipt','bill_payment')`,
    ),
    check(
      "contracting_settlement_direction_ck",
      sql`${t.direction} IN ('outgoing','incoming')`,
    ),
    check(
      "contracting_settlement_payment_ck",
      sql`${t.paymentType} IS NULL OR ${t.paymentType} IN ('cash','bank')`,
    ),
    index("contracting_settlements_project_idx").on(
      t.companyId,
      t.projectId,
      t.createdAt.desc(),
    ),
    index("contracting_settlements_bill_idx").on(t.companyId, t.billId),
    uniqueIndex("contracting_settlements_idempotency_idx")
      .on(t.companyId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    index("ctg_advance_source_contract_idx")
      .on(
        t.companyId,
        t.projectId,
        t.ownerContractId,
        t.subcontractorContractId,
        t.settlementDate,
        t.id,
      )
      .where(sql`kind IN ('advance_receipt','advance_payment') AND status = 'posted'`),
    index("ctg_advance_application_bill_idx")
      .on(t.companyId, t.billId, t.applicationOrigin, t.status)
      .where(sql`kind = 'advance_application'`),
  ],
);

export const contractingMaterialMovementsTable = pgTable(
  "contracting_material_movements",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    projectId: integer("project_id").notNull(),
    projectBranchId: integer("project_branch_id"),
    resourceId: integer("resource_id"),
    itemId: integer("item_id").notNull(),
    unitId: integer("unit_id").notNull(),
    warehouseId: integer("warehouse_id").notNull(),
    warehouseBranchId: integer("warehouse_branch_id"),
    direction: text("direction").notNull(),
    movementDate: date("movement_date").notNull(),
    qty: numeric("qty", { precision: 30, scale: 18 }).notNull(),
    qtyBase: numeric("qty_base", { precision: 30, scale: 18 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 30, scale: 18 }).notNull(),
    totalCost: numeric("total_cost", { precision: 60, scale: 36 }).notNull(),
    sourceMovementId: integer("source_movement_id"),
    journalEntryId: integer("journal_entry_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    idempotencyPayloadHash: text("idempotency_payload_hash").notNull(),
    status: text("status").notNull().default("posted"),
    notes: text("notes"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "contracting_material_movements_company_id_fkey",
      columns: [t.companyId],
      foreignColumns: [companiesTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "contracting_material_movements_project_id_fkey",
      columns: [t.projectId],
      foreignColumns: [contractingProjectsTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_material_movements_project_branch_id_fkey",
      columns: [t.projectBranchId],
      foreignColumns: [branchesTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_material_movements_resource_id_fkey",
      columns: [t.resourceId],
      foreignColumns: [contractingResourcesTable.id],
    }).onDelete("set null"),
    foreignKey({
      name: "contracting_material_movements_item_id_fkey",
      columns: [t.itemId],
      foreignColumns: [itemsTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_material_movements_unit_id_fkey",
      columns: [t.unitId],
      foreignColumns: [unitsTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_material_movements_warehouse_id_fkey",
      columns: [t.warehouseId],
      foreignColumns: [warehousesTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_material_movements_warehouse_branch_id_fkey",
      columns: [t.warehouseBranchId],
      foreignColumns: [branchesTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_material_movements_source_movement_id_fkey",
      columns: [t.sourceMovementId],
      foreignColumns: [t.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_material_movements_journal_entry_id_fkey",
      columns: [t.journalEntryId],
      foreignColumns: [journalEntriesTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_material_movements_created_by_fkey",
      columns: [t.createdBy],
      foreignColumns: [usersTable.id],
    }).onDelete("set null"),
    check("contracting_material_movements_qty_check", sql`${t.qty} > 0`),
    check(
      "contracting_material_movements_qty_base_check",
      sql`${t.qtyBase} > 0`,
    ),
    check(
      "contracting_material_movements_unit_cost_check",
      sql`${t.unitCost} >= 0`,
    ),
    check(
      "contracting_material_movements_total_cost_check",
      sql`${t.totalCost} >= 0`,
    ),
    uniqueIndex("contracting_material_idempotency_idx").on(
      t.companyId,
      t.idempotencyKey,
    ),
    index("contracting_material_project_idx").on(
      t.companyId,
      t.projectId,
      t.movementDate.desc(),
    ),
  ],
);

export const contractingMaterialMovementAllocationsTable = pgTable(
  "contracting_material_movement_allocations",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    movementId: integer("movement_id").notNull(),
    sourceMovementId: integer("source_movement_id"),
    sourceAllocationId: integer("source_allocation_id"),
    sourceLedgerId: integer("source_ledger_id"),
    itemId: integer("item_id").notNull(),
    warehouseId: integer("warehouse_id").notNull(),
    batchNumber: text("batch_number"),
    expiryDate: date("expiry_date"),
    qtyBase: numeric("qty_base", { precision: 30, scale: 18 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 30, scale: 18 }).notNull(),
    totalCost: numeric("total_cost", { precision: 60, scale: 36 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "contracting_material_movement_allocations_company_id_fkey",
      columns: [t.companyId],
      foreignColumns: [companiesTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "contracting_material_movement_allocations_movement_id_fkey",
      columns: [t.movementId],
      foreignColumns: [contractingMaterialMovementsTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_material_movement_allocatio_source_movement_id_fkey",
      columns: [t.sourceMovementId],
      foreignColumns: [contractingMaterialMovementsTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_material_movement_allocat_source_allocation_id_fkey",
      columns: [t.sourceAllocationId],
      foreignColumns: [t.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_material_movement_allocations_source_ledger_id_fkey",
      columns: [t.sourceLedgerId],
      foreignColumns: [stockLedgerTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_material_movement_allocations_item_id_fkey",
      columns: [t.itemId],
      foreignColumns: [itemsTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_material_movement_allocations_warehouse_id_fkey",
      columns: [t.warehouseId],
      foreignColumns: [warehousesTable.id],
    }).onDelete("restrict"),
    check(
      "contracting_material_movement_allocations_qty_base_check",
      sql`${t.qtyBase} > 0`,
    ),
    check(
      "contracting_material_movement_allocations_unit_cost_check",
      sql`${t.unitCost} >= 0`,
    ),
    check(
      "contracting_material_movement_allocations_total_cost_check",
      sql`${t.totalCost} >= 0`,
    ),
    index("contracting_material_alloc_movement_idx").on(
      t.companyId,
      t.movementId,
      t.id,
    ),
    index("contracting_material_alloc_source_idx").on(
      t.companyId,
      t.sourceMovementId,
      t.sourceAllocationId,
    ),
  ],
);

export const contractingAccountingAuditTable = pgTable(
  "contracting_accounting_audit",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    projectId: integer("project_id"),
    billId: integer("bill_id"),
    settlementId: integer("settlement_id"),
    materialMovementId: integer("material_movement_id"),
    action: text("action").notNull(),
    originalJournalEntryId: integer("original_journal_entry_id"),
    reversalJournalEntryId: integer("reversal_journal_entry_id"),
    amount: numeric("amount", { precision: 18, scale: 2 }),
    metadata: jsonb("metadata").notNull().default({}),
    userId: integer("user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "contracting_accounting_audit_company_id_fkey",
      columns: [t.companyId],
      foreignColumns: [companiesTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "contracting_accounting_audit_project_id_fkey",
      columns: [t.projectId],
      foreignColumns: [contractingProjectsTable.id],
    }).onDelete("set null"),
    foreignKey({
      name: "contracting_accounting_audit_bill_id_fkey",
      columns: [t.billId],
      foreignColumns: [contractingProgressBillsTable.id],
    }).onDelete("set null"),
    foreignKey({
      name: "contracting_accounting_audit_settlement_id_fkey",
      columns: [t.settlementId],
      foreignColumns: [contractingAccountingSettlementsTable.id],
    }).onDelete("set null"),
    foreignKey({
      name: "contracting_accounting_audit_material_movement_id_fkey",
      columns: [t.materialMovementId],
      foreignColumns: [contractingMaterialMovementsTable.id],
    }).onDelete("set null"),
    foreignKey({
      name: "contracting_accounting_audit_original_journal_entry_id_fkey",
      columns: [t.originalJournalEntryId],
      foreignColumns: [journalEntriesTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_accounting_audit_reversal_journal_entry_id_fkey",
      columns: [t.reversalJournalEntryId],
      foreignColumns: [journalEntriesTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "contracting_accounting_audit_user_id_fkey",
      columns: [t.userId],
      foreignColumns: [usersTable.id],
    }).onDelete("set null"),
    index("contracting_accounting_audit_source_idx").on(
      t.companyId,
      t.billId,
      t.createdAt.desc(),
    ),
  ],
);

export const contractingContractCreateIdempotencyTable = pgTable(
  "contracting_contract_create_idempotency",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    userId: integer("user_id").notNull(),
    operation: text("operation").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    payloadHash: text("payload_hash").notNull(),
    ownerContractId: integer("owner_contract_id"),
    subcontractorContractId: integer("subcontractor_contract_id"),
    result: jsonb("result").notNull(),
    statusCode: integer("status_code").notNull().default(201),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "contracting_contract_create_idempotency_company_id_fkey",
      columns: [t.companyId],
      foreignColumns: [companiesTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "contracting_contract_create_idempotency_user_id_fkey",
      columns: [t.userId],
      foreignColumns: [usersTable.id],
    }).onDelete("cascade"),
    check(
      "contracting_contract_create_idempotency_operation_check",
      sql`${t.operation} IN ('owner_contract_create', 'subcontract_create')`,
    ),
    unique(
      "contracting_contract_create_i_company_id_user_id_operation__key",
    ).on(t.companyId, t.userId, t.operation, t.idempotencyKey),
    index("contracting_contract_create_idempotency_result_idx").on(
      t.companyId,
      t.operation,
      t.ownerContractId,
      t.subcontractorContractId,
    ),
  ],
);