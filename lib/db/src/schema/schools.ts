import {
  pgTable, serial, text, integer, numeric, timestamp, boolean, date, unique,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";
import { employeesTable } from "./hr";
import { customersTable } from "./customers";
import { salesInvoicesTable } from "./sales";

export const schoolCampusesTable = pgTable("school_campuses", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId: integer("branch_id").references(() => branchesTable.id, { onDelete: "set null" }),
  code: text("code").notNull(),
  nameAr: text("name_ar").notNull(),
  nameEn: text("name_en"),
  address: text("address"),
  city: text("city"),
  phone: text("phone"),
  email: text("email"),
  managerEmployeeId: integer("manager_employee_id").references(() => employeesTable.id, { onDelete: "set null" }),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  companyCodeUq: unique("uq_school_campuses_company_code").on(t.companyId, t.code),
}));
export type SchoolCampus = typeof schoolCampusesTable.$inferSelect;
export type InsertSchoolCampus = typeof schoolCampusesTable.$inferInsert;

export const schoolAcademicYearsTable = pgTable("school_academic_years", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  startDate: date("start_date", { mode: "string" }).notNull(),
  endDate: date("end_date", { mode: "string" }).notNull(),
  status: text("status").notNull().default("planned"),
  isCurrent: boolean("is_current").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  companyNameUq: unique("uq_school_years_company_name").on(t.companyId, t.name),
}));
export type SchoolAcademicYear = typeof schoolAcademicYearsTable.$inferSelect;
export type InsertSchoolAcademicYear = typeof schoolAcademicYearsTable.$inferInsert;

export const schoolGradesTable = pgTable("school_grades", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  stage: text("stage").notNull(),
  nameAr: text("name_ar").notNull(),
  nameEn: text("name_en"),
  orderNo: integer("order_no").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  companyStageNameUq: unique("uq_school_grades_company_stage_name").on(t.companyId, t.stage, t.nameAr),
}));
export type SchoolGrade = typeof schoolGradesTable.$inferSelect;
export type InsertSchoolGrade = typeof schoolGradesTable.$inferInsert;

export const schoolClassesTable = pgTable("school_classes", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  campusId: integer("campus_id").references(() => schoolCampusesTable.id, { onDelete: "restrict" }),
  academicYearId: integer("academic_year_id").notNull().references(() => schoolAcademicYearsTable.id, { onDelete: "restrict" }),
  gradeId: integer("grade_id").notNull().references(() => schoolGradesTable.id, { onDelete: "restrict" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  capacity: integer("capacity").notNull().default(0),
  classTeacherEmployeeId: integer("class_teacher_employee_id").references(() => employeesTable.id, { onDelete: "set null" }),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  companyYearCodeUq: unique("uq_school_classes_company_year_code").on(t.companyId, t.academicYearId, t.code),
}));
export type SchoolClass = typeof schoolClassesTable.$inferSelect;
export type InsertSchoolClass = typeof schoolClassesTable.$inferInsert;

export const schoolStudentsTable = pgTable("school_students", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  studentNumber: text("student_number").notNull(),
  fullNameAr: text("full_name_ar").notNull(),
  fullNameEn: text("full_name_en"),
  nationalId: text("national_id"),
  gender: text("gender"),
  birthDate: date("birth_date", { mode: "string" }),
  phone: text("phone"),
  email: text("email"),
  address: text("address"),
  status: text("status").notNull().default("active"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  companyNumberUq: unique("uq_school_students_company_number").on(t.companyId, t.studentNumber),
}));
export type SchoolStudent = typeof schoolStudentsTable.$inferSelect;
export type InsertSchoolStudent = typeof schoolStudentsTable.$inferInsert;

export const schoolStudentGuardiansTable = pgTable("school_student_guardians", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  studentId: integer("student_id").notNull().references(() => schoolStudentsTable.id, { onDelete: "cascade" }),
  customerId: integer("customer_id").references(() => customersTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  relationship: text("relationship").notNull().default("guardian"),
  phone: text("phone"),
  email: text("email"),
  isPrimary: boolean("is_primary").notNull().default(false),
  isInvoicePayer: boolean("is_invoice_payer").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type SchoolStudentGuardian = typeof schoolStudentGuardiansTable.$inferSelect;
export type InsertSchoolStudentGuardian = typeof schoolStudentGuardiansTable.$inferInsert;

export const schoolEnrollmentsTable = pgTable("school_enrollments", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  studentId: integer("student_id").notNull().references(() => schoolStudentsTable.id, { onDelete: "restrict" }),
  academicYearId: integer("academic_year_id").notNull().references(() => schoolAcademicYearsTable.id, { onDelete: "restrict" }),
  classId: integer("class_id").notNull().references(() => schoolClassesTable.id, { onDelete: "restrict" }),
  enrollmentDate: date("enrollment_date", { mode: "string" }).notNull(),
  status: text("status").notNull().default("active"),
  annualFee: numeric("annual_fee", { precision: 15, scale: 2 }).notNull().default("0"),
  discountAmount: numeric("discount_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  studentYearUq: unique("uq_school_enrollments_company_student_year").on(t.companyId, t.studentId, t.academicYearId),
}));
export type SchoolEnrollment = typeof schoolEnrollmentsTable.$inferSelect;
export type InsertSchoolEnrollment = typeof schoolEnrollmentsTable.$inferInsert;

export const schoolAttendanceTable = pgTable("school_attendance", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  enrollmentId: integer("enrollment_id").notNull().references(() => schoolEnrollmentsTable.id, { onDelete: "restrict" }),
  attendanceDate: date("attendance_date", { mode: "string" }).notNull(),
  period: text("period").notNull().default("full_day"),
  status: text("status").notNull(),
  note: text("note"),
  recordedById: integer("recorded_by_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  enrollmentDatePeriodUq: unique("uq_school_attendance_enrollment_date_period")
    .on(t.companyId, t.enrollmentId, t.attendanceDate, t.period),
}));
export type SchoolAttendance = typeof schoolAttendanceTable.$inferSelect;
export type InsertSchoolAttendance = typeof schoolAttendanceTable.$inferInsert;

export const schoolSubjectsTable = pgTable("school_subjects", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  nameAr: text("name_ar").notNull(),
  nameEn: text("name_en"),
  gradeId: integer("grade_id").references(() => schoolGradesTable.id, { onDelete: "set null" }),
  teacherEmployeeId: integer("teacher_employee_id").references(() => employeesTable.id, { onDelete: "set null" }),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  companyCodeUq: unique("uq_school_subjects_company_code").on(t.companyId, t.code),
}));
export type SchoolSubject = typeof schoolSubjectsTable.$inferSelect;
export type InsertSchoolSubject = typeof schoolSubjectsTable.$inferInsert;

export const schoolExamsTable = pgTable("school_exams", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  academicYearId: integer("academic_year_id").notNull().references(() => schoolAcademicYearsTable.id, { onDelete: "restrict" }),
  classId: integer("class_id").notNull().references(() => schoolClassesTable.id, { onDelete: "restrict" }),
  subjectId: integer("subject_id").notNull().references(() => schoolSubjectsTable.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  examDate: date("exam_date", { mode: "string" }).notNull(),
  maxScore: numeric("max_score", { precision: 10, scale: 2 }).notNull().default("100"),
  status: text("status").notNull().default("planned"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type SchoolExam = typeof schoolExamsTable.$inferSelect;
export type InsertSchoolExam = typeof schoolExamsTable.$inferInsert;

export const schoolExamResultsTable = pgTable("school_exam_results", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  examId: integer("exam_id").notNull().references(() => schoolExamsTable.id, { onDelete: "restrict" }),
  enrollmentId: integer("enrollment_id").notNull().references(() => schoolEnrollmentsTable.id, { onDelete: "restrict" }),
  score: numeric("score", { precision: 10, scale: 2 }).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  examEnrollmentUq: unique("uq_school_exam_results_exam_enrollment").on(t.companyId, t.examId, t.enrollmentId),
}));
export type SchoolExamResult = typeof schoolExamResultsTable.$inferSelect;
export type InsertSchoolExamResult = typeof schoolExamResultsTable.$inferInsert;

export const schoolFeesTable = pgTable("school_fee_charges", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  enrollmentId: integer("enrollment_id").notNull().references(() => schoolEnrollmentsTable.id, { onDelete: "restrict" }),
  guardianId: integer("guardian_id").references(() => schoolStudentGuardiansTable.id, { onDelete: "set null" }),
  salesInvoiceId: integer("sales_invoice_id").references(() => salesInvoicesTable.id, { onDelete: "set null" }),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
  dueDate: date("due_date", { mode: "string" }),
  status: text("status").notNull().default("planned"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type SchoolFeeCharge = typeof schoolFeesTable.$inferSelect;
export type InsertSchoolFeeCharge = typeof schoolFeesTable.$inferInsert;
