import { pgTable, serial, text, boolean, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { accountsTable } from "./accounts";
import { branchesTable } from "./branches";

export const journalEntriesTable = pgTable("journal_entries", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").references(() => companiesTable.id).notNull(),
  docNumber:    text("doc_number"),
  entryDate:    text("entry_date").notNull(),
  currency:     text("currency").notNull().default("SAR"),
  exchangeRate: numeric("exchange_rate", { precision: 18, scale: 6 }).notNull().default("1"),
  description:  text("description"),
  entryType:    text("entry_type").notNull().default("general"),
  branchId:     integer("branch_id").references(() => branchesTable.id),
  // Resolved fiscal period the entry falls into. Nullable so existing rows
  // remain valid until backfilled; new rows are auto-resolved at write time.
  periodId:     integer("period_id"),
  status:       text("status").notNull().default("draft"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().notNull(),
});

export const journalEntryLinesTable = pgTable("journal_entry_lines", {
  id:           serial("id").primaryKey(),
  entryId:      integer("entry_id").references(() => journalEntriesTable.id, { onDelete: "cascade" }).notNull(),
  accountId:    integer("account_id").references(() => accountsTable.id),
  costCenter:   text("cost_center"),
  debit:        numeric("debit", { precision: 18, scale: 2 }).notNull().default("0"),
  credit:       numeric("credit", { precision: 18, scale: 2 }).notNull().default("0"),
  description:  text("description"),
  sortOrder:    integer("sort_order").notNull().default(0),
});
