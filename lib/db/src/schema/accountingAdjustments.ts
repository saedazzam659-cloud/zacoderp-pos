import {
  pgTable, serial, text, integer, numeric, boolean, timestamp, pgEnum, uniqueIndex,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { accountsTable } from "./accounts";
import { journalEntriesTable } from "./journalEntries";

export const adjustmentTypeEnum = pgEnum("adjustment_type", [
  "prepaid",
  "accrued",
]);

export const adjustmentStatusEnum = pgEnum("adjustment_status", [
  "active",
  "completed",
  "cancelled",
  "carried_forward",
]);

export const accountingAdjustmentsTable = pgTable("accounting_adjustments", {
  id:                  serial("id").primaryKey(),
  companyId:           integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  type:                adjustmentTypeEnum("type").notNull(),
  name:                text("name").notNull(),
  expenseAccountId:    integer("expense_account_id").notNull().references(() => accountsTable.id),
  contraAccountId:     integer("contra_account_id").notNull().references(() => accountsTable.id),
  totalAmount:         numeric("total_amount", { precision: 18, scale: 2 }).notNull(),
  startDate:           text("start_date").notNull(),
  endDate:             text("end_date").notNull(),
  monthlyAmount:       numeric("monthly_amount", { precision: 18, scale: 2 }).notNull(),
  autoGenerate:        boolean("auto_generate").notNull().default(true),
  carryForwardEnabled: boolean("carry_forward_enabled").notNull().default(true),
  parentAdjustmentId:  integer("parent_adjustment_id"),
  status:              adjustmentStatusEnum("status").notNull().default("active"),
  notes:               text("notes"),
  createdAt:           timestamp("created_at").defaultNow().notNull(),
  updatedAt:           timestamp("updated_at").defaultNow().notNull(),
});

export const accountingAdjustmentRunsTable = pgTable("accounting_adjustment_runs", {
  id:             serial("id").primaryKey(),
  adjustmentId:   integer("adjustment_id").notNull().references(() => accountingAdjustmentsTable.id, { onDelete: "cascade" }),
  companyId:      integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  periodMonth:    text("period_month").notNull(),
  journalEntryId: integer("journal_entry_id").references(() => journalEntriesTable.id, { onDelete: "set null" }),
  amount:         numeric("amount", { precision: 18, scale: 2 }).notNull(),
  generatedAt:    timestamp("generated_at").defaultNow().notNull(),
}, (t) => ({
  // Hard idempotency guard: even under concurrent run-due / generate calls,
  // we can never create two runs for the same adjustment+month combination.
  adjMonthUq: uniqueIndex("adj_runs_adj_month_uq").on(t.adjustmentId, t.periodMonth),
}));

export type AccountingAdjustment = typeof accountingAdjustmentsTable.$inferSelect;
export type AccountingAdjustmentRun = typeof accountingAdjustmentRunsTable.$inferSelect;
