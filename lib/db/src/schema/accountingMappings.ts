import { pgTable, serial, integer, text, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { accountsTable } from "./accounts";

export const accountingMappingsTable = pgTable("accounting_mappings", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  documentType: text("document_type").notNull(),
  roleKey:      text("role_key").notNull(),
  accountId:    integer("account_id").references(() => accountsTable.id, { onDelete: "set null" }),
  isLocked:     boolean("is_locked").notNull().default(false),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  uniq: uniqueIndex("acc_map_company_doc_role_uniq").on(t.companyId, t.documentType, t.roleKey),
}));

export type AccountingMapping = typeof accountingMappingsTable.$inferSelect;
