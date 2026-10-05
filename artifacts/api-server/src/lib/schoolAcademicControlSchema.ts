import { db, getActiveExternalDb } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Additive school academic-control DDL. This follows the existing school
 * portal schema initializer and runs against the currently routed database.
 */
export const SCHOOL_ACADEMIC_CONTROL_DDL = [
  `CREATE TABLE IF NOT EXISTS school_academic_periods (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    academic_year_id INTEGER NOT NULL REFERENCES school_academic_years(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    period_type TEXT NOT NULL DEFAULT 'term',
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_academic_period_year_name UNIQUE (company_id, academic_year_id, name)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_school_academic_period_year_order
    ON school_academic_periods(company_id, academic_year_id, sort_order)`,
  `ALTER TABLE school_exams
    ADD COLUMN IF NOT EXISTS period_id INTEGER REFERENCES school_academic_periods(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS assessment_type TEXT NOT NULL DEFAULT 'coursework'`,
  `CREATE TABLE IF NOT EXISTS school_subject_offerings (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    academic_year_id INTEGER NOT NULL REFERENCES school_academic_years(id) ON DELETE RESTRICT,
    class_id INTEGER NOT NULL REFERENCES school_classes(id) ON DELETE RESTRICT,
    subject_id INTEGER NOT NULL REFERENCES school_subjects(id) ON DELETE RESTRICT,
    teacher_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_subject_offering_year_class_subject
      UNIQUE (company_id, academic_year_id, class_id, subject_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_school_subject_offerings_class
    ON school_subject_offerings(company_id, class_id)`,
  `CREATE TABLE IF NOT EXISTS school_grade_subject_policies (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    grade_id INTEGER NOT NULL REFERENCES school_grades(id) ON DELETE RESTRICT,
    subject_id INTEGER NOT NULL REFERENCES school_subjects(id) ON DELETE RESTRICT,
    subject_type TEXT NOT NULL,
    maximum_score NUMERIC(10, 2) NOT NULL,
    minimum_score NUMERIC(10, 2) NOT NULL,
    pass_mark_percent NUMERIC(5, 2) NOT NULL,
    second_round_percent NUMERIC(5, 2) NOT NULL,
    grade_bands JSONB NOT NULL DEFAULT '[]'::jsonb,
    midyear_weights JSONB NOT NULL DEFAULT '{}'::jsonb,
    year_end_weights JSONB NOT NULL DEFAULT '{}'::jsonb,
    show_daily_assessments_to_guardians BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_grade_subject_policy UNIQUE (company_id, grade_id, subject_id)
  )`,
  `CREATE TABLE IF NOT EXISTS school_daily_assessments (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    enrollment_id INTEGER NOT NULL REFERENCES school_enrollments(id) ON DELETE RESTRICT,
    subject_id INTEGER NOT NULL REFERENCES school_subjects(id) ON DELETE RESTRICT,
    period_id INTEGER NOT NULL REFERENCES school_academic_periods(id) ON DELETE RESTRICT,
    teacher_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    assessment_date DATE NOT NULL,
    attendance_discipline NUMERIC(5, 2),
    participation NUMERIC(5, 2),
    homework NUMERIC(5, 2),
    activity NUMERIC(5, 2),
    behavior NUMERIC(5, 2),
    teacher_evaluation NUMERIC(5, 2),
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_daily_assessment_enrollment_subject_date
      UNIQUE (company_id, enrollment_id, subject_id, assessment_date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_school_daily_assessment_company_date
    ON school_daily_assessments(company_id, assessment_date)`,
  `CREATE TABLE IF NOT EXISTS school_result_approvals (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    academic_year_id INTEGER NOT NULL REFERENCES school_academic_years(id) ON DELETE RESTRICT,
    period_id INTEGER NOT NULL REFERENCES school_academic_periods(id) ON DELETE RESTRICT,
    class_id INTEGER NOT NULL REFERENCES school_classes(id) ON DELETE RESTRICT,
    subject_id INTEGER NOT NULL REFERENCES school_subjects(id) ON DELETE RESTRICT,
    publication_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'approved',
    results_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
    approved_by_id INTEGER,
    approved_at TIMESTAMP NOT NULL DEFAULT NOW(),
    reopened_by_id INTEGER,
    reopened_at TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_school_result_approvals_scope
    ON school_result_approvals(company_id, academic_year_id, class_id, subject_id, period_id, status)`,
  `CREATE TABLE IF NOT EXISTS school_grade_audit_events (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    enrollment_id INTEGER REFERENCES school_enrollments(id) ON DELETE SET NULL,
    subject_id INTEGER REFERENCES school_subjects(id) ON DELETE SET NULL,
    entity_type TEXT NOT NULL,
    entity_id INTEGER,
    action TEXT NOT NULL,
    before_value JSONB,
    after_value JSONB,
    actor_id INTEGER,
    occurred_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_school_grade_audit_company_time
    ON school_grade_audit_events(company_id, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_school_grade_audit_student
    ON school_grade_audit_events(company_id, enrollment_id, occurred_at)`,
] as const;

const centralCacheKey = {};
const initializationByPool = new WeakMap<object, Promise<void>>();

export async function ensureSchoolAcademicControlSchema(): Promise<void> {
  const key = (getActiveExternalDb()?.pool as object | undefined) ?? centralCacheKey;
  const existing = initializationByPool.get(key);
  if (existing) return existing;
  const pending = (async () => {
    for (const statement of SCHOOL_ACADEMIC_CONTROL_DDL) {
      await db.execute(sql.raw(statement));
    }
  })();
  initializationByPool.set(key, pending);
  try {
    await pending;
  } catch (error) {
    if (initializationByPool.get(key) === pending) initializationByPool.delete(key);
    throw error;
  }
}
