import {
  pgTable, serial, text, integer, numeric, timestamp, boolean, jsonb, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

// ─────────────────────────────────────────────────────────────────────────
// Developer & Partner Control Center — Phase 1 (additive only).
//
// A platform-level network of DEVELOPERS (who build/publish extensions) and
// PARTNERS (who resell apps / integrate). The head office (SuperAdmin) onboards
// each entity through a governed lifecycle, issues a Partner ID on approval,
// and tracks Zacode commissions per entity.
//
// 100% additive: new tables only. This NEVER touches the existing reseller
// network (`resellers`) nor any company/user data. It is the developer/partner
// analogue of the reseller subsystem and is SuperAdmin-only — nothing here is
// exposed to tenants.
// ─────────────────────────────────────────────────────────────────────────

// developer = builds & publishes extensions; partner = resells / integrates.
export const PARTNER_KINDS = ["developer", "partner"] as const;
export type PartnerKind = (typeof PARTNER_KINDS)[number];

// Onboarding state machine (in order):
//   draft           — just registered (basic profile)
//   documents       — awaiting / collecting required documents
//   identity_check  — identity verification in progress
//   fees            — onboarding fees due / under settlement
//   security_review — platform security review
//   approved        — approved; Partner ID issued, may operate
//   suspended       — temporarily disabled by the head office
//   rejected        — application declined
export const PARTNER_STATUSES = [
  "draft", "documents", "identity_check", "fees", "security_review",
  "approved", "suspended", "rejected",
] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

// The forward onboarding path (terminal/exception states handled explicitly).
export const PARTNER_ONBOARDING_FLOW: PartnerStatus[] = [
  "draft", "documents", "identity_check", "fees", "security_review", "approved",
];

// Granular per-partner capability flags (mirrors RESELLER_PERMISSION_KEYS).
// Missing key ⇒ false (denied). Reserved for the developer portal / marketplace
// accrual in later phases; surfaced & toggled in the Control Center now.
//   publish_extensions — submit / publish extensions to the catalog
//   manage_listings    — edit their marketplace listings
//   sell_apps          — sell paid apps (commission-bearing)
//   view_reports       — see their commission & company reports
//   support            — open / manage support tickets
export const PARTNER_PERMISSION_KEYS = [
  "publish_extensions",
  "manage_listings",
  "sell_apps",
  "view_reports",
  "support",
] as const;
export type PartnerPermissionKey = (typeof PARTNER_PERMISSION_KEYS)[number];
export type PartnerPermissions = Partial<Record<PartnerPermissionKey, boolean>>;

export const platformPartnersTable = pgTable("platform_partners", {
  id:               serial("id").primaryKey(),
  kind:             text("kind").notNull().default("developer"),
  // The issued "Partner ID" — null until approval. Unique when present.
  partnerCode:      text("partner_code").unique(),
  nameAr:           text("name_ar").notNull(),
  nameEn:           text("name_en"),
  contactName:      text("contact_name"),
  phone:            text("phone"),
  email:            text("email"),
  address:          text("address"),
  website:          text("website"),
  // ─── Self-service portal credentials (additive) ──────────────────────────
  // A partner authenticates against the developer/partner portal through these.
  // NULL until the head office provisions portal access; login requires BOTH
  // username + passwordHash present AND status==="approved". Mirrors the
  // reseller auth columns; kept nullable so existing Phase-1 rows are untouched.
  username:         text("username").unique(),
  passwordHash:     text("password_hash"),
  sessionToken:     text("session_token"),
  sessionId:        text("session_id"),
  lastLoginAt:      timestamp("last_login_at"),
  // Default commission rate (percent) for this entity's app sales.
  commissionRate:   numeric("commission_rate", { precision: 6, scale: 3 }).notNull().default("0"),
  // Onboarding state — see PARTNER_STATUSES above.
  status:           text("status").notNull().default("draft"),
  permissions:      jsonb("permissions").$type<PartnerPermissions>().notNull().default({}),
  notes:            text("notes"),
  approvedAt:       timestamp("approved_at"),
  partnerIdIssuedAt: timestamp("partner_id_issued_at"),
  isActive:         boolean("is_active").notNull().default(true),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
  updatedAt:        timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  kindIdx:   index("platform_partners_kind_idx").on(t.kind),
  statusIdx: index("platform_partners_status_idx").on(t.status),
}));

export type PlatformPartner       = typeof platformPartnersTable.$inferSelect;
export type InsertPlatformPartner = typeof platformPartnersTable.$inferInsert;

// Onboarding documents collected during the lifecycle (CR, VAT, ID, contract…).
// fileUrl stores an object-storage path; review status tracked per document.
export const partnerDocumentsTable = pgTable("partner_documents", {
  id:         serial("id").primaryKey(),
  partnerId:  integer("partner_id").notNull().references(() => platformPartnersTable.id, { onDelete: "cascade" }),
  docType:    text("doc_type").notNull(),
  title:      text("title"),
  fileUrl:    text("file_url"),
  // pending | verified | rejected
  status:     text("status").notNull().default("pending"),
  note:       text("note"),
  reviewedAt: timestamp("reviewed_at"),
  createdAt:  timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  partnerIdx: index("partner_documents_partner_idx").on(t.partnerId),
}));

export type PartnerDocument       = typeof partnerDocumentsTable.$inferSelect;
export type InsertPartnerDocument = typeof partnerDocumentsTable.$inferInsert;

// Link table: which companies a developer/partner serves (apps sold / managed).
// Unlike resellers, a company MAY be linked to multiple partners (e.g. several
// app vendors), so uniqueness is on the (partner, company) PAIR — not company.
export const partnerCompaniesTable = pgTable("partner_companies", {
  id:        serial("id").primaryKey(),
  partnerId: integer("partner_id").notNull().references(() => platformPartnersTable.id, { onDelete: "cascade" }),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  // free-form role/label of the relationship (e.g. served | integrator).
  role:      text("role").notNull().default("served"),
  linkedAt:  timestamp("linked_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  pairUniq:   uniqueIndex("partner_companies_pair_uniq").on(t.partnerId, t.companyId),
  partnerIdx: index("partner_companies_partner_idx").on(t.partnerId),
  companyIdx: index("partner_companies_company_idx").on(t.companyId),
}));

export type PartnerCompany       = typeof partnerCompaniesTable.$inferSelect;
export type InsertPartnerCompany = typeof partnerCompaniesTable.$inferInsert;

// Developer / app-sales commission ledger — mirrors reseller_commissions.
// One row per accrued commission event, ready for marketplace accrual (Phase 4).
//   event_type: app_sale | app_renewal | subscription | adjustment
export const partnerCommissionsTable = pgTable("partner_commissions", {
  id:               serial("id").primaryKey(),
  partnerId:        integer("partner_id").notNull().references(() => platformPartnersTable.id, { onDelete: "cascade" }),
  companyId:        integer("company_id").references(() => companiesTable.id, { onDelete: "set null" }),
  // Optional extension this commission relates to (free-form extension_id).
  extensionId:      text("extension_id"),
  eventType:        text("event_type").notNull(),
  description:      text("description"),
  baseAmount:       numeric("base_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  commissionRate:   numeric("commission_rate", { precision: 6, scale: 3 }).notNull().default("0"),
  commissionAmount: numeric("commission_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  periodMonth:      integer("period_month").notNull(),
  periodYear:       integer("period_year").notNull(),
  status:           text("status").notNull().default("accrued"),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  partnerIdx: index("partner_commissions_partner_idx").on(t.partnerId),
  periodIdx:  index("partner_commissions_period_idx").on(t.partnerId, t.periodYear, t.periodMonth),
}));

export type PartnerCommission       = typeof partnerCommissionsTable.$inferSelect;
export type InsertPartnerCommission = typeof partnerCommissionsTable.$inferInsert;
