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
import { sql } from "drizzle-orm";
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
    // ─── PHASE D — Batch tracking (تتبّع التشغيلات) ────────────────────────
    // Generated automatically when the order moves to `in_production`. Format:
    // PRD-YYYYMMDD-{orderId} (unique per company). Propagated to the
    // `production_receipt` stock-ledger row at completion so the produced
    // batch appears in the item's batches panel and is traceable downstream
    // (sales, returns, recall, expiry).
    batchNumber: text("batch_number"),
    // Opaque token used as the QR-code payload. Includes batchNumber + a
    // random suffix so two batches with the same number (e.g. across tenants
    // in printouts) still scan to distinct codes. Generated alongside
    // batchNumber on issue.
    qrToken: text("qr_token"),
    // Optional shelf-life on the produced FG batch. When set, also flows into
    // the stock_ledger.expiry_date column so the FEFO reports work.
    fgExpiryDate: date("fg_expiry_date"),
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
    // PHASE D — partial unique index: prevents duplicate batchNumbers per
    // company. NULL values are excluded (drafts/pre-issue orders allowed to
    // share the empty slot). Also guards the manual-override PATCH path.
    byCompanyBatch: uniqueIndex("prod_orders_company_batch_uniq")
      .on(t.companyId, t.batchNumber)
      .where(sql`${t.batchNumber} IS NOT NULL`),
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

// ─── PHASE C — Production Routings (مراحل الإنتاج / Routing) ──────────────
// قالب مراحل قياسي لكل منتج: عجن → تجميد → فك تجميد → ماكينة → تصبيع →
// فرن → فرز/تعبئة، أو أي تسلسل آخر يناسب المنتج. عند إنشاء أمر إنتاج
// لمنتج له Routing نشط، تُنسخ مراحله تلقائياً إلى أمر الإنتاج (مثل BOM).
//
// التتبّع التشغيلي على مستوى المرحلة: كمية داخلة/خارجة/هالك + مشغل
// + ختم وقت بداية/نهاية. القيود المحاسبية تبقى على مستوى الأمر (إصدار
// خامات في البداية + قيد إنتاج تام عند الانتهاء)، تماماً كما في
// SAP S/4HANA و Odoo Manufacturing — Routing تشغيلي، WIP محاسبي.
export const productionRoutingsTable = pgTable(
  "production_routings",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    productItemId: integer("product_item_id").references(() => itemsTable.id, {
      onDelete: "set null",
    }),
    nameAr: text("name_ar").notNull(),
    nameEn: text("name_en"),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byCompanyProduct: index("prod_routings_company_product_idx").on(
      t.companyId,
      t.productItemId,
    ),
  }),
);

export const productionRoutingStagesTable = pgTable(
  "production_routing_stages",
  {
    id: serial("id").primaryKey(),
    routingId: integer("routing_id")
      .notNull()
      .references(() => productionRoutingsTable.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    code: text("code").notNull(),
    nameAr: text("name_ar").notNull(),
    nameEn: text("name_en"),
    workCenterId: integer("work_center_id").references(
      () => workCentersTable.id,
      { onDelete: "set null" },
    ),
    expectedWasteRatio: numeric("expected_waste_ratio", {
      precision: 6,
      scale: 4,
    })
      .notNull()
      .default("0"),
    expectedDurationMinutes: integer("expected_duration_minutes"),
    // Expected operating cost per stage (labor + overhead, in base currency).
    // Used for routing-level cost estimation and seeded into the order
    // stage so finished-goods cost can include routing cost without
    // requiring per-stage time tracking.
    expectedCost: numeric("expected_cost", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    expectedCostAccountId: integer("expected_cost_account_id").references(
      () => accountsTable.id,
      { onDelete: "set null" },
    ),
    icon: text("icon"),
    color: text("color"),
    notes: text("notes"),
  },
  (t) => ({
    byRouting: index("prod_routing_stages_routing_idx").on(t.routingId),
  }),
);

export const productionOrderStagesTable = pgTable(
  "production_order_stages",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => productionOrdersTable.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    code: text("code").notNull(),
    nameAr: text("name_ar").notNull(),
    nameEn: text("name_en"),
    workCenterId: integer("work_center_id").references(
      () => workCentersTable.id,
      { onDelete: "set null" },
    ),
    expectedWasteRatio: numeric("expected_waste_ratio", {
      precision: 6,
      scale: 4,
    })
      .notNull()
      .default("0"),
    expectedDurationMinutes: integer("expected_duration_minutes"),
    expectedCost: numeric("expected_cost", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    expectedCostAccountId: integer("expected_cost_account_id").references(
      () => accountsTable.id,
      { onDelete: "set null" },
    ),
    icon: text("icon"),
    color: text("color"),
    // pending → in_progress → done (or skipped). Stages can be re-opened
    // by setting status back to in_progress.
    status: text("status").notNull().default("pending"),
    inputQty: numeric("input_qty", { precision: 14, scale: 4 })
      .notNull()
      .default("0"),
    outputQty: numeric("output_qty", { precision: 14, scale: 4 })
      .notNull()
      .default("0"),
    wasteQty: numeric("waste_qty", { precision: 14, scale: 4 })
      .notNull()
      .default("0"),
    operatorUserId: integer("operator_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    notes: text("notes"),
    fromRoutingId: integer("from_routing_id").references(
      () => productionRoutingsTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    byOrder: index("prod_order_stages_order_idx").on(t.orderId),
    byOrderSeq: uniqueIndex("prod_order_stages_order_seq_uniq").on(
      t.orderId,
      t.sequence,
    ),
  }),
);

export type ProductionRouting = typeof productionRoutingsTable.$inferSelect;
export type ProductionRoutingStage =
  typeof productionRoutingStagesTable.$inferSelect;
export type ProductionOrderStage =
  typeof productionOrderStagesTable.$inferSelect;

export const PRODUCTION_STAGE_STATUSES = [
  "pending",
  "in_progress",
  "done",
  "skipped",
] as const;
export type ProductionStageStatus = (typeof PRODUCTION_STAGE_STATUSES)[number];

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

// ─── PHASE B — Quality Control ───────────────────────────────────────────
// Universal QC log: one row per check performed on a production order (or
// a specific stage within it). Industry-neutral by design — `checkType`
// is a free-form string so any factory can add their own check kinds
// (visual, weight, temperature, dimension, AI camera, barcode, etc.) via
// data, NOT new tables. The `measuredValue` / `expectedValue` pair is
// stored as text so it can hold "250 g", "ok", "16.5 mm", etc., without
// forcing a numeric type that wouldn't fit qualitative checks.
//
// Pairs with `production_order_stages.status` — when a check has
// `result='fail'`, the FE can prompt to re-open the stage. No automatic
// status flip server-side (intentional — QC failures often need manual
// adjudication before the stage is moved back).
export const QC_CHECK_TYPES = [
  "visual",
  "weight",
  "temperature",
  "dimension",
  "barcode",
  "ai_camera",
  "other",
] as const;
export type QcCheckType = (typeof QC_CHECK_TYPES)[number];

export const QC_RESULTS = ["pass", "fail", "conditional"] as const;
export type QcResult = (typeof QC_RESULTS)[number];

export const productionQualityChecksTable = pgTable(
  "production_quality_checks",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    orderId: integer("order_id")
      .notNull()
      .references(() => productionOrdersTable.id, { onDelete: "cascade" }),
    // Optional — when the check is tied to a specific stage of the order.
    stageId: integer("stage_id").references(
      () => productionOrderStagesTable.id,
      { onDelete: "set null" },
    ),
    checkType: text("check_type").notNull(), // QcCheckType (string for extensibility)
    result: text("result").notNull(),         // QcResult
    measuredValue: text("measured_value"),
    expectedValue: text("expected_value"),
    sampleSize: integer("sample_size"),
    defectsFound: integer("defects_found").notNull().default(0),
    mediaUrl: text("media_url"),              // optional photo / AI evidence
    notes: text("notes"),
    checkedByUserId: integer("checked_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    checkedAt: timestamp("checked_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    byOrder: index("prod_qc_order_idx").on(t.orderId),
    byCompany: index("prod_qc_company_idx").on(t.companyId),
    byStage: index("prod_qc_stage_idx").on(t.stageId),
  }),
);

export const insertProductionQualityCheckSchema = createInsertSchema(
  productionQualityChecksTable,
).omit({ id: true, createdAt: true });

export type ProductionQualityCheck =
  typeof productionQualityChecksTable.$inferSelect;
export type InsertProductionQualityCheck = z.infer<
  typeof insertProductionQualityCheckSchema
>;

// ─── PHASE H (Round 14) — QC Templates ────────────────────────────────────
// Reusable QC checklists. A template is OPTIONALLY tied to a productItemId
// (so per-product checklists can be auto-suggested when filling a QC for
// an order producing that item) — when productItemId is NULL the template
// is a generic checklist available for any order.
//
// Each template holds one or more items, each describing a single check
// (label, type, expected value, sample size). The UI uses a template to
// pre-fill the QC form fields; nothing is auto-inserted into the QC log
// without an operator clicking save.
export const productionQualityCheckTemplatesTable = pgTable(
  "production_quality_check_templates",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Nullable — when set, this template is the default suggestion when
    // a QC is filed against an order producing this item.
    productItemId: integer("product_item_id").references(() => itemsTable.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    createdByUserId: integer("created_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byCompany: index("prod_qc_tpl_company_idx").on(t.companyId),
    byProduct: index("prod_qc_tpl_product_idx").on(t.productItemId),
  }),
);

export const productionQualityCheckTemplateItemsTable = pgTable(
  "production_quality_check_template_items",
  {
    id: serial("id").primaryKey(),
    templateId: integer("template_id")
      .notNull()
      .references(() => productionQualityCheckTemplatesTable.id, {
        onDelete: "cascade",
      }),
    label: text("label").notNull(), // human-readable e.g. "Weight check"
    checkType: text("check_type").notNull(), // QcCheckType
    expectedValue: text("expected_value"),
    sampleSize: integer("sample_size"),
    sortOrder: integer("sort_order").notNull().default(0),
    isRequired: boolean("is_required").notNull().default(true),
  },
  (t) => ({
    byTemplate: index("prod_qc_tpl_item_template_idx").on(t.templateId),
  }),
);

export const insertProductionQualityCheckTemplateSchema = createInsertSchema(
  productionQualityCheckTemplatesTable,
).omit({ id: true, createdAt: true, updatedAt: true });

export const insertProductionQualityCheckTemplateItemSchema = createInsertSchema(
  productionQualityCheckTemplateItemsTable,
).omit({ id: true });

export type ProductionQualityCheckTemplate =
  typeof productionQualityCheckTemplatesTable.$inferSelect;
export type ProductionQualityCheckTemplateItem =
  typeof productionQualityCheckTemplateItemsTable.$inferSelect;

// ─── PHASE D — Waste / Scrap Records (سجلّات التالف والهالك) ───────────────
// Detailed scrap log per production order. Unlike `productionOrders.wasteQty`
// (a single rolled-up number used for accounting), this table captures the
// *why* of each scrap event: type, root cause, stage, machine, operator,
// quantity & cost impact. Aggregating by waste_type / reason / machine_id
// powers the scrap-analytics dashboard (top loss reasons, machine-level
// scrap rates, operator coaching).
//
// Cost is informational — the financial impact of waste is already booked
// at completion via the existing `wasteAccountId` JE line, so these records
// don't post their own journal entries. Adding/removing a record after
// completion is allowed (forensic edits); it does NOT re-post any JE.
export const PRODUCTION_WASTE_TYPES = [
  "burn",            // احتراق
  "break",           // كسر
  "deform",          // تشوّه
  "packaging_error", // خطأ تعبئة
  "quality",         // نقص جودة
  "overweight",      // زيادة وزن
  "underweight",     // نقص وزن
  "contamination",   // تلوّث
  "other",           // أخرى
] as const;
export type ProductionWasteType = (typeof PRODUCTION_WASTE_TYPES)[number];

export const productionWasteRecordsTable = pgTable(
  "production_waste_records",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    orderId: integer("order_id")
      .notNull()
      .references(() => productionOrdersTable.id, { onDelete: "cascade" }),
    // Optional link to a specific routing stage so analytics can attribute
    // waste to a phase (mixing vs packaging vs oven). Set NULL for waste
    // detected outside any stage.
    stageId: integer("stage_id").references(
      () => productionOrderStagesTable.id,
      { onDelete: "set null" },
    ),
    wasteType: text("waste_type").notNull(), // ProductionWasteType
    reason: text("reason"),                  // free-form root cause
    qty: numeric("qty", { precision: 14, scale: 4 }).notNull().default("0"),
    unitCode: text("unit_code").notNull().default("PCE"),
    costImpact: numeric("cost_impact", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    // Either the machine (productionResource) or work-center the scrap came
    // from. Both nullable — small shops won't always tag this.
    resourceId: integer("resource_id").references(
      () => productionResourcesTable.id,
      { onDelete: "set null" },
    ),
    workCenterId: integer("work_center_id").references(
      () => workCentersTable.id,
      { onDelete: "set null" },
    ),
    operatorUserId: integer("operator_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    notes: text("notes"),
    createdBy: integer("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    byOrder: index("prod_waste_order_idx").on(t.orderId),
    byCompany: index("prod_waste_company_idx").on(t.companyId),
    byType: index("prod_waste_type_idx").on(t.companyId, t.wasteType),
  }),
);

export const insertProductionWasteRecordSchema = createInsertSchema(
  productionWasteRecordsTable,
).omit({ id: true, createdAt: true });

export type ProductionWasteRecord =
  typeof productionWasteRecordsTable.$inferSelect;
export type InsertProductionWasteRecord = z.infer<
  typeof insertProductionWasteRecordSchema
>;

// ─── ROUND I — Shift Calendar (تقويم الورديات) ─────────────────────────────
// Defines named shifts (morning/evening/night/custom) per company with
// start/end times and active weekdays. Shifts are catalog data (NOT
// branch-scoped) used to plan capacity and bound production-order
// scheduling. Holidays/exception dates override the weekly pattern.
//
// `daysOfWeek` is a Postgres int[] of weekday ordinals 0..6 where 0=Sunday
// (matches `Date.prototype.getDay()`). Stored as int array to keep
// "which days does this shift run?" trivially queryable without a join
// table — typical row has 5-7 entries.
//
// `startTime`/`endTime` are stored as text "HH:MM" (24h). When endTime
// is lexicographically <= startTime, the shift spans midnight (e.g.
// 22:00 → 06:00) — consumers must handle that.
//
// No JE / no posting — purely planning + analytics master data.
export const productionShiftsTable = pgTable(
  "production_shifts",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // "وردية الصباح"
    code: text("code").notNull(), // "M" / "MORNING" — unique per company
    startTime: text("start_time").notNull(), // "06:00"
    endTime: text("end_time").notNull(),     // "14:00"
    daysOfWeek: jsonb("days_of_week")
      .$type<number[]>()
      .notNull()
      .default(sql`'[0,1,2,3,4]'::jsonb`),
    breakMinutes: integer("break_minutes").notNull().default(0),
    color: text("color").notNull().default("#3b82f6"),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byCompany: index("prod_shift_company_idx").on(t.companyId),
    uniqCode: uniqueIndex("prod_shift_company_code_uniq").on(
      t.companyId,
      t.code,
    ),
  }),
);

// Exception dates: full-day closures (national holidays, plant
// shutdowns) OR partial overrides (single-shift adjustments). When
// `shiftId` is NULL the holiday applies to ALL shifts that day; when
// set, only that one shift is overridden.
export const productionShiftHolidaysTable = pgTable(
  "production_shift_holidays",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    shiftId: integer("shift_id").references(() => productionShiftsTable.id, {
      onDelete: "cascade",
    }),
    date: date("date").notNull(),
    name: text("name").notNull(), // "اليوم الوطني"
    isFullDay: boolean("is_full_day").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    byCompany: index("prod_shift_holiday_company_idx").on(t.companyId),
    byDate: index("prod_shift_holiday_date_idx").on(t.companyId, t.date),
  }),
);

export const insertProductionShiftSchema = createInsertSchema(
  productionShiftsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertProductionShiftHolidaySchema = createInsertSchema(
  productionShiftHolidaysTable,
).omit({ id: true, createdAt: true });

export type ProductionShift = typeof productionShiftsTable.$inferSelect;
export type ProductionShiftHoliday =
  typeof productionShiftHolidaysTable.$inferSelect;

// ─── ROUND F — Forecasts / MRP (تخطيط احتياجات المواد) ────────────────────
// A *forecast* groups one or more demand lines for a future period. Each
// line names a FINISHED GOOD item and an expected sales quantity. The MRP
// engine (live calculation — not persisted) then:
//   1) Expands every FG line through its active BOM template into raw
//      material requirements (scale = forecastQty / template.outputQty).
//   2) For every affected item (FG + raw), subtracts on-hand stock
//      (sum of stock_balance.qty across all warehouses for the company).
//   3) For FG items, additionally subtracts already-open production
//      orders (status NOT IN completed/cancelled).
//   4) Returns a "net requirement" per item with a suggested action
//      (produce vs purchase).
//
// Forecasts are catalog-style master data: per-company, NOT branch-scoped.
// Status drives lifecycle only — `draft` is editable, `active` is the
// one(s) MRP runs against by default, `archived` keeps history.
export const PRODUCTION_FORECAST_STATUSES = [
  "draft",
  "active",
  "archived",
] as const;
export type ProductionForecastStatus =
  (typeof PRODUCTION_FORECAST_STATUSES)[number];

export const productionForecastsTable = pgTable(
  "production_forecasts",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    status: text("status").notNull().default("draft"),
    notes: text("notes"),
    createdByUserId: integer("created_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byCompany: index("prod_forecast_company_idx").on(t.companyId),
    byPeriod: index("prod_forecast_period_idx").on(
      t.companyId,
      t.periodStart,
      t.periodEnd,
    ),
  }),
);

export const productionForecastLinesTable = pgTable(
  "production_forecast_lines",
  {
    id: serial("id").primaryKey(),
    forecastId: integer("forecast_id")
      .notNull()
      .references(() => productionForecastsTable.id, { onDelete: "cascade" }),
    productItemId: integer("product_item_id")
      .notNull()
      .references(() => itemsTable.id, { onDelete: "cascade" }),
    forecastQty: numeric("forecast_qty", { precision: 14, scale: 4 })
      .notNull()
      .default("0"),
    notes: text("notes"),
  },
  (t) => ({
    byForecast: index("prod_forecast_line_fc_idx").on(t.forecastId),
  }),
);

export const insertProductionForecastSchema = createInsertSchema(
  productionForecastsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertProductionForecastLineSchema = createInsertSchema(
  productionForecastLinesTable,
).omit({ id: true });

export type ProductionForecast = typeof productionForecastsTable.$inferSelect;
export type ProductionForecastLine =
  typeof productionForecastLinesTable.$inferSelect;

// ─── ROUND D — Downtime Tracking + OEE (تتبع التوقفات + OEE) ─────────────
// Downtime events log every minute a work center is NOT producing —
// either planned (PM, changeover, breaks) or unplanned (breakdown,
// material shortage). Combined with the existing shift capacity
// (`workCenters.capacityHoursPerDay`) and production order qty fields
// (`producedQty` / `wasteQty`), we can compute an OEE-lite metric:
//
//   Availability = (planned_minutes - downtime_minutes) / planned_minutes
//   Quality      = producedQty / (producedQty + wasteQty)
//   OEE          = Availability × Quality
//
// Performance dimension (actual rate vs ideal cycle time) is omitted in
// this MVP because we don't yet store per-product ideal cycle times.
//
// Multi-tenant: every table has companyId; queries scope on it.
// Not branch-scoped — downtime is a work-center concern.
export const DOWNTIME_CATEGORIES = ["planned", "unplanned"] as const;
export type DowntimeCategory = (typeof DOWNTIME_CATEGORIES)[number];

export const productionDowntimeReasonsTable = pgTable(
  "production_downtime_reasons",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    code: text("code").notNull(),           // e.g. "BRK01", "PM"
    nameAr: text("name_ar").notNull(),
    nameEn: text("name_en"),
    category: text("category").notNull().default("unplanned"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    byCompany: index("dt_reason_company_idx").on(t.companyId),
    uniqCode: uniqueIndex("dt_reason_company_code_uniq").on(
      t.companyId,
      t.code,
    ),
  }),
);

export const productionDowntimeEventsTable = pgTable(
  "production_downtime_events",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    workCenterId: integer("work_center_id")
      .notNull()
      .references(() => workCentersTable.id, { onDelete: "cascade" }),
    reasonId: integer("reason_id").references(
      () => productionDowntimeReasonsTable.id,
      { onDelete: "set null" },
    ),
    productionOrderId: integer("production_order_id"),
    startAt: timestamp("start_at").notNull(),
    endAt: timestamp("end_at").notNull(),
    // Materialised on save so reporting queries don't need EXTRACT(epoch …)
    // every time. Required to be non-null and >= 0.
    durationMinutes: integer("duration_minutes").notNull().default(0),
    notes: text("notes"),
    loggedByUserId: integer("logged_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    byCompany: index("dt_event_company_idx").on(t.companyId),
    byWcStart: index("dt_event_wc_start_idx").on(
      t.companyId,
      t.workCenterId,
      t.startAt,
    ),
  }),
);

export const insertDowntimeReasonSchema = createInsertSchema(
  productionDowntimeReasonsTable,
).omit({ id: true, createdAt: true });
export const insertDowntimeEventSchema = createInsertSchema(
  productionDowntimeEventsTable,
).omit({ id: true, createdAt: true, durationMinutes: true });

export type ProductionDowntimeReason =
  typeof productionDowntimeReasonsTable.$inferSelect;
export type ProductionDowntimeEvent =
  typeof productionDowntimeEventsTable.$inferSelect;
