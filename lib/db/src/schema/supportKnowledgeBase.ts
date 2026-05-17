// Support-assistant knowledge base.
//
// Holds bilingual (Arabic primary, English secondary) Q&A entries used by
// the in-app support assistant. The AI assistant retrieves the top-N
// matching rows via keyword search, then synthesises an answer; if AI is
// unavailable the highest-scoring row is returned verbatim.
import { pgTable, serial, text, varchar, jsonb, timestamp, integer } from "drizzle-orm/pg-core";

export const supportKnowledgeBaseTable = pgTable("support_knowledge_base", {
  id:          serial("id").primaryKey(),
  slug:        varchar("slug", { length: 120 }).notNull().unique(),
  category:    varchar("category", { length: 60 }).notNull(),  // zatca | invoicing | inventory | accounting | pos | users | reports | general
  questionAr:  text("question_ar").notNull(),
  questionEn:  text("question_en"),
  answerAr:    text("answer_ar").notNull(),
  answerEn:    text("answer_en"),
  // Free-form keywords (Arabic + English) for the LIKE/ILIKE retrieval —
  // we don't have embeddings, so the seed authors hand-pick the words a
  // user might actually type.
  keywords:    jsonb("keywords").$type<string[]>().notNull().default([]),
  // Optional list of page-path prefixes ("/sales/invoices", "/inventory")
  // where this entry is most relevant — we boost rows whose prefix matches
  // the caller's current page.
  pageHints:   jsonb("page_hints").$type<string[]>().notNull().default([]),
  // Lightweight feedback loop: thumbs-up / thumbs-down counters updated
  // when users react to an AI answer that cited this row.
  helpfulCount:    integer("helpful_count").notNull().default(0),
  notHelpfulCount: integer("not_helpful_count").notNull().default(0),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SupportKnowledgeBaseRow = typeof supportKnowledgeBaseTable.$inferSelect;
export type NewSupportKnowledgeBaseRow = typeof supportKnowledgeBaseTable.$inferInsert;
