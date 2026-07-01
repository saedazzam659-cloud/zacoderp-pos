import { pgTable, serial, text, boolean, timestamp, integer, numeric, uniqueIndex } from "drizzle-orm/pg-core";
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
  // ── Audit trail (who/where/when created the entry & posted it) ────────
  // All nullable: legacy rows + system-generated rows that pre-date this
  // column will read as NULL and the UI shows a dash. The fields are
  // captured at write time from the authenticated request — IP via
  // Express's trust-proxy chain, user-agent verbatim (capped at 500 chars),
  // and the user id straight from `req.authUser`. Country is resolved
  // on-demand by the audit endpoint via the same free Geo-IP service the
  // visitor-country middleware uses, so we don't need a column for it.
  createdBy:        integer("created_by"),
  createdIp:        text("created_ip"),
  createdUserAgent: text("created_user_agent"),
  postedBy:         integer("posted_by"),
  postedAt:         timestamp("posted_at"),
  postedIp:         text("posted_ip"),
  postedUserAgent:  text("posted_user_agent"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().notNull(),
});

// ─── Journal-entry number reservations (reuse-on-unpost→repost) ──────────────
// When a source document (invoice / return / voucher / …) is UNPOSTED, its
// linked journal entry is deleted (drafts have zero report impact). Before that
// delete we stash the JE's number here, keyed by the source document. On the
// next RE-POST the helper reuses the stashed number instead of consuming a new
// one from the "journal_entry" sequence — so an unpost→edit→repost cycle never
// leaves a permanent gap in the numbering. One live reservation per source
// document (UNIQUE company+sourceType+sourceId); it is deleted the moment it is
// consumed. Fully additive: when no reservation exists the helper falls back to
// the normal next-number behaviour.
export const jeNumberReservationsTable = pgTable("je_number_reservations", {
  id:         serial("id").primaryKey(),
  companyId:  integer("company_id").notNull(),
  sourceType: text("source_type").notNull(),   // e.g. "purchase_invoice", "sales_return"
  sourceId:   integer("source_id").notNull(),  // the source document's id
  docNumber:  text("doc_number").notNull(),    // the JE number to reuse
  branchId:   integer("branch_id"),            // captured for audit/back-compat
  createdAt:  timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  srcUnique: uniqueIndex("je_number_reservations_src_unq").on(t.companyId, t.sourceType, t.sourceId),
}));

export const journalEntryLinesTable = pgTable("journal_entry_lines", {
  id:           serial("id").primaryKey(),
  entryId:      integer("entry_id").references(() => journalEntriesTable.id, { onDelete: "cascade" }).notNull(),
  accountId:    integer("account_id").references(() => accountsTable.id),
  costCenter:   text("cost_center"),
  debit:        numeric("debit", { precision: 18, scale: 2 }).notNull().default("0"),
  credit:       numeric("credit", { precision: 18, scale: 2 }).notNull().default("0"),
  description:  text("description"),
  // Per-line supplier tax metadata (entered via the ⋮ dialog, mainly on VAT
  // "قيد الضريبة" lines). Mirrors payment_voucher_lines so a manual JE that
  // records input VAT can attribute the tax to a supplier and surface it in
  // the VAT report + tax account statement. Stored as text (date ISO YYYY-MM-DD).
  supplierName:          text("supplier_name"),
  supplierVatNumber:     text("supplier_vat_number"),
  supplierInvoiceNumber: text("supplier_invoice_number"),
  supplierInvoiceDate:   text("supplier_invoice_date"),
  sortOrder:    integer("sort_order").notNull().default(0),
});
