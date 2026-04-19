import { pgTable, serial, text, integer, numeric, timestamp, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { customersTable } from "./customers";

export const invoicesTable = pgTable("invoices", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id),
  customerId: integer("customer_id").references(() => customersTable.id),
  invoiceNumber: text("invoice_number").notNull().unique(),
  invoiceType: text("invoice_type").notNull().default("standard"),
  status: text("status").notNull().default("draft"),
  issueDate: date("issue_date").notNull(),
  supplyDate: date("supply_date"),
  dueDate: date("due_date"),
  currency: text("currency").notNull().default("SAR"),
  subtotal: numeric("subtotal", { precision: 14, scale: 2 }).notNull().default("0"),
  discountTotal: numeric("discount_total", { precision: 14, scale: 2 }).notNull().default("0"),
  vatTotal: numeric("vat_total", { precision: 14, scale: 2 }).notNull().default("0"),
  grandTotal: numeric("grand_total", { precision: 14, scale: 2 }).notNull().default("0"),
  notes: text("notes"),
  qrCode: text("qr_code"),
  invoiceHash: text("invoice_hash"),
  xmlContent: text("xml_content"),
  invoiceCounterValue: integer("invoice_counter_value").default(0),
  previousInvoiceHash: text("previous_invoice_hash"),
  zatcaStatus: text("zatca_status").default("pending"),
  zatcaResponseCode: text("zatca_response_code"),
  zatcaWarningMessages: text("zatca_warning_messages"),
  zatcaErrorMessages: text("zatca_error_messages"),
  zatcaClearanceStatus: text("zatca_clearance_status"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const invoiceLineItemsTable = pgTable("invoice_line_items", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull().references(() => invoicesTable.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
  unitPrice: numeric("unit_price", { precision: 14, scale: 2 }).notNull(),
  discountAmount: numeric("discount_amount", { precision: 14, scale: 2 }).notNull().default("0"),
  vatRate: numeric("vat_rate", { precision: 6, scale: 2 }).notNull().default("15"),
  vatAmount: numeric("vat_amount", { precision: 14, scale: 2 }).notNull().default("0"),
  subtotal: numeric("subtotal", { precision: 14, scale: 2 }).notNull().default("0"),
  total: numeric("total", { precision: 14, scale: 2 }).notNull().default("0"),
});

export const insertInvoiceSchema = createInsertSchema(invoicesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertLineItemSchema = createInsertSchema(invoiceLineItemsTable).omit({ id: true });
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type Invoice = typeof invoicesTable.$inferSelect;
export type InvoiceLineItem = typeof invoiceLineItemsTable.$inferSelect;
