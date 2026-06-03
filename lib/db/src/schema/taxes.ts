import { pgTable, serial, text, boolean, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

// ─── Dynamic Tax Catalog (الضرائب) ───────────────────────────────────────────
// Company-scoped, user-managed tax definitions that replace the hard-coded
// 15% VAT default flowing into sales/purchase document lines and the journal
// entry tax button. A protected "system" tax (isSystem = true) represents the
// ZATCA KSA standard VAT (15%) — it can be renamed/re-pointed but never
// deleted, and its rate stays locked at 15 so the ZATCA path is never broken.
//
// IMPORTANT — ZATCA safety: this table ONLY changes the DEFAULT rate that gets
// written into the existing stored fields (sales_invoice_lines.vat_rate, etc.)
// BEFORE an invoice is issued. The ZATCA XML/TLV/signing layer keeps reading
// those same stored fields verbatim, so dynamic taxes never alter issued
// invoices and never rename or repurpose any ZATCA-consumed column.
export const taxesTable = pgTable("taxes", {
  id:        serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  code:      text("code").notNull(),
  nameAr:    text("name_ar").notNull(),
  nameEn:    text("name_en"),
  // Rate value. Interpreted as a percentage when rateType = "percent"
  // (e.g. 15 → 15%), or as a fixed amount when rateType = "fixed".
  rate:      numeric("rate", { precision: 9, scale: 4 }).notNull().default("15"),
  // "percent" (نسبة) | "fixed" (قيمة ثابتة). Document line wiring applies the
  // percent rate to vat_rate; fixed taxes are recorded but only the manual JE
  // tax button uses the fixed amount directly.
  rateType:  text("rate_type").notNull().default("percent"),
  // Optional scoping: NULL currencyCode = applies to all currencies; NULL
  // branchId = applies to all branches.
  currencyCode: text("currency_code"),
  branchId:     integer("branch_id"),
  // Cost-center CODE (text) mirroring journal_entry_lines.cost_center convention.
  costCenter:   text("cost_center"),
  // Primary GL account (general). The per-doc-type accounts below take
  // precedence when set: output VAT (sales) vs input VAT (purchases).
  accountId:            integer("account_id"),
  salesTaxAccountId:    integer("sales_tax_account_id"),
  purchaseTaxAccountId: integer("purchase_tax_account_id"),
  isActive:  boolean("is_active").notNull().default(true),
  // Per-company default tax auto-loaded on new documents. Exactly one row
  // per company should carry isDefault = true (enforced in the router).
  isDefault: boolean("is_default").notNull().default(false),
  // Protected ZATCA system tax (KSA 15%). Cannot be deleted; rate + isSystem
  // are locked on update.
  isSystem:  boolean("is_system").notNull().default(false),
  notes:     text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertTaxSchema = createInsertSchema(taxesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTax = z.infer<typeof insertTaxSchema>;
export type Tax = typeof taxesTable.$inferSelect;
