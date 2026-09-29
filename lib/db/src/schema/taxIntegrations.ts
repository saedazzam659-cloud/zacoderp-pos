import { pgTable, serial, integer, text, timestamp, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

/** Country-specific tax setup. Secrets are encrypted before they reach this table. */
export const taxIntegrationSetupsTable = pgTable("tax_integration_setups", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  country: text("country").notNull(),
  provider: text("provider").notNull(),
  environment: text("environment").notNull(),
  credentialsEnc: text("credentials_enc").notNull(),
  status: text("status").notNull().default("configured_unverified"),
  updatedBy: integer("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  companyProvider: uniqueIndex("tax_setup_company_provider_uniq").on(t.companyId, t.provider),
  byCompany: index("tax_setup_company_idx").on(t.companyId),
}));

export const taxIntegrationAuditTable = pgTable("tax_integration_audit", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  userId: integer("user_id"),
  provider: text("provider").notNull(),
  action: text("action").notNull(),
  environment: text("environment"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byCompanyTime: index("tax_setup_audit_company_time_idx").on(t.companyId, t.createdAt),
}));

export type TaxIntegrationSetup = typeof taxIntegrationSetupsTable.$inferSelect;