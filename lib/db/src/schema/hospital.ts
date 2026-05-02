import {
  pgTable, serial, text, integer, numeric, timestamp, boolean, pgEnum, date,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";
import { customersTable } from "./customers";

export const hospitalTypeEnum = pgEnum("hospital_type", [
  "hospital", "clinic", "dispensary", "medical_center", "polyclinic",
]);
export const hospitalStatusEnum = pgEnum("hospital_status_v2", [
  "active", "inactive", "under_renovation",
]);

export const hospitalsTable = pgTable("hospitals", {
  id:            serial("id").primaryKey(),
  companyId:     integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:      integer("branch_id").references(() => branchesTable.id, { onDelete: "set null" }),
  code:          text("code").notNull(),
  nameAr:        text("name_ar").notNull(),
  nameEn:        text("name_en"),
  type:          hospitalTypeEnum("type").notNull().default("clinic"),
  crNumber:      text("cr_number"),
  licenseNo:     text("license_no"),
  beds:          integer("beds").notNull().default(0),
  address:       text("address"),
  city:          text("city"),
  contactPhone:  text("contact_phone"),
  contactEmail:  text("contact_email"),
  status:        hospitalStatusEnum("status").notNull().default("active"),
  notes:         text("notes"),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
  updatedAt:     timestamp("updated_at").defaultNow().notNull(),
});
export type Hospital       = typeof hospitalsTable.$inferSelect;
export type InsertHospital = typeof hospitalsTable.$inferInsert;

export const hospitalDoctorsTable = pgTable("hospital_doctors", {
  id:               serial("id").primaryKey(),
  companyId:        integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  hospitalId:       integer("hospital_id").references(() => hospitalsTable.id, { onDelete: "set null" }),
  code:             text("code").notNull(),
  nameAr:           text("name_ar").notNull(),
  nameEn:           text("name_en"),
  specialty:        text("specialty"),
  licenseNo:        text("license_no"),
  phone:            text("phone"),
  email:            text("email"),
  consultationFee:  numeric("consultation_fee", { precision: 15, scale: 2 }).notNull().default("0"),
  isActive:         boolean("is_active").notNull().default(true),
  notes:            text("notes"),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
  updatedAt:        timestamp("updated_at").defaultNow().notNull(),
});
export type HospitalDoctor       = typeof hospitalDoctorsTable.$inferSelect;
export type InsertHospitalDoctor = typeof hospitalDoctorsTable.$inferInsert;

export const hospitalGenderEnum = pgEnum("hospital_gender", ["male", "female"]);
export const hospitalIdTypeEnum = pgEnum("hospital_id_type", [
  "national_id", "iqama", "passport", "gcc_id", "other",
]);

export const hospitalPatientsTable = pgTable("hospital_patients", {
  id:            serial("id").primaryKey(),
  companyId:     integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  code:          text("code").notNull(),
  fullNameAr:    text("full_name_ar").notNull(),
  fullNameEn:    text("full_name_en"),
  nationalId:    text("national_id"),
  idType:        hospitalIdTypeEnum("id_type").notNull().default("national_id"),
  dob:           date("dob"),
  gender:        hospitalGenderEnum("gender").notNull().default("male"),
  phone:         text("phone"),
  email:         text("email"),
  bloodType:     text("blood_type"),
  address:       text("address"),
  city:          text("city"),
  // Insurance bookkeeping (the actual NPHIES Coverage resource is built
  // dynamically by hospital-ai when we generate a Claim).
  insurerName:   text("insurer_name"),
  policyNo:      text("policy_no"),
  policyExpires: date("policy_expires"),
  coveragePct:   numeric("coverage_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  customerId:    integer("customer_id").references(() => customersTable.id, { onDelete: "set null" }),
  notes:         text("notes"),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
  updatedAt:     timestamp("updated_at").defaultNow().notNull(),
});
export type HospitalPatient       = typeof hospitalPatientsTable.$inferSelect;
export type InsertHospitalPatient = typeof hospitalPatientsTable.$inferInsert;

export const hospitalAppointmentStatusEnum = pgEnum("hospital_appointment_status", [
  "scheduled", "checked_in", "in_progress", "completed", "cancelled", "no_show",
]);
export const hospitalVisitTypeEnum = pgEnum("hospital_visit_type", [
  "consultation", "follow_up", "emergency", "procedure", "lab", "imaging",
]);

export const hospitalAppointmentsTable = pgTable("hospital_appointments", {
  id:               serial("id").primaryKey(),
  companyId:        integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  hospitalId:       integer("hospital_id").references(() => hospitalsTable.id, { onDelete: "set null" }),
  docNumber:        text("doc_number").notNull(),
  patientId:        integer("patient_id").notNull().references(() => hospitalPatientsTable.id, { onDelete: "restrict" }),
  doctorId:         integer("doctor_id").notNull().references(() => hospitalDoctorsTable.id, { onDelete: "restrict" }),
  scheduledAt:      timestamp("scheduled_at").notNull(),
  status:           hospitalAppointmentStatusEnum("status").notNull().default("scheduled"),
  visitType:        hospitalVisitTypeEnum("visit_type").notNull().default("consultation"),
  chiefComplaint:   text("chief_complaint"),
  diagnosis:        text("diagnosis"),
  icd10Code:        text("icd10_code"),
  treatment:        text("treatment"),
  prescriptions:    text("prescriptions"),
  vitals:           text("vitals"),
  estimatedCost:    numeric("estimated_cost", { precision: 15, scale: 2 }).notNull().default("0"),
  notes:            text("notes"),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
  updatedAt:        timestamp("updated_at").defaultNow().notNull(),
});
export type HospitalAppointment       = typeof hospitalAppointmentsTable.$inferSelect;
export type InsertHospitalAppointment = typeof hospitalAppointmentsTable.$inferInsert;

export const hospitalInvoiceStatusEnum = pgEnum("hospital_invoice_status", [
  "draft", "issued", "partial", "paid", "cancelled",
]);

export const hospitalInvoicesTable = pgTable("hospital_invoices", {
  id:                  serial("id").primaryKey(),
  companyId:           integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  docNumber:           text("doc_number").notNull(),
  appointmentId:       integer("appointment_id").references(() => hospitalAppointmentsTable.id, { onDelete: "set null" }),
  patientId:           integer("patient_id").notNull().references(() => hospitalPatientsTable.id, { onDelete: "restrict" }),
  doctorId:            integer("doctor_id").references(() => hospitalDoctorsTable.id, { onDelete: "set null" }),
  hospitalId:          integer("hospital_id").references(() => hospitalsTable.id, { onDelete: "set null" }),
  totalAmount:         numeric("total_amount",         { precision: 15, scale: 2 }).notNull().default("0"),
  insuranceCoverage:   numeric("insurance_coverage",   { precision: 15, scale: 2 }).notNull().default("0"),
  patientShare:        numeric("patient_share",        { precision: 15, scale: 2 }).notNull().default("0"),
  paidAmount:          numeric("paid_amount",          { precision: 15, scale: 2 }).notNull().default("0"),
  status:              hospitalInvoiceStatusEnum("status").notNull().default("draft"),
  issuedAt:            timestamp("issued_at"),
  notes:               text("notes"),
  createdAt:           timestamp("created_at").defaultNow().notNull(),
  updatedAt:           timestamp("updated_at").defaultNow().notNull(),
});
export type HospitalInvoice       = typeof hospitalInvoicesTable.$inferSelect;
export type InsertHospitalInvoice = typeof hospitalInvoicesTable.$inferInsert;

export const hospitalInvoiceItemsTable = pgTable("hospital_invoice_items", {
  id:           serial("id").primaryKey(),
  invoiceId:    integer("invoice_id").notNull().references(() => hospitalInvoicesTable.id, { onDelete: "cascade" }),
  description:  text("description").notNull(),
  serviceCode:  text("service_code"),
  qty:          numeric("qty",        { precision: 15, scale: 3 }).notNull().default("1"),
  unitPrice:    numeric("unit_price", { precision: 15, scale: 2 }).notNull().default("0"),
  total:        numeric("total",      { precision: 15, scale: 2 }).notNull().default("0"),
});
export type HospitalInvoiceItem       = typeof hospitalInvoiceItemsTable.$inferSelect;
export type InsertHospitalInvoiceItem = typeof hospitalInvoiceItemsTable.$inferInsert;

export const hospitalClaimStatusEnum = pgEnum("hospital_claim_status", [
  "draft", "queued", "sent", "approved", "rejected", "pending_info", "cancelled",
]);

// Insurance / NPHIES claims. The real NPHIES connection requires CCHI
// accreditation — until then the FHIR R4 payload is generated locally and
// stored as JSON text so it can be inspected, queued and (later) POST-ed
// to the live integration gateway without schema changes.
export const hospitalClaimsTable = pgTable("hospital_insurance_claims", {
  id:               serial("id").primaryKey(),
  companyId:        integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  invoiceId:        integer("invoice_id").notNull().references(() => hospitalInvoicesTable.id, { onDelete: "cascade" }),
  payerName:        text("payer_name").notNull(),
  policyNo:         text("policy_no"),
  claimNumber:      text("claim_number").notNull(),
  status:           hospitalClaimStatusEnum("status").notNull().default("draft"),
  totalAmount:      numeric("total_amount",     { precision: 15, scale: 2 }).notNull().default("0"),
  approvedAmount:   numeric("approved_amount",  { precision: 15, scale: 2 }).notNull().default("0"),
  rejectionReason:  text("rejection_reason"),
  fhirPayload:      text("fhir_payload"),       // serialized FHIR R4 Claim resource
  responsePayload:  text("response_payload"),   // serialized NPHIES ClaimResponse
  sentAt:           timestamp("sent_at"),
  respondedAt:      timestamp("responded_at"),
  notes:            text("notes"),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
  updatedAt:        timestamp("updated_at").defaultNow().notNull(),
});
export type HospitalClaim       = typeof hospitalClaimsTable.$inferSelect;
export type InsertHospitalClaim = typeof hospitalClaimsTable.$inferInsert;
