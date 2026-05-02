import { pgTable, serial, text, integer, boolean, timestamp, primaryKey, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
}, (t) => ({
  // Idempotency anchor for system-generated notifications (e.g. low-stock
  // alerts use sourceKey="low_stock_item_<id>_<YYYY-MM-DD>"). Partial so
  // that legacy ad-hoc notifications without a sourceKey still work.
  // Combined with INSERT ... ON CONFLICT DO NOTHING this gives us strict
  // dedupe even under concurrent /alerts/notify requests.
  uxNotifSourceKey: uniqueIndex("ux_notifications_company_source_key")
    .on(t.companyId, t.sourceKey)
    .where(sql`${t.sourceKey} IS NOT NULL`),
}));

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

// Per-user dismissals (soft-delete). When a row exists for (notification, user)
// the notification is hidden from that user's lists. Broadcast notifications
// (userId NULL) stay visible to other users; this is per-recipient only.
export const notificationDismissalsTable = pgTable("notification_dismissals", {
  notificationId: integer("notification_id").notNull().references(() => notificationsTable.id, { onDelete: "cascade" }),
  userId:         integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  dismissedAt:    timestamp("dismissed_at").defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.notificationId, t.userId] }),
}));
