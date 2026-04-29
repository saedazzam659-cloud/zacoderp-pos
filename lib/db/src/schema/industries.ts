import { pgTable, serial, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

// =====================================================================
// INDUSTRIES (activity types) — Super-admin managed catalogue.
//
// Each row defines a "نوع نشاط" (e.g. تجاري / صناعي / مقاولات) shown as
// a chip on the public registration wizard. When the user clicks a chip
// the listed `recommendedModuleKeys` are added to their selection (union
// across multiple chips), pre-bundling the right modules for that line
// of business.
//
// `recommendedModuleKeys` references `modules.key` (string) values. We
// store the array as JSONB so the SuperAdmin UI can edit the whole list
// in one PUT and Postgres does the typing for us. Keys that no longer
// exist (e.g. a module was deactivated) are silently filtered on render.
// =====================================================================
export const industriesTable = pgTable("industries", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),         // stable lookup key (commercial, industrial, …)
  nameAr: text("name_ar").notNull(),
  nameEn: text("name_en").notNull().default(""),
  emoji: text("emoji").notNull().default("🏢"),  // small visual cue on the chip
  recommendedModuleKeys: jsonb("recommended_module_keys")
    .$type<string[]>()
    .notNull()
    .default([]),
  // ── Per-industry default templates (SuperAdmin uploads) ────────────
  // Applied automatically when a NEW company picks this industry at
  // registration. Re-uploads REPLACE the stored template fully.
  // Keeping the JSON parsed-rows shape lets us restore an .xlsx download
  // and apply the rows in one DB round-trip without re-parsing files.
  coaTemplate: jsonb("coa_template").$type<any[] | null>(),
  coaTemplateUploadedAt: timestamp("coa_template_uploaded_at"),
  coaTemplateRowCount: integer("coa_template_row_count").notNull().default(0),
  mappingsTemplate: jsonb("mappings_template").$type<any[] | null>(),
  mappingsTemplateUploadedAt: timestamp("mappings_template_uploaded_at"),
  mappingsTemplateRowCount: integer("mappings_template_row_count").notNull().default(0),

  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Industry = typeof industriesTable.$inferSelect;
export type NewIndustry = typeof industriesTable.$inferInsert;
