import {
  pgTable, serial, text, integer, timestamp, numeric, pgEnum,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { customersTable } from "./customers";
import { accountsTable } from "./accounts";

// ─── Sales Invoices ──────────────────────────────────────────────────────────
export const salesInvoiceStatusEnum = pgEnum("sales_invoice_status", [
  "draft", "posted", "cancelled",
]);

export const salesInvoicesTable = pgTable("sales_invoices", {
  id:             serial("id").primaryKey(),
  companyId:      integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:       integer("branch_id"),
  docNumber:      text("doc_number"),
  invoiceDate:    text("invoice_date").notNull(),
  customerId:     integer("customer_id").references(() => customersTable.id),
  paymentType:    text("payment_type").notNull().default("credit"),
  cashBoxId:      integer("cash_box_id"),
  currencyCode:   text("currency_code").notNull().default("SAR"),
  exchangeRate:   numeric("exchange_rate", { precision: 15, scale: 6 }).notNull().default("1"),
  subtotal:       numeric("subtotal",        { precision: 15, scale: 2 }).notNull().default("0"),
  vatAmount:      numeric("vat_amount",      { precision: 15, scale: 2 }).notNull().default("0"),
  discountAmount: numeric("discount_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  totalAmount:    numeric("total_amount",    { precision: 15, scale: 2 }).notNull().default("0"),
  status:         salesInvoiceStatusEnum("status").notNull().default("draft"),
  notes:          text("notes"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
});

export const salesInvoiceLinesTable = pgTable("sales_invoice_lines", {
  id:          serial("id").primaryKey(),
  invoiceId:   integer("invoice_id").notNull().references(() => salesInvoicesTable.id, { onDelete: "cascade" }),
  companyId:   integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  itemId:      integer("item_id"),
  itemName:    text("item_name").notNull(),
  itemCode:    text("item_code"),
  unit:        text("unit"),
  unitId:      integer("unit_id"),
  conversionFactor: numeric("conversion_factor", { precision: 15, scale: 6 }).default("1"),
  warehouseId: integer("warehouse_id"),
  qty:         numeric("qty",        { precision: 15, scale: 4 }).notNull().default("1"),
  unitPrice:   numeric("unit_price", { precision: 15, scale: 4 }).notNull().default("0"),
  discount:    numeric("discount",   { precision: 15, scale: 2 }).default("0"),
  vatRate:     numeric("vat_rate",   { precision: 5,  scale: 2 }).default("15"),
  lineTotal:   numeric("line_total", { precision: 15, scale: 2 }).notNull().default("0"),
  notes:       text("notes"),
});

// ─── Sales Returns ───────────────────────────────────────────────────────────
export const salesReturnsTable = pgTable("sales_returns", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:     integer("branch_id"),
  docNumber:    text("doc_number"),
  returnDate:   text("return_date").notNull(),
  customerId:   integer("customer_id").references(() => customersTable.id),
  invoiceId:    integer("invoice_id").references(() => salesInvoicesTable.id),
  paymentType:  text("payment_type").notNull().default("credit"),
  cashBoxId:    integer("cash_box_id"),
  currencyCode: text("currency_code").notNull().default("SAR"),
  exchangeRate: numeric("exchange_rate", { precision: 15, scale: 6 }).notNull().default("1"),
  totalAmount:  numeric("total_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  vatAmount:    numeric("vat_amount",   { precision: 15, scale: 2 }).notNull().default("0"),
  status:       text("status").notNull().default("draft"),
  notes:        text("notes"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().notNull(),
});

export const salesReturnLinesTable = pgTable("sales_return_lines", {
  id:          serial("id").primaryKey(),
  returnId:    integer("return_id").notNull().references(() => salesReturnsTable.id, { onDelete: "cascade" }),
  companyId:   integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  itemId:      integer("item_id"),
  itemName:    text("item_name").notNull(),
  itemCode:    text("item_code"),
  unit:        text("unit"),
  unitId:      integer("unit_id"),
  conversionFactor: numeric("conversion_factor", { precision: 15, scale: 6 }).default("1"),
  warehouseId: integer("warehouse_id"),
  qty:         numeric("qty",        { precision: 15, scale: 4 }).notNull().default("1"),
  unitPrice:   numeric("unit_price", { precision: 15, scale: 4 }).notNull().default("0"),
  vatRate:     numeric("vat_rate",   { precision: 5,  scale: 2 }).default("15"),
  lineTotal:   numeric("line_total", { precision: 15, scale: 2 }).notNull().default("0"),
  notes:       text("notes"),
});

// ─── Sales Quotations ────────────────────────────────────────────────────────
export const salesQuotationStatusEnum = pgEnum("sales_quotation_status", [
  "draft", "sent", "accepted", "rejected", "converted",
]);

export const salesQuotationsTable = pgTable("sales_quotations", {
  id:             serial("id").primaryKey(),
  companyId:      integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  docNumber:      text("doc_number"),
  quotationDate:  text("quotation_date").notNull(),
  validUntil:     text("valid_until"),
  customerId:     integer("customer_id").references(() => customersTable.id),
  currencyCode:   text("currency_code").notNull().default("SAR"),
  exchangeRate:   numeric("exchange_rate", { precision: 15, scale: 6 }).notNull().default("1"),
  subtotal:       numeric("subtotal",        { precision: 15, scale: 2 }).notNull().default("0"),
  vatAmount:      numeric("vat_amount",      { precision: 15, scale: 2 }).notNull().default("0"),
  discountAmount: numeric("discount_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  totalAmount:    numeric("total_amount",    { precision: 15, scale: 2 }).notNull().default("0"),
  status:         salesQuotationStatusEnum("status").notNull().default("draft"),
  convertedInvoiceId: integer("converted_invoice_id").references(() => salesInvoicesTable.id),
  notes:          text("notes"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
});

export const salesQuotationLinesTable = pgTable("sales_quotation_lines", {
  id:          serial("id").primaryKey(),
  quotationId: integer("quotation_id").notNull().references(() => salesQuotationsTable.id, { onDelete: "cascade" }),
  companyId:   integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  itemId:      integer("item_id"),
  itemName:    text("item_name").notNull(),
  itemCode:    text("item_code"),
  unit:        text("unit"),
  unitId:      integer("unit_id"),
  qty:         numeric("qty",        { precision: 15, scale: 4 }).notNull().default("1"),
  unitPrice:   numeric("unit_price", { precision: 15, scale: 4 }).notNull().default("0"),
  discount:    numeric("discount",   { precision: 15, scale: 2 }).default("0"),
  vatRate:     numeric("vat_rate",   { precision: 5,  scale: 2 }).default("15"),
  lineTotal:   numeric("line_total", { precision: 15, scale: 2 }).notNull().default("0"),
  notes:       text("notes"),
});

// ─── Customer Settlements ────────────────────────────────────────────────────
export const customerSettlementsTable = pgTable("customer_settlements", {
  id:             serial("id").primaryKey(),
  companyId:      integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  docNumber:      text("doc_number"),
  settlementDate: text("settlement_date").notNull(),
  customerId:     integer("customer_id").references(() => customersTable.id),
  paymentMethod:  text("payment_method").notNull().default("bank"),
  accountId:      integer("account_id").references(() => accountsTable.id),
  amount:         numeric("amount", { precision: 15, scale: 2 }).notNull().default("0"),
  currencyCode:   text("currency_code").notNull().default("SAR"),
  exchangeRate:   numeric("exchange_rate", { precision: 15, scale: 6 }).notNull().default("1"),
  status:         text("status").notNull().default("draft"),
  notes:          text("notes"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
});

export type SalesInvoice       = typeof salesInvoicesTable.$inferSelect;
export type SalesInvoiceLine   = typeof salesInvoiceLinesTable.$inferSelect;
export type SalesReturn        = typeof salesReturnsTable.$inferSelect;
export type SalesReturnLine    = typeof salesReturnLinesTable.$inferSelect;
export type SalesQuotation     = typeof salesQuotationsTable.$inferSelect;
export type SalesQuotationLine = typeof salesQuotationLinesTable.$inferSelect;
export type CustomerSettlement = typeof customerSettlementsTable.$inferSelect;
