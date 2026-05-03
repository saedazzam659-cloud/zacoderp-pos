import {
  pgTable, serial, text, integer, numeric, boolean, timestamp, date, pgEnum,
  uniqueIndex, jsonb, AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companiesTable } from "./companies";
import { accountsTable } from "./accounts";
import { suppliersTable } from "./suppliers";
import { branchesTable } from "./branches";

// ─── Enums ────────────────────────────────────────────────────────────────────
export const itemTypeEnum       = pgEnum("item_type",        ["stock", "service"]);
export const itemStatusEnum     = pgEnum("item_status",      ["active", "inactive"]);
export const txTypeEnum         = pgEnum("inv_tx_type",      ["transfer_out", "transfer_in", "adjustment", "count_adj", "sale", "sales_return", "purchase", "purchase_return", "opening", "goods_receipt", "goods_delivery"]);
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
  branchId:       integer("branch_id").references(() => branchesTable.id),
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
  // Comma-separated tags for smart search & filtering (PRO Extension #4)
  tags:             text("tags"),
  // Default per-item discount applied automatically when the item is added
  // to a sales document line (PRO Extension #3 — "خصم بنسبة/قيمة").
  // discountType:  "none" | "percent" | "amount"
  //   - "none"    → no auto-discount (default)
  //   - "percent" → discountValue is a percentage of (qty × unitPrice)
  //   - "amount"  → discountValue is an absolute currency amount per line
  discountType:     text("discount_type").default("none").notNull(),
  discountValue:    numeric("discount_value", { precision: 14, scale: 4 }).default("0").notNull(),
  // PRO Extension #2 — Bundles / Kits. When true, this item's child
  // composition is defined in `item_bundle_components`. Used by the UI to
  // show/hide the "المكونات" panel; future work: deduct child stock on sale.
  isBundle:         boolean("is_bundle").default(false).notNull(),
  // PRO Extension #20 — Item Variants. A variant is an item whose
  // `parentItemId` points to another item in the same tenant — for example
  // a "T-Shirt – Red – Large" variant of the parent "T-Shirt" template.
  // Variants are first-class items: they have their own code/barcode,
  // their own stock balances, and they appear independently in stock
  // movements. Routes enforce the rules: a variant cannot be a bundle,
  // a bundle cannot be a variant parent, and variants cannot have variants
  // (no nesting). The free-form JSON shape (e.g. `{"color":"red","size":"L"}`)
  // is intentional — different industries need different attribute sets.
  parentItemId:       integer("parent_item_id").references((): AnyPgColumn => itemsTable.id, { onDelete: "cascade" }),
  variantAttributes:  jsonb("variant_attributes"),
  // Whether the item appears in POS (cashier / supermarket / restaurant)
  // item lists. Defaults to true so existing items keep showing up. The
  // POS items endpoint filters on this so unchecked items are hidden from
  // the cashier UI without affecting inventory or sales documents.
  showInPos:        boolean("show_in_pos").default(true).notNull(),
  // Optional expiry date — primarily meaningful for manufactured items
  // (those with a BOM / bundle composition) but stored on every item so
  // future workflows (lot tracking, batch posting) can read it uniformly.
  expiryDate:       date("expiry_date"),
  costAccountId:    integer("cost_account_id"),
  revenueAccountId: integer("revenue_account_id"),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
  updatedAt:        timestamp("updated_at").defaultNow().notNull(),
});

// ─── Item Documents (PRO Extension #10) ──────────────────────────────────────
// Files attached to an item — typically warranty cards, certificates,
// product manuals, datasheets, supplier invoices, photos of physical
// receipts, etc. The actual blob lives in object storage; we store only
// the /objects/... path so the existing storage proxy + ACL rules apply.
export const itemDocumentsTable = pgTable("item_documents", {
  id:               serial("id").primaryKey(),
  companyId:        integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  itemId:           integer("item_id").notNull().references(() => itemsTable.id, { onDelete: "cascade" }),
  fileUrl:          text("file_url").notNull(),         // /objects/... path
  fileName:         text("file_name").notNull(),        // original filename for display + download
  fileType:         text("file_type"),                  // MIME type
  fileSize:         integer("file_size"),               // bytes
  // Free-text category — kept as text (not enum) so users can add custom
  // categories like "صيانة" or "موافقة هيئة الغذاء" without a migration.
  // The UI offers preset values but doesn't enforce them.
  category:         text("category").default("other").notNull(),
  notes:            text("notes"),
  uploadedByUserId: integer("uploaded_by_user_id"),     // soft FK; user might be deleted later
  createdAt:        timestamp("created_at").defaultNow().notNull(),
});

// ─── Item Suppliers (PRO Extension #17) ───────────────────────────────────────
// Many-to-many link between items and suppliers, with per-link metadata:
// the last-known purchase price from this supplier, an optional supplier-
// specific item code (the supplier's own SKU for the part), an optional
// lead-time-in-days, and a single "preferred supplier" flag per item that
// the schema enforces (only one preferred row per (companyId, itemId))
// via a partial unique index — this makes the invariant concurrency-safe
// instead of relying on application-level checks alone.
export const itemSuppliersTable = pgTable("item_suppliers", {
  id:                 serial("id").primaryKey(),
  companyId:          integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  itemId:             integer("item_id").notNull().references(() => itemsTable.id, { onDelete: "cascade" }),
  supplierId:         integer("supplier_id").notNull().references(() => suppliersTable.id, { onDelete: "cascade" }),
  // Supplier's own SKU for this item (e.g. their internal part number).
  // Useful when reordering — the user can quote the supplier's own code.
  supplierItemCode:   text("supplier_item_code"),
  // Last known unit purchase price from this supplier. Manually editable
  // for now; in a future batch a hook on the purchase-invoice posting flow
  // can auto-update this when a new purchase line for the same item lands.
  lastPurchasePrice:  numeric("last_purchase_price", { precision: 14, scale: 4 }),
  lastPurchaseDate:   date("last_purchase_date"),
  // Quoted lead time in days — surfaced in low-stock reorder suggestions.
  leadTimeDays:       integer("lead_time_days"),
  // Schema-enforced invariant via partial unique index below: at most ONE
  // preferred supplier per (companyId, itemId). The route layer also unsets
  // others before flipping a new one to true so the typical happy-path UX
  // is "click and it just works", but the partial index is the truth-keeper
  // under concurrent requests.
  preferredSupplier:  boolean("preferred_supplier").notNull().default(false),
  notes:              text("notes"),
  createdAt:          timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  // Prevent duplicate rows per (tenant, item, supplier) under concurrency.
  // The route layer still does an app-level 409 check first for nicer UX;
  // this index is the safety net when two POSTs race past that check.
  itemSupplierUnique: uniqueIndex("item_suppliers_company_item_supplier_uniq")
    .on(t.companyId, t.itemId, t.supplierId),
  // Postgres partial unique index: at most ONE row per (companyId, itemId)
  // with preferred_supplier = true. Multiple non-preferred rows are fine.
  preferredOnePerItem: uniqueIndex("item_suppliers_one_preferred_per_item_uniq")
    .on(t.companyId, t.itemId)
    .where(sql`preferred_supplier = true`),
}));

// ─── Item Bundle Components (PRO Extension #2 — Bundles / Kits) ──────────────
// When a parent item is a "bundle" (`items.is_bundle = true`), its child
// composition lives here: each row says "this many units of <child item>
// per 1 unit of <parent>". A unique index prevents the same child being
// listed twice on one parent. We do NOT enforce parent.is_bundle = true
// at the DB level — the route layer keeps the flag in sync (auto-flips
// to true when the first component is added, auto-flips to false when
// the last one is removed).
//
// Future work (deferred to a later batch): on sales-invoice posting,
// expand each bundle line into stock-deduction entries for its components.
// Kept out of this batch to avoid touching the sales posting code path.
export const itemBundleComponentsTable = pgTable("item_bundle_components", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  parentItemId: integer("parent_item_id").notNull().references(() => itemsTable.id, { onDelete: "cascade" }),
  childItemId:  integer("child_item_id").notNull().references(() => itemsTable.id, { onDelete: "cascade" }),
  qty:          numeric("qty", { precision: 14, scale: 4 }).notNull().default("1"),
  notes:        text("notes"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  // No duplicate child rows per (tenant, parent).
  parentChildUnique: uniqueIndex("item_bundle_components_parent_child_uniq")
    .on(t.companyId, t.parentItemId, t.childItemId),
}));

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

// ─── PRO Extension #8 — Item Currency Prices ─────────────────────────────────
// Per-item override prices in non-default currencies. The base costPrice/
// salePrice on `items` are always quoted in the company's default currency
// (typically SAR); rows here let an item also have a price in USD/EUR/AED/etc.
// The route enforces that you can NEVER add a row for the company's default
// currency (which would be ambiguous vs the base price columns) and that
// the currency must exist in this tenant. Sales/purchase forms can opt in
// to use these prices via a future "currency picker" — out of scope for
// this batch, but the data is here to drive it.
export const itemCurrencyPricesTable = pgTable("item_currency_prices", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  itemId:       integer("item_id").notNull().references(() => itemsTable.id, { onDelete: "cascade" }),
  // Stored as the currency `code` (e.g. "USD", "EUR") rather than an FK
  // to currencies.id, matching the convention already in use across
  // suppliers/purchasing/inventoryReceipts where currency_code is a text col.
  currencyCode: text("currency_code").notNull(),
  costPrice:    numeric("cost_price", { precision: 14, scale: 4 }).notNull().default("0"),
  salePrice:    numeric("sale_price", { precision: 14, scale: 4 }).notNull().default("0"),
  notes:        text("notes"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  // Prevent the same item having two rows for the same currency (the
  // route's app-level dup check is best-effort; this is the safety net).
  itemCurrencyUniq: uniqueIndex("item_currency_prices_item_curr_uniq")
    .on(t.companyId, t.itemId, t.currencyCode),
}));

// ─── PRO Extension #9 — Item Branch Stock ────────────────────────────────────
// Per-item per-branch quantity & reorder thresholds. The system already has
// `stock_balance` (per-item per-WAREHOUSE quantities) but branches and
// warehouses are different: a single branch can have multiple warehouses
// (e.g. main store + cold storage), and conversely some warehouses serve
// the whole company. This table is the lighter "branch view" — the qty
// here is the operator's read on what's at that branch (initially set
// from the warehouses inside the branch but not auto-synced — to keep the
// data lean and skip touching the stock-posting code path in this batch).
export const itemBranchStockTable = pgTable("item_branch_stock", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  itemId:       integer("item_id").notNull().references(() => itemsTable.id, { onDelete: "cascade" }),
  branchId:     integer("branch_id").notNull().references(() => branchesTable.id, { onDelete: "cascade" }),
  qty:          numeric("qty", { precision: 18, scale: 4 }).notNull().default("0"),
  reorderLevel: numeric("reorder_level", { precision: 14, scale: 4 }),
  maxLevel:     numeric("max_level", { precision: 14, scale: 4 }),
  notes:        text("notes"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  // One row per (item, branch) per tenant — UPSERT target.
  itemBranchUniq: uniqueIndex("item_branch_stock_item_branch_uniq")
    .on(t.companyId, t.itemId, t.branchId),
}));

// ─── PRO Extension #18 — Item BOM Steps ──────────────────────────────────────
// Manufacturing steps for a bundle/kit. Each step has a sequence #, a
// name, an optional duration, and labour + overhead costs. The total
// labor + overhead is added to the bundle's component cost (sum of
// children) to give a more accurate manufactured-cost figure. Only
// shown for items where isBundle=true (orthogonal to variants per
// Extension #20). Sequence is per-item, no DB unique on (item, seq) —
// the UI re-numbers freely on add/move/delete.
export const itemBomStepsTable = pgTable("item_bom_steps", {
  id:               serial("id").primaryKey(),
  companyId:        integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  itemId:           integer("item_id").notNull().references(() => itemsTable.id, { onDelete: "cascade" }),
  sequence:         integer("sequence").notNull().default(0),
  nameAr:           text("name_ar").notNull(),
  nameEn:           text("name_en"),
  durationMinutes:  integer("duration_minutes").default(0),
  laborCost:        numeric("labor_cost",    { precision: 14, scale: 4 }).notNull().default("0"),
  overheadCost:     numeric("overhead_cost", { precision: 14, scale: 4 }).notNull().default("0"),
  notes:            text("notes"),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
  updatedAt:        timestamp("updated_at").defaultNow().notNull(),
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
