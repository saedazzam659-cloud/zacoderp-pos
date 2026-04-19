import {
  pgTable, serial, text, integer, boolean, timestamp, pgEnum,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

export const accountTypeEnum = pgEnum("account_type", [
  "asset", "liability", "equity", "revenue", "expense",
]);

export const accountsTable = pgTable("accounts", {
  id:              serial("id").primaryKey(),
  companyId:       integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  parentId:        integer("parent_id"),
  code:            text("code").notNull(),
  nameAr:          text("name_ar").notNull(),
  nameEn:          text("name_en"),
  accountType:     accountTypeEnum("account_type").notNull(),
  reportDirection: text("report_direction"),
  level:           integer("level").notNull().default(1),
  isPosting:       boolean("is_posting").notNull().default(true),
  isActive:        boolean("is_active").notNull().default(true),
  notes:           text("notes"),
  createdAt:       timestamp("created_at").defaultNow().notNull(),
  updatedAt:       timestamp("updated_at").defaultNow().notNull(),
});

export type Account = typeof accountsTable.$inferSelect;
