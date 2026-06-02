// Occupational Safety & Health (OSH) module — السلامة والصحة المهنية
//
// Phase 1 (ISO 45001:2018 core): Risk Assessment register (5×5 matrix +
// hierarchy of controls + residual risk), Incident/Accident management
// (near-miss → fatality classification, 5-Whys root cause, links to work
// center / production order / employee), and CAPA (corrective/preventive
// actions). No journal entries — OSH is operational, not financial.
//
// Multi-tenant, branch-scoped, mirroring the production schema conventions.
import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  date,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";
import { usersTable } from "./users";
import { workCentersTable, productionOrdersTable } from "./production";
import { employeesTable } from "./hr";

// ─── Shared enums (kept as plain const arrays for runtime validation) ────────
export const SAFETY_HAZARD_CATEGORIES = [
  "mechanical",
  "electrical",
  "chemical",
  "ergonomic",
  "biological",
  "physical",
  "psychosocial",
  "fire",
  "fall",
  "environmental",
  "other",
] as const;
export type SafetyHazardCategory = (typeof SAFETY_HAZARD_CATEGORIES)[number];

// ISO 45001 / standard 5×5 matrix → qualitative band.
export const SAFETY_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type SafetyRiskLevel = (typeof SAFETY_RISK_LEVELS)[number];

export const SAFETY_RISK_STATUSES = [
  "open",
  "in_review",
  "controlled",
  "closed",
] as const;
export type SafetyRiskStatus = (typeof SAFETY_RISK_STATUSES)[number];

// ISO 45001 §8.1.2 hierarchy of controls (most → least effective).
export const SAFETY_CONTROL_TYPES = [
  "elimination",
  "substitution",
  "engineering",
  "administrative",
  "ppe",
] as const;
export type SafetyControlType = (typeof SAFETY_CONTROL_TYPES)[number];

export const SAFETY_CONTROL_STATUSES = [
  "planned",
  "in_progress",
  "done",
] as const;
export type SafetyControlStatus = (typeof SAFETY_CONTROL_STATUSES)[number];

export const SAFETY_INCIDENT_TYPES = [
  "near_miss",
  "unsafe_condition",
  "property_damage",
  "injury",
  "occupational_illness",
  "environmental",
] as const;
export type SafetyIncidentType = (typeof SAFETY_INCIDENT_TYPES)[number];

// OSHA-style severity classification (drives TRIR / LTIFR / days-since-LTI).
export const SAFETY_SEVERITY_CLASSES = [
  "no_treatment",
  "first_aid",
  "medical_treatment",
  "lost_time",
  "fatality",
] as const;
export type SafetySeverityClass = (typeof SAFETY_SEVERITY_CLASSES)[number];

export const SAFETY_INCIDENT_STATUSES = [
  "open",
  "investigating",
  "action_pending",
  "closed",
] as const;
export type SafetyIncidentStatus = (typeof SAFETY_INCIDENT_STATUSES)[number];

export const SAFETY_ACTION_TYPES = ["corrective", "preventive"] as const;
export type SafetyActionType = (typeof SAFETY_ACTION_TYPES)[number];

export const SAFETY_ACTION_STATUSES = [
  "open",
  "in_progress",
  "done",
] as const;
export type SafetyActionStatus = (typeof SAFETY_ACTION_STATUSES)[number];

// ────────────────────────────────────────────────────────────────────────
// RISK ASSESSMENT REGISTER (سجل تقييم المخاطر)
// ────────────────────────────────────────────────────────────────────────
export const safetyRiskAssessmentsTable = pgTable(
  "safety_risk_assessments",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    branchId: integer("branch_id").references(() => branchesTable.id, {
      onDelete: "set null",
    }),
    code: text("code").notNull(),
    title: text("title").notNull(),
    processArea: text("process_area"),
    workCenterId: integer("work_center_id").references(() => workCentersTable.id, {
      onDelete: "set null",
    }),
    hazardDescription: text("hazard_description"),
    hazardCategory: text("hazard_category")
      .notNull()
      .default("other")
      .$type<SafetyHazardCategory>(),
    // Inherent risk (before / with existing controls): 1-5 each.
    likelihood: integer("likelihood").notNull().default(1),
    severity: integer("severity").notNull().default(1),
    riskScore: integer("risk_score").notNull().default(1),
    riskLevel: text("risk_level").notNull().default("low").$type<SafetyRiskLevel>(),
    existingControls: text("existing_controls"),
    // Residual risk (after additional controls implemented): nullable until set.
    residualLikelihood: integer("residual_likelihood"),
    residualSeverity: integer("residual_severity"),
    residualScore: integer("residual_score"),
    residualLevel: text("residual_level").$type<SafetyRiskLevel>(),
    responsibleUserId: integer("responsible_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    assessmentDate: date("assessment_date"),
    reviewDate: date("review_date"),
    status: text("status").notNull().default("open").$type<SafetyRiskStatus>(),
    notes: text("notes"),
    createdBy: integer("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byCompany: index("safety_ra_company_idx").on(t.companyId),
    byStatus: index("safety_ra_status_idx").on(t.companyId, t.status),
  }),
);

// Hierarchy-of-controls line items attached to a risk assessment.
export const safetyRiskControlsTable = pgTable(
  "safety_risk_controls",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    assessmentId: integer("assessment_id")
      .notNull()
      .references(() => safetyRiskAssessmentsTable.id, { onDelete: "cascade" }),
    controlType: text("control_type")
      .notNull()
      .default("administrative")
      .$type<SafetyControlType>(),
    description: text("description").notNull(),
    status: text("status").notNull().default("planned").$type<SafetyControlStatus>(),
    ownerUserId: integer("owner_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    dueDate: date("due_date"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    byAssessment: index("safety_rc_assessment_idx").on(t.assessmentId),
  }),
);

// ────────────────────────────────────────────────────────────────────────
// INCIDENT / ACCIDENT MANAGEMENT (إدارة الحوادث والإصابات)
// ────────────────────────────────────────────────────────────────────────
export const safetyIncidentsTable = pgTable(
  "safety_incidents",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    branchId: integer("branch_id").references(() => branchesTable.id, {
      onDelete: "set null",
    }),
    incidentNumber: text("incident_number").notNull(),
    incidentType: text("incident_type")
      .notNull()
      .default("near_miss")
      .$type<SafetyIncidentType>(),
    severityClass: text("severity_class")
      .notNull()
      .default("no_treatment")
      .$type<SafetySeverityClass>(),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    workCenterId: integer("work_center_id").references(
      () => workCentersTable.id,
      { onDelete: "set null" },
    ),
    productionOrderId: integer("production_order_id").references(
      () => productionOrdersTable.id,
      { onDelete: "set null" },
    ),
    injuredEmployeeId: integer("injured_employee_id").references(
      () => employeesTable.id,
      { onDelete: "set null" },
    ),
    occurredAt: timestamp("occurred_at").notNull(),
    reportedAt: timestamp("reported_at").defaultNow().notNull(),
    reportedByUserId: integer("reported_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    immediateActions: text("immediate_actions"),
    rootCause: text("root_cause"),
    // 5-Whys investigation — array of up to 5 strings.
    whys: jsonb("whys").$type<string[]>().default([]),
    lostDays: integer("lost_days").notNull().default(0),
    // OSHA-recordable flag — drives TRIR. Derived from severityClass on save
    // but stored so manual overrides survive.
    isRecordable: boolean("is_recordable").notNull().default(false),
    status: text("status").notNull().default("open").$type<SafetyIncidentStatus>(),
    createdBy: integer("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byCompany: index("safety_inc_company_idx").on(t.companyId),
    byOccurred: index("safety_inc_occurred_idx").on(t.companyId, t.occurredAt),
  }),
);

// CAPA — corrective & preventive actions attached to an incident.
export const safetyIncidentActionsTable = pgTable(
  "safety_incident_actions",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    incidentId: integer("incident_id")
      .notNull()
      .references(() => safetyIncidentsTable.id, { onDelete: "cascade" }),
    actionType: text("action_type")
      .notNull()
      .default("corrective")
      .$type<SafetyActionType>(),
    description: text("description").notNull(),
    ownerUserId: integer("owner_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    dueDate: date("due_date"),
    status: text("status").notNull().default("open").$type<SafetyActionStatus>(),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byIncident: index("safety_act_incident_idx").on(t.incidentId),
  }),
);

export type SafetyRiskAssessment = typeof safetyRiskAssessmentsTable.$inferSelect;
export type SafetyRiskControl = typeof safetyRiskControlsTable.$inferSelect;
export type SafetyIncident = typeof safetyIncidentsTable.$inferSelect;
export type SafetyIncidentAction = typeof safetyIncidentActionsTable.$inferSelect;
