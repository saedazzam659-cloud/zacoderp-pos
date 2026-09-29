import { pgTable, integer, text, jsonb, primaryKey } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
export const documentExpensesTable = pgTable("document_expenses", {
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  documentType: text("document_type").notNull(),
  documentId: integer("document_id").notNull(),
  version: integer("version").notNull().default(0),
  rows: jsonb("rows").notNull().default([]),
}, t => ({ pk: primaryKey({ columns: [t.companyId, t.documentType, t.documentId] }) }));