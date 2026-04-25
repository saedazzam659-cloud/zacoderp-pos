import { pgTable, serial, integer, text, timestamp, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

// Per-(company, tool) result row written every time a scheduled or manual scan
// finishes. Kept append-only so the UI can show "آخر فحص" + a short trend
// without joining against the audit_log (which only records fix actions).
export const maintenanceRunsTable = pgTable("maintenance_runs", {
  id:        serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  toolKey:   text("tool_key").notNull(),                // e.g. "journal-pending"
  status:    text("status").notNull(),                  // "ok" | "warn" | "critical" | "error"
  count:     integer("count").notNull().default(0),
  trigger:   text("trigger").notNull().default("scheduled"), // "scheduled" | "manual"
  runAt:     timestamp("run_at", { withTimezone: true }).defaultNow().notNull(),
  durationMs: integer("duration_ms").notNull().default(0),
  error:     text("error"),                             // populated when status = "error"
  details:   jsonb("details"),                          // tool-specific extras (e.g. salesCount, sequencesAffected)
}, (t) => ({
  byCompanyTool: index("maintenance_runs_company_tool_idx").on(t.companyId, t.toolKey, t.runAt),
  byRunAt:       index("maintenance_runs_run_at_idx").on(t.runAt),
}));

// Single-row schedule config (id=1) — same pattern as report_email_schedules.
// Fields are intentionally tiny: enabling, the local time-of-day (KSA), and a
// "lastTickAt" we use to throttle so a missed minute doesn't double-fire.
export const maintenanceScheduleTable = pgTable("maintenance_schedule", {
  id:           serial("id").primaryKey(),
  enabled:      boolean("enabled").notNull().default(true),
  // Local time of day at which the daily scan should fire. KSA is fixed at
  // UTC+3 (no DST), so we compare against `now()` shifted by 3h.
  hourOfDay:    integer("hour_of_day").notNull().default(3),     // 0..23
  minuteOfHour: integer("minute_of_hour").notNull().default(0),  // 0..59
  // Critical-status alert banner is dismissed by writing the timestamp here
  // so it doesn't reappear until a new run lifts the count back up.
  alertsMutedUntil: timestamp("alerts_muted_until", { withTimezone: true }),
  lastTickAt:   timestamp("last_tick_at", { withTimezone: true }),
  lastRunAt:    timestamp("last_run_at", { withTimezone: true }),
  lastRunStatus: text("last_run_status"),                        // "ok" | "partial" | "failed"
  lastRunCompanies: integer("last_run_companies").notNull().default(0),
  lastRunCriticalCount: integer("last_run_critical_count").notNull().default(0),
  lastError:    text("last_error"),
  updatedAt:    timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type MaintenanceRun = typeof maintenanceRunsTable.$inferSelect;
export type MaintenanceSchedule = typeof maintenanceScheduleTable.$inferSelect;
