import { pgTable, serial, text, integer, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

export const fiscalPeriodStatusEnum = pgEnum("fiscal_period_status", [
  "open", "closed", "permanently_closed",
]);

export const fiscalYearsTable = pgTable("fiscal_years", {
  id:        serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  name:      text("name").notNull(),
  startDate: text("start_date").notNull(),
  endDate:   text("end_date").notNull(),
  status:    fiscalPeriodStatusEnum("status").notNull().default("open"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const fiscalPeriodsTable = pgTable("fiscal_periods", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  fiscalYearId: integer("fiscal_year_id").notNull().references(() => fiscalYearsTable.id, { onDelete: "cascade" }),
  name:         text("name").notNull(),
  startDate:    text("start_date").notNull(),
  endDate:      text("end_date").notNull(),
  status:       fiscalPeriodStatusEnum("status").notNull().default("open"),
  sequence:     integer("sequence").notNull().default(1),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().notNull(),
});

export type FiscalYear = typeof fiscalYearsTable.$inferSelect;
export type FiscalPeriod = typeof fiscalPeriodsTable.$inferSelect;
