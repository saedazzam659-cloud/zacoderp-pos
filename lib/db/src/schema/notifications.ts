import { pgTable, serial, text, integer, boolean, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// In-app notifications. A notification can be addressed to a specific user
// (userId set) or to all users of a company (userId NULL → "broadcast").
// Created by superadmin from the AI-fix page or by other system events.
export const notificationsTable = pgTable("notifications", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  userId:       integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  title:        text("title").notNull(),
  body:         text("body").notNull(),                  // Markdown
  severity:     text("severity").notNull().default("info"), // info | low | medium | high
  category:     text("category").notNull().default("general"), // e.g. "ai_diagnostic"
  sourceKey:    text("source_key"),                      // e.g. "unbalanced_journals"
  isRead:       boolean("is_read").notNull().default(false),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  readAt:       timestamp("read_at"),
});

export type Notification = typeof notificationsTable.$inferSelect;

// Per-user read receipts. Required for broadcast notifications (userId NULL)
// so that "marking as read" is per-user and not global. For directly-addressed
// notifications we ALSO write a row here on read for uniformity.
export const notificationReadsTable = pgTable("notification_reads", {
  notificationId: integer("notification_id").notNull().references(() => notificationsTable.id, { onDelete: "cascade" }),
  userId:         integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  readAt:         timestamp("read_at").defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.notificationId, t.userId] }),
}));
