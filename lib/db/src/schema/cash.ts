import {
  pgTable, serial, text, integer, boolean, timestamp, numeric, pgEnum,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";
import { accountsTable } from "./accounts";
import { currenciesTable } from "./currencies";
import { salesInvoicesTable } from "./sales";
import { purchaseInvoicesTable } from "./purchasing";

// ─── Enums ────────────────────────────────────────────────────────────────────
export const cashVoucherStatusEnum = pgEnum("cash_voucher_status", ["draft", "posted"]);
export const cashEntityTypeEnum    = pgEnum("cash_entity_type",   ["customer", "supplier", "other"]);
export const cashPaymentTypeEnum   = pgEnum("cash_payment_type",  ["cash", "bank"]);
export const cashTransferTypeEnum  = pgEnum("cash_transfer_type", ["cash_to_cash","cash_to_bank","bank_to_cash","bank_to_bank"]);

// ─── Cash Boxes (الخزن) ───────────────────────────────────────────────────────
export const cashBoxesTable = pgTable("cash_boxes", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:     integer("branch_id").references(() => branchesTable.id),
  code:         text("code").notNull(),
  nameAr:       text("name_ar").notNull(),
  nameEn:       text("name_en"),
  currencyId:   integer("currency_id").references(() => currenciesTable.id),
  accountId:    integer("account_id").references(() => accountsTable.id),
  minBalance:   numeric("min_balance", { precision: 15, scale: 2 }).default("0"),
  maxBalance:   numeric("max_balance", { precision: 15, scale: 2 }),
  isActive:     boolean("is_active").notNull().default(true),
  notes:        text("notes"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
});

// ─── Bank Accounts (حسابات بنكية) ─────────────────────────────────────────────
export const bankAccountsTable = pgTable("bank_accounts", {
  id:            serial("id").primaryKey(),
  companyId:     integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:      integer("branch_id").references(() => branchesTable.id),
  // Multi-branch link (نظام متعدد الفروع). When set, this is the source of
  // truth for branch ownership; the legacy single `branchId` column is kept
  // and mirrored to `branchIds[0]` for back-compat with cash-analytics
  // (which still groups by a single branch).
  branchIds:     integer("branch_ids").array(),
  code:          text("code").notNull(),
  nameAr:        text("name_ar").notNull(),
  nameEn:        text("name_en"),
  bankName:      text("bank_name"),
  bankNameEn:    text("bank_name_en"),
  accountNumber: text("account_number"),
  iban:          text("iban"),
  swiftCode:     text("swift_code"),
  currencyId:    integer("currency_id").references(() => currenciesTable.id),
  accountId:     integer("account_id").references(() => accountsTable.id),
  isActive:      boolean("is_active").notNull().default(true),
  notes:         text("notes"),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
});

// ─── Receipt Vouchers (سندات القبض) ───────────────────────────────────────────
export const receiptVouchersTable = pgTable("receipt_vouchers", {
  id:            serial("id").primaryKey(),
  companyId:     integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:      integer("branch_id").references(() => branchesTable.id),
  code:          text("code").notNull(),
  date:          text("date").notNull(),
  paymentType:   cashPaymentTypeEnum("payment_type").notNull().default("cash"),
  cashBoxId:     integer("cash_box_id").references(() => cashBoxesTable.id),
  bankAccountId: integer("bank_account_id").references(() => bankAccountsTable.id),
  entityType:    cashEntityTypeEnum("entity_type").notNull().default("customer"),
  entityId:      integer("entity_id"),
  entityName:    text("entity_name"),
  accountId:     integer("account_id").references(() => accountsTable.id),
  amount:        numeric("amount", { precision: 15, scale: 2 }).notNull().default("0"),
  currencyId:    integer("currency_id").references(() => currenciesTable.id),
  exchangeRate:  numeric("exchange_rate", { precision: 15, scale: 6 }).default("1"),
  refType:       text("ref_type"),
  refNumber:     text("ref_number"),
  // Optional FK to a sales invoice this receipt is settling. When set,
  // the sales-invoices listing surfaces a "paid via cash/bank" badge so
  // accountants can see at a glance which invoices were collected.
  salesInvoiceId: integer("sales_invoice_id").references(() => salesInvoicesTable.id, { onDelete: "set null" }),
  description:   text("description"),
  notes:         text("notes"),
  // Optional cost-center code propagated to JE lines on /post.
  costCenter:    text("cost_center"),
  status:        cashVoucherStatusEnum("status").notNull().default("draft"),
  salesRepId:    integer("sales_rep_id"),
  journalEntryId: integer("journal_entry_id"),
  // Manual (admin-created) session this voucher was recorded under, if any.
  sessionId:     integer("session_id"),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
});

// ─── Payment Vouchers (سندات الصرف) ───────────────────────────────────────────
export const paymentVouchersTable = pgTable("payment_vouchers", {
  id:            serial("id").primaryKey(),
  companyId:     integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:      integer("branch_id").references(() => branchesTable.id),
  code:          text("code").notNull(),
  date:          text("date").notNull(),
  paymentType:   cashPaymentTypeEnum("payment_type").notNull().default("cash"),
  cashBoxId:     integer("cash_box_id").references(() => cashBoxesTable.id),
  bankAccountId: integer("bank_account_id").references(() => bankAccountsTable.id),
  entityType:    cashEntityTypeEnum("entity_type").notNull().default("supplier"),
  entityId:      integer("entity_id"),
  entityName:    text("entity_name"),
  accountId:     integer("account_id").references(() => accountsTable.id),
  amount:        numeric("amount", { precision: 15, scale: 2 }).notNull().default("0"),
  currencyId:    integer("currency_id").references(() => currenciesTable.id),
  exchangeRate:  numeric("exchange_rate", { precision: 15, scale: 6 }).default("1"),
  refType:       text("ref_type"),
  refNumber:     text("ref_number"),
  // Optional FK to a purchase invoice this payment is settling. When set,
  // the purchase-invoices listing surfaces a "paid via cash/bank" badge so
  // accountants can see at a glance which invoices were paid out.
  purchaseInvoiceId: integer("purchase_invoice_id").references(() => purchaseInvoicesTable.id, { onDelete: "set null" }),
  description:   text("description"),
  notes:         text("notes"),
  // Optional cost-center code propagated to JE lines on /post.
  costCenter:    text("cost_center"),
  status:        cashVoucherStatusEnum("status").notNull().default("draft"),
  journalEntryId: integer("journal_entry_id"),
  // Manual (admin-created) session this voucher was recorded under, if any.
  sessionId:     integer("session_id"),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
});

// ─── Receipt Voucher Lines (بنود سند القبض) ──────────────────────────────────
// Multi-allocation model: one receipt voucher carries a single cash/bank
// treasury side and MANY allocation lines (each crediting an account —
// typically a customer receivable or income account). Receipt lines carry
// NO VAT (output VAT belongs on the sales tax invoice only). Legacy
// single-`amount` vouchers that predate this table keep posting unchanged.
export const receiptVoucherLinesTable = pgTable("receipt_voucher_lines", {
  id:             serial("id").primaryKey(),
  voucherId:      integer("voucher_id").notNull().references(() => receiptVouchersTable.id, { onDelete: "cascade" }),
  accountId:      integer("account_id").references(() => accountsTable.id),
  description:    text("description"),
  amount:         numeric("amount", { precision: 15, scale: 2 }).notNull().default("0"),
  costCenter:     text("cost_center"),
  branchId:       integer("branch_id").references(() => branchesTable.id),
  // Optional per-line link to the sales invoice this allocation settles.
  salesInvoiceId: integer("sales_invoice_id").references(() => salesInvoicesTable.id, { onDelete: "set null" }),
  sortOrder:      integer("sort_order").notNull().default(0),
});

// ─── Payment Voucher Lines (بنود سند الصرف) ──────────────────────────────────
// Same multi-allocation model as receipt lines but each line MAY carry its
// own input VAT (rate + amount + input-VAT account), so one payment voucher
// can record several different taxes at once. The VAT declaration report
// reads `taxAmount` here as an additive INPUT-VAT source.
export const paymentVoucherLinesTable = pgTable("payment_voucher_lines", {
  id:                serial("id").primaryKey(),
  voucherId:         integer("voucher_id").notNull().references(() => paymentVouchersTable.id, { onDelete: "cascade" }),
  accountId:         integer("account_id").references(() => accountsTable.id),
  description:       text("description"),
  amount:            numeric("amount", { precision: 15, scale: 2 }).notNull().default("0"),
  // Per-line VAT (input side). taxRate is informational; taxAmount drives
  // both the JE input-VAT line and the VAT declaration report.
  taxRate:           numeric("tax_rate",   { precision: 15, scale: 2 }).notNull().default("0"),
  taxAmount:         numeric("tax_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  taxAccountId:      integer("tax_account_id").references(() => accountsTable.id),
  costCenter:        text("cost_center"),
  branchId:          integer("branch_id").references(() => branchesTable.id),
  // Optional per-line link to the purchase invoice this allocation settles.
  purchaseInvoiceId: integer("purchase_invoice_id").references(() => purchaseInvoicesTable.id, { onDelete: "set null" }),
  // Per-line supplier tax metadata (entered via the ⋮ dialog). Captured when
  // NO header supplier is chosen so a consolidated voucher can still attribute
  // each tax line to its own supplier. These flow into the VAT declaration
  // report + tax account statement. Stored as text (invoiceDate is ISO YYYY-MM-DD).
  supplierName:          text("supplier_name"),
  supplierVatNumber:     text("supplier_vat_number"),
  supplierInvoiceNumber: text("supplier_invoice_number"),
  supplierInvoiceDate:   text("supplier_invoice_date"),
  sortOrder:         integer("sort_order").notNull().default(0),
});

// ─── Cash/Bank Transfers (التحويلات) ──────────────────────────────────────────
export const cashTransfersTable = pgTable("cash_transfers", {
  id:              serial("id").primaryKey(),
  companyId:       integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  code:            text("code").notNull(),
  date:            text("date").notNull(),
  transferType:    cashTransferTypeEnum("transfer_type").notNull().default("cash_to_bank"),
  fromCashBoxId:   integer("from_cash_box_id").references(() => cashBoxesTable.id),
  fromBankId:      integer("from_bank_id").references(() => bankAccountsTable.id),
  toCashBoxId:     integer("to_cash_box_id").references(() => cashBoxesTable.id),
  toBankId:        integer("to_bank_id").references(() => bankAccountsTable.id),
  amount:          numeric("amount", { precision: 15, scale: 2 }).notNull().default("0"),
  currencyId:      integer("currency_id").references(() => currenciesTable.id),
  exchangeRate:    numeric("exchange_rate", { precision: 15, scale: 6 }).default("1"),
  description:     text("description"),
  notes:           text("notes"),
  status:          cashVoucherStatusEnum("status").notNull().default("draft"),
  createdAt:       timestamp("created_at").defaultNow().notNull(),
});
