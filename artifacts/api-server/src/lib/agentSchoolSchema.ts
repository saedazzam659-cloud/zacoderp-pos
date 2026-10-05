import { db, getActiveExternalDb } from "@workspace/db";
import { sql } from "drizzle-orm";
import { SCHOOL_ACADEMIC_CONTROL_DDL } from "./schoolAcademicControlSchema.js";

/**
 * School-module DDL for routed agent databases.
 *
 * The central schema remains Publish-managed. These additive statements run
 * only inside an external-agent database context, before strict schema checks.
 */
export const EXTERNAL_AGENT_SCHOOL_DDL = [
  `CREATE TABLE IF NOT EXISTS school_campuses (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
    code TEXT NOT NULL,
    name_ar TEXT NOT NULL,
    name_en TEXT,
    address TEXT,
    city TEXT,
    phone TEXT,
    email TEXT,
    manager_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_campuses_company_code UNIQUE (company_id, code)
  )`,
  `CREATE TABLE IF NOT EXISTS school_academic_years (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned',
    is_current BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_years_company_name UNIQUE (company_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS school_grades (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    name_ar TEXT NOT NULL,
    name_en TEXT,
    order_no INTEGER NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_grades_company_stage_name UNIQUE (company_id, stage, name_ar)
  )`,
  `CREATE TABLE IF NOT EXISTS school_students (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    student_number TEXT NOT NULL,
    full_name_ar TEXT NOT NULL,
    full_name_en TEXT,
    national_id TEXT,
    gender TEXT,
    birth_date DATE,
    phone TEXT,
    email TEXT,
    address TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_students_company_number UNIQUE (company_id, student_number)
  )`,
  `CREATE TABLE IF NOT EXISTS school_student_guardians (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES school_students(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    relationship TEXT NOT NULL DEFAULT 'guardian',
    phone TEXT,
    email TEXT,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    is_invoice_payer BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS school_classes (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    campus_id INTEGER REFERENCES school_campuses(id) ON DELETE RESTRICT,
    academic_year_id INTEGER NOT NULL REFERENCES school_academic_years(id) ON DELETE RESTRICT,
    grade_id INTEGER NOT NULL REFERENCES school_grades(id) ON DELETE RESTRICT,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    capacity INTEGER NOT NULL DEFAULT 0,
    class_teacher_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_classes_company_year_code UNIQUE (company_id, academic_year_id, code)
  )`,
  `CREATE TABLE IF NOT EXISTS school_enrollments (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES school_students(id) ON DELETE RESTRICT,
    academic_year_id INTEGER NOT NULL REFERENCES school_academic_years(id) ON DELETE RESTRICT,
    class_id INTEGER NOT NULL REFERENCES school_classes(id) ON DELETE RESTRICT,
    enrollment_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    annual_fee NUMERIC(15, 2) NOT NULL DEFAULT 0,
    discount_amount NUMERIC(15, 2) NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_enrollments_company_student_year UNIQUE (company_id, student_id, academic_year_id)
  )`,
  `CREATE TABLE IF NOT EXISTS school_attendance (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    enrollment_id INTEGER NOT NULL REFERENCES school_enrollments(id) ON DELETE RESTRICT,
    attendance_date DATE NOT NULL,
    period TEXT NOT NULL DEFAULT 'full_day',
    status TEXT NOT NULL,
    note TEXT,
    recorded_by_id INTEGER,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_attendance_enrollment_date_period
      UNIQUE (company_id, enrollment_id, attendance_date, period)
  )`,
  `CREATE TABLE IF NOT EXISTS school_subjects (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    name_ar TEXT NOT NULL,
    name_en TEXT,
    grade_id INTEGER REFERENCES school_grades(id) ON DELETE SET NULL,
    teacher_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_subjects_company_code UNIQUE (company_id, code)
  )`,
  `CREATE TABLE IF NOT EXISTS school_exams (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    academic_year_id INTEGER NOT NULL REFERENCES school_academic_years(id) ON DELETE RESTRICT,
    class_id INTEGER NOT NULL REFERENCES school_classes(id) ON DELETE RESTRICT,
    subject_id INTEGER NOT NULL REFERENCES school_subjects(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    exam_date DATE NOT NULL,
    max_score NUMERIC(10, 2) NOT NULL DEFAULT 100,
    status TEXT NOT NULL DEFAULT 'planned',
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS school_exam_results (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    exam_id INTEGER NOT NULL REFERENCES school_exams(id) ON DELETE RESTRICT,
    enrollment_id INTEGER NOT NULL REFERENCES school_enrollments(id) ON DELETE RESTRICT,
    score NUMERIC(10, 2) NOT NULL,
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_exam_results_exam_enrollment UNIQUE (company_id, exam_id, enrollment_id)
  )`,
  `CREATE TABLE IF NOT EXISTS school_fee_charges (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    enrollment_id INTEGER NOT NULL REFERENCES school_enrollments(id) ON DELETE RESTRICT,
    guardian_id INTEGER REFERENCES school_student_guardians(id) ON DELETE SET NULL,
    sales_invoice_id INTEGER REFERENCES sales_invoices(id) ON DELETE SET NULL,
    description TEXT NOT NULL,
    amount NUMERIC(15, 2) NOT NULL,
    due_date DATE,
    status TEXT NOT NULL DEFAULT 'planned',
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
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
    action TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS school_student_face_templates (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES school_students(id) ON DELETE CASCADE,
    consent_id INTEGER NOT NULL REFERENCES school_student_biometric_consents(id) ON DELETE CASCADE,
    descriptor_ciphertext TEXT NOT NULL,
    quality_score NUMERIC(7, 6) NOT NULL,
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
    event_type TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'face',
    camera_id INTEGER,
    confidence NUMERIC(7, 6) NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_student_attendance_event_per_day
      UNIQUE (company_id, enrollment_id, attendance_date, event_type)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_school_guardian_portal_links_company_account
    ON school_guardian_portal_links(company_id, account_id)`,
  `CREATE INDEX IF NOT EXISTS idx_school_biometric_consent_events_student
    ON school_biometric_consent_events(company_id, student_id, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_school_student_attendance_events_company_date
    ON school_student_attendance_events(company_id, attendance_date)`,
  ...SCHOOL_ACADEMIC_CONTROL_DDL,
] as const;

const schemaPromisesByPool = new WeakMap<object, Promise<void>>();

export async function ensureAgentSchoolSchema(): Promise<void> {
  const activeDb = getActiveExternalDb();
  if (!activeDb) return;

  const poolKey = activeDb.pool as object;
  const existing = schemaPromisesByPool.get(poolKey);
  if (existing) return existing;

  const pending = (async () => {
    for (const statement of EXTERNAL_AGENT_SCHOOL_DDL) {
      await db.execute(sql.raw(statement));
    }
  })();
  schemaPromisesByPool.set(poolKey, pending);

  try {
    await pending;
  } catch (error) {
    if (schemaPromisesByPool.get(poolKey) === pending) {
      schemaPromisesByPool.delete(poolKey);
    }
    throw error;
  }
}
