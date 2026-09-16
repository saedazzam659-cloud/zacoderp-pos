import {
  pgTable,
  serial,
  integer,
  numeric,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { accountsTable } from "./accounts";
import { usersTable } from "./users";

/**
 * Company-wide defaults and accounting policy for the contracting module.
 *
 * Contract rows keep immutable copies of the advance-recovery and retention
 * values that were in force when they were created. This row therefore only
 * supplies defaults for new contracts and the selectable policy used by the
 * detail editor; it must never rewrite existing contract/bill snapshots.
 */
export const contractingSettingsTable = pgTable(
  "contracting_settings",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    defaultAdvanceRecoveryEnabled: boolean("default_advance_recovery_enabled")
      .notNull()
      .default(false),
    defaultAdvanceRecoveryPercent: numeric("default_advance_recovery_percent", {
      precision: 5,
      scale: 2,
    }).notNull().default("0"),
    defaultAdvanceRecoveryStartProgressPercent: numeric(
      "default_advance_recovery_start_progress_percent",
      { precision: 5, scale: 2 },
    ).notNull().default("0"),
    defaultRetentionEnabled: boolean("default_retention_enabled")
      .notNull()
      .default(true),
    defaultRetentionPercent: numeric("default_retention_percent", {
      precision: 5,
      scale: 2,
    }).notNull().default("5"),
    defaultRetentionCapPercent: numeric("default_retention_cap_percent", {
      precision: 5,
      scale: 2,
    }).notNull().default("100"),
    // The list is intentionally data, rather than a database enum.  Tenants
    // can hide an adjustment type without a destructive schema migration.
    adjustmentTypes: jsonb("adjustment_types").$type<string[]>().notNull().default([
      "advance_recovery",
      "retention",
      "material_deduction",
      "penalty",
      "addition",
      "other_deduction",
    ]),
    // Exact role-key -> account-id overrides for future/tenant-defined
    // adjustment types.  The dedicated columns below cover the built-in keys
    // and make the common mappings easy to query and display.
    adjustmentAccountMappings: jsonb("adjustment_account_mappings")
      .$type<Record<string, number>>()
      .notNull().default({}),
    advanceRecoveryAccountId: integer("advance_recovery_account_id")
      .references(() => accountsTable.id, { onDelete: "set null" }),
    retentionAccountId: integer("retention_account_id")
      .references(() => accountsTable.id, { onDelete: "set null" }),
    materialDeductionAccountId: integer("material_deduction_account_id")
      .references(() => accountsTable.id, { onDelete: "set null" }),
    penaltyAccountId: integer("penalty_account_id")
      .references(() => accountsTable.id, { onDelete: "set null" }),
    additionAccountId: integer("addition_account_id")
      .references(() => accountsTable.id, { onDelete: "set null" }),
    otherDeductionAccountId: integer("other_deduction_account_id")
      .references(() => accountsTable.id, { onDelete: "set null" }),
    // Override approval remains subject to the user's contracting:overrun
    // permission.  This role allow-list adds a company-level approval policy.
    overrideApprovalRequired: boolean("override_approval_required")
      .notNull().default(true),
    overrideApproverRoles: jsonb("override_approver_roles")
      .$type<string[]>().notNull().default(["admin", "user", "cashier"]),
    updatedByUserId: integer("updated_by_user_id")
      .references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    oneRowPerCompany: uniqueIndex("contracting_settings_company_idx").on(t.companyId),
  }),
);

export type ContractingSettingsRow = typeof contractingSettingsTable.$inferSelect;
export type ContractingSettingsInsert = typeof contractingSettingsTable.$inferInsert;