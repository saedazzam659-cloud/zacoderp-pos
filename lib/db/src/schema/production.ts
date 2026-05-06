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
import { itemsTable, warehousesTable } from "./inventory";
import { accountsTable } from "./accounts";
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
    // ─── SAP-style WIP cycle: header-level warehouses + cost allocation ────
    // When the order moves to "in_production" the BOM raw lines are
    // decremented from rawWarehouseId; on "completed" the produced qty is
    // added to finishedWarehouseId. Header-level fields (header warehouses,
    // labor/overhead totals, account ids, costCenter) propagate to the
    // generated journal entries — mirrors how invoices/receipts post.
    rawWarehouseId: integer("raw_warehouse_id").references(
      () => warehousesTable.id,
      { onDelete: "set null" },
    ),
    finishedWarehouseId: integer("finished_warehouse_id").references(
      () => warehousesTable.id,
      { onDelete: "set null" },
    ),
    laborCost: numeric("labor_cost", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    overheadCost: numeric("overhead_cost", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    rawMaterialsCost: numeric("raw_materials_cost", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    costCenter: text("cost_center"),
    wipAccountId: integer("wip_account_id").references(() => accountsTable.id, {
      onDelete: "set null",
    }),
    rawInventoryAccountId: integer("raw_inventory_account_id").references(
      () => accountsTable.id,
      { onDelete: "set null" },
    ),
    finishedGoodsAccountId: integer("finished_goods_account_id").references(
      () => accountsTable.id,
      { onDelete: "set null" },
    ),
    laborAccountId: integer("labor_account_id").references(
      () => accountsTable.id,
      { onDelete: "set null" },
    ),
    overheadAccountId: integer("overhead_account_id").references(
      () => accountsTable.id,
      { onDelete: "set null" },
    ),
    varianceAccountId: integer("variance_account_id").references(
      () => accountsTable.id,
      { onDelete: "set null" },
    ),
    wasteAccountId: integer("waste_account_id").references(
      () => accountsTable.id,
      { onDelete: "set null" },
    ),
    issueJournalEntryId: integer("issue_journal_entry_id"),
    receiptJournalEntryId: integer("receipt_journal_entry_id"),
    // ─── PHASE B — Work Center link ────────────────────────────────────────
    // عند ضبط workCenterId + plannedHours، يُحسَب laborCost و overheadCost
    // تلقائياً من معدلات المركز. actualHours تُسجَّل عند الإكمال للمراجعة.
    workCenterId: integer("work_center_id"),
    plannedHours: numeric("planned_hours", { precision: 14, scale: 4 })
      .notNull()
      .default("0"),
    actualHours: numeric("actual_hours", { precision: 14, scale: 4 })
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

// ─── PHASE A — BOM Templates ──────────────────────────────────────────────
// قائمة المكوّنات القياسية لكل منتج نهائي. عند إنشاء أمر إنتاج لمنتج
// له قالب نشط، تُنسخ سطور المكوّنات تلقائياً إلى أمر الإنتاج بدل أن
// يضطر المستخدم لإدخالها يدوياً في كل مرة.
export const bomTemplatesTable = pgTable(
  "bom_templates",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    productItemId: integer("product_item_id")
      .notNull()
      .references(() => itemsTable.id, { onDelete: "cascade" }),
    nameAr: text("name_ar").notNull(),
    nameEn: text("name_en"),
    // Output produced per template execution (defaults to 1 unit). All
    // raw line quantities are scaled by `desiredQty / outputQty` when
    // applied to a production order.
    outputQty: numeric("output_qty", { precision: 14, scale: 4 })
      .notNull()
      .default("1"),
    outputUnitCode: text("output_unit_code").notNull().default("PCE"),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byCompanyProduct: index("bom_tmpl_company_product_idx").on(
      t.companyId,
      t.productItemId,
    ),
  }),
);

export const bomTemplateLinesTable = pgTable(
  "bom_template_lines",
  {
    id: serial("id").primaryKey(),
    templateId: integer("template_id")
      .notNull()
      .references(() => bomTemplatesTable.id, { onDelete: "cascade" }),
    itemId: integer("item_id").references(() => itemsTable.id, {
      onDelete: "set null",
    }),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 4 })
      .notNull()
      .default("0"),
    unitCode: text("unit_code").notNull().default("PCE"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    byTemplate: index("bom_tmpl_lines_tmpl_idx").on(t.templateId),
  }),
);

// ─── PHASE A — Manufacturing Settings (per-company defaults) ──────────────
// إعدادات التصنيع للشركة: المخازن والحسابات الافتراضية التي تُستخدم
// تلقائياً عند إنشاء أمر إنتاج. تُختصر بذلك خطوة "إعداد WIP" في كل أمر،
// لأن المعظم سيستخدم نفس الحسابات والمخازن دائماً.
export const manufacturingSettingsTable = pgTable(
  "manufacturing_settings",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    defaultRawWarehouseId: integer("default_raw_warehouse_id").references(
      () => warehousesTable.id,
      { onDelete: "set null" },
    ),
    defaultFinishedWarehouseId: integer(
      "default_finished_warehouse_id",
    ).references(() => warehousesTable.id, { onDelete: "set null" }),
    defaultCostCenter: text("default_cost_center"),
    // 7 default GL accounts mirroring the production order columns.
    defaultWipAccountId: integer("default_wip_account_id").references(
      () => accountsTable.id,
      { onDelete: "set null" },
    ),
    defaultRawInventoryAccountId: integer(
      "default_raw_inventory_account_id",
    ).references(() => accountsTable.id, { onDelete: "set null" }),
    defaultFinishedGoodsAccountId: integer(
      "default_finished_goods_account_id",
    ).references(() => accountsTable.id, { onDelete: "set null" }),
    defaultLaborAccountId: integer("default_labor_account_id").references(
      () => accountsTable.id,
      { onDelete: "set null" },
    ),
    defaultOverheadAccountId: integer(
      "default_overhead_account_id",
    ).references(() => accountsTable.id, { onDelete: "set null" }),
    defaultVarianceAccountId: integer(
      "default_variance_account_id",
    ).references(() => accountsTable.id, { onDelete: "set null" }),
    defaultWasteAccountId: integer("default_waste_account_id").references(
      () => accountsTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byCompany: uniqueIndex("mfg_settings_company_uniq").on(t.companyId),
  }),
);

// ─── PHASE B — Work Centers (مراكز العمل) ────────────────────────────────
// مركز العمل = وحدة عمل/خط إنتاج له معدل أجور ساعي ومعدل تكاليف غير
// مباشرة ساعي وحسابات GL افتراضية. عند ربط أمر إنتاج بمركز عمل + ساعات
// مخططة، يُحسَب laborCost و overheadCost تلقائياً = ساعات × المعدل.
// كذلك يُملأ تلقائياً حسابات الأجور/التكاليف ومركز التكلفة من المركز إذا
// كانت فارغة على الأمر.
export const workCentersTable = pgTable(
  "work_centers",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    nameAr: text("name_ar").notNull(),
    nameEn: text("name_en"),
    costCenterCode: text("cost_center_code"),
    laborRatePerHour: numeric("labor_rate_per_hour", {
      precision: 14,
      scale: 4,
    })
      .notNull()
      .default("0"),
    overheadRatePerHour: numeric("overhead_rate_per_hour", {
      precision: 14,
      scale: 4,
    })
      .notNull()
      .default("0"),
    capacityHoursPerDay: numeric("capacity_hours_per_day", {
      precision: 14,
      scale: 4,
    })
      .notNull()
      .default("8"),
    defaultLaborAccountId: integer("default_labor_account_id").references(
      () => accountsTable.id,
      { onDelete: "set null" },
    ),
    defaultOverheadAccountId: integer(
      "default_overhead_account_id",
    ).references(() => accountsTable.id, { onDelete: "set null" }),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byCompanyCode: uniqueIndex("work_centers_company_code_uniq").on(
      t.companyId,
      t.code,
    ),
    byCompany: index("work_centers_company_idx").on(t.companyId),
  }),
);

export const insertWorkCenterSchema = createInsertSchema(workCentersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type WorkCenter = typeof workCentersTable.$inferSelect;
export type InsertWorkCenter = z.infer<typeof insertWorkCenterSchema>;

export type BomTemplate = typeof bomTemplatesTable.$inferSelect;
export type BomTemplateLine = typeof bomTemplateLinesTable.$inferSelect;
export type ManufacturingSettings =
  typeof manufacturingSettingsTable.$inferSelect;

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
