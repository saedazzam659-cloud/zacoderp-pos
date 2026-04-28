import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// AI-generated SEO articles. Used by the SuperAdmin SEO AI Studio screen
// to draft, store, and (eventually) publish content aimed at boosting
// site traffic. Status flow: draft → reviewed → published. The actual
// publishing pipeline is out of scope for v1; we just persist drafts and
// let SuperAdmin export/copy them.
export const seoGeneratedArticlesTable = pgTable("seo_generated_articles", {
  id:               serial("id").primaryKey(),
  title:            text("title").notNull(),
  slug:             text("slug").notNull(),
  metaDescription:  text("meta_description").notNull().default(""),
  content:          text("content").notNull(),               // markdown body
  targetKeyword:    text("target_keyword").notNull().default(""),
  // Free-text topic the user typed OR a short label of the recommendation
  // that seeded this article (e.g. "rec:add-articles-zatca-phase-2").
  sourceTopic:      text("source_topic").notNull().default(""),
  aiModel:          text("ai_model").notNull().default(""),  // model id used
  status:           text("status").notNull().default("draft"), // draft|reviewed|published
  createdByUserId:  integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt:        timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byStatus:    index("seo_articles_status_idx").on(t.status, t.createdAt),
  byCreatedAt: index("seo_articles_created_at_idx").on(t.createdAt),
}));

export type SeoGeneratedArticle = typeof seoGeneratedArticlesTable.$inferSelect;
export type NewSeoGeneratedArticle = typeof seoGeneratedArticlesTable.$inferInsert;
