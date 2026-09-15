import {
  pgTable,
  serial,
  integer,
  text,
  numeric,
  boolean,
  timestamp,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import {
  contractingProjectsTable,
  contractingProgressBillsTable,
  contractingWorkItemsTable,
} from "./contracting";

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
    previousQty: numeric("previous_qty", { precision: 14, scale: 4 }).notNull().default("0"),
    currentQty: numeric("current_qty", { precision: 14, scale: 4 }).notNull().default("0"),
    cumulativeQty: numeric("cumulative_qty", { precision: 14, scale: 4 }).notNull().default("0"),
    previousValue: numeric("previous_value", { precision: 14, scale: 2 }).notNull().default("0"),
    currentValue: numeric("current_value", { precision: 14, scale: 2 }).notNull().default("0"),
    cumulativeValue: numeric("cumulative_value", { precision: 14, scale: 2 }).notNull().default("0"),
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
    oneWorkItemPerBill: uniqueIndex("ctg_bill_lines_bill_work_item_uidx")
      .on(t.companyId, t.billId, t.workItemId),
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
export type ContractingBillAttachment = typeof contractingBillAttachmentsTable.$inferSelect;
export type ContractingBillWorkflowEvent = typeof contractingBillWorkflowEventsTable.$inferSelect;