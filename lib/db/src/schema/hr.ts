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
  // ─── Saudi Mudad / WPS payroll eligibility (kafala / sponsorship) ─────
  // Data used to build the Mudad salary-upload file and to auto-exclude
  // employees who cannot be paid via the platform. residency/work-permit
  // *validity* is DERIVED at runtime from iqamaExpiry / workPermitExpiry —
  // only the raw dates are stored.
  borderNumber:        text("border_number"),            // رقم الحدود (للمقيمين)
  saudiType:           text("saudi_type"),               // 'saudi' | 'non_saudi'
  employmentType:      text("employment_type").default("regular"), // 'regular' | 'irregular'
  onSponsorship:       boolean("on_sponsorship").default(true),    // على كفالة المنشأة
  establishmentNumber: text("establishment_number"),     // رقم المنشأة في مدد
  sponsorshipStart:    date("sponsorship_start"),
  sponsorshipEnd:      date("sponsorship_end"),
  workPermitExpiry:    date("work_permit_expiry"),       // انتهاء رخصة العمل
  bankApproved:        boolean("bank_approved").default(true),     // الحساب البنكي معتمد لدى مدد (يُعلَّم false لاستبعاده)
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
  // ─── ZacodeHR employee-portal credentials (optional) ────────────────
  // Employees with a username+password can sign in to the zacodehr
  // self-service portal (company code + username + password). The count of
  // employees with a non-null username is capped by subscriptions.max_hr_users.
  loginUsername:     text("login_username"),
  loginPasswordHash: text("login_password_hash"),
  portalActive:      boolean("portal_active").default(true),
  // Optional link to an ERP users row — lets the mobile companion app show
  // this employee's own attendance (تقرير حضوري) to the logged-in user.
  userId:            integer("user_id"),
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
  // ─── Attendance & time-management contract fields (وثيقة الحضور والانصراف) ──
  // Schedule is read from the contract — NOT re-entered daily. All ADDITIVE.
  shiftId:            integer("shift_id"),            // FK → attendance_shifts (soft)
  workStart:          text("work_start"),              // "08:00" — overrides shift when set
  workEnd:            text("work_end"),                // "16:00"
  weeklyHours:        decimal("weekly_hours", { precision: 5, scale: 2 }),
  workDaysPerWeek:    integer("work_days_per_week"),
  restDays:           text("rest_days"),               // JSON [5,6] = Fri,Sat (0=Sun)
  lateGraceMin:       integer("late_grace_min"),       // فترة سماح التأخير
  earlyGraceMin:      integer("early_grace_min"),      // فترة سماح الانصراف المبكر
  overtimeMinMinutes: integer("overtime_min_minutes"), // الحد الأدنى لاحتساب الإضافي
  overtimePolicy:     text("overtime_policy"),         // none | after_shift | after_daily_hours
  permissionMonthlyMinutes: integer("permission_monthly_minutes"), // رصيد الاستئذان الشهري
  permissionMaxPerRequestMinutes: integer("permission_max_per_request_minutes"),
  permissionAllowExceed: boolean("permission_allow_exceed"),
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
  // ─── Derived time-management buckets (engine-computed, additive) ─────
  // Rule 16 (عدم التكرار): every scheduled minute lands in EXACTLY ONE
  // bucket — worked, paid permission, unpaid permission, late, early
  // leave, or missing. The engine recomputes these from raw movements.
  earlyLeaveMinutes:      integer("early_leave_minutes"),
  breakMinutes:           integer("break_minutes"),
  permissionPaidMinutes:  integer("permission_paid_minutes"),
  permissionUnpaidMinutes:integer("permission_unpaid_minutes"),
  missingMinutes:         integer("missing_minutes"),
  netHours:               decimal("net_hours", { precision: 6, scale: 2 }),
  calcSource:             text("calc_source"),   // engine | manual
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
  installmentStartDate: date("installment_start_date"),
  installmentEndDate:   date("installment_end_date"),
  paidAmount:     decimal("paid_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  status:         text("status").notNull().default("active"),
  reason:         text("reason"),
  notes:          text("notes"),
  loanAccountId:  integer("loan_account_id").references(() => accountsTable.id),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
});

// ─── Employee Custody / Imprest (العُهد) ─────────────────────────────────────
// A custody is an amount advanced to an employee to spend on the company's
// behalf, SETTLED by submitting expense/invoice lines (NOT deducted from
// salary). Lifecycle: create → disburse (DR custody / CR cash|bank) →
// settle expenses (DR expense / CR custody) → return remaining (DR cash|bank /
// CR custody). status: active | settled | cancelled.
export const employeeCustodiesTable = pgTable("employee_custodies", {
  id:             serial("id").primaryKey(),
  companyId:      integer("company_id").references(() => companiesTable.id).notNull(),
  branchId:       integer("branch_id").references(() => branchesTable.id),
  employeeId:     integer("employee_id").references(() => employeesTable.id, { onDelete: "cascade" }).notNull(),
  custodyDate:    date("custody_date").notNull(),
  amount:         decimal("amount", { precision: 12, scale: 2 }).notNull().default("0"),
  settledAmount:  decimal("settled_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  returnedAmount: decimal("returned_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  purpose:        text("purpose"),
  notes:          text("notes"),
  status:         text("status").notNull().default("active"),
  custodyAccountId:      integer("custody_account_id").references(() => accountsTable.id),
  disbursementJournalId: integer("disbursement_journal_id"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
});

export const employeeCustodySettlementsTable = pgTable("employee_custody_settlements", {
  id:             serial("id").primaryKey(),
  companyId:      integer("company_id").references(() => companiesTable.id).notNull(),
  custodyId:      integer("custody_id").references(() => employeeCustodiesTable.id, { onDelete: "cascade" }).notNull(),
  settleDate:     date("settle_date").notNull(),
  kind:           text("kind").notNull().default("expense"), // expense | return
  expenseAccountId: integer("expense_account_id").references(() => accountsTable.id),
  amount:         decimal("amount", { precision: 12, scale: 2 }).notNull().default("0"),
  description:    text("description"),
  invoiceNumber:  text("invoice_number"),
  journalId:      integer("journal_id"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
});

// ─── العهد العينية (أصول مسلَّمة للموظفين) ───────────────────────────────────
// Administrative custody of a REGISTERED fixed asset (car/laptop/phone/…).
// NO journal entry is created — the asset is already on the books; this only
// tracks employee responsibility. Delivering/returning also syncs
// fixed_assets.custodian_employee_id. status: delivered | returned.
export const assetCustodiesTable = pgTable("asset_custodies", {
  id:                 serial("id").primaryKey(),
  companyId:          integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId:         integer("employee_id").references(() => employeesTable.id, { onDelete: "cascade" }).notNull(),
  assetId:            integer("asset_id").notNull(), // fixed_assets.id (validated per-company in routes)
  deliveryDate:       date("delivery_date").notNull(),
  expectedReturnDate: date("expected_return_date"),
  actualReturnDate:   date("actual_return_date"),
  status:             text("status").notNull().default("delivered"),
  notes:              text("notes"),
  createdAt:          timestamp("created_at").defaultNow().notNull(),
  updatedAt:          timestamp("updated_at").defaultNow().notNull(),
});

// ─── مخالفات الموظفين ────────────────────────────────────────────────────────
// Registered disciplinary violations (distinct from the DERIVED attendance
// violations grid). deduct_from_salary=true + status='pending' rows are
// consumed by payroll preview/run as violationDeduction; when a run is
// created they flip to status='deducted' with payroll_run_id (reverted if the
// run is deleted). status: pending | deducted | waived.
export const employeeViolationsTable = pgTable("employee_violations", {
  id:              serial("id").primaryKey(),
  companyId:       integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId:      integer("employee_id").references(() => employeesTable.id, { onDelete: "cascade" }).notNull(),
  violationType:   text("violation_type").notNull(),
  violationDate:   date("violation_date").notNull(),
  reason:          text("reason"),
  amount:          decimal("amount", { precision: 12, scale: 2 }).notNull().default("0"),
  deductFromSalary: boolean("deduct_from_salary").notNull().default(false),
  payrollRunId:    integer("payroll_run_id"),
  status:          text("status").notNull().default("pending"),
  notes:           text("notes"),
  createdAt:       timestamp("created_at").defaultNow().notNull(),
  updatedAt:       timestamp("updated_at").defaultNow().notNull(),
});

// ─── الخروج والعودة (سفر الموظف) ─────────────────────────────────────────────
// Travel exit/return tracking. Alerts fire one week before expected return
// (in /employees/alerts). status: out | returned.
export const employeeTravelsTable = pgTable("employee_travels", {
  id:                 serial("id").primaryKey(),
  companyId:          integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId:         integer("employee_id").references(() => employeesTable.id, { onDelete: "cascade" }).notNull(),
  exitDate:           date("exit_date").notNull(),
  exitTime:           text("exit_time"),
  expectedReturnDate: date("expected_return_date"),
  expectedReturnTime: text("expected_return_time"),
  actualReturnDate:   date("actual_return_date"),
  actualReturnTime:   text("actual_return_time"),
  status:             text("status").notNull().default("out"),
  notes:              text("notes"),
  createdAt:          timestamp("created_at").defaultNow().notNull(),
  updatedAt:          timestamp("updated_at").defaultNow().notNull(),
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
  // JE of the actual salary payment (DR salaries payable / CR cash|bank).
  // Set by «صرف الرواتب»; non-null = paid (blocks double payment + run unpost).
  paymentJournalId: integer("payment_journal_id"),
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
  violationDeduction: decimal("violation_deduction", { precision: 12, scale: 2 }).notNull().default("0"),
  absenceDeduction:decimal("absence_deduction", { precision: 12, scale: 2 }).notNull().default("0"),
  otherDeduction: decimal("other_deduction", { precision: 12, scale: 2 }).notNull().default("0"),
  totalDeductions:decimal("total_deductions", { precision: 12, scale: 2 }).notNull().default("0"),
  netSalary:      decimal("net_salary", { precision: 12, scale: 2 }).notNull().default("0"),
  workedDays:     integer("worked_days").notNull().default(30),
  absentDays:     integer("absent_days").notNull().default(0),
  notes:          text("notes"),
});

// ─── Saudi Mudad salary batches (WPS-compatible export) ──────────────────────
// A batch is one "send salaries to Mudad" operation. It snapshots the payroll
// run's net salaries, applies eligibility rules, records who is included /
// excluded (with the Arabic reason), and totals. The exported file is
// regenerated on demand from the persisted lines, so a live Mudad API can be
// wired later without changing this model. sendMode: 'sponsored_only' (default)
// | 'all'. status: 'generated' | 'sent' | 'partial'.
export const mudadSalaryBatchesTable = pgTable("mudad_salary_batches", {
  id:                  serial("id").primaryKey(),
  companyId:           integer("company_id").references(() => companiesTable.id).notNull(),
  branchId:            integer("branch_id").references(() => branchesTable.id),
  payrollRunId:        integer("payroll_run_id").references(() => payrollRunsTable.id, { onDelete: "set null" }),
  code:                text("code").notNull(),
  year:                integer("year").notNull(),
  month:               integer("month").notNull(),
  sendMode:            text("send_mode").notNull().default("sponsored_only"),
  establishmentNumber: text("establishment_number"),
  totalEmployees:      integer("total_employees").notNull().default(0),
  includedCount:       integer("included_count").notNull().default(0),
  excludedCount:       integer("excluded_count").notNull().default(0),
  sentCount:           integer("sent_count").notNull().default(0),
  rejectedCount:       integer("rejected_count").notNull().default(0),
  totalNet:            decimal("total_net", { precision: 14, scale: 2 }).notNull().default("0"),
  fileFormat:          text("file_format").notNull().default("wps_csv"),
  status:              text("status").notNull().default("generated"),
  createdBy:           integer("created_by"),
  createdByName:       text("created_by_name"),
  notes:               text("notes"),
  createdAt:           timestamp("created_at").defaultNow().notNull(),
  updatedAt:           timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  uqCode: unique("uq_mudad_batch_company_code").on(t.companyId, t.code),
}));

export const mudadSalaryBatchLinesTable = pgTable("mudad_salary_batch_lines", {
  id:              serial("id").primaryKey(),
  batchId:         integer("batch_id").references(() => mudadSalaryBatchesTable.id, { onDelete: "cascade" }).notNull(),
  companyId:       integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId:      integer("employee_id").references(() => employeesTable.id, { onDelete: "set null" }),
  employeeCode:    text("employee_code"),
  employeeName:    text("employee_name"),
  idNumber:        text("id_number"),
  iban:            text("iban"),
  bankName:        text("bank_name"),
  netSalary:       decimal("net_salary", { precision: 12, scale: 2 }).notNull().default("0"),
  included:        boolean("included").notNull().default(false),
  excludedReason:  text("excluded_reason"),   // reason code (mapped to Arabic in the UI/report)
  status:          text("status").notNull().default("pending"), // sent | rejected | pending | excluded
  rejectionReason: text("rejection_reason"),
  createdAt:       timestamp("created_at").defaultNow().notNull(),
});

// ─── Attendance Shifts (الورديات) ─────────────────────────────────────────────
// Morning / evening / night / flexible shifts, incl. cross-midnight ones.
// Contracts point at a shift; per-contract workStart/workEnd override it.
export const attendanceShiftsTable = pgTable("attendance_shifts", {
  id:             serial("id").primaryKey(),
  companyId:      integer("company_id").references(() => companiesTable.id).notNull(),
  name:           text("name").notNull(),
  startTime:      text("start_time").notNull(),  // "08:00"
  endTime:        text("end_time").notNull(),    // "16:00" — may be < startTime (تعبر منتصف الليل)
  crossesMidnight:boolean("crosses_midnight").notNull().default(false),
  breakMinutes:   integer("break_minutes").notNull().default(0),
  lateGraceMin:   integer("late_grace_min").notNull().default(0),
  earlyGraceMin:  integer("early_grace_min").notNull().default(0),
  overtimeMinMinutes: integer("overtime_min_minutes").notNull().default(0),
  restDays:       text("rest_days"),              // JSON [5,6]
  active:         boolean("active").notNull().default(true),
  notes:          text("notes"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
});

// ─── Attendance Movements (السجل اليومي للحركات) ─────────────────────────────
// EVERY punch is a row: device, mobile app, manual entry, API. The daily
// attendance row is DERIVED from these; recalc never mutates raw movements.
// Duplicate-punch protection: UNIQUE (employee, date, time, type) — importers
// and devices must insert with ON CONFLICT DO NOTHING (اكتشاف البصمات المكررة).
export const attendanceMovementsTable = pgTable("attendance_movements", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId:   integer("employee_id").references(() => employeesTable.id, { onDelete: "cascade" }).notNull(),
  date:         date("date").notNull(),
  time:         text("time").notNull(),           // "HH:MM"
  type:         text("type").notNull(),           // in | out
  source:       text("source").notNull().default("manual"), // device | mobile | manual | api | other
  deviceId:     text("device_id"),
  location:     text("location"),
  // Link to the exit permission this OUT/IN pair belongs to (خروج استئذان) —
  // set automatically when an approved permission window covers the punch.
  exitPermissionId: integer("exit_permission_id"),
  enteredBy:    integer("entered_by"),
  editReason:   text("edit_reason"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  uqPunch: unique("uq_att_movement_punch").on(t.employeeId, t.date, t.time, t.type),
}));

// ─── Exit Permissions (استئذان الخروج) ───────────────────────────────────────
// Full cycle: draft → pending → approved/rejected → (cancelled/expired).
// An APPROVED permission window is excluded from lateness / early-leave /
// missing-hours so the same minutes are NEVER double-counted (قاعدة 16).
export const exitPermissionsTable = pgTable("exit_permissions", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId:   integer("employee_id").references(() => employeesTable.id, { onDelete: "cascade" }).notNull(),
  date:         date("date").notNull(),
  startTime:    text("start_time").notNull(),     // "12:00"
  endTime:      text("end_time").notNull(),       // "13:00"
  minutes:      integer("minutes").notNull(),     // derived, stored for reporting
  permissionType: text("permission_type").notNull().default("personal"), // personal | official | medical | other
  paid:         boolean("paid").notNull().default(true),
  reason:       text("reason"),
  notes:        text("notes"),
  status:       text("status").notNull().default("pending"), // draft|pending|approved|rejected|cancelled|expired
  approverId:   integer("approver_id"),
  decidedBy:    integer("decided_by"),
  decidedAt:    timestamp("decided_at"),
  decisionNote: text("decision_note"),
  createdBy:    integer("created_by"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().notNull(),
});

// ─── Attendance Day Locks (اعتماد/قفل اليوم) ─────────────────────────────────
// One row per company+date. approved = HR signed the day off; locked = no
// further edits (movements/permissions/manual rows) without reopen.
export const attendanceDayLocksTable = pgTable("attendance_day_locks", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").references(() => companiesTable.id).notNull(),
  date:         date("date").notNull(),
  status:       text("status").notNull().default("approved"), // approved | locked
  lockedBy:     integer("locked_by"),
  lockedAt:     timestamp("locked_at").defaultNow().notNull(),
  reopenedBy:   integer("reopened_by"),
  reopenedAt:   timestamp("reopened_at"),
  notes:        text("notes"),
}, (t) => ({
  uqDay: unique("uq_att_day_lock").on(t.companyId, t.date),
}));

// ─── Attendance → Payroll transfers (منع الترحيل المكرر) ─────────────────────
// One row per company+period ("YYYY-MM"). The UNIQUE constraint is the ONLY
// thing standing between payroll and a double transfer — never remove it.
export const attendancePayrollTransfersTable = pgTable("attendance_payroll_transfers", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").references(() => companiesTable.id).notNull(),
  period:       text("period").notNull(),          // "2026-08"
  summary:      text("summary"),                   // JSON snapshot of per-employee totals
  transferredBy:integer("transferred_by"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  uqPeriod: unique("uq_att_payroll_transfer").on(t.companyId, t.period),
}));

// ─── Attendance Audit Log (سجل التدقيق) ──────────────────────────────────────
export const attendanceAuditTable = pgTable("attendance_audit", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").references(() => companiesTable.id).notNull(),
  userId:       integer("user_id"),
  action:       text("action").notNull(),          // create|update|delete|approve|reject|lock|reopen|recalc|transfer
  entity:       text("entity").notNull(),          // movement|permission|attendance|day_lock|payroll_transfer|shift
  entityId:     integer("entity_id"),
  oldValue:     text("old_value"),
  newValue:     text("new_value"),
  reason:       text("reason"),
  ip:           text("ip"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
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

// ═══════════════════════════════════════════════════════════════════════════
// HR Core extension (دورة حياة الموظف الكاملة) — additive tables:
// org catalogs, salary-adjustment history, transfers/assignments,
// evaluations, emergency contacts, dependents, qualifications,
// certificates, document repository, unified employee history and
// termination records. All tables are created in ensureSchema.ts
// (ensureColumns only ALTERs existing tables, never CREATEs).
// Rule: historical rows are NEVER deleted when employee data changes.
// ═══════════════════════════════════════════════════════════════════════════

// ─── الهيكل التنظيمي: الإدارات/الأقسام (شجرية عبر parentId) ─────────────────
export const hrDepartmentsTable = pgTable("hr_departments", {
  id:         serial("id").primaryKey(),
  companyId:  integer("company_id").references(() => companiesTable.id).notNull(),
  name:       text("name").notNull(),
  parentId:   integer("parent_id"),                 // إدارة أعلى (قسم داخل إدارة)
  managerEmployeeId: integer("manager_employee_id").references(() => employeesTable.id),
  isActive:   boolean("is_active").notNull().default(true),
  notes:      text("notes"),
  createdAt:  timestamp("created_at").defaultNow().notNull(),
});

// ─── الوظائف / المسميات الوظيفية ────────────────────────────────────────────
export const hrPositionsTable = pgTable("hr_positions", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").references(() => companiesTable.id).notNull(),
  title:        text("title").notNull(),
  departmentId: integer("department_id").references(() => hrDepartmentsTable.id),
  isActive:     boolean("is_active").notNull().default(true),
  notes:        text("notes"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
});

// ─── تعديلات الرواتب — سجل تاريخي، الراتب السابق لا يُستبدل أبداً ────────────
export const employeeSalaryAdjustmentsTable = pgTable("employee_salary_adjustments", {
  id:            serial("id").primaryKey(),
  companyId:     integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId:    integer("employee_id").references(() => employeesTable.id, { onDelete: "cascade" }).notNull(),
  adjustmentDate: date("adjustment_date").notNull(),
  effectiveDate: date("effective_date").notNull(),
  prevBasic:     decimal("prev_basic",  { precision: 12, scale: 2 }).notNull().default("0"),
  newBasic:      decimal("new_basic",   { precision: 12, scale: 2 }).notNull().default("0"),
  prevTotal:     decimal("prev_total",  { precision: 12, scale: 2 }).notNull().default("0"),
  newTotal:      decimal("new_total",   { precision: 12, scale: 2 }).notNull().default("0"),
  amount:        decimal("amount",      { precision: 12, scale: 2 }).notNull().default("0"),
  percent:       decimal("percent",     { precision: 7,  scale: 3 }).notNull().default("0"),
  newHousing:    decimal("new_housing", { precision: 12, scale: 2 }),
  newTransport:  decimal("new_transport",{ precision: 12, scale: 2 }),
  newOther:      decimal("new_other",   { precision: 12, scale: 2 }),
  reason:        text("reason"),
  decisionRef:   text("decision_ref"),               // قرار التعديل
  status:        text("status").notNull().default("applied"), // applied|scheduled|cancelled
  notes:         text("notes"),
  createdBy:     integer("created_by"),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
});

// ─── النقل والتكليف — حركة وظيفية بتاريخ سريان، لا تعديل مباشر صامت ─────────
export const employeeTransfersTable = pgTable("employee_transfers", {
  id:            serial("id").primaryKey(),
  companyId:     integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId:    integer("employee_id").references(() => employeesTable.id, { onDelete: "cascade" }).notNull(),
  moveType:      text("move_type").notNull(),        // transfer|assignment|promotion|job_change|branch_change|department_change|location_change|project_change|manager_change
  prevValue:     text("prev_value"),                 // JSON snapshot للبيانات السابقة
  newValue:      text("new_value"),                  // JSON للبيانات الجديدة
  decisionDate:  date("decision_date"),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo:   date("effective_to"),               // للتكليف المؤقت فقط
  isTemporary:   boolean("is_temporary").notNull().default(false),
  reason:        text("reason"),
  approvedBy:    text("approved_by"),                // جهة الاعتماد
  status:        text("status").notNull().default("applied"), // applied|scheduled|ended|cancelled
  notes:         text("notes"),
  createdBy:     integer("created_by"),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
});

// ─── تقييم الأداء ───────────────────────────────────────────────────────────
export const employeeEvaluationsTable = pgTable("employee_evaluations", {
  id:             serial("id").primaryKey(),
  companyId:      integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId:     integer("employee_id").references(() => employeesTable.id, { onDelete: "cascade" }).notNull(),
  periodFrom:     date("period_from"),
  periodTo:       date("period_to"),
  evaluator:      text("evaluator"),
  evalDate:       date("eval_date").notNull(),
  score:          decimal("score", { precision: 6, scale: 2 }),
  maxScore:       decimal("max_score", { precision: 6, scale: 2 }).default("100"),
  result:         text("result"),                    // ممتاز/جيد جداً/...
  strengths:      text("strengths"),
  weaknesses:     text("weaknesses"),
  recommendations: text("recommendations"),
  nextEvalDate:   date("next_eval_date"),
  notes:          text("notes"),
  createdBy:      integer("created_by"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
});

// ─── جهات اتصال الطوارئ ─────────────────────────────────────────────────────
export const employeeEmergencyContactsTable = pgTable("employee_emergency_contacts", {
  id:         serial("id").primaryKey(),
  companyId:  integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId: integer("employee_id").references(() => employeesTable.id, { onDelete: "cascade" }).notNull(),
  name:       text("name").notNull(),
  relation:   text("relation"),
  phone:      text("phone"),
  phone2:     text("phone2"),
  address:    text("address"),
  email:      text("email"),
  isPrimary:  boolean("is_primary").notNull().default(false),
  createdAt:  timestamp("created_at").defaultNow().notNull(),
});

// ─── أفراد الأسرة والتابعون ─────────────────────────────────────────────────
export const employeeDependentsTable = pgTable("employee_dependents", {
  id:              serial("id").primaryKey(),
  companyId:       integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId:      integer("employee_id").references(() => employeesTable.id, { onDelete: "cascade" }).notNull(),
  name:            text("name").notNull(),
  relation:        text("relation"),
  birthDate:       date("birth_date"),
  gender:          text("gender"),
  idNumber:        text("id_number"),
  benefitsEligible: boolean("benefits_eligible").notNull().default(false), // مستحق للمزايا/التأمين
  notes:           text("notes"),
  createdAt:       timestamp("created_at").defaultNow().notNull(),
});

// ─── المؤهلات العلمية ───────────────────────────────────────────────────────
export const employeeQualificationsTable = pgTable("employee_qualifications", {
  id:          serial("id").primaryKey(),
  companyId:   integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId:  integer("employee_id").references(() => employeesTable.id, { onDelete: "cascade" }).notNull(),
  degree:      text("degree").notNull(),              // المؤهل
  specialty:   text("specialty"),
  institution: text("institution"),
  gradYear:    text("grad_year"),
  grade:       text("grade"),
  attachmentUrl: text("attachment_url"),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
});

// ─── الشهادات المهنية (بتاريخ انتهاء وتنبيه) ─────────────────────────────────
export const employeeCertificatesTable = pgTable("employee_certificates", {
  id:          serial("id").primaryKey(),
  companyId:   integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId:  integer("employee_id").references(() => employeesTable.id, { onDelete: "cascade" }).notNull(),
  name:        text("name").notNull(),
  issuer:      text("issuer"),
  certNumber:  text("cert_number"),
  issueDate:   date("issue_date"),
  expiryDate:  date("expiry_date"),
  attachmentUrl: text("attachment_url"),
  notes:       text("notes"),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
});

// ─── مستودع مستندات الموظف ──────────────────────────────────────────────────
export const employeeDocumentsTable = pgTable("employee_documents", {
  id:         serial("id").primaryKey(),
  companyId:  integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId: integer("employee_id").references(() => employeesTable.id, { onDelete: "cascade" }).notNull(),
  docType:    text("doc_type").notNull(),             // هوية/عقد/مؤهل/خبرة/تأمين/...
  docNumber:  text("doc_number"),
  issueDate:  date("issue_date"),
  expiryDate: date("expiry_date"),
  fileUrl:    text("file_url"),
  notes:      text("notes"),
  createdBy:  integer("created_by"),
  createdAt:  timestamp("created_at").defaultNow().notNull(),
});

// ─── السجل الوظيفي الموحّد — append-only، يُكتب من كل عملية HR جوهرية ────────
export const employeeHistoryTable = pgTable("employee_history", {
  id:         serial("id").primaryKey(),
  companyId:  integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId: integer("employee_id").references(() => employeesTable.id, { onDelete: "cascade" }).notNull(),
  eventType:  text("event_type").notNull(),           // hire|salary_adjustment|transfer|assignment|promotion|evaluation|contract|status_change|termination|...
  eventDate:  date("event_date").notNull(),
  prevValue:  text("prev_value"),
  newValue:   text("new_value"),
  reason:     text("reason"),
  refTable:   text("ref_table"),
  refId:      integer("ref_id"),
  userId:     integer("user_id"),
  createdAt:  timestamp("created_at").defaultNow().notNull(),
});

// ─── نهاية الخدمة — سجل رسمي (ملف الموظف لا يُحذف أبداً) ─────────────────────
export const employeeTerminationsTable = pgTable("employee_terminations", {
  id:              serial("id").primaryKey(),
  companyId:       integer("company_id").references(() => companiesTable.id).notNull(),
  employeeId:      integer("employee_id").references(() => employeesTable.id, { onDelete: "cascade" }).notNull(),
  terminationType: text("termination_type").notNull(), // resignation|contract_end|termination|dismissal|retirement|other
  reason:          text("reason"),
  lastWorkDay:     date("last_work_day").notNull(),
  settlementDone:  boolean("settlement_done").notNull().default(false), // تسوية المستحقات
  custodyReturned: boolean("custody_returned").notNull().default(false),
  accessClosed:    boolean("access_closed").notNull().default(false),
  documentsUrl:    text("documents_url"),
  notes:           text("notes"),
  status:          text("status").notNull().default("active"), // active|cancelled
  createdBy:       integer("created_by"),
  createdAt:       timestamp("created_at").defaultNow().notNull(),
});
