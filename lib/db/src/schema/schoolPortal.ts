import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import {
  schoolEnrollmentsTable,
  schoolStudentGuardiansTable,
  schoolStudentsTable,
} from "./schools";

export const schoolGuardianPortalAccountsTable = pgTable("school_guardian_portal_accounts", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  username: text("username").notNull(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdById: integer("created_by_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  companyUsernameUq: unique("uq_school_guardian_portal_company_username")
    .on(table.companyId, table.username),
}));

export const schoolGuardianPortalLinksTable = pgTable("school_guardian_portal_links", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  accountId: integer("account_id").notNull().references(() => schoolGuardianPortalAccountsTable.id, { onDelete: "cascade" }),
  guardianId: integer("guardian_id").notNull().references(() => schoolStudentGuardiansTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  accountGuardianUq: unique("uq_school_guardian_portal_link_account_guardian")
    .on(table.accountId, table.guardianId),
  guardianAccountUq: unique("uq_school_guardian_portal_link_guardian")
    .on(table.guardianId),
  companyAccountIdx: index("idx_school_guardian_portal_links_company_account")
    .on(table.companyId, table.accountId),
}));

export const schoolStudentBiometricConsentsTable = pgTable("school_student_biometric_consents", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  studentId: integer("student_id").notNull().references(() => schoolStudentsTable.id, { onDelete: "cascade" }),
  guardianAccountId: integer("guardian_account_id").notNull()
    .references(() => schoolGuardianPortalAccountsTable.id, { onDelete: "cascade" }),
  isActive: boolean("is_active").notNull().default(false),
  policyVersion: text("policy_version").notNull(),
  consentedAt: timestamp("consented_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  companyStudentAccountUq: unique("uq_school_student_biometric_consent")
    .on(table.companyId, table.studentId, table.guardianAccountId),
}));

export const schoolBiometricConsentEventsTable = pgTable("school_biometric_consent_events", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  studentId: integer("student_id").notNull().references(() => schoolStudentsTable.id, { onDelete: "cascade" }),
  guardianAccountId: integer("guardian_account_id").notNull()
    .references(() => schoolGuardianPortalAccountsTable.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  policyVersion: text("policy_version").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  companyStudentDateIdx: index("idx_school_biometric_consent_events_student")
    .on(table.companyId, table.studentId, table.occurredAt),
}));

export const schoolStudentFaceTemplatesTable = pgTable("school_student_face_templates", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  studentId: integer("student_id").notNull().references(() => schoolStudentsTable.id, { onDelete: "cascade" }),
  consentId: integer("consent_id").notNull()
    .references(() => schoolStudentBiometricConsentsTable.id, { onDelete: "cascade" }),
  descriptorCiphertext: text("descriptor_ciphertext").notNull(),
  qualityScore: numeric("quality_score", { precision: 7, scale: 6 }).notNull(),
  enrolledById: integer("enrolled_by_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  companyStudentUq: unique("uq_school_student_face_template")
    .on(table.companyId, table.studentId),
}));

export const schoolStudentAttendanceEventsTable = pgTable("school_student_attendance_events", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  enrollmentId: integer("enrollment_id").notNull()
    .references(() => schoolEnrollmentsTable.id, { onDelete: "restrict" }),
  attendanceDate: date("attendance_date", { mode: "string" }).notNull(),
  eventType: text("event_type").notNull(),
  source: text("source").notNull().default("face"),
  cameraId: integer("camera_id"),
  confidence: numeric("confidence", { precision: 7, scale: 6 }).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  oneEventPerDayUq: unique("uq_school_student_attendance_event_per_day")
    .on(table.companyId, table.enrollmentId, table.attendanceDate, table.eventType),
  companyDateIdx: index("idx_school_student_attendance_events_company_date")
    .on(table.companyId, table.attendanceDate),
}));

export const insertSchoolGuardianPortalAccountSchema =
  createInsertSchema(schoolGuardianPortalAccountsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertSchoolGuardianPortalLinkSchema =
  createInsertSchema(schoolGuardianPortalLinksTable).omit({ id: true, createdAt: true });
export const insertSchoolStudentBiometricConsentSchema =
  createInsertSchema(schoolStudentBiometricConsentsTable).omit({ id: true, createdAt: true, updatedAt: true });

export type SchoolGuardianPortalAccount = typeof schoolGuardianPortalAccountsTable.$inferSelect;
export type InsertSchoolGuardianPortalAccount = typeof schoolGuardianPortalAccountsTable.$inferInsert;
export type SchoolGuardianPortalLink = typeof schoolGuardianPortalLinksTable.$inferSelect;
export type SchoolStudentBiometricConsent = typeof schoolStudentBiometricConsentsTable.$inferSelect;
export type SchoolStudentFaceTemplate = typeof schoolStudentFaceTemplatesTable.$inferSelect;
export type SchoolStudentAttendanceEvent = typeof schoolStudentAttendanceEventsTable.$inferSelect;
