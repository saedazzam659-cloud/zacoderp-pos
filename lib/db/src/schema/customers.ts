import { pgTable, serial, text, integer, timestamp, numeric, boolean } from "drizzle-orm/pg-core";

import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

export const customersTable = pgTable("customers", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  nameAr: text("name_ar").notNull(),
  nameEn: text("name_en"),
  vatNumber: text("vat_number"),
  crNumber: text("cr_number"),
  email: text("email"),
  phone: text("phone"),
  city: text("city"),
  district: text("district"),
  street: text("street"),
  buildingNumber: text("building_number"),
  postalCode: text("postal_code"),
  country:   text("country").default("SA"),
  nationalAddressShort: text("national_address_short"),
  locationLat: numeric("location_lat", { precision: 10, scale: 7 }),
  locationLng: numeric("location_lng", { precision: 10, scale: 7 }),
  locationLink: text("location_link"),
  accountId: integer("account_id"),
  salesRepId: integer("sales_rep_id"),
  creditLimit: numeric("credit_limit", { precision: 15, scale: 2 }).default("0"),
  /**
   * When true → POST /api/invoices refuses to create a credit sales invoice
   * for this customer if (currentARBalance + newInvoiceTotal) would exceed
   * `creditLimit`. When false (default) the limit is informational only.
   * Cash invoices and zero/empty `creditLimit` always bypass the guard.
   */
  enforceCreditLimit: boolean("enforce_credit_limit").notNull().default(false),
  /**
   * When false → this customer is treated as a *display-only* / memo entity:
   *   – Their data still prints on invoices / vouchers / journal entries.
   *   – Their AR balance is EXCLUDED from كشف حساب العملاء، تقارير الأعمار،
   *     وأرصدة العملاء (the customer doesn't appear in those reports at all).
   *   – Underlying journal entries are still posted normally to the AR
   *     control account, so the trial balance / income statement remain
   *     correct — only the per-customer statement views ignore them.
   * Default true (full posting + statement participation).
   */
  includeInStatements: boolean("include_in_statements").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCustomerSchema = createInsertSchema(customersTable).omit({ id: true, createdAt: true });
export type InsertCustomer = z.infer<typeof insertCustomerSchema>;
export type Customer = typeof customersTable.$inferSelect;
