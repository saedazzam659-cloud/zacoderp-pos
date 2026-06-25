import {
  pgTable, serial, text, integer, numeric, timestamp, boolean, jsonb, date, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { subscriptionsTable } from "./users";

// ─────────────────────────────────────────────────────────────────────────
// Reseller (Agent) Network — Task #237
//
// A platform-level distributor network. The head office (SuperAdmin) onboards
// resellers who each manage their OWN set of client companies, renewals, and
// commissions, with strict per-reseller data isolation.
//
// 100% additive: new tables only. Existing company/user data and existing
// permission behaviour are untouched. A reseller is a NEW identity type that
// lives in `resellers` (NOT in `users`) and authenticates through its own
// /api/reseller/login flow against `session_token`.
// ─────────────────────────────────────────────────────────────────────────

// Granular per-reseller capability flags. Stored as a jsonb object on the
// reseller row; the SuperAdmin toggles each individually. Missing key ⇒ false
// (denied) so a brand-new reseller starts with nothing until explicitly
// granted. Mirror this list in the admin UI + reseller portal gate.
//   add_companies         — onboard new client companies
//   manage_clients        — edit their clients' profiles / branches / users
//   renew_subscriptions   — extend / change their clients' subscriptions
//   manage_branches_users — manage branches & users for their clients
//   view_reports          — see commission & client reports
//   support               — open / manage support tickets for their clients
export const RESELLER_PERMISSION_KEYS = [
  "add_companies",
  "manage_clients",
  "renew_subscriptions",
  "manage_branches_users",
  "view_reports",
  "support",
] as const;
export type ResellerPermissionKey = (typeof RESELLER_PERMISSION_KEYS)[number];
export type ResellerPermissions = Partial<Record<ResellerPermissionKey, boolean>>;

export const resellersTable = pgTable("resellers", {
  id:             serial("id").primaryKey(),
  code:           text("code").notNull().unique(),
  nameAr:         text("name_ar").notNull(),
  nameEn:         text("name_en"),
  phone:          text("phone"),
  email:          text("email"),
  address:        text("address"),
  // Login credentials — reseller portal authenticates against these.
  username:       text("username").notNull().unique(),
  passwordHash:   text("password_hash").notNull(),
  sessionToken:   text("session_token"),
  sessionId:      text("session_id"),
  // Default commission rate (percent) applied when accruing commissions.
  commissionRate: numeric("commission_rate", { precision: 6, scale: 3 }).notNull().default("0"),
  // active | suspended
  status:         text("status").notNull().default("active"),
  activatedAt:    date("activated_at"),
  // Granular capability map — see RESELLER_PERMISSION_KEYS above.
  permissions:    jsonb("permissions").$type<ResellerPermissions>().notNull().default({}),
  notes:          text("notes"),
  isActive:       boolean("is_active").notNull().default(true),
  lastLoginAt:    timestamp("last_login_at"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
});

export type Reseller       = typeof resellersTable.$inferSelect;
export type InsertReseller = typeof resellersTable.$inferInsert;

// Link table: which client companies belong to which reseller. A company can
// be linked to at most one reseller (enforced by the unique index on
// company_id), so commission attribution is unambiguous.
export const resellerCompaniesTable = pgTable("reseller_companies", {
  id:         serial("id").primaryKey(),
  resellerId: integer("reseller_id").notNull().references(() => resellersTable.id, { onDelete: "cascade" }),
  companyId:  integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  linkedAt:   timestamp("linked_at").defaultNow().notNull(),
  createdAt:  timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  companyUniq: uniqueIndex("reseller_companies_company_uniq").on(t.companyId),
  resellerIdx: index("reseller_companies_reseller_idx").on(t.resellerId),
}));

export type ResellerCompany       = typeof resellerCompaniesTable.$inferSelect;
export type InsertResellerCompany = typeof resellerCompaniesTable.$inferInsert;

// Commission ledger — one row per accrued commission event. Computed
// automatically by the commission engine from subscription create / renew /
// add-on sale events. Reporting only for now (no payout/settlement movement).
//   event_type: new_subscription | renewal | addon
export const resellerCommissionsTable = pgTable("reseller_commissions", {
  id:               serial("id").primaryKey(),
  resellerId:       integer("reseller_id").notNull().references(() => resellersTable.id, { onDelete: "cascade" }),
  companyId:        integer("company_id").references(() => companiesTable.id, { onDelete: "set null" }),
  subscriptionId:   integer("subscription_id").references(() => subscriptionsTable.id, { onDelete: "set null" }),
  eventType:        text("event_type").notNull(),
  description:      text("description"),
  baseAmount:       numeric("base_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  commissionRate:   numeric("commission_rate", { precision: 6, scale: 3 }).notNull().default("0"),
  commissionAmount: numeric("commission_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  // Accrual period for monthly / annual roll-ups.
  periodMonth:      integer("period_month").notNull(),
  periodYear:       integer("period_year").notNull(),
  status:           text("status").notNull().default("accrued"),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  resellerIdx: index("reseller_commissions_reseller_idx").on(t.resellerId),
  periodIdx:   index("reseller_commissions_period_idx").on(t.resellerId, t.periodYear, t.periodMonth),
}));

export type ResellerCommission       = typeof resellerCommissionsTable.$inferSelect;
export type InsertResellerCommission = typeof resellerCommissionsTable.$inferInsert;

// Reseller-scoped support tickets — the reseller portal raises tickets to the
// head office (optionally about one of their client companies). Kept separate
// from the tenant `support_messages` table so reseller data stays isolated.
export const resellerTicketsTable = pgTable("reseller_tickets", {
  id:           serial("id").primaryKey(),
  resellerId:   integer("reseller_id").notNull().references(() => resellersTable.id, { onDelete: "cascade" }),
  companyId:    integer("company_id").references(() => companiesTable.id, { onDelete: "set null" }),
  subject:      text("subject").notNull(),
  body:         text("body").notNull(),
  category:     text("category").notNull().default("general"),
  priority:     text("priority").notNull().default("normal"),
  status:       text("status").notNull().default("open"),
  adminReply:   text("admin_reply"),
  adminReplyAt: timestamp("admin_reply_at"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  resellerIdx: index("reseller_tickets_reseller_idx").on(t.resellerId),
}));

export type ResellerTicket       = typeof resellerTicketsTable.$inferSelect;
export type InsertResellerTicket = typeof resellerTicketsTable.$inferInsert;

// Activation requests — a reseller requests the head office to activate /
// onboard a new client company (when they lack the add_companies grant, or
// for company creations that require head-office approval).
export const resellerActivationRequestsTable = pgTable("reseller_activation_requests", {
  id:            serial("id").primaryKey(),
  resellerId:    integer("reseller_id").notNull().references(() => resellersTable.id, { onDelete: "cascade" }),
  companyNameAr: text("company_name_ar").notNull(),
  contactPhone:  text("contact_phone"),
  contactEmail:  text("contact_email"),
  plan:          text("plan"),
  notes:         text("notes"),
  // pending | approved | rejected
  status:        text("status").notNull().default("pending"),
  adminNote:     text("admin_note"),
  resolvedAt:    timestamp("resolved_at"),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
  updatedAt:     timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  resellerIdx: index("reseller_activation_requests_reseller_idx").on(t.resellerId),
}));

export type ResellerActivationRequest       = typeof resellerActivationRequestsTable.$inferSelect;
export type InsertResellerActivationRequest = typeof resellerActivationRequestsTable.$inferInsert;
