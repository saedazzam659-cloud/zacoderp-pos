import { pgTable, serial, text, boolean, timestamp, integer, bigint, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";
import { usersTable } from "./users";

export const deviceLicensesTable = pgTable("device_licenses", {
  id: serial("id").primaryKey(),
  licenseKey: text("license_key").notNull(),
  companyId: integer("company_id").references(() => companiesTable.id, { onDelete: "set null" }),
  deviceId: integer("device_id"),
  status: text("status").notNull().default("unassigned"),
  plan: text("plan").notNull().default("pos_full"),
  maxDevices: integer("max_devices").notNull().default(1),
  issuedAt: timestamp("issued_at").defaultNow().notNull(),
  activatedAt: timestamp("activated_at"),
  expiresAt: timestamp("expires_at"),
  revokedAt: timestamp("revoked_at"),
  notes: text("notes"),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  keyUniq: uniqueIndex("device_licenses_key_uniq").on(t.licenseKey),
  companyIdx: index("device_licenses_company_idx").on(t.companyId),
  statusIdx: index("device_licenses_status_idx").on(t.status),
}));

export const posDevicesTable = pgTable("pos_devices", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId: integer("branch_id").references(() => branchesTable.id, { onDelete: "set null" }),
  deviceName: text("device_name").notNull(),
  fingerprintHash: text("fingerprint_hash").notNull(),
  licenseId: integer("license_id").references(() => deviceLicensesTable.id, { onDelete: "set null" }),
  deviceToken: text("device_token").notNull(),
  status: text("status").notNull().default("active"),
  appVersion: text("app_version"),
  osInfo: text("os_info"),
  lastHeartbeatAt: timestamp("last_heartbeat_at"),
  lastSeenIp: text("last_seen_ip"),
  lastSyncAt: timestamp("last_sync_at"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  deactivatedAt: timestamp("deactivated_at"),
}, (t) => ({
  tokenUniq: uniqueIndex("pos_devices_token_uniq").on(t.deviceToken),
  companyIdx: index("pos_devices_company_idx").on(t.companyId),
  fingerprintIdx: index("pos_devices_fp_idx").on(t.companyId, t.fingerprintHash),
}));

export const syncQueueLogTable = pgTable("sync_queue_log", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companiesTable.id, { onDelete: "cascade" }),
  deviceId: integer("device_id").references(() => posDevicesTable.id, { onDelete: "set null" }),
  direction: text("direction").notNull(),
  entityType: text("entity_type"),
  payloadCount: integer("payload_count").notNull().default(0),
  status: text("status").notNull().default("ok"),
  errorMessage: text("error_message"),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  deviceIdx: index("sync_queue_log_device_idx").on(t.deviceId, t.createdAt),
  companyIdx: index("sync_queue_log_company_idx").on(t.companyId, t.createdAt),
}));

export const deviceInvoiceRangesTable = pgTable("device_invoice_ranges", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  deviceId: integer("device_id").notNull().references(() => posDevicesTable.id, { onDelete: "cascade" }),
  docType: text("doc_type").notNull().default("pos_invoice"),
  rangeStart: bigint("range_start", { mode: "number" }).notNull(),
  rangeEnd: bigint("range_end", { mode: "number" }).notNull(),
  nextNumber: bigint("next_number", { mode: "number" }).notNull(),
  exhaustedAt: timestamp("exhausted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  deviceIdx: index("device_invoice_ranges_device_idx").on(t.deviceId, t.docType),
}));

export const downloadReleasesTable = pgTable("download_releases", {
  id: serial("id").primaryKey(),
  countryCode: text("country_code").notNull(),
  platform: text("platform").notNull().default("win-x64"),
  version: text("version").notNull(),
  downloadUrl: text("download_url").notNull(),
  fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
  checksumSha256: text("checksum_sha256"),
  releaseNotes: text("release_notes"),
  isActive: boolean("is_active").notNull().default(true),
  publishedAt: timestamp("published_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  countryPlatformIdx: index("download_releases_country_platform_idx").on(t.countryCode, t.platform, t.isActive),
}));

export type DeviceLicense = typeof deviceLicensesTable.$inferSelect;
export type PosDevice = typeof posDevicesTable.$inferSelect;
export type SyncQueueLog = typeof syncQueueLogTable.$inferSelect;
export type DeviceInvoiceRange = typeof deviceInvoiceRangesTable.$inferSelect;
export type DownloadRelease = typeof downloadReleasesTable.$inferSelect;
