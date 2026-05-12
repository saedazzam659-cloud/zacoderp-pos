import {
  pgTable, serial, text, integer, numeric, timestamp, boolean, pgEnum, date,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { customersTable } from "./customers";
import { accountsTable } from "./accounts";

// ─── Sales Representatives ────────────────────────────────────────────────────
export const commissionTypeEnum = pgEnum("commission_type", [
  "invoice",     // % of invoice grand total when invoice is posted
  "collection",  // % of receipt amount when payment is collected
]);

export const salesRepsTable = pgTable("sales_reps", {
  id:              serial("id").primaryKey(),
  companyId:       integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  code:            text("code").notNull(),
  nameAr:          text("name_ar").notNull(),
  nameEn:          text("name_en"),
  phone:           text("phone"),
  email:           text("email"),
  address:         text("address"),
  branchId:        integer("branch_id"),
  region:          text("region"),
  isActive:        boolean("is_active").notNull().default(true),
  userId:          integer("user_id"),
  commissionPct:   numeric("commission_pct", { precision: 6, scale: 3 }).notNull().default("0"),
  commissionType:  commissionTypeEnum("commission_type").notNull().default("invoice"),
  monthlyTarget:   numeric("monthly_target", { precision: 15, scale: 2 }).notNull().default("0"),
  accountId:       integer("account_id").references(() => accountsTable.id),
  notes:           text("notes"),
  createdAt:       timestamp("created_at").defaultNow().notNull(),
  updatedAt:       timestamp("updated_at").defaultNow().notNull(),
});

export type SalesRep       = typeof salesRepsTable.$inferSelect;
export type InsertSalesRep = typeof salesRepsTable.$inferInsert;

// ─── Customer Visits ──────────────────────────────────────────────────────────
export const visitStatusEnum = pgEnum("visit_status", [
  "planned", "completed", "cancelled",
]);

export const visitOutcomeEnum = pgEnum("visit_outcome", [
  "none", "interested", "quotation_sent", "deal_closed", "no_interest", "follow_up",
]);

export const salesRepVisitsTable = pgTable("sales_rep_visits", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  salesRepId:   integer("sales_rep_id").notNull().references(() => salesRepsTable.id, { onDelete: "cascade" }),
  customerId:   integer("customer_id").references(() => customersTable.id, { onDelete: "set null" }),
  visitDate:    date("visit_date").notNull(),
  status:       visitStatusEnum("status").notNull().default("completed"),
  outcome:      visitOutcomeEnum("outcome").notNull().default("none"),
  notes:        text("notes"),
  followUpDate: date("follow_up_date"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().notNull(),
});

export type SalesRepVisit       = typeof salesRepVisitsTable.$inferSelect;
export type InsertSalesRepVisit = typeof salesRepVisitsTable.$inferInsert;
