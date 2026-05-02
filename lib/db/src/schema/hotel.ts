import {
  pgTable, serial, text, integer, numeric, timestamp, boolean, pgEnum, date,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";
import { customersTable } from "./customers";

export const hotelStatusEnum = pgEnum("hotel_status", [
  "active", "inactive", "under_renovation",
]);

export const hotelsTable = pgTable("hotels", {
  id:            serial("id").primaryKey(),
  companyId:     integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:      integer("branch_id").references(() => branchesTable.id, { onDelete: "set null" }),
  code:          text("code").notNull(),
  nameAr:        text("name_ar").notNull(),
  nameEn:        text("name_en"),
  location:      text("location"),
  rating:        integer("rating").notNull().default(3),
  status:        hotelStatusEnum("status").notNull().default("active"),
  contactPhone:  text("contact_phone"),
  contactEmail:  text("contact_email"),
  notes:         text("notes"),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
  updatedAt:     timestamp("updated_at").defaultNow().notNull(),
});
export type Hotel       = typeof hotelsTable.$inferSelect;
export type InsertHotel = typeof hotelsTable.$inferInsert;

export const hotelRoomTypeEnum = pgEnum("hotel_room_type", [
  "single", "double", "twin", "triple", "suite", "deluxe", "family",
]);
export const hotelRoomStatusEnum = pgEnum("hotel_room_status", [
  "available", "occupied", "reserved", "cleaning", "maintenance", "out_of_service",
]);

export const hotelRoomsTable = pgTable("hotel_rooms", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  hotelId:      integer("hotel_id").notNull().references(() => hotelsTable.id, { onDelete: "cascade" }),
  roomNumber:   text("room_number").notNull(),
  roomType:     hotelRoomTypeEnum("room_type").notNull().default("double"),
  basePrice:    numeric("base_price", { precision: 15, scale: 2 }).notNull().default("0"),
  status:       hotelRoomStatusEnum("status").notNull().default("available"),
  capacity:     integer("capacity").notNull().default(2),
  floor:        text("floor"),
  features:     text("features"),
  notes:        text("notes"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().notNull(),
});
export type HotelRoom       = typeof hotelRoomsTable.$inferSelect;
export type InsertHotelRoom = typeof hotelRoomsTable.$inferInsert;

export const hotelGuestsTable = pgTable("hotel_guests", {
  id:            serial("id").primaryKey(),
  companyId:     integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  code:          text("code").notNull(),
  fullNameAr:    text("full_name_ar").notNull(),
  fullNameEn:    text("full_name_en"),
  phone:         text("phone"),
  email:         text("email"),
  nationality:   text("nationality"),
  idType:        text("id_type"),
  idNumber:      text("id_number"),
  preferences:   text("preferences"),
  customerId:    integer("customer_id").references(() => customersTable.id, { onDelete: "set null" }),
  notes:         text("notes"),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
  updatedAt:     timestamp("updated_at").defaultNow().notNull(),
});
export type HotelGuest       = typeof hotelGuestsTable.$inferSelect;
export type InsertHotelGuest = typeof hotelGuestsTable.$inferInsert;

export const hotelBookingStatusEnum = pgEnum("hotel_booking_status", [
  "pending", "confirmed", "checked_in", "checked_out", "cancelled", "no_show",
]);

export const hotelBookingsTable = pgTable("hotel_bookings", {
  id:                serial("id").primaryKey(),
  companyId:         integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  hotelId:           integer("hotel_id").notNull().references(() => hotelsTable.id, { onDelete: "restrict" }),
  docNumber:         text("doc_number").notNull(),
  guestId:           integer("guest_id").notNull().references(() => hotelGuestsTable.id, { onDelete: "restrict" }),
  roomId:            integer("room_id").notNull().references(() => hotelRoomsTable.id, { onDelete: "restrict" }),
  checkIn:           date("check_in").notNull(),
  checkOut:          date("check_out").notNull(),
  status:            hotelBookingStatusEnum("status").notNull().default("pending"),
  nightlyRate:       numeric("nightly_rate",      { precision: 15, scale: 2 }).notNull().default("0"),
  nightsCount:       integer("nights_count").notNull().default(1),
  totalPrice:        numeric("total_price",       { precision: 15, scale: 2 }).notNull().default("0"),
  aiSuggestedPrice:  numeric("ai_suggested_price",{ precision: 15, scale: 2 }),
  aiFactors:         text("ai_factors"),
  paidAmount:        numeric("paid_amount",       { precision: 15, scale: 2 }).notNull().default("0"),
  guestsCount:       integer("guests_count").notNull().default(1),
  specialRequests:   text("special_requests"),
  checkInAt:         timestamp("check_in_at"),
  checkOutAt:        timestamp("check_out_at"),
  notes:             text("notes"),
  createdAt:         timestamp("created_at").defaultNow().notNull(),
  updatedAt:         timestamp("updated_at").defaultNow().notNull(),
});
export type HotelBooking       = typeof hotelBookingsTable.$inferSelect;
export type InsertHotelBooking = typeof hotelBookingsTable.$inferInsert;

export const hotelPaymentMethodEnum = pgEnum("hotel_payment_method", [
  "cash", "card", "bank_transfer", "online", "other",
]);
export const hotelPaymentStatusEnum = pgEnum("hotel_payment_status", [
  "pending", "completed", "failed", "refunded",
]);

export const hotelPaymentsTable = pgTable("hotel_payments", {
  id:          serial("id").primaryKey(),
  companyId:   integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  bookingId:   integer("booking_id").notNull().references(() => hotelBookingsTable.id, { onDelete: "cascade" }),
  docNumber:   text("doc_number").notNull(),
  amount:      numeric("amount", { precision: 15, scale: 2 }).notNull().default("0"),
  method:      hotelPaymentMethodEnum("method").notNull().default("cash"),
  status:      hotelPaymentStatusEnum("status").notNull().default("completed"),
  paidAt:      timestamp("paid_at").defaultNow().notNull(),
  reference:   text("reference"),
  notes:       text("notes"),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
});
export type HotelPayment       = typeof hotelPaymentsTable.$inferSelect;
export type InsertHotelPayment = typeof hotelPaymentsTable.$inferInsert;

export const hotelHousekeepingStatusEnum = pgEnum("hotel_housekeeping_status", [
  "pending", "in_progress", "done", "skipped",
]);
export const hotelHousekeepingPriorityEnum = pgEnum("hotel_housekeeping_priority", [
  "low", "medium", "high", "urgent",
]);
export const hotelHousekeepingTaskTypeEnum = pgEnum("hotel_housekeeping_task_type", [
  "cleaning", "linen_change", "deep_clean", "inspection", "restock", "other",
]);

export const hotelHousekeepingTable = pgTable("hotel_housekeeping", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  hotelId:      integer("hotel_id").notNull().references(() => hotelsTable.id, { onDelete: "cascade" }),
  roomId:       integer("room_id").references(() => hotelRoomsTable.id, { onDelete: "set null" }),
  docNumber:    text("doc_number").notNull(),
  taskType:     hotelHousekeepingTaskTypeEnum("task_type").notNull().default("cleaning"),
  status:       hotelHousekeepingStatusEnum("status").notNull().default("pending"),
  priority:     hotelHousekeepingPriorityEnum("priority").notNull().default("medium"),
  assignedTo:   text("assigned_to"),
  scheduledAt:  timestamp("scheduled_at"),
  completedAt:  timestamp("completed_at"),
  notes:        text("notes"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().notNull(),
});
export type HotelHousekeeping       = typeof hotelHousekeepingTable.$inferSelect;
export type InsertHotelHousekeeping = typeof hotelHousekeepingTable.$inferInsert;
