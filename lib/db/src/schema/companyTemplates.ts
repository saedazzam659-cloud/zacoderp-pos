import {
  pgTable, serial, integer, text, boolean, timestamp, jsonb,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// ─── Company Templates ────────────────────────────────────────────────────────
// A SuperAdmin-curated "blueprint" that points at a fully-configured SOURCE
// company. Cloning a template creates a brand-new company by copying ONLY the
// source company's SETUP (modules, COA, mappings, settings, print/notification
// setup, default users) — never its transactional data. The source company is
// only ever read from; the clone INSERTs into the new company exclusively.
export const companyTemplatesTable = pgTable("company_templates", {
  id:               serial("id").primaryKey(),
  nameAr:           text("name_ar").notNull(),
  nameEn:           text("name_en"),
  description:      text("description"),
  // Free-text vertical label (تجاري / صناعي / طبي …) for grouping/picking.
  industryName:     text("industry_name"),
  // The company whose setup this template clones FROM.
  sourceCompanyId:  integer("source_company_id").notNull()
                      .references(() => companiesTable.id, { onDelete: "cascade" }),
  isActive:         boolean("is_active").notNull().default(true),
  createdByUserId:  integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
  updatedAt:        timestamp("updated_at").defaultNow().notNull(),
});

export type CompanyTemplate    = typeof companyTemplatesTable.$inferSelect;
export type NewCompanyTemplate = typeof companyTemplatesTable.$inferInsert;

// ─── Company Clone Runs ───────────────────────────────────────────────────────
// Append-only audit trail for every clone operation: which source produced which
// target, by whom, with a per-table count summary. `status='failed'` rows record
// the error for diagnostics (the clone transaction itself rolls back on failure).
export const companyCloneRunsTable = pgTable("company_clone_runs", {
  id:                serial("id").primaryKey(),
  sourceCompanyId:   integer("source_company_id").notNull(),
  targetCompanyId:   integer("target_company_id"),
  templateId:        integer("template_id"),
  performedByUserId: integer("performed_by_user_id"),
  status:            text("status").notNull().default("success"),
  // { accounts: 41, branches: 2, users: 3, ... } — counts of rows inserted.
  summary:           jsonb("summary"),
  error:             text("error"),
  createdAt:         timestamp("created_at").defaultNow().notNull(),
});

export type CompanyCloneRun    = typeof companyCloneRunsTable.$inferSelect;
export type NewCompanyCloneRun = typeof companyCloneRunsTable.$inferInsert;
