// ─────────────────────────────────────────────────────────────────────────
// Fixed Assets module — Categories, Assets, Maintenance, Transfers,
// Depreciation runs, and Disposals. Multi-company scoped with branch +
// cost-center references. Includes purchase, technical, depreciation,
// and insurance fields plus AI risk metadata.
// ─────────────────────────────────────────────────────────────────────────
import {
  pgTable, serial, text, integer, numeric, timestamp, boolean, pgEnum, date,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";
import { costCentersTable } from "./costCenters";

export const faStatusEnum = pgEnum("fa_status", [
  "active", "in_maintenance", "transferred", "sold", "scrapped", "fully_depreciated",
]);
export const faMaintenanceTypeEnum = pgEnum("fa_maintenance_type", [
  "periodic", "emergency", "preventive", "corrective",
]);
export const faDepreciationMethodEnum = pgEnum("fa_depreciation_method", [
  "straight_line", "declining_balance", "units_of_production",
]);
export const faDisposalTypeEnum = pgEnum("fa_disposal_type", [
  "sale", "scrap", "full_depreciation", "write_off",
]);

// 1) Categories (سيارات، معدات، أثاث، حاسبات، مباني، عقارات…)
export const faCategoriesTable = pgTable("fa_categories", {
  id:                  serial("id").primaryKey(),
  companyId:           integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  code:                text("code").notNull(),
  nameAr:              text("name_ar").notNull(),
  nameEn:              text("name_en"),
  defaultLifeYears:    integer("default_life_years").notNull().default(5),
  defaultDepreciationMethod: faDepreciationMethodEnum("default_depreciation_method").notNull().default("straight_line"),
  defaultScrapRate:    numeric("default_scrap_rate", { precision: 5, scale: 2 }).notNull().default("10"),
  isActive:            boolean("is_active").notNull().default(true),
  // ─── Phase-2: per-category JE account overrides (IAS 16). NULL = fall
  // back to the company-wide defaults on `companies.faXxxAccountId`. The
  // fa-journals helper resolves category first, then company.
  costAccountId:               integer("cost_account_id"),
  accumDepreciationAccountId:  integer("accum_depreciation_account_id"),
  depreciationExpenseAccountId: integer("depreciation_expense_account_id"),
  createdAt:           timestamp("created_at").defaultNow().notNull(),
});
export type FaCategory       = typeof faCategoriesTable.$inferSelect;
export type InsertFaCategory = typeof faCategoriesTable.$inferInsert;

// 2) Fixed Assets (الأصل الرئيسي)
export const fixedAssetsTable = pgTable("fixed_assets", {
  id:                  serial("id").primaryKey(),
  companyId:           integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:            integer("branch_id").references(() => branchesTable.id, { onDelete: "set null" }),
  costCenterId:        integer("cost_center_id").references(() => costCentersTable.id, { onDelete: "set null" }),
  categoryId:          integer("category_id").references(() => faCategoriesTable.id, { onDelete: "set null" }),

  code:                text("code").notNull(),
  nameAr:              text("name_ar").notNull(),
  nameEn:              text("name_en"),
  status:              faStatusEnum("status").notNull().default("active"),

  // ── Purchase data ────────────────────────────────────────────
  purchaseDate:        date("purchase_date"),
  purchaseValue:       numeric("purchase_value", { precision: 15, scale: 2 }).notNull().default("0"),
  supplierName:        text("supplier_name"),
  // FK to suppliers.id — preferred over the free-text snapshot above.
  // Kept nullable + no FK constraint so legacy rows (and rows where the
  // user types a one-off vendor) keep working.
  supplierId:          integer("supplier_id"),
  invoiceNo:           text("invoice_no"),
  // cash | bank | credit — same vocabulary as purchase invoices.
  paymentMethod:       text("payment_method"),
  // When paymentMethod = 'cash' or 'bank', point at the source of funds so
  // the acquisition JE credits the right cash/bank account instead of the
  // generic acquisition-clearing account.
  cashBoxId:           integer("cash_box_id"),
  bankAccountId:       integer("bank_account_id"),

  // ── Technical / vehicle data ─────────────────────────────────
  model:               text("model"),                 // e.g. 2023
  brand:               text("brand"),                 // e.g. Toyota
  serialNo:            text("serial_no"),             // chassis / serial
  plateNumber:         text("plate_number"),
  color:               text("color"),
  initialKm:           integer("initial_km"),
  currentKm:           integer("current_km"),

  // ── Depreciation ─────────────────────────────────────────────
  lifeYears:           integer("life_years").notNull().default(5),
  depreciationMethod:  faDepreciationMethodEnum("depreciation_method").notNull().default("straight_line"),
  scrapValue:          numeric("scrap_value", { precision: 15, scale: 2 }).notNull().default("0"),
  depreciationStart:   date("depreciation_start"),
  accumulatedDepreciation: numeric("accumulated_depreciation", { precision: 15, scale: 2 }).notNull().default("0"),
  bookValue:           numeric("book_value", { precision: 15, scale: 2 }).notNull().default("0"),

  // ── Insurance ────────────────────────────────────────────────
  insuranceCompany:    text("insurance_company"),
  insurancePolicyNo:   text("insurance_policy_no"),
  insuranceStart:      date("insurance_start"),
  insuranceEnd:        date("insurance_end"),
  insuranceValue:      numeric("insurance_value", { precision: 15, scale: 2 }).notNull().default("0"),

  // ── Custody / location ───────────────────────────────────────
  custodianEmployeeId: integer("custodian_employee_id"),
  location:            text("location"),

  // ── AI / extra ───────────────────────────────────────────────
  riskLevel:           text("risk_level"),          // low/medium/high — populated by AI
  aiRecommendation:    text("ai_recommendation"),   // keep/maintain/replace/sell
  qrPayload:           text("qr_payload"),
  notes:               text("notes"),

  // ─── Phase-2: link to the acquisition JE (when posted). NULL = no JE
  // (opening-balance load, accounts not configured, or auto-post toggle off
  // and the user hasn't manually posted yet from the Posting Center).
  journalEntryId:      integer("journal_entry_id"),

  createdAt:           timestamp("created_at").defaultNow().notNull(),
  updatedAt:           timestamp("updated_at").defaultNow().notNull(),
});
export type FixedAsset       = typeof fixedAssetsTable.$inferSelect;
export type InsertFixedAsset = typeof fixedAssetsTable.$inferInsert;

// 3) Maintenance log — every service entry for an asset
export const faMaintenanceTable = pgTable("fa_maintenance", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  assetId:      integer("asset_id").notNull().references(() => fixedAssetsTable.id, { onDelete: "cascade" }),
  code:         text("code").notNull(),
  type:         faMaintenanceTypeEnum("type").notNull().default("periodic"),
  serviceDate:  date("service_date").notNull(),
  cost:         numeric("cost", { precision: 15, scale: 2 }).notNull().default("0"),
  vendorName:   text("vendor_name"),
  technicianName: text("technician_name"),
  description:  text("description"),
  kmAtService:  integer("km_at_service"),
  approved:     boolean("approved").notNull().default(false),
  notes:        text("notes"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
});
export type FaMaintenance       = typeof faMaintenanceTable.$inferSelect;
export type InsertFaMaintenance = typeof faMaintenanceTable.$inferInsert;

// 4) Transfers — between branches / cost centers
export const faTransfersTable = pgTable("fa_transfers", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  assetId:      integer("asset_id").notNull().references(() => fixedAssetsTable.id, { onDelete: "cascade" }),
  code:         text("code").notNull(),
  fromBranchId: integer("from_branch_id").references(() => branchesTable.id, { onDelete: "set null" }),
  toBranchId:   integer("to_branch_id").references(() => branchesTable.id, { onDelete: "set null" }),
  fromCostCenterId: integer("from_cost_center_id").references(() => costCentersTable.id, { onDelete: "set null" }),
  toCostCenterId:   integer("to_cost_center_id").references(() => costCentersTable.id, { onDelete: "set null" }),
  transferDate: date("transfer_date").notNull(),
  reason:       text("reason"),
  approvedBy:   text("approved_by"),
  notes:        text("notes"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
});
export type FaTransfer       = typeof faTransfersTable.$inferSelect;
export type InsertFaTransfer = typeof faTransfersTable.$inferInsert;

// 5) Monthly depreciation runs (audit trail of postings)
export const faDepreciationRunsTable = pgTable("fa_depreciation_runs", {
  id:                serial("id").primaryKey(),
  companyId:         integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  assetId:           integer("asset_id").notNull().references(() => fixedAssetsTable.id, { onDelete: "cascade" }),
  periodMonth:       integer("period_month").notNull(),  // 1-12
  periodYear:        integer("period_year").notNull(),
  depreciationAmount: numeric("depreciation_amount", { precision: 15, scale: 2 }).notNull(),
  bookValueBefore:   numeric("book_value_before", { precision: 15, scale: 2 }).notNull(),
  bookValueAfter:    numeric("book_value_after", { precision: 15, scale: 2 }).notNull(),
  postedBy:          text("posted_by"),
  postedAt:          timestamp("posted_at").defaultNow().notNull(),
  journalEntryId:    integer("journal_entry_id"),
  notes:             text("notes"),
});
export type FaDepreciationRun       = typeof faDepreciationRunsTable.$inferSelect;
export type InsertFaDepreciationRun = typeof faDepreciationRunsTable.$inferInsert;

// 6) Disposals (sale / scrap / full depreciation / write-off)
export const faDisposalsTable = pgTable("fa_disposals", {
  id:               serial("id").primaryKey(),
  companyId:        integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  assetId:          integer("asset_id").notNull().references(() => fixedAssetsTable.id, { onDelete: "cascade" }),
  code:             text("code").notNull(),
  type:             faDisposalTypeEnum("type").notNull().default("sale"),
  disposalDate:     date("disposal_date").notNull(),
  salePrice:        numeric("sale_price", { precision: 15, scale: 2 }).notNull().default("0"),
  scrapValue:       numeric("scrap_value", { precision: 15, scale: 2 }).notNull().default("0"),
  bookValueAtDisposal: numeric("book_value_at_disposal", { precision: 15, scale: 2 }).notNull().default("0"),
  gainLoss:         numeric("gain_loss", { precision: 15, scale: 2 }).notNull().default("0"),
  buyerName:        text("buyer_name"),
  reason:           text("reason"),
  journalEntryId:   integer("journal_entry_id"),
  notes:            text("notes"),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
});
export type FaDisposal       = typeof faDisposalsTable.$inferSelect;
export type InsertFaDisposal = typeof faDisposalsTable.$inferInsert;
