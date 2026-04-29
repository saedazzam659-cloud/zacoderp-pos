import { pgTable, serial, text, integer, numeric, timestamp, jsonb } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { accountsTable } from "./accounts";
import { usersTable } from "./users";
import { fiscalYearsTable } from "./fiscalPeriods";
import { journalEntriesTable } from "./journalEntries";

export const trialBalancesTable = pgTable("trial_balances", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  fiscalYearId: integer("fiscal_year_id").references(() => fiscalYearsTable.id),
  fiscalYear:   text("fiscal_year").notNull(),
  periodStart:  text("period_start").notNull(),
  periodEnd:    text("period_end").notNull(),
  balanceType:  text("balance_type").notNull().default("before_review"),
  status:       text("status").notNull().default("draft"),
  notes:        text("notes"),
  totalDebit:   numeric("total_debit",  { precision: 20, scale: 2 }).notNull().default("0"),
  totalCredit:  numeric("total_credit", { precision: 20, scale: 2 }).notNull().default("0"),
  sourceTrialBalanceId: integer("source_trial_balance_id"),
  createdBy:    integer("created_by").references(() => usersTable.id),
  approvedBy:   integer("approved_by").references(() => usersTable.id),
  approvedAt:   timestamp("approved_at"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().notNull(),
});

export const trialBalanceDetailsTable = pgTable("trial_balance_details", {
  id:              serial("id").primaryKey(),
  trialBalanceId:  integer("trial_balance_id").notNull().references(() => trialBalancesTable.id, { onDelete: "cascade" }),
  accountId:       integer("account_id").references(() => accountsTable.id),
  accountCode:     text("account_code").notNull(),
  accountName:     text("account_name").notNull(),
  debit:           numeric("debit",  { precision: 20, scale: 2 }).notNull().default("0"),
  credit:          numeric("credit", { precision: 20, scale: 2 }).notNull().default("0"),
  originalDebit:   numeric("original_debit",  { precision: 20, scale: 2 }).notNull().default("0"),
  originalCredit:  numeric("original_credit", { precision: 20, scale: 2 }).notNull().default("0"),
  changeReason:    text("change_reason"),
  isUnlinked:      integer("is_unlinked").notNull().default(0),
  sortOrder:       integer("sort_order").notNull().default(0),
});

export const trialBalanceAdjustmentsTable = pgTable("trial_balance_adjustments", {
  id:              serial("id").primaryKey(),
  trialBalanceId:  integer("trial_balance_id").notNull().references(() => trialBalancesTable.id, { onDelete: "cascade" }),
  journalEntryId:  integer("journal_entry_id").references(() => journalEntriesTable.id, { onDelete: "set null" }),
  description:     text("description").notNull(),
  category:        text("category").notNull().default("manual"),
  amount:          numeric("amount", { precision: 20, scale: 2 }).notNull().default("0"),
  createdBy:       integer("created_by").references(() => usersTable.id),
  createdAt:       timestamp("created_at").defaultNow().notNull(),
});

export const trialBalanceLogsTable = pgTable("trial_balance_logs", {
  id:              serial("id").primaryKey(),
  trialBalanceId:  integer("trial_balance_id").notNull().references(() => trialBalancesTable.id, { onDelete: "cascade" }),
  userId:          integer("user_id").references(() => usersTable.id),
  action:          text("action").notNull(),
  details:         jsonb("details"),
  createdAt:       timestamp("created_at").defaultNow().notNull(),
});

export type TrialBalance = typeof trialBalancesTable.$inferSelect;
export type TrialBalanceDetail = typeof trialBalanceDetailsTable.$inferSelect;
export type TrialBalanceAdjustment = typeof trialBalanceAdjustmentsTable.$inferSelect;
export type TrialBalanceLog = typeof trialBalanceLogsTable.$inferSelect;
