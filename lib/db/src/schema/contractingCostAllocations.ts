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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import {
  contractingOwnerContractsTable,
  contractingProjectsTable,
  contractingSubContractsTable,
} from "./contracting";
import { contractingContractBoqLinesTable } from "./contractingBoq";
import { fixedAssetsTable } from "./fixedAssets";

/**
 * Analytical attribution of costs posted by their owning ERP module.
 *
 * This table never owns a journal entry or master data. Positive rows freeze a
 * portion of an existing posted source; negative rows reverse one positive row.
 */
export const contractingCostAllocationsTable = pgTable(
  "contracting_cost_allocations",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    projectId: integer("project_id").notNull()
      .references(() => contractingProjectsTable.id, { onDelete: "restrict" }),
    ownerContractId: integer("owner_contract_id")
      .references(() => contractingOwnerContractsTable.id, { onDelete: "restrict" }),
    subcontractorContractId: integer("subcontractor_contract_id")
      .references(() => contractingSubContractsTable.id, { onDelete: "restrict" }),
    boqLineId: integer("boq_line_id")
      .references(() => contractingContractBoqLinesTable.id, { onDelete: "restrict" }),
    category: text("category").notNull(),
    sourceType: text("source_type").notNull(),
    sourceRecordId: integer("source_record_id").notNull(),
    sourceDate: date("source_date").notNull(),
    sourceAmount: numeric("source_amount", { precision: 18, scale: 2 }).notNull(),
    basis: text("basis").notNull().default("percentage"),
    sharePct: numeric("share_pct", { precision: 9, scale: 6 }),
    allocatedAmount: numeric("allocated_amount", { precision: 18, scale: 2 }).notNull(),
    equipmentAssetId: integer("equipment_asset_id")
      .references(() => fixedAssetsTable.id, { onDelete: "restrict" }),
    equipmentHours: numeric("equipment_hours", { precision: 14, scale: 4 }),
    sourceHoursDenominator: numeric("source_hours_denominator", { precision: 14, scale: 4 }),
    hourlyRateEvidence: numeric("hourly_rate_evidence", { precision: 18, scale: 6 }),
    reversalOfId: integer("reversal_of_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    sourceSnapshot: jsonb("source_snapshot").$type<Record<string, unknown>>().notNull().default({}),
    notes: text("notes"),
    createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    sourceLookup: index("ctg_cost_alloc_source_idx")
      .on(t.companyId, t.sourceType, t.sourceRecordId),
    targetLookup: index("ctg_cost_alloc_target_idx")
      .on(t.companyId, t.projectId, t.ownerContractId, t.subcontractorContractId, t.boqLineId),
    idempotency: uniqueIndex("ctg_cost_alloc_idempotency_uidx")
      .on(t.companyId, t.idempotencyKey),
    oneReversal: uniqueIndex("ctg_cost_alloc_reversal_uidx")
      .on(t.reversalOfId)
      .where(sql`${t.reversalOfId} IS NOT NULL`),
    reversalFk: foreignKey({
      columns: [t.reversalOfId],
      foreignColumns: [t.id],
      name: "ctg_cost_alloc_reversal_fk",
    }).onDelete("restrict"),
    positiveOrReversal: check("ctg_cost_alloc_sign_ck", sql`
      (${t.reversalOfId} IS NULL AND ${t.allocatedAmount} > 0)
      OR (${t.reversalOfId} IS NOT NULL AND ${t.allocatedAmount} < 0)
    `),
    targetContractSide: check("ctg_cost_alloc_contract_side_ck", sql`
      NOT (${t.ownerContractId} IS NOT NULL AND ${t.subcontractorContractId} IS NOT NULL)
    `),
    equipmentEvidence: check("ctg_cost_alloc_equipment_evidence_ck", sql`
      (${t.category} = 'equipment'
        AND ${t.equipmentAssetId} IS NOT NULL
        AND ${t.equipmentHours} > 0
        AND ${t.sourceHoursDenominator} > 0
        AND ${t.hourlyRateEvidence} > 0)
      OR
      (${t.category} <> 'equipment'
        AND ${t.equipmentAssetId} IS NULL
        AND ${t.equipmentHours} IS NULL
        AND ${t.sourceHoursDenominator} IS NULL
        AND ${t.hourlyRateEvidence} IS NULL)
    `),
    ownerTarget: foreignKey({
      columns: [t.companyId, t.projectId, t.ownerContractId],
      foreignColumns: [
        contractingOwnerContractsTable.companyId,
        contractingOwnerContractsTable.projectId,
        contractingOwnerContractsTable.id,
      ],
      name: "ctg_cost_alloc_owner_project_fk",
    }).onDelete("restrict"),
    subcontractTarget: foreignKey({
      columns: [t.companyId, t.projectId, t.subcontractorContractId],
      foreignColumns: [
        contractingSubContractsTable.companyId,
        contractingSubContractsTable.projectId,
        contractingSubContractsTable.id,
      ],
      name: "ctg_cost_alloc_subcontract_project_fk",
    }).onDelete("restrict"),
  }),
);

export type ContractingCostAllocation = typeof contractingCostAllocationsTable.$inferSelect;
export type ContractingCostAllocationInsert = typeof contractingCostAllocationsTable.$inferInsert;