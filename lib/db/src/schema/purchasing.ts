import {
  pgTable, serial, text, integer, boolean, timestamp, numeric, pgEnum,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { suppliersTable } from "./suppliers";
import { accountsTable } from "./accounts";

// ─── Supplier Groups ────────────────────────────────────────────────────────
export const supplierGroupsTable = pgTable("supplier_groups", {
  id:              serial("id").primaryKey(),
  companyId:       integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  code:            text("code").notNull(),
  nameAr:          text("name_ar").notNull(),
  nameEn:          text("name_en"),
  discountPercent: numeric("discount_percent", { precision: 5, scale: 2 }).default("0"),
  notes:           text("notes"),
  isActive:        boolean("is_active").notNull().default(true),
  createdAt:       timestamp("created_at").defaultNow().notNull(),
});

// ─── Letters of Credit (LC) ─────────────────────────────────────────────────
export const lcStatusEnum = pgEnum("lc_status", ["open", "partial", "closed"]);

export const lettersOfCreditTable = pgTable("letters_of_credit", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  lcNumber:     text("lc_number").notNull(),
  lcDate:       text("lc_date").notNull(),
  supplierId:   integer("supplier_id").references(() => suppliersTable.id),
  bankName:     text("bank_name"),
  currencyCode: text("currency_code").notNull().default("SAR"),
  totalAmount:  numeric("total_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  usedAmount:   numeric("used_amount",  { precision: 15, scale: 2 }).notNull().default("0"),
  status:       lcStatusEnum("status").notNull().default("open"),
  notes:        text("notes"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().notNull(),
});

// ─── LC Expenses ─────────────────────────────────────────────────────────────
export const lcExpensesTable = pgTable("lc_expenses", {
  id:           serial("id").primaryKey(),
  lcId:         integer("lc_id").notNull().references(() => lettersOfCreditTable.id, { onDelete: "cascade" }),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  expenseType:  text("expense_type").notNull(),
  accountId:    integer("account_id").references(() => accountsTable.id),
  amount:       numeric("amount", { precision: 15, scale: 2 }).notNull().default("0"),
  currencyCode: text("currency_code").notNull().default("SAR"),
  notes:        text("notes"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
});

// ─── Distribution method enum ─────────────────────────────────────────────────
export const distributionMethodEnum = pgEnum("distribution_method", [
  "qty", "value", "weight", "manual",
]);

// ─── Purchase Invoices ───────────────────────────────────────────────────────
export const purchaseInvoiceStatusEnum = pgEnum("purchase_invoice_status", [
  "draft", "posted", "cancelled",
]);

export const purchaseInvoicesTable = pgTable("purchase_invoices", {
  id:                   serial("id").primaryKey(),
  companyId:            integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:             integer("branch_id"),
  docNumber:            text("doc_number"),
  invoiceDate:          text("invoice_date").notNull(),
  supplierId:           integer("supplier_id").references(() => suppliersTable.id),
  paymentType:          text("payment_type").notNull().default("credit"),
  cashBoxId:            integer("cash_box_id"),
  currencyCode:         text("currency_code").notNull().default("SAR"),
  exchangeRate:         numeric("exchange_rate", { precision: 15, scale: 6 }).notNull().default("1"),
  lcId:                 integer("lc_id").references(() => lettersOfCreditTable.id),
  distributionMethod:   distributionMethodEnum("distribution_method").default("value"),
  subtotal:             numeric("subtotal",     { precision: 15, scale: 2 }).notNull().default("0"),
  vatAmount:            numeric("vat_amount",   { precision: 15, scale: 2 }).notNull().default("0"),
  discountAmount:       numeric("discount_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  totalExpensesLoaded:  numeric("total_expenses_loaded", { precision: 15, scale: 2 }).notNull().default("0"),
  totalAmount:          numeric("total_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  status:               purchaseInvoiceStatusEnum("status").notNull().default("draft"),
  notes:                text("notes"),
  createdAt:            timestamp("created_at").defaultNow().notNull(),
  updatedAt:            timestamp("updated_at").defaultNow().notNull(),
});

// ─── Purchase Invoice Lines ──────────────────────────────────────────────────
export const purchaseInvoiceLinesTable = pgTable("purchase_invoice_lines", {
  id:              serial("id").primaryKey(),
  invoiceId:       integer("invoice_id").notNull().references(() => purchaseInvoicesTable.id, { onDelete: "cascade" }),
  companyId:       integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  itemId:          integer("item_id"),
  itemName:        text("item_name").notNull(),
  itemCode:        text("item_code"),
  unit:            text("unit"),
  unitId:          integer("unit_id"),
  qty:             numeric("qty",        { precision: 15, scale: 4 }).notNull().default("1"),
  weight:          numeric("weight",     { precision: 15, scale: 4 }).default("0"),
  unitPrice:       numeric("unit_price", { precision: 15, scale: 4 }).notNull().default("0"),
  discount:        numeric("discount",   { precision: 15, scale: 2 }).default("0"),
  vatRate:         numeric("vat_rate",   { precision: 5,  scale: 2 }).default("15"),
  lineTotal:       numeric("line_total", { precision: 15, scale: 2 }).notNull().default("0"),
  expenseShare:    numeric("expense_share", { precision: 15, scale: 2 }).default("0"),
  finalCost:       numeric("final_cost",    { precision: 15, scale: 2 }).default("0"),
  accountId:       integer("account_id").references(() => accountsTable.id),
  warehouseId:     integer("warehouse_id"),
  notes:           text("notes"),
});

// ─── Purchase Returns ────────────────────────────────────────────────────────
export const purchaseReturnsTable = pgTable("purchase_returns", {
  id:            serial("id").primaryKey(),
  companyId:     integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:      integer("branch_id"),
  docNumber:     text("doc_number"),
  returnDate:    text("return_date").notNull(),
  supplierId:    integer("supplier_id").references(() => suppliersTable.id),
  invoiceId:     integer("invoice_id").references(() => purchaseInvoicesTable.id),
  paymentType:   text("payment_type").notNull().default("credit"),
  cashBoxId:     integer("cash_box_id"),
  currencyCode:  text("currency_code").notNull().default("SAR"),
  exchangeRate:  numeric("exchange_rate", { precision: 15, scale: 6 }).notNull().default("1"),
  totalAmount:   numeric("total_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  vatAmount:     numeric("vat_amount",   { precision: 15, scale: 2 }).notNull().default("0"),
  status:        text("status").notNull().default("draft"),
  notes:         text("notes"),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
  updatedAt:     timestamp("updated_at").defaultNow().notNull(),
});

export const purchaseReturnLinesTable = pgTable("purchase_return_lines", {
  id:          serial("id").primaryKey(),
  returnId:    integer("return_id").notNull().references(() => purchaseReturnsTable.id, { onDelete: "cascade" }),
  companyId:   integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  itemId:      integer("item_id"),
  itemName:    text("item_name").notNull(),
  itemCode:    text("item_code"),
  unit:        text("unit"),
  unitId:      integer("unit_id"),
  warehouseId: integer("warehouse_id"),
  qty:         numeric("qty",        { precision: 15, scale: 4 }).notNull().default("1"),
  unitPrice:   numeric("unit_price", { precision: 15, scale: 4 }).notNull().default("0"),
  vatRate:     numeric("vat_rate",   { precision: 5,  scale: 2 }).default("15"),
  lineTotal:   numeric("line_total", { precision: 15, scale: 2 }).notNull().default("0"),
  notes:       text("notes"),
});

// ─── Supplier Settlements ────────────────────────────────────────────────────
export const supplierSettlementsTable = pgTable("supplier_settlements", {
  id:            serial("id").primaryKey(),
  companyId:     integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  docNumber:     text("doc_number"),
  settlementDate: text("settlement_date").notNull(),
  supplierId:    integer("supplier_id").references(() => suppliersTable.id),
  paymentMethod: text("payment_method").notNull().default("bank"),
  accountId:     integer("account_id").references(() => accountsTable.id),
  amount:        numeric("amount", { precision: 15, scale: 2 }).notNull().default("0"),
  currencyCode:  text("currency_code").notNull().default("SAR"),
  exchangeRate:  numeric("exchange_rate", { precision: 15, scale: 6 }).notNull().default("1"),
  status:        text("status").notNull().default("draft"),
  notes:         text("notes"),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
  updatedAt:     timestamp("updated_at").defaultNow().notNull(),
});

export type SupplierGroup        = typeof supplierGroupsTable.$inferSelect;
export type LetterOfCredit       = typeof lettersOfCreditTable.$inferSelect;
export type LcExpense            = typeof lcExpensesTable.$inferSelect;
export type PurchaseInvoice      = typeof purchaseInvoicesTable.$inferSelect;
export type PurchaseInvoiceLine  = typeof purchaseInvoiceLinesTable.$inferSelect;
export type PurchaseReturn       = typeof purchaseReturnsTable.$inferSelect;
export type SupplierSettlement   = typeof supplierSettlementsTable.$inferSelect;
