import {
  pgTable,
  serial,
  integer,
  text,
  numeric,
  date,
  timestamp,
  index,
  unique,
  uniqueIndex,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { CONTRACTING_COMPOSITE_SCOPE_FKS_ENABLED } from "./contractingPublishStage";
import { companiesTable } from "./companies";
import { customersTable } from "./customers";
import { usersTable } from "./users";
import { bankAccountsTable } from "./cash";
import {
  contractingProjectsTable,
  contractingOwnerContractsTable,
  contractingSubContractsTable,
} from "./contracting";

/**
 * A tender is project-owned but precedes a contract. Awarding selects an
 * existing owner/subcontract; it never manufactures or rewrites a contract.
 */
export const contractingTendersTable = pgTable(
  "contracting_tenders",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    projectId: integer("project_id").notNull()
      .references(() => contractingProjectsTable.id, { onDelete: "restrict" }),
    customerId: integer("customer_id")
      .references(() => customersTable.id, { onDelete: "set null" }),
    tenderNumber: text("tender_number").notNull(),
    title: text("title").notNull(),
    tenderDate: date("tender_date").notNull(),
    submissionDate: date("submission_date"),
    estimatedValue: numeric("estimated_value", { precision: 14, scale: 2 }).notNull().default("0"),
    status: text("status").notNull().default("draft"),
    awardedContractKind: text("awarded_contract_kind"),
    awardedOwnerContractId: integer("awarded_owner_contract_id")
      .references(() => contractingOwnerContractsTable.id, { onDelete: "restrict" }),
    awardedSubcontractId: integer("awarded_subcontract_id")
      .references(() => contractingSubContractsTable.id, { onDelete: "restrict" }),
    awardedAt: timestamp("awarded_at"),
    notes: text("notes"),
    archivedAt: timestamp("archived_at"),
    archivedByUserId: integer("archived_by_user_id")
      .references(() => usersTable.id, { onDelete: "set null" }),
    createdByUserId: integer("created_by_user_id")
      .references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    byCompanyProject: index("ctg_tender_company_project_idx").on(t.companyId, t.projectId),
    byStatus: index("ctg_tender_status_idx").on(t.companyId, t.status),
    companyProjectIdUq: unique("ctg_tender_company_project_id_uq").on(t.companyId, t.projectId, t.id),
    awardShape: check("ctg_tender_award_shape_ck", sql`
      (${t.awardedContractKind} IS NULL AND ${t.awardedOwnerContractId} IS NULL AND ${t.awardedSubcontractId} IS NULL)
      OR (${t.awardedContractKind} = 'owner' AND ${t.awardedOwnerContractId} IS NOT NULL AND ${t.awardedSubcontractId} IS NULL)
      OR (${t.awardedContractKind} = 'subcontract' AND ${t.awardedOwnerContractId} IS NULL AND ${t.awardedSubcontractId} IS NOT NULL)
    `),
    statusShape: check("ctg_tender_status_ck", sql`
      ${t.status} IN ('draft', 'submitted', 'under_review', 'awarded', 'lost', 'cancelled')
      AND ((${t.status} = 'awarded') = (${t.awardedContractKind} IS NOT NULL))
    `),
    ...(CONTRACTING_COMPOSITE_SCOPE_FKS_ENABLED ? {
      customerCompanyFk: foreignKey({
        columns: [t.companyId, t.customerId],
        foreignColumns: [customersTable.companyId, customersTable.id],
        name: "ctg_tender_customer_company_fk",
      }).onDelete("restrict"),
      ownerContractProjectFk: foreignKey({
        columns: [t.companyId, t.projectId, t.awardedOwnerContractId],
        foreignColumns: [
          contractingOwnerContractsTable.companyId,
          contractingOwnerContractsTable.projectId,
          contractingOwnerContractsTable.id,
        ],
        name: "ctg_tender_owner_contract_project_fk",
      }).onDelete("restrict"),
      subcontractProjectFk: foreignKey({
        columns: [t.companyId, t.projectId, t.awardedSubcontractId],
        foreignColumns: [
          contractingSubContractsTable.companyId,
          contractingSubContractsTable.projectId,
          contractingSubContractsTable.id,
        ],
        name: "ctg_tender_subcontract_project_fk",
      }).onDelete("restrict"),
    } : {}),
  }),
);

/**
 * Bank guarantees reuse bank accounts and customers. Initial guarantees have
 * tender + project and no contract. Every post-award guarantee has exactly one
 * existing owner/subcontract. A performance guarantee generated from a tender
 * points to the original initial guarantee; that original row remains unchanged.
 */
export const contractingGuaranteesTable = pgTable(
  "contracting_guarantees",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    projectId: integer("project_id").notNull()
      .references(() => contractingProjectsTable.id, { onDelete: "restrict" }),
    tenderId: integer("tender_id")
      .references(() => contractingTendersTable.id, { onDelete: "restrict" }),
    contractKind: text("contract_kind"),
    ownerContractId: integer("owner_contract_id")
      .references(() => contractingOwnerContractsTable.id, { onDelete: "restrict" }),
    subcontractId: integer("subcontract_id")
      .references(() => contractingSubContractsTable.id, { onDelete: "restrict" }),
    parentGuaranteeId: integer("parent_guarantee_id"),
    bankAccountId: integer("bank_account_id").notNull()
      .references(() => bankAccountsTable.id, { onDelete: "restrict" }),
    beneficiaryCustomerId: integer("beneficiary_customer_id")
      .references(() => customersTable.id, { onDelete: "restrict" }),
    guaranteeNumber: text("guarantee_number").notNull(),
    guaranteeType: text("guarantee_type").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    issueDate: date("issue_date").notNull(),
    expiryDate: date("expiry_date").notNull(),
    status: text("status").notNull().default("draft"),
    purpose: text("purpose"),
    notes: text("notes"),
    releasedAt: timestamp("released_at"),
    archivedAt: timestamp("archived_at"),
    archivedByUserId: integer("archived_by_user_id")
      .references(() => usersTable.id, { onDelete: "set null" }),
    createdByUserId: integer("created_by_user_id")
      .references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    byCompanyProject: index("ctg_guarantee_company_project_idx").on(t.companyId, t.projectId),
    byContract: index("ctg_guarantee_contract_idx").on(t.companyId, t.contractKind, t.ownerContractId, t.subcontractId),
    byTender: index("ctg_guarantee_tender_idx").on(t.companyId, t.tenderId),
    byBank: index("ctg_guarantee_bank_idx").on(t.companyId, t.bankAccountId),
    byStatus: index("ctg_guarantee_status_idx").on(t.companyId, t.status),
    onePerformanceChild: uniqueIndex("ctg_guarantee_one_performance_child_uq")
      .on(t.parentGuaranteeId)
      .where(sql`${t.guaranteeType} = 'performance' AND ${t.parentGuaranteeId} IS NOT NULL AND ${t.archivedAt} IS NULL`),
    companyProjectIdUq: unique("ctg_guarantee_company_project_id_uq").on(t.companyId, t.projectId, t.id),
    relationshipShape: check("ctg_guarantee_relationship_shape_ck", sql`
      (${t.guaranteeType} = 'initial' AND ${t.tenderId} IS NOT NULL
        AND ${t.contractKind} IS NULL AND ${t.ownerContractId} IS NULL
        AND ${t.subcontractId} IS NULL AND ${t.parentGuaranteeId} IS NULL)
      OR
      (${t.guaranteeType} <> 'initial' AND (
        (${t.contractKind} = 'owner' AND ${t.ownerContractId} IS NOT NULL AND ${t.subcontractId} IS NULL)
        OR
        (${t.contractKind} = 'subcontract' AND ${t.ownerContractId} IS NULL AND ${t.subcontractId} IS NOT NULL)
      ))
    `),
    valuesShape: check("ctg_guarantee_values_ck", sql`
      ${t.guaranteeType} IN ('initial', 'performance', 'advance_payment', 'maintenance', 'other')
      AND ${t.status} IN ('draft', 'issued', 'active', 'extended', 'released', 'expired', 'cancelled')
      AND ${t.amount} > 0 AND ${t.expiryDate} >= ${t.issueDate}
    `),
    parentShape: check("ctg_guarantee_parent_shape_ck", sql`
      (${t.parentGuaranteeId} IS NULL OR ${t.guaranteeType} = 'performance')
      AND (${t.tenderId} IS NULL OR ${t.guaranteeType} = 'initial'
        OR (${t.guaranteeType} = 'performance' AND ${t.parentGuaranteeId} IS NOT NULL))
    `),
    ...(CONTRACTING_COMPOSITE_SCOPE_FKS_ENABLED ? {
      bankCompanyFk: foreignKey({
        columns: [t.companyId, t.bankAccountId],
        foreignColumns: [bankAccountsTable.companyId, bankAccountsTable.id],
        name: "ctg_guarantee_bank_company_fk",
      }).onDelete("restrict"),
      customerCompanyFk: foreignKey({
        columns: [t.companyId, t.beneficiaryCustomerId],
        foreignColumns: [customersTable.companyId, customersTable.id],
        name: "ctg_guarantee_customer_company_fk",
      }).onDelete("restrict"),
      tenderProjectFk: foreignKey({
        columns: [t.companyId, t.projectId, t.tenderId],
        foreignColumns: [
          contractingTendersTable.companyId,
          contractingTendersTable.projectId,
          contractingTendersTable.id,
        ],
        name: "ctg_guarantee_tender_project_fk",
      }).onDelete("restrict"),
      ownerContractProjectFk: foreignKey({
        columns: [t.companyId, t.projectId, t.ownerContractId],
        foreignColumns: [
          contractingOwnerContractsTable.companyId,
          contractingOwnerContractsTable.projectId,
          contractingOwnerContractsTable.id,
        ],
        name: "ctg_guarantee_owner_contract_project_fk",
      }).onDelete("restrict"),
      subcontractProjectFk: foreignKey({
        columns: [t.companyId, t.projectId, t.subcontractId],
        foreignColumns: [
          contractingSubContractsTable.companyId,
          contractingSubContractsTable.projectId,
          contractingSubContractsTable.id,
        ],
        name: "ctg_guarantee_subcontract_project_fk",
      }).onDelete("restrict"),
      parentProjectFk: foreignKey({
        columns: [t.companyId, t.projectId, t.parentGuaranteeId],
        foreignColumns: [t.companyId, t.projectId, t.id],
        name: "ctg_guarantee_parent_project_fk",
      }).onDelete("restrict"),
    } : {}),
  }),
);

export type ContractingTender = typeof contractingTendersTable.$inferSelect;
export type ContractingGuarantee = typeof contractingGuaranteesTable.$inferSelect;