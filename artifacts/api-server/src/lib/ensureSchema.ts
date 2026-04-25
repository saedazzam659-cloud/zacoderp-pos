import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

let healPromise: Promise<void> | null = null;

async function runHeal(): Promise<void> {
  try {
    // Cover every column on users that was added incrementally over time so a
    // production DB that missed any single migration is healed in one shot.
    // Each statement is idempotent (IF NOT EXISTS) and Postgres ≥11 fills the
    // default value into existing rows in O(1) without rewriting the table.
    await db.execute(sql`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "code" text,
        ADD COLUMN IF NOT EXISTS "name_ar" text,
        ADD COLUMN IF NOT EXISTS "name_en" text,
        ADD COLUMN IF NOT EXISTS "permissions" jsonb,
        ADD COLUMN IF NOT EXISTS "view_all_branches" boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "notify_maintenance_email" boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "notify_maintenance_severity" text NOT NULL DEFAULT 'critical',
        ADD COLUMN IF NOT EXISTS "session_token" text,
        ADD COLUMN IF NOT EXISTS "session_id" text,
        ADD COLUMN IF NOT EXISTS "last_login_at" timestamp,
        ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "created_at" timestamp NOT NULL DEFAULT now(),
        ADD COLUMN IF NOT EXISTS "updated_at" timestamp NOT NULL DEFAULT now()
    `);
    logger.info("ensureSchema: users table columns verified");
  } catch (err) {
    logger.error({ err }, "ensureSchema: failed to verify users columns");
    throw err;
  }
}

/**
 * Idempotent self-healing migration that runs once on startup.
 * Adds critical columns that may be missing from production databases
 * when the deployment did not run a schema push.
 *
 * Uses ALTER TABLE ... ADD COLUMN IF NOT EXISTS so it is safe to run
 * repeatedly with no side-effects on already-up-to-date databases.
 */
export function ensureSchemaUpToDate(): Promise<void> {
  if (!healPromise) healPromise = runHeal();
  return healPromise;
}
