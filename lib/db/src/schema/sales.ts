import {
  pgTable, serial, text, integer, timestamp, numeric, pgEnum, boolean,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { customersTable } from "./customers";
import { accountsTable } from "./accounts";
import { salesRepsTable } from "./salesReps";
import { offersTable } from "./offers";

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
  bankAccountId:  integer("bank_account_id"),
  currencyCode:   text("currency_code").notNull().default("SAR"),
  exchangeRate:   numeric("exchange_rate", { precision: 15, scale: 6 }).notNull().default("1"),
  subtotal:       numeric("subtotal",        { precision: 15, scale: 2 }).notNull().default("0"),
  vatAmount:      numeric("vat_amount",      { precision: 15, scale: 2 }).notNull().default("0"),
  discountAmount: numeric("discount_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  totalAmount:    numeric("total_amount",    { precision: 15, scale: 2 }).notNull().default("0"),
  priceIncludesVat: boolean("price_includes_vat").notNull().default(false),
  status:         salesInvoiceStatusEnum("status").notNull().default("draft"),
  notes:          text("notes"),
  // Accounts used to build the journal entry on posting
  cogsAccountId:      integer("cogs_account_id").references(() => accountsTable.id),
  inventoryAccountId: integer("inventory_account_id").references(() => accountsTable.id),
  salesAccountId:     integer("sales_account_id").references(() => accountsTable.id),
  taxAccountId:       integer("tax_account_id").references(() => accountsTable.id),
  discountAccountId:  integer("discount_account_id").references(() => accountsTable.id),
  journalEntryId:     integer("journal_entry_id"),
  // ZATCA submission tracking ("pending" | "approved" | "rejected")
  zatcaStatus:           text("zatca_status").default("pending"),
  zatcaSubmittedAt:      timestamp("zatca_submitted_at"),
  zatcaUuid:             text("zatca_uuid"),
  zatcaResponseCode:     text("zatca_response_code"),
  zatcaErrorMessages:    text("zatca_error_messages"),
  zatcaWarningMessages:  text("zatca_warning_messages"),
  zatcaAiSuggestion:     text("zatca_ai_suggestion"),
  posSessionId:   integer("pos_session_id"),
  // Manual (admin-created) session this invoice was recorded under, if any.
  // Soft reference to sessions.id (kept nullable; no FK to allow purging).
  sessionId:      integer("session_id"),
  createdById:    integer("created_by_id"),
  // Sales rep + commission snapshot (commissionPct copied from rep at save time
  // so historical invoices keep their original % even if the rep's % changes)
  salesRepId:        integer("sales_rep_id"),
  commissionPct:     numeric("commission_pct",     { precision: 6,  scale: 3 }).notNull().default("0"),
  commissionAmount:  numeric("commission_amount",  { precision: 15, scale: 2 }).notNull().default("0"),
  // Header-level promotion that produced any document-wide discount
  // (percentage_total / fixed_total). NULL when no doc-level promo applied or
  // when only line-level promos (line_pricing / buy_x_get_y) were used.
  // SET NULL on offer delete so historical invoices survive a deleted offer.
  documentOfferId:   integer("document_offer_id").references(() => offersTable.id, { onDelete: "set null" }),
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
  // Per-line promotion that influenced this line's price/discount
  // (line_pricing or buy_x_get_y). NULL when no offer applied to this line.
  appliedOfferId: integer("applied_offer_id").references(() => offersTable.id, { onDelete: "set null" }),
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
  bankAccountId: integer("bank_account_id"),
  currencyCode: text("currency_code").notNull().default("SAR"),
  exchangeRate: numeric("exchange_rate", { precision: 15, scale: 6 }).notNull().default("1"),
  totalAmount:  numeric("total_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  vatAmount:    numeric("vat_amount",   { precision: 15, scale: 2 }).notNull().default("0"),
  discountAmount: numeric("discount_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  priceIncludesVat: boolean("price_includes_vat").notNull().default(false),
  status:       text("status").notNull().default("draft"),
  notes:        text("notes"),
  // Manual (admin-created) session this return was recorded under, if any.
  sessionId:    integer("session_id"),
  salesRepId:         integer("sales_rep_id").references(() => salesRepsTable.id),
  cogsAccountId:      integer("cogs_account_id").references(() => accountsTable.id),
  inventoryAccountId: integer("inventory_account_id").references(() => accountsTable.id),
  salesAccountId:     integer("sales_account_id").references(() => accountsTable.id),
  taxAccountId:       integer("tax_account_id").references(() => accountsTable.id),
  discountAccountId:  integer("discount_account_id").references(() => accountsTable.id),
  journalEntryId:     integer("journal_entry_id"),
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
  discount:    numeric("discount",   { precision: 5,  scale: 2 }).notNull().default("0"),
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
  priceIncludesVat: boolean("price_includes_vat").notNull().default(false),
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

// ─── Sales Orders (أوامر البيع) ──────────────────────────────────────────────
// Pre-invoice commitment document. Has ZERO financial / accounting / stock
// side-effects on save — orders never touch journal_entries, stock_ledger,
// receipt_vouchers, or ZATCA. They only become "real" once converted to a
// sales invoice (which then runs the normal posting flow).
export const salesOrderStatusEnum = pgEnum("sales_order_status", [
  "draft", "confirmed", "cancelled", "converted",
]);

export const salesOrdersTable = pgTable("sales_orders", {
  id:                   serial("id").primaryKey(),
  companyId:            integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:             integer("branch_id"),
  docNumber:            text("doc_number"),
  orderDate:            text("order_date").notNull(),
  expectedDeliveryDate: text("expected_delivery_date"),
  customerId:           integer("customer_id").references(() => customersTable.id),
  // Payment type + cash/bank account ids are stored INFORMATIONALLY only
  // (so the future converted invoice can pre-fill these). Never used to
  // post a receipt voucher or journal entry from the order itself.
  paymentType:          text("payment_type").notNull().default("credit"),
  cashBoxId:            integer("cash_box_id"),
  bankAccountId:        integer("bank_account_id"),
  salesRepId:           integer("sales_rep_id"),
  currencyCode:         text("currency_code").notNull().default("SAR"),
  exchangeRate:         numeric("exchange_rate", { precision: 15, scale: 6 }).notNull().default("1"),
  subtotal:             numeric("subtotal",        { precision: 15, scale: 2 }).notNull().default("0"),
  vatAmount:            numeric("vat_amount",      { precision: 15, scale: 2 }).notNull().default("0"),
  discountAmount:       numeric("discount_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  totalAmount:          numeric("total_amount",    { precision: 15, scale: 2 }).notNull().default("0"),
  priceIncludesVat:     boolean("price_includes_vat").notNull().default(false),
  status:               salesOrderStatusEnum("status").notNull().default("draft"),
  convertedInvoiceId:   integer("converted_invoice_id").references(() => salesInvoicesTable.id),
  createdById:          integer("created_by_id"),
  notes:                text("notes"),
  createdAt:            timestamp("created_at").defaultNow().notNull(),
  updatedAt:            timestamp("updated_at").defaultNow().notNull(),
});

export const salesOrderLinesTable = pgTable("sales_order_lines", {
  id:               serial("id").primaryKey(),
  orderId:          integer("order_id").notNull().references(() => salesOrdersTable.id, { onDelete: "cascade" }),
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
  discount:         numeric("discount",   { precision: 15, scale: 2 }).default("0"),
  vatRate:          numeric("vat_rate",   { precision: 5,  scale: 2 }).default("15"),
  lineTotal:        numeric("line_total", { precision: 15, scale: 2 }).notNull().default("0"),
  notes:            text("notes"),
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
