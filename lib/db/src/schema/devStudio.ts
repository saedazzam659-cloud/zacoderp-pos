import {
  pgTable, serial, text, integer, timestamp, boolean, jsonb, uniqueIndex, index,
} from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────
// DevStudio — "التطوير من خلال زاكود" (additive only; SuperAdmin-governed).
//
// An in-browser AI coding studio where externally-registered, SuperAdmin-approved
// developers work ON an ISOLATED, version-pinned snapshot of the codebase. Safe
// model #1: read-only scoped access + AI-PROPOSED diffs. NO untrusted code ever
// executes on our infrastructure. Developers never get a download/clone/terminal.
//
// Governance levers (all enforced by the API, modelled here):
//   • Who enters    — developer status (pending→active / suspended / rejected).
//   • What they see  — per-developer visibility allow-list (DEFAULT DENY).
//   • How much       — read/write LINE quotas (internal-only entitlements).
//   • Which version  — SuperAdmin assigns a published snapshot per developer.
//   • Kill-switch    — suspending the developer kills all live sessions/tokens.
//
// 100% additive: new tables only. Platform-level (no company_id), like resellers.
// ─────────────────────────────────────────────────────────────────────────

export const DEV_STUDIO_BILLING_CYCLES = ["monthly", "annual"] as const;
export type DevStudioBillingCycle = (typeof DEV_STUDIO_BILLING_CYCLES)[number];

export const DEV_STUDIO_DEVELOPER_STATUSES = [
  "pending",   // self-registered, awaiting SuperAdmin approval
  "active",    // approved; entitlements applied; may log in
  "suspended", // kill-switch engaged; sessions revoked; cannot log in
  "rejected",  // application declined
] as const;
export type DevStudioDeveloperStatus = (typeof DEV_STUDIO_DEVELOPER_STATUSES)[number];

export const DEV_STUDIO_SNAPSHOT_STATUSES = ["draft", "published", "archived"] as const;
export type DevStudioSnapshotStatus = (typeof DEV_STUDIO_SNAPSHOT_STATUSES)[number];

export const DEV_STUDIO_SESSION_STATUSES = ["active", "killed", "expired"] as const;
export type DevStudioSessionStatus = (typeof DEV_STUDIO_SESSION_STATUSES)[number];

export const DEV_STUDIO_PROPOSAL_STATUSES = [
  "draft", "proposed", "submitted", "published", "rejected",
] as const;
export type DevStudioProposalStatus = (typeof DEV_STUDIO_PROPOSAL_STATUSES)[number];

// Entitlements snapshotted onto a developer at approval time (from the package),
// so later package edits never silently change a live developer's limits.
export interface DevStudioEntitlements {
  offices: number;        // number of AI "offices" (provider slots) allowed
  units: number;          // number of work units / concurrent tasks allowed
  readLineQuota: number;  // max lines a developer may READ per period
  writeLineQuota: number; // max lines a developer may propose (WRITE) per period
  billingCycle: DevStudioBillingCycle;
}

// ─── Packages / Editions (offices + units + monthly/annual + quotas) ────────
export const devStudioPackagesTable = pgTable("dev_studio_packages", {
  id:             serial("id").primaryKey(),
  nameAr:         text("name_ar").notNull(),
  nameEn:         text("name_en"),
  offices:        integer("offices").notNull().default(1),
  units:          integer("units").notNull().default(1),
  readLineQuota:  integer("read_line_quota").notNull().default(5000),
  writeLineQuota: integer("write_line_quota").notNull().default(1000),
  priceMonthly:   integer("price_monthly").notNull().default(0),
  priceAnnual:    integer("price_annual").notNull().default(0),
  isActive:       boolean("is_active").notNull().default(true),
  sortOrder:      integer("sort_order").notNull().default(0),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  activeIdx: index("dev_studio_packages_active_idx").on(t.isActive),
}));
export type DevStudioPackage       = typeof devStudioPackagesTable.$inferSelect;
export type InsertDevStudioPackage = typeof devStudioPackagesTable.$inferInsert;

// ─── Developers (self-register → approve) — platform-level, no company_id ───
export const devStudioDevelopersTable = pgTable("dev_studio_developers", {
  id:             serial("id").primaryKey(),
  name:           text("name").notNull(),
  phone:          text("phone").notNull(),
  country:        text("country").notNull(),
  packageId:      integer("package_id").references(() => devStudioPackagesTable.id, { onDelete: "set null" }),
  // Login credentials. Phone is the login identifier; password is bcrypt-hashed.
  passwordHash:   text("password_hash").notNull(),
  status:         text("status").notNull().default("pending"),
  // Entitlements copied from the package at approval (see DevStudioEntitlements).
  entitlements:   jsonb("entitlements").$type<DevStudioEntitlements | null>(),
  billingCycle:   text("billing_cycle").notNull().default("monthly"),
  // Snapshot the developer currently works on (SuperAdmin-assigned).
  snapshotId:     integer("snapshot_id"),
  ndaAcceptedAt:  timestamp("nda_accepted_at"),
  approvedAt:     timestamp("approved_at"),
  suspendedAt:    timestamp("suspended_at"),
  notes:          text("notes"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  phoneUniq:  uniqueIndex("dev_studio_developers_phone_uniq").on(t.phone),
  statusIdx:  index("dev_studio_developers_status_idx").on(t.status),
}));
export type DevStudioDeveloper       = typeof devStudioDevelopersTable.$inferSelect;
export type InsertDevStudioDeveloper = typeof devStudioDevelopersTable.$inferInsert;

// ─── Visibility allow-list (DEFAULT DENY) — SuperAdmin controls what is shown ─
// A developer sees a snapshot path ONLY if it falls under one of their allowed
// path prefixes. No row ⇒ the developer sees nothing.
export const devStudioVisibilityTable = pgTable("dev_studio_visibility", {
  id:          serial("id").primaryKey(),
  developerId: integer("developer_id").notNull().references(() => devStudioDevelopersTable.id, { onDelete: "cascade" }),
  pathPrefix:  text("path_prefix").notNull(),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  devPathUniq: uniqueIndex("dev_studio_visibility_dev_path_uniq").on(t.developerId, t.pathPrefix),
  devIdx:      index("dev_studio_visibility_dev_idx").on(t.developerId),
}));
export type DevStudioVisibility       = typeof devStudioVisibilityTable.$inferSelect;
export type InsertDevStudioVisibility = typeof devStudioVisibilityTable.$inferInsert;

// ─── Snapshots (version-pinned isolated copy) ───────────────────────────────
// content = gzip(JSON manifest+files) base64; isolation from live edits + the
// version the SuperAdmin distributes to developers.
export const devStudioSnapshotsTable = pgTable("dev_studio_snapshots", {
  id:         serial("id").primaryKey(),
  version:    text("version").notNull(),
  label:      text("label"),
  status:     text("status").notNull().default("draft"),
  fileCount:  integer("file_count").notNull().default(0),
  byteSize:   integer("byte_size").notNull().default(0),
  // Compressed (gzip→base64) JSON of { paths: string[], files: Record<path,content> }.
  content:    text("content"),
  createdAt:  timestamp("created_at").defaultNow().notNull(),
  publishedAt: timestamp("published_at"),
}, (t) => ({
  versionUniq: uniqueIndex("dev_studio_snapshots_version_uniq").on(t.version),
  statusIdx:   index("dev_studio_snapshots_status_idx").on(t.status),
}));
export type DevStudioSnapshot       = typeof devStudioSnapshotsTable.$inferSelect;
export type InsertDevStudioSnapshot = typeof devStudioSnapshotsTable.$inferInsert;

// ─── Sessions (developer bearer tokens; kill-switch) ────────────────────────
export const devStudioSessionsTable = pgTable("dev_studio_sessions", {
  id:          serial("id").primaryKey(),
  developerId: integer("developer_id").notNull().references(() => devStudioDevelopersTable.id, { onDelete: "cascade" }),
  token:       text("token").notNull(),
  status:      text("status").notNull().default("active"),
  lastSeenAt:  timestamp("last_seen_at").defaultNow().notNull(),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  tokenUniq: uniqueIndex("dev_studio_sessions_token_uniq").on(t.token),
  devIdx:    index("dev_studio_sessions_dev_idx").on(t.developerId),
}));
export type DevStudioSession       = typeof devStudioSessionsTable.$inferSelect;
export type InsertDevStudioSession = typeof devStudioSessionsTable.$inferInsert;

// ─── Usage (read/write line quota counters per period) ──────────────────────
export const devStudioUsageTable = pgTable("dev_studio_usage", {
  id:             serial("id").primaryKey(),
  developerId:    integer("developer_id").notNull().references(() => devStudioDevelopersTable.id, { onDelete: "cascade" }),
  periodKey:      text("period_key").notNull(), // e.g. "2026-06" (monthly bucket)
  readLinesUsed:  integer("read_lines_used").notNull().default(0),
  writeLinesUsed: integer("write_lines_used").notNull().default(0),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  devPeriodUniq: uniqueIndex("dev_studio_usage_dev_period_uniq").on(t.developerId, t.periodKey),
}));
export type DevStudioUsage       = typeof devStudioUsageTable.$inferSelect;
export type InsertDevStudioUsage = typeof devStudioUsageTable.$inferInsert;

// ─── Audit log (every file open / AI call / proposal, for IP traceability) ──
export const devStudioAuditTable = pgTable("dev_studio_audit", {
  id:          serial("id").primaryKey(),
  developerId: integer("developer_id").references(() => devStudioDevelopersTable.id, { onDelete: "set null" }),
  action:      text("action").notNull(), // read_file | ai_propose | submit | login | ...
  path:        text("path"),
  lines:       integer("lines").notNull().default(0),
  detail:      jsonb("detail").$type<Record<string, any>>().notNull().default({}),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  devIdx:    index("dev_studio_audit_dev_idx").on(t.developerId),
  actionIdx: index("dev_studio_audit_action_idx").on(t.action),
}));
export type DevStudioAudit       = typeof devStudioAuditTable.$inferSelect;
export type InsertDevStudioAudit = typeof devStudioAuditTable.$inferInsert;

// ─── Proposals (AI-generated diffs the developer produces / submits) ────────
export const devStudioProposalsTable = pgTable("dev_studio_proposals", {
  id:          serial("id").primaryKey(),
  developerId: integer("developer_id").notNull().references(() => devStudioDevelopersTable.id, { onDelete: "cascade" }),
  snapshotId:  integer("snapshot_id").references(() => devStudioSnapshotsTable.id, { onDelete: "set null" }),
  title:       text("title").notNull(),
  description: text("description"),
  targetPath:  text("target_path"),
  diff:        text("diff"),
  status:      text("status").notNull().default("draft"),
  writeLines:  integer("write_lines").notNull().default(0),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
  updatedAt:   timestamp("updated_at").defaultNow().notNull(),
  submittedAt: timestamp("submitted_at"),
}, (t) => ({
  devIdx:    index("dev_studio_proposals_dev_idx").on(t.developerId),
  statusIdx: index("dev_studio_proposals_status_idx").on(t.status),
}));
export type DevStudioProposal       = typeof devStudioProposalsTable.$inferSelect;
export type InsertDevStudioProposal = typeof devStudioProposalsTable.$inferInsert;
