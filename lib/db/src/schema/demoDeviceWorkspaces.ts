import {
  pgTable,
  serial,
  integer,
  varchar,
  boolean,
  timestamp,
  text,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { companiesTable } from "./companies";

/**
 * Browser-binding history for a demo source user. Under the strict policy
 * exactly one unrevoked primary row may authorize login. The raw opaque token
 * lives only in an HttpOnly cookie; only its SHA-256 hash is persisted.
 */
export const demoDeviceWorkspacesTable = pgTable("demo_device_workspaces", {
  id: serial("id").primaryKey(),
  sourceUserId: integer("source_user_id").notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  sourceCompanyId: integer("source_company_id").notNull()
    .references(() => companiesTable.id, { onDelete: "cascade" }),
  workspaceCompanyId: integer("workspace_company_id")
    .references(() => companiesTable.id, { onDelete: "cascade" }),
  workspaceUserId: integer("workspace_user_id")
    .references(() => usersTable.id, { onDelete: "cascade" }),
  deviceTokenHash: varchar("device_token_hash", { length: 64 }).notNull(),
  deviceLabel: varchar("device_label", { length: 180 }),
  userAgent: text("user_agent"),
  firstIp: varchar("first_ip", { length: 64 }),
  lastIp: varchar("last_ip", { length: 64 }),
  isPrimary: boolean("is_primary").notNull().default(false),
  status: varchar("status", { length: 24 }).notNull().default("provisioning"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sourceDeviceUnique: uniqueIndex("demo_device_workspaces_source_device_uq")
    .on(t.sourceUserId, t.deviceTokenHash),
  sourceIdx: index("demo_device_workspaces_source_idx").on(t.sourceUserId),
  workspaceIdx: index("demo_device_workspaces_company_idx").on(t.workspaceCompanyId),
}));

/**
 * Legacy pairing-code history. New codes are disabled by the strict
 * one-browser policy; retained only so old rows can be invalidated safely.
 */
export const demoDevicePairCodesTable = pgTable("demo_device_pair_codes", {
  id: serial("id").primaryKey(),
  sourceUserId: integer("source_user_id").notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  workspaceCompanyId: integer("workspace_company_id").notNull()
    .references(() => companiesTable.id, { onDelete: "cascade" }),
  createdByDeviceId: integer("created_by_device_id").notNull()
    .references(() => demoDeviceWorkspacesTable.id, { onDelete: "cascade" }),
  codeHash: varchar("code_hash", { length: 64 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUnique: uniqueIndex("demo_device_pair_codes_hash_uq").on(t.codeHash),
  sourceIdx: index("demo_device_pair_codes_source_idx").on(t.sourceUserId),
}));