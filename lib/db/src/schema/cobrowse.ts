import { pgTable, serial, integer, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const cobrowseSessionsTable = pgTable("cobrowse_sessions", {
  id:                serial("id").primaryKey(),
  inviteToken:       text("invite_token").notNull().unique(),
  agentUserId:       integer("agent_user_id").notNull(),
  agentUsername:     text("agent_username"),
  customerUserId:    integer("customer_user_id"),
  customerCompanyId: integer("customer_company_id"),
  customerLabel:     text("customer_label"),
  state:             text("state").notNull().default("pending"),
  controlState:      text("control_state").notNull().default("none"),
  createdAt:         timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  joinedAt:          timestamp("joined_at", { withTimezone: true }),
  controlGrantedAt:  timestamp("control_granted_at", { withTimezone: true }),
  controlEndedAt:    timestamp("control_ended_at", { withTimezone: true }),
  endedAt:           timestamp("ended_at", { withTimezone: true }),
  endReason:         text("end_reason"),
  ipAgent:           text("ip_agent"),
  ipCustomer:        text("ip_customer"),
  meta:              jsonb("meta"),
}, (t) => ({
  byAgent:    index("cobrowse_agent_idx").on(t.agentUserId, t.createdAt),
  byCustomer: index("cobrowse_customer_idx").on(t.customerUserId, t.createdAt),
  byState:    index("cobrowse_state_idx").on(t.state),
}));

export type CobrowseSession = typeof cobrowseSessionsTable.$inferSelect;
export type CobrowseSessionInsert = typeof cobrowseSessionsTable.$inferInsert;
