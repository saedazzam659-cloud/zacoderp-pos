import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import { contractingProjectsTable, contractingOwnerContractsTable } from "./contracting";
import { contractingContractBoqLinesTable } from "./contractingBoq";

/**
 * Country-provider codes attached to an exact owner-contract BOQ line.
 * This is deliberately separate from commercial BOQ values and from sales
 * invoice mappings. Provider codes must be entered by a company admin.
 */
export const contractingOwnerBillTaxMappingsTable = pgTable(
  "contracting_owner_bill_tax_mappings",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    projectId: integer("project_id").notNull()
      .references(() => contractingProjectsTable.id, { onDelete: "cascade" }),
    ownerContractId: integer("owner_contract_id").notNull()
      .references(() => contractingOwnerContractsTable.id, { onDelete: "cascade" }),
    boqLineId: integer("boq_line_id").notNull()
      .references(() => contractingContractBoqLinesTable.id, { onDelete: "cascade" }),
    countryCode: text("country_code").notNull(),
    provider: text("provider").notNull(),
    providerItemCode: text("provider_item_code").notNull(),
    providerUnitCode: text("provider_unit_code").notNull(),
    providerTaxCategoryCode: text("provider_tax_category_code").notNull(),
    createdByUserId: integer("created_by_user_id")
      .references(() => usersTable.id, { onDelete: "set null" }),
    updatedByUserId: integer("updated_by_user_id")
      .references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    byOwnerContract: index("ctg_owner_bill_tax_map_contract_idx")
      .on(t.companyId, t.projectId, t.ownerContractId),
    byBoqLine: uniqueIndex("ctg_owner_bill_tax_map_line_provider_uidx")
      .on(t.companyId, t.boqLineId, t.provider),
    validProviderCountry: check("ctg_owner_bill_tax_map_country_provider_ck", sql`
      (${t.countryCode} = 'EG' AND ${t.provider} = 'egypt_eta')
      OR (${t.countryCode} = 'JO' AND ${t.provider} = 'jordan_national')
    `),
  }),
);

export type ContractingOwnerBillTaxMapping =
  typeof contractingOwnerBillTaxMappingsTable.$inferSelect;