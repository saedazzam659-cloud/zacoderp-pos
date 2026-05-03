import {
  pgTable, serial, text, integer, numeric, timestamp, boolean, pgEnum, date,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";
import { customersTable } from "./customers";

// ─── Enums ──────────────────────────────────────────────────────────────────
export const installmentRiskEnum = pgEnum("installment_risk", [
  "low", "medium", "high",
]);
export const installmentContractStatusEnum = pgEnum("installment_contract_status", [
  "draft", "pending", "approved", "rejected", "active", "completed", "defaulted", "cancelled",
]);
export const installmentRowStatusEnum = pgEnum("installment_row_status", [
  "pending", "paid", "overdue", "partial",
]);
export const installmentPaymentMethodEnum = pgEnum("installment_payment_method", [
  "cash", "transfer", "card", "wallet",
]);

// ─── Per-company settings ───────────────────────────────────────────────────
export const installmentSettingsTable = pgTable("installment_settings", {
  companyId:           integer("company_id").primaryKey().references(() => companiesTable.id, { onDelete: "cascade" }),
  minScoreApproval:    integer("min_score_approval").notNull().default(80),
  minScoreReview:      integer("min_score_review").notNull().default(60),
  defaultInterestRate: numeric("default_interest_rate", { precision: 6, scale: 3 }).notNull().default("12"),
  maxInstallments:     integer("max_installments").notNull().default(36),
  aiEnabled:           boolean("ai_enabled").notNull().default(true),
  notes:               text("notes"),
  updatedAt:           timestamp("updated_at").defaultNow().notNull(),
});

export type InstallmentSettings       = typeof installmentSettingsTable.$inferSelect;
export type InsertInstallmentSettings = typeof installmentSettingsTable.$inferInsert;

// ─── Contracts ──────────────────────────────────────────────────────────────
export const installmentContractsTable = pgTable("installment_contracts", {
  id:                    serial("id").primaryKey(),
  companyId:             integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:              integer("branch_id").references(() => branchesTable.id, { onDelete: "set null" }),
  contractNumber:        text("contract_number").notNull(),

  // Customer snapshot — optional FK + denormalized fields so contracts
  // remain readable even if the customer record is later edited/deleted.
  customerId:            integer("customer_id").references(() => customersTable.id, { onDelete: "set null" }),
  customerName:          text("customer_name").notNull(),
  nationalId:            text("national_id"),
  occupation:            text("occupation"),
  monthlyIncome:         numeric("monthly_income", { precision: 15, scale: 2 }).notNull().default("0"),
  monthlyObligations:    numeric("monthly_obligations", { precision: 15, scale: 2 }).notNull().default("0"),
  age:                   integer("age"),
  phone:                 text("phone"),
  address:               text("address"),

  // Product / service
  productDescription:    text("product_description").notNull(),

  // Financial terms
  cashPrice:             numeric("cash_price",       { precision: 15, scale: 2 }).notNull().default("0"),
  downPayment:           numeric("down_payment",     { precision: 15, scale: 2 }).notNull().default("0"),
  financedAmount:        numeric("financed_amount",  { precision: 15, scale: 2 }).notNull().default("0"),
  interestRate:          numeric("interest_rate",    { precision: 6,  scale: 3 }).notNull().default("0"),
  totalInterest:         numeric("total_interest",   { precision: 15, scale: 2 }).notNull().default("0"),
  installmentCount:      integer("installment_count").notNull().default(1),
  installmentAmount:     numeric("installment_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  totalAmount:           numeric("total_amount",     { precision: 15, scale: 2 }).notNull().default("0"),
  firstInstallmentDate:  date("first_installment_date").notNull(),

  // AI risk
  creditScore:           integer("credit_score").default(0),
  riskLevel:             installmentRiskEnum("risk_level").notNull().default("medium"),
  defaultProbability:    numeric("default_probability", { precision: 5, scale: 2 }).default("0"),
  aiAnalysis:            text("ai_analysis"),

  // Workflow
  status:                installmentContractStatusEnum("status").notNull().default("draft"),
  approvedBy:            text("approved_by"),
  approvedAt:            timestamp("approved_at"),
  rejectedReason:        text("rejected_reason"),

  notes:                 text("notes"),
  createdBy:             text("created_by"),
  createdAt:             timestamp("created_at").defaultNow().notNull(),
  updatedAt:             timestamp("updated_at").defaultNow().notNull(),
});

export type InstallmentContract       = typeof installmentContractsTable.$inferSelect;
export type InsertInstallmentContract = typeof installmentContractsTable.$inferInsert;

// ─── Schedule rows ──────────────────────────────────────────────────────────
export const installmentsTable = pgTable("installments", {
  id:                serial("id").primaryKey(),
  contractId:        integer("contract_id").notNull().references(() => installmentContractsTable.id, { onDelete: "cascade" }),
  companyId:         integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  installmentNumber: integer("installment_number").notNull(),
  dueDate:           date("due_date").notNull(),
  amount:            numeric("amount",      { precision: 15, scale: 2 }).notNull().default("0"),
  paidAmount:        numeric("paid_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  paidAt:            timestamp("paid_at"),
  status:            installmentRowStatusEnum("status").notNull().default("pending"),
  notes:             text("notes"),
  createdAt:         timestamp("created_at").defaultNow().notNull(),
});

export type InstallmentRow       = typeof installmentsTable.$inferSelect;
export type InsertInstallmentRow = typeof installmentsTable.$inferInsert;

// ─── Payment ledger ─────────────────────────────────────────────────────────
export const installmentPaymentsTable = pgTable("installment_payments", {
  id:             serial("id").primaryKey(),
  companyId:      integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  contractId:     integer("contract_id").notNull().references(() => installmentContractsTable.id, { onDelete: "cascade" }),
  installmentId:  integer("installment_id").references(() => installmentsTable.id, { onDelete: "set null" }),
  amount:         numeric("amount", { precision: 15, scale: 2 }).notNull().default("0"),
  paymentMethod:  installmentPaymentMethodEnum("payment_method").notNull().default("cash"),
  paidAt:         timestamp("paid_at").defaultNow().notNull(),
  receivedBy:     text("received_by"),
  reference:      text("reference"),
  notes:          text("notes"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
});

export type InstallmentPayment       = typeof installmentPaymentsTable.$inferSelect;
export type InsertInstallmentPayment = typeof installmentPaymentsTable.$inferInsert;
