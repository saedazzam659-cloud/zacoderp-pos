// Per-company AI feature controls + usage tracking.
//
// Two tables:
//   ai_feature_settings — per-(company, feature_key) toggle + daily/monthly
//                         quota. Missing row => use the system default
//                         (enabled, generous limit). Lets the SuperAdmin
//                         kill or throttle AI on a per-tenant basis from
//                         /admin/ai-controls.
//   ai_usage_log        — append-only log of every AI invocation:
//                         allowed/blocked/limit/error, token counts, ms.
//                         Used to compute "X / Y today" in the dashboard
//                         and to enforce the quota in the middleware.
import {
  pgTable, serial, integer, varchar, boolean, timestamp, jsonb, text, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const aiFeatureSettingsTable = pgTable("ai_feature_settings", {
  id:            serial("id").primaryKey(),
  // NULL company_id = system default for that feature key.
  companyId:     integer("company_id"),
  featureKey:    varchar("feature_key", { length: 64 }).notNull(),
  isEnabled:     boolean("is_enabled").notNull().default(true),
  // null = unlimited.
  dailyLimit:    integer("daily_limit"),
  monthlyLimit:  integer("monthly_limit"),
  // Free-form note shown in the admin UI ("Disabled by SA on 2026-05-19 — abuse").
  note:          text("note"),
  updatedBy:     integer("updated_by"),
  updatedAt:     timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  // NOTE: Postgres treats NULLs as distinct in standard unique indexes, so
  // multiple "system default" rows (company_id IS NULL) for the same key
  // would still be possible. The DELETE-before-INSERT pattern in
  // admin-ai-controls.ts is what actually keeps system defaults singular;
  // this index gives us the per-company uniqueness guarantee.
  uniqByCompanyFeature: uniqueIndex("ai_feature_settings_company_feature_uniq")
                          .on(t.companyId, t.featureKey),
}));

export const aiUsageLogTable = pgTable("ai_usage_log", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id"),
  userId:       integer("user_id"),
  featureKey:   varchar("feature_key", { length: 64 }).notNull(),
  // allowed | blocked_disabled | blocked_daily_limit | blocked_monthly_limit | error
  status:       varchar("status", { length: 32 }).notNull(),
  // Provider that actually answered (openai/anthropic/kb/none).
  provider:     varchar("provider", { length: 24 }),
  // Best-effort token accounting; null when the provider doesn't report.
  tokensIn:     integer("tokens_in"),
  tokensOut:    integer("tokens_out"),
  durationMs:   integer("duration_ms"),
  meta:         jsonb("meta").$type<Record<string, unknown>>(),
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  byCompanyFeatureDate: index("ai_usage_log_company_feature_date_idx")
                           .on(t.companyId, t.featureKey, t.createdAt),
}));

export type AiFeatureSettingsRow    = typeof aiFeatureSettingsTable.$inferSelect;
export type NewAiFeatureSettingsRow = typeof aiFeatureSettingsTable.$inferInsert;
export type AiUsageLogRow           = typeof aiUsageLogTable.$inferSelect;
export type NewAiUsageLogRow        = typeof aiUsageLogTable.$inferInsert;

// Canonical list of AI features the system exposes. Kept here so the
// admin UI and the middleware agree on the keys. Add new ones at the
// bottom — never rename (the key is persisted in ai_usage_log).
export const AI_FEATURE_CATALOG = [
  { key: "accounting_ai_ask",     labelAr: "مستشار المعايير المحاسبية (سؤال وجواب)",     defaultDaily: 100 },
  { key: "seo_article_gen",       labelAr: "توليد مقالات SEO (مدفوع — OpenAI)",          defaultDaily: 10  },
  { key: "seo_suggestions",       labelAr: "اقتراحات عناوين SEO",                          defaultDaily: 50  },
  { key: "report_analyzer",       labelAr: "محلل التقارير المالية بالذكاء الاصطناعي",      defaultDaily: 50  },
  { key: "chat_assistant",        labelAr: "المساعد العام داخل الشاشات",                   defaultDaily: 200 },
  { key: "voice_actions",         labelAr: "أوامر صوتية للذكاء الاصطناعي",                 defaultDaily: 100 },
  { key: "product_descriptions",  labelAr: "توليد أوصاف المنتجات",                          defaultDaily: 50  },
  { key: "crm_ai",                labelAr: "تحليلات CRM",                                   defaultDaily: 50  },
  { key: "support_ai",            labelAr: "مساعد الدعم الفني",                            defaultDaily: 50  },
  { key: "online_store_ai",       labelAr: "تحليلات المتجر الإلكتروني",                    defaultDaily: 50  },
  { key: "pos_ai",                labelAr: "تحليلات نقاط البيع",                            defaultDaily: 50  },
  { key: "manufacturing_ai",      labelAr: "مساعد التصنيع",                                 defaultDaily: 50  },
  { key: "hr_ai",                 labelAr: "تحليلات الموارد البشرية",                       defaultDaily: 50  },
  { key: "fixed_assets_ai",       labelAr: "تحليلات الأصول الثابتة",                        defaultDaily: 50  },
  { key: "contracting_ai",        labelAr: "تحليلات المقاولات",                             defaultDaily: 50  },
  { key: "hotel_ai",              labelAr: "تحليلات الفنادق",                               defaultDaily: 50  },
  { key: "hospital_ai",           labelAr: "تحليلات المستشفيات",                            defaultDaily: 50  },
  { key: "tax_entry_ai",          labelAr: "إدخال القيد الضريبي بالذكاء الاصطناعي",         defaultDaily: 100 },
] as const;

export type AiFeatureKey = typeof AI_FEATURE_CATALOG[number]["key"];
