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
  country: text("country").notNull().default("SA"),
  industryName: text("industry_name"),
  invoiceType: text("invoice_type").notNull().default("both"),
  isSandbox: boolean("is_sandbox").notNull().default(false),
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
  // System-wide posting mode: true = auto-post after save, false = manual posting only
  autoPostingEnabled: boolean("auto_posting_enabled").notNull().default(true),
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
});

export const insertCompanySchema = createInsertSchema(companiesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCompany = z.infer<typeof insertCompanySchema>;
export type Company = typeof companiesTable.$inferSelect;
