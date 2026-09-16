import {
  pgTable,
  serial,
  integer,
  text,
  numeric,
  boolean,
  timestamp,
  date,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import {
  contractingProjectsTable,
  contractingProgressBillsTable,
  contractingOwnerContractsTable,
  contractingSubContractsTable,
  contractingWorkItemsTable,
} from "./contracting";
import { contractingContractBoqLinesTable } from "./contractingBoq";

/**
 * Additive detail records for progress bills.
 *
 * The existing contracting_progress_bills row remains the source of truth for
 * its automatically populated contract/amount/tax fields. These tables only
 * store the detail that was missing from the original screen: allocations,
 * deductions, penalties, object-storage references, and workflow audit.
 */
export const contractingBillLinesTable = pgTable(
  "contracting_bill_lines",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    projectId: integer("project_id").notNull()
      .references(() => contractingProjectsTable.id, { onDelete: "cascade" }),
    billId: integer("bill_id").notNull()
      .references(() => contractingProgressBillsTable.id, { onDelete: "cascade" }),
    workItemId: integer("work_item_id")
      .references(() => contractingWorkItemsTable.id, { onDelete: "set null" }),
    // New lines reference the exact contract BOQ line.  NULL is retained for
    // legacy rows; migration never guesses a contract or assigns one.
    boqLineId: integer("boq_line_id")
      .references(() => contractingContractBoqLinesTable.id, { onDelete: "set null" }),
    unitSnapshot: text("unit_snapshot"),
    unitPriceSnapshot: numeric("unit_price_snapshot", { precision: 14, scale: 2 }),
    // Optional per-line relation to an approved owner-contract change order.
    // NULL deliberately preserves legacy work-item-only lines.
    changeOrderId: integer("change_order_id")
      .references(() => contractingOwnerContractsTable.id, { onDelete: "set null" }),
    changeOrderSubcontractId: integer("change_order_subcontract_id")
      .references(() => contractingSubContractsTable.id, { onDelete: "set null" }),
    previousQty: numeric("previous_qty", { precision: 14, scale: 4 }).notNull().default("0"),
    currentQty: numeric("current_qty", { precision: 14, scale: 4 }).notNull().default("0"),
    cumulativeQty: numeric("cumulative_qty", { precision: 14, scale: 4 }).notNull().default("0"),
    previousValue: numeric("previous_value", { precision: 14, scale: 2 }).notNull().default("0"),
    currentValue: numeric("current_value", { precision: 14, scale: 2 }).notNull().default("0"),
    cumulativeValue: numeric("cumulative_value", { precision: 14, scale: 2 }).notNull().default("0"),
    // Certification is deliberately nullable for legacy rows. A NULL
    // extension value means that the historical value was fully certified.
    executionValue: numeric("execution_value", { precision: 14, scale: 2 }),
    certificationPercent: numeric("certification_percent", { precision: 5, scale: 2 }),
    currentExecutionCertifiedValue: numeric("current_execution_certified_value", { precision: 14, scale: 2 }),
    priorPendingCertifiedValue: numeric("prior_pending_certified_value", { precision: 14, scale: 2 }),
    certificationReason: text("certification_reason"),
    pendingCertificationAllocations: jsonb("pending_certification_allocations")
      .$type<Array<{ sourceLineId: number; amount: string }>>(),
    excessApproved: boolean("excess_approved").notNull().default(false),
    excessApprovalReason: text("excess_approval_reason"),
    excessApprovedByUserId: integer("excess_approved_by_user_id")
      .references(() => usersTable.id, { onDelete: "set null" }),
    excessApprovedAt: timestamp("excess_approved_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    byBill: index("ctg_bill_lines_bill_idx").on(t.companyId, t.billId),
    byWorkItem: index("ctg_bill_lines_work_item_idx").on(t.companyId, t.projectId, t.workItemId),
    byBoqLine: index("ctg_bill_lines_boq_line_idx").on(t.companyId, t.projectId, t.boqLineId),
  }),
);

export const contractingBillDeductionsTable = pgTable(
  "contracting_bill_deductions",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    projectId: integer("project_id").notNull()
      .references(() => contractingProjectsTable.id, { onDelete: "cascade" }),
    billId: integer("bill_id").notNull()
      .references(() => contractingProgressBillsTable.id, { onDelete: "cascade" }),
    // Client-generated idempotency key. It prevents a retry from creating the
    // same deduction twice without inventing a second business identifier.
    deductionKey: text("deduction_key").notNull(),
    // advance | retention | materials | settlement | other
    kind: text("kind").notNull(),
    percentage: numeric("percentage", { precision: 7, scale: 4 }),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull().default("0"),
    reason: text("reason").notNull(),
    reference: text("reference"),
    notes: text("notes"),
    createdByUserId: integer("created_by_user_id")
      .references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    byBill: index("ctg_bill_deductions_bill_idx").on(t.companyId, t.billId),
    uniqueKey: uniqueIndex("ctg_bill_deductions_key_uidx")
      .on(t.companyId, t.billId, t.deductionKey),
  }),
);

export const contractingBillPenaltiesTable = pgTable(
  "contracting_bill_penalties",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    projectId: integer("project_id").notNull()
      .references(() => contractingProjectsTable.id, { onDelete: "cascade" }),
    billId: integer("bill_id").notNull()
      .references(() => contractingProgressBillsTable.id, { onDelete: "cascade" }),
    penaltyKey: text("penalty_key").notNull(),
    penaltyType: text("penalty_type").notNull(),
    reason: text("reason").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull().default("0"),
    penaltyDate: date("penalty_date").notNull(),
    reference: text("reference"),
    notes: text("notes"),
    // Mapping is deliberately explicit; a penalty is not treated as a VAT
    // deduction and no VAT account is inferred by this extension.
    accountMappingKey: text("account_mapping_key"),
    createdByUserId: integer("created_by_user_id")
      .references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    byBill: index("ctg_bill_penalties_bill_idx").on(t.companyId, t.billId),
    uniqueKey: uniqueIndex("ctg_bill_penalties_key_uidx")
      .on(t.companyId, t.billId, t.penaltyKey),
  }),
);

/**
 * Explicit financial additions to a progress bill.  This is intentionally
 * separate from BOQ work lines: a financial settlement adjustment must never
 * be able to manufacture contract work or bypass the approved BOQ/change
 * order ceiling.
 */
export const contractingBillAdditionsTable = pgTable(
  "contracting_bill_additions",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    projectId: integer("project_id").notNull()
      .references(() => contractingProjectsTable.id, { onDelete: "cascade" }),
    billId: integer("bill_id").notNull()
      .references(() => contractingProgressBillsTable.id, { onDelete: "cascade" }),
    // Idempotency key supplied by the editor; the same business row cannot be
    // created twice by a retry.
    additionKey: text("addition_key").notNull(),
    // fixed | rate. Rate amounts are calculated server-side from baseAmount.
    calculationType: text("calculation_type").notNull(),
    rate: numeric("rate", { precision: 9, scale: 4 }),
    // The base is persisted as a snapshot so reports never recalculate from a
    // mutable project/bill form. The UI must always show the selected base.
    baseType: text("base_type").notNull(),
    baseAmount: numeric("base_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull().default("0"),
    reason: text("reason").notNull(),
    // attachment | variation. Both require a human-readable reference.
    referenceType: text("reference_type").notNull(),
    reference: text("reference").notNull(),
    // Currently the only supported fiscal treatment is explicitly
    // non-taxable settlement adjustment. Unsupported VAT treatments fail
    // closed rather than silently reducing VAT.
    taxTreatment: text("tax_treatment").notNull(),
    // Exact accounting mapping role; no generic/fallback account is inferred.
    accountMappingKey: text("account_mapping_key").notNull(),
    notes: text("notes"),
    createdByUserId: integer("created_by_user_id")
      .references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    byBill: index("ctg_bill_additions_bill_idx").on(t.companyId, t.billId),
    uniqueKey: uniqueIndex("ctg_bill_additions_key_uidx")
      .on(t.companyId, t.billId, t.additionKey),
  }),
);

export const contractingBillAttachmentsTable = pgTable(
  "contracting_bill_attachments",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    projectId: integer("project_id").notNull()
      .references(() => contractingProjectsTable.id, { onDelete: "cascade" }),
    billId: integer("bill_id").notNull()
      .references(() => contractingProgressBillsTable.id, { onDelete: "cascade" }),
    // invoice | completion_certificate | handover | penalty | other
    category: text("category").notNull(),
    filename: text("filename").notNull(),
    // Persistent object-storage reference, never an arbitrary remote URL.
    objectPath: text("object_path").notNull(),
    contentType: text("content_type"),
    bytes: integer("bytes"),
    uploadedByUserId: integer("uploaded_by_user_id")
      .references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    byBill: index("ctg_bill_attachments_bill_idx").on(t.companyId, t.billId),
  }),
);

export const contractingBillWorkflowEventsTable = pgTable(
  "contracting_bill_workflow_events",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    projectId: integer("project_id").notNull()
      .references(() => contractingProjectsTable.id, { onDelete: "cascade" }),
    billId: integer("bill_id").notNull()
      .references(() => contractingProgressBillsTable.id, { onDelete: "cascade" }),
    // draft | submitted | under_review | approved | posted |
    // partially_paid | paid | rejected
    state: text("state").notNull(),
    action: text("action").notNull(),
    note: text("note"),
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    byBill: index("ctg_bill_workflow_bill_idx").on(t.companyId, t.billId, t.createdAt),
    byProject: index("ctg_bill_workflow_project_idx").on(t.companyId, t.projectId, t.createdAt),
  }),
);

export type ContractingBillLine = typeof contractingBillLinesTable.$inferSelect;
export type ContractingBillDeduction = typeof contractingBillDeductionsTable.$inferSelect;
export type ContractingBillPenalty = typeof contractingBillPenaltiesTable.$inferSelect;
export type ContractingBillAddition = typeof contractingBillAdditionsTable.$inferSelect;
export type ContractingBillAttachment = typeof contractingBillAttachmentsTable.$inferSelect;
export type ContractingBillWorkflowEvent = typeof contractingBillWorkflowEventsTable.$inferSelect;