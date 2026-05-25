import { pgTable, serial, text, integer, timestamp, numeric, boolean, date, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

// ─── Standalone Credit / Debit Notes (إشعارات دائنة ومدينة) ──────────────
// Pure-accounting notes that adjust a customer's or supplier's balance
// independently of any sales/purchase invoice or stock movement.
//
// Why a single unified table (instead of 4 separate tables):
//   • Identical shape across the 4 variants (party + amount + optional VAT
//     + 2 GL accounts). Splitting into 4 tables would 4× the schema noise,
//     repeat the same indexes, and force the API/UI/statement code to
//     fan-out for no business reason. The (partyType, noteType) pair is
//     the only thing that differs, so it lives in 2 enum columns.
//
// NOT linked to a specific invoice — these are free-form accounting
// adjustments. ZATCA UBL Credit/Debit Notes (which MUST reference an
// invoice) are still produced by `sales_returns` / `purchase_returns`;
// these notes do NOT submit to ZATCA.
//
// `partyId` is intentionally NOT a hard FK — it points at either
// `customers.id` or `suppliers.id` depending on `partyType`. The route
// validates the FK belongs to the same company before insert.
export const accountNotePartyTypeEnum = pgEnum("account_note_party_type", ["customer", "supplier"]);
export const accountNoteTypeEnum      = pgEnum("account_note_type",       ["credit", "debit"]);
export const accountNoteStatusEnum    = pgEnum("account_note_status",     ["draft", "posted", "cancelled"]);

export const accountNotesTable = pgTable("account_notes", {
  id:               serial("id").primaryKey(),
  companyId:        integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:         integer("branch_id"),
  noteNumber:       text("note_number").notNull(),
  noteDate:         date("note_date").notNull(),
  partyType:        accountNotePartyTypeEnum("party_type").notNull(),
  noteType:         accountNoteTypeEnum("note_type").notNull(),
  // FK target depends on partyType — `customers.id` or `suppliers.id`.
  partyId:          integer("party_id").notNull(),
  // The receivable/payable control account for the party (DR/CR side).
  partyAccountId:   integer("party_account_id").notNull(),
  // The contra account (income/expense/discount) the user picks per note.
  contraAccountId:  integer("contra_account_id").notNull(),
  amount:           numeric("amount",      { precision: 18, scale: 4 }).notNull().default("0"),
  vatEnabled:       boolean("vat_enabled").notNull().default(false),
  vatRate:          numeric("vat_rate",    { precision: 5,  scale: 2 }).notNull().default("15"),
  vatAccountId:     integer("vat_account_id"),
  vatAmount:        numeric("vat_amount",  { precision: 18, scale: 4 }).notNull().default("0"),
  totalAmount:      numeric("total_amount",{ precision: 18, scale: 4 }).notNull().default("0"),
  description:      text("description"),
  notes:            text("notes"),
  // ── Optional metadata fields (added to mirror the voucher form) ─────
  // operationNumber: free-text reference to an internal operation/ticket
  // referenceNumber + referenceDate: external document being noted
  // costCenter:      stores the cost-centre CODE (matches JE line convention)
  // projectId:       soft-ref to `contracting_projects.id` (no hard FK,
  //                  same pattern as `partyId` above)
  operationNumber:  text("operation_number"),
  referenceNumber:  text("reference_number"),
  referenceDate:    date("reference_date"),
  costCenter:       text("cost_center"),
  projectId:        integer("project_id"),
  status:           accountNoteStatusEnum("status").notNull().default("draft"),
  journalEntryId:   integer("journal_entry_id"),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
  updatedAt:        timestamp("updated_at").defaultNow().notNull(),
  createdBy:        integer("created_by"),
});

export const insertAccountNoteSchema = createInsertSchema(accountNotesTable).omit({
  id: true, createdAt: true, updatedAt: true, journalEntryId: true, status: true,
});

export type AccountNote       = typeof accountNotesTable.$inferSelect;
export type InsertAccountNote = z.infer<typeof insertAccountNoteSchema>;
