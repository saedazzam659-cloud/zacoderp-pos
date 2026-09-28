import { pgTable, serial, integer, text, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";

// Review-only observations. No FK cascade to operational documents: evidence
// and review history must survive a source being removed.
export const internalControlCasesTable = pgTable("internal_control_cases", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull(),
  branchId: integer("branch_id"),
  ruleKey: text("rule_key").notNull(),
  eventKey: text("event_key").notNull(),
  category: text("category").notNull(),
  source: text("source").notNull(),
  documentType: text("document_type").notNull(),
  documentId: text("document_id").notNull(),
  documentNumber: text("document_number"),
  projectId: integer("project_id"),
  customerId: integer("customer_id"),
  supplierId: integer("supplier_id"),
  userId: integer("user_id"),
  approverId: integer("approver_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  description: text("description").notNull(),
  reason: text("reason").notNull(),
  severity: text("severity").notNull(),
  status: text("status").notNull().default("open"),
  reviewerId: integer("reviewer_id"),
  reviewerNotes: text("reviewer_notes"),
  actionTaken: text("action_taken"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  documentUrl: text("document_url"),
  evidence: jsonb("evidence").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  eventUnique: uniqueIndex("internal_control_case_event_uq").on(t.companyId, t.ruleKey, t.eventKey),
  scopeIndex: index("internal_control_case_scope_idx").on(t.companyId, t.branchId, t.createdAt),
}));

export const internalControlRulesTable = pgTable("internal_control_rules", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull(),
  key: text("key").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  updatedBy: integer("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ companyKey: uniqueIndex("internal_control_rule_company_uq").on(t.companyId, t.key) }));

export const internalControlHistoryTable = pgTable("internal_control_history", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull(),
  caseId: integer("case_id"),
  userId: integer("user_id"),
  action: text("action").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ scopeIndex: index("internal_control_history_scope_idx").on(t.companyId, t.caseId, t.createdAt) }));