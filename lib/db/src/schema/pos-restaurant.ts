import {
  pgTable, serial, integer, text, numeric, timestamp, boolean, pgEnum,
  uniqueIndex, index, jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";
import { usersTable } from "./users";
import { posSessionsTable } from "./pos";
import { customersTable } from "./customers";
import { salesInvoicesTable } from "./sales";

// ─── Restaurant / Cafe POS — extension of the basic cashier POS ─────────────
// Adds dine-in tables, a configurable menu, waiter-side order taking,
// kitchen tickets, and suspicious-cashier-ops audit. Reused as-is for cafes
// (kind="drink"), pizza shops, etc.

export const POS_TABLE_STATUSES = ["free", "occupied", "reserved", "cleaning"] as const;
export const posTableStatusEnum = pgEnum("pos_table_status", POS_TABLE_STATUSES);

export const posTablesTable = pgTable("pos_tables", {
  id:             serial("id").primaryKey(),
  companyId:      integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:       integer("branch_id").notNull().references(() => branchesTable.id, { onDelete: "cascade" }),
  code:           text("code").notNull(),
  nameAr:         text("name_ar").notNull(),
  capacity:       integer("capacity").notNull().default(4),
  area:           text("area"),
  status:         posTableStatusEnum("status").notNull().default("free"),
  currentOrderId: integer("current_order_id"),
  publicOrderToken: text("public_order_token"),
  isActive:       boolean("is_active").notNull().default(true),
  notes:          text("notes"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  uniqCode: uniqueIndex("pos_tables_company_code_uniq").on(t.companyId, t.code),
  byBranch: index("pos_tables_branch_idx").on(t.branchId, t.status),
}));

export const posRestaurantReservationsTable = pgTable("pos_restaurant_reservations", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId: integer("branch_id").notNull().references(() => branchesTable.id, { onDelete: "cascade" }),
  tableId: integer("table_id").references(() => posTablesTable.id, { onDelete: "set null" }),
  kind: text("kind").notNull().default("reservation"),
  status: text("status").notNull().default("confirmed"),
  customerName: text("customer_name").notNull(),
  customerPhone: text("customer_phone"),
  guestCount: integer("guest_count").notNull().default(1),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  durationMinutes: integer("duration_minutes").notNull().default(90),
  notes: text("notes"),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  bySchedule: index("pos_restaurant_reservations_schedule_idx").on(t.companyId, t.branchId, t.scheduledAt),
  byTable: index("pos_restaurant_reservations_table_idx").on(t.companyId, t.tableId, t.scheduledAt),
}));

export const POS_MENU_KINDS = ["food", "drink", "dessert", "other"] as const;
export const posMenuKindEnum = pgEnum("pos_menu_kind", POS_MENU_KINDS);

export const posMenuCategoriesTable = pgTable("pos_menu_categories", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:     integer("branch_id").references(() => branchesTable.id, { onDelete: "set null" }),
  code:         text("code").notNull(),
  nameAr:       text("name_ar").notNull(),
  nameEn:       text("name_en"),
  kind:         posMenuKindEnum("kind").notNull().default("food"),
  displayOrder: integer("display_order").notNull().default(0),
  color:        text("color"),
  isActive:     boolean("is_active").notNull().default(true),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  uniqCode: uniqueIndex("pos_menu_cat_company_code_uniq").on(t.companyId, t.code),
}));

export const posRestaurantKitchenStationsTable = pgTable("pos_restaurant_kitchen_stations", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  stationKey: text("station_key").notNull(),
  nameAr: text("name_ar").notNull(),
  nameEn: text("name_en"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  companyStationUnique: uniqueIndex("pos_restaurant_kitchen_stations_company_key_uniq").on(t.companyId, t.stationKey),
  byCompanyOrder: index("pos_restaurant_kitchen_stations_company_order_idx").on(t.companyId, t.sortOrder, t.id),
}));

export const posRestaurantKitchenPrinterRoutesTable = pgTable("pos_restaurant_kitchen_printer_routes", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId: integer("branch_id").notNull().references(() => branchesTable.id, { onDelete: "cascade" }),
  stationKey: text("station_key").notNull(),
  primaryPrinterName: text("primary_printer_name").notNull(),
  backupPrinterName: text("backup_printer_name"),
  isActive: boolean("is_active").notNull().default(true),
  updatedByUserId: integer("updated_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  companyBranchStationUnique: uniqueIndex("pos_rest_kitchen_printer_route_scope_uniq")
    .on(t.companyId, t.branchId, t.stationKey),
  byCompanyBranch: index("pos_rest_kitchen_printer_route_branch_idx").on(t.companyId, t.branchId),
}));

export const posRestaurantPrintBridgesTable = pgTable("pos_restaurant_print_bridges", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId: integer("branch_id").notNull().references(() => branchesTable.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  lastSeenAt: timestamp("last_seen_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  companyBranchUnique: uniqueIndex("pos_rest_print_bridge_scope_uniq").on(t.companyId, t.branchId),
}));

export const posRestaurantKitchenPrintJobsTable = pgTable("pos_restaurant_kitchen_print_jobs", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId: integer("branch_id").notNull().references(() => branchesTable.id, { onDelete: "cascade" }),
  orderId: integer("order_id").notNull().references(() => posOrdersTable.id, { onDelete: "cascade" }),
  stationKey: text("station_key").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  payload: jsonb("payload").$type<{
    operation: "new" | "update" | "cancel";
    orderNumber: string; channel: string; tableName: string | null; stationName: string;
    primaryPrinterName: string; backupPrinterName: string | null;
    items: Array<{ name: string; qty: string; notes: string | null; modifiers: Array<{ option: string }> }>;
  }>().notNull(),
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  claimedAt: timestamp("claimed_at"),
  printedAt: timestamp("printed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  companyIdempotencyUnique: uniqueIndex("pos_rest_kitchen_print_job_idempotency_uniq").on(t.companyId, t.idempotencyKey),
  byBranchStatus: index("pos_rest_kitchen_print_job_branch_status_idx").on(t.branchId, t.status, t.createdAt),
}));

// Company/branch-scoped credentials for official restaurant delivery APIs.
// Secrets are encrypted by the API server before being persisted.
export const posRestaurantDeliveryIntegrationsTable = pgTable("pos_restaurant_delivery_integrations", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId: integer("branch_id").notNull().references(() => branchesTable.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("hungerstation"),
  environment: text("environment").notNull().default("sandbox"),
  chainId: text("chain_id").notNull(),
  vendorId: text("vendor_id").notNull(),
  clientId: text("client_id").notNull(),
  credentialsEnc: text("credentials_enc").notNull(),
  webhookTokenHash: text("webhook_token_hash"),
  isEnabled: boolean("is_enabled").notNull().default(false),
  updatedByUserId: integer("updated_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  branchProviderUnique: uniqueIndex("pos_rest_delivery_company_branch_provider_uniq")
    .on(t.companyId, t.branchId, t.provider),
  byCompany: index("pos_rest_delivery_company_idx").on(t.companyId, t.provider),
}));

export const posRestaurantExternalOrdersTable = pgTable("pos_restaurant_external_orders", {
  id: serial("id").primaryKey(),
  integrationId: integer("integration_id").notNull()
    .references(() => posRestaurantDeliveryIntegrationsTable.id, { onDelete: "cascade" }),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId: integer("branch_id").notNull().references(() => branchesTable.id, { onDelete: "cascade" }),
  externalOrderId: text("external_order_id").notNull(),
  orderCode: text("order_code"),
  providerStatus: text("provider_status").notNull(),
  orderPayload: jsonb("order_payload").$type<Record<string, unknown>>().notNull(),
  posOrderId: integer("pos_order_id").references(() => posOrdersTable.id, { onDelete: "set null" }),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  integrationOrderUnique: uniqueIndex("pos_rest_external_order_integration_uidx").on(t.integrationId, t.externalOrderId),
  companyStatusIndex: index("pos_rest_external_order_company_status_idx").on(t.companyId, t.providerStatus, t.receivedAt),
}));

export const posRestaurantDeliveryItemMappingsTable = pgTable("pos_restaurant_delivery_item_mappings", {
  id: serial("id").primaryKey(),
  integrationId: integer("integration_id").notNull()
    .references(() => posRestaurantDeliveryIntegrationsTable.id, { onDelete: "cascade" }),
  externalSku: text("external_sku").notNull(),
  menuItemId: integer("menu_item_id").notNull().references(() => posMenuItemsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  integrationSkuUnique: uniqueIndex("pos_rest_delivery_mapping_integration_sku_uidx").on(t.integrationId, t.externalSku),
  byMenuItem: index("pos_rest_delivery_mapping_menu_item_idx").on(t.menuItemId),
}));

// kitchenStation stores a stable catalog key so each restaurant can define
// its own stations while order-line snapshots keep their routing identity.
export const posMenuItemsTable = pgTable("pos_menu_items", {
  id:              serial("id").primaryKey(),
  companyId:       integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  categoryId:      integer("category_id").notNull().references(() => posMenuCategoriesTable.id, { onDelete: "cascade" }),
  // Optional FK to the main inventory item — when set, billing decrements
  // stock and pulls the cost. When null the line is service-only.
  itemId:          integer("item_id"),
  code:            text("code").notNull(),
  nameAr:          text("name_ar").notNull(),
  nameEn:          text("name_en"),
  description:     text("description"),
  price:           numeric("price", { precision: 15, scale: 2 }).notNull().default("0"),
  vatIncluded:     boolean("vat_included").notNull().default(true),
  prepTimeMinutes: integer("prep_time_minutes").notNull().default(0),
  kitchenStation:  text("kitchen_station").notNull().default("kitchen"),
  imageUrl:        text("image_url"),
  modifiers:       jsonb("modifiers").$type<Array<{ name: string; options: Array<{ label: string; price: number }> }>>().notNull().default([]),
  isActive:        boolean("is_active").notNull().default(true),
  createdAt:       timestamp("created_at").defaultNow().notNull(),
  updatedAt:       timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  uniqCode: uniqueIndex("pos_menu_items_company_code_uniq").on(t.companyId, t.code),
  byCat:    index("pos_menu_items_cat_idx").on(t.categoryId, t.isActive),
}));

export const POS_ORDER_CHANNELS = ["dine_in", "takeaway", "delivery"] as const;
export const posOrderChannelEnum = pgEnum("pos_order_channel", POS_ORDER_CHANNELS);

export const POS_ORDER_STATUSES = [
  "open", "sent", "preparing", "ready", "served", "billed", "cancelled",
] as const;
export const posOrderStatusEnum = pgEnum("pos_order_status", POS_ORDER_STATUSES);

export const posOrdersTable = pgTable("pos_orders", {
  id:              serial("id").primaryKey(),
  companyId:       integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:        integer("branch_id").notNull().references(() => branchesTable.id, { onDelete: "cascade" }),
  orderNumber:     text("order_number").notNull(),
  channel:         posOrderChannelEnum("channel").notNull().default("dine_in"),
  tableId:         integer("table_id"),
  customerName:    text("customer_name"),
  customerPhone:   text("customer_phone"),
  deliveryAddress: text("delivery_address"),
  waiterId:        integer("waiter_id"),
  status:          posOrderStatusEnum("status").notNull().default("open"),
  guestCount:      integer("guest_count").notNull().default(1),
  subtotal:        numeric("subtotal",   { precision: 15, scale: 2 }).notNull().default("0"),
  vatAmount:       numeric("vat_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  total:           numeric("total",      { precision: 15, scale: 2 }).notNull().default("0"),
  // Cashier completes the order → emits a salesInvoice, links it back here.
  billedInvoiceId: integer("billed_invoice_id"),
  notes:           text("notes"),
  sourcePlatform:  text("source_platform"),
  externalOrderId: text("external_order_id"),
  openedAt:        timestamp("opened_at").defaultNow().notNull(),
  sentAt:          timestamp("sent_at"),
  readyAt:         timestamp("ready_at"),
  servedAt:        timestamp("served_at"),
  billedAt:        timestamp("billed_at"),
  cancelledAt:     timestamp("cancelled_at"),
  createdAt:       timestamp("created_at").defaultNow().notNull(),
  updatedAt:       timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  uniqNumber: uniqueIndex("pos_orders_company_number_uniq").on(t.companyId, t.orderNumber),
  byBranch:   index("pos_orders_branch_status_idx").on(t.branchId, t.status),
  byTable:    index("pos_orders_table_idx").on(t.tableId),
  externalOrderUnique: uniqueIndex("pos_orders_external_source_uq")
    .on(t.companyId, t.sourcePlatform, t.externalOrderId)
    .where(sql`${t.externalOrderId} IS NOT NULL`),
}));

export const POS_LINE_STATUSES = [
  "pending", "preparing", "ready", "served", "cancelled",
] as const;
export const posLineStatusEnum = pgEnum("pos_line_status", POS_LINE_STATUSES);

export const posOrderItemsTable = pgTable("pos_order_items", {
  id:             serial("id").primaryKey(),
  orderId:        integer("order_id").notNull().references(() => posOrdersTable.id, { onDelete: "cascade" }),
  menuItemId:     integer("menu_item_id").notNull(),
  nameSnapshot:   text("name_snapshot").notNull(),
  qty:            numeric("qty", { precision: 15, scale: 3 }).notNull().default("1"),
  price:          numeric("price", { precision: 15, scale: 2 }).notNull().default("0"),
  total:          numeric("total", { precision: 15, scale: 2 }).notNull().default("0"),
  modifiers:      jsonb("modifiers").$type<Array<{
    name: string;
    option: string;
    price: number;
    groupId?: string;
    optionId?: string;
    itemId?: number;
    itemType?: "stock" | "service";
    vatRate?: string | number;
    vatIncluded?: boolean;
    consumptionQtyPerSelection?: number;
  }>>().notNull().default([]),
  kitchenStation: text("kitchen_station").notNull().default("kitchen"),
  status:         posLineStatusEnum("status").notNull().default("pending"),
  notes:          text("notes"),
  sentAt:         timestamp("sent_at"),
  readyAt:        timestamp("ready_at"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  byOrder:   index("pos_order_items_order_idx").on(t.orderId),
  byStation: index("pos_order_items_station_status_idx").on(t.kitchenStation, t.status),
}));

export const posRestaurantLoyaltyProgramsTable = pgTable("pos_restaurant_loyalty_programs", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  earnEvery: numeric("earn_every", { precision: 12, scale: 4 }).notNull().default("1"),
  redeemValuePer100: numeric("redeem_value_per_100", { precision: 12, scale: 4 }).notNull().default("1"),
  minRedeemPoints: integer("min_redeem_points").notNull().default(100),
  expiryDays: integer("expiry_days").notNull().default(365),
  rules: jsonb("rules").$type<Array<{
    id: string | number; name: string; channel: "all" | "dine_in" | "takeaway" | "delivery";
    minInvoiceAmount: number; customerGroupId: number | null; pointsMultiplier: number; isActive: boolean;
  }>>().notNull().default([]),
  tiers: jsonb("tiers").$type<Array<{
    id: string | number; name: string; minLifetimeSpend: number; pointsMultiplier: number; isActive: boolean;
  }>>().notNull().default([]),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  companyUnique: uniqueIndex("pos_restaurant_loyalty_programs_company_uniq").on(t.companyId),
}));

export const posRestaurantLoyaltyLedgerTable = pgTable("pos_restaurant_loyalty_ledger", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  customerId: integer("customer_id").notNull().references(() => customersTable.id, { onDelete: "cascade" }),
  invoiceId: integer("invoice_id").notNull().references(() => salesInvoicesTable.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  points: integer("points").notNull(),
  spendAmount: numeric("spend_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  sourceEarnId: integer("source_earn_id"),
  sourceLedgerId: integer("source_ledger_id"),
  returnId: integer("return_id"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byCustomer: index("pos_restaurant_loyalty_ledger_customer_idx").on(t.companyId, t.customerId, t.createdAt),
  bySourceLedger: index("pos_restaurant_loyalty_ledger_source_idx").on(t.companyId, t.sourceLedgerId),
  earnOnce: uniqueIndex("pos_restaurant_loyalty_ledger_earn_once")
    .on(t.companyId, t.invoiceId).where(sql`${t.type} = 'earn'`),
  redeemOncePerLot: uniqueIndex("pos_restaurant_loyalty_ledger_redeem_once_per_lot")
    .on(t.companyId, t.invoiceId, t.sourceEarnId).where(sql`${t.type} = 'redeem'`),
}));

// ─── Suspicious cashier ops (rule-based now, AI-enriched later) ────────────
export const POS_SUSPICIOUS_KINDS = [
  "excessive_void", "excessive_refund", "large_discount",
  "late_night_sale", "after_hours_login", "rapid_voids",
] as const;
export const posSuspiciousKindEnum = pgEnum("pos_suspicious_kind", POS_SUSPICIOUS_KINDS);

export const posSuspiciousOpsTable = pgTable("pos_suspicious_ops", {
  id:          serial("id").primaryKey(),
  companyId:   integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  sessionId:   integer("session_id").references(() => posSessionsTable.id, { onDelete: "set null" }),
  userId:      integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  branchId:    integer("branch_id"),
  kind:        posSuspiciousKindEnum("kind").notNull(),
  severity:    text("severity").notNull().default("medium"),
  description: text("description").notNull(),
  payload:     jsonb("payload").$type<Record<string, any>>().notNull().default({}),
  acknowledged: boolean("acknowledged").notNull().default(false),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byCompany: index("pos_suspicious_ops_company_idx").on(t.companyId, t.createdAt),
  byUser:    index("pos_suspicious_ops_user_idx").on(t.userId),
}));
