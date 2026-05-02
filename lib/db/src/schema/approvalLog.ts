import { pgTable, serial, integer, text, timestamp, numeric, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

/**
 * Approval log — append-only audit trail for every approval-related event
 * across the system (sales documents, purchase invoices, journal entries,
 * payments, etc.). Each row records who acted, on what document, at what
 * level, and the resulting status transition. Read by the future Approvals
 * dashboard and exposed per-document for compliance.
 */
export const approvalLogTable = pgTable("approval_log", {
  id: serial("id").primaryKey(),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  // Document being approved — kept loose (text type + integer id) so any
  // future module can write into this log without a schema change.
  documentType: text("document_type").notNull(),    // e.g. "sales_invoice", "purchase_invoice", "journal_entry"
  documentId:   integer("document_id").notNull(),
  // Acting user (nullable so a system / cron can also write entries).
  userId:       integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  // What happened: "request" | "approve" | "reject" | "escalate" | "auto_approve"
  action:       text("action").notNull(),
  // Approval level at the time of the action (0 = none, 1 = L1, 2 = L2…).
  level:        integer("level").notNull().default(0),
  // Document amount snapshot — recorded for audit, never recomputed.
  amount:       numeric("amount", { precision: 18, scale: 2 }).notNull().default("0"),
  // Status transitions: "draft" | "pending" | "pending_l1" | "pending_l2" |
  //                    "approved" | "rejected"
  fromStatus:   text("from_status"),
  toStatus:     text("to_status"),
  comment:      text("comment"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byDoc: index("approval_log_doc_idx").on(t.companyId, t.documentType, t.documentId),
  byCompany: index("approval_log_company_idx").on(t.companyId, t.createdAt),
}));

export const insertApprovalLogSchema = createInsertSchema(approvalLogTable).omit({ id: true, createdAt: true });
export type InsertApprovalLog = z.infer<typeof insertApprovalLogSchema>;
export type ApprovalLog = typeof approvalLogTable.$inferSelect;
