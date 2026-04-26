import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  timestamp,
  date,
  boolean,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";
import { itemsTable } from "./inventory";
import { usersTable } from "./users";

export const productionResourcesTable = pgTable(
  "production_resources",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    branchId: integer("branch_id").references(() => branchesTable.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    type: text("type").notNull().default("machine"),
    status: text("status").notNull().default("available"),
    capacityPerHour: numeric("capacity_per_hour", {
      precision: 14,
      scale: 4,
    }).default("0"),
    notes: text("notes"),
    meta: jsonb("meta").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byCompany: index("prod_res_company_idx").on(t.companyId),
  }),
);

export const productionOrdersTable = pgTable(
  "production_orders",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    branchId: integer("branch_id").references(() => branchesTable.id, {
      onDelete: "set null",
    }),
    orderNumber: text("order_number").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("draft"),
    plannedQty: numeric("planned_qty", { precision: 14, scale: 4 })
      .notNull()
      .default("0"),
    producedQty: numeric("produced_qty", { precision: 14, scale: 4 })
      .notNull()
      .default("0"),
    wasteQty: numeric("waste_qty", { precision: 14, scale: 4 })
      .notNull()
      .default("0"),
    plannedStartDate: date("planned_start_date"),
    plannedEndDate: date("planned_end_date"),
    actualStartAt: timestamp("actual_start_at"),
    actualEndAt: timestamp("actual_end_at"),
    resourceId: integer("resource_id").references(
      () => productionResourcesTable.id,
      { onDelete: "set null" },
    ),
    productItemId: integer("product_item_id").references(() => itemsTable.id, {
      onDelete: "set null",
    }),
    unitCode: text("unit_code").notNull().default("PCE"),
    estimatedCost: numeric("estimated_cost", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    actualCost: numeric("actual_cost", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    notes: text("notes"),
    meta: jsonb("meta").$type<Record<string, unknown>>().default({}),
    createdBy: integer("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byCompanyNumber: uniqueIndex("prod_orders_company_number_idx").on(
      t.companyId,
      t.orderNumber,
    ),
    byCompanyStatus: index("prod_orders_company_status_idx").on(
      t.companyId,
      t.status,
    ),
  }),
);

export const productionOrderItemsTable = pgTable(
  "production_order_items",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => productionOrdersTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("raw"),
    itemId: integer("item_id").references(() => itemsTable.id, {
      onDelete: "set null",
    }),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 4 })
      .notNull()
      .default("0"),
    unitCode: text("unit_code").notNull().default("PCE"),
    unitCost: numeric("unit_cost", { precision: 14, scale: 4 })
      .notNull()
      .default("0"),
    totalCost: numeric("total_cost", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    meta: jsonb("meta").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    byOrder: index("prod_order_items_order_idx").on(t.orderId),
  }),
);

export const productionEventsTable = pgTable(
  "production_events",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    orderId: integer("order_id").references(() => productionOrdersTable.id, {
      onDelete: "cascade",
    }),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}),
    userId: integer("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    byAi: boolean("by_ai").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    byOrder: index("prod_events_order_idx").on(t.orderId),
    byCompany: index("prod_events_company_idx").on(t.companyId),
  }),
);

// ─────────────────────────────────────────────────────────────────────────
// Zod insert/select schemas
// ─────────────────────────────────────────────────────────────────────────
export const insertProductionResourceSchema = createInsertSchema(
  productionResourcesTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertProductionOrderSchema = createInsertSchema(
  productionOrdersTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertProductionOrderItemSchema = createInsertSchema(
  productionOrderItemsTable,
).omit({ id: true, createdAt: true });
export const insertProductionEventSchema = createInsertSchema(
  productionEventsTable,
).omit({ id: true, createdAt: true });

export type ProductionResource = typeof productionResourcesTable.$inferSelect;
export type ProductionOrder = typeof productionOrdersTable.$inferSelect;
export type ProductionOrderItem =
  typeof productionOrderItemsTable.$inferSelect;
export type ProductionEvent = typeof productionEventsTable.$inferSelect;
export type InsertProductionResource = z.infer<
  typeof insertProductionResourceSchema
>;
export type InsertProductionOrder = z.infer<typeof insertProductionOrderSchema>;
export type InsertProductionOrderItem = z.infer<
  typeof insertProductionOrderItemSchema
>;
export type InsertProductionEvent = z.infer<typeof insertProductionEventSchema>;

// Allowed status transitions for production orders. Used by both backend
// validation and frontend status-button rendering. Keep this in sync with
// the workflow described in the manufacturing module spec.
export const PRODUCTION_ORDER_STATUSES = [
  "draft",
  "approved",
  "in_production",
  "quality_check",
  "completed",
  "cancelled",
] as const;
export type ProductionOrderStatus =
  (typeof PRODUCTION_ORDER_STATUSES)[number];

export const PRODUCTION_STATUS_TRANSITIONS: Record<
  ProductionOrderStatus,
  ProductionOrderStatus[]
> = {
  draft: ["approved", "cancelled"],
  approved: ["in_production", "cancelled"],
  in_production: ["quality_check", "cancelled"],
  quality_check: ["completed", "in_production", "cancelled"],
  completed: [],
  cancelled: [],
};
