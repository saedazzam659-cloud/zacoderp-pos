import { pgTable, serial, integer, text, numeric, timestamp, boolean, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { itemsTable } from "./inventory";
import { invoicesTable } from "./invoices";

// ─── Online Stores: tenant-scoped e-commerce storefronts ───────────────────
// Each company may run one or more online stores. Each store has:
//   - a slug (used to build the default subdomain like {slug}.zacoderp.com)
//   - optional custom domains (managed in storeDomainsTable)
//   - its own published catalogue (storeProductsTable links to inventory)
//   - its own orders (storeOrdersTable) which can be confirmed into ERP
//     invoices automatically (linked via store_orders.invoice_id).
// Theme is just a free-form JSONB right now — picked by the admin from a
// list of presets ("modern", "classic", "minimal", "luxury") on the UI.
export const storesTable = pgTable("stores", {
  id:          serial("id").primaryKey(),
  companyId:   integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  name:        text("name").notNull(),
  slug:        text("slug").notNull(),
  currency:    text("currency").notNull().default("SAR"),
  language:    text("language").notNull().default("ar"),
  theme:       text("theme").notNull().default("modern"),
  logoUrl:     text("logo_url"),
  description: text("description"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  isActive:    boolean("is_active").notNull().default(true),
  metadata:    jsonb("metadata"),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
  updatedAt:   timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  uniqSlug: uniqueIndex("stores_slug_uniq").on(t.slug),
}));

// ─── Store domains: subdomain or custom-domain mapping ─────────────────────
// type: "subdomain" (eg "myshop.zacoderp.com") or "custom" (eg "shop.acme.sa")
// status: "pending" until DNS is verified, then "active" or "failed".
export const storeDomainsTable = pgTable("store_domains", {
  id:         serial("id").primaryKey(),
  companyId:  integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  storeId:    integer("store_id").notNull().references(() => storesTable.id, { onDelete: "cascade" }),
  domain:     text("domain").notNull(),
  type:       text("type").notNull().default("custom"),
  status:     text("status").notNull().default("pending"),
  isPrimary:  boolean("is_primary").notNull().default(false),
  verifiedAt: timestamp("verified_at"),
  createdAt:  timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  uniqDomain: uniqueIndex("store_domains_domain_uniq").on(t.domain),
}));

// ─── Store products: published catalogue per store ─────────────────────────
// Wraps an inventory product with store-specific overrides (price, visibility,
// hero image, sort order, long-form description) so the same item can be
// published differently in two stores.
export const storeProductsTable = pgTable("store_products", {
  id:             serial("id").primaryKey(),
  companyId:      integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  storeId:        integer("store_id").notNull().references(() => storesTable.id, { onDelete: "cascade" }),
  productId:      integer("product_id").notNull().references(() => itemsTable.id, { onDelete: "cascade" }),
  price:          numeric("price", { precision: 15, scale: 2 }).notNull().default("0"),
  comparePrice:   numeric("compare_price", { precision: 15, scale: 2 }),
  isVisible:      boolean("is_visible").notNull().default(true),
  imageUrl:       text("image_url"),
  galleryUrls:    jsonb("gallery_urls"),
  descriptionAr:  text("description_ar"),
  descriptionEn:  text("description_en"),
  sortOrder:      integer("sort_order").notNull().default(0),
  metadata:       jsonb("metadata"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  uniqStoreProduct: uniqueIndex("store_products_uniq").on(t.storeId, t.productId),
}));

// ─── Store orders: customer-facing orders placed on the storefront ─────────
// status workflow: new → confirmed → shipped → delivered (or → cancelled).
// Confirming an order: deducts inventory + creates an ERP invoice and stamps
// invoice_id here, so the accounting side picks the journal entry up via the
// usual invoices pipeline.
export const storeOrdersTable = pgTable("store_orders", {
  id:               serial("id").primaryKey(),
  companyId:        integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  storeId:          integer("store_id").notNull().references(() => storesTable.id, { onDelete: "cascade" }),
  code:             text("code").notNull(),
  customerName:     text("customer_name").notNull(),
  customerPhone:    text("customer_phone"),
  customerEmail:    text("customer_email"),
  shippingAddress:  text("shipping_address"),
  shippingCity:     text("shipping_city"),
  shippingMethod:   text("shipping_method"),
  shippingCost:     numeric("shipping_cost",   { precision: 15, scale: 2 }).notNull().default("0"),
  subtotal:         numeric("subtotal",        { precision: 15, scale: 2 }).notNull().default("0"),
  vat:              numeric("vat",             { precision: 15, scale: 2 }).notNull().default("0"),
  total:            numeric("total",           { precision: 15, scale: 2 }).notNull().default("0"),
  paymentMethod:    text("payment_method").notNull().default("cod"),
  paymentStatus:    text("payment_status").notNull().default("unpaid"),
  status:           text("status").notNull().default("new"),
  invoiceId:        integer("invoice_id").references(() => invoicesTable.id, { onDelete: "set null" }),
  notes:            text("notes"),
  trackingNumber:   text("tracking_number"),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
  confirmedAt:      timestamp("confirmed_at"),
  shippedAt:        timestamp("shipped_at"),
  deliveredAt:      timestamp("delivered_at"),
  cancelledAt:      timestamp("cancelled_at"),
}, (t) => ({
  uniqCode: uniqueIndex("store_orders_company_code_uniq").on(t.companyId, t.code),
}));

export const storeOrderItemsTable = pgTable("store_order_items", {
  id:             serial("id").primaryKey(),
  orderId:        integer("order_id").notNull().references(() => storeOrdersTable.id, { onDelete: "cascade" }),
  storeProductId: integer("store_product_id").references(() => storeProductsTable.id, { onDelete: "set null" }),
  productId:      integer("product_id").references(() => itemsTable.id, { onDelete: "set null" }),
  productName:    text("product_name").notNull(),
  qty:            numeric("qty",       { precision: 15, scale: 3 }).notNull(),
  unitPrice:      numeric("unit_price", { precision: 15, scale: 2 }).notNull(),
  lineTotal:      numeric("line_total", { precision: 15, scale: 2 }).notNull(),
});

// ─── Payment gateway settings: per-store toggle + (encrypted-ish) config ──
// gateway: mada, stcpay, applepay, sadad, tamara, tabby, stripe, paypal,
// bank_transfer, cod, etc. environment: "test" | "live". configJson holds
// gateway-specific keys; we don't surface them on listing endpoints.
export const storePaymentSettingsTable = pgTable("store_payment_settings", {
  id:          serial("id").primaryKey(),
  companyId:   integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  storeId:     integer("store_id").notNull().references(() => storesTable.id, { onDelete: "cascade" }),
  gateway:     text("gateway").notNull(),
  isEnabled:   boolean("is_enabled").notNull().default(false),
  environment: text("environment").notNull().default("test"),
  displayName: text("display_name"),
  configJson:  jsonb("config_json"),
  updatedAt:   timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  uniqStoreGateway: uniqueIndex("store_payment_settings_uniq").on(t.storeId, t.gateway),
}));
