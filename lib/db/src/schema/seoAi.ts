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
  // CSV of ISO-3166-1 alpha-2 country codes the article targets, plus the
  // sentinel "GLOBAL" which means "show everywhere as fallback". Stored as
  // text (not array) so plain `LIKE '%CODE%'` filtering works without
  // needing pg array operators in every callsite. Examples:
  //   "GLOBAL"
  //   "SA"
  //   "SA,AE,KW"
  // Filtering rule for visitor country X:
  //   target_countries LIKE '%X%' OR target_countries LIKE '%GLOBAL%'
  // so a country-specific article shows for matching visitors and the
  // GLOBAL fallback always shows when no country-specific match exists.
  targetCountries:  text("target_countries").notNull().default("GLOBAL"),
  createdByUserId:  integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt:        timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byStatus:    index("seo_articles_status_idx").on(t.status, t.createdAt),
  byCreatedAt: index("seo_articles_created_at_idx").on(t.createdAt),
  // Btree index on the CSV column. Note: `LIKE '%X%'` queries (used for
  // membership tests in the CSV) cannot use a standard btree because of
  // the leading wildcard — for that, a pg_trgm GIN index would be needed
  // and we'll add one when article volume grows enough to make latency
  // measurable. This index still helps the equality lookups we do for
  // the GLOBAL-only fast path and any future exact-match query plans.
  byTargetCountries: index("seo_articles_target_countries_idx").on(t.targetCountries),
}));

export type SeoGeneratedArticle = typeof seoGeneratedArticlesTable.$inferSelect;
export type NewSeoGeneratedArticle = typeof seoGeneratedArticlesTable.$inferInsert;
