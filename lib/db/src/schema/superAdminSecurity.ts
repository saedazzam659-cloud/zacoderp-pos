import {
  pgTable, serial, integer, text, timestamp, boolean, jsonb, index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const superAdminOtpCodesTable = pgTable("sa_otp_codes", {
  id:                 serial("id").primaryKey(),
  userId:             integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  challengeToken:     text("challenge_token").notNull().unique(),
  codeHash:           text("code_hash").notNull(),
  purpose:            text("purpose").notNull(),
  deviceFingerprint:  text("device_fingerprint"),
  ip:                 text("ip"),
  userAgent:          text("user_agent"),
  attempts:           integer("attempts").notNull().default(0),
  expiresAt:          timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt:         timestamp("consumed_at", { withTimezone: true }),
  createdAt:          timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byUser:    index("sa_otp_user_idx").on(t.userId, t.createdAt),
  byExpires: index("sa_otp_expires_idx").on(t.expiresAt),
}));

export const superAdminTrustedDevicesTable = pgTable("sa_trusted_devices", {
  id:                serial("id").primaryKey(),
  userId:            integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  deviceFingerprint: text("device_fingerprint").notNull(),
  deviceName:        text("device_name"),
  userAgent:         text("user_agent"),
  ip:                text("ip"),
  approvedAt:        timestamp("approved_at", { withTimezone: true }).defaultNow().notNull(),
  approvedFromIp:    text("approved_from_ip"),
  lastSeenAt:        timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  revokedAt:         timestamp("revoked_at", { withTimezone: true }),
  createdAt:         timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byUserFp: index("sa_trusted_user_fp_idx").on(t.userId, t.deviceFingerprint),
}));

export const superAdminSessionsTable = pgTable("sa_sessions", {
  id:                serial("id").primaryKey(),
  userId:            integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  sessionToken:      text("session_token").notNull().unique(),
  deviceFingerprint: text("device_fingerprint"),
  deviceName:        text("device_name"),
  userAgent:         text("user_agent"),
  ip:                text("ip"),
  lastSeenAt:        timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  revokedAt:         timestamp("revoked_at", { withTimezone: true }),
  revokedReason:     text("revoked_reason"),
  createdAt:         timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byUser:  index("sa_session_user_idx").on(t.userId, t.lastSeenAt),
  byToken: index("sa_session_token_idx").on(t.sessionToken),
}));

export const superAdminLoginAttemptsTable = pgTable("sa_login_attempts", {
  id:                serial("id").primaryKey(),
  userId:            integer("user_id"),
  username:          text("username").notNull(),
  ip:                text("ip"),
  userAgent:         text("user_agent"),
  deviceFingerprint: text("device_fingerprint"),
  success:           boolean("success").notNull(),
  outcome:           text("outcome").notNull(),
  failureReason:     text("failure_reason"),
  riskScore:         integer("risk_score").notNull().default(0),
  riskLevel:         text("risk_level").notNull().default("low"),
  riskFactors:       jsonb("risk_factors"),
  createdAt:         timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byUser:    index("sa_la_user_idx").on(t.userId, t.createdAt),
  byUname:   index("sa_la_username_idx").on(t.username, t.createdAt),
  byIp:      index("sa_la_ip_idx").on(t.ip, t.createdAt),
}));

export const superAdminRecoveryCodesTable = pgTable("sa_recovery_codes", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  codeHash:  text("code_hash").notNull(),
  label:     text("label"),
  usedAt:    timestamp("used_at", { withTimezone: true }),
  usedFromIp: text("used_from_ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byUser: index("sa_recovery_user_idx").on(t.userId),
}));

export const superAdminDeviceApprovalsTable = pgTable("sa_device_approvals", {
  id:                  serial("id").primaryKey(),
  userId:              integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  approvalToken:       text("approval_token").notNull().unique(),
  requestingDeviceFp:  text("requesting_device_fp").notNull(),
  requestingIp:        text("requesting_ip"),
  requestingUserAgent: text("requesting_user_agent"),
  status:              text("status").notNull().default("pending"),
  decidedAt:           timestamp("decided_at", { withTimezone: true }),
  decidedFromIp:       text("decided_from_ip"),
  expiresAt:           timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt:           timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byUserStatus: index("sa_dapproval_user_status_idx").on(t.userId, t.status),
  byExpires:    index("sa_dapproval_expires_idx").on(t.expiresAt),
}));

export const superAdminRecoveryLinksTable = pgTable("sa_recovery_links", {
  id:         serial("id").primaryKey(),
  userId:     integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  token:      text("token").notNull().unique(),
  // Capture both the IP that *requested* the link (via email) AND the IP
  // that ultimately *consumed* it. They almost always differ, and we need
  // both for the audit trail / risk-scoring on a recovery event.
  ip:         text("ip"),
  userAgent:  text("user_agent"),
  expiresAt:  timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt:     timestamp("used_at", { withTimezone: true }),
  usedFromIp: text("used_from_ip"),
  createdAt:  timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byUser: index("sa_recovery_link_user_idx").on(t.userId, t.createdAt),
}));

export type SuperAdminOtp           = typeof superAdminOtpCodesTable.$inferSelect;
export type SuperAdminTrustedDevice = typeof superAdminTrustedDevicesTable.$inferSelect;
export type SuperAdminSession       = typeof superAdminSessionsTable.$inferSelect;
export type SuperAdminLoginAttempt  = typeof superAdminLoginAttemptsTable.$inferSelect;
export type SuperAdminRecoveryCode  = typeof superAdminRecoveryCodesTable.$inferSelect;
export type SuperAdminDeviceApproval = typeof superAdminDeviceApprovalsTable.$inferSelect;
export type SuperAdminRecoveryLink  = typeof superAdminRecoveryLinksTable.$inferSelect;
