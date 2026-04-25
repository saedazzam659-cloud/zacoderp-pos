import { pgTable, serial, text, boolean, timestamp, integer, jsonb } from "drizzle-orm/pg-core";

// Single-row config (id=1) that controls the SuperAdmin's scheduled-report
// emails. We model it as a regular table (rather than packing JSON into
// system_settings) so future multi-recipient lists or migrations stay easy.
export const reportEmailSchedulesTable = pgTable("report_email_schedules", {
  id:         serial("id").primaryKey(),
  enabled:    boolean("enabled").notNull().default(false),
  // List of report keys to attach as CSV. Currently supported:
  //   "operational-summary" | "revenue-by-plan"
  reports:    jsonb("reports").notNull().$type<string[]>().default([]),
  // "weekly" | "monthly". Drives the next-run countdown (7d / 30d).
  frequency:  text("frequency").notNull().default("weekly"),
  // Recipients: list of plain email addresses.
  recipients: jsonb("recipients").notNull().$type<string[]>().default([]),
  lastSentAt:    timestamp("last_sent_at", { withTimezone: true }),
  lastStatus:    text("last_status"),       // "ok" | "failed" | "no_data" | null
  lastError:     text("last_error"),
  lastReports:   jsonb("last_reports").$type<string[]>(),
  lastRecipients: integer("last_recipients"),
  updatedAt:  timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Append-only history of every send attempt — surfaces the recent activity in
// the admin UI and helps debug delivery problems.
export const reportEmailScheduleRunsTable = pgTable("report_email_schedule_runs", {
  id:        serial("id").primaryKey(),
  ranAt:     timestamp("ran_at", { withTimezone: true }).defaultNow().notNull(),
  trigger:   text("trigger").notNull(),    // "scheduled" | "manual"
  status:    text("status").notNull(),     // "ok" | "failed" | "no_data" | "skipped"
  reports:   jsonb("reports").$type<string[]>(),
  recipients: integer("recipients").notNull().default(0),
  message:   text("message"),
});

export type ReportEmailSchedule = typeof reportEmailSchedulesTable.$inferSelect;
export type ReportEmailScheduleRun = typeof reportEmailScheduleRunsTable.$inferSelect;
