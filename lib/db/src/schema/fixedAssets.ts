// ─────────────────────────────────────────────────────────────────────────
// Fixed Assets module — Categories, Assets, Maintenance, Transfers,
// Depreciation runs, and Disposals. Multi-company scoped with branch +
// cost-center references. Includes purchase, technical, depreciation,
// and insurance fields plus AI risk metadata.
// ─────────────────────────────────────────────────────────────────────────
import {
  pgTable, serial, text, integer, numeric, timestamp, boolean, pgEnum, date, uniqueIndex,
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
  defaultLifeYears:    numeric("default_life_years", { precision: 8, scale: 4 }).notNull().default("5"),
  defaultDepreciationMethod: faDepreciationMethodEnum("default_depreciation_method").notNull().default("straight_line"),
  defaultScrapRate:    numeric("default_scrap_rate", { precision: 15, scale: 2 }).notNull().default("10"),
  // How to interpret defaultScrapRate: "percent" = % of purchase value,
  // "value" = a fixed absolute scrap amount. Widened precision above so the
  // same column can hold either a small % or a large absolute figure.
  defaultScrapType:    text("default_scrap_type").notNull().default("percent"), // percent | value
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

// 1b) Asset Groups (مجموعات الأصول) — international-standard (IAS 16 / SAP-style
// "asset class") HIERARCHICAL classification tree. `parentId` self-references
// this same table = the "مجموعة رئيسية" (main group). This is a purely
// organizational / reporting dimension and is INDEPENDENT of `fa_categories`
// which owns the accounting defaults + per-category JE account overrides.
// parentId is kept as a plain integer (no FK) to allow a lazy self-reference;
// same-company ownership + cycle prevention are enforced in the route layer.
export const faAssetGroupsTable = pgTable("fa_asset_groups", {
  id:        serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  code:      text("code").notNull(),
  nameAr:    text("name_ar").notNull(),
  nameEn:    text("name_en"),
  parentId:  integer("parent_id"),
  isActive:  boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type FaAssetGroup       = typeof faAssetGroupsTable.$inferSelect;
export type InsertFaAssetGroup = typeof faAssetGroupsTable.$inferInsert;

// 2) Fixed Assets (الأصل الرئيسي)
export const fixedAssetsTable = pgTable("fixed_assets", {
  id:                  serial("id").primaryKey(),
  companyId:           integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:            integer("branch_id").references(() => branchesTable.id, { onDelete: "set null" }),
  costCenterId:        integer("cost_center_id").references(() => costCentersTable.id, { onDelete: "set null" }),
  categoryId:          integer("category_id").references(() => faCategoriesTable.id, { onDelete: "set null" }),
  groupId:             integer("group_id").references(() => faAssetGroupsTable.id, { onDelete: "set null" }),

  code:                text("code").notNull(),
  nameAr:              text("name_ar").notNull(),
  nameEn:              text("name_en"),
  status:              faStatusEnum("status").notNull().default("active"),

  // ── Purchase data ────────────────────────────────────────────
  purchaseDate:        date("purchase_date"),
  purchaseValue:       numeric("purchase_value", { precision: 15, scale: 2 }).notNull().default("0"),
  // Tax tab: rate is the VAT % (default 15 KSA), priceIncludesVat marks
  // whether the user-entered figure was already gross. purchaseValue is
  // ALWAYS stored as the NET (before-VAT) amount because depreciation,
  // book-value and JE acquisition all run on the net basis.
  vatRate:             numeric("vat_rate", { precision: 5, scale: 2 }).notNull().default("15"),
  priceIncludesVat:    boolean("price_includes_vat").notNull().default(false),
  supplierName:        text("supplier_name"),
  // FK to suppliers.id — preferred over the free-text snapshot above.
  // Kept nullable + no FK constraint so legacy rows (and rows where the
  // user types a one-off vendor) keep working.
  supplierId:          integer("supplier_id"),
  invoiceNo:           text("invoice_no"),
  // Acquisition journal-entry number when the asset was loaded from an
  // existing manual JE. Kept SEPARATE from invoice_no so a JE reference never
  // masquerades as a purchase-invoice number (print/reports read invoice_no).
  acquisitionJeNo:     text("acquisition_je_no"),
  // cash | bank | credit — same vocabulary as purchase invoices.
  paymentMethod:       text("payment_method"),
  // When paymentMethod = 'cash' or 'bank', point at the source of funds so
  // the acquisition JE credits the right cash/bank account instead of the
  // generic acquisition-clearing account.
  cashBoxId:           integer("cash_box_id"),
  bankAccountId:       integer("bank_account_id"),
  // When TRUE the asset's cost was ALREADY recorded elsewhere (a manual JE
  // or a purchase invoice), so POST /assets must NOT post another
  // acquisition JE — it only tracks depreciation. Prevents double-counting.
  skipAcquisitionJe:   boolean("skip_acquisition_je").notNull().default(false),
  // When TRUE the asset was loaded as an OPENING BALANCE (رصيد افتتاحي): it is
  // NOT tied to a purchase invoice or a manual JE, so no acquisition JE is
  // posted (implies skipAcquisitionJe) and supplier/invoice are optional. The
  // asset still surfaces in the depreciation schedule + fixed-asset movement
  // reports (which read the asset rows, not the JEs).
  isOpeningBalance:    boolean("is_opening_balance").notNull().default(false),

  // ── Technical / vehicle data ─────────────────────────────────
  model:               text("model"),                 // e.g. 2023
  brand:               text("brand"),                 // e.g. Toyota
  serialNo:            text("serial_no"),             // chassis number (رقم الشاسيه)
  serialNumber:        text("serial_number"),         // serial / asset serial (المسلسل)
  plateNumber:         text("plate_number"),
  color:               text("color"),
  initialKm:           integer("initial_km"),
  currentKm:           integer("current_km"),

  // ── Depreciation ─────────────────────────────────────────────
  lifeYears:           numeric("life_years", { precision: 8, scale: 4 }).notNull().default("5"),
  depreciationMethod:  faDepreciationMethodEnum("depreciation_method").notNull().default("straight_line"),
  scrapValue:          numeric("scrap_value", { precision: 15, scale: 2 }).notNull().default("0"),
  depreciationStart:   date("depreciation_start"),
  accumulatedDepreciation: numeric("accumulated_depreciation", { precision: 15, scale: 2 }).notNull().default("0"),
  // "المجمع حتى تاريخ" — the date the manually-entered opening accumulated
  // depreciation covers UP TO (inclusive). When set (straight-line only):
  // catch-up/scheduler resume from the NEXT day and the remaining book value
  // is spread over the REMAINING life days (accumAsOf+1 → last life day)
  // instead of the full-life rate. NULL = legacy behavior, fully unchanged.
  accumAsOf:           date("accum_as_of"),
  // Snapshot of the OPENING accumulated depreciation as of accumAsOf. The
  // live accumulatedDepreciation column keeps growing with every monthly run,
  // so the resume-rate math must use this frozen figure, never the rolling
  // one, or the daily rate would drift every month.
  accumAsOfAmount:     numeric("accum_as_of_amount", { precision: 15, scale: 2 }),
  bookValue:           numeric("book_value", { precision: 15, scale: 2 }).notNull().default("0"),

  // ── Insurance ────────────────────────────────────────────────
  insuranceCompany:    text("insurance_company"),
  insurancePolicyNo:   text("insurance_policy_no"),
  insuranceCoverage:   text("insurance_coverage"),
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

  // ─── Source linkage (SAP-style): where the asset card was created FROM.
  // NULL sourceType = manual entry. purchase_invoice → sourceDocumentId is
  // purchase_invoices.id + sourceLineId the invoice line; journal_entry →
  // sourceDocumentId is journal_entries.id + sourceLineId the JE line.
  // A partial unique index (company_id, source_type, source_document_id,
  // COALESCE(source_line_id,0)) WHERE source_type IS NOT NULL AND status NOT IN ('sold','scrapped')
  // guarantees one live asset per source line (no double entry).
  sourceType:          text("source_type"),          // purchase_invoice | journal_entry
  sourceDocumentId:    integer("source_document_id"),
  sourceLineId:        integer("source_line_id"),

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
  // Posting lifecycle of the run itself (separate from JE status). A row
  // existing historically meant "posted"; the Posting Center (مركز الترحيل)
  // now lets an accountant UNPOST a run — which fully reverses its economic
  // effect (asset accumulated depreciation + book value AND its JE) and flips
  // this to 'unposted' while KEEPING the row so it can be re-posted (recomputed
  // day-based). Defaults to 'posted' so all legacy rows migrate correctly.
  status:            text("status").notNull().default("posted"), // 'posted' | 'unposted'
}, (t) => ({
  // One run per asset per calendar month — DB-level guarantee that catch-up /
  // scheduler / manual posting can never double-post the same period, even
  // under concurrent asset saves (the app-level existence check races). Insert
  // paths use ON CONFLICT DO NOTHING against this constraint.
  uqPeriod: uniqueIndex("uq_fa_dep_run_period").on(t.companyId, t.assetId, t.periodMonth, t.periodYear),
}));
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
