import { pgTable, serial, text, integer, timestamp, boolean, index, jsonb } from "drizzle-orm/pg-core";

export const integrationConnectionsTable = pgTable("integration_connections", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull(),
  provider: text("provider").notNull(),
  displayName: text("display_name").notNull(),
  status: text("status").notNull().default("disconnected"),
  baseUrl: text("base_url"),
  credentialsEnc: text("credentials_enc"),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  inboundTokenHash: text("inbound_token_hash"),
  lastSyncAt: timestamp("last_sync_at"),
  lastSyncStatus: text("last_sync_status"),
  lastSyncError: text("last_sync_error"),
  totalSyncs: integer("total_syncs").notNull().default(0),
  pullEnabled: boolean("pull_enabled").notNull().default(false),
  pullIntervalMinutes: integer("pull_interval_minutes").notNull().default(60),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => ({
  byCompany: index("integration_connections_company_idx").on(t.companyId),
  byProvider: index("integration_connections_provider_idx").on(t.provider),
}));

export const integrationSyncRunsTable = pgTable("integration_sync_runs", {
  id: serial("id").primaryKey(),
  connectionId: integer("connection_id").notNull(),
  trigger: text("trigger").notNull(),
  status: text("status").notNull().default("running"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
  invoicesIngested: integer("invoices_ingested").notNull().default(0),
  errors: jsonb("errors").$type<Array<{ ref: string; reason: string }>>().notNull().default([]),
  rawResponse: jsonb("raw_response"),
}, t => ({
  byConnection: index("integration_sync_runs_connection_idx").on(t.connectionId),
}));
