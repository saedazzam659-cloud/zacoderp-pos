import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";

// Short-lived, single-use pre-authentication challenges. Shared PostgreSQL
// storage is required because the production API runs in PM2 cluster mode.
export const agentLoginCaptchaChallengesTable = pgTable("agent_login_captcha_challenges", {
  sessionHash: text("session_hash").primaryKey(),
  host: text("host").notNull(),
  nonce: text("nonce").notNull(),
  answerDigest: text("answer_digest").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("agent_login_captcha_expires_at_idx").on(table.expiresAt),
]);
