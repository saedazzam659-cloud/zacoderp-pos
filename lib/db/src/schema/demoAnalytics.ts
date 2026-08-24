import { boolean, index, integer, pgTable, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";

// These are control-plane records.  Local IDs are deliberately scalar values:
// an agent database can have the same numeric IDs as another agent (or central).
const source = {
  sourceKind: varchar("source_kind", { length: 12 }).notNull(), // central | agent
  sourceInstanceId: integer("source_instance_id"),
  localCompanyId: integer("local_company_id"),
  localUserId: integer("local_user_id"),
};

export const demoAnalyticsProfilesTable = pgTable("demo_analytics_profiles", {
  id: serial("id").primaryKey(),
  ...source,
  phone: varchar("phone", { length: 32 }),
  device: varchar("device", { length: 32 }),
  leadStatus: varchar("lead_status", { length: 32 }).notNull().default("new"),
  leadNotes: text("lead_notes"),
  followUpAt: timestamp("follow_up_at", { withTimezone: true }),
  loginCount: integer("login_count").notNull().default(0),
  totalDurationMs: integer("total_duration_ms").notNull().default(0),
  interestScore: integer("interest_score").notNull().default(0),
  interestCategory: varchar("interest_category", { length: 24 }).notNull().default("new_visitor"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  identity: uniqueIndex("demo_analytics_profiles_identity_uq").on(t.sourceKind, t.sourceInstanceId, t.localCompanyId, t.localUserId),
  phone: index("demo_analytics_profiles_phone_idx").on(t.phone),
}));

export const demoAnalyticsPoliciesTable = pgTable("demo_analytics_policies", {
  id: serial("id").primaryKey(),
  profileId: integer("profile_id").notNull().references(() => demoAnalyticsProfilesTable.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(true),
  actionLimit: integer("action_limit").notNull().default(25),
  warningRemaining: integer("warning_remaining").notNull().default(5),
  subscriptionMessage: text("subscription_message"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ profile: uniqueIndex("demo_analytics_policies_profile_uq").on(t.profileId) }));

export const demoAnalyticsSessionsTable = pgTable("demo_analytics_sessions", {
  id: serial("id").primaryKey(),
  profileId: integer("profile_id").notNull().references(() => demoAnalyticsProfilesTable.id, { onDelete: "cascade" }),
  sessionKey: varchar("session_key", { length: 128 }).notNull(),
  deviceType: varchar("device_type", { length: 16 }),
  os: varchar("os", { length: 80 }),
  browser: varchar("browser", { length: 80 }),
  userAgent: varchar("user_agent", { length: 300 }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationMs: integer("duration_ms").notNull().default(0),
}, (t) => ({ key: uniqueIndex("demo_analytics_sessions_key_uq").on(t.profileId, t.sessionKey), profile: index("demo_analytics_sessions_profile_idx").on(t.profileId) }));

export const demoAnalyticsEventsTable = pgTable("demo_analytics_events", {
  id: serial("id").primaryKey(),
  profileId: integer("profile_id").notNull().references(() => demoAnalyticsProfilesTable.id, { onDelete: "cascade" }),
  eventId: varchar("event_id", { length: 128 }).notNull(),
  type: varchar("type", { length: 48 }).notNull(),
  moduleKey: varchar("module_key", { length: 80 }),
  screenKey: varchar("screen_key", { length: 120 }),
  actionKey: varchar("action_key", { length: 120 }),
  route: varchar("route", { length: 240 }),
  durationMs: integer("duration_ms"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ event: uniqueIndex("demo_analytics_events_profile_event_uq").on(t.profileId, t.eventId), profile: index("demo_analytics_events_profile_idx").on(t.profileId) }));

export const demoActionReservationsTable = pgTable("demo_action_reservations", {
  id: serial("id").primaryKey(),
  profileId: integer("profile_id").notNull().references(() => demoAnalyticsProfilesTable.id, { onDelete: "cascade" }),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
  route: varchar("route", { length: 240 }).notNull(),
  status: varchar("status", { length: 16 }).notNull().default("reserved"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
}, (t) => ({ key: uniqueIndex("demo_action_reservations_key_uq").on(t.profileId, t.idempotencyKey), profile: index("demo_action_reservations_profile_idx").on(t.profileId, t.status) }));

export const demoActionLedgerTable = pgTable("demo_action_ledger", {
  id: serial("id").primaryKey(),
  reservationId: integer("reservation_id").notNull().references(() => demoActionReservationsTable.id, { onDelete: "cascade" }),
  profileId: integer("profile_id").notNull().references(() => demoAnalyticsProfilesTable.id, { onDelete: "cascade" }),
  actionKey: varchar("action_key", { length: 120 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ reservation: uniqueIndex("demo_action_ledger_reservation_uq").on(t.reservationId), profile: index("demo_action_ledger_profile_idx").on(t.profileId) }));

export const demoAgentBatchReceiptsTable = pgTable("demo_agent_batch_receipts", {
  id: serial("id").primaryKey(),
  sourceInstanceId: integer("source_instance_id").notNull(),
  receiptKey: varchar("receipt_key", { length: 160 }).notNull(),
  eventCount: integer("event_count").notNull().default(0),
  status: varchar("status", { length: 16 }).notNull().default("processing"),
  error: varchar("error", { length: 300 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ receipt: uniqueIndex("demo_agent_batch_receipts_uq").on(t.sourceInstanceId, t.receiptKey) }));