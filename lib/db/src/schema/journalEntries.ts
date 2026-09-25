import { pgTable, serial, text, boolean, timestamp, integer, numeric, uniqueIndex, index } from "drizzle-orm/pg-core";
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
  // ── سداد فاتورة عن طريق قيد محاسبي (اختياري، آجل فقط) ────────────────
  // A MANUAL journal entry may settle a credit invoice, same policy as
  // receipt/payment vouchers: settlementAmount (in entry currency) counts
  // toward the invoice's paid total and may never exceed the remaining due
  // (drafts count too). Exactly one of the two links may be set.
  salesInvoiceId:    integer("sales_invoice_id"),
  purchaseInvoiceId: integer("purchase_invoice_id"),
  settlementAmount:  numeric("settlement_amount", { precision: 18, scale: 2 }),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  companyCreatedIdx: index("journal_entries_company_created_idx").on(t.companyId, t.createdAt.desc()),
  // Match the tenant/branch/date list predicate without imposing uniqueness on
  // existing accounting data. PostgreSQL can also scan this backwards for the
  // legacy created-at ordering.
  companyBranchCreatedIdx: index("journal_entries_company_branch_created_idx").on(t.companyId, t.branchId, t.createdAt.desc()),
  companyStatusDateIdx: index("journal_entries_company_status_date_idx").on(t.companyId, t.status, t.entryDate),
  companyDateIdx: index("journal_entries_company_date_idx").on(t.companyId, t.entryDate),
}));

// ─── Partial settlement links (سداد جزئي متعدد الفواتير) ─────────────────────
// A manual JE / receipt voucher / payment voucher can settle SEVERAL invoices,
// each link consuming part of the source document's amount. The legacy header
// links above (salesInvoiceId/purchaseInvoiceId + settlementAmount on JEs,
// header FK on vouchers) remain valid and keep counting — this table is
// ADDITIVE. `amount` is in the SOURCE document's currency; base = amount ×
// source exchangeRate. Exactly one of the two invoice FKs is set per row.
export const settlementLinksTable = pgTable("settlement_links", {
  id:                serial("id").primaryKey(),
  companyId:         integer("company_id").notNull(),
  sourceType:        text("source_type").notNull(), // "je" | "receipt_voucher" | "payment_voucher"
  sourceId:          integer("source_id").notNull(),
  salesInvoiceId:    integer("sales_invoice_id"),
  purchaseInvoiceId: integer("purchase_invoice_id"),
  amount:            numeric("amount", { precision: 18, scale: 2 }).notNull(),
  createdBy:         integer("created_by"),
  createdAt:         timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
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
  projectId:    integer("project_id"),
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
}, (t) => ({
  // Keeps page-only line aggregation and debit/credit ordering index-backed.
  entryIdIdx: index("journal_entry_lines_entry_idx").on(t.entryId),
}));
