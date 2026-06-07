import { pgTable, serial, text, boolean, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const companiesTable = pgTable("companies", {
  id: serial("id").primaryKey(),
  nameAr: text("name_ar").notNull(),
  nameEn: text("name_en"),
  vatNumber: text("vat_number").notNull(),
  crNumber: text("cr_number").notNull(),
  city: text("city").notNull(),
  district: text("district"),
  street: text("street").notNull(),
  buildingNumber: text("building_number").notNull(),
  postalCode: text("postal_code").notNull(),
  additionalNumber: text("additional_number"),
  phone: text("phone"),
  country: text("country").notNull().default("SA"),
  industryName: text("industry_name"),
  invoiceType: text("invoice_type").notNull().default("both"),
  isSandbox: boolean("is_sandbox").notNull().default(false),
  zatcaEnvironment: text("zatca_environment"),
  serialNumber: text("serial_number"),
  deviceSerial1: text("device_serial1"),
  deviceSerial2: text("device_serial2"),
  deviceSerial3: text("device_serial3"),
  zatcaCsid: text("zatca_csid"),
  zatcaPcsid: text("zatca_pcsid"),
  zatcaPrivateKey: text("zatca_private_key"),
  zatcaCsr: text("zatca_csr"),
  zatcaCsidToken: text("zatca_csid_token"),
  zatcaCsidSecret: text("zatca_csid_secret"),
  zatcaPcsidToken: text("zatca_pcsid_token"),
  zatcaPcsidSecret: text("zatca_pcsid_secret"),
  invoiceCounter: integer("invoice_counter").notNull().default(0),
  // General settings
  logo: text("logo"),                          // base64 data URL
  decimalPlaces: integer("decimal_places").notNull().default(2),
  // Menu visibility permissions (JSON): { invoices, customers, suppliers, zatca }
  menuPermissions: text("menu_permissions").default('{"invoices":true,"customers":true,"suppliers":true,"zatca":true}'),
  // Windows desktop-app module visibility (JSON): { <windows module key>: boolean }.
  // SuperAdmin-controlled, separate from the web `menuPermissions` because the
  // Windows app (artifacts/pos-desktop) has its own screen/module set. Pushed to
  // the device through /api/sync/pull (settings entity). NULL/missing key → enabled
  // (legacy companies keep every module visible).
  windowsModulePermissions: text("windows_module_permissions"),
  // System-wide posting mode: true = auto-post after save, false = manual posting only.
  // This is the master switch and the legacy fallback for the per-doc-type flags
  // below. When a per-doc-type flag is NULL (legacy rows) the form falls back to
  // this global value so existing tenants keep their current behavior.
  autoPostingEnabled: boolean("auto_posting_enabled").notNull().default(true),
  // Journal-entry form behavior after a successful save:
  //   "auto"   → keep the form open and reset to a fresh draft so the user can
  //              keep typing the next entry (current default behavior).
  //   "manual" → navigate back to the journal-entries list (legacy/old
  //              behavior some accountants prefer).
  // Defaults to "auto" so existing tenants keep the modern flow.
  journalEntryFormMode: text("journal_entry_form_mode").notNull().default("auto"),
  // ─── Per-document-type auto-posting toggles ───────────────────────────
  // Each flag controls whether saving a document of that type immediately
  // posts the resulting journal entry (true) or leaves it as a draft for
  // manual posting from the Posting Center (false). Default true so newly
  // added columns don't silently change behavior on upgrade.
  // Manual journal entries (POST /api/journal-entries). When false, a
  // newly-saved balanced JE lands as `draft` instead of `posted` so the
  // accountant can review it from مركز الترحيل before it touches any
  // financial report. Drafts have ZERO impact on trial balance / B-S /
  // P&L per the financial-reports gotcha in replit.md.
  autoPostJournalEntry:  boolean("auto_post_journal_entry").notNull().default(true),
  autoPostSales:         boolean("auto_post_sales").notNull().default(true),
  autoPostPurchase:      boolean("auto_post_purchase").notNull().default(true),
  autoPostReceipt:       boolean("auto_post_receipt").notNull().default(true),
  autoPostPayment:       boolean("auto_post_payment").notNull().default(true),
  autoPostFinancial:     boolean("auto_post_financial").notNull().default(true),
  autoPostCashTransfer:  boolean("auto_post_cash_transfer").notNull().default(true),
  autoPostPayroll:       boolean("auto_post_payroll").notNull().default(true),
  // ─── Phase-1 additions: every other module that produces a JE ─────────
  // Production orders (issue + completion JEs), stock movements (transfers
  // and adjustments share one toggle so the user doesn't have to reason
  // about two near-identical inventory flows), goods receipts (GRN cost
  // accrual), goods deliveries (COGS), and the recurring monthly
  // accounting adjustments (prepaid / accrued). All default to true so
  // upgrading tenants keep their existing behavior — the user only sees
  // the toggle off after they explicitly flip it from /general-settings.
  autoPostProduction:    boolean("auto_post_production").notNull().default(true),
  autoPostStockMovement: boolean("auto_post_stock_movement").notNull().default(true),
  autoPostGoodsReceipt:  boolean("auto_post_goods_receipt").notNull().default(true),
  autoPostGoodsDelivery: boolean("auto_post_goods_delivery").notNull().default(true),
  autoPostAdjustment:    boolean("auto_post_adjustment").notNull().default(true),
  // ─── Phase-2 additions: Fixed Assets (IAS 16) auto-post toggles ───────
  // Acquisition = JE on POST /assets when purchaseValue>0 and not an
  // opening balance. Depreciation = JE for each row created by the monthly
  // /depreciation/post run. Disposal = JE on POST /disposals.
  autoPostFaAcquisition: boolean("auto_post_fa_acquisition").notNull().default(true),
  autoPostFaDepreciation: boolean("auto_post_fa_depreciation").notNull().default(true),
  autoPostFaDisposal:    boolean("auto_post_fa_disposal").notNull().default(true),
  // Day of the current KSA-local month on which the depreciation scheduler
  // auto-posts the PREVIOUS month's depreciation for every active asset.
  // Range 1..28 (avoid 29-31 to keep behavior identical in February). The
  // scheduler is a no-op when `autoPostFaDepreciation` is false. The post
  // operation itself is naturally idempotent — fa_depreciation_runs has a
  // unique (companyId, assetId, periodMonth, periodYear) check that the
  // posting helper consults before inserting, so a duplicate run on the
  // same day is safe.
  faAutoDepDay: integer("fa_auto_dep_day").notNull().default(1),
  // ─── Phase-3 additions: Contracting (IFRS 15) auto-post toggles ───────
  // OutgoingBill = JE on PUT /bills/:id when status flips to "approved" for
  // a direction='outgoing' bill (مستخلص للمالك): recognises period revenue
  // via percentage-of-completion. IncomingBill = same trigger for
  // direction='incoming' (مستخلص باطن): capitalises period cost into
  // construction WIP and books the subcontractor payable + retention.
  // Account routing uses the generic accounting_mappings table
  // (documentType = "contracting_outgoing_bill" | "contracting_incoming_bill").
  autoPostCtgOutgoingBill: boolean("auto_post_ctg_outgoing_bill").notNull().default(true),
  autoPostCtgIncomingBill: boolean("auto_post_ctg_incoming_bill").notNull().default(true),
  // ─── HR / Payroll account mapping (resolved from COA on first use) ─────
  hrSalariesExpenseAccountId:    integer("hr_salaries_expense_account_id"),
  hrAllowancesExpenseAccountId:  integer("hr_allowances_expense_account_id"),
  hrGosiExpenseAccountId:        integer("hr_gosi_expense_account_id"),
  hrEosExpenseAccountId:         integer("hr_eos_expense_account_id"),
  hrSalariesPayableAccountId:    integer("hr_salaries_payable_account_id"),
  hrGosiPayableAccountId:        integer("hr_gosi_payable_account_id"),
  hrOtherDeductionsAccountId:    integer("hr_other_deductions_account_id"),
  hrEmployeeLoansAccountId:      integer("hr_employee_loans_account_id"),
  hrEosProvisionAccountId:       integer("hr_eos_provision_account_id"),
  hrDefaultPayCashBoxId:         integer("hr_default_pay_cashbox_id"),
  hrDefaultPayBankAccountId:     integer("hr_default_pay_bank_account_id"),
  // ─── Fixed Assets (IAS 16) account mapping (company-wide defaults) ─────
  // The fa-journals helper falls back to these when the asset's category
  // doesn't carry a per-category override. AcquisitionClearing is the CR
  // side of the acquisition JE when the user didn't supply a cash/bank
  // source (typical for "purchased on credit, settle later via voucher").
  faAssetCostAccountId:          integer("fa_asset_cost_account_id"),
  faAccumDepreciationAccountId:  integer("fa_accum_depreciation_account_id"),
  faDepreciationExpenseAccountId: integer("fa_depreciation_expense_account_id"),
  faAcquisitionClearingAccountId: integer("fa_acquisition_clearing_account_id"),
  faDisposalGainAccountId:       integer("fa_disposal_gain_account_id"),
  faDisposalLossAccountId:       integer("fa_disposal_loss_account_id"),
  // POS payment-method → account mappings
  posCashCashBoxId:          integer("pos_cash_cashbox_id"),
  posCardBankAccountId:      integer("pos_card_bank_account_id"),
  posAppleBankAccountId:     integer("pos_apple_bank_account_id"),
  posWalletBankAccountId:    integer("pos_wallet_bank_account_id"),
  // ─── Print footer customization (thermal/A4 templates) ───────────────
  printFooterInvoice:   text("print_footer_invoice").notNull().default("شكراً لزيارتكم — نتمنى لكم يوماً سعيداً"),
  printFooterReturn:    text("print_footer_return").notNull().default("تم استلام المرتجع — شكراً لتعاملكم"),
  printShowTimestamp:   boolean("print_show_timestamp").notNull().default(true),
  printShowZatcaBrand:  boolean("print_show_zatca_brand").notNull().default(true),
  // Which sales-print templates are visible to end-users in the print
  // modal. NULL or empty array = show all 12 (default behavior). Stored
  // as a JSONB int[] (template ids 1..12). The "default" id below picks
  // which one is preselected when the modal opens.
  printEnabledTemplates: jsonb("print_enabled_templates").$type<number[]>(),
  printDefaultTemplate:  integer("print_default_template").notNull().default(1),
  // Default language for invoice PRINT output ("ar" | "en"). Currently
  // honoured by template 14 («الأصلي») only; the per-print toggle in
  // SalesPrintModal can override it for a single print job.
  invoicePrintLanguage:  text("invoice_print_language").notNull().default("ar"),
  // Which date the `{MM}`/`{YY}`/`{YYYY}` tokens in a document-number
  // sequence pattern should read from:
  //   - "system"   = today's date at the moment of issuance (default,
  //                  matches legacy behaviour).
  //   - "document" = the date the user actually entered on the
  //                  document being saved (e.g. a JE backdated to
  //                  1-1-2026 produces "01" even if today is May).
  // The sequences library honours this per call; callers that don't
  // pass a `docDate` always fall back to system date regardless.
  sequenceDateSource: text("sequence_date_source").notNull().default("system"),
  // ─── Auto-print after save + per-doc-type template (a4 | thermal) ─────
  // When `printAutoAfterSave*` is true, the matching form opens a print
  // window automatically right after the save mutation succeeds. The
  // template column picks the visual layout used for that auto-print
  // (and is the default selection on manual-print buttons too).
  printAutoAfterSaveSales:    boolean("print_auto_after_save_sales").notNull().default(false),
  printAutoAfterSaveReceipt:  boolean("print_auto_after_save_receipt").notNull().default(false),
  printAutoAfterSavePayment:  boolean("print_auto_after_save_payment").notNull().default(false),
  printAutoAfterSaveJournal:  boolean("print_auto_after_save_journal").notNull().default(false),
  printTemplateSales:    text("print_template_sales").notNull().default("a4"),
  printTemplateReceipt:  text("print_template_receipt").notNull().default("a4"),
  printTemplatePayment:  text("print_template_payment").notNull().default("a4"),
  printTemplateJournal:  text("print_template_journal").notNull().default("a4"),
  // ─── Automatic backup settings ────────────────────────────────────────
  autoBackupEnabled:        boolean("auto_backup_enabled").notNull().default(true),
  autoBackupFrequencyHours: integer("auto_backup_frequency_hours").notNull().default(24),
  autoBackupRetention:      integer("auto_backup_retention").notNull().default(7),
  lastAutoBackupAt:         timestamp("last_auto_backup_at"),
  // Registration workflow
  status: text("status").notNull().default("active"), // pending | active | rejected
  rejectionReason: text("rejection_reason"),
  registrationIp: text("registration_ip"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  // Soft-delete timestamp. NULL = company is live; set = company is in the
  // recycle bin and excluded from every regular list / dashboard query.
  // SuperAdmin can restore (clear deletedAt) or hard-delete from the
  // dedicated /companies/deleted screen.
  deletedAt: timestamp("deleted_at"),
  // ─── Tax calculation mode (VAT vs discount ordering) ────────────────
  // Controls whether VAT is computed on the gross line BEFORE the discount
  // is applied (`before_discount` → vat = qty*price*rate, then
  // lineTotal = qty*price + vat − disc) or AFTER (`after_discount` →
  // vat = (qty*price − disc)*rate, then lineTotal = (qty*price − disc) + vat).
  // Default `after_discount` matches the legacy/current calculator and the
  // ZATCA-standard behaviour where the discount reduces the taxable base.
  // The setting is read by every line-tax calculator (sales invoice /
  // quotation / order, sales return, purchase invoice, purchase return,
  // POS, fixed assets). Changing it only affects NEW lines typed after
  // the toggle — already-saved documents retain their stored vatAmount.
  taxCalculationMode: text("tax_calculation_mode").notNull().default("after_discount"),
  // ─── Windows Desktop POS feature flag (Task #174) ─────────────────────
  // When true, the company is opted into the offline Windows POS desktop
  // app (Tauri-based). All sync/license/device-management APIs reject
  // requests with HTTP 403 when this is false. The flag is opt-in only and
  // defaults to false so existing tenants are completely unaffected by
  // the new code paths until SuperAdmin explicitly enables it.
  enableOfflinePos: boolean("enable_offline_pos").notNull().default(false),
  // Public, human-friendly company code (e.g. "ZTC-1042"). Required by
  // login: tenants identify themselves with (companyCode, username,
  // password) so usernames can repeat across companies. Generated at
  // registration. Backfilled for legacy rows as "ZTC-{id}". Unique
  // among non-NULL values via a partial index added in the schema-pin
  // ensureSchema run; intentionally nullable here so a company created
  // before the column existed can be patched without blocking writes.
  code: text("code"),
});

export const insertCompanySchema = createInsertSchema(companiesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCompany = z.infer<typeof insertCompanySchema>;
export type Company = typeof companiesTable.$inferSelect;
