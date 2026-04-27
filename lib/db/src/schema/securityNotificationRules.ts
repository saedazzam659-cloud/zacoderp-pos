import { pgTable, serial, integer, text, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// ─── Security event → notification routing rules ────────────────────
// Per-company rules that decide WHO gets an in-app notification when
// a security_events row is created. Evaluated by the helper
// `runSecurityNotificationRules` in the API server right after the
// event row is inserted. Multiple rules can match a single event;
// each match emits its own notification (so two overlapping rules
// targeting different user groups both fire).
//
// Match shape:
//   - severity rank(event.severity) >= rank(rule.minSeverity)
//   - rule.eventTypes empty OR contains event.eventType
//   - rule.branchIds empty OR contains event.branchId
//
// Target shape:
//   - targetMode = "broadcast" → one notifications row with userId=NULL
//     (visible to every user in the company via the existing list
//     endpoint).
//   - targetMode = "users"     → one notifications row per id in
//     targetUserIds, after re-validating each id still belongs to
//     this company at write time.
export const securityNotificationRulesTable = pgTable("security_notification_rules", {
  id:              serial("id").primaryKey(),
  companyId:       integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  name:            text("name").notNull(),
  isActive:        boolean("is_active").notNull().default(true),
  // low | medium | high | critical — same vocabulary as security_events.severity.
  minSeverity:     text("min_severity").notNull().default("medium"),
  // Empty array = match any event type. Element values come from
  // SECURITY_EVENT_TYPES.
  eventTypes:      text("event_types").array().notNull().default([] as any),
  // Empty array = match any branch (including null branch_id).
  branchIds:       integer("branch_ids").array().notNull().default([] as any),
  // "broadcast" or "users".
  targetMode:      text("target_mode").notNull().default("broadcast"),
  // Used only when targetMode = "users".
  targetUserIds:   integer("target_user_ids").array().notNull().default([] as any),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id),
  createdAt:       timestamp("created_at").defaultNow().notNull(),
  updatedAt:       timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  byCompany: index("security_notification_rules_company_idx").on(t.companyId),
}));

export type SecurityNotificationRule = typeof securityNotificationRulesTable.$inferSelect;
