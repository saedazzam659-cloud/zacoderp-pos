import {
  pgTable, serial, text, integer, boolean, timestamp, numeric, pgEnum,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { suppliersTable } from "./suppliers";
import { accountsTable } from "./accounts";
import { purchaseInvoicesTable } from "./purchasing";

export const goodsReceiptStatusEnum = pgEnum("goods_receipt_status", [
  "draft", "posted", "invoiced",
]);

export const goodsReceiptsTable = pgTable("goods_receipts", {
  id:                          serial("id").primaryKey(),
  companyId:                   integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:                    integer("branch_id"),
  docNumber:                   text("doc_number"),
  supplierInvoiceNumber:       text("supplier_invoice_number"),
  receiptDate:                 text("receipt_date").notNull(),
  supplierId:                  integer("supplier_id").references(() => suppliersTable.id),
  currencyCode:                text("currency_code").notNull().default("SAR"),
  exchangeRate:                numeric("exchange_rate", { precision: 15, scale: 6 }).notNull().default("1"),
  subtotal:                    numeric("subtotal",        { precision: 15, scale: 2 }).notNull().default("0"),
  vatAmount:                   numeric("vat_amount",      { precision: 15, scale: 2 }).notNull().default("0"),
  discountAmount:              numeric("discount_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  totalAmount:                 numeric("total_amount",    { precision: 15, scale: 2 }).notNull().default("0"),
  priceIncludesVat:            boolean("price_includes_vat").notNull().default(false),
  status:                      goodsReceiptStatusEnum("status").notNull().default("draft"),
  inventoryAccountId:          integer("inventory_account_id"),
  receivingClearingAccountId:  integer("receiving_clearing_account_id").references(() => accountsTable.id),
  journalEntryId:              integer("journal_entry_id"),
  linkedInvoiceId:             integer("linked_invoice_id").references(() => purchaseInvoicesTable.id, { onDelete: "set null" }),
  notes:                       text("notes"),
  // Audit: who created this receipt and who clicked /post
  createdById:                 integer("created_by_id"),
  postedById:                  integer("posted_by_id"),
  postedAt:                    timestamp("posted_at"),
  createdAt:                   timestamp("created_at").defaultNow().notNull(),
  updatedAt:                   timestamp("updated_at").defaultNow().notNull(),
});

export const goodsReceiptLinesTable = pgTable("goods_receipt_lines", {
  id:               serial("id").primaryKey(),
  receiptId:        integer("receipt_id").notNull().references(() => goodsReceiptsTable.id, { onDelete: "cascade" }),
  companyId:        integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  itemId:           integer("item_id"),
  itemName:         text("item_name").notNull(),
  itemCode:         text("item_code"),
  unit:             text("unit"),
  unitId:           integer("unit_id"),
  conversionFactor: numeric("conversion_factor", { precision: 15, scale: 6 }).default("1"),
  warehouseId:      integer("warehouse_id"),
  qty:              numeric("qty",        { precision: 15, scale: 4 }).notNull().default("1"),
  unitPrice:        numeric("unit_price", { precision: 15, scale: 4 }).notNull().default("0"),
  discount:         numeric("discount",   { precision: 5,  scale: 2 }).notNull().default("0"),
  vatRate:          numeric("vat_rate",   { precision: 5,  scale: 2 }).default("15"),
  lineTotal:        numeric("line_total", { precision: 15, scale: 2 }).notNull().default("0"),
  notes:            text("notes"),
});

export type GoodsReceipt     = typeof goodsReceiptsTable.$inferSelect;
export type GoodsReceiptLine = typeof goodsReceiptLinesTable.$inferSelect;
