import {
  pgTable, serial, text, integer, boolean, timestamp, numeric, pgEnum,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";
import { accountsTable } from "./accounts";
import { currenciesTable } from "./currencies";

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
  description:   text("description"),
  notes:         text("notes"),
  status:        cashVoucherStatusEnum("status").notNull().default("draft"),
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
  description:   text("description"),
  notes:         text("notes"),
  status:        cashVoucherStatusEnum("status").notNull().default("draft"),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
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
