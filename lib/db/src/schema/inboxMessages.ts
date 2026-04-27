import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// In-app inbox: persistent per-user messages with optional CSV / PDF
// attachments. Used for delivering generated reports (manual or AI-driven)
// to users without going through SMTP. A message addressed to a single user
// has recipientUserId set; a broadcast to the whole company has it NULL.
//
// Why this is separate from `notifications`:
//   - notifications are short, ephemeral, rendered in a popover bell
//   - inbox messages are full-body, may carry attachments, and are read in
//     a dedicated screen with a preview pane.
// The two coexist: the AI/report delivery helper drops a row in BOTH tables
// (an inbox row with the body+attachment, a notification row that links to
// the inbox row so the bell wakes the user up).
export const inboxMessagesTable = pgTable("inbox_messages", {
  id:                 serial("id").primaryKey(),
  companyId:          integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  recipientUserId:    integer("recipient_user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  // 'report' (auto/AI), 'system' (housekeeping), 'message' (admin → user note).
  kind:               text("kind").notNull().default("report"),
  subject:            text("subject").notNull(),
  body:               text("body").notNull(),               // HTML or Markdown
  // Attachment is optional; when set, attachmentUrl is an internal `/objects/...`
  // entity path (private, served by storage router with auth).
  attachmentUrl:      text("attachment_url"),
  attachmentFilename: text("attachment_filename"),
  attachmentMime:     text("attachment_mime"),
  // Optional cross-link to the notification row so the inbox UI can show
  // "marked read in bell ↔ marked read here" symmetry later.
  notificationId:     integer("notification_id"),
  createdByUserId:    integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt:          timestamp("created_at").defaultNow().notNull(),
  // Per-row read marker. Broadcast rows ignore this and rely on a separate
  // per-user receipt table (added later if we ever need broadcasts here).
  readAt:             timestamp("read_at"),
}, (t) => ({
  byRecipient: index("inbox_messages_recipient_idx").on(t.companyId, t.recipientUserId, t.createdAt),
  byUnread:    index("inbox_messages_unread_idx").on(t.recipientUserId, t.readAt),
}));

export type InboxMessage = typeof inboxMessagesTable.$inferSelect;
export type NewInboxMessage = typeof inboxMessagesTable.$inferInsert;
