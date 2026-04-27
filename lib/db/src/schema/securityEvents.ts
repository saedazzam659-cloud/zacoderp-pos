import { pgTable, serial, integer, varchar, text, timestamp, index, numeric } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const SECURITY_EVENT_TYPES = [
  "intrusion",
  "theft",
  "suspicious_movement",
  "unknown_person",
  "after_hours_presence",
  "missing_item",
  "unusual_gathering",
  "tampering",
  "other",
] as const;

export const SECURITY_EVENT_SEVERITIES = ["low", "medium", "high", "critical"] as const;

export const SECURITY_EVENT_STATUSES = [
  "open",
  "investigating",
  "closed",
  "false_positive",
] as const;

export const securityEventsTable = pgTable("security_events", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull(),
  branchId: integer("branch_id"),
  cameraLabel: varchar("camera_label", { length: 200 }),
  eventType: varchar("event_type", { length: 50 }).notNull(),
  severity: varchar("severity", { length: 20 }).notNull().default("medium"),
  title: varchar("title", { length: 300 }).notNull(),
  description: text("description"),
  imageUrl: text("image_url"),
  videoClipUrl: text("video_clip_url"),
  // 0.0000 - 1.0000 — confidence score from AI (manual events leave it null)
  confidence: numeric("confidence", { precision: 5, scale: 4 }),
  eventDateTime: timestamp("event_date_time", { withTimezone: false }).notNull().defaultNow(),
  status: varchar("status", { length: 20 }).notNull().default("open"),
  assignedToUserId: integer("assigned_to_user_id"),
  createdByUserId: integer("created_by_user_id"),
  resolvedAt: timestamp("resolved_at", { withTimezone: false }),
  resolutionNote: text("resolution_note"),
  createdAt: timestamp("created_at", { withTimezone: false }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: false }).notNull().default(sql`now()`),
}, (t) => ({
  byCompanyDate: index("security_events_company_date_idx").on(t.companyId, t.eventDateTime),
  byCompanyStatus: index("security_events_company_status_idx").on(t.companyId, t.status),
  byCompanySeverity: index("security_events_company_severity_idx").on(t.companyId, t.severity),
}));

export type SecurityEventRow = typeof securityEventsTable.$inferSelect;
export type SecurityEventInsert = typeof securityEventsTable.$inferInsert;
