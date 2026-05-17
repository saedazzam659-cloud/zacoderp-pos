// International accounting standards knowledge base.
//
// Curated bilingual reference for IFRS / US GAAP / ZATCA articles, used
// by the accounting-AI assistant for retrieval-augmented answers and by
// the standards-browser UI for direct lookup. Updated rarely (months,
// not days), so we keep the full text inline — no chunking / embeddings.
import { pgTable, serial, text, varchar, jsonb, timestamp } from "drizzle-orm/pg-core";

export const accountingStandardsKbTable = pgTable("accounting_standards_kb", {
  id:           serial("id").primaryKey(),
  // ifrs | gaap | zatca — used to scope searches in the UI.
  standard:     varchar("standard", { length: 16 }).notNull(),
  // Canonical code, e.g. "IFRS 15", "IAS 2", "ASC 606", "ZATCA-Art-53".
  // Unique so seed re-runs can ON CONFLICT DO NOTHING safely.
  code:         varchar("code", { length: 60 }).notNull().unique(),
  titleAr:      text("title_ar").notNull(),
  titleEn:      text("title_en"),
  summaryAr:    text("summary_ar").notNull(),       // ~2-3 sentences
  summaryEn:    text("summary_en"),
  fullTextAr:   text("full_text_ar").notNull(),     // expanded explanation
  fullTextEn:   text("full_text_en"),
  // Topic tags ("revenue", "inventory", "lease", "deferred-tax") used by
  // the UI filter chips and by retrieval ranking.
  tags:         jsonb("tags").$type<string[]>().notNull().default([]),
  // Optional links to authoritative sources (IFRS.org, FASB, ZATCA).
  // Column named source_refs because plain "references" is a reserved
  // word in Postgres (used for FK declarations) and triggers a parse error.
  sourceRefs:   jsonb("source_refs").$type<{ titleAr?: string; titleEn?: string; url: string }[]>()
                  .notNull().default([]),
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AccountingStandardsKbRow = typeof accountingStandardsKbTable.$inferSelect;
export type NewAccountingStandardsKbRow = typeof accountingStandardsKbTable.$inferInsert;
