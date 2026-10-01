import { pgTable, serial, integer, text, timestamp, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { salesInvoicesTable } from "./sales";
import { contractingProgressBillsTable } from "./contracting";

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

/**
 * One idempotency/status record per country provider, environment, and invoice.
 * No invoice payload or credential is retained in this table.
 */
export const taxIntegrationSubmissionsTable = pgTable("tax_integration_submissions", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  invoiceId: integer("invoice_id").notNull().references(() => salesInvoicesTable.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  environment: text("environment").notNull(),
  status: text("status").notNull(),
  attemptCount: integer("attempt_count").notNull().default(1),
  documentUuid: text("document_uuid"),
  providerSubmissionId: text("provider_submission_id"),
  responseCode: text("response_code"),
  errorCode: text("error_code"),
  requestHash: text("request_hash"),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  companyProviderInvoice: uniqueIndex("tax_submission_company_provider_invoice_uniq")
    .on(t.companyId, t.provider, t.invoiceId, t.environment),
  byCompanyStatus: index("tax_submission_company_status_idx")
    .on(t.companyId, t.provider, t.status),
}));

/**
 * Local-provider progress-bill submissions are separate from sales-invoice
 * submissions because their source document and foreign key are different.
 * The row stores status/hash metadata only; provider documents are not retained.
 */
export const contractingTaxSubmissionsTable = pgTable("contracting_tax_submissions", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  billId: integer("bill_id").notNull().references(() => contractingProgressBillsTable.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  environment: text("environment").notNull(),
  status: text("status").notNull(),
  attemptCount: integer("attempt_count").notNull().default(1),
  documentUuid: text("document_uuid"),
  providerSubmissionId: text("provider_submission_id"),
  responseCode: text("response_code"),
  errorCode: text("error_code"),
  requestHash: text("request_hash"),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  companyProviderBill: uniqueIndex("ctg_tax_submission_company_provider_bill_uniq")
    .on(t.companyId, t.provider, t.billId, t.environment),
  byCompanyStatus: index("ctg_tax_submission_company_status_idx")
    .on(t.companyId, t.provider, t.status),
}));


export type TaxIntegrationSetup = typeof taxIntegrationSetupsTable.$inferSelect;
export type TaxIntegrationSubmission = typeof taxIntegrationSubmissionsTable.$inferSelect;