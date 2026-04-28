import { pgTable, serial, text, varchar, integer, timestamp, index } from "drizzle-orm/pg-core";

export const reportEmailInvitationsTable = pgTable(
  "report_email_invitations",
  {
    id:                serial("id").primaryKey(),
    token:             varchar("token", { length: 64 }).notNull().unique(),
    email:             varchar("email", { length: 320 }).notNull(),
    invitedByUserId:   integer("invited_by_user_id"),
    invitedByUsername: text("invited_by_username"),
    invitedFromIp:     varchar("invited_from_ip", { length: 64 }),
    createdAt:         timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt:         timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt:        timestamp("accepted_at", { withTimezone: true }),
    acceptedFromIp:    varchar("accepted_from_ip", { length: 64 }),
    revokedAt:         timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId:   integer("revoked_by_user_id"),
  },
  (t) => ({
    emailIdx: index("report_email_invitations_email_idx").on(t.email),
  }),
);

export type ReportEmailInvitation = typeof reportEmailInvitationsTable.$inferSelect;
