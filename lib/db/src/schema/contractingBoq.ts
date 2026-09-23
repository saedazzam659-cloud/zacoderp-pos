import {
  pgTable,
  serial,
  integer,
  text,
  numeric,
  timestamp,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { CONTRACTING_COMPOSITE_SCOPE_FKS_ENABLED } from "./contractingPublishStage";
import { companiesTable } from "./companies";
import {
  contractingProjectsTable,
  contractingWorkItemsTable,
  contractingOwnerContractsTable,
  contractingSubContractsTable,
} from "./contracting";

/**
 * Contract-specific BOQ lines.
 *
 * Work items are the project's common scope catalogue.  Commercial terms
 * belong here instead: the same work item can have a different quantity/rate
 * in an owner contract and in each subcontract, and several subcontractors can
 * split one owner line without changing the project catalogue.
 */
export const contractingContractBoqLinesTable = pgTable(
  "contracting_contract_boq_lines",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    projectId: integer("project_id").notNull()
      .references(() => contractingProjectsTable.id, { onDelete: "cascade" }),
    workItemId: integer("work_item_id").notNull()
      .references(() => contractingWorkItemsTable.id, { onDelete: "restrict" }),
    // Exactly one contract side is selected according to direction.  Keeping
    // both explicit ids prevents a line from being inferred from a project or
    // from whichever contract happens to be active.
    direction: text("direction").notNull().default("owner"),
    ownerContractId: integer("owner_contract_id")
      .references(() => contractingOwnerContractsTable.id, { onDelete: "restrict" }),
    subcontractorContractId: integer("subcontractor_contract_id")
      .references(() => contractingSubContractsTable.id, { onDelete: "restrict" }),
    // A subcontract line may optionally point at the exact owner BOQ line it
    // fulfils.  It is intentionally nullable for direct subcontract scopes.
    sourceOwnerLineId: integer("source_owner_line_id"),
    // Change-order lines stay in the same BOQ catalogue.  They point at the
    // base line and store the signed delta/rate override; the child contract
    // itself remains the approval/workflow record.
    baseLineId: integer("base_line_id"),
    quantityDelta: numeric("quantity_delta", { precision: 14, scale: 4 }),
    unitPriceDelta: numeric("unit_price_delta", { precision: 14, scale: 2 }),
    unitPriceOverride: numeric("unit_price_override", { precision: 14, scale: 2 }),
    lineCode: text("line_code"),
    description: text("description"),
    unit: text("unit").notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull().default("0"),
    unitPrice: numeric("unit_price", { precision: 14, scale: 2 }).notNull().default("0"),
    totalAmount: numeric("total_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    byProject: index("ctg_boq_project_idx").on(t.companyId, t.projectId),
    byOwnerContract: index("ctg_boq_owner_contract_idx").on(t.companyId, t.ownerContractId),
    bySubcontract: index("ctg_boq_subcontract_idx").on(t.companyId, t.subcontractorContractId),
    byWorkItem: index("ctg_boq_work_item_idx").on(t.companyId, t.projectId, t.workItemId),
    bySourceOwner: index("ctg_boq_source_owner_idx").on(t.companyId, t.sourceOwnerLineId),
    oneLinePerContractWorkItem: uniqueIndex("ctg_boq_contract_work_item_uidx")
      .on(t.companyId, t.direction, t.ownerContractId, t.subcontractorContractId, t.workItemId),
    companyProjectIdWorkItemUq: unique("ctg_boq_company_project_id_work_item_uq")
      .on(t.companyId, t.projectId, t.id, t.workItemId),
    exactDirectionContract: check("ctg_boq_exact_direction_contract_ck", sql`
      (${t.direction} = 'owner' AND ${t.ownerContractId} IS NOT NULL
        AND ${t.subcontractorContractId} IS NULL AND ${t.sourceOwnerLineId} IS NULL)
      OR
      (${t.direction} = 'subcontract' AND ${t.ownerContractId} IS NULL
        AND ${t.subcontractorContractId} IS NOT NULL)
    `),
    ...(CONTRACTING_COMPOSITE_SCOPE_FKS_ENABLED ? {
      ownerContractProjectFk: foreignKey({
        columns: [t.companyId, t.projectId, t.ownerContractId],
        foreignColumns: [
          contractingOwnerContractsTable.companyId,
          contractingOwnerContractsTable.projectId,
          contractingOwnerContractsTable.id,
        ],
        name: "ctg_boq_owner_contract_project_fk",
      }).onDelete("restrict"),
      subcontractProjectFk: foreignKey({
        columns: [t.companyId, t.projectId, t.subcontractorContractId],
        foreignColumns: [
          contractingSubContractsTable.companyId,
          contractingSubContractsTable.projectId,
          contractingSubContractsTable.id,
        ],
        name: "ctg_boq_subcontract_project_fk",
      }).onDelete("restrict"),
      sourceOwnerProjectWorkItemFk: foreignKey({
        columns: [t.companyId, t.projectId, t.sourceOwnerLineId, t.workItemId],
        foreignColumns: [t.companyId, t.projectId, t.id, t.workItemId],
        name: "ctg_boq_source_owner_project_item_fk",
      }).onDelete("restrict"),
    } : {}),
  }),
);

export type ContractingContractBoqLine = typeof contractingContractBoqLinesTable.$inferSelect;