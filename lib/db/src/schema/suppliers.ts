import { pgTable, serial, text, integer, timestamp, numeric, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

export const suppliersTable = pgTable("suppliers", {
  id:                  serial("id").primaryKey(),
  companyId:           integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  code:                text("code"),
  nameAr:              text("name_ar").notNull(),
  nameEn:              text("name_en"),
  vatNumber:           text("vat_number"),
  crNumber:            text("cr_number"),
  email:               text("email"),
  phone:               text("phone"),
  city:                text("city"),
  district:            text("district"),
  street:              text("street"),
  buildingNumber:      text("building_number"),
  postalCode:          text("postal_code"),
  country:             text("country").default("SA"),
  nationalAddressShort: text("national_address_short"),
  locationLat:         numeric("location_lat", { precision: 10, scale: 7 }),
  locationLng:         numeric("location_lng", { precision: 10, scale: 7 }),
  locationLink:        text("location_link"),
  accountId:           integer("account_id"),
  groupId:             integer("group_id"),
  /** Optional home branch — mirror of customers.branchId. */
  branchId:            integer("branch_id"),
  currencyCode:        text("currency_code").default("SAR"),
  creditLimit:         numeric("credit_limit", { precision: 15, scale: 2 }).default("0"),
  openingBalance:      numeric("opening_balance", { precision: 15, scale: 2 }).default("0"),
  openingBalanceType:  text("opening_balance_type").default("credit"),
  isActive:            boolean("is_active").notNull().default(true),
  /** Mirror of customers.includeInStatements — see that field for full rationale. */
  includeInStatements: boolean("include_in_statements").notNull().default(true),
  createdAt:           timestamp("created_at").defaultNow().notNull(),
});

export const insertSupplierSchema = createInsertSchema(suppliersTable).omit({ id: true, createdAt: true });
export type InsertSupplier = z.infer<typeof insertSupplierSchema>;
export type Supplier = typeof suppliersTable.$inferSelect;
