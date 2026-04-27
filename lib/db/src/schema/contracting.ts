import {
  pgTable, serial, text, integer, numeric, timestamp, date, jsonb, index,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";
import { customersTable } from "./customers";
import { suppliersTable } from "./suppliers";
import { usersTable } from "./users";

// ─────────────────────────────────────────────────────────────────────
// Contracting / Construction ERP module (نظام إدارة المقاولات)
//
// Multi-tenant by companyId (the platform's standard scoping). All tables
// cascade-delete with the company so a company hard-delete cleans up
// without orphans.
//
// Currency: SAR everywhere (matches platform default). Prices stored as
// numeric(14,2) to be consistent with the rest of the schema.
// ─────────────────────────────────────────────────────────────────────

export const contractingProjectsTable = pgTable(
  "contracting_projects",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    branchId: integer("branch_id")
      .references(() => branchesTable.id, { onDelete: "set null" }),
    // Stable per-company code (e.g. "PRJ-2026-001"). NOT globally unique
    // because multiple tenants will reuse common formats.
    code: text("code").notNull(),
    nameAr: text("name_ar").notNull(),
    nameEn: text("name_en"),
    // Client linkage. customerId is preferred; clientName is kept as a
    // snapshot fallback so reports keep working if the customer row is
    // later soft-deleted or renamed.
    customerId: integer("customer_id")
      .references(() => customersTable.id, { onDelete: "set null" }),
    clientName: text("client_name"),
    location: text("location"),
    // building / road / infrastructure / renovation / other
    projectType: text("project_type").notNull().default("building"),
    // draft | study | contract | planning | in_progress | on_hold | completed | cancelled
    status: text("status").notNull().default("draft"),
    contractValue: numeric("contract_value", { precision: 14, scale: 2 }).notNull().default("0"),
    plannedBudget: numeric("planned_budget", { precision: 14, scale: 2 }).notNull().default("0"),
    actualCost:    numeric("actual_cost",    { precision: 14, scale: 2 }).notNull().default("0"),
    plannedStartDate: date("planned_start_date"),
    plannedEndDate:   date("planned_end_date"),
    actualStartAt:    timestamp("actual_start_at"),
    actualEndAt:      timestamp("actual_end_at"),
    // 0-100; mirrored cumulative progress used by dashboard KPIs.
    progressPercent: numeric("progress_percent", { precision: 5, scale: 2 }).notNull().default("0"),
    description: text("description"),
    meta: jsonb("meta").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byCompany:   index("ctg_proj_company_idx").on(t.companyId),
    byStatus:    index("ctg_proj_status_idx").on(t.companyId, t.status),
    byCode:      index("ctg_proj_code_idx").on(t.companyId, t.code),
  }),
);

export const contractingContractorsTable = pgTable(
  "contracting_contractors",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    // Optional link to an existing supplier — lets users avoid double-entry
    // when the contractor is already a supplier in the purchasing module.
    supplierId: integer("supplier_id")
      .references(() => suppliersTable.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    contactPerson: text("contact_person"),
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    // general | civil | electrical | plumbing | mep | finishing | landscaping | other
    specialty: text("specialty").notNull().default("general"),
    rating: numeric("rating", { precision: 3, scale: 1 }).notNull().default("0"), // 0-5
    status: text("status").notNull().default("active"), // active | inactive
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({ byCompany: index("ctg_contractor_company_idx").on(t.companyId) }),
);

export const contractingWorkItemsTable = pgTable(
  "contracting_work_items",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    projectId: integer("project_id").notNull()
      .references(() => contractingProjectsTable.id, { onDelete: "cascade" }),
    code: text("code"),
    nameAr: text("name_ar").notNull(),
    // excavation | concrete | finishing | electrical | plumbing | mep | other
    category: text("category").notNull().default("other"),
    unit: text("unit").notNull().default("m3"),
    plannedQty: numeric("planned_qty", { precision: 14, scale: 4 }).notNull().default("0"),
    actualQty:  numeric("actual_qty",  { precision: 14, scale: 4 }).notNull().default("0"),
    unitCost:          numeric("unit_cost",          { precision: 14, scale: 2 }).notNull().default("0"),
    totalPlannedCost:  numeric("total_planned_cost", { precision: 14, scale: 2 }).notNull().default("0"),
    totalActualCost:   numeric("total_actual_cost",  { precision: 14, scale: 2 }).notNull().default("0"),
    progressPercent: numeric("progress_percent", { precision: 5, scale: 2 }).notNull().default("0"),
    plannedStartDate: date("planned_start_date"),
    plannedEndDate:   date("planned_end_date"),
    // pending | in_progress | done | blocked
    status: text("status").notNull().default("pending"),
    contractorId: integer("contractor_id")
      .references(() => contractingContractorsTable.id, { onDelete: "set null" }),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byProject: index("ctg_wi_project_idx").on(t.projectId),
    byCompany: index("ctg_wi_company_idx").on(t.companyId),
  }),
);

export const contractingResourcesTable = pgTable(
  "contracting_resources",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    // Nullable: when null this is a "pool" resource not yet assigned.
    projectId: integer("project_id")
      .references(() => contractingProjectsTable.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    // labor | equipment | material
    type: text("type").notNull().default("material"),
    unit: text("unit").notNull().default("hr"),
    qty: numeric("qty", { precision: 14, scale: 4 }).notNull().default("0"),
    unitCost:  numeric("unit_cost",  { precision: 14, scale: 2 }).notNull().default("0"),
    totalCost: numeric("total_cost", { precision: 14, scale: 2 }).notNull().default("0"),
    supplierId: integer("supplier_id")
      .references(() => suppliersTable.id, { onDelete: "set null" }),
    // planned | in_use | consumed | returned
    status: text("status").notNull().default("planned"),
    usedAt: timestamp("used_at"),
    notes: text("notes"),
    meta: jsonb("meta").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byCompany: index("ctg_res_company_idx").on(t.companyId),
    byProject: index("ctg_res_project_idx").on(t.projectId),
  }),
);

export const contractingProgressBillsTable = pgTable(
  "contracting_progress_bills",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    projectId: integer("project_id").notNull()
      .references(() => contractingProjectsTable.id, { onDelete: "cascade" }),
    billNumber: text("bill_number").notNull(),
    // interim (مرحلي) | final (نهائي)
    billType: text("bill_type").notNull().default("interim"),
    billDate: date("bill_date").notNull(),
    fromDate: date("from_date"),
    toDate:   date("to_date"),
    // Cumulative project progress at the time of this bill (0-100).
    progressPercent: numeric("progress_percent", { precision: 5, scale: 2 }).notNull().default("0"),
    grossAmount:     numeric("gross_amount",      { precision: 14, scale: 2 }).notNull().default("0"),
    retentionPercent:numeric("retention_percent", { precision: 5,  scale: 2 }).notNull().default("0"),
    retentionAmount: numeric("retention_amount",  { precision: 14, scale: 2 }).notNull().default("0"),
    previousPaid:    numeric("previous_paid",     { precision: 14, scale: 2 }).notNull().default("0"),
    dueAmount:       numeric("due_amount",        { precision: 14, scale: 2 }).notNull().default("0"),
    vatAmount:       numeric("vat_amount",        { precision: 14, scale: 2 }).notNull().default("0"),
    netAmount:       numeric("net_amount",        { precision: 14, scale: 2 }).notNull().default("0"),
    // draft | submitted | approved | paid | rejected
    status: text("status").notNull().default("draft"),
    approvedByUserId: integer("approved_by_user_id")
      .references(() => usersTable.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at"),
    paidAt: timestamp("paid_at"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byProject: index("ctg_bill_project_idx").on(t.projectId),
    byCompany: index("ctg_bill_company_idx").on(t.companyId),
  }),
);

export const contractingEventsTable = pgTable(
  "contracting_events",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    projectId: integer("project_id")
      .references(() => contractingProjectsTable.id, { onDelete: "cascade" }),
    // project_created | phase_started | material_issued | bill_submitted |
    // bill_approved | risk_added | ai_suggestion | delay_detected | other
    eventType: text("event_type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    // info | warn | error
    severity: text("severity").notNull().default("info"),
    // Nullable when the event is system-generated (e.g. AI delay detection).
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    meta: jsonb("meta").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    byProject: index("ctg_event_project_idx").on(t.projectId, t.createdAt),
    byCompany: index("ctg_event_company_idx").on(t.companyId, t.createdAt),
  }),
);

export const contractingRisksTable = pgTable(
  "contracting_risks",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    projectId: integer("project_id").notNull()
      .references(() => contractingProjectsTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    // delay | cost | material | equipment | safety | legal | other
    category: text("category").notNull().default("other"),
    // low | medium | high
    likelihood: text("likelihood").notNull().default("medium"),
    impact:     text("impact").notNull().default("medium"),
    // 1-9 (likelihood × impact, mapped low=1, medium=2, high=3)
    score: integer("score").notNull().default(4),
    mitigationPlan: text("mitigation_plan"),
    ownerUserId: integer("owner_user_id")
      .references(() => usersTable.id, { onDelete: "set null" }),
    // open | mitigating | resolved | accepted
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at"),
  },
  (t) => ({
    byProject: index("ctg_risk_project_idx").on(t.projectId),
    byCompany: index("ctg_risk_company_idx").on(t.companyId, t.status),
  }),
);
