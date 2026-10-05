import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { employeesTable } from "./hr";
import {
  schoolAcademicYearsTable,
  schoolClassesTable,
  schoolEnrollmentsTable,
  schoolGradesTable,
  schoolSubjectsTable,
} from "./schools";

export const schoolAcademicPeriodsTable = pgTable("school_academic_periods", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  academicYearId: integer("academic_year_id").notNull()
    .references(() => schoolAcademicYearsTable.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  periodType: text("period_type").notNull().default("term"),
  startDate: date("start_date", { mode: "string" }).notNull(),
  endDate: date("end_date", { mode: "string" }).notNull(),
  sortOrder: integer("sort_order").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  yearNameUq: unique("uq_school_academic_period_year_name").on(table.companyId, table.academicYearId, table.name),
  yearOrderIdx: index("idx_school_academic_period_year_order").on(table.companyId, table.academicYearId, table.sortOrder),
}));

export const schoolSubjectOfferingsTable = pgTable("school_subject_offerings", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  academicYearId: integer("academic_year_id").notNull()
    .references(() => schoolAcademicYearsTable.id, { onDelete: "restrict" }),
  classId: integer("class_id").notNull().references(() => schoolClassesTable.id, { onDelete: "restrict" }),
  subjectId: integer("subject_id").notNull().references(() => schoolSubjectsTable.id, { onDelete: "restrict" }),
  teacherEmployeeId: integer("teacher_employee_id").references(() => employeesTable.id, { onDelete: "set null" }),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  classSubjectUq: unique("uq_school_subject_offering_year_class_subject")
    .on(table.companyId, table.academicYearId, table.classId, table.subjectId),
  classIdx: index("idx_school_subject_offerings_class").on(table.companyId, table.classId),
}));

export const schoolGradeSubjectPoliciesTable = pgTable("school_grade_subject_policies", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  gradeId: integer("grade_id").notNull().references(() => schoolGradesTable.id, { onDelete: "restrict" }),
  subjectId: integer("subject_id").notNull().references(() => schoolSubjectsTable.id, { onDelete: "restrict" }),
  subjectType: text("subject_type").notNull(),
  maximumScore: numeric("maximum_score", { precision: 10, scale: 2 }).notNull(),
  minimumScore: numeric("minimum_score", { precision: 10, scale: 2 }).notNull(),
  passMarkPercent: numeric("pass_mark_percent", { precision: 5, scale: 2 }).notNull(),
  secondRoundPercent: numeric("second_round_percent", { precision: 5, scale: 2 }).notNull(),
  gradeBands: jsonb("grade_bands").notNull().default([]),
  midyearWeights: jsonb("midyear_weights").notNull().default({}),
  yearEndWeights: jsonb("year_end_weights").notNull().default({}),
  showDailyAssessmentsToGuardians: boolean("show_daily_assessments_to_guardians").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  gradeSubjectUq: unique("uq_school_grade_subject_policy").on(table.companyId, table.gradeId, table.subjectId),
}));

export const schoolDailyAssessmentsTable = pgTable("school_daily_assessments", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  enrollmentId: integer("enrollment_id").notNull()
    .references(() => schoolEnrollmentsTable.id, { onDelete: "restrict" }),
  subjectId: integer("subject_id").notNull().references(() => schoolSubjectsTable.id, { onDelete: "restrict" }),
  periodId: integer("period_id").notNull()
    .references(() => schoolAcademicPeriodsTable.id, { onDelete: "restrict" }),
  teacherEmployeeId: integer("teacher_employee_id").references(() => employeesTable.id, { onDelete: "set null" }),
  assessmentDate: date("assessment_date", { mode: "string" }).notNull(),
  attendanceDiscipline: numeric("attendance_discipline", { precision: 5, scale: 2 }),
  participation: numeric("participation", { precision: 5, scale: 2 }),
  homework: numeric("homework", { precision: 5, scale: 2 }),
  activity: numeric("activity", { precision: 5, scale: 2 }),
  behavior: numeric("behavior", { precision: 5, scale: 2 }),
  teacherEvaluation: numeric("teacher_evaluation", { precision: 5, scale: 2 }),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  enrollmentSubjectDateUq: unique("uq_school_daily_assessment_enrollment_subject_date")
    .on(table.companyId, table.enrollmentId, table.subjectId, table.assessmentDate),
  companyDateIdx: index("idx_school_daily_assessment_company_date").on(table.companyId, table.assessmentDate),
}));

export const schoolResultApprovalsTable = pgTable("school_result_approvals", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  academicYearId: integer("academic_year_id").notNull()
    .references(() => schoolAcademicYearsTable.id, { onDelete: "restrict" }),
  periodId: integer("period_id").notNull()
    .references(() => schoolAcademicPeriodsTable.id, { onDelete: "restrict" }),
  classId: integer("class_id").notNull().references(() => schoolClassesTable.id, { onDelete: "restrict" }),
  subjectId: integer("subject_id").notNull().references(() => schoolSubjectsTable.id, { onDelete: "restrict" }),
  publicationType: text("publication_type").notNull(),
  status: text("status").notNull().default("approved"),
  resultsSnapshot: jsonb("results_snapshot").notNull().default([]),
  approvedById: integer("approved_by_id"),
  approvedAt: timestamp("approved_at").notNull().defaultNow(),
  reopenedById: integer("reopened_by_id"),
  reopenedAt: timestamp("reopened_at"),
}, (table) => ({
  companyScopeIdx: index("idx_school_result_approvals_scope")
    .on(table.companyId, table.academicYearId, table.classId, table.subjectId, table.periodId, table.status),
}));

export const schoolGradeAuditEventsTable = pgTable("school_grade_audit_events", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  enrollmentId: integer("enrollment_id").references(() => schoolEnrollmentsTable.id, { onDelete: "set null" }),
  subjectId: integer("subject_id").references(() => schoolSubjectsTable.id, { onDelete: "set null" }),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id"),
  action: text("action").notNull(),
  beforeValue: jsonb("before_value"),
  afterValue: jsonb("after_value"),
  actorId: integer("actor_id"),
  occurredAt: timestamp("occurred_at").notNull().defaultNow(),
}, (table) => ({
  companyTimeIdx: index("idx_school_grade_audit_company_time").on(table.companyId, table.occurredAt),
  studentIdx: index("idx_school_grade_audit_student").on(table.companyId, table.enrollmentId, table.occurredAt),
}));

export type SchoolAcademicPeriod = typeof schoolAcademicPeriodsTable.$inferSelect;
export type SchoolSubjectOffering = typeof schoolSubjectOfferingsTable.$inferSelect;
export type SchoolGradeSubjectPolicy = typeof schoolGradeSubjectPoliciesTable.$inferSelect;
export type SchoolDailyAssessment = typeof schoolDailyAssessmentsTable.$inferSelect;
export type SchoolResultApproval = typeof schoolResultApprovalsTable.$inferSelect;
export type SchoolGradeAuditEvent = typeof schoolGradeAuditEventsTable.$inferSelect;
