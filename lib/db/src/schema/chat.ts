import { pgTable, serial, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// ─────────────────────────────────────────────────────────────────────────
// Internal Chat module — phase 1: real-time text chat with AI insights.
// Multi-tenant: every conversation/message carries companyId. Cross-company
// chat is forbidden at the API layer (see routes/chat.ts).
// ─────────────────────────────────────────────────────────────────────────

export const chatConversationsTable = pgTable("chat_conversations", {
  id:               serial("id").primaryKey(),
  companyId:        integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  // 'direct' = 1:1 chat, 'group' = N participants with a shared title.
  kind:             text("kind").notNull().default("direct"),
  title:            text("title"),
  createdByUserId:  integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
  // Bumped on every new message so list ordering is O(1).
  lastMessageAt:    timestamp("last_message_at").defaultNow().notNull(),
}, (t) => ({
  byCompany: index("chat_conv_company_idx").on(t.companyId, t.lastMessageAt),
}));

export const chatParticipantsTable = pgTable("chat_participants", {
  id:                  serial("id").primaryKey(),
  conversationId:      integer("conversation_id").notNull().references(() => chatConversationsTable.id, { onDelete: "cascade" }),
  userId:              integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  // 'owner' = creator (can rename / add / remove others), 'member' = ordinary participant.
  role:                text("role").notNull().default("member"),
  joinedAt:            timestamp("joined_at").defaultNow().notNull(),
  // Read-receipt anchor: the id of the last message this user has seen in
  // this conversation. Used to compute unread counts cheaply.
  lastReadMessageId:   integer("last_read_message_id"),
  lastReadAt:          timestamp("last_read_at"),
}, (t) => ({
  uniq:    uniqueIndex("chat_participants_uniq").on(t.conversationId, t.userId),
  byUser:  index("chat_participants_user_idx").on(t.userId),
}));

export const chatMessagesTable = pgTable("chat_messages", {
  id:                serial("id").primaryKey(),
  conversationId:    integer("conversation_id").notNull().references(() => chatConversationsTable.id, { onDelete: "cascade" }),
  // Denormalised companyId to make tenant-scoped queries trivial without a join.
  companyId:         integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  senderUserId:      integer("sender_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  // 'text' (most messages), 'image', 'file' — drives client-side rendering.
  kind:              text("kind").notNull().default("text"),
  body:              text("body").notNull().default(""),
  attachmentUrl:     text("attachment_url"),
  attachmentName:    text("attachment_name"),
  attachmentMime:    text("attachment_mime"),
  attachmentSize:    integer("attachment_size"),
  // Optional reply target — UI renders a quoted preview when set.
  replyToId:         integer("reply_to_id"),
  createdAt:         timestamp("created_at").defaultNow().notNull(),
  editedAt:          timestamp("edited_at"),
  // Soft-delete: messages stay in the DB but the body is cleared on the API.
  deletedAt:         timestamp("deleted_at"),
}, (t) => ({
  byConv:    index("chat_messages_conv_idx").on(t.conversationId, t.createdAt),
  byCompany: index("chat_messages_company_idx").on(t.companyId, t.createdAt),
}));

export type ChatConversation = typeof chatConversationsTable.$inferSelect;
export type ChatParticipant  = typeof chatParticipantsTable.$inferSelect;
export type ChatMessage      = typeof chatMessagesTable.$inferSelect;
