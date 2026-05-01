import {
  pgTable, serial, text, integer, numeric, boolean, timestamp, date, pgEnum,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { accountsTable } from "./accounts";

// ─── Enums ────────────────────────────────────────────────────────────────────
export const itemTypeEnum       = pgEnum("item_type",        ["stock", "service"]);
export const itemStatusEnum     = pgEnum("item_status",      ["active", "inactive"]);
export const txTypeEnum         = pgEnum("inv_tx_type",      ["transfer_out", "transfer_in", "adjustment", "count_adj", "sale", "sales_return", "purchase", "purchase_return", "opening", "goods_receipt"]);
export const docStatusEnum      = pgEnum("inv_doc_status",   ["draft", "posted", "cancelled"]);
export const costMethodEnum     = pgEnum("cost_method",      ["weighted_avg", "last_cost"]);

// ─── Warehouse Groups ─────────────────────────────────────────────────────────
export const warehouseGroupsTable = pgTable("warehouse_groups", {
  id:        serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  code:      text("code").notNull(),
  nameAr:    text("name_ar").notNull(),
  nameEn:    text("name_en"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Warehouses ───────────────────────────────────────────────────────────────
export const warehousesTable = pgTable("warehouses", {
  id:             serial("id").primaryKey(),
  companyId:      integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  groupId:        integer("group_id").references(() => warehouseGroupsTable.id),
  code:           text("code").notNull(),
  nameAr:         text("name_ar").notNull(),
  nameEn:         text("name_en"),
  city:           text("city"),
  region:         text("region"),
  allowNegative:  boolean("allow_negative").default(false).notNull(),
  negativeLimit:  numeric("negative_limit", { precision: 14, scale: 4 }),
  isActive:       boolean("is_active").default(true).notNull(),
  accountId:      integer("account_id"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
});

// ─── Item Groups ──────────────────────────────────────────────────────────────
export const itemGroupsTable = pgTable("item_groups", {
  id:              serial("id").primaryKey(),
  companyId:       integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  code:            text("code").notNull(),
  nameAr:          text("name_ar").notNull(),
  nameEn:          text("name_en"),
  costAccountId:   integer("cost_account_id"),
  revenueAccountId:integer("revenue_account_id"),
  createdAt:       timestamp("created_at").defaultNow().notNull(),
});

// ─── Units of Measure ─────────────────────────────────────────────────────────
export const unitsTable = pgTable("units", {
  id:               serial("id").primaryKey(),
  companyId:        integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  code:             text("code").notNull(),
  nameAr:           text("name_ar").notNull(),
  nameEn:           text("name_en"),
  conversionFactor: numeric("conversion_factor", { precision: 14, scale: 6 }).default("1").notNull(),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
});

// ─── Items ────────────────────────────────────────────────────────────────────
export const itemsTable = pgTable("items", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  groupId:      integer("group_id").references(() => itemGroupsTable.id),
  unitId:       integer("unit_id").references(() => unitsTable.id),
  code:         text("code").notNull(),
  nameAr:       text("name_ar").notNull(),
  nameEn:       text("name_en"),
  barcode:      text("barcode"),
  itemType:     itemTypeEnum("item_type").notNull().default("stock"),
  costPrice:    numeric("cost_price",  { precision: 14, scale: 4 }).default("0").notNull(),
  salePrice:    numeric("sale_price",  { precision: 14, scale: 4 }).default("0").notNull(),
  vatRate:      numeric("vat_rate",    { precision: 5,  scale: 2  }).default("15").notNull(),
  reorderLevel: numeric("reorder_level", { precision: 14, scale: 4 }).default("0"),
  maxLevel:     numeric("max_level",     { precision: 14, scale: 4 }),
  costMethod:       costMethodEnum("cost_method").default("weighted_avg").notNull(),
  status:           itemStatusEnum("item_status").default("active").notNull(),
  description:      text("description"),
  imageUrl:         text("image_url"),
  costAccountId:    integer("cost_account_id"),
  revenueAccountId: integer("revenue_account_id"),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
  updatedAt:        timestamp("updated_at").defaultNow().notNull(),
});

// ─── Item Unit Prices (multi-unit per item with conversion factor) ────────────
// Example: Item "Sugar" — base unit واحدة (×1, cost 5, sale 10), unit كرتونة (×12, cost 60, sale 100)
export const itemUnitPricesTable = pgTable("item_unit_prices", {
  id:               serial("id").primaryKey(),
  companyId:        integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  itemId:           integer("item_id").notNull().references(() => itemsTable.id, { onDelete: "cascade" }),
  unitId:           integer("unit_id").notNull().references(() => unitsTable.id, { onDelete: "cascade" }),
  conversionFactor: numeric("conversion_factor", { precision: 14, scale: 6 }).notNull().default("1"),
  costPrice:        numeric("cost_price",  { precision: 14, scale: 4 }).notNull().default("0"),
  salePrice:        numeric("sale_price",  { precision: 14, scale: 4 }).notNull().default("0"),
  isBase:           boolean("is_base").notNull().default(false),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
});

// ─── Stock Balance (summary per item per warehouse) ───────────────────────────
export const stockBalanceTable = pgTable("stock_balance", {
  id:          serial("id").primaryKey(),
  companyId:   integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  itemId:      integer("item_id").notNull().references(() => itemsTable.id, { onDelete: "cascade" }),
  warehouseId: integer("warehouse_id").notNull().references(() => warehousesTable.id, { onDelete: "cascade" }),
  qty:         numeric("qty",      { precision: 18, scale: 4 }).default("0").notNull(),
  avgCost:     numeric("avg_cost", { precision: 14, scale: 4 }).default("0").notNull(),
  updatedAt:   timestamp("updated_at").defaultNow().notNull(),
});

// ─── Stock Ledger (full movement log) ────────────────────────────────────────
export const stockLedgerTable = pgTable("stock_ledger", {
  id:          serial("id").primaryKey(),
  companyId:   integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  itemId:      integer("item_id").notNull().references(() => itemsTable.id),
  warehouseId: integer("warehouse_id").notNull().references(() => warehousesTable.id),
  txDate:      date("tx_date").notNull(),
  txType:      txTypeEnum("tx_type").notNull(),
  qty:         numeric("qty",        { precision: 18, scale: 4 }).notNull(),
  costPrice:   numeric("cost_price", { precision: 14, scale: 4 }).default("0").notNull(),
  totalCost:   numeric("total_cost", { precision: 18, scale: 4 }).default("0").notNull(),
  balanceQty:  numeric("balance_qty",{ precision: 18, scale: 4 }).default("0").notNull(),
  refId:       integer("ref_id"),
  refType:     text("ref_type"),     // transfer | adjustment | count | invoice
  notes:       text("notes"),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
});

// ─── Stock Transfers ──────────────────────────────────────────────────────────
export const stockTransfersTable = pgTable("stock_transfers", {
  id:              serial("id").primaryKey(),
  companyId:       integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  transferNumber:  text("transfer_number").notNull(),
  transferDate:    date("transfer_date").notNull(),
  fromWarehouseId: integer("from_warehouse_id").notNull().references(() => warehousesTable.id),
  toWarehouseId:   integer("to_warehouse_id").notNull().references(() => warehousesTable.id),
  accountId:       integer("account_id").references(() => accountsTable.id),
  fromAccountId:   integer("from_account_id").references(() => accountsTable.id),
  toAccountId:     integer("to_account_id").references(() => accountsTable.id),
  journalEntryId:  integer("journal_entry_id"),
  status:          docStatusEnum("status").default("draft").notNull(),
  notes:           text("notes"),
  createdAt:       timestamp("created_at").defaultNow().notNull(),
  updatedAt:       timestamp("updated_at").defaultNow().notNull(),
});

export const stockTransferItemsTable = pgTable("stock_transfer_items", {
  id:         serial("id").primaryKey(),
  transferId: integer("transfer_id").notNull().references(() => stockTransfersTable.id, { onDelete: "cascade" }),
  itemId:     integer("item_id").notNull().references(() => itemsTable.id),
  unitId:     integer("unit_id").references(() => unitsTable.id),
  qty:        numeric("qty",        { precision: 18, scale: 4 }).notNull(),
  costPrice:  numeric("cost_price", { precision: 14, scale: 4 }).default("0").notNull(),
});

// ─── Stock Adjustments ────────────────────────────────────────────────────────
export const stockAdjustmentsTable = pgTable("stock_adjustments", {
  id:               serial("id").primaryKey(),
  companyId:        integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  adjustmentNumber: text("adjustment_number").notNull(),
  adjustmentDate:   date("adjustment_date").notNull(),
  warehouseId:      integer("warehouse_id").notNull().references(() => warehousesTable.id),
  accountId:        integer("account_id").references(() => accountsTable.id),
  // Inventory account = the warehouse-side asset account (debit on increase / credit on decrease)
  inventoryAccountId:  integer("inventory_account_id").references(() => accountsTable.id),
  // Adjustment account = expense/income contra account (loss for shrinkage, gain for surplus)
  adjustmentAccountId: integer("adjustment_account_id").references(() => accountsTable.id),
  // Linked JE id created on post
  journalEntryId:      integer("journal_entry_id"),
  reason:           text("reason"),
  status:           docStatusEnum("status").default("draft").notNull(),
  notes:            text("notes"),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
  updatedAt:        timestamp("updated_at").defaultNow().notNull(),
});

export const stockAdjustmentItemsTable = pgTable("stock_adjustment_items", {
  id:           serial("id").primaryKey(),
  adjustmentId: integer("adjustment_id").notNull().references(() => stockAdjustmentsTable.id, { onDelete: "cascade" }),
  itemId:       integer("item_id").notNull().references(() => itemsTable.id),
  unitId:       integer("unit_id").references(() => unitsTable.id),
  qty:          numeric("qty",        { precision: 18, scale: 4 }).notNull(),
  costPrice:    numeric("cost_price", { precision: 14, scale: 4 }).default("0").notNull(),
  notes:        text("notes"),
});

// ─── Stock Counts ─────────────────────────────────────────────────────────────
export const stockCountsTable = pgTable("stock_counts", {
  id:          serial("id").primaryKey(),
  companyId:   integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  countNumber: text("count_number").notNull(),
  countDate:   date("count_date").notNull(),
  warehouseId: integer("warehouse_id").notNull().references(() => warehousesTable.id),
  status:      docStatusEnum("status").default("draft").notNull(),
  notes:       text("notes"),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
  updatedAt:   timestamp("updated_at").defaultNow().notNull(),
});

export const stockCountItemsTable = pgTable("stock_count_items", {
  id:        serial("id").primaryKey(),
  countId:   integer("count_id").notNull().references(() => stockCountsTable.id, { onDelete: "cascade" }),
  itemId:    integer("item_id").notNull().references(() => itemsTable.id),
  systemQty: numeric("system_qty",  { precision: 18, scale: 4 }).default("0").notNull(),
  actualQty: numeric("actual_qty",  { precision: 18, scale: 4 }).notNull(),
  diff:      numeric("diff",        { precision: 18, scale: 4 }).default("0").notNull(),
  costPrice: numeric("cost_price",  { precision: 14, scale: 4 }).default("0").notNull(),
  notes:     text("notes"),
});
