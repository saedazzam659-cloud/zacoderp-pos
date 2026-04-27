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
  // Number of modules the plan includes "for free" — anything selected on
  // top of this count is added to the bill at the module's monthly price.
  // Mirrors the legacy static PLAN_INCLUDED map (starter:2, pro:5, ent:100)
  // but lives in the DB so SuperAdmin can tune it from PlanSettings.tsx.
  includedModulesCount: integer("included_modules_count").notNull().default(0),
  features: text("features").notNull().default("[]"),
  isRecommended: boolean("is_recommended").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PlanConfig = typeof planConfigsTable.$inferSelect;
