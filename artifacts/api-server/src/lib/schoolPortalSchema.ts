import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const statements = [
  `CREATE TABLE IF NOT EXISTS school_guardian_portal_accounts (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at TIMESTAMPTZ,
    created_by_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_guardian_portal_company_username UNIQUE (company_id, username)
  )`,
  `CREATE TABLE IF NOT EXISTS school_guardian_portal_links (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES school_guardian_portal_accounts(id) ON DELETE CASCADE,
    guardian_id INTEGER NOT NULL REFERENCES school_student_guardians(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_guardian_portal_link_account_guardian UNIQUE (account_id, guardian_id),
    CONSTRAINT uq_school_guardian_portal_link_guardian UNIQUE (guardian_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_school_guardian_portal_links_company_account
    ON school_guardian_portal_links(company_id, account_id)`,
  `CREATE TABLE IF NOT EXISTS school_student_biometric_consents (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES school_students(id) ON DELETE CASCADE,
    guardian_account_id INTEGER NOT NULL REFERENCES school_guardian_portal_accounts(id) ON DELETE CASCADE,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    policy_version TEXT NOT NULL,
    consented_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_student_biometric_consent
      UNIQUE (company_id, student_id, guardian_account_id)
  )`,
  `CREATE TABLE IF NOT EXISTS school_biometric_consent_events (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES school_students(id) ON DELETE CASCADE,
    guardian_account_id INTEGER NOT NULL REFERENCES school_guardian_portal_accounts(id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK (action IN ('granted', 'revoked')),
    policy_version TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_school_biometric_consent_events_student
    ON school_biometric_consent_events(company_id, student_id, occurred_at)`,
  `CREATE TABLE IF NOT EXISTS school_student_face_templates (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES school_students(id) ON DELETE CASCADE,
    consent_id INTEGER NOT NULL REFERENCES school_student_biometric_consents(id) ON DELETE CASCADE,
    descriptor_ciphertext TEXT NOT NULL,
    quality_score NUMERIC(7, 6) NOT NULL CHECK (quality_score >= 0 AND quality_score <= 1),
    enrolled_by_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_student_face_template UNIQUE (company_id, student_id)
  )`,
  `CREATE TABLE IF NOT EXISTS school_student_attendance_events (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    enrollment_id INTEGER NOT NULL REFERENCES school_enrollments(id) ON DELETE RESTRICT,
    attendance_date DATE NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('arrival', 'departure')),
    source TEXT NOT NULL DEFAULT 'face',
    camera_id INTEGER,
    confidence NUMERIC(7, 6) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_student_attendance_event_per_day
      UNIQUE (company_id, enrollment_id, attendance_date, event_type)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_school_student_attendance_events_company_date
    ON school_student_attendance_events(company_id, attendance_date)`,
];

let schemaPromise: Promise<void> | null = null;

export function ensureSchoolPortalSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      for (const statement of statements) {
        await db.execute(sql.raw(statement));
      }
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

export async function lockStudentBiometrics(tx: any, companyId: number, studentId: number): Promise<void> {
  const key = `school-biometric:${companyId}:${studentId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}
