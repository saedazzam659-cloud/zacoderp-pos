import { pgTable, serial, integer, text, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { securityEventsTable } from "./securityEvents";

// ─── Audit trail of actions dispatched by the security AI engine ─────
// Every time the rule engine — or a human via the AI screen — turns a
// security event into an ERP outcome (HR violation, production task,
// notification, …) we append a row here. The original event keeps a
// summary in `security_events.actions_taken` (jsonb), but this table
// is the canonical audit log and what the reports query.
export const securityActionsTable = pgTable("security_actions", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  eventId:      integer("event_id").references(() => securityEventsTable.id, { onDelete: "set null" }),

  // 'notify' | 'task' | 'violation' | 'evaluation' | 'stop_process'
  kind:         text("kind").notNull(),
  // Which ERP module the action lives in: hr | production | inventory | none
  targetModule: text("target_module").notNull().default("none"),
  // Free-form id inside that module (employee_id for a violation, …).
  targetRefId:  integer("target_ref_id"),

  title:        text("title").notNull(),
  details:      text("details"),

  // 'pending' | 'completed' | 'failed'
  status:       text("status").notNull().default("completed"),

  payload:      jsonb("payload"),

  createdByUserId: integer("created_by_user_id"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byCompany: index("security_actions_company_idx").on(t.companyId),
  byEvent:   index("security_actions_event_idx").on(t.eventId),
  byModule:  index("security_actions_module_idx").on(t.companyId, t.targetModule),
}));

export type SecurityAction = typeof securityActionsTable.$inferSelect;
export type SecurityActionInsert = typeof securityActionsTable.$inferInsert;
