import {
  pgTable, serial, integer, text, boolean, timestamp, jsonb, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Master list of transaction types known to the sequence engine.
// Frontend dropdown + backend validation share this list — keep in sync with
// any TX_TYPES re-export on the API server side.
export const SEQUENCE_TX_TYPES = [
  "sales_quotation",
  "sales_invoice",
  "sales_order",
  "sales_return",
  "purchase_invoice",
  "purchase_order",
  "purchase_return",
  "goods_receipt",
  "goods_delivery",
  "journal_entry",
  "stock_transfer",
  "stock_adjustment",
  "stock_count",
  "receipt_voucher",
  "payment_voucher",
  // Per-payment-method numbering sub-types (opt-in). When a company configures
  // a sequence bound to one of these, documents of that payment type draw from
  // it instead of the unified base type; otherwise they fall back to the base
  // type (`sales_invoice` / `purchase_invoice` / `receipt_voucher` /
  // `payment_voucher`). Only the human-readable document number is affected —
  // the ZATCA ICV/PIH cryptographic chain is NEVER split. Resolution lives in
  // `nextSequenceForPayment` (api-server lib/sequences.ts). Vouchers have no
  // credit variant (cash_payment_type enum = cash|bank).
  "sales_invoice_cash",
  "sales_invoice_credit",
  "sales_invoice_bank",
  "purchase_invoice_cash",
  "purchase_invoice_credit",
  "purchase_invoice_bank",
  "receipt_voucher_cash",
  "receipt_voucher_bank",
  "payment_voucher_cash",
  "payment_voucher_bank",
  "pos_receipt",
  // Production & Manufacturing — production_order is already issued by the
  // backend via nextSequenceNumber, declaring it here closes the type drift.
  "production_order",
  // Contracting Management — project codes and progress-bill numbers.
  "contracting_project",
  "contracting_bill",
  // Master data & operational documents wired through nextSequenceOrFallback.
  // Each entry below maps to an existing route's auto-code generator and falls
  // back to the legacy CC-####/EMP-####/INS#####/etc. pattern when no admin
  // sequence is configured — see artifacts/api-server/src/routes/* for wiring.
  "cost_center",
  "fixed_asset",
  "maintenance_order",
  "crm_lead",
  "hotel_booking",
  "installment_contract",
  "cash_transfer",
  "offer",
  "employee",
  "hr_contract",
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
  // Optional free-form pattern inserted between prefix and the padded
  // running number, with the following tokens substituted at issuance time:
  //   {MM}   → 2-digit month (01..12)
  //   {M}    → 1- or 2-digit month (1..12)
  //   {YY}   → 2-digit year   (e.g. "26")
  //   {YYYY} → 4-digit year   (e.g. "2026")
  // Examples (prefix="PR-", padLength=4, currentNumber=1):
  //   monthPattern = ""           → "PR-0001"     (legacy behaviour, default)
  //   monthPattern = "{MM}-"      → "PR-01-0001"
  //   monthPattern = "{YY}/{MM}/" → "PR-26/01/0001"
  // Optional — empty string keeps the prior format exactly.
  monthPattern:     text("month_pattern"),
  startNumber:      integer("start_number").notNull().default(1),
  endNumber:        integer("end_number").notNull().default(999999),
  currentNumber:    integer("current_number").notNull().default(1),  // NEXT to be issued
  padLength:        integer("pad_length").notNull().default(4),      // zero-pad width; 0 = no padding
  isActive:         boolean("is_active").notNull().default(true),
  // When true, the running counter restarts at `startNumber` at the beginning
  // of every new calendar month. Pairs naturally with a `{MM}` monthPattern so
  // each month produces a distinct stream (e.g. PR-01-0001, PR-02-0001…) and
  // never collides on the document-number unique index. Default false keeps
  // every existing tenant on a single continuous counter (legacy behaviour).
  // The actual month-change detection lives per-branch in
  // `sequence_counters.last_period` so each branch resets independently.
  monthlyReset:     boolean("monthly_reset").notNull().default(false),
  // Transaction types this sequence feeds. Stored as a JSON array of strings
  // matching SEQUENCE_TX_TYPES so the column stays portable across versions.
  transactionTypes: jsonb("transaction_types").notNull().default([]),
  // Optional whitelist of branch IDs allowed to use this sequence. Empty
  // array (the default) means "all branches" — preserves the prior behavior
  // for every existing tenant. When non-empty, only the listed branches may
  // issue from this sequence; other branches fall back to whatever sequence
  // resolution they would normally pick (or to a free-typed number when no
  // sequence applies). Stored as a JSON array of integers (branches.id).
  branchIds:        jsonb("branch_ids").notNull().default([]),
  // Optional whitelist of fiscal-period IDs this sequence applies to. Empty
  // array (the default) means "all periods" — keeps every existing tenant
  // on a single continuous counter regardless of fiscal year.
  //
  // When non-empty, this sequence is ONLY used for documents whose
  // effective date falls inside one of the listed periods. This lets
  // tenants run two separate counters across years (e.g. fiscal 2025
  // keeps INV-####, fiscal 2026 starts a fresh INV-2026-#### stream)
  // OR share a single counter across multiple periods (list them all).
  //
  // Resolution order in nextSequenceNumber: scoped sequences win over
  // unscoped ones for the same tx-type, so a tenant can keep a default
  // "any-period" sequence and add narrow overrides per fiscal year.
  // Stored as a JSON array of integers (fiscal_periods.id).
  fiscalPeriodIds:  jsonb("fiscal_period_ids").notNull().default([]),
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

// ─── Per-branch counter ─────────────────────────────────────────────────────
// Each (sequenceId, branchId) pair gets its OWN running counter. This makes
// branch numbering streams independent: branch A may issue INV-0001..0050
// while branch B is still on INV-0001..0010, with no collision within a branch.
// The master `sequences.currentNumber` field is preserved for legacy reasons
// (UI display + initial seed for existing tenants on first issue) but is no
// longer touched on issuance — the per-branch counter is the source of truth.
//
// `branchId = 0` is the sentinel used for company-wide / non-branched
// operations (e.g. stock_transfer, stock_adjustment, stock_count) so the
// composite uniqueness can stay a plain b-tree index without partial-index
// gymnastics. Real branches are always > 0 (branches.id is serial starting at 1).
export const sequenceCountersTable = pgTable("sequence_counters", {
  id:            serial("id").primaryKey(),
  sequenceId:    integer("sequence_id").notNull(),
  branchId:      integer("branch_id").notNull().default(0),
  // Period bucket for the counter. The key insight that makes monthly-reset
  // correct under out-of-order / backdated entry:
  //   • monthlyReset = false → ALWAYS the empty-string sentinel "". One single
  //     continuous counter row per (sequence, branch), exactly like before.
  //   • monthlyReset = true  → "YYYY-MM" of the document. EACH month gets its
  //     OWN counter row, so switching the entry month back and forth (or
  //     backdating) never resets or duplicates another month's stream. Month
  //     5's counter is completely independent of month 4's counter.
  // Replaces the old single-row + `lastPeriod` reset hack, which could only
  // remember ONE month at a time and produced wrong "next numbers" and
  // duplicate document numbers whenever months were entered out of order.
  period:        text("period").notNull().default(""),
  currentNumber: integer("current_number").notNull(),
  // "YYYY-MM" stamp of the most recent issuance on this row. Retained mainly
  // for the legacy-adoption path: when a sequence that previously ran WITHOUT
  // monthly reset (its single "" row) is toggled ON, the first issuance in the
  // current month adopts that row's running number (so it never reuses an
  // already-issued number), then stamps this field so later months reset
  // cleanly. NULL means "never stamped" (a pre-feature / freshly-inserted row).
  lastPeriod:    text("last_period"),
  createdAt:     timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:     timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  seqBranchPeriodUnique: uniqueIndex("sequence_counters_seq_branch_period_unq").on(t.sequenceId, t.branchId, t.period),
  bySequence:            index("sequence_counters_sequence_idx").on(t.sequenceId),
}));

export const insertSequenceSchema = createInsertSchema(sequencesTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertSequence = z.infer<typeof insertSequenceSchema>;
export type Sequence = typeof sequencesTable.$inferSelect;
export type SequenceLog = typeof sequenceLogsTable.$inferSelect;
export type SequenceCounter = typeof sequenceCountersTable.$inferSelect;
