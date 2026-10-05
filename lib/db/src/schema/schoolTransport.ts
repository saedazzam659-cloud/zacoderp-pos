import {
  boolean,
  date,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { employeesTable } from "./hr";
import {
  schoolAcademicYearsTable,
  schoolCampusesTable,
  schoolEnrollmentsTable,
} from "./schools";

export const schoolTransportVehiclesTable = pgTable("school_transport_vehicles", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  plateNumber: text("plate_number").notNull(),
  ownerType: text("owner_type").notNull().default("school_owned"),
  capacity: integer("capacity").notNull().default(0),
  // Cross-module references are validated against the current company in the API.
  // They intentionally have no FK so school schema healing does not depend on
  // the order in which optional ERP modules are initialized.
  fixedAssetId: integer("fixed_asset_id"),
  supplierId: integer("supplier_id"),
  leaseContractNo: text("lease_contract_no"),
  leaseStartDate: date("lease_start_date", { mode: "string" }),
  leaseEndDate: date("lease_end_date", { mode: "string" }),
  monthlyRent: numeric("monthly_rent", { precision: 15, scale: 2 }),
  status: text("status").notNull().default("active"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  companyCodeUq: uniqueIndex("uq_school_transport_vehicle_company_code").on(t.companyId, t.code),
  companyPlateUq: uniqueIndex("uq_school_transport_vehicle_company_plate").on(t.companyId, t.plateNumber),
  companyAssetUq: uniqueIndex("uq_school_transport_vehicle_company_asset").on(t.companyId, t.fixedAssetId),
}));
export type SchoolTransportVehicle = typeof schoolTransportVehiclesTable.$inferSelect;
export type InsertSchoolTransportVehicle = typeof schoolTransportVehiclesTable.$inferInsert;

export const schoolTransportRoutesTable = pgTable("school_transport_routes", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  academicYearId: integer("academic_year_id").notNull()
    .references(() => schoolAcademicYearsTable.id, { onDelete: "restrict" }),
  campusId: integer("campus_id").references(() => schoolCampusesTable.id, { onDelete: "set null" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  vehicleId: integer("vehicle_id").notNull()
    .references(() => schoolTransportVehiclesTable.id, { onDelete: "restrict" }),
  driverEmployeeId: integer("driver_employee_id").references(() => employeesTable.id, { onDelete: "set null" }),
  attendantEmployeeId: integer("attendant_employee_id").references(() => employeesTable.id, { onDelete: "set null" }),
  direction: text("direction").notNull().default("round_trip"),
  capacityOverride: integer("capacity_override"),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  companyYearCodeUq: uniqueIndex("uq_school_transport_route_company_year_code")
    .on(t.companyId, t.academicYearId, t.code),
}));
export type SchoolTransportRoute = typeof schoolTransportRoutesTable.$inferSelect;
export type InsertSchoolTransportRoute = typeof schoolTransportRoutesTable.$inferInsert;

export const schoolTransportStopsTable = pgTable("school_transport_stops", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  routeId: integer("route_id").notNull()
    .references(() => schoolTransportRoutesTable.id, { onDelete: "restrict" }),
  sequence: integer("sequence").notNull(),
  name: text("name").notNull(),
  address: text("address"),
  pickupTime: text("pickup_time"),
  dropoffTime: text("dropoff_time"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  routeSequenceUq: uniqueIndex("uq_school_transport_stop_route_sequence")
    .on(t.companyId, t.routeId, t.sequence),
}));
export type SchoolTransportStop = typeof schoolTransportStopsTable.$inferSelect;
export type InsertSchoolTransportStop = typeof schoolTransportStopsTable.$inferInsert;

export const schoolTransportAssignmentsTable = pgTable("school_transport_assignments", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  academicYearId: integer("academic_year_id").notNull()
    .references(() => schoolAcademicYearsTable.id, { onDelete: "restrict" }),
  enrollmentId: integer("enrollment_id").notNull()
    .references(() => schoolEnrollmentsTable.id, { onDelete: "restrict" }),
  routeId: integer("route_id").notNull()
    .references(() => schoolTransportRoutesTable.id, { onDelete: "restrict" }),
  pickupStopId: integer("pickup_stop_id").references(() => schoolTransportStopsTable.id, { onDelete: "restrict" }),
  dropoffStopId: integer("dropoff_stop_id").references(() => schoolTransportStopsTable.id, { onDelete: "restrict" }),
  serviceType: text("service_type").notNull().default("round_trip"),
  startDate: date("start_date", { mode: "string" }).notNull(),
  endDate: date("end_date", { mode: "string" }),
  status: text("status").notNull().default("active"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  enrollmentYearUq: uniqueIndex("uq_school_transport_assignment_company_year_enrollment")
    .on(t.companyId, t.academicYearId, t.enrollmentId),
}));
export type SchoolTransportAssignment = typeof schoolTransportAssignmentsTable.$inferSelect;
export type InsertSchoolTransportAssignment = typeof schoolTransportAssignmentsTable.$inferInsert;
