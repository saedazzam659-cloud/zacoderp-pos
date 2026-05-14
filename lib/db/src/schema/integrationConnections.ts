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
  /**
   * Phase B — per-connection forwarding settings (timing mode, customer/item
   * matching, branch/warehouse defaults, notifications, dedup). Shape lives
   * in artifacts/api-server/src/lib/integrations/forwardingConfig.ts. Stored
   * as a JSONB blob so we can evolve the shape without DDL churn.
   */
  forwardingConfig: jsonb("forwarding_config").$type<Record<string, unknown>>().notNull().default({}),
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

/**
 * Phase B — per-invoice forwarding queue.
 *
 * Each canonical invoice ingested via Pull or Push is enqueued here with a
 * `state` and (for delayed/scheduled modes) a `scheduledFor` timestamp. A
 * background worker polls this table and forwards due rows through the
 * downstream pipeline (sales_invoice draft → post → ZATCA submit).
 *
 * `salesInvoiceId` is set once a draft has been created so the UI can deep
 * link to it. `freezeReason` carries human text when the worker pauses
 * because of a missing customer/item/warehouse the user must resolve.
 */
export const integrationInvoiceQueueTable = pgTable("integration_invoice_queue", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull(),
  connectionId: integer("connection_id").notNull(),
  syncRunId: integer("sync_run_id"),
  state: text("state").notNull().default("pending"),
  canonical: jsonb("canonical").$type<Record<string, unknown>>().notNull(),
  sourceRef: text("source_ref"),
  scheduledFor: timestamp("scheduled_for"),
  salesInvoiceId: integer("sales_invoice_id"),
  freezeReason: text("freeze_reason"),
  retryCount: integer("retry_count").notNull().default(0),
  lastError: text("last_error"),
  zatcaStatus: text("zatca_status"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => ({
  byConnection: index("integration_invoice_queue_connection_idx").on(t.connectionId),
  byCompany:    index("integration_invoice_queue_company_idx").on(t.companyId),
  byState:      index("integration_invoice_queue_state_idx").on(t.state),
  byScheduled:  index("integration_invoice_queue_scheduled_idx").on(t.scheduledFor),
}));
