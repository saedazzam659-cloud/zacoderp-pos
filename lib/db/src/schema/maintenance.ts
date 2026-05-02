import {
  pgTable, serial, text, integer, numeric, timestamp, boolean, pgEnum, date,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";
import { itemsTable } from "./inventory";

// ─── Asset categories / statuses ─────────────────────────────────────────────
export const maintenanceAssetCategoryEnum = pgEnum("maintenance_asset_category", [
  "vehicle", "machine", "equipment", "tool", "building", "it_hardware", "other",
]);

export const maintenanceAssetStatusEnum = pgEnum("maintenance_asset_status", [
  "active", "in_repair", "out_of_service", "retired",
]);

// ─── Assets ─────────────────────────────────────────────────────────────────
export const maintenanceAssetsTable = pgTable("maintenance_assets", {
  id:             serial("id").primaryKey(),
  companyId:      integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:       integer("branch_id").references(() => branchesTable.id, { onDelete: "set null" }),
  code:           text("code").notNull(),
  nameAr:         text("name_ar").notNull(),
  nameEn:         text("name_en"),
  category:       maintenanceAssetCategoryEnum("category").notNull().default("equipment"),
  serialNumber:   text("serial_number"),
  location:       text("location"),
  manufacturer:   text("manufacturer"),
  model:          text("model"),
  purchaseDate:   date("purchase_date"),
  purchasePrice:  numeric("purchase_price", { precision: 15, scale: 2 }),
  warrantyExpiry: date("warranty_expiry"),
  status:         maintenanceAssetStatusEnum("status").notNull().default("active"),
  notes:          text("notes"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
});

export type MaintenanceAsset       = typeof maintenanceAssetsTable.$inferSelect;
export type InsertMaintenanceAsset = typeof maintenanceAssetsTable.$inferInsert;

// ─── Technicians ─────────────────────────────────────────────────────────────
export const maintenanceTechniciansTable = pgTable("maintenance_technicians", {
  id:             serial("id").primaryKey(),
  companyId:      integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:       integer("branch_id").references(() => branchesTable.id, { onDelete: "set null" }),
  code:           text("code").notNull(),
  nameAr:         text("name_ar").notNull(),
  nameEn:         text("name_en"),
  phone:          text("phone"),
  email:          text("email"),
  specialization: text("specialization"),
  hourlyRate:     numeric("hourly_rate", { precision: 10, scale: 2 }).notNull().default("0"),
  isActive:       boolean("is_active").notNull().default(true),
  notes:          text("notes"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
});

export type MaintenanceTechnician       = typeof maintenanceTechniciansTable.$inferSelect;
export type InsertMaintenanceTechnician = typeof maintenanceTechniciansTable.$inferInsert;

// ─── Work orders ────────────────────────────────────────────────────────────
export const maintenanceOrderTypeEnum = pgEnum("maintenance_order_type", [
  "preventive", "corrective", "emergency", "inspection",
]);

export const maintenanceOrderPriorityEnum = pgEnum("maintenance_order_priority", [
  "low", "medium", "high", "urgent",
]);

export const maintenanceOrderStatusEnum = pgEnum("maintenance_order_status", [
  "draft", "scheduled", "in_progress", "completed", "cancelled",
]);

export const maintenanceOrdersTable = pgTable("maintenance_orders", {
  id:                   serial("id").primaryKey(),
  companyId:            integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:             integer("branch_id").references(() => branchesTable.id, { onDelete: "set null" }),
  docNumber:            text("doc_number").notNull(),
  assetId:              integer("asset_id").notNull().references(() => maintenanceAssetsTable.id, { onDelete: "restrict" }),
  technicianId:         integer("technician_id").references(() => maintenanceTechniciansTable.id, { onDelete: "set null" }),
  orderType:            maintenanceOrderTypeEnum("order_type").notNull().default("corrective"),
  priority:             maintenanceOrderPriorityEnum("priority").notNull().default("medium"),
  status:               maintenanceOrderStatusEnum("status").notNull().default("draft"),
  reportedDate:         date("reported_date").notNull(),
  scheduledDate:        date("scheduled_date"),
  startDate:            date("start_date"),
  completionDate:       date("completion_date"),
  problemDescription:   text("problem_description").notNull(),
  diagnosis:            text("diagnosis"),
  workPerformed:        text("work_performed"),
  laborHours:           numeric("labor_hours", { precision: 10, scale: 2 }).notNull().default("0"),
  laborCost:            numeric("labor_cost",  { precision: 15, scale: 2 }).notNull().default("0"),
  partsCost:            numeric("parts_cost",  { precision: 15, scale: 2 }).notNull().default("0"),
  totalCost:            numeric("total_cost",  { precision: 15, scale: 2 }).notNull().default("0"),
  reportedBy:           text("reported_by"),
  notes:                text("notes"),
  createdAt:            timestamp("created_at").defaultNow().notNull(),
  updatedAt:            timestamp("updated_at").defaultNow().notNull(),
});

export type MaintenanceOrder       = typeof maintenanceOrdersTable.$inferSelect;
export type InsertMaintenanceOrder = typeof maintenanceOrdersTable.$inferInsert;

// ─── Spare parts consumed per order ─────────────────────────────────────────
export const maintenanceOrderPartsTable = pgTable("maintenance_order_parts", {
  id:        serial("id").primaryKey(),
  orderId:   integer("order_id").notNull().references(() => maintenanceOrdersTable.id, { onDelete: "cascade" }),
  itemId:    integer("item_id").notNull().references(() => itemsTable.id, { onDelete: "restrict" }),
  quantity:  numeric("quantity",  { precision: 15, scale: 4 }).notNull().default("1"),
  unitCost:  numeric("unit_cost", { precision: 15, scale: 2 }).notNull().default("0"),
  total:     numeric("total",     { precision: 15, scale: 2 }).notNull().default("0"),
  notes:     text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type MaintenanceOrderPart       = typeof maintenanceOrderPartsTable.$inferSelect;
export type InsertMaintenanceOrderPart = typeof maintenanceOrderPartsTable.$inferInsert;
