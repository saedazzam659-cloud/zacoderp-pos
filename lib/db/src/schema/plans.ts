import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const planConfigsTable = pgTable("plan_configs", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  nameAr: text("name_ar").notNull(),
  nameEn: text("name_en").notNull(),
  monthlyPrice: text("monthly_price").notNull().default("0"),
  annualPrice: text("annual_price").notNull().default("0"),
  maxUsers: integer("max_users").notNull().default(1),
  maxBranches: integer("max_branches").notNull().default(1),
  maxWarehouses: integer("max_warehouses").notNull().default(1),
  maxInvoices: integer("max_invoices").notNull().default(50),
  features: text("features").notNull().default("[]"),
  isRecommended: boolean("is_recommended").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PlanConfig = typeof planConfigsTable.$inferSelect;
