import { pgTable, serial, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

export const regionsTable = pgTable("regions", {
  id:        serial("id").primaryKey(),
  code:      text("code").notNull(),
  nameAr:    text("name_ar").notNull(),
  nameEn:    text("name_en"),
  notes:     text("notes"),
  companyId: integer("company_id").references(() => companiesTable.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const branchesTable = pgTable("branches", {
  id:        serial("id").primaryKey(),
  code:      text("code").notNull(),
  nameAr:    text("name_ar").notNull(),
  nameEn:    text("name_en"),
  regionId:  integer("region_id").references(() => regionsTable.id),
  companyId: integer("company_id").references(() => companiesTable.id),
  city:      text("city"),
  address:   text("address"),
  phone:     text("phone"),
  email:     text("email"),
  isMain:    boolean("is_main").notNull().default(false),
  status:    text("status").notNull().default("active"),
  notes:     text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
