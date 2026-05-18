import { pgTable, serial, integer, text, timestamp, numeric, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import { branchesTable } from "./branches";

export const userVisitsTable = pgTable("user_visits", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  branchId: integer("branch_id").references(() => branchesTable.id, { onDelete: "set null" }),
  purpose: text("purpose"),
  notes: text("notes"),
  status: text("status").notNull().default("active"),
  checkinAt: timestamp("checkin_at").defaultNow().notNull(),
  checkinLat: numeric("checkin_lat", { precision: 10, scale: 7 }),
  checkinLng: numeric("checkin_lng", { precision: 10, scale: 7 }),
  checkinPlace: text("checkin_place"),
  checkinAddress: text("checkin_address"),
  checkinAccuracy: numeric("checkin_accuracy", { precision: 10, scale: 2 }),
  checkoutAt: timestamp("checkout_at"),
  checkoutLat: numeric("checkout_lat", { precision: 10, scale: 7 }),
  checkoutLng: numeric("checkout_lng", { precision: 10, scale: 7 }),
  checkoutPlace: text("checkout_place"),
  checkoutAddress: text("checkout_address"),
  checkoutAccuracy: numeric("checkout_accuracy", { precision: 10, scale: 2 }),
  durationMinutes: integer("duration_minutes"),
  zoneId: integer("zone_id"),
  alertFlags: text("alert_flags"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  byCompanyUser: index("idx_user_visits_company_user").on(t.companyId, t.userId, t.checkinAt),
  byStatus:      index("idx_user_visits_status").on(t.companyId, t.status),
}));

export const trackingZonesTable = pgTable("tracking_zones", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  centerLat: numeric("center_lat", { precision: 10, scale: 7 }).notNull(),
  centerLng: numeric("center_lng", { precision: 10, scale: 7 }).notNull(),
  radiusMeters: integer("radius_meters").notNull().default(500),
  isAllowed: boolean("is_allowed").notNull().default(true),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertUserVisitSchema = createInsertSchema(userVisitsTable).omit({
  id: true, createdAt: true, updatedAt: true, durationMinutes: true,
});
export const insertTrackingZoneSchema = createInsertSchema(trackingZonesTable).omit({
  id: true, createdAt: true,
});

export type UserVisit = typeof userVisitsTable.$inferSelect;
export type InsertUserVisit = z.infer<typeof insertUserVisitSchema>;
export type TrackingZone = typeof trackingZonesTable.$inferSelect;
export type InsertTrackingZone = z.infer<typeof insertTrackingZoneSchema>;
