import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
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

// ─────────────────────────────────────────────────────────────────────────
// Marketplace — Phase 4 (المتجر والماركت بليس). 100% ADDITIVE. The storefront
// where developers list/sell extensions and companies install them per tenant.
//
//   extension_listings   — the COMMERCIAL descriptor of an extension on the
//                          store, kept SEPARATE from the signed code manifest
//                          (pricing is a commercial attribute the head office /
//                          developer controls, never part of the signed code).
//                          One listing per extension_id. `commission_rate` is
//                          ZACODE's cut (percent); when null it falls back to
//                          the attributed developer's default partner rate.
//
//   extension_purchases  — per-tenant purchase / entitlement records. A PAID
//                          extension can only be enabled for a company that
//                          holds an `active` purchase here (entitlement). Each
//                          purchase snapshots the price + commission so the
//                          developer commission ledger and the Control Center
//                          breakdown stay consistent even if the listing later
//                          changes. Billing is the platform's EXISTING internal
//                          ledger model (no external card processor).
// ─────────────────────────────────────────────────────────────────────────

// free = no charge; one_time = single purchase; monthly = recurring entitlement.
export const EXTENSION_PRICING_MODELS = ["free", "one_time", "monthly"] as const;
export type ExtensionPricingModel = (typeof EXTENSION_PRICING_MODELS)[number];

// draft = not visible in the store; published = visible/installable; unpublished = hidden.
export const EXTENSION_LISTING_STATUSES = ["draft", "published", "unpublished"] as const;
export type ExtensionListingStatus = (typeof EXTENSION_LISTING_STATUSES)[number];

// active = entitled; cancelled = uninstalled/refunded; expired = billing lapsed.
export const EXTENSION_PURCHASE_STATUSES = ["active", "cancelled", "expired"] as const;
export type ExtensionPurchaseStatus = (typeof EXTENSION_PURCHASE_STATUSES)[number];

export const extensionListingsTable = pgTable(
  "extension_listings",
  {
    id: serial("id").primaryKey(),
    // One listing per extension (free-form extension_id slug, no FK by design).
    extensionId: text("extension_id").notNull().unique(),
    // Developer (platform_partners.id) who earns on each sale. Nullable.
    partnerId: integer("partner_id"),
    category: text("category").notNull().default("other"),
    summaryAr: text("summary_ar"),
    summaryEn: text("summary_en"),
    descriptionAr: text("description_ar"),
    iconUrl: text("icon_url"),
    // free | one_time | monthly
    pricingModel: text("pricing_model").notNull().default("free"),
    price: numeric("price", { precision: 15, scale: 2 }).notNull().default("0"),
    currency: text("currency").notNull().default("SAR"),
    // Zacode's commission cut (percent). NULL ⇒ fall back to the partner default.
    commissionRate: numeric("commission_rate", { precision: 6, scale: 3 }),
    // draft | published | unpublished — storefront visibility.
    status: text("status").notNull().default("draft"),
    featured: boolean("featured").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStatus: index("extension_listings_status_idx").on(t.status),
    byPartner: index("extension_listings_partner_idx").on(t.partnerId),
  }),
);

export const extensionPurchasesTable = pgTable(
  "extension_purchases",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    extensionId: text("extension_id").notNull(),
    // The listing the purchase was made against (snapshot reference).
    listingId: integer("listing_id"),
    // Developer attribution snapshot (commission recipient).
    partnerId: integer("partner_id"),
    // free | one_time | monthly (snapshot of the listing at purchase time).
    pricingModel: text("pricing_model").notNull().default("free"),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull().default("0"),
    currency: text("currency").notNull().default("SAR"),
    // Commission snapshots (Zacode's cut) — kept in lockstep with the ledger row.
    commissionRate: numeric("commission_rate", { precision: 6, scale: 3 }).notNull().default("0"),
    commissionAmount: numeric("commission_amount", { precision: 15, scale: 2 }).notNull().default("0"),
    // active | cancelled | expired — the entitlement state.
    status: text("status").notNull().default("active"),
    // For monthly entitlements: when the current billing cycle ends.
    billingCycleEnd: timestamp("billing_cycle_end", { withTimezone: true }),
    purchasedBy: integer("purchased_by"),
    purchasedByUsername: text("purchased_by_username"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCompany: index("extension_purchases_company_idx").on(t.companyId),
    byScope: index("extension_purchases_scope_idx").on(t.companyId, t.extensionId),
    byPartner: index("extension_purchases_partner_idx").on(t.partnerId),
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
export const insertExtensionListingSchema = createInsertSchema(extensionListingsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertExtensionPurchaseSchema = createInsertSchema(extensionPurchasesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type PlatformExtension = typeof platformExtensionsTable.$inferSelect;
export type CompanyExtension = typeof companyExtensionsTable.$inferSelect;
export type ExtData = typeof extDataTable.$inferSelect;
export type ExtRecord = typeof extRecordsTable.$inferSelect;
export type ExtensionPublish = typeof extensionPublishesTable.$inferSelect;
export type ExtensionListing = typeof extensionListingsTable.$inferSelect;
export type ExtensionPurchase = typeof extensionPurchasesTable.$inferSelect;
export type InsertPlatformExtension = z.infer<typeof insertPlatformExtensionSchema>;
export type InsertCompanyExtension = z.infer<typeof insertCompanyExtensionSchema>;
export type InsertExtData = z.infer<typeof insertExtDataSchema>;
export type InsertExtRecord = z.infer<typeof insertExtRecordSchema>;
export type InsertExtensionPublish = z.infer<typeof insertExtensionPublishSchema>;
export type InsertExtensionListing = z.infer<typeof insertExtensionListingSchema>;
export type InsertExtensionPurchase = z.infer<typeof insertExtensionPurchaseSchema>;
