import { pgTable, serial, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

export const supportMessagesTable = pgTable("support_messages", {
  id:               serial("id").primaryKey(),
  companyId:        integer("company_id").references(() => companiesTable.id, { onDelete: "set null" }),
  userId:           integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  senderName:       text("sender_name"),
  companyName:      text("company_name"),
  subject:          text("subject").notNull(),
  body:             text("body").notNull(),
  category:         text("category").notNull().default("general"),
  priority:         text("priority").notNull().default("normal"),
  status:           text("status").notNull().default("open"),
  adminReply:       text("admin_reply"),
  adminReplyAt:     timestamp("admin_reply_at"),
  resolvedAt:       timestamp("resolved_at"),
  resolvedByUserId: integer("resolved_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
  updatedAt:        timestamp("updated_at").defaultNow().notNull(),
});

export type SupportMessage = typeof supportMessagesTable.$inferSelect;

export const supportSettingsTable = pgTable("support_settings", {
  id:                   serial("id").primaryKey(),
  inAppEnabled:         boolean("in_app_enabled").notNull().default(true),
  webhookEnabled:       boolean("webhook_enabled").notNull().default(false),
  webhookUrl:           text("webhook_url"),
  webhookSecret:        text("webhook_secret"),
  telegramEnabled:      boolean("telegram_enabled").notNull().default(false),
  telegramBotToken:     text("telegram_bot_token"),
  telegramChatId:       text("telegram_chat_id"),
  emailEnabled:         boolean("email_enabled").notNull().default(false),
  emailRecipients:      text("email_recipients"),
  notifySuperadminInApp:boolean("notify_superadmin_in_app").notNull().default(true),
  updatedAt:            timestamp("updated_at").defaultNow().notNull(),
  updatedByUserId:      integer("updated_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
});

export type SupportSettings = typeof supportSettingsTable.$inferSelect;
