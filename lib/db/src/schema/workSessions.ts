import {
  pgTable, serial, integer, text, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Work-session log: each user login opens a "work session"; logout (or
// the optional manual "End session" button) closes it. Once closed, the
// session can be paired with an AI-generated activity report drawn from
// the centralized `audit_log` rows that fall inside the session window.
//
// Why a dedicated table instead of inferring from audit_log alone?
// - Sessions need a stable identity even for users who never perform any
//   recorded mutations (so they still show up as "logged in").
// - The AI report is expensive to regenerate, so we cache the rendered
//   Markdown alongside a "generated at" stamp.
// - We denormalise `username` and `companyId` so the row stays meaningful
//   if the user is later renamed or moved.
//
// Status semantics:
//   - "active": session is currently open (user has not logged out yet).
//   - "ended":  session was closed (logout, or manual end click, or the
//               "force-end on new login" branch).
export const workSessionsTable = pgTable("work_sessions", {
  id:                  serial("id").primaryKey(),
  companyId:           integer("company_id").notNull(),
  userId:              integer("user_id").notNull(),
  username:            text("username"),                   // snapshot for display
  startedAt:           timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  endedAt:             timestamp("ended_at",   { withTimezone: true }),
  status:              text("status").notNull().default("active"),     // active | ended
  endReason:           text("end_reason"),                              // logout | manual | new_login | system
  ip:                  text("ip"),                                      // client IP at login
  userAgent:           text("user_agent"),                              // UA string at login
  // Optional branch tag for the session. When the user has access to a
  // single branch (or the company has a "default branch" configured), this
  // is filled at login time. Otherwise the user can pick/change it later
  // from the session detail dialog. Plain integer (no FK constraint) to
  // avoid blocking login if the branch row is later deleted.
  branchId:            integer("branch_id"),
  notes:               text("notes"),                                   // optional admin/user note
  aiReport:            text("ai_report"),                               // cached Markdown report
  aiReportGeneratedAt: timestamp("ai_report_generated_at", { withTimezone: true }),
  activityCount:       integer("activity_count").default(0).notNull(),  // last-counted audit rows
  createdAt:           timestamp("created_at",  { withTimezone: true }).defaultNow().notNull(),
  updatedAt:           timestamp("updated_at",  { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byCompanyTime: index("work_sessions_company_time_idx").on(t.companyId, t.startedAt),
  byUserTime:    index("work_sessions_user_time_idx").on(t.userId, t.startedAt),
  byStatus:      index("work_sessions_status_idx").on(t.companyId, t.status),
  // Enforce the "one active session per (user, company)" invariant at the DB
  // layer. Concurrent logins would otherwise race past the application-level
  // close-then-insert and create duplicate active rows. Partial unique index
  // on status='active' lets ended rows accumulate freely.
  oneActivePerUser: uniqueIndex("work_sessions_one_active_per_user_idx")
    .on(t.userId, t.companyId)
    .where(sql`status = 'active'`),
}));

export type WorkSessionRow    = typeof workSessionsTable.$inferSelect;
export type WorkSessionInsert = typeof workSessionsTable.$inferInsert;
