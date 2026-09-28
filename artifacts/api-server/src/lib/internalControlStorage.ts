import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Additive central/agent reconciliation, invoked from the existing schema heal.
export async function ensureInternalControlSchema() {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS internal_control_cases (
      id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, branch_id INTEGER,
      rule_key TEXT NOT NULL, event_key TEXT NOT NULL, category TEXT NOT NULL,
      source TEXT NOT NULL, document_type TEXT NOT NULL, document_id TEXT NOT NULL,
      document_number TEXT, project_id INTEGER, customer_id INTEGER, supplier_id INTEGER,
      user_id INTEGER, approver_id INTEGER, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      description TEXT NOT NULL, reason TEXT NOT NULL, severity TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', reviewer_id INTEGER, reviewer_notes TEXT,
      action_taken TEXT, resolved_at TIMESTAMPTZ, document_url TEXT,
      evidence JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS internal_control_case_event_uq ON internal_control_cases(company_id,rule_key,event_key);
    CREATE INDEX IF NOT EXISTS internal_control_case_scope_idx ON internal_control_cases(company_id,branch_id,created_at);
    CREATE TABLE IF NOT EXISTS internal_control_rules (
      id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, key TEXT NOT NULL,
      config JSONB NOT NULL DEFAULT '{}', updated_by INTEGER, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS internal_control_rule_company_uq ON internal_control_rules(company_id,key);
    CREATE TABLE IF NOT EXISTS internal_control_history (
      id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, case_id INTEGER, user_id INTEGER,
      action TEXT NOT NULL, from_status TEXT, to_status TEXT, note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS internal_control_history_scope_idx ON internal_control_history(company_id,case_id,created_at);
  `));
}