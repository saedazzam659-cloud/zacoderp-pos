import { pgTable, serial, integer, text, timestamp, unique } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

/** Shared identity only; customer/supplier settings and ledgers stay in role tables. */
export const partyIdentitiesTable = pgTable("party_identities", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  nameAr: text("name_ar").notNull(),
  nameEn: text("name_en"),
  vatNumber: text("vat_number"),
  crNumber: text("cr_number"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  companyCodeUnique: unique("party_identities_company_code_uq").on(t.companyId, t.code),
  companyIdUnique: unique("party_identities_company_id_id_uq").on(t.companyId, t.id),
}));
