import {
  pgTable, serial, integer, text, boolean, timestamp, jsonb, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Master list of transaction types known to the sequence engine.
// Frontend dropdown + backend validation share this list — keep in sync with
// any TX_TYPES re-export on the API server side.
export const SEQUENCE_TX_TYPES = [
  "sales_invoice",
  "sales_return",
  "purchase_invoice",
  "purchase_return",
  "journal_entry",
  "stock_transfer",
  "stock_adjustment",
  "stock_count",
  "receipt_voucher",
  "payment_voucher",
  "pos_receipt",
] as const;

export type SequenceTxType = typeof SEQUENCE_TX_TYPES[number];

// Per-tenant numbering configuration. One sequence row produces a continuous
// stream of `${prefix}${pad(currentNumber)}` numbers for every transaction type
// it is bound to. `currentNumber` is the NEXT number to be issued.
//
// Multiple transaction types may share a single sequence (e.g. all stock docs
// on one counter), but only ONE active sequence may be bound to a given type
// at a time — the API enforces this on save and the helper picks the first
// active match deterministically (lowest id).
export const sequencesTable = pgTable("sequences", {
  id:               serial("id").primaryKey(),
  companyId:        integer("company_id").notNull(),
  code:             text("code").notNull(),                          // unique per company, used in UI
  nameAr:           text("name_ar").notNull(),
  nameEn:           text("name_en"),
  prefix:           text("prefix").notNull().default(""),            // e.g. "INV-", may be empty
  startNumber:      integer("start_number").notNull().default(1),
  endNumber:        integer("end_number").notNull().default(999999),
  currentNumber:    integer("current_number").notNull().default(1),  // NEXT to be issued
  padLength:        integer("pad_length").notNull().default(4),      // zero-pad width; 0 = no padding
  isActive:         boolean("is_active").notNull().default(true),
  // Transaction types this sequence feeds. Stored as a JSON array of strings
  // matching SEQUENCE_TX_TYPES so the column stays portable across versions.
  transactionTypes: jsonb("transaction_types").notNull().default([]),
  createdAt:        timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  companyCodeUnique: uniqueIndex("sequences_company_code_unique").on(t.companyId, t.code),
  byCompanyActive:   index("sequences_company_active_idx").on(t.companyId, t.isActive),
}));

// Append-only log of every number generated. Useful for auditing and for the
// "logs drawer" in the management UI. Kept lightweight (no FKs) so the table
// can be pruned independently if it grows.
export const sequenceLogsTable = pgTable("sequence_logs", {
  id:               serial("id").primaryKey(),
  sequenceId:       integer("sequence_id").notNull(),
  companyId:        integer("company_id").notNull(),
  transactionType:  text("transaction_type").notNull(),
  generatedNumber:  text("generated_number").notNull(),
  userId:           integer("user_id"),                              // nullable: system jobs
  refTable:         text("ref_table"),                               // e.g. "journal_entries"
  refId:            text("ref_id"),                                  // string for flexibility
  createdAt:        timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  bySeqTime:     index("sequence_logs_seq_time_idx").on(t.sequenceId, t.createdAt),
  byCompanyTime: index("sequence_logs_company_time_idx").on(t.companyId, t.createdAt),
}));

export const insertSequenceSchema = createInsertSchema(sequencesTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertSequence = z.infer<typeof insertSequenceSchema>;
export type Sequence = typeof sequencesTable.$inferSelect;
export type SequenceLog = typeof sequenceLogsTable.$inferSelect;
