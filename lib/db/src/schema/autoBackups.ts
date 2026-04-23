import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

export const autoBackupsTable = pgTable("auto_backups", {
  id:        serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  reason:    text("reason").notNull().default("scheduled"),   // scheduled | manual
  sizeBytes: integer("size_bytes").notNull().default(0),
  counts:    jsonb("counts").notNull(),                       // { items: 100, customers: 20, ... }
  data:      jsonb("data").notNull(),                         // full serialised backup payload
});

export type AutoBackup = typeof autoBackupsTable.$inferSelect;
