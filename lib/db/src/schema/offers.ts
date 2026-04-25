import {
  pgTable, serial, integer, text, numeric, timestamp, date, pgEnum, index,
  uniqueIndex, boolean,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companiesTable } from "./companies";
import { customersTable } from "./customers";
import { itemsTable } from "./inventory";
import { salesRepsTable } from "./salesReps";

// ─── Enums ──────────────────────────────────────────────────────────────────
// Three independent "scope" knobs — each lets the offer apply to ALL of that
// dimension (customers / items / sales-reps) or just a SPECIFIC subset stored
// in the matching junction table.
export const offerScopeEnum  = pgEnum("offer_scope",  ["all", "specific"]);
export const offerStatusEnum = pgEnum("offer_status", ["draft", "active", "expired"]);

// What kind of price/discount this offer carries.  `line_pricing` is the
// historical behaviour (per-item price/discount/qty in `offer_items`); the
// other three are header-level promotions familiar from Odoo / Zoho / SAP B1.
export const offerDiscountTypeEnum = pgEnum("offer_discount_type", [
  "line_pricing",       // per-item rules in offer_items table (legacy)
  "percentage_total",   // X% off the whole document
  "fixed_total",        // fixed amount off the whole document
  "buy_x_get_y",        // buy N → get M at `getDiscountPercent` off
]);

// Which channels the offer should apply to.  Useful when the same tenant runs
// both POS lanes and back-office sales invoices but wants different promos.
export const offerApplyToEnum = pgEnum("offer_apply_to", ["all", "pos", "invoice"]);

// ─── Offers (master) ────────────────────────────────────────────────────────
// Multi-tenant: every offer belongs to one company. `priority` 1-10 decides the
// winner when more than one active offer matches a single line on an invoice
// (higher wins, ties break on the highest discount).
export const offersTable = pgTable("offers", {
  id:             serial("id").primaryKey(),
  companyId:      integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  offerNumber:    text("offer_number").notNull(),
  nameAr:         text("name_ar"),
  description:    text("description"),
  customerScope:  offerScopeEnum("customer_scope").notNull().default("all"),
  itemsScope:     offerScopeEnum("items_scope").notNull().default("all"),
  salesRepScope:  offerScopeEnum("salesrep_scope").notNull().default("all"),
  status:         offerStatusEnum("status").notNull().default("draft"),
  priority:       integer("priority").notNull().default(1),
  // Validity range — historical offers keep working because both columns are
  // nullable and the engine treats null as "no bound on that side".
  startDate:      date("start_date"),
  expiryDate:     date("expiry_date"),

  // Discount mechanics.
  discountType:       offerDiscountTypeEnum("discount_type").notNull().default("line_pricing"),
  // Used by percentage_total (0-100) and fixed_total (currency amount).
  discountValue:      numeric("discount_value", { precision: 14, scale: 4 }),
  // Buy X get Y mechanics — only meaningful when discountType = "buy_x_get_y".
  buyQty:             integer("buy_qty"),
  getQty:             integer("get_qty"),
  getDiscountPercent: numeric("get_discount_percent", { precision: 5, scale: 2 }),

  // Eligibility / usage rules.
  minPurchaseAmount:  numeric("min_purchase_amount", { precision: 14, scale: 4 }).notNull().default("0"),
  // Optional coupon — when set, the offer only applies if the cashier types
  // this code at checkout.  Per-tenant unique (partial index below).
  couponCode:         text("coupon_code"),
  // null = unlimited.
  maxUses:            integer("max_uses"),
  maxUsesPerCustomer: integer("max_uses_per_customer"),
  // Read-only counter the engine bumps on apply — surfaced in the list page
  // so admins can see how popular each offer is.
  timesUsed:          integer("times_used").notNull().default(0),
  // If false, this offer cannot stack with another applied to the same line.
  stackable:          boolean("stackable").notNull().default(false),
  applyTo:            offerApplyToEnum("apply_to").notNull().default("all"),
  notes:              text("notes"),

  createdAt:      timestamp("created_at").defaultNow().notNull(),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  // Per-company unique offer number — same number CAN repeat across tenants.
  byCompanyNumber: uniqueIndex("offers_company_number_idx").on(t.companyId, t.offerNumber),
  byCompanyStatus: index("offers_company_status_idx").on(t.companyId, t.status),
  // Coupon codes are per-tenant unique when present — uses a partial index so
  // multiple offers without coupons are allowed (common case).
  byCouponCode:    uniqueIndex("offers_company_coupon_idx")
                     .on(t.companyId, t.couponCode)
                     .where(sql`${t.couponCode} IS NOT NULL`),
}));

// ─── Junction: offer_customers ──────────────────────────────────────────────
// Only used when offer.customerScope = "specific". Cascading delete keeps the
// junction tidy when an offer or a customer is removed.
export const offerCustomersTable = pgTable("offer_customers", {
  id:         serial("id").primaryKey(),
  offerId:    integer("offer_id").notNull().references(() => offersTable.id, { onDelete: "cascade" }),
  customerId: integer("customer_id").notNull().references(() => customersTable.id, { onDelete: "cascade" }),
}, (t) => ({
  byOffer:    index("offer_customers_offer_idx").on(t.offerId),
  byCustomer: index("offer_customers_customer_idx").on(t.customerId),
  // No two rows for the same (offer, customer) pair.
  unique:     uniqueIndex("offer_customers_unique_idx").on(t.offerId, t.customerId),
}));

// ─── Junction: offer_items ──────────────────────────────────────────────────
// Only used when offer.itemsScope = "specific". Carries the per-item price /
// discount / minimum-qty that the engine surfaces back to the invoice line.
// `discount` is a percentage (0-100) so it stays readable in reports.
export const offerItemsTable = pgTable("offer_items", {
  id:        serial("id").primaryKey(),
  offerId:   integer("offer_id").notNull().references(() => offersTable.id, { onDelete: "cascade" }),
  itemId:    integer("item_id").notNull().references(() => itemsTable.id, { onDelete: "cascade" }),
  price:     numeric("price",    { precision: 14, scale: 4 }),
  discount:  numeric("discount", { precision: 5,  scale: 2 }),
  qty:       numeric("qty",      { precision: 14, scale: 4 }),
}, (t) => ({
  byOffer:  index("offer_items_offer_idx").on(t.offerId),
  byItem:   index("offer_items_item_idx").on(t.itemId),
  unique:   uniqueIndex("offer_items_unique_idx").on(t.offerId, t.itemId),
}));

// ─── Junction: offer_salesreps ──────────────────────────────────────────────
// Only used when offer.salesRepScope = "specific".
export const offerSalesRepsTable = pgTable("offer_salesreps", {
  id:         serial("id").primaryKey(),
  offerId:    integer("offer_id").notNull().references(() => offersTable.id, { onDelete: "cascade" }),
  salesRepId: integer("salesrep_id").notNull().references(() => salesRepsTable.id, { onDelete: "cascade" }),
}, (t) => ({
  byOffer:    index("offer_salesreps_offer_idx").on(t.offerId),
  bySalesRep: index("offer_salesreps_rep_idx").on(t.salesRepId),
  unique:     uniqueIndex("offer_salesreps_unique_idx").on(t.offerId, t.salesRepId),
}));

export type Offer            = typeof offersTable.$inferSelect;
export type InsertOffer      = typeof offersTable.$inferInsert;
export type OfferCustomer    = typeof offerCustomersTable.$inferSelect;
export type OfferItem        = typeof offerItemsTable.$inferSelect;
export type OfferSalesRep    = typeof offerSalesRepsTable.$inferSelect;
