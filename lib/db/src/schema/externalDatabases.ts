import { pgTable, serial, integer, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────
// External storage databases (SuperAdmin-only platform module).
//
// Lets the platform owner register EXTERNAL Postgres databases and route
// specific storage-heavy modules (document archive, attachments, …) to them
// PLATFORM-WIDE (all companies) to offload the central database. Core system
// tables (users, companies, subscriptions, JEs, SA panel) always stay central.
//
// Connection strings are stored ENCRYPTED (AES-256-GCM, key derived from
// SESSION_SECRET) and are never returned to the client after saving.
// ─────────────────────────────────────────────────────────────────────────
export const externalDatabasesTable = pgTable("external_databases", {
  id:   serial("id").primaryKey(),
  name: text("name").notNull(),
  // AES-256-GCM ciphertext ("extdb1:<iv>:<tag>:<data>", all base64).
  connEncrypted: text("conn_encrypted").notNull(),
  // Redacted display form (host:port/dbname — no credentials).
  connDisplay: text("conn_display"),
  // pending | ok | error (last test-connection result).
  status: text("status").notNull().default("pending"),
  lastCheckAt:     timestamp("last_check_at"),
  lastCheckResult: jsonb("last_check_result"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  nameUniq: uniqueIndex("external_databases_name_uniq").on(t.name),
}));

// Platform-wide module → external DB routing. Absence of a row (or NULL
// externalDbId) = module stays on the central database.
export const storageRoutingsTable = pgTable("storage_routings", {
  id: serial("id").primaryKey(),
  // e.g. "document_archive" — must be in the API-layer module registry.
  moduleKey: text("module_key").notNull(),
  externalDbId: integer("external_db_id").references(() => externalDatabasesTable.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  moduleUniq: uniqueIndex("storage_routings_module_uniq").on(t.moduleKey),
}));

export type ExternalDatabase = typeof externalDatabasesTable.$inferSelect;
export type StorageRouting = typeof storageRoutingsTable.$inferSelect;
