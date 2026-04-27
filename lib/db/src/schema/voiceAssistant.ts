import {
  pgTable, serial, integer, text, boolean, timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";

// ─── Voice Assistant — Per-company settings ──────────────────────────────────
//
// Exactly one row per company. Lazily created on first save: the API treats a
// missing row as "all defaults" so existing tenants keep working without a
// migration backfill.
//
// Why a dedicated table (not on `companies`)?
//   - Keeps the wide companies row from accumulating unrelated columns.
//   - Lets the Voice Assistant feature evolve (new fields, new policies) in
//     its own migration cadence.
export const voiceAssistantSettingsTable = pgTable("voice_assistant_settings", {
  id:                       serial("id").primaryKey(),
  companyId:                integer("company_id").notNull(),

  // Master switch. When false, the floating mic widget is hidden for the whole
  // company, /parse-command returns 503, and the page shows "ميزة معطلة".
  enabled:                  boolean("enabled").notNull().default(false),

  // When true, the widget requests mic permission immediately after login and
  // starts listening right away. When false, the user must click the FAB.
  autoActivateOnLogin:      boolean("auto_activate_on_login").notNull().default(false),

  // BCP-47 locale fed to the browser SpeechRecognition + Anthropic prompt.
  // "ar-SA" by default; "ar-EG", "en-US" etc. supported.
  language:                 text("language").notNull().default("ar-SA"),

  // Anthropic model used by the intent parser. Haiku is fast & cheap and is
  // more than enough for routing commands. Admins may upgrade to Sonnet for
  // ambiguous phrasing.
  aiModel:                  text("ai_model").notNull().default("claude-haiku-4-5"),

  // Optional wake-word (e.g. "النظام"). Reserved for future continuous mode;
  // current MVP uses push-to-talk so this field is informational only.
  wakeWord:                 text("wake_word"),

  // Minimum browser-reported confidence (0..100) below which we ignore the
  // utterance instead of bothering the AI. 0 = always parse.
  confidenceThreshold:      integer("confidence_threshold").notNull().default(50),

  // Free-text admin notes (audit / what's enabled where).
  notes:                    text("notes"),

  updatedByUserId:          integer("updated_by_user_id"),
  createdAt:                timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:                timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  oneRowPerCompany: uniqueIndex("voice_assistant_settings_company_idx").on(t.companyId),
}));

export type VoiceAssistantSettingsRow    = typeof voiceAssistantSettingsTable.$inferSelect;
export type VoiceAssistantSettingsInsert = typeof voiceAssistantSettingsTable.$inferInsert;

// ─── Voice Assistant — Command log ────────────────────────────────────────────
//
// Every recognised utterance is logged here so admins can audit what users said
// and which actions were executed. Stores the raw transcript, the parsed action
// JSON returned by the AI, and the final status (success / unrecognized / failed).
export const voiceCommandLogTable = pgTable("voice_command_log", {
  id:               serial("id").primaryKey(),
  companyId:        integer("company_id").notNull(),
  userId:           integer("user_id").notNull(),
  workSessionId:    integer("work_session_id"),                 // soft-link, may be null
  transcript:       text("transcript").notNull(),
  parsed:           jsonb("parsed"),                            // structured action JSON
  action:           text("action").notNull().default("unknown"),// kind: navigate | back | save | …
  route:            text("route"),                              // resolved route (if navigate)
  status:           text("status").notNull().default("success"),// success | unrecognized | failed
  confidence:       integer("confidence"),                      // 0..100 (browser-reported)
  errorMessage:     text("error_message"),
  contextRoute:     text("context_route"),                      // page user was on at the time
  createdAt:        timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byCompanyTime: index("voice_command_log_company_time_idx").on(t.companyId, t.createdAt),
  byUserTime:    index("voice_command_log_user_time_idx").on(t.userId, t.createdAt),
}));

export type VoiceCommandLogRow    = typeof voiceCommandLogTable.$inferSelect;
export type VoiceCommandLogInsert = typeof voiceCommandLogTable.$inferInsert;
