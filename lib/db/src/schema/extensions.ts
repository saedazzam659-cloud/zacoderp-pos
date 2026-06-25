import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ─────────────────────────────────────────────────────────────────────────
// Extension Platform — Phase 0 foundation (الكفّر الخارجي / outer shell).
//
// These tables are 100% ADDITIVE and never referenced by any core business
// module. They let partners/developers extend Zacode WITHOUT touching or
// seeing the system core:
//
//   platform_extensions  — the global catalog of registered extensions. The
//                          `manifest` is the signed descriptor (screens, api
//                          routes, requested permissions). `signature` is an
//                          Ed25519 signature over the canonical manifest; the
//                          runtime REFUSES to load a row whose signature does
//                          not verify against the platform public key.
//
//   company_extensions   — per-tenant install/enable state. An extension is
//                          OFF for every company by default — a row with
//                          enabled=true must exist before a tenant can reach
//                          the extension's screens or API.
//
//   ext_data             — a generic, namespaced key/value store extensions
//                          use for their own data so they NEVER write to core
//                          tables. Scoped by (company_id, extension_id, key).
//                          company_id is nullable so the platform itself can
//                          store global rows (e.g. its signing keypair) here.
// ─────────────────────────────────────────────────────────────────────────

export const platformExtensionsTable = pgTable(
  "platform_extensions",
  {
    id: serial("id").primaryKey(),
    // Stable slug, e.g. "hello-world". Unique across the platform.
    extensionId: text("extension_id").notNull().unique(),
    nameAr: text("name_ar").notNull(),
    nameEn: text("name_en"),
    version: text("version").notNull().default("1.0.0"),
    vendor: text("vendor"),
    // Full signed manifest (screens, apiRoutes, permissions, …).
    manifest: jsonb("manifest").notNull(),
    // Base64 Ed25519 signature over the canonical manifest JSON.
    signature: text("signature"),
    // Fingerprint of the platform public key that signed the manifest.
    publicKeyId: text("public_key_id"),
    // active | disabled — a platform-level kill switch (independent of the
    // per-company enable flag in company_extensions).
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const companyExtensionsTable = pgTable(
  "company_extensions",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    extensionId: text("extension_id").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    // Per-company extension settings (opaque to the core).
    settings: jsonb("settings").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCompanyExt: uniqueIndex("company_extensions_company_ext_uniq").on(
      t.companyId,
      t.extensionId,
    ),
  }),
);

export const extDataTable = pgTable(
  "ext_data",
  {
    id: serial("id").primaryKey(),
    // Nullable: NULL = platform-global row (not tied to a tenant).
    companyId: integer("company_id"),
    extensionId: text("extension_id").notNull(),
    key: text("key").notNull(),
    value: jsonb("value"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byScope: index("ext_data_scope_idx").on(t.companyId, t.extensionId, t.key),
  }),
);

// ─────────────────────────────────────────────────────────────────────────
// ext_records — Phase 2 runtime: the additive "ext_* tables" store. An
// extension declares logical "tables" (collections) in its signed manifest;
// the runtime persists their rows HERE so partners get a real, queryable,
// per-tenant record store WITHOUT ever creating DDL or touching core tables.
// Scoped strictly by (company_id, extension_id, collection). record_id is a
// runtime-assigned UUID, unique within a tenant+extension+collection.
// ─────────────────────────────────────────────────────────────────────────
export const extRecordsTable = pgTable(
  "ext_records",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    extensionId: text("extension_id").notNull(),
    collection: text("collection").notNull(),
    recordId: text("record_id").notNull(),
    data: jsonb("data").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byScope: index("ext_records_scope_idx").on(t.companyId, t.extensionId, t.collection),
    byRecord: uniqueIndex("ext_records_record_uniq").on(
      t.companyId,
      t.extensionId,
      t.collection,
      t.recordId,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────────
// extension_publishes — Phase 3 "Publish Engine". An immutable-ish record of
// every publish RUN a developer triggers. The publish pipeline executes staged
// gates (build → security scan → AI review → package → sign → deploy → monitor);
// each gate's outcome is captured in `gates`, and a clear, actionable failure
// report lives in `report`. On success the signed manifest is deployed to
// platform_extensions and `signature`/`publicKeyId`/`deployedAt` are filled.
//
// This table is the durable, queryable audit trail of the distribution layer:
// it never carries executable code (only the declarative manifest + outcomes),
// and combined with the audit_log entries it satisfies the "immutable audit for
// every publish event" guarantee. Rows are append-only by convention (the
// pipeline updates a row in place only while a single run is in flight).
// ─────────────────────────────────────────────────────────────────────────
export const extensionPublishesTable = pgTable(
  "extension_publishes",
  {
    id: serial("id").primaryKey(),
    extensionId: text("extension_id").notNull(),
    version: text("version").notNull(),
    // Optional developer (platform_partners.id) the run is attributed to.
    partnerId: integer("partner_id"),
    // The candidate manifest exactly as submitted (pre-canonicalisation).
    submittedManifest: jsonb("submitted_manifest").notNull(),
    // pending | running | passed | deployed | failed | blocked
    status: text("status").notNull().default("pending"),
    // The last stage the pipeline reached (build, security_scan, …, monitor).
    currentStage: text("current_stage"),
    // Per-gate outcomes: [{ stage, status: pass|warn|fail|skip, summary, details, durationMs }]
    gates: jsonb("gates").notNull().default([]),
    // Actionable report surfaced to the developer: { errors[], warnings[], … }.
    report: jsonb("report"),
    // sha256 of the canonical manifest bytes that were signed (the "package").
    packageDigest: text("package_digest"),
    // Ed25519 signature over the canonical manifest (filled on a passing sign gate).
    signature: text("signature"),
    publicKeyId: text("public_key_id"),
    deployedAt: timestamp("deployed_at", { withTimezone: true }),
    createdBy: integer("created_by"),
    createdByUsername: text("created_by_username"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byExtension: index("extension_publishes_extension_idx").on(t.extensionId),
    byStatus: index("extension_publishes_status_idx").on(t.status),
    byCreatedAt: index("extension_publishes_created_idx").on(t.createdAt),
  }),
);

export const insertPlatformExtensionSchema = createInsertSchema(platformExtensionsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertCompanyExtensionSchema = createInsertSchema(companyExtensionsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertExtDataSchema = createInsertSchema(extDataTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertExtRecordSchema = createInsertSchema(extRecordsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertExtensionPublishSchema = createInsertSchema(extensionPublishesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type PlatformExtension = typeof platformExtensionsTable.$inferSelect;
export type CompanyExtension = typeof companyExtensionsTable.$inferSelect;
export type ExtData = typeof extDataTable.$inferSelect;
export type ExtRecord = typeof extRecordsTable.$inferSelect;
export type ExtensionPublish = typeof extensionPublishesTable.$inferSelect;
export type InsertPlatformExtension = z.infer<typeof insertPlatformExtensionSchema>;
export type InsertCompanyExtension = z.infer<typeof insertCompanyExtensionSchema>;
export type InsertExtData = z.infer<typeof insertExtDataSchema>;
export type InsertExtRecord = z.infer<typeof insertExtRecordSchema>;
export type InsertExtensionPublish = z.infer<typeof insertExtensionPublishSchema>;
