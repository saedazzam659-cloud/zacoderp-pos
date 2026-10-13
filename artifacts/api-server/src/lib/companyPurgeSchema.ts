import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const PURGE_AWARE_IMMUTABILITY_FUNCTIONS = [
  `CREATE OR REPLACE FUNCTION public.reject_sales_line_production_cost_mutation()
   RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF TG_OP = 'DELETE' AND OLD.company_id IS NOT NULL AND (
       current_setting('zacode.company_reset_company_id', TRUE) = OLD.company_id::TEXT
       OR current_setting('zacode.company_purge_company_id', TRUE) = OLD.company_id::TEXT
     ) THEN
       RETURN OLD;
     END IF;
     RAISE EXCEPTION 'sales line production cost attributions are immutable';
   END;
   $$`,
  `CREATE OR REPLACE FUNCTION public.reject_contracting_material_allocation_mutation()
   RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF TG_OP = 'DELETE' AND OLD.company_id IS NOT NULL AND (
       current_setting('zacode.company_reset_company_id', TRUE) = OLD.company_id::TEXT
       OR current_setting('zacode.company_purge_company_id', TRUE) = OLD.company_id::TEXT
     ) THEN
       RETURN OLD;
     END IF;
     RAISE EXCEPTION 'contracting material cost allocations are immutable';
   END;
   $$`,
  `CREATE OR REPLACE FUNCTION public.reject_production_cost_allocation_mutation()
   RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF TG_OP = 'DELETE' AND OLD.company_id IS NOT NULL AND (
       current_setting('zacode.company_reset_company_id', TRUE) = OLD.company_id::TEXT
       OR current_setting('zacode.company_purge_company_id', TRUE) = OLD.company_id::TEXT
     ) THEN
       RETURN OLD;
     END IF;
     RAISE EXCEPTION 'production cost allocation snapshots are immutable';
   END;
   $$`,
  `CREATE OR REPLACE FUNCTION public.reject_production_stage_resource_cost_mutation()
   RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF TG_OP = 'DELETE' AND OLD.company_id IS NOT NULL AND (
       current_setting('zacode.company_reset_company_id', TRUE) = OLD.company_id::TEXT
       OR current_setting('zacode.company_purge_company_id', TRUE) = OLD.company_id::TEXT
     ) THEN
       RETURN OLD;
     END IF;
     RAISE EXCEPTION 'production stage resource cost snapshots are immutable';
   END;
   $$`,
] as const;

/**
 * Keep append-only evidence immutable during normal operation while allowing
 * the validated, transaction-scoped reset/purge path to remove only its own
 * company's rows. Runs on the active DB so this also covers agent databases.
 */
export async function ensureCompanyPurgeSchema(): Promise<void> {
  for (const statement of PURGE_AWARE_IMMUTABILITY_FUNCTIONS) {
    await db.execute(sql.raw(statement));
  }
}
