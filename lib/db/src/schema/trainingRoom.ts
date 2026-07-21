import { pgTable, serial, integer, text, timestamp, boolean, jsonb, index } from "drizzle-orm/pg-core";

// ─── قاعة التدريب المباشر (LiveKit) ────────────────────────────────────────
// One row per training session. The trainer (company admin / permitted user)
// broadcasts; trainees join subscribe-only either as registered users or via
// a public tokenized link (per-session choice, both may be enabled).
export const trainingSessionsTable = pgTable("training_sessions", {
  id:             serial("id").primaryKey(),
  companyId:      integer("company_id").notNull(),
  trainerUserId:  integer("trainer_user_id").notNull(),
  trainerName:    text("trainer_name"),
  title:          text("title").notNull(),
  description:    text("description"),
  roomName:       text("room_name").notNull().unique(),
  status:         text("status").notNull().default("scheduled"), // scheduled | live | ended
  allowRegistered: boolean("allow_registered").notNull().default(true),
  allowPublic:     boolean("allow_public").notNull().default(false),
  publicToken:    text("public_token").unique(),
  scheduledAt:    timestamp("scheduled_at", { withTimezone: true }),
  startedAt:      timestamp("started_at", { withTimezone: true }),
  endedAt:        timestamp("ended_at", { withTimezone: true }),
  createdAt:      timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  meta:           jsonb("meta"),
}, (t) => ({
  byCompany: index("training_sessions_company_idx").on(t.companyId, t.createdAt),
  byStatus:  index("training_sessions_status_idx").on(t.status),
}));

// Attendance log — one row per join. Registered joins carry user_id; public
// joins carry only the display name typed on the public landing page.
export const trainingAttendanceTable = pgTable("training_attendance", {
  id:          serial("id").primaryKey(),
  sessionId:   integer("session_id").notNull(),
  companyId:   integer("company_id").notNull(),
  userId:      integer("user_id"),
  displayName: text("display_name").notNull(),
  identity:    text("identity").notNull(), // LiveKit participant identity
  isPublic:    boolean("is_public").notNull().default(false),
  joinedAt:    timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  leftAt:      timestamp("left_at", { withTimezone: true }),
}, (t) => ({
  bySession: index("training_attendance_session_idx").on(t.sessionId, t.joinedAt),
}));

// ─── سجل مكالمات الدعم الفني (LiveKit support room) ───────────────────────
export const supportCallLogsTable = pgTable("support_call_logs", {
  id:              serial("id").primaryKey(),
  agentUserId:     integer("agent_user_id").notNull(),
  agentUsername:   text("agent_username"),
  targetUserId:    integer("target_user_id"),
  targetCompanyId: integer("target_company_id"),
  targetLabel:     text("target_label"),
  roomName:        text("room_name").notNull().unique(),
  status:          text("status").notNull().default("pending"), // pending | active | ended
  createdAt:       timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  joinedAt:        timestamp("joined_at", { withTimezone: true }),
  endedAt:         timestamp("ended_at", { withTimezone: true }),
  endReason:       text("end_reason"),
  meta:            jsonb("meta"),
}, (t) => ({
  byAgent:  index("support_call_logs_agent_idx").on(t.agentUserId, t.createdAt),
  byTarget: index("support_call_logs_target_idx").on(t.targetUserId, t.createdAt),
}));

export type TrainingSession = typeof trainingSessionsTable.$inferSelect;
export type TrainingSessionInsert = typeof trainingSessionsTable.$inferInsert;
export type TrainingAttendance = typeof trainingAttendanceTable.$inferSelect;
export type SupportCallLog = typeof supportCallLogsTable.$inferSelect;
