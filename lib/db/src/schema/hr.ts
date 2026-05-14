import { pgTable, serial, text, integer, date, timestamp, decimal, boolean, unique } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";
import { accountsTable } from "./accounts";

export const employeesTable = pgTable("employees", {
  id:             serial("id").primaryKey(),
  companyId:      integer("company_id").references(() => companiesTable.id).notNull(),
  branchId:       integer("branch_id").references(() => branchesTable.id),
  code:           text("code").notNull(),
  nameAr:         text("name_ar").notNull(),
  nameEn:         text("name_en"),
  idType:         text("id_type").notNull().default("iqama"),
  idNumber:       text("id_number"),
  iqamaExpiry:    date("iqama_expiry"),
  passportNumber: text("passport_number"),
  passportExpiry: date("passport_expiry"),
  nationality:    text("nationality"),
  gender:         text("gender"),
  birthDate:      date("birth_date"),
  mobile:         text("mobile"),
  email:          text("email"),
  hireDate:       date("hire_date"),
  endDate:        date("end_date"),
  department:     text("department"),
  jobTitle:       text("job_title"),
  sponsor:        text("sponsor"),
  profession:     text("profession"),
  status:         text("status").notNull().default("active"),
  basicSalary:    decimal("basic_salary", { precision: 12, scale: 2 }).default("0"),
  housingAllow:   decimal("housing_allow", { precision: 12, scale: 2 }).default("0"),
  transportAllow: decimal("transport_allow", { precision: 12, scale: 2 }).default("0"),
  otherAllow:     decimal("other_allow", { precision: 12, scale: 2 }).default("0"),
  bankAccountIban:text("bank_account_iban"),
  bankName:       text("bank_name"),
  payableAccountId:integer("payable_account_id").references(() => accountsTable.id),
  photoUrl:       text("photo_url"),
  notes:          text("notes"),
  // ─── Mobile face-attendance work location ────────────────────────────
  // Each employee has their own check-in coordinates (supports field staff
  // and multiple work-sites). When workLat/workLng are NULL, geofence
  // checks are skipped — useful for back-office staff already verified
  // by other means. workRadiusM defaults to 200m if not set.
  workLat:        decimal("work_lat", { precision: 10, scale: 7 }),
  workLng:        decimal("work_lng", { precision: 10, scale: 7 }),
  workRadiusM:    integer("work_radius_m"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  uqIdNumber: unique("uq_employees_company_idnumber").on(t.companyId, t.idNumber),
  uqCode:     unique("uq_employees_company_code").on(t.companyId, t.code),
}));

export const employeeContractsTable = pgTable("employee_contracts", {
  id:             serial("id").primaryKey(),
  companyId:      integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId:     integer("employee_id").references(() => employeesTable.id, { onDelete: "cascade" }).notNull(),
  contractNumber: text("contract_number").notNull(),
  contractType:   text("contract_type").notNull().default("fixed"),
  startDate:      date("start_date").notNull(),
  endDate:        date("end_date"),
  basicSalary:    decimal("basic_salary", { precision: 12, scale: 2 }).notNull().default("0"),
  housingAllow:   decimal("housing_allow", { precision: 12, scale: 2 }).default("0"),
  transportAllow: decimal("transport_allow", { precision: 12, scale: 2 }).default("0"),
  otherAllow:     decimal("other_allow", { precision: 12, scale: 2 }).default("0"),
  workingHours:   integer("working_hours").default(8),
  probationDays:  integer("probation_days").default(90),
  noticePeriod:   integer("notice_period_days").default(60),
  vacationDays:   integer("vacation_days").default(21),
  terms:          text("terms"),
  status:         text("status").notNull().default("active"),
  renewedFromId:  integer("renewed_from_id"),
  notes:          text("notes"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
});

export const employeeAttendanceTable = pgTable("employee_attendance", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId:   integer("employee_id").references(() => employeesTable.id, { onDelete: "cascade" }).notNull(),
  date:         date("date").notNull(),
  checkIn:      text("check_in"),
  checkOut:     text("check_out"),
  workedHours:  decimal("worked_hours", { precision: 6, scale: 2 }).default("0"),
  overtimeHours:decimal("overtime_hours", { precision: 6, scale: 2 }).default("0"),
  lateMinutes:  integer("late_minutes").default(0),
  status:       text("status").notNull().default("present"),
  notes:        text("notes"),
  aiMethod:     text("ai_method"),
  aiConfidenceIn: decimal("ai_confidence_in", { precision: 5, scale: 4 }),
  aiConfidenceOut: decimal("ai_confidence_out", { precision: 5, scale: 4 }),
  cameraInId:   integer("camera_in_id"),
  cameraOutId:  integer("camera_out_id"),
  // ─── Live GPS / geofence (one set per check-in, one per check-out) ───
  // Coordinates captured on the employee's device at the moment of the
  // event. accuracy_m is the GPS reading's circular error (smaller is
  // better — values > ~75m are flagged for review). location_status:
  //   ok | out_of_geofence | low_accuracy | mock_suspected | denied | no_gps
  checkInLat:        decimal("check_in_lat",  { precision: 10, scale: 7 }),
  checkInLng:        decimal("check_in_lng",  { precision: 10, scale: 7 }),
  checkInAccuracyM:  decimal("check_in_accuracy_m", { precision: 8, scale: 2 }),
  checkInDistanceM:  decimal("check_in_distance_m", { precision: 10, scale: 2 }),
  checkInLocStatus:  text("check_in_loc_status"),
  checkOutLat:       decimal("check_out_lat", { precision: 10, scale: 7 }),
  checkOutLng:       decimal("check_out_lng", { precision: 10, scale: 7 }),
  checkOutAccuracyM: decimal("check_out_accuracy_m", { precision: 8, scale: 2 }),
  checkOutDistanceM: decimal("check_out_distance_m", { precision: 10, scale: 2 }),
  checkOutLocStatus: text("check_out_loc_status"),
  // Manager-approval workflow (triggered when location is denied or
  // outside the configured geofence radius for the employee).
  needsApproval:   boolean("needs_approval").notNull().default(false),
  approvalStatus:  text("approval_status"),     // pending | approved | rejected
  approvedBy:      integer("approved_by"),
  approvedAt:      timestamp("approved_at"),
  approvalNote:    text("approval_note"),
  // Snapshot of UA / platform / mock-detection flags at capture time
  deviceInfoIn:    text("device_info_in"),
  deviceInfoOut:   text("device_info_out"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  uqDay: unique("uq_attendance_emp_date").on(t.employeeId, t.date),
}));

export const attendanceCamerasTable = pgTable("attendance_cameras", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").references(() => companiesTable.id).notNull(),
  branchId:     integer("branch_id").references(() => branchesTable.id),
  name:         text("name").notNull(),
  location:     text("location"),
  kind:         text("kind").notNull().default("webcam"),
  dvrIp:        text("dvr_ip"),
  port:         integer("port"),
  channel:      integer("channel"),
  protocol:     text("protocol").default("rtsp"),
  username:     text("username"),
  passwordEnc:  text("password_enc"),
  streamUrl:    text("stream_url"),
  aiEnabled:    boolean("ai_enabled").notNull().default(true),
  status:       text("status").notNull().default("active"),
  lastSeenAt:   timestamp("last_seen_at"),
  notes:        text("notes"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().notNull(),
});

export const employeeFaceEnrollmentsTable = pgTable("employee_face_enrollments", {
  id:             serial("id").primaryKey(),
  companyId:      integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId:     integer("employee_id").references(() => employeesTable.id, { onDelete: "cascade" }).notNull(),
  descriptorJson: text("descriptor_json").notNull(),
  qualityScore:   decimal("quality_score", { precision: 5, scale: 4 }).default("0"),
  pose:           text("pose").default("frontal"),
  livenessPassed: boolean("liveness_passed").notNull().default(false),
  imageUrl:       text("image_url"),
  isPrimary:      boolean("is_primary").notNull().default(false),
  capturedAt:     timestamp("captured_at").defaultNow().notNull(),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
});

export const faceRecognitionLogsTable = pgTable("face_recognition_logs", {
  id:                 serial("id").primaryKey(),
  companyId:          integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId:         integer("employee_id").references(() => employeesTable.id, { onDelete: "set null" }),
  cameraId:           integer("camera_id"),
  matchedConfidence:  decimal("matched_confidence", { precision: 5, scale: 4 }),
  bestDistance:       decimal("best_distance", { precision: 5, scale: 4 }),
  action:             text("action"),
  status:             text("status").notNull(),
  livenessPassed:     boolean("liveness_passed").notNull().default(false),
  spoofReason:        text("spoof_reason"),
  frameThumbnailUrl:  text("frame_thumbnail_url"),
  deviceInfo:         text("device_info"),
  attendanceId:       integer("attendance_id"),
  createdAt:          timestamp("created_at").defaultNow().notNull(),
});

export const attendanceAiSettingsTable = pgTable("attendance_ai_settings", {
  id:               serial("id").primaryKey(),
  companyId:        integer("company_id").references(() => companiesTable.id).notNull().unique(),
  matchThreshold:   decimal("match_threshold", { precision: 5, scale: 4 }).notNull().default("0.6"),
  cooldownSeconds:  integer("cooldown_seconds").notNull().default(300),
  requireLiveness:  boolean("require_liveness").notNull().default(true),
  autoCheckOut:     boolean("auto_check_out").notNull().default(true),
  lateToleranceMin: integer("late_tolerance_min").notNull().default(10),
  workdayStart:     text("workday_start").default("08:00"),
  workdayEnd:       text("workday_end").default("17:00"),
  notifyOnUnknown:  boolean("notify_on_unknown").notNull().default(true),
  minQualityScore:  decimal("min_quality_score", { precision: 5, scale: 4 }).notNull().default("0.5"),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
  updatedAt:        timestamp("updated_at").defaultNow().notNull(),
});

export const employeeLoansTable = pgTable("employee_loans", {
  id:             serial("id").primaryKey(),
  companyId:      integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId:     integer("employee_id").references(() => employeesTable.id, { onDelete: "cascade" }).notNull(),
  loanDate:       date("loan_date").notNull(),
  loanType:       text("loan_type").notNull().default("loan"),
  amount:         decimal("amount", { precision: 12, scale: 2 }).notNull().default("0"),
  installments:   integer("installments").notNull().default(1),
  installmentAmt: decimal("installment_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  paidAmount:     decimal("paid_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  status:         text("status").notNull().default("active"),
  reason:         text("reason"),
  notes:          text("notes"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
});

export const payrollRunsTable = pgTable("payroll_runs", {
  id:             serial("id").primaryKey(),
  companyId:      integer("company_id").references(() => companiesTable.id).notNull(),
  branchId:       integer("branch_id").references(() => branchesTable.id),
  code:           text("code").notNull(),
  year:           integer("year").notNull(),
  month:          integer("month").notNull(),
  periodStart:    date("period_start").notNull(),
  periodEnd:      date("period_end").notNull(),
  payDate:        date("pay_date"),
  totalGross:     decimal("total_gross", { precision: 14, scale: 2 }).notNull().default("0"),
  totalDeductions:decimal("total_deductions", { precision: 14, scale: 2 }).notNull().default("0"),
  totalNet:       decimal("total_net", { precision: 14, scale: 2 }).notNull().default("0"),
  employeesCount: integer("employees_count").notNull().default(0),
  status:         text("status").notNull().default("draft"),
  postedJournalId:integer("posted_journal_id"),
  notes:          text("notes"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  uqPeriod: unique("uq_payroll_company_period").on(t.companyId, t.year, t.month),
  uqCode:   unique("uq_payroll_company_code").on(t.companyId, t.code),
}));

export const payrollLinesTable = pgTable("payroll_lines", {
  id:             serial("id").primaryKey(),
  payrollRunId:   integer("payroll_run_id").references(() => payrollRunsTable.id, { onDelete: "cascade" }).notNull(),
  employeeId:     integer("employee_id").references(() => employeesTable.id).notNull(),
  basicSalary:    decimal("basic_salary", { precision: 12, scale: 2 }).notNull().default("0"),
  housingAllow:   decimal("housing_allow", { precision: 12, scale: 2 }).notNull().default("0"),
  transportAllow: decimal("transport_allow", { precision: 12, scale: 2 }).notNull().default("0"),
  otherAllow:     decimal("other_allow", { precision: 12, scale: 2 }).notNull().default("0"),
  overtimeAmount: decimal("overtime_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  bonusAmount:    decimal("bonus_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  grossSalary:    decimal("gross_salary", { precision: 12, scale: 2 }).notNull().default("0"),
  gosiEmployee:   decimal("gosi_employee", { precision: 12, scale: 2 }).notNull().default("0"),
  loanDeduction:  decimal("loan_deduction", { precision: 12, scale: 2 }).notNull().default("0"),
  absenceDeduction:decimal("absence_deduction", { precision: 12, scale: 2 }).notNull().default("0"),
  otherDeduction: decimal("other_deduction", { precision: 12, scale: 2 }).notNull().default("0"),
  totalDeductions:decimal("total_deductions", { precision: 12, scale: 2 }).notNull().default("0"),
  netSalary:      decimal("net_salary", { precision: 12, scale: 2 }).notNull().default("0"),
  workedDays:     integer("worked_days").notNull().default(30),
  absentDays:     integer("absent_days").notNull().default(0),
  notes:          text("notes"),
});

export const employeeLeavesTable = pgTable("employee_leaves", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId:   integer("employee_id").references(() => employeesTable.id, { onDelete: "cascade" }).notNull(),
  leaveType:    text("leave_type").notNull(),
  startDate:    date("start_date").notNull(),
  endDate:      date("end_date").notNull(),
  days:         integer("days").notNull().default(1),
  paid:         boolean("paid").notNull().default(true),
  status:       text("status").notNull().default("pending"),
  reason:       text("reason"),
  approvedBy:   text("approved_by"),
  approvedAt:   timestamp("approved_at"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().notNull(),
});
