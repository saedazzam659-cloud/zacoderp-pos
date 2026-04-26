import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const modulesTable = pgTable("modules", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  nameAr: text("name_ar").notNull(),
  nameEn: text("name_en").notNull().default(""),
  description: text("description").notNull().default(""),
  monthlyPrice: text("monthly_price").notNull().default("0"),
  icon: text("icon").notNull().default("Package"),
  iconColor: text("icon_color").notNull().default("#0ea5e9"),
  category: text("category").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Module = typeof modulesTable.$inferSelect;
export type NewModule = typeof modulesTable.$inferInsert;
