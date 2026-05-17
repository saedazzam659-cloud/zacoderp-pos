import { pgTable, serial, integer, text, boolean, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { z } from "zod";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

export const DOCUMENT_TYPES = [
  "sales_invoice",
  "purchase_invoice",
  "sales_return",
  "purchase_return",
  "receipt_voucher",
  "payment_voucher",
  "bank_receipt",
  "treasury_receipt",
  "account_statement",
  "journal_entry",
] as const;

export type CustomPrintDocumentType = (typeof DOCUMENT_TYPES)[number];

export const customPrintTemplatesTable = pgTable(
  "custom_print_templates",
  {
    id:           serial("id").primaryKey(),
    companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
    documentType: text("document_type").notNull(),
    name:         text("name").notNull(),
    isDefault:    boolean("is_default").notNull().default(false),
    paperSize:    text("paper_size").notNull().default("A4"),
    widthMm:      integer("width_mm").notNull().default(210),
    heightMm:     integer("height_mm").notNull().default(297),
    layoutJson:   jsonb("layout_json").notNull().default({ elements: [] }),
    createdBy:    integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt:    timestamp("created_at", { withTimezone: false }).notNull().defaultNow(),
    updatedAt:    timestamp("updated_at", { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    byCompanyDoc: index("cpt_company_doc_idx").on(t.companyId, t.documentType),
  }),
);

export const insertCustomPrintTemplateSchema = z.object({
  companyId:    z.number().int().positive(),
  documentType: z.string().min(1),
  name:         z.string().min(1).max(120),
  isDefault:    z.boolean().optional(),
  paperSize:    z.string().optional(),
  widthMm:      z.number().int().positive().optional(),
  heightMm:     z.number().int().positive().optional(),
  layoutJson:   z.any().optional(),
  createdBy:    z.number().int().positive().nullable().optional(),
});

export type CustomPrintTemplate = typeof customPrintTemplatesTable.$inferSelect;
export type InsertCustomPrintTemplate = z.infer<typeof insertCustomPrintTemplateSchema>;
