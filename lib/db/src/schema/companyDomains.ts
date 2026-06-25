import { pgTable, serial, integer, text, boolean, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// ─────────────────────────────────────────────────────────────────────────
// Multi-Domain Management (SuperAdmin-only platform module).
//
// Lets each company run on its own domain (e.g. company1.com, erp.company3.com)
// while staying on the SAME shared multi-tenant database. One domain maps to
// exactly one company. A request arriving on a mapped + active domain scopes
// to that company as a FALLBACK only (explicit ?companyId= and acting-company
// impersonation still win — see resolveCompanyId). The main domain keeps the
// current multi-company behavior.
//
// Purely additive: a new table + new SuperAdmin screen. Existing tenant data
// is untouched.
// ─────────────────────────────────────────────────────────────────────────
export const companyDomainsTable = pgTable("company_domains", {
  id:        serial("id").primaryKey(),
  // One domain → one company. Cascade so removing a company drops its domains.
  // NULLABLE: the shared "main" multi-company domain (isMain=true) has NO bound
  // company — it keeps the default multi-company behavior (see domainResolver).
  companyId: integer("company_id").references(() => companiesTable.id, { onDelete: "cascade" }),
  // Normalised host (lowercase, no scheme/port). Globally unique.
  domain:    text("domain").notNull(),
  // The primary/canonical domain for the company (at most one per company —
  // enforced in the API layer, not the DB, to keep edits flexible).
  isPrimary: boolean("is_primary").notNull().default(false),
  // The shared "main" multi-company domain — NOT bound to a single company;
  // preserves the default multi-company behavior. At most one (API-enforced).
  isMain: boolean("is_main").notNull().default(false),
  // pending | active | disabled.
  status:    text("status").notNull().default("pending"),
  // When the domain went live (set when activated).
  activatedAt: timestamp("activated_at"),
  // Last read-only domain check (DNS / SSL / reachability) results + when.
  lastCheckAt:     timestamp("last_check_at"),
  lastCheckResult: jsonb("last_check_result"),
  notes:     text("notes"),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  domainUniq:  uniqueIndex("company_domains_domain_uniq").on(t.domain),
  companyIdx:  index("company_domains_company_idx").on(t.companyId),
}));

export type CompanyDomain = typeof companyDomainsTable.$inferSelect;
