import {
  pgTable, serial, integer, text, boolean, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";

// Per-company configuration for the Work Sessions feature.
//
// Exactly one row per company. Created lazily on first save: a missing row
// is treated as "all defaults" by the API so existing companies continue to
// work without a migration backfill.
//
// What lives here (and why not on `companies`?):
//   - Email delivery: who receives the AI activity report when a session ends,
//     whether to auto-generate the report on end, and whether to fire on
//     every end (logout, manual end, force-end on new login).
//   - Branch defaults: optionally pin every new session to a default branch,
//     and optionally require the user to confirm/select a branch.
//   - AI controls: which Claude model to use (haiku is cheap and fast, sonnet
//     is more thorough), so admins can dial cost vs. quality without code.
//
// We keep these on a dedicated row instead of the wide `companies` table to
// avoid coupling unrelated migrations and to let the Work Sessions team own
// its own schema evolution.
export const workSessionSettingsTable = pgTable("work_session_settings", {
  id:                       serial("id").primaryKey(),
  companyId:                integer("company_id").notNull(),

  // Email delivery
  emailReportsEnabled:      boolean("email_reports_enabled").notNull().default(false),
  emailRecipients:          text("email_recipients"),                 // comma-separated list
  emailOnSessionEnd:        boolean("email_on_session_end").notNull().default(true),
  autoGenerateReportOnEnd:  boolean("auto_generate_report_on_end").notNull().default(true),

  // Branch
  defaultBranchId:          integer("default_branch_id"),             // FK soft-link to branches.id
  requireBranchSelection:   boolean("require_branch_selection").notNull().default(false),

  // AI
  aiModel:                  text("ai_model").notNull().default("claude-haiku-4-5"),

  // Optional: future idle-timeout sweeper
  idleTimeoutMinutes:       integer("idle_timeout_minutes"),

  updatedByUserId:          integer("updated_by_user_id"),
  createdAt:                timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:                timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  // One settings row per company.
  oneRowPerCompany: uniqueIndex("work_session_settings_company_idx").on(t.companyId),
}));

export type WorkSessionSettingsRow    = typeof workSessionSettingsTable.$inferSelect;
export type WorkSessionSettingsInsert = typeof workSessionSettingsTable.$inferInsert;
