import { pgTable, serial, text, integer, timestamp, numeric } from "drizzle-orm/pg-core";

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
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCustomerSchema = createInsertSchema(customersTable).omit({ id: true, createdAt: true });
export type InsertCustomer = z.infer<typeof insertCustomerSchema>;
export type Customer = typeof customersTable.$inferSelect;
