import {
  pgTable, serial, text, integer, decimal, timestamp, boolean, date, jsonb, index,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";
import { employeesTable } from "./hr";
import { customersTable } from "./customers";
import { costCentersTable } from "./costCenters";

// ─────────────────────────────────────────────────────────────────────
// Field Service Management (FSM) — unified module that powers:
//   • Project engineers moving between job sites
//   • Sales reps following daily customer routes
//   • Maintenance technicians responding to service tickets with SLA
//
// Single `field_locations` registry + `field_visits` event log feeds all
// three personas. `field_visit_plans` adds route planning for sales,
// `field_service_tickets` adds SLA-tracked work for maintenance.
// All tables are tenant-scoped via companyId and cascade-delete with the
// company. Foreign keys to optional related entities use ON DELETE SET NULL
// so historical visits survive master-data cleanups.
// ─────────────────────────────────────────────────────────────────────

// One row per physical site the company cares about: head office, branch,
// customer premises, project location, asset installation, supplier yard.
// `type` lets us colour-code on the map and filter reports.
export const fieldLocationsTable = pgTable(
  "field_locations",
  {
    id:             serial("id").primaryKey(),
    companyId:      integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
    branchId:       integer("branch_id").references(() => branchesTable.id, { onDelete: "set null" }),
    name:           text("name").notNull(),
    // office | branch | customer | project | asset | warehouse | supplier | other
    type:           text("type").notNull().default("customer"),
    lat:            decimal("lat",     { precision: 10, scale: 7 }).notNull(),
    lng:            decimal("lng",     { precision: 10, scale: 7 }).notNull(),
    radiusM:        integer("radius_m").notNull().default(150),
    // Soft links to other modules — populated when the location was created
    // from a customer / project / asset record. NULLable: free-form sites
    // (e.g. a temporary booth) live here too.
    customerId:     integer("customer_id").references(() => customersTable.id, { onDelete: "set null" }),
    projectId:      integer("project_id"),         // contracting_projects.id (soft ref to avoid circular import)
    assetId:        integer("asset_id"),           // maintenance_assets.id (soft ref)
    costCenterId:   integer("cost_center_id").references(() => costCentersTable.id, { onDelete: "set null" }),
    address:        text("address"),
    city:           text("city"),
    contactPerson:  text("contact_person"),
    contactPhone:   text("contact_phone"),
    isActive:       boolean("is_active").notNull().default(true),
    notes:          text("notes"),
    createdAt:      timestamp("created_at").defaultNow().notNull(),
    updatedAt:      timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byCompany:  index("field_loc_company_idx").on(t.companyId),
    byType:     index("field_loc_type_idx").on(t.companyId, t.type),
    byCustomer: index("field_loc_customer_idx").on(t.customerId),
  }),
);

// One row per arrival-at-a-site event. The same employee can have many open
// visits in a day (project tour, customer round). `arrivedAt` is set on
// start; `leftAt`+`durationMin` set on end. Visit links to whatever doc
// triggered it (sales call → customerId, maintenance call → ticketId).
export const fieldVisitsTable = pgTable(
  "field_visits",
  {
    id:                   serial("id").primaryKey(),
    companyId:            integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
    employeeId:           integer("employee_id").notNull().references(() => employeesTable.id, { onDelete: "cascade" }),
    locationId:           integer("location_id").references(() => fieldLocationsTable.id, { onDelete: "set null" }),
    // Snapshot of location name/type so reports survive a location rename or
    // delete (location row gets SET NULL, but the report still shows what it
    // was).
    locationName:         text("location_name"),
    locationType:         text("location_type"),
    customerId:           integer("customer_id").references(() => customersTable.id, { onDelete: "set null" }),
    projectId:            integer("project_id"),
    assetId:              integer("asset_id"),
    ticketId:             integer("ticket_id"),    // field_service_tickets.id (soft ref)
    costCenterId:         integer("cost_center_id").references(() => costCentersTable.id, { onDelete: "set null" }),
    // sales_call | delivery | maintenance | inspection | site_visit | meeting | other
    purpose:              text("purpose").notNull().default("site_visit"),
    // open | completed | cancelled
    status:               text("status").notNull().default("open"),
    arrivedAt:            timestamp("arrived_at").notNull().defaultNow(),
    leftAt:               timestamp("left_at"),
    durationMin:          integer("duration_min"),
    // GPS at arrival / departure — used for distance-from-target check and
    // for drawing the day's route on a map.
    arrivalLat:           decimal("arrival_lat",      { precision: 10, scale: 7 }),
    arrivalLng:           decimal("arrival_lng",      { precision: 10, scale: 7 }),
    arrivalAccuracyM:     decimal("arrival_accuracy_m",  { precision: 8, scale: 2 }),
    arrivalDistanceM:     decimal("arrival_distance_m",  { precision: 10, scale: 2 }),
    arrivalLocStatus:     text("arrival_loc_status"),   // ok | out_of_geofence | denied | low_accuracy | no_gps
    departureLat:         decimal("departure_lat",    { precision: 10, scale: 7 }),
    departureLng:         decimal("departure_lng",    { precision: 10, scale: 7 }),
    departureAccuracyM:   decimal("departure_accuracy_m",{ precision: 8, scale: 2 }),
    // outcome: completed | rescheduled | no_answer | issue_found | quote_sent | deal_closed | nothing | other
    outcome:              text("outcome"),
    // Sales / FSM extras
    photoUrl:             text("photo_url"),         // proof-of-visit selfie or site photo
    signatureUrl:         text("signature_url"),     // customer signature (data URL or object-storage key)
    signedByName:         text("signed_by_name"),
    formData:             jsonb("form_data").$type<Record<string, unknown>>().default({}),
    notes:                text("notes"),
    createdAt:            timestamp("created_at").defaultNow().notNull(),
    updatedAt:            timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byCompany:    index("field_visits_company_idx").on(t.companyId),
    byEmployee:   index("field_visits_employee_idx").on(t.employeeId),
    byStatus:     index("field_visits_status_idx").on(t.companyId, t.status),
    byArrived:    index("field_visits_arrived_idx").on(t.arrivedAt),
    byTicket:     index("field_visits_ticket_idx").on(t.ticketId),
  }),
);

// Daily route plan — manager pre-builds the day's stops for a sales rep or
// a technician. Items reference fieldLocations and convert to actual visits
// as the field staff checks in.
export const fieldVisitPlansTable = pgTable(
  "field_visit_plans",
  {
    id:           serial("id").primaryKey(),
    companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
    employeeId:   integer("employee_id").notNull().references(() => employeesTable.id, { onDelete: "cascade" }),
    date:         date("date").notNull(),
    // draft | published | in_progress | completed | cancelled
    status:       text("status").notNull().default("published"),
    notes:        text("notes"),
    createdBy:    integer("created_by"),
    createdAt:    timestamp("created_at").defaultNow().notNull(),
    updatedAt:    timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byEmpDate: index("field_plans_emp_date_idx").on(t.employeeId, t.date),
  }),
);

export const fieldVisitPlanItemsTable = pgTable(
  "field_visit_plan_items",
  {
    id:           serial("id").primaryKey(),
    planId:       integer("plan_id").notNull().references(() => fieldVisitPlansTable.id, { onDelete: "cascade" }),
    sequenceNo:   integer("sequence_no").notNull().default(1),
    locationId:   integer("location_id").references(() => fieldLocationsTable.id, { onDelete: "set null" }),
    locationName: text("location_name"),     // snapshot
    plannedAt:    timestamp("planned_at"),
    purpose:      text("purpose"),
    // pending | done | skipped
    status:       text("status").notNull().default("pending"),
    visitId:      integer("visit_id").references(() => fieldVisitsTable.id, { onDelete: "set null" }),
    notes:        text("notes"),
  },
);

// Service tickets — the FSM heart. Links an asset/customer issue to an
// assigned technician with SLA timers. Response SLA = arrival timer.
// Resolution SLA = total time-to-fix. Both are computed on close.
export const fieldServiceTicketsTable = pgTable(
  "field_service_tickets",
  {
    id:                       serial("id").primaryKey(),
    companyId:                integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
    branchId:                 integer("branch_id").references(() => branchesTable.id, { onDelete: "set null" }),
    ticketNo:                 text("ticket_no").notNull(),       // e.g. SR-2026-0001
    customerId:               integer("customer_id").references(() => customersTable.id, { onDelete: "set null" }),
    assetId:                  integer("asset_id"),               // maintenance_assets.id
    locationId:               integer("location_id").references(() => fieldLocationsTable.id, { onDelete: "set null" }),
    title:                    text("title").notNull(),
    description:              text("description"),
    // installation | repair | preventive | inspection | complaint | other
    category:                 text("category").notNull().default("repair"),
    // low | medium | high | urgent
    priority:                 text("priority").notNull().default("medium"),
    // open | assigned | in_progress | on_hold | resolved | closed | cancelled
    status:                   text("status").notNull().default("open"),
    openedAt:                 timestamp("opened_at").notNull().defaultNow(),
    openedBy:                 integer("opened_by"),
    assignedTo:               integer("assigned_to").references(() => employeesTable.id, { onDelete: "set null" }),
    assignedAt:               timestamp("assigned_at"),
    respondedAt:              timestamp("responded_at"),
    resolvedAt:               timestamp("resolved_at"),
    closedAt:                 timestamp("closed_at"),
    // Targets in minutes (per priority — defaulted on insert by route)
    slaResponseMin:           integer("sla_response_min").notNull().default(60),
    slaResolutionMin:         integer("sla_resolution_min").notNull().default(480),
    slaResponseBreached:      boolean("sla_response_breached").notNull().default(false),
    slaResolutionBreached:    boolean("sla_resolution_breached").notNull().default(false),
    resolution:               text("resolution"),
    customerRating:           integer("customer_rating"),   // 1..5
    laborHours:               decimal("labor_hours",  { precision: 10, scale: 2 }).default("0"),
    laborCost:                decimal("labor_cost",   { precision: 15, scale: 2 }).default("0"),
    partsCost:                decimal("parts_cost",   { precision: 15, scale: 2 }).default("0"),
    totalCost:                decimal("total_cost",   { precision: 15, scale: 2 }).default("0"),
    notes:                    text("notes"),
    createdAt:                timestamp("created_at").defaultNow().notNull(),
    updatedAt:                timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byCompany:  index("field_tickets_company_idx").on(t.companyId),
    byStatus:   index("field_tickets_status_idx").on(t.companyId, t.status),
    byAssigned: index("field_tickets_assigned_idx").on(t.assignedTo),
    byTicketNo: index("field_tickets_no_idx").on(t.companyId, t.ticketNo),
  }),
);

export type FieldLocation       = typeof fieldLocationsTable.$inferSelect;
export type FieldVisit          = typeof fieldVisitsTable.$inferSelect;
export type FieldVisitPlan      = typeof fieldVisitPlansTable.$inferSelect;
export type FieldVisitPlanItem  = typeof fieldVisitPlanItemsTable.$inferSelect;
export type FieldServiceTicket  = typeof fieldServiceTicketsTable.$inferSelect;
