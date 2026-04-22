import {
  pgTable, serial, text, integer, boolean, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

export const costCentersTable = pgTable("cost_centers", {
  id:          serial("id").primaryKey(),
  companyId:   integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  parentId:    integer("parent_id"),
  code:        text("code").notNull(),
  nameAr:      text("name_ar").notNull(),
  nameEn:      text("name_en"),
  level:       integer("level").notNull().default(1),
  isPosting:   boolean("is_posting").notNull().default(true),
  isActive:    boolean("is_active").notNull().default(true),
  notes:       text("notes"),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
  updatedAt:   timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  companyCodeUq: uniqueIndex("cost_centers_company_code_uq").on(t.companyId, t.code),
}));

export type CostCenter = typeof costCentersTable.$inferSelect;
