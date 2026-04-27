import {
  pgTable, serial, text, integer, timestamp, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// ─── Sessions (admin-managed manual entity) ─────────────────────────────────
// NOTE: This is intentionally separate from `work_sessions` (which remains the
// per-login auto-created activity log feeding AI reports). These named sessions
// are created by admins, assigned to one or many users via session_users, and
// optionally recorded on operations (sales invoices, vouchers, …) so an
// operation can be grouped under a named work shift / period.
export const sessionsTable = pgTable("sessions", {
  id:        serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  name:      text("name").notNull(),
  notes:     text("notes"),
  // active | archived
  status:    text("status").notNull().default("active"),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  byCompany: index("sessions_company_idx").on(t.companyId, t.status),
}));

export const sessionUsersTable = pgTable("session_users", {
  id:        serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => sessionsTable.id, { onDelete: "cascade" }),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  addedByUserId: integer("added_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  addedAt:   timestamp("added_at").defaultNow().notNull(),
}, (t) => ({
  uniq: uniqueIndex("session_users_uniq").on(t.sessionId, t.userId),
  byUser: index("session_users_user_idx").on(t.userId),
}));

export const insertSessionSchema = createInsertSchema(sessionsTable).omit({
  id: true, createdAt: true, updatedAt: true, archivedAt: true,
});
export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessionsTable.$inferSelect;
export type SessionUser = typeof sessionUsersTable.$inferSelect;
