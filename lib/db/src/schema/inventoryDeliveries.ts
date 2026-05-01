import {
  pgTable, serial, text, integer, boolean, timestamp, numeric, pgEnum,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { customersTable } from "./customers";
import { accountsTable } from "./accounts";
import { salesInvoicesTable } from "./sales";

export const goodsDeliveryStatusEnum = pgEnum("goods_delivery_status", [
  "draft", "posted", "invoiced",
]);

export const goodsDeliveriesTable = pgTable("goods_deliveries", {
  id:                          serial("id").primaryKey(),
  companyId:                   integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:                    integer("branch_id"),
  docNumber:                   text("doc_number"),
  customerOrderNumber:         text("customer_order_number"),
  deliveryDate:                text("delivery_date").notNull(),
  customerId:                  integer("customer_id").references(() => customersTable.id),
  currencyCode:                text("currency_code").notNull().default("SAR"),
  exchangeRate:                numeric("exchange_rate", { precision: 15, scale: 6 }).notNull().default("1"),
  subtotal:                    numeric("subtotal",        { precision: 15, scale: 2 }).notNull().default("0"),
  vatAmount:                   numeric("vat_amount",      { precision: 15, scale: 2 }).notNull().default("0"),
  discountAmount:              numeric("discount_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  totalAmount:                 numeric("total_amount",    { precision: 15, scale: 2 }).notNull().default("0"),
  priceIncludesVat:            boolean("price_includes_vat").notNull().default(false),
  status:                      goodsDeliveryStatusEnum("status").notNull().default("draft"),
  inventoryAccountId:          integer("inventory_account_id"),
  deliveryClearingAccountId:   integer("delivery_clearing_account_id").references(() => accountsTable.id),
  journalEntryId:              integer("journal_entry_id"),
  linkedInvoiceId:             integer("linked_invoice_id").references(() => salesInvoicesTable.id, { onDelete: "set null" }),
  notes:                       text("notes"),
  createdAt:                   timestamp("created_at").defaultNow().notNull(),
  updatedAt:                   timestamp("updated_at").defaultNow().notNull(),
});

export const goodsDeliveryLinesTable = pgTable("goods_delivery_lines", {
  id:               serial("id").primaryKey(),
  deliveryId:       integer("delivery_id").notNull().references(() => goodsDeliveriesTable.id, { onDelete: "cascade" }),
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

export type GoodsDelivery     = typeof goodsDeliveriesTable.$inferSelect;
export type GoodsDeliveryLine = typeof goodsDeliveryLinesTable.$inferSelect;
