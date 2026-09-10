import {
  pgTable, serial, text, integer, numeric, boolean, timestamp, pgEnum, uniqueIndex, jsonb,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { accountsTable } from "./accounts";
import { journalEntriesTable } from "./journalEntries";
import { costCentersTable } from "./costCenters";

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
  // Optional cost-center dimension. Rides ONLY the EXPENSE (debit) line of
  // each generated monthly JE — the prepaid/accrued contra line stays
  // cost-center-free (BS accounts carry no cost dimension).
  costCenterId:        integer("cost_center_id").references(() => costCentersTable.id, { onDelete: "set null" }),
  totalAmount:         numeric("total_amount", { precision: 18, scale: 2 }).notNull(),
  startDate:           text("start_date").notNull(),
  endDate:             text("end_date").notNull(),
  monthlyAmount:       numeric("monthly_amount", { precision: 18, scale: 2 }).notNull(),
  // ── Deferred-expense extensions (ADDITIVE — default behavior unchanged) ──
  // periodicity: how installments are grouped along the anniversary schedule.
  //   'monthly' (default) = one installment per month (legacy behavior)
  //   'quarterly' = every 3 months, amount = 3 monthly slices summed
  //   'semiannual' = every 6 months, 'annual' = every 12 months.
  periodicity:         text("periodicity").notNull().default("monthly"),
  // Optional link back to the originating document (e.g. a purchase-invoice
  // line whose item group is "مصروف يوزع على فترات"). NULL = manual adjustment.
  sourceType:          text("source_type"),
  sourceId:            integer("source_id"),
  // Optional multi-cost-center split for the EXPENSE (debit) side of each
  // periodic JE: [{ costCenterId: number, pct: number }] — pcts sum to 100.
  // When set it overrides costCenterId; the contra line stays dimension-free.
  costCenterSplit:     jsonb("cost_center_split"),
  // Explicit production link. Only prepaid runs with this opt-in and a valid
  // approved quantity denominator are offered to manufacturing.
  manufacturingEligible: boolean("manufacturing_eligible").notNull().default(false),
  manufacturingAllocationMethod: text("manufacturing_allocation_method").notNull().default("none"),
  approvedProductionQuantity: numeric("approved_production_quantity", { precision: 14, scale: 4 }),
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
