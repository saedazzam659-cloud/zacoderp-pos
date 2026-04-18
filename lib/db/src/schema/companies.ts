import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";
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
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertCompanySchema = createInsertSchema(companiesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCompany = z.infer<typeof insertCompanySchema>;
export type Company = typeof companiesTable.$inferSelect;
