import { pgTable, serial, text, boolean, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

export const currenciesTable = pgTable("currencies", {
  id:        serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companiesTable.id).notNull(),
  code:      text("code").notNull(),
  nameAr:    text("name_ar").notNull(),
  nameEn:    text("name_en"),
  symbol:    text("symbol"),
  isDefault: boolean("is_default").notNull().default(false),
  isActive:  boolean("is_active").notNull().default(true),
  notes:     text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const exchangeRatesTable = pgTable("exchange_rates", {
  id:             serial("id").primaryKey(),
  companyId:      integer("company_id").references(() => companiesTable.id).notNull(),
  fromCurrencyId: integer("from_currency_id").references(() => currenciesTable.id).notNull(),
  toCurrencyId:   integer("to_currency_id").references(() => currenciesTable.id).notNull(),
  rate:           numeric("rate", { precision: 18, scale: 6 }).notNull().default("1"),
  effectiveDate:  text("effective_date").notNull(),
  notes:          text("notes"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
});
