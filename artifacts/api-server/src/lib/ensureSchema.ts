import { centralDb, db, getActiveExternalDb, pool } from "@workspace/db";
import * as schema from "@workspace/db";
import { sql, is } from "drizzle-orm";
import { PgTable, PgEnumColumn } from "drizzle-orm/pg-core";
import { getTableConfig } from "drizzle-orm/pg-core";
import { PgEnum } from "drizzle-orm/pg-core";
import { logger } from "./logger";
import { reconcilePostgresSequences } from "./postgresSequenceReconciliation.js";
import { ensureContractingBillDetailsTables } from "./contracting-bill-details-service.js";
import { ensureContractingBoqTables } from "./contracting-boq-service.js";
import { ensureContractingSettingsTable } from "./contracting-settings.js";
import { ensureContractCreateIdempotencySchema } from "./contracting-contract-create-idempotency.js";
import { ensureBillCreateIdempotencySchema } from "./contracting-bill-create-idempotency.js";
import {
  ensureContractingProjectIntegrity,
  ensureContractingProjectIntegrityPrerequisites,
} from "./contracting-integrity.js";
import { ensureContractingAccountingTables } from "./contracting-accounting-storage.js";
import { ensureContractingCostAllocationTables } from "./contracting-cost-allocation-service.js";
import { ensureContractingExecutionSchema } from "./contracting-execution-storage.js";
import { ensureContractingGuaranteeTables } from "./contracting-guarantees-storage.js";

let healPromise: Promise<void> | null = null;
type SchemaReconciliationState =
  | { state: "idle" | "running" }
  | { state: "ready"; completedAt: string }
  | { state: "failed"; error: string };
let schemaReconciliationState: SchemaReconciliationState = { state: "idle" };

export function getSchemaReconciliationState(): SchemaReconciliationState {
  return { ...schemaReconciliationState };
}

/**
 * Database-level invariant for every JE producer (invoices, returns, vouchers,
 * manual entries, and generated/conversion entries).  The journal header is
 * the tenant authority: an account registered as a bank account by some other
 * tenant must not affect this tenant's lines.
 *
 * Keep this as a BEFORE trigger rather than normalising in route callers so
 * future posting engines cannot accidentally bypass the rule.  Assigning NULL
 * is intentionally idempotent, preserving the existing explicit VAT-line NULL
 * behaviour.
 */
export const BANK_JE_COST_CENTER_LOCK_DDL = `
CREATE OR REPLACE FUNCTION null_bank_je_line_cost_center()
RETURNS trigger AS $$
DECLARE
  is_bank_ledger boolean := false;
BEGIN
  IF NEW.cost_center IS NULL THEN
    RETURN NEW;
  END IF;

  WITH RECURSIVE account_ancestors AS (
    SELECT a.id, a.parent_id, a.code, a.company_id, a.account_type
      FROM accounts a
      JOIN journal_entries je
        ON je.id = NEW.entry_id
       AND je.company_id = a.company_id
     WHERE a.id = NEW.account_id
    UNION ALL
    SELECT parent.id, parent.parent_id, parent.code, parent.company_id, parent.account_type
      FROM accounts parent
      JOIN account_ancestors child
        ON child.parent_id = parent.id
       AND child.company_id = parent.company_id
  )
  SELECT
    EXISTS (
       SELECT 1
         FROM journal_entries je
         JOIN bank_accounts ba
           ON ba.company_id = je.company_id
          AND ba.account_id = NEW.account_id
        WHERE je.id = NEW.entry_id
     )
    OR EXISTS (
      SELECT 1
        FROM account_ancestors leaf
       WHERE leaf.id = NEW.account_id
         AND leaf.account_type = 'asset'
         AND (
           EXISTS (
             SELECT 1
               FROM account_ancestors ancestor
              WHERE ancestor.code IN ('1102', '11021')
           )
           OR EXISTS (
             SELECT 1
               FROM account_ancestors ancestor
               JOIN accounting_mappings mapping
                 ON mapping.company_id = ancestor.company_id
                AND (
                  (mapping.document_type = 'entity_account_parents' AND mapping.role_key = 'bank_account_parent')
                  OR (mapping.document_type = 'bank' AND mapping.role_key = 'bank_main')
                )
                AND mapping.account_id = ancestor.id
           )
           OR (
             (leaf.code LIKE '1102%' OR leaf.code LIKE '11021%')
             AND length(leaf.code) > 5
             AND NOT EXISTS (
               SELECT 1
                 FROM account_ancestors ancestor
                WHERE ancestor.id <> leaf.id
             )
           )
         )
    )
    INTO is_bank_ledger;

  IF is_bank_ledger THEN
    NEW.cost_center := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_entry_lines_bank_cost_center_null
  ON journal_entry_lines;
CREATE TRIGGER journal_entry_lines_bank_cost_center_null
BEFORE INSERT OR UPDATE OF entry_id, account_id, cost_center
ON journal_entry_lines
FOR EACH ROW
EXECUTE FUNCTION null_bank_je_line_cost_center();

CREATE OR REPLACE FUNCTION clear_existing_bank_je_line_cost_centers()
RETURNS trigger AS $$
BEGIN
  IF NEW.account_id IS NOT NULL THEN
    UPDATE journal_entry_lines jel
       SET cost_center = NULL
      FROM journal_entries je
     WHERE je.id = jel.entry_id
       AND je.company_id = NEW.company_id
       AND jel.account_id = NEW.account_id
       AND jel.cost_center IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bank_accounts_clear_je_cost_centers
  ON bank_accounts;
CREATE TRIGGER bank_accounts_clear_je_cost_centers
AFTER INSERT OR UPDATE OF company_id, account_id
ON bank_accounts
FOR EACH ROW
EXECUTE FUNCTION clear_existing_bank_je_line_cost_centers();

WITH RECURSIVE bank_tree AS (
  SELECT a.id, a.company_id
    FROM accounts a
   WHERE a.account_type = 'asset'
     AND (
       a.code IN ('1102', '11021')
       OR EXISTS (
         SELECT 1
           FROM accounting_mappings mapping
          WHERE mapping.company_id = a.company_id
            AND mapping.account_id = a.id
            AND (
              (mapping.document_type = 'entity_account_parents' AND mapping.role_key = 'bank_account_parent')
              OR (mapping.document_type = 'bank' AND mapping.role_key = 'bank_main')
            )
       )
     )
  UNION
  SELECT child.id, child.company_id
    FROM accounts child
    JOIN bank_tree parent
      ON child.parent_id = parent.id
     AND child.company_id = parent.company_id
),
bank_ledger_ids AS (
  SELECT company_id, account_id
    FROM bank_accounts
   WHERE account_id IS NOT NULL
  UNION
  SELECT company_id, id
    FROM bank_tree
)
UPDATE journal_entry_lines jel
   SET cost_center = NULL
  FROM journal_entries je
 WHERE je.id = jel.entry_id
   AND jel.cost_center IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM bank_ledger_ids bank_ledger
      WHERE bank_ledger.company_id = je.company_id
        AND bank_ledger.account_id = jel.account_id
   )`;

// These columns are platform control state. The shared Drizzle schema must
// expose them to central routes, but external-agent schema healing must never
// materialize them in an agent business database.
const CENTRAL_ONLY_AGENT_ACCELERATION_COLUMNS = [
  "agent_instances.invoice_acceleration_mode",
  "agent_instances.invoice_trial_remaining",
  "agent_instances.invoice_acceleration_last_error",
  "agent_instances.invoice_acceleration_reason",
  "agent_instances.invoice_acceleration_updated_at",
  "agent_instances.invoice_acceleration_generation",
  "agent_instances.invoice_acceleration_baseline",
] as const;

// These control-plane records contain an encrypted, one-time registration
// envelope and must never be materialized in an agent's independent database.
const CENTRAL_ONLY_ZATCA_TRANSFER_TABLES = ["zatca_registration_transfers"] as const;

// Older agent bundles emitted supplier_tax_number while the current shared
// schema uses supplier_vat_number. Keep both additive columns during the
// rolling-upgrade window so saving a purchase invoice cannot fail while an
// agent is moving between those package generations.
const SUPPLIER_METADATA_COMPATIBILITY_DDL = [
  `ALTER TABLE IF EXISTS journal_entry_lines ADD COLUMN IF NOT EXISTS supplier_name TEXT`,
  `ALTER TABLE IF EXISTS journal_entry_lines ADD COLUMN IF NOT EXISTS supplier_tax_number TEXT`,
  `ALTER TABLE IF EXISTS journal_entry_lines ADD COLUMN IF NOT EXISTS supplier_vat_number TEXT`,
  `ALTER TABLE IF EXISTS journal_entry_lines ADD COLUMN IF NOT EXISTS supplier_invoice_number TEXT`,
  `ALTER TABLE IF EXISTS journal_entry_lines ADD COLUMN IF NOT EXISTS supplier_invoice_date TEXT`,
  `ALTER TABLE IF EXISTS payment_voucher_lines ADD COLUMN IF NOT EXISTS supplier_name TEXT`,
  `ALTER TABLE IF EXISTS receipt_voucher_lines ADD COLUMN IF NOT EXISTS contracting_kind TEXT`,
  `ALTER TABLE IF EXISTS receipt_voucher_lines ADD COLUMN IF NOT EXISTS contracting_project_id INTEGER`,
  `ALTER TABLE IF EXISTS receipt_voucher_lines ADD COLUMN IF NOT EXISTS contracting_contract_id INTEGER`,
  `ALTER TABLE IF EXISTS receipt_voucher_lines ADD COLUMN IF NOT EXISTS contracting_bill_id INTEGER`,
  `ALTER TABLE IF EXISTS payment_voucher_lines ADD COLUMN IF NOT EXISTS contracting_kind TEXT`,
  `ALTER TABLE IF EXISTS payment_voucher_lines ADD COLUMN IF NOT EXISTS contracting_project_id INTEGER`,
  `ALTER TABLE IF EXISTS payment_voucher_lines ADD COLUMN IF NOT EXISTS contracting_contract_id INTEGER`,
  `ALTER TABLE IF EXISTS payment_voucher_lines ADD COLUMN IF NOT EXISTS contracting_bill_id INTEGER`,
  `ALTER TABLE IF EXISTS payment_voucher_lines ADD COLUMN IF NOT EXISTS supplier_tax_number TEXT`,
  `ALTER TABLE IF EXISTS payment_voucher_lines ADD COLUMN IF NOT EXISTS supplier_vat_number TEXT`,
  `ALTER TABLE IF EXISTS payment_voucher_lines ADD COLUMN IF NOT EXISTS supplier_invoice_number TEXT`,
  `ALTER TABLE IF EXISTS payment_voucher_lines ADD COLUMN IF NOT EXISTS supplier_invoice_date TEXT`,
] as const;

async function ensureSupplierMetadataCompatibility(): Promise<void> {
  for (const stmt of SUPPLIER_METADATA_COMPATIBILITY_DDL) {
    try {
      await execDDL(stmt);
    } catch (err) {
      logger.error({ err, stmt }, "ensureSchema: supplier metadata compatibility reconciliation failed");
      throw err;
    }
  }
}

// Generic schema inspection can run after traffic starts in an external agent.
// These source-fact columns are read during manufacturing close, so heal them
// explicitly before any purchasing/production route can expose a tagged line.
const INDUSTRIAL_PURCHASE_COST_COMPATIBILITY_DDL = [
  `ALTER TABLE IF EXISTS purchase_invoice_lines ADD COLUMN IF NOT EXISTS industrial_cost JSONB`,
  `ALTER TABLE IF EXISTS purchase_return_lines ADD COLUMN IF NOT EXISTS industrial_cost JSONB`,
] as const;

// Internal transport is an additive cost on a warehouse transfer. Keep this
// rolling-upgrade DDL independent from Drizzle migrations so old tenants can
// receive the fields without rewriting posted documents.
const INTERNAL_TRANSPORT_COMPATIBILITY_DDL = [
  `ALTER TABLE IF EXISTS stock_transfers ADD COLUMN IF NOT EXISTS transfer_type TEXT NOT NULL DEFAULT 'warehouse'`,
  `ALTER TABLE IF EXISTS stock_transfers ADD COLUMN IF NOT EXISTS production_order_id INTEGER`,
  `ALTER TABLE IF EXISTS stock_transfers ADD COLUMN IF NOT EXISTS internal_transport_amount NUMERIC(18,2) NOT NULL DEFAULT '0'`,
  `ALTER TABLE IF EXISTS stock_transfers ADD COLUMN IF NOT EXISTS internal_transport_expense_account_id INTEGER`,
  `ALTER TABLE IF EXISTS stock_transfers ADD COLUMN IF NOT EXISTS internal_transport_counterpart_account_id INTEGER`,
  `ALTER TABLE IF EXISTS stock_transfers ADD COLUMN IF NOT EXISTS internal_transport_journal_entry_id INTEGER`,
  `ALTER TABLE IF EXISTS manufacturing_settings ADD COLUMN IF NOT EXISTS internal_transport_enabled BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE IF EXISTS production_cost_allocations ADD COLUMN IF NOT EXISTS reclassification_journal_entry_id INTEGER`,
  `ALTER TABLE IF EXISTS production_cost_allocations ADD COLUMN IF NOT EXISTS reversal_journal_entry_id INTEGER`,
  `CREATE INDEX IF NOT EXISTS stock_transfers_production_order_idx ON stock_transfers (company_id, production_order_id)`,
] as const;

async function ensureInternalTransportCompatibility(): Promise<void> {
  for (const stmt of INTERNAL_TRANSPORT_COMPATIBILITY_DDL) await execDDL(stmt);
}

async function ensureIndustrialPurchaseCostCompatibility(): Promise<void> {
  for (const stmt of INDUSTRIAL_PURCHASE_COST_COMPATIBILITY_DDL) {
    try {
      await execDDL(stmt);
    } catch (err) {
      logger.error({ err, stmt }, "ensureSchema: industrial purchase-cost compatibility reconciliation failed");
      throw err;
    }
  }
}

// Contracting resource inventory links were added after the original
// contracting tables shipped.  Keep this reconciliation additive for both the
// central database and external agents: existing labour/equipment rows remain
// valid and material planning rows gain nullable links plus a quantity
// conversion snapshot.  Planning is deliberately not coupled to stock
// posting; these columns are read-only allocation metadata.
const CONTRACTING_RESOURCE_INVENTORY_COMPATIBILITY_DDL = [
  `ALTER TABLE IF EXISTS contracting_resources ADD COLUMN IF NOT EXISTS item_id INTEGER`,
  `ALTER TABLE IF EXISTS contracting_resources ADD COLUMN IF NOT EXISTS unit_id INTEGER`,
  `ALTER TABLE IF EXISTS contracting_resources ADD COLUMN IF NOT EXISTS warehouse_id INTEGER`,
  `ALTER TABLE IF EXISTS contracting_resources ADD COLUMN IF NOT EXISTS qty_base NUMERIC(30,18) NOT NULL DEFAULT 0`,
  `ALTER TABLE IF EXISTS contracting_resources ADD COLUMN IF NOT EXISTS conversion_factor NUMERIC(30,18) NOT NULL DEFAULT 1`,
  `CREATE INDEX IF NOT EXISTS ctg_res_item_idx ON contracting_resources(company_id, item_id)`,
  `CREATE INDEX IF NOT EXISTS ctg_res_warehouse_idx ON contracting_resources(company_id, warehouse_id)`,
] as const;

async function ensureContractingResourceInventoryCompatibility(): Promise<void> {
  for (const stmt of CONTRACTING_RESOURCE_INVENTORY_COMPATIBILITY_DDL) {
    try {
      await execDDL(stmt);
    } catch (err) {
      logger.error({ err, stmt }, "ensureSchema: contracting resource inventory compatibility reconciliation failed");
      throw err;
    }
  }
}

// Project/customer links are nullable by design: NULL + client_name is the
// explicit unlinked legacy form. Keep the tenant lookup index available on
// databases that were created before the customer link was introduced.
const CONTRACTING_PROJECT_CUSTOMER_COMPATIBILITY_DDL = [
  `ALTER TABLE IF EXISTS contracting_projects ADD COLUMN IF NOT EXISTS customer_id INTEGER`,
  `CREATE INDEX IF NOT EXISTS ctg_proj_customer_idx ON contracting_projects(company_id, customer_id)`,
] as const;

async function ensureContractingProjectCustomerCompatibility(): Promise<void> {
  for (const stmt of CONTRACTING_PROJECT_CUSTOMER_COMPATIBILITY_DDL) {
    try {
      await execDDL(stmt);
    } catch (err) {
      logger.error({ err, stmt }, "ensureSchema: contracting project customer compatibility reconciliation failed");
      throw err;
    }
  }
}

// Cost-centre links are optional for both projects and progress bills. Keep
// this additive so older tenant databases gain the columns without needing a
// destructive table rebuild; the Drizzle schema owns the FK metadata for new
// installs.
const CONTRACTING_COST_CENTER_COMPATIBILITY_DDL = [
  `ALTER TABLE IF EXISTS contracting_projects ADD COLUMN IF NOT EXISTS cost_center_id INTEGER`,
  `CREATE INDEX IF NOT EXISTS ctg_proj_cost_center_idx ON contracting_projects(company_id, cost_center_id)`,
  `ALTER TABLE IF EXISTS contracting_progress_bills ADD COLUMN IF NOT EXISTS cost_center_id INTEGER`,
  `CREATE INDEX IF NOT EXISTS ctg_bill_cost_center_idx ON contracting_progress_bills(company_id, cost_center_id)`,
] as const;

async function ensureContractingCostCenterCompatibility(): Promise<void> {
  for (const stmt of CONTRACTING_COST_CENTER_COMPATIBILITY_DDL) {
    try {
      await execDDL(stmt);
    } catch (err) {
      logger.error({ err, stmt }, "ensureSchema: contracting cost-centre compatibility reconciliation failed");
      throw err;
    }
  }
}

// Contract policy columns are deliberately additive. Recovery remains disabled
// for historical rows and retention keeps a legacy-compatible enabled/100%
// contract default; no historical bill is backfilled or recalculated by this
// heal pass.
const CONTRACTING_ADVANCE_RECOVERY_COMPATIBILITY_DDL = [
  `ALTER TABLE IF EXISTS contracting_owner_contracts
     ADD COLUMN IF NOT EXISTS advance_recovery_enabled BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE IF EXISTS contracting_owner_contracts
     ADD COLUMN IF NOT EXISTS advance_recovery_percent NUMERIC(5,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE IF EXISTS contracting_owner_contracts
     ADD COLUMN IF NOT EXISTS advance_recovery_method TEXT NOT NULL DEFAULT 'percentage'`,
  `ALTER TABLE IF EXISTS contracting_owner_contracts
     ADD COLUMN IF NOT EXISTS advance_recovery_fixed_amount NUMERIC(14,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE IF EXISTS contracting_owner_contracts
     ADD COLUMN IF NOT EXISTS advance_recovery_start_progress_percent NUMERIC(5,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE IF EXISTS contracting_owner_contracts
     ADD COLUMN IF NOT EXISTS retention_enabled BOOLEAN NOT NULL DEFAULT TRUE`,
  `ALTER TABLE IF EXISTS contracting_owner_contracts
     ADD COLUMN IF NOT EXISTS retention_cap_percent NUMERIC(5,2) NOT NULL DEFAULT 100`,
  `ALTER TABLE IF EXISTS contracting_sub_contracts
     ADD COLUMN IF NOT EXISTS advance_recovery_enabled BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE IF EXISTS contracting_sub_contracts
     ADD COLUMN IF NOT EXISTS advance_recovery_percent NUMERIC(5,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE IF EXISTS contracting_sub_contracts
     ADD COLUMN IF NOT EXISTS advance_recovery_method TEXT NOT NULL DEFAULT 'percentage'`,
  `ALTER TABLE IF EXISTS contracting_sub_contracts
     ADD COLUMN IF NOT EXISTS advance_recovery_fixed_amount NUMERIC(14,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE IF EXISTS contracting_sub_contracts
     ADD COLUMN IF NOT EXISTS advance_recovery_start_progress_percent NUMERIC(5,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE IF EXISTS contracting_sub_contracts
     ADD COLUMN IF NOT EXISTS retention_enabled BOOLEAN NOT NULL DEFAULT TRUE`,
  `ALTER TABLE IF EXISTS contracting_sub_contracts
     ADD COLUMN IF NOT EXISTS retention_cap_percent NUMERIC(5,2) NOT NULL DEFAULT 100`,
  `ALTER TABLE IF EXISTS contracting_progress_bills
     ADD COLUMN IF NOT EXISTS advance_recovery_enabled BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE IF EXISTS contracting_progress_bills
     ADD COLUMN IF NOT EXISTS advance_recovery_percent NUMERIC(5,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE IF EXISTS contracting_progress_bills
     ADD COLUMN IF NOT EXISTS advance_recovery_method TEXT NOT NULL DEFAULT 'percentage'`,
  `ALTER TABLE IF EXISTS contracting_progress_bills
     ADD COLUMN IF NOT EXISTS advance_recovery_fixed_amount NUMERIC(14,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE IF EXISTS contracting_progress_bills
     ADD COLUMN IF NOT EXISTS advance_recovery_start_progress_percent NUMERIC(5,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE IF EXISTS contracting_progress_bills
     ADD COLUMN IF NOT EXISTS advance_recovery_requested_amount NUMERIC(14,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE IF EXISTS contracting_progress_bills
     ADD COLUMN IF NOT EXISTS advance_recovery_amount NUMERIC(14,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE IF EXISTS contracting_progress_bills
     ADD COLUMN IF NOT EXISTS advance_recovery_remaining_before NUMERIC(14,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE IF EXISTS contracting_progress_bills
     ADD COLUMN IF NOT EXISTS advance_recovery_remaining_after NUMERIC(14,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE IF EXISTS contracting_progress_bills
     ADD COLUMN IF NOT EXISTS advance_recovery_contract_advance_amount NUMERIC(14,2)`,
  `ALTER TABLE IF EXISTS contracting_progress_bills
     ADD COLUMN IF NOT EXISTS advance_recovery_total_previously_recovered NUMERIC(14,2)`,
  `ALTER TABLE IF EXISTS contracting_progress_bills
     ADD COLUMN IF NOT EXISTS advance_recovery_override_amount NUMERIC(14,2)`,
  `ALTER TABLE IF EXISTS contracting_progress_bills
     ADD COLUMN IF NOT EXISTS advance_recovery_override_reason TEXT`,
  `ALTER TABLE IF EXISTS contracting_progress_bills
     ADD COLUMN IF NOT EXISTS retention_enabled BOOLEAN`,
  `ALTER TABLE IF EXISTS contracting_progress_bills
     ADD COLUMN IF NOT EXISTS retention_cap_percent NUMERIC(5,2)`,
  `ALTER TABLE IF EXISTS contracting_accounting_settlements
     ADD COLUMN IF NOT EXISTS application_origin TEXT NOT NULL DEFAULT 'manual'`,
  `ALTER TABLE IF EXISTS contracting_accounting_settlements
     ADD COLUMN IF NOT EXISTS reversal_journal_entry_id INTEGER`,
  `DO $$ BEGIN
     IF to_regclass('contracting_accounting_settlements') IS NOT NULL THEN
       EXECUTE 'CREATE INDEX IF NOT EXISTS ctg_advance_source_contract_idx
         ON contracting_accounting_settlements(company_id, project_id, owner_contract_id, subcontractor_contract_id, settlement_date, id)
         WHERE kind IN (''advance_receipt'',''advance_payment'') AND status = ''posted''';
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF to_regclass('contracting_accounting_settlements') IS NOT NULL THEN
       EXECUTE 'CREATE INDEX IF NOT EXISTS ctg_advance_application_bill_idx
         ON contracting_accounting_settlements(company_id, bill_id, application_origin, status)
         WHERE kind = ''advance_application''';
     END IF;
   END $$`,
] as const;

async function ensureContractingAdvanceRecoveryCompatibility(): Promise<void> {
  for (const stmt of CONTRACTING_ADVANCE_RECOVERY_COMPATIBILITY_DDL) {
    try {
      await execDDL(stmt);
    } catch (err) {
      logger.error({ err, stmt }, "ensureSchema: contracting advance-recovery reconciliation failed");
      throw err;
    }
  }
}

/**
 * The item-unit table predates the graph model.  Keep this migration additive:
 * it only derives edges when the old row has one unambiguous base marker (or
 * the existing item.unit_id identifies that marker). A sole active,
 * tenant-owned item-unit row is also provably its item's base. Multiple/no
 * candidates are preserved and flagged, never silently rebased. The guard
 * that all reference_unit_id values are still NULL makes the backfill
 * idempotent and prevents a later boot from overwriting a user-edited graph.
 */
const ITEM_UNIT_CONVERSION_COMPATIBILITY_DDL = [
  `ALTER TABLE IF EXISTS units
     ALTER COLUMN conversion_factor TYPE NUMERIC(30,18)`,
  `ALTER TABLE IF EXISTS sales_invoice_lines
     ALTER COLUMN conversion_factor TYPE NUMERIC(30,18)`,
  `ALTER TABLE IF EXISTS sales_return_lines
     ALTER COLUMN conversion_factor TYPE NUMERIC(30,18)`,
  `ALTER TABLE IF EXISTS purchase_invoice_lines
     ALTER COLUMN conversion_factor TYPE NUMERIC(30,18)`,
  `ALTER TABLE IF EXISTS purchase_order_lines
     ALTER COLUMN conversion_factor TYPE NUMERIC(30,18)`,
  `ALTER TABLE IF EXISTS purchase_return_lines
     ALTER COLUMN conversion_factor TYPE NUMERIC(30,18)`,
  `ALTER TABLE IF EXISTS sales_order_lines
     ALTER COLUMN conversion_factor TYPE NUMERIC(30,18)`,
  `ALTER TABLE IF EXISTS goods_receipt_lines
     ALTER COLUMN conversion_factor TYPE NUMERIC(30,18)`,
  `ALTER TABLE IF EXISTS goods_delivery_lines
     ALTER COLUMN conversion_factor TYPE NUMERIC(30,18)`,
  `ALTER TABLE IF EXISTS production_order_stages
     ALTER COLUMN quantity_unit_factor TYPE NUMERIC(30,18)`,
  `ALTER TABLE IF EXISTS production_order_stages
     ALTER COLUMN waste_unit_factor TYPE NUMERIC(30,18)`,
  `ALTER TABLE IF EXISTS production_waste_records
     ALTER COLUMN unit_factor TYPE NUMERIC(30,18)`,
  `ALTER TABLE IF EXISTS item_unit_prices
     ALTER COLUMN conversion_factor TYPE NUMERIC(30,18)`,
  `ALTER TABLE IF EXISTS item_unit_prices
     ADD COLUMN IF NOT EXISTS reference_unit_id INTEGER`,
  `ALTER TABLE IF EXISTS item_unit_prices
     ADD COLUMN IF NOT EXISTS relation_factor NUMERIC(30,18) NOT NULL DEFAULT 1`,
  `ALTER TABLE IF EXISTS item_unit_prices
     ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`,
  `ALTER TABLE IF EXISTS item_unit_prices
     ADD COLUMN IF NOT EXISTS decimal_places INTEGER NOT NULL DEFAULT 2`,
  `ALTER TABLE IF EXISTS item_unit_prices
     ADD COLUMN IF NOT EXISTS rounding_mode TEXT NOT NULL DEFAULT 'half_up'`,
  `ALTER TABLE IF EXISTS item_unit_prices
     ADD COLUMN IF NOT EXISTS legacy_conversion_conflict BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE IF EXISTS stock_transfer_items
     ADD COLUMN IF NOT EXISTS conversion_factor NUMERIC(30,18) NOT NULL DEFAULT 1`,
  `ALTER TABLE IF EXISTS stock_adjustment_items
     ADD COLUMN IF NOT EXISTS conversion_factor NUMERIC(30,18) NOT NULL DEFAULT 1`,
  `DO $unit_conversion_migration$
  DECLARE
    item_row RECORD;
    candidate_base INTEGER;
    base_count INTEGER;
     owned_unit_count INTEGER;
     active_unit_count INTEGER;
     sole_active_unit INTEGER;
     sole_mapping_repair BOOLEAN := FALSE;
    has_other_edge BOOLEAN;
    has_unmigrated_row BOOLEAN;
  BEGIN
    IF to_regclass('public.item_unit_prices') IS NULL THEN
      RETURN;
    END IF;
    FOR item_row IN
      SELECT DISTINCT company_id, item_id
        FROM item_unit_prices
    LOOP
      candidate_base := NULL;
       sole_mapping_repair := FALSE;
      IF EXISTS (
        SELECT 1
          FROM item_unit_prices
         WHERE company_id = item_row.company_id
           AND item_id = item_row.item_id
         GROUP BY unit_id
        HAVING COUNT(*) > 1
      ) THEN
        UPDATE item_unit_prices
           SET legacy_conversion_conflict = TRUE
         WHERE company_id = item_row.company_id
           AND item_id = item_row.item_id;
        CONTINUE;
      END IF;
      SELECT COUNT(*)::INTEGER, MIN(unit_id)
        INTO base_count, candidate_base
        FROM item_unit_prices
       WHERE company_id = item_row.company_id
         AND item_id = item_row.item_id
          AND is_active = TRUE
          AND is_base = TRUE
          AND reference_unit_id IS NULL;

      -- A pre-existing item.unit_id is an authoritative base only when it
      -- points at exactly one item-unit row. This handles old imports that
      -- did not set is_base while avoiding a guess among unrelated rows.
      IF base_count = 0 THEN
        SELECT i.unit_id
          INTO candidate_base
          FROM items i
         WHERE i.company_id = item_row.company_id
           AND i.id = item_row.item_id
           AND i.unit_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM item_unit_prices u
              WHERE u.company_id = item_row.company_id
                AND u.item_id = item_row.item_id
                AND u.unit_id = i.unit_id
                 AND u.is_active = TRUE
                 AND EXISTS (
                   SELECT 1 FROM units unit
                    WHERE unit.id = u.unit_id
                      AND unit.company_id = item_row.company_id
                 )
           );
      END IF;

       -- The old item editor/importer could persist one item-owned unit-price
       -- row but omit both its base marker and items.unit_id. There is no
       -- conversion relationship to infer in this exact shape: one active,
       -- tenant-owned mapping is necessarily the item's base. Do not apply
       -- this repair to two+ mappings (including inactive ones),
       -- inactive-only rows, or a unit from another tenant; each of those
       -- still needs an explicit repair.
       IF base_count = 0 AND candidate_base IS NULL THEN
         SELECT
           COUNT(*)::INTEGER,
           COUNT(*) FILTER (WHERE u.is_active = TRUE)::INTEGER,
           MIN(u.unit_id) FILTER (WHERE u.is_active = TRUE)
           INTO owned_unit_count, active_unit_count, sole_active_unit
           FROM item_unit_prices u
          WHERE u.company_id = item_row.company_id
            AND u.item_id = item_row.item_id
            AND EXISTS (
              SELECT 1 FROM items item
               WHERE item.id = u.item_id
                 AND item.company_id = item_row.company_id
            )
            AND EXISTS (
              SELECT 1 FROM units unit
               WHERE unit.id = u.unit_id
                 AND unit.company_id = item_row.company_id
            );
         IF owned_unit_count = 1 AND active_unit_count = 1 THEN
           candidate_base := sole_active_unit;
           sole_mapping_repair := TRUE;
         END IF;
       END IF;

      IF base_count > 1 OR (base_count = 0 AND candidate_base IS NULL) THEN
        UPDATE item_unit_prices
           SET legacy_conversion_conflict = TRUE
         WHERE company_id = item_row.company_id
           AND item_id = item_row.item_id;
        CONTINUE;
      END IF;

      IF EXISTS (
        SELECT 1 FROM items i
         WHERE i.company_id = item_row.company_id
           AND i.id = item_row.item_id
           AND i.unit_id IS NOT NULL
           AND i.unit_id <> candidate_base
      ) THEN
        UPDATE item_unit_prices
           SET legacy_conversion_conflict = TRUE
         WHERE company_id = item_row.company_id
           AND item_id = item_row.item_id;
        CONTINUE;
      END IF;

      UPDATE items
         SET unit_id = candidate_base
       WHERE company_id = item_row.company_id
         AND id = item_row.item_id
         AND unit_id IS NULL;

      -- A non-null reference means this item has already been migrated or
      -- edited; never overwrite its relationFactor on a subsequent boot.
      SELECT EXISTS (
        SELECT 1 FROM item_unit_prices
         WHERE company_id = item_row.company_id
           AND item_id = item_row.item_id
           AND reference_unit_id IS NOT NULL
      ) INTO has_other_edge;
      IF has_other_edge THEN
        SELECT EXISTS (
          SELECT 1 FROM item_unit_prices
           WHERE company_id = item_row.company_id
             AND item_id = item_row.item_id
             AND reference_unit_id IS NULL
        ) INTO has_unmigrated_row;
        IF has_unmigrated_row THEN
          UPDATE item_unit_prices
             SET legacy_conversion_conflict = TRUE
           WHERE company_id = item_row.company_id
             AND item_id = item_row.item_id;
        END IF;
        CONTINUE;
      END IF;

      UPDATE item_unit_prices
         SET is_base = (unit_id = candidate_base),
             reference_unit_id = CASE WHEN unit_id = candidate_base THEN NULL ELSE candidate_base END,
             relation_factor = CASE
               WHEN unit_id = candidate_base THEN 1
               WHEN conversion_factor > 0 THEN conversion_factor
               ELSE 1
             END,
             conversion_factor = CASE
                -- A base is always one of itself. In the deterministic
                -- single-link repair, an old cached catalog factor is not an
                -- item relationship and must not survive as one.
                WHEN unit_id = candidate_base AND sole_mapping_repair THEN 1
                WHEN unit_id = candidate_base AND conversion_factor > 0 THEN 1
               ELSE conversion_factor
             END,
              -- This pass reaches here only after proving one base. Clear a
              -- stale flag left by the earlier compatibility release only
              -- for its deterministic single-link repair. Other legacy
              -- conflict signals must remain visible for explicit repair.
              legacy_conversion_conflict = CASE
                WHEN sole_mapping_repair THEN FALSE
                ELSE legacy_conversion_conflict OR conversion_factor <= 0
              END
       WHERE company_id = item_row.company_id
          AND item_id = item_row.item_id;
    END LOOP;
  END
  $unit_conversion_migration$`,
] as const;

async function ensureItemUnitConversionCompatibility(): Promise<void> {
  for (const stmt of ITEM_UNIT_CONVERSION_COMPATIBILITY_DDL) {
    try {
      await execDDL(stmt);
    } catch (err) {
      logger.error({ err, stmt }, "ensureSchema: item-unit conversion compatibility reconciliation failed");
      throw err;
    }
  }
}

// Boot-time DDL (ALTER TABLE ADD COLUMN / CREATE INDEX) must never hang forever
// waiting on a relation lock held by another backend — most importantly the
// PREVIOUS revision still serving traffic during an autoscale promote. A blocked
// ALTER would keep the HTTP port closed (see bootstrap in index.ts) and fail the
// deployment's startup probe, and worse, an ACCESS EXCLUSIVE lock request queues
// AHEAD of new queries on that table, freezing it. Scope a short lock_timeout
// via a transaction (SET LOCAL auto-resets on commit/rollback, so it never leaks
// onto a pooled connection): a contended statement aborts quickly, the caller
// catches the error and continues, and the change re-applies on the next boot.
const DDL_LOCK_TIMEOUT_MS = (() => {
  const n = Number(process.env["SCHEMA_DDL_LOCK_TIMEOUT_MS"]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4000;
})();

/**
 * Reserve only account codes created by the supplier bulk-linking tool.
 * Historical duplicate codes stay untouched, while every future account-code
 * writer participates in the same lightweight per-company serialization.
 */
export const SUPPLIER_BULK_ACCOUNT_CODE_GUARD_DDL = `
CREATE TABLE IF NOT EXISTS supplier_bulk_account_code_guards (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, code)
);

CREATE OR REPLACE FUNCTION enforce_supplier_bulk_account_code_guard()
RETURNS trigger AS $$
BEGIN
  IF NEW.code IS NULL OR btrim(NEW.code) = '' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.company_id IS NOT DISTINCT FROM OLD.company_id
     AND NEW.code IS NOT DISTINCT FROM OLD.code THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('supplier-bulk-account-company'),
    NEW.company_id
  );

  IF EXISTS (
    SELECT 1
      FROM supplier_bulk_account_code_guards guard
     WHERE guard.company_id = NEW.company_id
       AND guard.code = NEW.code
  ) AND EXISTS (
    SELECT 1
      FROM accounts existing
     WHERE existing.company_id = NEW.company_id
       AND existing.code = NEW.code
       AND (TG_OP = 'INSERT' OR existing.id <> NEW.id)
  ) THEN
    RAISE EXCEPTION 'account code % is reserved by supplier bulk assignment', NEW.code
      USING ERRCODE = '23505',
            CONSTRAINT = 'supplier_bulk_account_code_guard';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS supplier_bulk_account_code_guard ON accounts;
CREATE TRIGGER supplier_bulk_account_code_guard
BEFORE INSERT OR UPDATE OF company_id, code
ON accounts
FOR EACH ROW
EXECUTE FUNCTION enforce_supplier_bulk_account_code_guard();
`;

async function execDDL(stmt: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${DDL_LOCK_TIMEOUT_MS}ms'`));
    await tx.execute(sql.raw(stmt));
  });
}

/** Control-plane DDL must never follow the active external-agent ALS context. */
async function execCentralDDL(stmt: string): Promise<void> {
  await centralDb.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${DDL_LOCK_TIMEOUT_MS}ms'`));
    await tx.execute(sql.raw(stmt));
  });
}

// Enum DDL (`CREATE TYPE` / `ALTER TYPE … ADD VALUE`) can't reliably use the
// transaction wrapper above — `ALTER TYPE … ADD VALUE` has historical
// in-transaction restrictions. Bound it on a DEDICATED pooled client with a
// session lock_timeout, then RESET before releasing so the timeout never leaks
// onto a connection reused for normal request traffic.
async function execTypeDDL(stmt: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`SET lock_timeout = '${DDL_LOCK_TIMEOUT_MS}ms'`);
    await client.query(stmt);
  } finally {
    try {
      await client.query("RESET lock_timeout");
    } catch {
      /* best-effort reset; release still returns the client to the pool */
    }
    client.release();
  }
}

interface ExistingColumn {
  table_name: string;
  column_name: string;
}

interface ExistingTable {
  table_name: string;
}

interface ExistingEnum {
  typname: string;
}

/**
 * Quote a Postgres identifier safely (table / column / type names).
 */
function qid(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quote a Postgres string literal safely.
 */
function qstr(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Walk every export of `@workspace/db` and collect Drizzle entities we know
 * how to reconcile: pgTables (for column-level checks) and pgEnums (so we
 * can ensure missing enum types and labels exist).
 */
function collectSchemaEntities(): {
  tables: { name: string; columns: ReturnType<typeof getTableConfig>["columns"] }[];
  enums: { name: string; values: readonly string[] }[];
} {
  const tables: { name: string; columns: ReturnType<typeof getTableConfig>["columns"] }[] = [];
  const enums: { name: string; values: readonly string[] }[] = [];

  for (const exported of Object.values(schema as Record<string, unknown>)) {
    if (!exported) continue;
    // Tables are objects.
    if (typeof exported === "object" && is(exported as object, PgTable)) {
      const cfg = getTableConfig(exported as PgTable);
      tables.push({ name: cfg.name, columns: cfg.columns });
      continue;
    }
    // pgEnum() returns a callable function with metadata attached
    // (enumName + enumValues) — see drizzle-orm/pg-core/columns/enum. We
    // therefore have to inspect functions too, not just objects.
    if (typeof exported === "object" || typeof exported === "function") {
      const maybeEnum = exported as { enumName?: unknown; enumValues?: unknown };
      if (
        typeof maybeEnum.enumName === "string" &&
        Array.isArray(maybeEnum.enumValues) &&
        (maybeEnum.enumValues as unknown[]).every((v) => typeof v === "string")
      ) {
        enums.push({ name: maybeEnum.enumName, values: maybeEnum.enumValues as string[] });
      }
    }
  }

  return { tables, enums };
}

export function assertStrictSchemaReady(input: {
  failures: string[];
  missingTables?: string[];
  optionalMissingTables?: readonly string[];
}): void {
  const optional = new Set(input.optionalMissingTables ?? []);
  const blockingMissingTables = (input.missingTables ?? []).filter((name) => !optional.has(name));
  if (!input.failures.length && !blockingMissingTables.length) return;
  const parts: string[] = [];
  if (input.failures.length) parts.push(`DDL failures: ${input.failures.slice(0, 5).join("; ")}`);
  if (blockingMissingTables.length) {
    parts.push(`missing tables: ${blockingMissingTables.slice(0, 10).join(", ")}`);
  }
  throw new Error(`schema reconciliation incomplete — ${parts.join(" | ")}`);
}

async function ensureEnums(
  enums: { name: string; values: readonly string[] }[],
  options: { strict?: boolean } = {},
): Promise<string[]> {
  if (enums.length === 0) return [];
  const applied: string[] = [];
  const failures: string[] = [];

  // Pull existing enum types + their labels in one round-trip.
  const existingTypes = (await db.execute<ExistingEnum>(sql`
    SELECT typname FROM pg_type WHERE typtype = 'e'
  `)).rows as ExistingEnum[];
  const existingTypeSet = new Set(existingTypes.map((r) => r.typname));

  const existingLabels = (await db.execute<{ typname: string; enumlabel: string }>(sql`
    SELECT t.typname, e.enumlabel
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
  `)).rows as { typname: string; enumlabel: string }[];
  const labelsByType = new Map<string, Set<string>>();
  for (const row of existingLabels) {
    if (!labelsByType.has(row.typname)) labelsByType.set(row.typname, new Set());
    labelsByType.get(row.typname)!.add(row.enumlabel);
  }

  for (const e of enums) {
    if (!existingTypeSet.has(e.name)) {
      const valuesSql = e.values.map(qstr).join(", ");
      const stmt = `CREATE TYPE ${qid(e.name)} AS ENUM (${valuesSql})`;
      try {
        await execTypeDDL(stmt);
        applied.push(stmt);
      } catch (err) {
        logger.warn({ err, stmt }, "ensureSchema: failed to create enum type (continuing)");
        failures.push(`${e.name}: ${String((err as any)?.message ?? err).slice(0, 180)}`);
      }
      continue;
    }
    // Type exists — ensure every label is present (additive only).
    const have = labelsByType.get(e.name) ?? new Set<string>();
    for (const v of e.values) {
      if (!have.has(v)) {
        const stmt = `ALTER TYPE ${qid(e.name)} ADD VALUE IF NOT EXISTS ${qstr(v)}`;
        try {
          await execTypeDDL(stmt);
          applied.push(stmt);
        } catch (err) {
          logger.warn({ err, stmt }, "ensureSchema: failed to add enum value (continuing)");
          failures.push(`${e.name}.${v}: ${String((err as any)?.message ?? err).slice(0, 180)}`);
        }
      }
    }
  }

  if (options.strict) assertStrictSchemaReady({ failures });
  return applied;
}

async function ensureColumns(
  tables: { name: string; columns: ReturnType<typeof getTableConfig>["columns"] }[],
  options: {
    strict?: boolean;
    optionalMissingTables?: readonly string[];
    excludedColumns?: readonly string[];
  } = {},
): Promise<{ applied: string[]; missingTables: string[] }> {
  const applied: string[] = [];
  const missingTables: string[] = [];
  const failures: string[] = [];
  const excludedColumns = new Set(options.excludedColumns ?? []);

  // Snapshot which tables / columns currently exist in the public schema.
  const tableRows = (await db.execute<ExistingTable>(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `)).rows as ExistingTable[];
  const existingTables = new Set(tableRows.map((r) => r.table_name));

  const colRows = (await db.execute<ExistingColumn>(sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'
  `)).rows as ExistingColumn[];
  const existingColsByTable = new Map<string, Set<string>>();
  for (const row of colRows) {
    if (!existingColsByTable.has(row.table_name)) existingColsByTable.set(row.table_name, new Set());
    existingColsByTable.get(row.table_name)!.add(row.column_name);
  }

  for (const t of tables) {
    if (!existingTables.has(t.name)) {
      // Creating brand-new tables safely is non-trivial (constraints, FKs,
      // defaults, etc). Skip and surface a warning so an operator can run
      // the proper migration once. The vast majority of production drift
      // is "I added a column" — that path *is* handled.
      missingTables.push(t.name);
      continue;
    }
    const haveCols = existingColsByTable.get(t.name) ?? new Set<string>();
    for (const col of t.columns) {
      if (excludedColumns.has(`${t.name}.${col.name}`)) continue;
      if (haveCols.has(col.name)) continue;

      // Column type comes from drizzle's column.getSQLType() (e.g. "text",
      // "integer", "timestamp", "jsonb", "user_role"). For enum columns the
      // type *is* the enum type name and we already ensured it exists.
      const sqlType = col.getSQLType();

      // Build DEFAULT clause. drizzle stores `default` raw value or SQL.
      let defaultClause = "";
      if (col.default !== undefined && col.default !== null) {
        const def = col.default as unknown;
        if (typeof def === "string") defaultClause = ` DEFAULT ${qstr(def)}`;
        else if (typeof def === "number" || typeof def === "boolean") defaultClause = ` DEFAULT ${String(def)}`;
        else if (typeof def === "object" && def !== null && "queryChunks" in (def as object)) {
          // SQL object — render via drizzle (defaultNow(), sql\`...\`).
          // We can't easily inline; fall back to no default and let the app
          // handle it on insert.
          defaultClause = "";
        }
      } else if (col.defaultFn) {
        // Runtime-only default — handled by drizzle on insert.
        defaultClause = "";
      } else if ((col as unknown as { hasDefault?: boolean }).hasDefault) {
        defaultClause = "";
      }

      // Special-case the most common defaults that we know are SQL-generated.
      if (!defaultClause && (sqlType === "timestamp" || sqlType.startsWith("timestamp"))) {
        if ((col as unknown as { defaultNow?: boolean }).defaultNow) {
          defaultClause = " DEFAULT now()";
        }
      }

      // NOT NULL only when we can satisfy it for existing rows: either the
      // table is empty, or we have a default. Otherwise add the column as
      // nullable so the deploy doesn't crash mid-migration on legacy rows.
      let notNullClause = "";
      if (col.notNull && defaultClause) notNullClause = " NOT NULL";

      // ENUM types may need to be referenced by quoted name; getSQLType()
      // already returns the bare name. For pg_enum columns prefer the
      // explicit enum name from the column.
      let typeForSql = sqlType;
      if (col instanceof Object && (col as unknown as { enumValues?: unknown }).enumValues) {
        const enumName = (col as unknown as { enumName?: string; enum?: { enumName?: string } }).enumName
          ?? (col as unknown as { enum?: { enumName?: string } }).enum?.enumName;
        if (enumName) typeForSql = qid(enumName);
      } else if ((col as unknown) instanceof PgEnumColumn) {
        const e = (col as PgEnumColumn).enum as unknown as { enumName?: string };
        if (e?.enumName) typeForSql = qid(e.enumName);
      }

      const stmt = `ALTER TABLE ${qid(t.name)} ADD COLUMN IF NOT EXISTS ${qid(col.name)} ${typeForSql}${defaultClause}${notNullClause}`;
      try {
        await execDDL(stmt);
        applied.push(stmt);
      } catch (err) {
        logger.warn({ err, stmt }, "ensureSchema: failed to add column (continuing)");
        failures.push(`${t.name}.${col.name}: ${String((err as any)?.message ?? err).slice(0, 180)}`);
      }
    }
  }

  if (options.strict) {
    assertStrictSchemaReady({
      failures,
      missingTables,
      optionalMissingTables: options.optionalMissingTables,
    });
  }
  return { applied, missingTables };
}

/**
 * Reconcile the per-tenant identity model: usernames must be unique
 * PER company (not globally), the SuperAdmin keyspace (company_id IS NULL)
 * stays globally unique, and every company carries a public `code`
 * (e.g. ZTC-42) that the user types at login.
 *
 * Drizzle's pgTable doesn't yet have first-class partial-index support
 * we can rely on across schema-push, so we materialise the constraints
 * here as raw SQL. All statements are idempotent and additive — safe
 * to re-run on every boot.
 */
const PAYROLL_ALLOCATION_SCHEMA_STMTS: { label: string; sql: string }[] = [
  { label: "stock_ledger.source_line_id",
    sql: `ALTER TABLE stock_ledger ADD COLUMN IF NOT EXISTS source_line_id INTEGER` },
  { label: "packaging specification workflow tables",
    sql: `CREATE TABLE IF NOT EXISTS packaging_specifications (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      product_item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS packaging_specs_company_code_uniq
      ON packaging_specifications(company_id, code);
    CREATE INDEX IF NOT EXISTS packaging_specs_product_idx
      ON packaging_specifications(company_id, product_item_id);

    CREATE TABLE IF NOT EXISTS packaging_specification_versions (
      id SERIAL PRIMARY KEY,
      specification_id INTEGER NOT NULL REFERENCES packaging_specifications(id) ON DELETE CASCADE,
      version_no INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      effective_from DATE,
      effective_to DATE,
      primary_material TEXT,
      dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
      material_lines JSONB NOT NULL DEFAULT '[]'::jsonb,
      artwork_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
      notes TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS packaging_spec_versions_spec_no_uniq
      ON packaging_specification_versions(specification_id, version_no);
    CREATE INDEX IF NOT EXISTS packaging_spec_versions_status_idx
      ON packaging_specification_versions(specification_id, status);

    CREATE TABLE IF NOT EXISTS packaging_specification_approvals (
      id SERIAL PRIMARY KEY,
      version_id INTEGER NOT NULL REFERENCES packaging_specification_versions(id) ON DELETE CASCADE,
      decision TEXT NOT NULL,
      approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      notes TEXT,
      decided_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS packaging_spec_approvals_version_idx
      ON packaging_specification_approvals(version_id);

    CREATE TABLE IF NOT EXISTS packaging_specification_tests (
      id SERIAL PRIMARY KEY,
      version_id INTEGER NOT NULL REFERENCES packaging_specification_versions(id) ON DELETE CASCADE,
      test_type TEXT NOT NULL,
      lab_name TEXT,
      test_date DATE NOT NULL,
      result TEXT NOT NULL,
      report_reference TEXT,
      notes TEXT,
      tested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS packaging_spec_tests_version_idx
      ON packaging_specification_tests(version_id);` },
  { label: "packaging logistics, EPR, and guarded artwork metadata",
    sql: `ALTER TABLE packaging_specification_versions
      ADD COLUMN IF NOT EXISTS pallet_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS container_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS epr_declarations JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS artwork_archive_refs JSONB NOT NULL DEFAULT '[]'::jsonb` },
  { label: "sales_line_production_cost_attributions",
    sql: `CREATE TABLE IF NOT EXISTS sales_line_production_cost_attributions (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      document_type TEXT NOT NULL,
      document_id INTEGER NOT NULL,
      document_line_id INTEGER NOT NULL,
      movement_ledger_id INTEGER REFERENCES stock_ledger(id) ON DELETE RESTRICT,
      source_outbound_ledger_id INTEGER REFERENCES stock_ledger(id) ON DELETE RESTRICT,
      source_ledger_id INTEGER REFERENCES stock_ledger(id) ON DELETE RESTRICT,
      production_order_id INTEGER REFERENCES production_orders(id) ON DELETE RESTRICT,
      item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
      batch_number TEXT,
      quantity NUMERIC(18,4) NOT NULL,
      cost_price NUMERIC(18,6) NOT NULL DEFAULT '0',
      total_cost NUMERIC(18,4) NOT NULL DEFAULT '0',
      status TEXT NOT NULL,
      unavailable_reason TEXT,
      snapshot_key TEXT NOT NULL,
      source_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT sales_line_prod_cost_snapshot_uniq UNIQUE(company_id, snapshot_key)
    );
    CREATE INDEX IF NOT EXISTS sales_line_prod_cost_line_idx
      ON sales_line_production_cost_attributions(company_id, document_type, document_line_id);
    CREATE INDEX IF NOT EXISTS sales_line_prod_cost_source_idx
      ON sales_line_production_cost_attributions(company_id, source_ledger_id);
    CREATE OR REPLACE FUNCTION reject_sales_line_production_cost_mutation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'sales line production cost attributions are immutable'; END; $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS sales_line_prod_cost_no_mutation
      ON sales_line_production_cost_attributions;
    CREATE TRIGGER sales_line_prod_cost_no_mutation
      BEFORE UPDATE OR DELETE ON sales_line_production_cost_attributions
      FOR EACH ROW EXECUTE FUNCTION reject_sales_line_production_cost_mutation();` },
  { label: "companies.payroll_cost_basis",
    sql: `ALTER TABLE companies ADD COLUMN IF NOT EXISTS payroll_cost_basis TEXT NOT NULL DEFAULT 'gross'` },
  { label: "create employee_project_assignments table",
    sql: `CREATE TABLE IF NOT EXISTS employee_project_assignments (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      project_id INTEGER REFERENCES contracting_projects(id) ON DELETE RESTRICT,
      cost_center_id INTEGER REFERENCES cost_centers(id) ON DELETE RESTRICT,
      effective_from DATE NOT NULL,
      effective_to DATE,
      notes TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CHECK (effective_to IS NULL OR effective_to >= effective_from),
      CHECK (project_id IS NOT NULL OR cost_center_id IS NOT NULL)
    )` },
  { label: "employee_project_assignments_employee_period_idx",
    sql: `CREATE INDEX IF NOT EXISTS employee_project_assignments_employee_period_idx ON employee_project_assignments (company_id, employee_id, effective_from, effective_to)` },
  { label: "create payroll_allocation_snapshots table",
    sql: `CREATE TABLE IF NOT EXISTS payroll_allocation_snapshots (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      payroll_run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
      payroll_line_id INTEGER NOT NULL REFERENCES payroll_lines(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      project_id INTEGER REFERENCES contracting_projects(id) ON DELETE RESTRICT,
      cost_center_id INTEGER REFERENCES cost_centers(id) ON DELETE RESTRICT,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      days INTEGER NOT NULL CHECK (days > 0),
      cost_basis TEXT NOT NULL DEFAULT 'gross',
      basis_amount NUMERIC(12,2) NOT NULL,
      allocated_amount NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )` },
  { label: "payroll_allocation_snapshots_run_idx",
    sql: `CREATE INDEX IF NOT EXISTS payroll_allocation_snapshots_run_idx ON payroll_allocation_snapshots (company_id, payroll_run_id, employee_id)` },
  { label: "payroll_allocation_snapshots_immutable",
    sql: `CREATE OR REPLACE FUNCTION reject_payroll_allocation_snapshot_update() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'payroll allocation snapshots are immutable'; END; $$ LANGUAGE plpgsql;
           DROP TRIGGER IF EXISTS payroll_allocation_snapshots_no_update ON payroll_allocation_snapshots;
           CREATE TRIGGER payroll_allocation_snapshots_no_update BEFORE UPDATE ON payroll_allocation_snapshots FOR EACH ROW EXECUTE FUNCTION reject_payroll_allocation_snapshot_update()` },
  { label: "production_cost_allocations",
    sql: `CREATE TABLE IF NOT EXISTS production_cost_allocations (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      order_id INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE RESTRICT,
      source_type TEXT NOT NULL,
      source_record_id INTEGER NOT NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      basis TEXT NOT NULL,
      source_amount NUMERIC(18,2) NOT NULL,
      share_pct NUMERIC(9,6) NOT NULL CHECK (share_pct >= 0 AND share_pct <= 100),
      allocated_amount NUMERIC(18,2) NOT NULL CHECK (allocated_amount >= 0),
      snapshot_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT prod_cost_alloc_order_source_uniq UNIQUE(order_id, source_type, source_record_id)
    );
    CREATE INDEX IF NOT EXISTS prod_cost_alloc_source_idx ON production_cost_allocations(company_id, source_type, source_record_id);
    CREATE OR REPLACE FUNCTION reject_production_cost_allocation_mutation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'production cost allocation snapshots are immutable'; END; $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS production_cost_allocations_no_mutation ON production_cost_allocations;
    CREATE TRIGGER production_cost_allocations_no_mutation BEFORE UPDATE OR DELETE ON production_cost_allocations
      FOR EACH ROW EXECUTE FUNCTION reject_production_cost_allocation_mutation();
    ALTER TABLE production_cost_allocations DROP CONSTRAINT IF EXISTS production_cost_allocations_share_pct_check;
    ALTER TABLE production_cost_allocations ADD CONSTRAINT production_cost_allocations_share_pct_check
      CHECK (share_pct >= 0 AND share_pct <= 100);` },
  // Frozen calculation evidence only. This deliberately has no journal entry:
  // the linked payroll/asset source allocation owns capitalization and its
  // delta/reversal lifecycle.
  { label: "production_stage_resource_costs",
    sql: `CREATE TABLE IF NOT EXISTS production_stage_resource_costs (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      order_id INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE RESTRICT,
      stage_id INTEGER NOT NULL REFERENCES production_order_stages(id) ON DELETE RESTRICT,
      component TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_record_id INTEGER NOT NULL,
      amount NUMERIC(18,2) NOT NULL,
      snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS prod_stage_resource_cost_component_source_uniq
      ON production_stage_resource_costs(stage_id, component, source_type, source_record_id);
    CREATE INDEX IF NOT EXISTS prod_stage_resource_cost_order_idx
      ON production_stage_resource_costs(company_id, order_id);
    CREATE INDEX IF NOT EXISTS prod_stage_resource_cost_source_idx
      ON production_stage_resource_costs(company_id, source_type, source_record_id);
    CREATE OR REPLACE FUNCTION reject_production_stage_resource_cost_mutation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'production stage resource cost snapshots are immutable'; END; $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS production_stage_resource_costs_no_mutation ON production_stage_resource_costs;
    CREATE TRIGGER production_stage_resource_costs_no_mutation
      BEFORE UPDATE OR DELETE ON production_stage_resource_costs
      FOR EACH ROW EXECUTE FUNCTION reject_production_stage_resource_cost_mutation();` },
  // Order-stage execution fields are additive snapshots. They intentionally
  // carry no currency amount: elapsed time is a driver consumed by approved
  // source allocations, not a second stage-expense engine.
  { label: "production_order_stages execution facts",
    sql: `ALTER TABLE production_order_stages ADD COLUMN IF NOT EXISTS actual_duration_minutes INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE production_order_stages ADD COLUMN IF NOT EXISTS worker_count INTEGER;
          ALTER TABLE production_order_stages ADD COLUMN IF NOT EXISTS resource_id INTEGER REFERENCES production_resources(id) ON DELETE SET NULL;
          ALTER TABLE production_order_stages ADD COLUMN IF NOT EXISTS waste_reason TEXT;
          ALTER TABLE production_order_stages ADD COLUMN IF NOT EXISTS waste_type TEXT;
          ALTER TABLE production_order_stages ADD COLUMN IF NOT EXISTS waste_classification TEXT;
          ALTER TABLE production_order_stages ADD COLUMN IF NOT EXISTS quantity_unit TEXT;
          ALTER TABLE production_order_stages ADD COLUMN IF NOT EXISTS quantity_unit_factor NUMERIC(14,8) NOT NULL DEFAULT 1;
          ALTER TABLE production_order_stages ADD COLUMN IF NOT EXISTS waste_unit TEXT;
          ALTER TABLE production_order_stages ADD COLUMN IF NOT EXISTS waste_unit_factor NUMERIC(14,8) NOT NULL DEFAULT 1` },
  // Resource-costing v1 is deliberately additive.  Runtime schema repair is
  // required for tenant databases that pre-date the generated schema fields.
  { label: "production resource costing v1 fields",
    sql: `ALTER TABLE production_resources ADD COLUMN IF NOT EXISTS fixed_asset_id INTEGER REFERENCES fixed_assets(id) ON DELETE SET NULL;
          ALTER TABLE production_resources ADD COLUMN IF NOT EXISTS electricity_enabled BOOLEAN NOT NULL DEFAULT false;
          ALTER TABLE production_resources ADD COLUMN IF NOT EXISTS electricity_kw NUMERIC(14,4);
          ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS resource_costing_version INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE manufacturing_settings ADD COLUMN IF NOT EXISTS electricity_tariff_per_kwh NUMERIC(14,6) NOT NULL DEFAULT 0` },
  { label: "production_waste_records classification",
    sql: `ALTER TABLE production_waste_records ADD COLUMN IF NOT EXISTS waste_classification TEXT NOT NULL DEFAULT 'normal';
          ALTER TABLE production_waste_records ADD COLUMN IF NOT EXISTS unit_factor NUMERIC(14,8) NOT NULL DEFAULT 1` },
  { label: "production overhead closure workflow",
    sql: `CREATE TABLE IF NOT EXISTS production_overhead_closures (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      correction_date DATE NOT NULL,
      source_key TEXT NOT NULL,
      variance_account_id INTEGER NOT NULL REFERENCES accounts(id),
      status TEXT NOT NULL DEFAULT 'draft',
      journal_entry_id INTEGER,
      reversal_journal_entry_id INTEGER,
      actual_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
      applied_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
      variance_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
      source_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      posted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      posted_at TIMESTAMP,
      reversed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reversed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS production_overhead_closures_source_key_uniq
      ON production_overhead_closures(company_id, source_key);
    CREATE INDEX IF NOT EXISTS production_overhead_closures_period_idx
      ON production_overhead_closures(company_id, period_start, period_end);
    CREATE OR REPLACE FUNCTION reject_production_overhead_closure_snapshot_mutation() RETURNS trigger AS $$
    BEGIN
      IF NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot
         OR NEW.actual_amount IS DISTINCT FROM OLD.actual_amount
         OR NEW.applied_amount IS DISTINCT FROM OLD.applied_amount
         OR NEW.variance_amount IS DISTINCT FROM OLD.variance_amount
         OR NEW.source_key IS DISTINCT FROM OLD.source_key
         OR NEW.period_start IS DISTINCT FROM OLD.period_start
         OR NEW.period_end IS DISTINCT FROM OLD.period_end
      THEN RAISE EXCEPTION 'production overhead closure snapshot is immutable'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS production_overhead_closures_snapshot_no_mutation
      ON production_overhead_closures;
    CREATE TRIGGER production_overhead_closures_snapshot_no_mutation
      BEFORE UPDATE ON production_overhead_closures
      FOR EACH ROW EXECUTE FUNCTION reject_production_overhead_closure_snapshot_mutation();` },
  { label: "production_pending_utility_claims",
    sql: `CREATE TABLE IF NOT EXISTS production_pending_utility_claims (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      closure_id INTEGER NOT NULL REFERENCES production_overhead_closures(id) ON DELETE CASCADE,
      stage_resource_cost_id INTEGER NOT NULL REFERENCES production_stage_resource_costs(id) ON DELETE CASCADE,
      order_id INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      source_record_id INTEGER NOT NULL,
      allocated_amount NUMERIC(18,2) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS prod_pending_utility_claim_stage_uniq
      ON production_pending_utility_claims(stage_resource_cost_id);
    CREATE INDEX IF NOT EXISTS prod_pending_utility_claim_closure_idx
      ON production_pending_utility_claims(company_id, closure_id);` },
  { label: "production actual driver reconciliation ledger",
    sql: `CREATE TABLE IF NOT EXISTS production_driver_reconciliations (
      id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      order_id INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE RESTRICT,
      source_type TEXT NOT NULL, source_record_id INTEGER NOT NULL,
      base_allocation_id INTEGER NOT NULL REFERENCES production_cost_allocations(id) ON DELETE RESTRICT,
      period_start DATE NOT NULL, period_end DATE NOT NULL, driver_method TEXT NOT NULL,
      planned_numerator NUMERIC(18,4) NOT NULL, actual_numerator NUMERIC(18,4) NOT NULL,
      denominator_or_rate NUMERIC(18,4) NOT NULL, source_amount NUMERIC(18,2) NOT NULL,
      base_allocated_amount NUMERIC(18,2) NOT NULL, reconciled_amount NUMERIC(18,2) NOT NULL,
      delta_amount NUMERIC(18,2) NOT NULL, journal_entry_id INTEGER, reversal_journal_entry_id INTEGER,
      snapshot_meta JSONB NOT NULL DEFAULT '{}'::jsonb, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS prod_driver_reconcile_order_source_uniq
      ON production_driver_reconciliations(order_id, source_type, source_record_id);
    CREATE INDEX IF NOT EXISTS prod_driver_reconcile_source_idx
      ON production_driver_reconciliations(company_id, source_type, source_record_id);` },
  { label: "production overhead closure reopen trace",
    sql: `ALTER TABLE production_overhead_closures
      ADD COLUMN IF NOT EXISTS reopened_journal_entry_id INTEGER` },
  { label: "production commercial accrual workflow",
    sql: `CREATE TABLE IF NOT EXISTS production_commercial_accruals (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      order_id INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE RESTRICT,
      branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
      lifecycle_id TEXT NOT NULL,
      obligation_type TEXT NOT NULL,
      recognition_mode TEXT NOT NULL,
      source_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      posting_date DATE NOT NULL,
      amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
      basis_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
      expense_account_id INTEGER REFERENCES accounts(id),
      liability_account_id INTEGER NOT NULL REFERENCES accounts(id),
      supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
      technician_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      provision_accrual_id INTEGER,
      settlement_id INTEGER,
      journal_entry_id INTEGER,
      reversal_journal_entry_id INTEGER,
      source_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      posted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      posted_at TIMESTAMP,
      reversed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reversed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS production_commercial_accruals_source_key_uniq
      ON production_commercial_accruals(company_id, source_key);
    CREATE INDEX IF NOT EXISTS production_commercial_accruals_order_lifecycle_idx
      ON production_commercial_accruals(company_id, order_id, lifecycle_id);
    CREATE INDEX IF NOT EXISTS production_commercial_accruals_provision_idx
      ON production_commercial_accruals(company_id, provision_accrual_id);
    CREATE OR REPLACE FUNCTION reject_production_commercial_accrual_basis_mutation()
    RETURNS trigger AS $$
    BEGIN
      IF NEW.company_id IS DISTINCT FROM OLD.company_id
         OR NEW.order_id IS DISTINCT FROM OLD.order_id
         OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
         OR NEW.lifecycle_id IS DISTINCT FROM OLD.lifecycle_id
         OR NEW.obligation_type IS DISTINCT FROM OLD.obligation_type
         OR NEW.recognition_mode IS DISTINCT FROM OLD.recognition_mode
         OR NEW.source_key IS DISTINCT FROM OLD.source_key
         OR NEW.posting_date IS DISTINCT FROM OLD.posting_date
         OR NEW.amount IS DISTINCT FROM OLD.amount
         OR NEW.basis_amount IS DISTINCT FROM OLD.basis_amount
         OR NEW.expense_account_id IS DISTINCT FROM OLD.expense_account_id
         OR NEW.liability_account_id IS DISTINCT FROM OLD.liability_account_id
         OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
         OR NEW.technician_user_id IS DISTINCT FROM OLD.technician_user_id
         OR NEW.provision_accrual_id IS DISTINCT FROM OLD.provision_accrual_id
         OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot
      THEN RAISE EXCEPTION 'production commercial accrual basis is immutable'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS production_commercial_accruals_basis_no_mutation
      ON production_commercial_accruals;
    CREATE TRIGGER production_commercial_accruals_basis_no_mutation
      BEFORE UPDATE ON production_commercial_accruals
      FOR EACH ROW EXECUTE FUNCTION reject_production_commercial_accrual_basis_mutation();` },
  { label: "production wizard retry key",
    sql: `ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS wizard_request_id TEXT;
          CREATE UNIQUE INDEX IF NOT EXISTS prod_orders_wizard_request_uniq
            ON production_orders(company_id, wizard_request_id) WHERE wizard_request_id IS NOT NULL;` },
  { label: "production wizard templates",
    sql: `CREATE TABLE IF NOT EXISTS production_wizard_templates (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS prod_wizard_templates_company_idx
      ON production_wizard_templates(company_id, is_active);` },
  { label: "manufacturing source eligibility configuration",
    sql: `ALTER TABLE payroll_runs
            ADD COLUMN IF NOT EXISTS manufacturing_eligible BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS manufacturing_allocation_method TEXT NOT NULL DEFAULT 'none',
            ADD COLUMN IF NOT EXISTS approved_manufacturing_hours NUMERIC(14,4);
          ALTER TABLE accounting_adjustments
            ADD COLUMN IF NOT EXISTS manufacturing_eligible BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS manufacturing_allocation_method TEXT NOT NULL DEFAULT 'none',
            ADD COLUMN IF NOT EXISTS approved_production_quantity NUMERIC(14,4);` },
];

async function ensurePayrollAllocationSchema(options: { strict?: boolean } = {}): Promise<string[]> {
  const applied: string[] = [];
  const failures: string[] = [];
  for (const { label, sql: stmt } of PAYROLL_ALLOCATION_SCHEMA_STMTS) {
    try {
      await execDDL(stmt);
      applied.push(label);
    } catch (err) {
      logger.warn({ err, label, stmt }, "ensureSchema: payroll-allocation step failed");
      failures.push(`${label}: ${String((err as any)?.message ?? err).slice(0, 180)}`);
    }
  }
  if (options.strict) assertStrictSchemaReady({ failures });
  return applied;
}

async function ensureTenantIdentityIndexes(): Promise<string[]> {
  const applied: string[] = [];
  const stmts: { label: string; sql: string }[] = [
    { label: "users.demo_device_isolation",
      sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS demo_device_isolation BOOLEAN NOT NULL DEFAULT FALSE` },
    { label: "users.is_demo_shadow",
      sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo_shadow BOOLEAN NOT NULL DEFAULT FALSE` },
    { label: "companies.is_internal_demo_workspace",
      sql: `ALTER TABLE companies ADD COLUMN IF NOT EXISTS is_internal_demo_workspace BOOLEAN NOT NULL DEFAULT FALSE` },
    { label: "companies.demo_parent_company_id",
      sql: `ALTER TABLE companies ADD COLUMN IF NOT EXISTS demo_parent_company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE` },
    { label: "create demo_device_workspaces table",
      sql: `CREATE TABLE IF NOT EXISTS demo_device_workspaces (
        id SERIAL PRIMARY KEY,
        source_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        workspace_company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
        workspace_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        phone VARCHAR(32),
        device_token_hash VARCHAR(64) NOT NULL,
        device_label VARCHAR(180),
        user_agent TEXT,
        first_ip VARCHAR(64),
        last_ip VARCHAR(64),
        is_primary BOOLEAN NOT NULL DEFAULT FALSE,
        status VARCHAR(24) NOT NULL DEFAULT 'provisioning',
        revoked_at TIMESTAMPTZ,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
    { label: "demo_device_workspaces.phone",
      sql: `ALTER TABLE demo_device_workspaces ADD COLUMN IF NOT EXISTS phone VARCHAR(32)` },
    { label: "demo_device_workspaces_source_device_uq",
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS demo_device_workspaces_source_device_uq ON demo_device_workspaces(source_user_id, device_token_hash)` },
    { label: "demo_device_workspaces_source_idx",
      sql: `CREATE INDEX IF NOT EXISTS demo_device_workspaces_source_idx ON demo_device_workspaces(source_user_id)` },
    { label: "demo_device_workspaces_source_phone_idx",
      sql: `CREATE INDEX IF NOT EXISTS demo_device_workspaces_source_phone_idx ON demo_device_workspaces(source_user_id, phone)` },
    { label: "demo_device_workspaces_company_idx",
      sql: `CREATE INDEX IF NOT EXISTS demo_device_workspaces_company_idx ON demo_device_workspaces(workspace_company_id)` },
    { label: "create demo_device_pair_codes table",
      sql: `CREATE TABLE IF NOT EXISTS demo_device_pair_codes (
        id SERIAL PRIMARY KEY,
        source_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        created_by_device_id INTEGER NOT NULL REFERENCES demo_device_workspaces(id) ON DELETE CASCADE,
        code_hash VARCHAR(64) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
    { label: "demo_device_pair_codes_hash_uq",
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS demo_device_pair_codes_hash_uq ON demo_device_pair_codes(code_hash)` },
    { label: "demo_device_pair_codes_source_idx",
      sql: `CREATE INDEX IF NOT EXISTS demo_device_pair_codes_source_idx ON demo_device_pair_codes(source_user_id)` },
    // Create the replacement partial-unique indexes BEFORE dropping the legacy
    // global constraint, so users.username uniqueness is NEVER absent — even if a
    // later step is skipped by lock_timeout or the boot budget opens the port
    // mid-reconciliation. All statements are idempotent (IF NOT EXISTS / IF
    // EXISTS), so ordering only affects the transient window, not the end state.
    // Tenant users: (company_id, username) is unique per company.
    { label: "users_company_username_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS users_company_username_uniq ON users (company_id, username) WHERE company_id IS NOT NULL` },
    // SuperAdmins (company_id IS NULL): username stays globally unique.
    { label: "users_username_superadmin_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS users_username_superadmin_uniq ON users (username) WHERE company_id IS NULL` },
    // Now that the partial indexes enforce uniqueness, drop the legacy
    // global-unique on users.username if it survived.
    { label: "drop legacy users_username_unique", sql: `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_unique` },
    { label: "drop legacy users_username_key",    sql: `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key` },
    // companies.code is unique whenever populated.
    { label: "companies_code_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS companies_code_uniq ON companies (code) WHERE code IS NOT NULL` },
    { label: "supplier bulk account code reservation guard",
      sql: SUPPLIER_BULK_ACCOUNT_CODE_GUARD_DDL },
    // ─── Sales-rep ↔ user 1:1 link (per company). Partial unique so reps without
    // a login (external/freelancer) are allowed (user_id NULL). Same user can
    // never be linked to two reps in the same company.
    { label: "sales_reps_user_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS sales_reps_user_uniq ON sales_reps (company_id, user_id) WHERE user_id IS NOT NULL` },
    { label: "sales_reps_user_idx",
      sql:   `CREATE INDEX IF NOT EXISTS sales_reps_user_idx ON sales_reps (user_id) WHERE user_id IS NOT NULL` },
    // Backfill: any legacy company without a code gets ZTC-{id}.
    { label: "backfill companies.code",
      sql:   `UPDATE companies SET code = 'ZTC-' || id WHERE code IS NULL` },
    // ─── Trainee registration (طلبات المتدربين). Additive module: public
    // trainee sign-up requests reviewed/approved by SuperAdmin. Drizzle's
    // ensureColumns only ALTERs existing tables, never CREATEs, so the
    // table is materialised here. Idempotent — safe on every boot.
    { label: "create trainee_requests table",
      sql:   `CREATE TABLE IF NOT EXISTS trainee_requests (
        id                SERIAL PRIMARY KEY,
        full_name         TEXT    NOT NULL,
        email             TEXT    NOT NULL,
        phone             TEXT    NOT NULL,
        phone_country_key TEXT    NOT NULL,
        country           TEXT    NOT NULL,
        city              TEXT,
        company_name      TEXT,
        job_title         TEXT    NOT NULL,
        industry          TEXT    NOT NULL,
        experience_years  INTEGER NOT NULL DEFAULT 0,
        password_hash     TEXT    NOT NULL,
        terms_accepted    BOOLEAN NOT NULL DEFAULT FALSE,
        status            TEXT    NOT NULL DEFAULT 'pending',
        decided_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
        decided_at        TIMESTAMP,
        reject_reason     TEXT,
        duration_days     INTEGER,
        env_mode          TEXT,
        company_id        INTEGER REFERENCES companies(id) ON DELETE SET NULL,
        allowed_modules   JSONB,
        user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
        activation_email_sent_at TIMESTAMP,
        created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    // One live (pending/approved) request per email — rejected requests may
    // re-apply, so the guard is partial.
    { label: "trainee_requests_email_live_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS trainee_requests_email_live_uniq
              ON trainee_requests (lower(email)) WHERE status IN ('pending','approved')` },
    // users.is_trainee — flag consumed by the /auth/login no-companyCode
    // fallback. ensureColumns would add it too (users already exists), but
    // the explicit ALTER keeps the boot deterministic even if that pass is
    // budget-skipped.
    { label: "users.is_trainee column",
      sql:   `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_trainee BOOLEAN NOT NULL DEFAULT FALSE` },
    // Per-user POST/UNPOST rights map (صلاحيات الترحيل وفك الترحيل) — NULL
    // means "all allowed" (back-compat). See api-server lib/postingRights.ts.
    { label: "users.posting_permissions column",
      sql:   `ALTER TABLE users ADD COLUMN IF NOT EXISTS posting_permissions JSONB` },
    // Per-user mobile-app rights map (صلاحيات تطبيق الموبايل) — NULL means
    // "all allowed" (back-compat). See api-server lib/mobilePerms.ts.
    { label: "users.mobile_permissions column",
      sql:   `ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_permissions JSONB` },
    { label: "users.session_channel column",
      sql:   `ALTER TABLE users ADD COLUMN IF NOT EXISTS session_channel TEXT` },
    // Per-type HR expiry-alert lead times (days) — {iqama,contract,passport,workPermit}.
    // ─── HR Core extension (دورة حياة الموظف) — see lib/db/src/schema/hr.ts.
    // ensureColumns only ALTERs existing tables, so materialise them here.
    { label: "create hr_departments table",
      sql: `CREATE TABLE IF NOT EXISTS hr_departments (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        name TEXT NOT NULL,
        parent_id INTEGER,
        manager_employee_id INTEGER REFERENCES employees(id),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "create hr_positions table",
      sql: `CREATE TABLE IF NOT EXISTS hr_positions (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        title TEXT NOT NULL,
        department_id INTEGER REFERENCES hr_departments(id),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "create employee_salary_adjustments table",
      sql: `CREATE TABLE IF NOT EXISTS employee_salary_adjustments (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        adjustment_date DATE NOT NULL,
        effective_date DATE NOT NULL,
        prev_basic NUMERIC(12,2) NOT NULL DEFAULT '0',
        new_basic NUMERIC(12,2) NOT NULL DEFAULT '0',
        prev_total NUMERIC(12,2) NOT NULL DEFAULT '0',
        new_total NUMERIC(12,2) NOT NULL DEFAULT '0',
        amount NUMERIC(12,2) NOT NULL DEFAULT '0',
        percent NUMERIC(7,3) NOT NULL DEFAULT '0',
        new_housing NUMERIC(12,2),
        new_transport NUMERIC(12,2),
        new_other NUMERIC(12,2),
        reason TEXT,
        decision_ref TEXT,
        status TEXT NOT NULL DEFAULT 'applied',
        notes TEXT,
        created_by INTEGER,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "employee_salary_adjustments_emp_idx",
      sql: `CREATE INDEX IF NOT EXISTS employee_salary_adjustments_emp_idx ON employee_salary_adjustments (company_id, employee_id)` },
    { label: "create employee_transfers table",
      sql: `CREATE TABLE IF NOT EXISTS employee_transfers (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        move_type TEXT NOT NULL,
        prev_value TEXT,
        new_value TEXT,
        decision_date DATE,
        effective_from DATE NOT NULL,
        effective_to DATE,
        is_temporary BOOLEAN NOT NULL DEFAULT FALSE,
        reason TEXT,
        approved_by TEXT,
        status TEXT NOT NULL DEFAULT 'applied',
        notes TEXT,
        created_by INTEGER,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "employee_transfers_emp_idx",
      sql: `CREATE INDEX IF NOT EXISTS employee_transfers_emp_idx ON employee_transfers (company_id, employee_id)` },
    { label: "create employee_evaluations table",
      sql: `CREATE TABLE IF NOT EXISTS employee_evaluations (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        period_from DATE,
        period_to DATE,
        evaluator TEXT,
        eval_date DATE NOT NULL,
        score NUMERIC(6,2),
        max_score NUMERIC(6,2) DEFAULT '100',
        result TEXT,
        strengths TEXT,
        weaknesses TEXT,
        recommendations TEXT,
        next_eval_date DATE,
        notes TEXT,
        created_by INTEGER,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "employee_evaluations_emp_idx",
      sql: `CREATE INDEX IF NOT EXISTS employee_evaluations_emp_idx ON employee_evaluations (company_id, employee_id)` },
    { label: "create employee_emergency_contacts table",
      sql: `CREATE TABLE IF NOT EXISTS employee_emergency_contacts (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        relation TEXT,
        phone TEXT,
        phone2 TEXT,
        address TEXT,
        email TEXT,
        is_primary BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "create employee_dependents table",
      sql: `CREATE TABLE IF NOT EXISTS employee_dependents (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        relation TEXT,
        birth_date DATE,
        gender TEXT,
        id_number TEXT,
        benefits_eligible BOOLEAN NOT NULL DEFAULT FALSE,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "create employee_qualifications table",
      sql: `CREATE TABLE IF NOT EXISTS employee_qualifications (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        degree TEXT NOT NULL,
        specialty TEXT,
        institution TEXT,
        grad_year TEXT,
        grade TEXT,
        attachment_url TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "create employee_certificates table",
      sql: `CREATE TABLE IF NOT EXISTS employee_certificates (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        issuer TEXT,
        cert_number TEXT,
        issue_date DATE,
        expiry_date DATE,
        attachment_url TEXT,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "create employee_medical_insurance_policies table",
      sql: `CREATE TABLE IF NOT EXISTS employee_medical_insurance_policies (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        policy_number TEXT NOT NULL,
        insurance_company TEXT NOT NULL,
        coverage_details TEXT,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "employee_medical_insurance_policies_company_employee_idx",
      sql: `CREATE INDEX IF NOT EXISTS employee_medical_insurance_policies_company_employee_idx
            ON employee_medical_insurance_policies (company_id, employee_id)` },
    { label: "create employee_documents table",
      sql: `CREATE TABLE IF NOT EXISTS employee_documents (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        doc_type TEXT NOT NULL,
        doc_number TEXT,
        issue_date DATE,
        expiry_date DATE,
        file_url TEXT,
        notes TEXT,
        created_by INTEGER,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "employee_documents_emp_idx",
      sql: `CREATE INDEX IF NOT EXISTS employee_documents_emp_idx ON employee_documents (company_id, employee_id)` },
    { label: "create employee_history table",
      sql: `CREATE TABLE IF NOT EXISTS employee_history (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        event_date DATE NOT NULL,
        prev_value TEXT,
        new_value TEXT,
        reason TEXT,
        ref_table TEXT,
        ref_id INTEGER,
        user_id INTEGER,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "employee_history_emp_idx",
      sql: `CREATE INDEX IF NOT EXISTS employee_history_emp_idx ON employee_history (company_id, employee_id, event_date DESC)` },
    { label: "create employee_terminations table",
      sql: `CREATE TABLE IF NOT EXISTS employee_terminations (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        termination_type TEXT NOT NULL,
        reason TEXT,
        last_work_day DATE NOT NULL,
        settlement_done BOOLEAN NOT NULL DEFAULT FALSE,
        custody_returned BOOLEAN NOT NULL DEFAULT FALSE,
        access_closed BOOLEAN NOT NULL DEFAULT FALSE,
        documents_url TEXT,
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_by INTEGER,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "companies.hr_alert_thresholds column",
      sql:   `ALTER TABLE companies ADD COLUMN IF NOT EXISTS hr_alert_thresholds JSONB` },
    { label: "payroll_runs.payment_journal_id column",
      sql:   `ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS payment_journal_id INTEGER` },
    // ─── HR extras: asset custody (عهدة عينية), violations, travel exit/return.
    // See lib/db/src/schema/hr.ts. ensureColumns only ALTERs existing tables.
    { label: "create asset_custodies table",
      sql: `CREATE TABLE IF NOT EXISTS asset_custodies (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        asset_id INTEGER NOT NULL,
        delivery_date DATE NOT NULL,
        expected_return_date DATE,
        actual_return_date DATE,
        status TEXT NOT NULL DEFAULT 'delivered',
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "asset_custodies_emp_idx",
      sql: `CREATE INDEX IF NOT EXISTS asset_custodies_emp_idx ON asset_custodies (company_id, employee_id)` },
    { label: "asset_custodies_asset_idx",
      sql: `CREATE INDEX IF NOT EXISTS asset_custodies_asset_idx ON asset_custodies (company_id, asset_id)` },
    // Only ONE live custody per asset at a time.
    { label: "asset_custodies_live_uniq",
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS asset_custodies_live_uniq ON asset_custodies (asset_id) WHERE status = 'delivered'` },
    { label: "create employee_violations table",
      sql: `CREATE TABLE IF NOT EXISTS employee_violations (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        violation_type TEXT NOT NULL,
        violation_date DATE NOT NULL,
        reason TEXT,
        amount NUMERIC(12,2) NOT NULL DEFAULT '0',
        deduct_from_salary BOOLEAN NOT NULL DEFAULT FALSE,
        payroll_run_id INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "employee_violations_emp_idx",
      sql: `CREATE INDEX IF NOT EXISTS employee_violations_emp_idx ON employee_violations (company_id, employee_id)` },
    { label: "create employee_travels table",
      sql: `CREATE TABLE IF NOT EXISTS employee_travels (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        exit_date DATE NOT NULL,
        exit_time TEXT,
        expected_return_date DATE,
        expected_return_time TEXT,
        actual_return_date DATE,
        actual_return_time TEXT,
        status TEXT NOT NULL DEFAULT 'out',
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "employee_travels_emp_idx",
      sql: `CREATE INDEX IF NOT EXISTS employee_travels_emp_idx ON employee_travels (company_id, employee_id)` },
    // "الطريقة العالمية" — unified JE counter with per-source prefixes; flag
    // lives on the sequence bound to journal_entry. See lib/sequences.ts.
    { label: "sequences.apply_source_prefixes column",
      sql:   `ALTER TABLE sequences ADD COLUMN IF NOT EXISTS apply_source_prefixes BOOLEAN NOT NULL DEFAULT FALSE` },
    // Trainee usernames (emails) must be globally unique so the code-less
    // login can resolve the tenant unambiguously.
    { label: "users_trainee_username_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS users_trainee_username_uniq
              ON users (lower(username)) WHERE is_trainee = TRUE` },
    // ─── approval_log: append-only audit trail for the document approval
    // workflow (see lib/db/src/schema/approvalLog.ts). Drizzle's ensureColumns
    // only ALTERs existing tables, never CREATEs new ones, so we materialise
    // the table here. Idempotent — safe to re-run on every boot.
    { label: "create approval_log table",
      sql:   `CREATE TABLE IF NOT EXISTS approval_log (
        id            SERIAL PRIMARY KEY,
        company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        document_type TEXT    NOT NULL,
        document_id   INTEGER NOT NULL,
        user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action        TEXT    NOT NULL,
        level         INTEGER NOT NULL DEFAULT 0,
        amount        NUMERIC(18,2) NOT NULL DEFAULT '0',
        from_status   TEXT,
        to_status     TEXT,
        comment       TEXT,
        created_at    TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "approval_log_doc_idx",
      sql:   `CREATE INDEX IF NOT EXISTS approval_log_doc_idx ON approval_log (company_id, document_type, document_id)` },
    { label: "approval_log_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS approval_log_company_idx ON approval_log (company_id, created_at)` },
    // ─── Journal-entries list performance. The JE list screen (and the
    // Posting Center built on it) filters by company and orders by
    // created_at DESC; the per-entry debit/credit totals aggregate lines by
    // entry_id. Neither column had an index, so data-heavy companies caused
    // full-table scans on every list load → severe slowness on
    // /accounting/journals. Idempotent, safe on every boot.
    { label: "journal_entries_company_created_idx",
      sql:   `CREATE INDEX IF NOT EXISTS journal_entries_company_created_idx ON journal_entries (company_id, created_at DESC)` },
    { label: "journal_entries_company_branch_created_idx",
      sql:   `CREATE INDEX IF NOT EXISTS journal_entries_company_branch_created_idx ON journal_entries (company_id, branch_id, created_at DESC)` },
    { label: "journal_entries_company_status_date_idx",
      sql:   `CREATE INDEX IF NOT EXISTS journal_entries_company_status_date_idx ON journal_entries (company_id, status, entry_date)` },
    { label: "journal_entries_company_date_idx",
      sql:   `CREATE INDEX IF NOT EXISTS journal_entries_company_date_idx ON journal_entries (company_id, entry_date)` },
    { label: "journal_entry_lines_entry_idx",
      sql:   `CREATE INDEX IF NOT EXISTS journal_entry_lines_entry_idx ON journal_entry_lines (entry_id)` },
    // ─── Partial settlement links (سداد جزئي — قيود وسندات ↔ فواتير) ─────────
    // Additive to the legacy header links; see schema/journalEntries.ts.
    { label: "settlement_links table",
      sql:   `CREATE TABLE IF NOT EXISTS settlement_links (
                id SERIAL PRIMARY KEY,
                company_id INTEGER NOT NULL,
                source_type TEXT NOT NULL,
                source_id INTEGER NOT NULL,
                sales_invoice_id INTEGER,
                purchase_invoice_id INTEGER,
                amount NUMERIC(18,2) NOT NULL,
                created_by INTEGER,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
              )` },
    { label: "settlement_links source idx",
      sql:   `CREATE INDEX IF NOT EXISTS settlement_links_source_idx ON settlement_links (company_id, source_type, source_id)` },
    { label: "settlement_links sales inv idx",
      sql:   `CREATE INDEX IF NOT EXISTS settlement_links_sales_idx ON settlement_links (company_id, sales_invoice_id)` },
    { label: "settlement_links purchase inv idx",
      sql:   `CREATE INDEX IF NOT EXISTS settlement_links_purchase_idx ON settlement_links (company_id, purchase_invoice_id)` },
    // ─── Voucher allocation lines (multi-allocation model, see schema/cash.ts).
    // Created here because ensureColumns only ALTERs existing tables. Legacy
    // single-`amount` vouchers keep posting without any line rows. Idempotent.
    { label: "create receipt_voucher_lines table",
      sql:   `CREATE TABLE IF NOT EXISTS receipt_voucher_lines (
        id               SERIAL PRIMARY KEY,
        voucher_id       INTEGER NOT NULL REFERENCES receipt_vouchers(id) ON DELETE CASCADE,
        account_id       INTEGER REFERENCES accounts(id),
        description      TEXT,
        amount           NUMERIC(15,2) NOT NULL DEFAULT '0',
        cost_center      TEXT,
        branch_id        INTEGER REFERENCES branches(id),
        sales_invoice_id INTEGER REFERENCES sales_invoices(id) ON DELETE SET NULL,
        sort_order       INTEGER NOT NULL DEFAULT 0
      )` },
    { label: "receipt_voucher_lines_voucher_idx",
      sql:   `CREATE INDEX IF NOT EXISTS receipt_voucher_lines_voucher_idx ON receipt_voucher_lines (voucher_id)` },
    { label: "create payment_voucher_lines table",
      sql:   `CREATE TABLE IF NOT EXISTS payment_voucher_lines (
        id                  SERIAL PRIMARY KEY,
        voucher_id          INTEGER NOT NULL REFERENCES payment_vouchers(id) ON DELETE CASCADE,
        account_id          INTEGER REFERENCES accounts(id),
        description         TEXT,
        amount              NUMERIC(15,2) NOT NULL DEFAULT '0',
        tax_rate            NUMERIC(15,2) NOT NULL DEFAULT '0',
        tax_amount          NUMERIC(15,2) NOT NULL DEFAULT '0',
        tax_account_id      INTEGER REFERENCES accounts(id),
        cost_center         TEXT,
        branch_id           INTEGER REFERENCES branches(id),
        purchase_invoice_id INTEGER REFERENCES purchase_invoices(id) ON DELETE SET NULL,
        sort_order          INTEGER NOT NULL DEFAULT 0
      )` },
    { label: "payment_voucher_lines_voucher_idx",
      sql:   `CREATE INDEX IF NOT EXISTS payment_voucher_lines_voucher_idx ON payment_voucher_lines (voucher_id)` },
    { label: "receipt contracting voucher allocation fields",
      sql: `ALTER TABLE receipt_voucher_lines
        ADD COLUMN IF NOT EXISTS contracting_kind TEXT,
        ADD COLUMN IF NOT EXISTS contracting_project_id INTEGER,
        ADD COLUMN IF NOT EXISTS contracting_contract_id INTEGER,
        ADD COLUMN IF NOT EXISTS contracting_bill_id INTEGER` },
    { label: "payment contracting voucher allocation fields",
      sql: `ALTER TABLE payment_voucher_lines
        ADD COLUMN IF NOT EXISTS contracting_kind TEXT,
        ADD COLUMN IF NOT EXISTS contracting_project_id INTEGER,
        ADD COLUMN IF NOT EXISTS contracting_contract_id INTEGER,
        ADD COLUMN IF NOT EXISTS contracting_bill_id INTEGER` },
    // ─── je_number_reservations: reuse the SAME journal-entry number across an
    // unpost→edit→repost cycle (see schema/journalEntries.ts). Created here
    // because ensureColumns only ALTERs existing tables. Idempotent.
    { label: "create je_number_reservations table",
      sql:   `CREATE TABLE IF NOT EXISTS je_number_reservations (
        id          SERIAL PRIMARY KEY,
        company_id  INTEGER NOT NULL,
        source_type TEXT    NOT NULL,
        source_id   INTEGER NOT NULL,
        doc_number  TEXT    NOT NULL,
        branch_id   INTEGER,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
    { label: "je_number_reservations_src_unq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS je_number_reservations_src_unq ON je_number_reservations (company_id, source_type, source_id)` },
    // ─── Saudi Mudad salary batches (see schema/hr.ts). WPS-compatible salary
    // export to منصة مدد. Created here because ensureColumns only ALTERs
    // existing tables, never CREATEs. Idempotent — safe on every boot.
    { label: "create mudad_salary_batches table",
      sql:   `CREATE TABLE IF NOT EXISTS mudad_salary_batches (
        id                   SERIAL PRIMARY KEY,
        company_id           INTEGER NOT NULL REFERENCES companies(id),
        branch_id            INTEGER REFERENCES branches(id),
        payroll_run_id       INTEGER REFERENCES payroll_runs(id) ON DELETE SET NULL,
        code                 TEXT NOT NULL,
        year                 INTEGER NOT NULL,
        month                INTEGER NOT NULL,
        send_mode            TEXT NOT NULL DEFAULT 'sponsored_only',
        establishment_number TEXT,
        total_employees      INTEGER NOT NULL DEFAULT 0,
        included_count       INTEGER NOT NULL DEFAULT 0,
        excluded_count       INTEGER NOT NULL DEFAULT 0,
        sent_count           INTEGER NOT NULL DEFAULT 0,
        rejected_count       INTEGER NOT NULL DEFAULT 0,
        total_net            NUMERIC(14,2) NOT NULL DEFAULT '0',
        file_format          TEXT NOT NULL DEFAULT 'wps_csv',
        status               TEXT NOT NULL DEFAULT 'generated',
        created_by           INTEGER,
        created_by_name      TEXT,
        notes                TEXT,
        created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "mudad_salary_batches_company_code_unq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS uq_mudad_batch_company_code ON mudad_salary_batches (company_id, code)` },
    { label: "mudad_salary_batches_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS mudad_salary_batches_company_idx ON mudad_salary_batches (company_id)` },
    { label: "create mudad_salary_batch_lines table",
      sql:   `CREATE TABLE IF NOT EXISTS mudad_salary_batch_lines (
        id               SERIAL PRIMARY KEY,
        batch_id         INTEGER NOT NULL REFERENCES mudad_salary_batches(id) ON DELETE CASCADE,
        company_id       INTEGER NOT NULL REFERENCES companies(id),
        employee_id      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        employee_code    TEXT,
        employee_name    TEXT,
        id_number        TEXT,
        iban             TEXT,
        bank_name        TEXT,
        net_salary       NUMERIC(12,2) NOT NULL DEFAULT '0',
        included         BOOLEAN NOT NULL DEFAULT FALSE,
        excluded_reason  TEXT,
        status           TEXT NOT NULL DEFAULT 'pending',
        rejection_reason TEXT,
        created_at       TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "mudad_salary_batch_lines_batch_idx",
      sql:   `CREATE INDEX IF NOT EXISTS mudad_salary_batch_lines_batch_idx ON mudad_salary_batch_lines (batch_id)` },
    // ─── pos_terminal_users: optional per-terminal user allow-list (see
    // schema/pos.ts). Same rationale as approval_log — created here because
    // ensureColumns only ALTERs.
    { label: "create pos_terminal_users table",
      sql:   `CREATE TABLE IF NOT EXISTS pos_terminal_users (
        id              SERIAL PRIMARY KEY,
        company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        pos_terminal_id INTEGER NOT NULL REFERENCES pos_terminals(id) ON DELETE CASCADE,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "pos_terminal_users_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS pos_terminal_users_uniq ON pos_terminal_users (pos_terminal_id, user_id)` },
    { label: "pos_terminal_users_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS pos_terminal_users_company_idx ON pos_terminal_users (company_id)` },
    // ─── Per-station / per-cashier service-icon visibility (see schema/pos.ts).
    // null = all services visible (backwards compatible).
    { label: "pos_terminals.enabled_services",
      sql:   `ALTER TABLE pos_terminals ADD COLUMN IF NOT EXISTS enabled_services TEXT[]` },
    { label: "pos_terminal_users.enabled_services",
      sql:   `ALTER TABLE pos_terminal_users ADD COLUMN IF NOT EXISTS enabled_services TEXT[]` },

    // ─── Online Store module (see lib/db/src/schema/onlineStore.ts).
    // Multi-tenant e-commerce storefront tables — same rationale as above
    // (CREATE here, ensureColumns only ALTERs).
    { label: "create stores table",
      sql:   `CREATE TABLE IF NOT EXISTS stores (
        id            SERIAL PRIMARY KEY,
        company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        slug          TEXT NOT NULL,
        currency      TEXT NOT NULL DEFAULT 'SAR',
        language      TEXT NOT NULL DEFAULT 'ar',
        theme         TEXT NOT NULL DEFAULT 'modern',
        logo_url      TEXT,
        description   TEXT,
        contact_email TEXT,
        contact_phone TEXT,
        is_active     BOOLEAN NOT NULL DEFAULT TRUE,
        metadata      JSONB,
        created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "stores_slug_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS stores_slug_uniq ON stores (slug)` },
    { label: "stores_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS stores_company_idx ON stores (company_id)` },

    { label: "create store_domains table",
      sql:   `CREATE TABLE IF NOT EXISTS store_domains (
        id          SERIAL PRIMARY KEY,
        company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        store_id    INTEGER NOT NULL REFERENCES stores(id)   ON DELETE CASCADE,
        domain      TEXT NOT NULL,
        type        TEXT NOT NULL DEFAULT 'custom',
        status      TEXT NOT NULL DEFAULT 'pending',
        is_primary  BOOLEAN NOT NULL DEFAULT FALSE,
        verified_at TIMESTAMP,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "store_domains_domain_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS store_domains_domain_uniq ON store_domains (domain)` },

    // ─── Multi-Domain Management (SuperAdmin platform module). One domain →
    // one company; host-based resolution is a fallback only (see auth.ts
    // resolveCompanyId). Created here because ensureColumns only ALTERs.
    // Distinct from store_domains (online-store storefront domains).
    { label: "create company_domains table",
      sql:   `CREATE TABLE IF NOT EXISTS company_domains (
        id                 SERIAL PRIMARY KEY,
        company_id         INTEGER REFERENCES companies(id) ON DELETE CASCADE,
        domain             TEXT NOT NULL,
        is_primary         BOOLEAN NOT NULL DEFAULT FALSE,
        is_main            BOOLEAN NOT NULL DEFAULT FALSE,
        status             TEXT NOT NULL DEFAULT 'pending',
        activated_at       TIMESTAMP,
        last_check_at      TIMESTAMP,
        last_check_result  JSONB,
        notes              TEXT,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "company_domains_domain_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS company_domains_domain_uniq ON company_domains (domain)` },
    { label: "company_domains_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS company_domains_company_idx ON company_domains (company_id)` },
    // Multi-domain: allow a "main" multi-company domain (no bound company) plus
    // the is_main flag. Idempotent ALTERs for tables created before this change.
    { label: "company_domains company_id nullable",
      sql:   `ALTER TABLE company_domains ALTER COLUMN company_id DROP NOT NULL` },
    { label: "company_domains add is_main",
      sql:   `ALTER TABLE company_domains ADD COLUMN IF NOT EXISTS is_main BOOLEAN NOT NULL DEFAULT FALSE` },

    // ─── Item Usage Control (التحكم في توجيه الصنف) ───────────────────────────
    // Per-item × per-screen routing rules. Absence of a row = "allowed" (the
    // default). Only NON-default rows are persisted to stay lean at scale.
    // Created here because ensureColumns only ALTERs existing tables.
    { label: "create item_usage_controls table",
      sql:   `CREATE TABLE IF NOT EXISTS item_usage_controls (
        id                 SERIAL PRIMARY KEY,
        company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        item_id            INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        screen_key         TEXT NOT NULL,
        mode               TEXT NOT NULL DEFAULT 'allowed',
        reason             TEXT,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "item_usage_controls_item_screen_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS item_usage_controls_item_screen_uniq ON item_usage_controls (company_id, item_id, screen_key)` },
    { label: "item_usage_controls_company_item_idx",
      sql:   `CREATE INDEX IF NOT EXISTS item_usage_controls_company_item_idx ON item_usage_controls (company_id, item_id)` },
    { label: "item_usage_controls_company_screen_mode_idx",
      sql:   `CREATE INDEX IF NOT EXISTS item_usage_controls_company_screen_mode_idx ON item_usage_controls (company_id, screen_key, mode)` },

    // ─── Brands (العلامات التجارية) — OPTIONAL multi-brand support ─────────────
    // Materialised here because ensureColumns only ALTERs EXISTING tables.
    // Brand is a print-only concept on invoices; brandId/brandName columns on
    // sales_invoice_lines are auto-added by ensureColumns from the drizzle schema.
    { label: "create brands table",
      sql:   `CREATE TABLE IF NOT EXISTS brands (
        id                 SERIAL PRIMARY KEY,
        company_id         INTEGER NOT NULL,
        code               TEXT NOT NULL,
        name_ar            TEXT NOT NULL,
        name_en            TEXT,
        manufacturer_name  TEXT,
        supplier_name      TEXT,
        country_of_origin  TEXT,
        logo_url           TEXT,
        status             TEXT NOT NULL DEFAULT 'active',
        notes              TEXT,
        created_at         TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "brands_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS brands_company_idx ON brands (company_id)` },
    // Plain (company_id, code) — NOT a functional lower(code) expression index.
    // The Replit publish migration generator mis-serializes an expression index
    // (emits `lower(code) int4_ops`, which fails: "int4_ops does not accept text").
    // Case-insensitive uniqueness is already enforced at the app layer
    // (POST/PUT /brands compare code.toLowerCase()), so this plain index is a safe
    // exact-match backstop and keeps the publish diff clean.
    { label: "brands_company_code_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS brands_company_code_uniq ON brands (company_id, code)` },
    { label: "create item_brands table",
      sql:   `CREATE TABLE IF NOT EXISTS item_brands (
        id                  SERIAL PRIMARY KEY,
        company_id          INTEGER NOT NULL,
        item_id             INTEGER NOT NULL,
        brand_id            INTEGER NOT NULL,
        barcode             TEXT,
        part_number         TEXT,
        supplier_code       TEXT,
        purchase_unit       TEXT,
        purchase_cost       NUMERIC(15,4) DEFAULT 0,
        last_purchase_cost  NUMERIC(15,4) DEFAULT 0,
        avg_cost            NUMERIC(15,4) DEFAULT 0,
        sale_price1         NUMERIC(15,4) DEFAULT 0,
        sale_price2         NUMERIC(15,4) DEFAULT 0,
        sale_price3         NUMERIC(15,4) DEFAULT 0,
        min_sale_price      NUMERIC(15,4) DEFAULT 0,
        profit_margin       NUMERIC(8,4)  DEFAULT 0,
        country_of_origin   TEXT,
        warranty_period     TEXT,
        status              TEXT NOT NULL DEFAULT 'active',
        notes               TEXT,
        created_at          TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "item_brands_company_item_idx",
      sql:   `CREATE INDEX IF NOT EXISTS item_brands_company_item_idx ON item_brands (company_id, item_id)` },
    { label: "item_brands_item_brand_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS item_brands_item_brand_uniq ON item_brands (company_id, item_id, brand_id)` },

    // ─── Goods Receipt / Delivery documents (مستندات الاستلام والتسليم) ────────
    // Pure electronic archive linked to purchase/sales invoices. No GL, no
    // stock impact. Attachments reuse document_archives. Materialised here
    // because ensureColumns only ALTERs existing tables.
    { label: "create delivery_receipt_documents table",
      sql:   `CREATE TABLE IF NOT EXISTS delivery_receipt_documents (
        id                    SERIAL PRIMARY KEY,
        company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        branch_id             INTEGER,
        warehouse_id          INTEGER,
        kind                  TEXT NOT NULL,
        doc_number            TEXT NOT NULL,
        doc_date              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        invoice_id            INTEGER,
        invoice_type          TEXT,
        invoice_number        TEXT,
        party_id              INTEGER,
        party_type            TEXT,
        party_name            TEXT,
        employee_id           INTEGER,
        employee_name         TEXT,
        status                TEXT NOT NULL DEFAULT 'full',
        notes                 TEXT,
        recipient_name        TEXT,
        recipient_job         TEXT,
        recipient_id_number   TEXT,
        recipient_phone       TEXT,
        signature_type        TEXT,
        signature_object_path TEXT,
        is_approved           BOOLEAN NOT NULL DEFAULT FALSE,
        approved_by           INTEGER,
        approved_by_name      TEXT,
        approved_at           TIMESTAMPTZ,
        created_by            INTEGER,
        created_by_name       TEXT,
        updated_by            INTEGER,
        updated_by_name       TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
    { label: "drdoc_company_kind_idx",
      sql:   `CREATE INDEX IF NOT EXISTS drdoc_company_kind_idx ON delivery_receipt_documents (company_id, kind)` },
    { label: "drdoc_invoice_idx",
      sql:   `CREATE INDEX IF NOT EXISTS drdoc_invoice_idx ON delivery_receipt_documents (company_id, invoice_type, invoice_id)` },
    { label: "drdoc_party_idx",
      sql:   `CREATE INDEX IF NOT EXISTS drdoc_party_idx ON delivery_receipt_documents (company_id, party_type, party_id)` },
    { label: "drdoc_number_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS drdoc_number_uniq ON delivery_receipt_documents (company_id, kind, doc_number)` },
    { label: "create delivery_receipt_document_lines table",
      sql:   `CREATE TABLE IF NOT EXISTS delivery_receipt_document_lines (
        id          SERIAL PRIMARY KEY,
        company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        document_id INTEGER NOT NULL REFERENCES delivery_receipt_documents(id) ON DELETE CASCADE,
        item_id     INTEGER,
        item_name   TEXT NOT NULL,
        unit        TEXT,
        ordered_qty NUMERIC(18,4) NOT NULL DEFAULT '0',
        actual_qty  NUMERIC(18,4) NOT NULL DEFAULT '0',
        notes       TEXT,
        sort_order  INTEGER NOT NULL DEFAULT 0
      )` },
    { label: "drdoc_lines_doc_idx",
      sql:   `CREATE INDEX IF NOT EXISTS drdoc_lines_doc_idx ON delivery_receipt_document_lines (document_id)` },
    { label: "create delivery_receipt_document_audit table",
      sql:   `CREATE TABLE IF NOT EXISTS delivery_receipt_document_audit (
        id          SERIAL PRIMARY KEY,
        company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        document_id INTEGER NOT NULL REFERENCES delivery_receipt_documents(id) ON DELETE CASCADE,
        action      TEXT NOT NULL,
        user_id     INTEGER,
        user_name   TEXT,
        details     JSONB,
        at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
    { label: "drdoc_audit_doc_idx",
      sql:   `CREATE INDEX IF NOT EXISTS drdoc_audit_doc_idx ON delivery_receipt_document_audit (document_id, at)` },

    { label: "create store_products table",
      sql:   `CREATE TABLE IF NOT EXISTS store_products (
        id              SERIAL PRIMARY KEY,
        company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        store_id        INTEGER NOT NULL REFERENCES stores(id)   ON DELETE CASCADE,
        product_id      INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        price           NUMERIC(15,2) NOT NULL DEFAULT '0',
        compare_price   NUMERIC(15,2),
        is_visible      BOOLEAN NOT NULL DEFAULT TRUE,
        image_url       TEXT,
        gallery_urls    JSONB,
        description_ar  TEXT,
        description_en  TEXT,
        sort_order      INTEGER NOT NULL DEFAULT 0,
        metadata        JSONB,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "store_products_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS store_products_uniq ON store_products (store_id, product_id)` },

    { label: "create store_orders table",
      sql:   `CREATE TABLE IF NOT EXISTS store_orders (
        id               SERIAL PRIMARY KEY,
        company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        store_id         INTEGER NOT NULL REFERENCES stores(id)   ON DELETE CASCADE,
        code             TEXT NOT NULL,
        customer_name    TEXT NOT NULL,
        customer_phone   TEXT,
        customer_email   TEXT,
        shipping_address TEXT,
        shipping_city    TEXT,
        shipping_method  TEXT,
        shipping_cost    NUMERIC(15,2) NOT NULL DEFAULT '0',
        subtotal         NUMERIC(15,2) NOT NULL DEFAULT '0',
        vat              NUMERIC(15,2) NOT NULL DEFAULT '0',
        total            NUMERIC(15,2) NOT NULL DEFAULT '0',
        payment_method   TEXT NOT NULL DEFAULT 'cod',
        payment_status   TEXT NOT NULL DEFAULT 'unpaid',
        status           TEXT NOT NULL DEFAULT 'new',
        invoice_id       INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
        notes            TEXT,
        tracking_number  TEXT,
        created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
        confirmed_at     TIMESTAMP,
        shipped_at       TIMESTAMP,
        delivered_at     TIMESTAMP,
        cancelled_at     TIMESTAMP
      )` },
    { label: "store_orders_company_code_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS store_orders_company_code_uniq ON store_orders (company_id, code)` },
    { label: "store_orders_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS store_orders_status_idx ON store_orders (company_id, status, created_at DESC)` },

    { label: "create store_order_items table",
      sql:   `CREATE TABLE IF NOT EXISTS store_order_items (
        id               SERIAL PRIMARY KEY,
        order_id         INTEGER NOT NULL REFERENCES store_orders(id) ON DELETE CASCADE,
        store_product_id INTEGER REFERENCES store_products(id) ON DELETE SET NULL,
        product_id       INTEGER REFERENCES items(id)       ON DELETE SET NULL,
        product_name     TEXT NOT NULL,
        qty              NUMERIC(15,3) NOT NULL,
        unit_price       NUMERIC(15,2) NOT NULL,
        line_total       NUMERIC(15,2) NOT NULL
      )` },
    { label: "store_order_items_order_idx",
      sql:   `CREATE INDEX IF NOT EXISTS store_order_items_order_idx ON store_order_items (order_id)` },

    { label: "create custom_print_templates table",
      sql:   `CREATE TABLE IF NOT EXISTS custom_print_templates (
        id            SERIAL PRIMARY KEY,
        company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        document_type TEXT NOT NULL,
        name          TEXT NOT NULL,
        is_default    BOOLEAN NOT NULL DEFAULT FALSE,
        paper_size    TEXT NOT NULL DEFAULT 'A4',
        width_mm      INTEGER NOT NULL DEFAULT 210,
        height_mm     INTEGER NOT NULL DEFAULT 297,
        layout_json   JSONB NOT NULL DEFAULT '{"elements":[]}'::jsonb,
        created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "cpt_company_doc_idx",
      sql:   `CREATE INDEX IF NOT EXISTS cpt_company_doc_idx ON custom_print_templates (company_id, document_type)` },

    // ─── Company Cloning from Templates (see lib/db/src/schema/companyTemplates.ts).
    { label: "create company_templates table",
      sql:   `CREATE TABLE IF NOT EXISTS company_templates (
        id                 SERIAL PRIMARY KEY,
        name_ar            TEXT NOT NULL,
        name_en            TEXT,
        description        TEXT,
        industry_name      TEXT,
        source_company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        is_active          BOOLEAN NOT NULL DEFAULT TRUE,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "company_templates_source_idx",
      sql:   `CREATE INDEX IF NOT EXISTS company_templates_source_idx ON company_templates (source_company_id)` },

    { label: "create company_clone_runs table",
      sql:   `CREATE TABLE IF NOT EXISTS company_clone_runs (
        id                   SERIAL PRIMARY KEY,
        source_company_id    INTEGER NOT NULL,
        target_company_id    INTEGER,
        template_id          INTEGER,
        performed_by_user_id INTEGER,
        status               TEXT NOT NULL DEFAULT 'success',
        summary              JSONB,
        error                TEXT,
        created_at           TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "company_clone_runs_source_idx",
      sql:   `CREATE INDEX IF NOT EXISTS company_clone_runs_source_idx ON company_clone_runs (source_company_id)` },

    { label: "create store_payment_settings table",
      sql:   `CREATE TABLE IF NOT EXISTS store_payment_settings (
        id           SERIAL PRIMARY KEY,
        company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        store_id     INTEGER NOT NULL REFERENCES stores(id)   ON DELETE CASCADE,
        gateway      TEXT NOT NULL,
        is_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
        environment  TEXT NOT NULL DEFAULT 'test',
        display_name TEXT,
        config_json  JSONB,
        updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "store_payment_settings_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS store_payment_settings_uniq ON store_payment_settings (store_id, gateway)` },

    // ─── Internal Chat module (see lib/db/src/schema/chat.ts).
    { label: "create chat_conversations table",
      sql:   `CREATE TABLE IF NOT EXISTS chat_conversations (
        id                 SERIAL PRIMARY KEY,
        company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        kind               TEXT NOT NULL DEFAULT 'direct',
        title              TEXT,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
        last_message_at    TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "chat_conv_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS chat_conv_company_idx ON chat_conversations (company_id, last_message_at DESC)` },

    { label: "create chat_participants table",
      sql:   `CREATE TABLE IF NOT EXISTS chat_participants (
        id                    SERIAL PRIMARY KEY,
        conversation_id       INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role                  TEXT NOT NULL DEFAULT 'member',
        joined_at             TIMESTAMP NOT NULL DEFAULT NOW(),
        last_read_message_id  INTEGER,
        last_read_at          TIMESTAMP
      )` },
    { label: "chat_participants_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS chat_participants_uniq ON chat_participants (conversation_id, user_id)` },
    { label: "chat_participants_user_idx",
      sql:   `CREATE INDEX IF NOT EXISTS chat_participants_user_idx ON chat_participants (user_id)` },

    { label: "create chat_messages table",
      sql:   `CREATE TABLE IF NOT EXISTS chat_messages (
        id                SERIAL PRIMARY KEY,
        conversation_id   INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        sender_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        kind              TEXT NOT NULL DEFAULT 'text',
        body              TEXT NOT NULL DEFAULT '',
        attachment_url    TEXT,
        attachment_name   TEXT,
        attachment_mime   TEXT,
        attachment_size   INTEGER,
        reply_to_id       INTEGER,
        created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
        edited_at         TIMESTAMP,
        deleted_at        TIMESTAMP
      )` },
    { label: "chat_messages_conv_idx",
      sql:   `CREATE INDEX IF NOT EXISTS chat_messages_conv_idx ON chat_messages (conversation_id, created_at)` },
    { label: "chat_messages_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS chat_messages_company_idx ON chat_messages (company_id, created_at)` },

    // Drop the legacy single-policy-per-company table (was created earlier in
    // this same task, never used in production) — it's been replaced by the
    // profiles + user-assignments model below.
    { label: "drop legacy invoice_field_policies",
      sql:   `DROP TABLE IF EXISTS invoice_field_policies` },

    { label: "create invoice_field_policy_profiles table",
      sql:   `CREATE TABLE IF NOT EXISTS invoice_field_policy_profiles (
        id          SERIAL PRIMARY KEY,
        company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        bundle      JSONB NOT NULL DEFAULT '{}'::jsonb,
        is_default  BOOLEAN NOT NULL DEFAULT FALSE,
        color       TEXT,
        updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "invoice_field_policy_profiles_company_name_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS invoice_field_policy_profiles_company_name_uniq ON invoice_field_policy_profiles (company_id, name)` },

    { label: "create user_invoice_field_policies table",
      sql:   `CREATE TABLE IF NOT EXISTS user_invoice_field_policies (
        user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        profile_id  INTEGER NOT NULL REFERENCES invoice_field_policy_profiles(id) ON DELETE CASCADE,
        assigned_at TIMESTAMP NOT NULL DEFAULT NOW(),
        assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      )` },
    { label: "user_invoice_field_policies_profile_idx",
      sql:   `CREATE INDEX IF NOT EXISTS user_invoice_field_policies_profile_idx ON user_invoice_field_policies (profile_id)` },

    // ─── Field Service Management (FSM) — see lib/db/src/schema/fieldService.ts.
    // CREATE here because ensureColumns only ALTERs existing tables.
    { label: "create field_locations table",
      sql:   `CREATE TABLE IF NOT EXISTS field_locations (
        id              SERIAL PRIMARY KEY,
        company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        branch_id       INTEGER REFERENCES branches(id) ON DELETE SET NULL,
        name            TEXT NOT NULL,
        type            TEXT NOT NULL DEFAULT 'customer',
        lat             NUMERIC(10,7) NOT NULL,
        lng             NUMERIC(10,7) NOT NULL,
        radius_m        INTEGER NOT NULL DEFAULT 150,
        customer_id     INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        project_id      INTEGER,
        asset_id        INTEGER,
        cost_center_id  INTEGER REFERENCES cost_centers(id) ON DELETE SET NULL,
        address         TEXT,
        city            TEXT,
        contact_person  TEXT,
        contact_phone   TEXT,
        is_active       BOOLEAN NOT NULL DEFAULT TRUE,
        notes           TEXT,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "field_loc_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_loc_company_idx ON field_locations (company_id)` },
    { label: "field_loc_type_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_loc_type_idx ON field_locations (company_id, type)` },
    { label: "field_loc_customer_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_loc_customer_idx ON field_locations (customer_id)` },

    { label: "create field_visits table",
      sql:   `CREATE TABLE IF NOT EXISTS field_visits (
        id                    SERIAL PRIMARY KEY,
        company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        employee_id           INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        location_id           INTEGER REFERENCES field_locations(id) ON DELETE SET NULL,
        location_name         TEXT,
        location_type         TEXT,
        customer_id           INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        project_id            INTEGER,
        asset_id              INTEGER,
        ticket_id             INTEGER,
        cost_center_id        INTEGER REFERENCES cost_centers(id) ON DELETE SET NULL,
        purpose               TEXT NOT NULL DEFAULT 'site_visit',
        status                TEXT NOT NULL DEFAULT 'open',
        arrived_at            TIMESTAMP NOT NULL DEFAULT NOW(),
        left_at               TIMESTAMP,
        duration_min          INTEGER,
        arrival_lat           NUMERIC(10,7),
        arrival_lng           NUMERIC(10,7),
        arrival_accuracy_m    NUMERIC(8,2),
        arrival_distance_m    NUMERIC(10,2),
        arrival_loc_status    TEXT,
        departure_lat         NUMERIC(10,7),
        departure_lng         NUMERIC(10,7),
        departure_accuracy_m  NUMERIC(8,2),
        outcome               TEXT,
        photo_url             TEXT,
        signature_url         TEXT,
        signed_by_name        TEXT,
        form_data             JSONB DEFAULT '{}'::jsonb,
        notes                 TEXT,
        created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "field_visits_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_visits_company_idx ON field_visits (company_id)` },
    { label: "field_visits_employee_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_visits_employee_idx ON field_visits (employee_id)` },
    { label: "field_visits_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_visits_status_idx ON field_visits (company_id, status)` },
    { label: "field_visits_arrived_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_visits_arrived_idx ON field_visits (arrived_at)` },
    { label: "field_visits_ticket_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_visits_ticket_idx ON field_visits (ticket_id)` },

    { label: "create field_visit_plans table",
      sql:   `CREATE TABLE IF NOT EXISTS field_visit_plans (
        id           SERIAL PRIMARY KEY,
        company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        date         DATE NOT NULL,
        status       TEXT NOT NULL DEFAULT 'published',
        notes        TEXT,
        created_by   INTEGER,
        created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "field_plans_emp_date_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_plans_emp_date_idx ON field_visit_plans (employee_id, date)` },

    { label: "create field_visit_plan_items table",
      sql:   `CREATE TABLE IF NOT EXISTS field_visit_plan_items (
        id            SERIAL PRIMARY KEY,
        plan_id       INTEGER NOT NULL REFERENCES field_visit_plans(id) ON DELETE CASCADE,
        sequence_no   INTEGER NOT NULL DEFAULT 1,
        location_id   INTEGER REFERENCES field_locations(id) ON DELETE SET NULL,
        location_name TEXT,
        planned_at    TIMESTAMP,
        purpose       TEXT,
        status        TEXT NOT NULL DEFAULT 'pending',
        visit_id      INTEGER REFERENCES field_visits(id) ON DELETE SET NULL,
        notes         TEXT
      )` },

    { label: "create field_service_tickets table",
      sql:   `CREATE TABLE IF NOT EXISTS field_service_tickets (
        id                       SERIAL PRIMARY KEY,
        company_id               INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        branch_id                INTEGER REFERENCES branches(id) ON DELETE SET NULL,
        ticket_no                TEXT NOT NULL,
        customer_id              INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        asset_id                 INTEGER,
        location_id              INTEGER REFERENCES field_locations(id) ON DELETE SET NULL,
        title                    TEXT NOT NULL,
        description              TEXT,
        category                 TEXT NOT NULL DEFAULT 'repair',
        priority                 TEXT NOT NULL DEFAULT 'medium',
        status                   TEXT NOT NULL DEFAULT 'open',
        opened_at                TIMESTAMP NOT NULL DEFAULT NOW(),
        opened_by                INTEGER,
        assigned_to              INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        assigned_at              TIMESTAMP,
        responded_at             TIMESTAMP,
        resolved_at              TIMESTAMP,
        closed_at                TIMESTAMP,
        sla_response_min         INTEGER NOT NULL DEFAULT 60,
        sla_resolution_min       INTEGER NOT NULL DEFAULT 480,
        sla_response_breached    BOOLEAN NOT NULL DEFAULT FALSE,
        sla_resolution_breached  BOOLEAN NOT NULL DEFAULT FALSE,
        resolution               TEXT,
        customer_rating          INTEGER,
        labor_hours              NUMERIC(10,2) DEFAULT '0',
        labor_cost               NUMERIC(15,2) DEFAULT '0',
        parts_cost               NUMERIC(15,2) DEFAULT '0',
        total_cost               NUMERIC(15,2) DEFAULT '0',
        notes                    TEXT,
        created_at               TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "field_tickets_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_tickets_company_idx ON field_service_tickets (company_id)` },
    { label: "field_tickets_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_tickets_status_idx ON field_service_tickets (company_id, status)` },
    { label: "field_tickets_assigned_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_tickets_assigned_idx ON field_service_tickets (assigned_to)` },
    { label: "field_tickets_no_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS field_tickets_no_uniq ON field_service_tickets (company_id, ticket_no)` },

    // ── FSM SLA pre-computed deadlines ────────────────────────────────
    // Background SLA-breach evaluators (and reports) need a deterministic
    // due-at instead of recomputing `opened_at + sla_xxx_min` everywhere.
    // Populated by the route layer on insert and on priority change.
    { label: "alter field_service_tickets add response_due_at",
      sql:   `ALTER TABLE field_service_tickets ADD COLUMN IF NOT EXISTS response_due_at TIMESTAMP` },
    { label: "alter field_service_tickets add resolve_due_at",
      sql:   `ALTER TABLE field_service_tickets ADD COLUMN IF NOT EXISTS resolve_due_at TIMESTAMP` },
    // Backfill existing rows so old tickets also benefit from the new
    // breach-detection path. NOT NULL is intentionally NOT enforced — old
    // imports that lacked an opened_at would otherwise fail.
    { label: "backfill field_service_tickets response_due_at",
      sql:   `UPDATE field_service_tickets
              SET response_due_at = opened_at + (sla_response_min || ' minutes')::interval
              WHERE response_due_at IS NULL AND opened_at IS NOT NULL` },
    { label: "backfill field_service_tickets resolve_due_at",
      sql:   `UPDATE field_service_tickets
              SET resolve_due_at = opened_at + (sla_resolution_min || ' minutes')::interval
              WHERE resolve_due_at IS NULL AND opened_at IS NOT NULL` },
    { label: "field_tickets_response_due_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_tickets_response_due_idx ON field_service_tickets (response_due_at)` },
    { label: "field_tickets_resolve_due_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_tickets_resolve_due_idx ON field_service_tickets (resolve_due_at)` },
    { label: "field_tickets_branch_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_tickets_branch_idx ON field_service_tickets (company_id, branch_id)` },
    { label: "field_tickets_assigned_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_tickets_assigned_status_idx ON field_service_tickets (assigned_to, status)` },
    { label: "field_visits_company_arrived_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_visits_company_arrived_idx ON field_visits (company_id, arrived_at)` },
    { label: "field_visits_emp_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_visits_emp_status_idx ON field_visits (employee_id, status)` },
    // Branch-scoping for visits — added so branch-restricted users see
    // only the visits whose location belongs to their assigned branch.
    // Backfilled from the linked field_location's branch_id so historic
    // rows participate in branch filters too.
    { label: "alter field_visits add branch_id",
      sql:   `ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL` },
    { label: "backfill field_visits.branch_id from field_locations",
      sql:   `UPDATE field_visits v
              SET branch_id = l.branch_id
              FROM field_locations l
              WHERE v.location_id = l.id AND v.branch_id IS NULL AND l.branch_id IS NOT NULL` },
    { label: "field_visits_branch_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_visits_branch_idx ON field_visits (company_id, branch_id)` },

    // ─── FSM ↔ Maintenance integration ─────────────────────────────────
    // Soft FK from maintenance_orders → field_service_tickets, set when an
    // FSM ticket is converted to a maintenance work order. Allows two-way
    // navigation and a UNIQUE guard prevents double conversion of the same
    // ticket.
    { label: "alter maintenance_orders add field_ticket_id",
      sql:   `ALTER TABLE maintenance_orders ADD COLUMN IF NOT EXISTS field_ticket_id INTEGER` },
    // Migrate the legacy single-column unique index to a (company_id,
    // field_ticket_id) scoped one. Safe to drop because the column was
    // introduced in this same deploy and never globally reused.
    { label: "drop legacy maintenance_orders_field_ticket_uniq",
      sql:   `DO $$ BEGIN
                IF EXISTS (
                  SELECT 1 FROM pg_indexes
                  WHERE indexname = 'maintenance_orders_field_ticket_uniq'
                    AND indexdef NOT LIKE '%(company_id, field_ticket_id)%'
                ) THEN
                  EXECUTE 'DROP INDEX maintenance_orders_field_ticket_uniq';
                END IF;
              END $$;` },
    { label: "maintenance_orders_field_ticket_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS maintenance_orders_field_ticket_uniq
              ON maintenance_orders (company_id, field_ticket_id) WHERE field_ticket_id IS NOT NULL` },
    { label: "maintenance_orders_asset_idx",
      sql:   `CREATE INDEX IF NOT EXISTS maintenance_orders_asset_idx
              ON maintenance_orders (company_id, asset_id)` },
    { label: "field_tickets_asset_idx",
      sql:   `CREATE INDEX IF NOT EXISTS field_tickets_asset_idx
              ON field_service_tickets (company_id, asset_id)` },

    // ── Journal-entry audit columns ─────────────────────────────────────
    // Captures who created and who posted each entry, with the IP and
    // user-agent at the time, plus the posted-at timestamp. Country is
    // resolved on demand from the IP via the same Geo-IP service used by
    // the visitor-country middleware, so no column is needed for it.
    // ── ZATCA Gateway (multi-tenant external clients) ─────────────────
    { label: "create gateway_clients table",
      sql:   `CREATE TABLE IF NOT EXISTS gateway_clients (
        id                       SERIAL PRIMARY KEY,
        name_ar                  TEXT NOT NULL,
        name_en                  TEXT,
        vat_number               TEXT NOT NULL UNIQUE,
        cr_number                TEXT,
        contact_email            TEXT,
        contact_phone            TEXT,
        address_ar               TEXT,
        city                     TEXT,
        zatca_csid_enc           TEXT,
        zatca_pcsid_enc          TEXT,
        zatca_private_key_enc    TEXT,
        zatca_env                TEXT NOT NULL DEFAULT 'sandbox',
        status                   TEXT NOT NULL DEFAULT 'pending',
        notes                    TEXT,
        monthly_quota            INTEGER NOT NULL DEFAULT 1000,
        invoices_this_month      INTEGER NOT NULL DEFAULT 0,
        total_invoices           INTEGER NOT NULL DEFAULT 0,
        created_at               TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMP NOT NULL DEFAULT NOW(),
        last_invoice_at          TIMESTAMP
      )` },
    { label: "gateway_clients_vat_idx",
      sql:   `CREATE INDEX IF NOT EXISTS gateway_clients_vat_idx ON gateway_clients (vat_number)` },
    { label: "gateway_clients_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS gateway_clients_status_idx ON gateway_clients (status)` },
    { label: "create gateway_api_keys table",
      sql:   `CREATE TABLE IF NOT EXISTS gateway_api_keys (
        id            SERIAL PRIMARY KEY,
        client_id     INTEGER NOT NULL REFERENCES gateway_clients(id) ON DELETE CASCADE,
        label         TEXT NOT NULL,
        key_hash      TEXT NOT NULL UNIQUE,
        key_prefix    TEXT NOT NULL,
        scope         TEXT NOT NULL DEFAULT 'invoice_submit',
        created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
        last_used_at  TIMESTAMP,
        last_used_ip  TEXT,
        revoked_at    TIMESTAMP,
        expires_at    TIMESTAMP
      )` },
    { label: "gateway_api_keys_client_idx",
      sql:   `CREATE INDEX IF NOT EXISTS gateway_api_keys_client_idx ON gateway_api_keys (client_id)` },
    { label: "gateway_api_keys_hash_idx",
      sql:   `CREATE INDEX IF NOT EXISTS gateway_api_keys_hash_idx ON gateway_api_keys (key_hash)` },
    { label: "create gateway_invoices table",
      sql:   `CREATE TABLE IF NOT EXISTS gateway_invoices (
        id              SERIAL PRIMARY KEY,
        client_id       INTEGER NOT NULL REFERENCES gateway_clients(id) ON DELETE CASCADE,
        api_key_id      INTEGER REFERENCES gateway_api_keys(id) ON DELETE SET NULL,
        file_name       TEXT,
        file_size       INTEGER,
        invoice_number  TEXT,
        invoice_date    TIMESTAMP,
        total_amount    NUMERIC(18,2),
        vat_amount      NUMERIC(18,2),
        status          TEXT NOT NULL DEFAULT 'received',
        zatca_uuid      TEXT,
        zatca_response  JSONB,
        error_message   TEXT,
        received_at     TIMESTAMP NOT NULL DEFAULT NOW(),
        processed_at    TIMESTAMP,
        ip              TEXT
      )` },
    { label: "gateway_invoices_client_idx",
      sql:   `CREATE INDEX IF NOT EXISTS gateway_invoices_client_idx ON gateway_invoices (client_id, received_at)` },
    { label: "gateway_invoices_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS gateway_invoices_status_idx ON gateway_invoices (status)` },
    // ── Phase 2: real submission chain (ICV/PIH) + onboarding wizard ──
    { label: "companies add print_enabled_templates",
      sql:   `ALTER TABLE companies ADD COLUMN IF NOT EXISTS print_enabled_templates JSONB` },
    { label: "companies add print_default_template",
      sql:   `ALTER TABLE companies ADD COLUMN IF NOT EXISTS print_default_template INTEGER NOT NULL DEFAULT 1` },
    { label: "companies add sequence_date_source",
      sql:   `ALTER TABLE companies ADD COLUMN IF NOT EXISTS sequence_date_source TEXT NOT NULL DEFAULT 'system'` },
    { label: "companies add brand_logo",
      sql:   `ALTER TABLE companies ADD COLUMN IF NOT EXISTS brand_logo TEXT` },
    { label: "gateway_clients add last_icv",
      sql:   `ALTER TABLE gateway_clients ADD COLUMN IF NOT EXISTS last_icv INTEGER NOT NULL DEFAULT 0` },
    { label: "gateway_clients add last_invoice_hash",
      sql:   `ALTER TABLE gateway_clients ADD COLUMN IF NOT EXISTS last_invoice_hash TEXT` },
    { label: "gateway_clients add egs_serial",
      sql:   `ALTER TABLE gateway_clients ADD COLUMN IF NOT EXISTS egs_serial TEXT` },
    { label: "gateway_clients add csr_pem",
      sql:   `ALTER TABLE gateway_clients ADD COLUMN IF NOT EXISTS csr_pem TEXT` },
    { label: "gateway_clients add csr_private_key_enc",
      sql:   `ALTER TABLE gateway_clients ADD COLUMN IF NOT EXISTS csr_private_key_enc TEXT` },
    { label: "gateway_invoices add icv",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS icv INTEGER` },
    { label: "gateway_invoices add pih",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS pih TEXT` },
    { label: "gateway_invoices add invoice_hash",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS invoice_hash TEXT` },
    { label: "gateway_invoices add invoice_type",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS invoice_type TEXT` },
    { label: "gateway_invoices add invoice_flow",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS invoice_flow TEXT` },
    { label: "gateway_invoices add canonical_json",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS canonical_json JSONB` },
    { label: "gateway_invoices add ubl_xml",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS ubl_xml TEXT` },
    { label: "gateway_invoices add qr_tlv",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS qr_tlv TEXT` },
    { label: "gateway_invoices add zatca_submitted_at",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS zatca_submitted_at TIMESTAMP` },
    { label: "gateway_invoices add clearance_status",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS clearance_status TEXT` },
    { label: "gateway_invoices add clearance_notes",
      sql:   `ALTER TABLE gateway_invoices ADD COLUMN IF NOT EXISTS clearance_notes JSONB` },
    // Manual-JE auto-posting toggle (companion to auto_post_sales / etc.).
    // Default true so upgrading tenants keep the legacy "post on save"
    // behavior; flipping it to false makes new manual JEs land as drafts.
    { label: "companies add auto_post_journal_entry",
      sql:   `ALTER TABLE companies ADD COLUMN IF NOT EXISTS auto_post_journal_entry BOOLEAN NOT NULL DEFAULT TRUE` },
    { label: "companies add auto_send_zatca_after_post",
      sql:   `ALTER TABLE companies ADD COLUMN IF NOT EXISTS auto_send_zatca_after_post BOOLEAN NOT NULL DEFAULT FALSE` },
    // Optional UX prefs (company-wide): smart JE form + menu placement.
    { label: "companies add journal_smart_form",
      sql:   `ALTER TABLE companies ADD COLUMN IF NOT EXISTS journal_smart_form BOOLEAN NOT NULL DEFAULT FALSE` },
    { label: "companies add menu_layout",
      sql:   `ALTER TABLE companies ADD COLUMN IF NOT EXISTS menu_layout TEXT NOT NULL DEFAULT 'sidebar'` },
    { label: "companies add invoice_form_layout",
      sql:   `ALTER TABLE companies ADD COLUMN IF NOT EXISTS invoice_form_layout TEXT NOT NULL DEFAULT 'tabbed'` },
    // Phase 1B.2 — explicit Basic-auth secret storage and rotation marker
    { label: "gateway_clients add zatca_csid_secret_enc",
      sql:   `ALTER TABLE gateway_clients ADD COLUMN IF NOT EXISTS zatca_csid_secret_enc TEXT` },
    { label: "gateway_clients add zatca_pcsid_secret_enc",
      sql:   `ALTER TABLE gateway_clients ADD COLUMN IF NOT EXISTS zatca_pcsid_secret_enc TEXT` },
    { label: "gateway_clients add csid_last_rotated_at",
      sql:   `ALTER TABLE gateway_clients ADD COLUMN IF NOT EXISTS csid_last_rotated_at TIMESTAMP` },
    // Per-line fixed-amount discount (companion to existing per-line percent
    // discount). NOT NULL with default 0 so legacy rows reconcile cleanly.
    { label: "sales_invoice_lines add discount_amount",
      sql:   `ALTER TABLE sales_invoice_lines ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(15,2) NOT NULL DEFAULT 0` },
    { label: "sales_return_lines add discount_amount",
      sql:   `ALTER TABLE sales_return_lines ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(15,2) NOT NULL DEFAULT 0` },
    { label: "sales_quotation_lines add discount_amount",
      sql:   `ALTER TABLE sales_quotation_lines ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(15,2) NOT NULL DEFAULT 0` },
    { label: "sales_order_lines add discount_amount",
      sql:   `ALTER TABLE sales_order_lines ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(15,2) NOT NULL DEFAULT 0` },

    // Allow fractional years (years + months) on fixed-asset useful life.
    { label: "fixed_assets life_years to numeric",
      sql:   `ALTER TABLE fixed_assets ALTER COLUMN life_years TYPE NUMERIC(8,4) USING life_years::NUMERIC(8,4)` },
    { label: "fa_categories default_life_years to numeric",
      sql:   `ALTER TABLE fa_categories ALTER COLUMN default_life_years TYPE NUMERIC(8,4) USING default_life_years::NUMERIC(8,4)` },

    // Fixed-asset tax tab — KSA VAT defaults
    { label: "fixed_assets add vat_rate",
      sql:   `ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS vat_rate NUMERIC(5,2) NOT NULL DEFAULT 15` },
    { label: "fixed_assets add price_includes_vat",
      sql:   `ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS price_includes_vat BOOLEAN NOT NULL DEFAULT FALSE` },
    { label: "fixed_assets add is_opening_balance",
      sql:   `ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS is_opening_balance BOOLEAN NOT NULL DEFAULT FALSE` },
    { label: "fixed_assets add insurance_coverage",
      sql:   `ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS insurance_coverage TEXT` },
    { label: "fixed_assets manufacturing allocation config",
      sql:   `ALTER TABLE fixed_assets
                ADD COLUMN IF NOT EXISTS used_in_manufacturing BOOLEAN NOT NULL DEFAULT FALSE,
                ADD COLUMN IF NOT EXISTS manufacturing_allocation_method TEXT NOT NULL DEFAULT 'none',
                ADD COLUMN IF NOT EXISTS approved_operating_hours NUMERIC(14,4),
                ADD COLUMN IF NOT EXISTS fixed_manufacturing_rate NUMERIC(14,4);
              DO $$ BEGIN
                UPDATE fixed_assets SET manufacturing_allocation_method = 'none',
                  used_in_manufacturing = FALSE
                  WHERE manufacturing_allocation_method = 'production_quantity';
                ALTER TABLE fixed_assets DROP CONSTRAINT IF EXISTS fixed_assets_mfg_allocation_method_chk;
                ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_mfg_allocation_method_chk
                  CHECK (manufacturing_allocation_method IN ('none','operating_hours','fixed_hourly_rate'));
              EXCEPTION WHEN duplicate_object THEN NULL; END $$;` },
    // Source linkage (create-asset-from-purchase-invoice / from-JE): one LIVE
    // asset per (company, source doc, line). sold/scrapped excluded so a
    // disposed asset can be re-created from the same source if needed.
    { label: "fixed_assets source linkage unique index",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS uq_fixed_assets_source
              ON fixed_assets (company_id, source_type, source_document_id, COALESCE(source_line_id, 0))
              WHERE source_type IS NOT NULL AND status NOT IN ('sold','scrapped')` },

    // Phase 4 — webhooks + delivery log
    { label: "create gateway_webhooks",
      sql: `CREATE TABLE IF NOT EXISTS gateway_webhooks (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL REFERENCES gateway_clients(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        secret_enc TEXT NOT NULL,
        events JSONB NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        last_delivery_at TIMESTAMP,
        last_status TEXT,
        last_error TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0
      )` },
    { label: "create gateway_webhooks idx",
      sql: `CREATE INDEX IF NOT EXISTS gateway_webhooks_client_idx ON gateway_webhooks(client_id)` },
    { label: "create gateway_webhook_deliveries",
      sql: `CREATE TABLE IF NOT EXISTS gateway_webhook_deliveries (
        id SERIAL PRIMARY KEY,
        webhook_id INTEGER NOT NULL REFERENCES gateway_webhooks(id) ON DELETE CASCADE,
        event TEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        http_status INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        delivered_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "create gateway_webhook_deliveries idx",
      sql: `CREATE INDEX IF NOT EXISTS gateway_webhook_deliveries_webhook_idx ON gateway_webhook_deliveries(webhook_id, created_at)` },
    { label: "create gateway_webhook_deliveries status idx",
      sql: `CREATE INDEX IF NOT EXISTS gateway_webhook_deliveries_status_idx ON gateway_webhook_deliveries(status)` },

    // Phase A — integrations marketplace (Odoo, Salla, Generic REST + 8 stubs)
    { label: "create integration_connections",
      sql: `CREATE TABLE IF NOT EXISTS integration_connections (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'disconnected',
        base_url TEXT,
        credentials_enc TEXT,
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        inbound_token_hash TEXT,
        last_sync_at TIMESTAMP,
        last_sync_status TEXT,
        last_sync_error TEXT,
        total_syncs INTEGER NOT NULL DEFAULT 0,
        pull_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        pull_interval_minutes INTEGER NOT NULL DEFAULT 60,
        created_by INTEGER,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "create integration_connections company idx",
      sql: `CREATE INDEX IF NOT EXISTS integration_connections_company_idx ON integration_connections(company_id)` },
    { label: "create integration_connections provider idx",
      sql: `CREATE INDEX IF NOT EXISTS integration_connections_provider_idx ON integration_connections(provider)` },
    { label: "create integration_sync_runs",
      sql: `CREATE TABLE IF NOT EXISTS integration_sync_runs (
        id SERIAL PRIMARY KEY,
        connection_id INTEGER NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        started_at TIMESTAMP NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMP,
        invoices_ingested INTEGER NOT NULL DEFAULT 0,
        errors JSONB NOT NULL DEFAULT '[]'::jsonb,
        raw_response JSONB
      )` },
    { label: "create integration_sync_runs connection idx",
      sql: `CREATE INDEX IF NOT EXISTS integration_sync_runs_connection_idx ON integration_sync_runs(connection_id, started_at)` },

    { label: "alter journal_entries add createdBy",
      sql:   `ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS created_by INTEGER` },
    { label: "alter journal_entries add createdIp",
      sql:   `ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS created_ip TEXT` },
    { label: "alter journal_entries add createdUserAgent",
      sql:   `ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS created_user_agent TEXT` },
    { label: "alter journal_entries add postedBy",
      sql:   `ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS posted_by INTEGER` },
    { label: "alter journal_entries add postedAt",
      sql:   `ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS posted_at TIMESTAMP` },
    { label: "alter journal_entries add postedIp",
      sql:   `ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS posted_ip TEXT` },
    { label: "alter journal_entries add postedUserAgent",
      sql:   `ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS posted_user_agent TEXT` },

    // ── Document audit columns (created_by_id / posted_by_id / posted_at) ──
    // Mirrors the journal-entry pattern across the four key business
    // documents so the list grids can render "أنشأه" / "رحّله" columns.
    { label: "alter sales_invoices add postedById",
      sql:   `ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS posted_by_id INTEGER` },
    { label: "alter sales_invoices add postedAt",
      sql:   `ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS posted_at TIMESTAMP` },

    { label: "alter purchase_invoices add createdById",
      sql:   `ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS created_by_id INTEGER` },
    { label: "alter purchase_invoices add postedById",
      sql:   `ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS posted_by_id INTEGER` },
    { label: "alter purchase_invoices add postedAt",
      sql:   `ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS posted_at TIMESTAMP` },

    { label: "alter goods_receipts add createdById",
      sql:   `ALTER TABLE goods_receipts ADD COLUMN IF NOT EXISTS created_by_id INTEGER` },
    { label: "alter goods_receipts add postedById",
      sql:   `ALTER TABLE goods_receipts ADD COLUMN IF NOT EXISTS posted_by_id INTEGER` },
    { label: "alter goods_receipts add postedAt",
      sql:   `ALTER TABLE goods_receipts ADD COLUMN IF NOT EXISTS posted_at TIMESTAMP` },

    { label: "alter goods_deliveries add createdById",
      sql:   `ALTER TABLE goods_deliveries ADD COLUMN IF NOT EXISTS created_by_id INTEGER` },
    { label: "alter goods_deliveries add postedById",
      sql:   `ALTER TABLE goods_deliveries ADD COLUMN IF NOT EXISTS posted_by_id INTEGER` },
    { label: "alter goods_deliveries add postedAt",
      sql:   `ALTER TABLE goods_deliveries ADD COLUMN IF NOT EXISTS posted_at TIMESTAMP` },

    // ─── Windows Desktop POS (Task #174) — additive only ──────────────
    // Five new tables for offline POS + sync + licensing + per-device
    // invoice ranges + per-country download URLs. All gated behind
    // companies.enable_offline_pos (default false) so zero impact on
    // existing tenants until SuperAdmin opts a company in.
    { label: "create device_licenses table",
      sql:   `CREATE TABLE IF NOT EXISTS device_licenses (
        id                   SERIAL PRIMARY KEY,
        license_key          TEXT NOT NULL,
        company_id           INTEGER REFERENCES companies(id) ON DELETE SET NULL,
        device_id            INTEGER,
        status               TEXT NOT NULL DEFAULT 'unassigned',
        plan                 TEXT NOT NULL DEFAULT 'pos_full',
        max_devices          INTEGER NOT NULL DEFAULT 1,
        issued_at            TIMESTAMP NOT NULL DEFAULT NOW(),
        activated_at         TIMESTAMP,
        expires_at           TIMESTAMP,
        revoked_at           TIMESTAMP,
        notes                TEXT,
        created_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "device_licenses_key_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS device_licenses_key_uniq ON device_licenses (license_key)` },
    { label: "device_licenses_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS device_licenses_company_idx ON device_licenses (company_id)` },
    { label: "device_licenses_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS device_licenses_status_idx ON device_licenses (status)` },

    { label: "create pos_devices table",
      sql:   `CREATE TABLE IF NOT EXISTS pos_devices (
        id                   SERIAL PRIMARY KEY,
        company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        branch_id            INTEGER REFERENCES branches(id) ON DELETE SET NULL,
        device_name          TEXT NOT NULL,
        fingerprint_hash     TEXT NOT NULL,
        license_id           INTEGER REFERENCES device_licenses(id) ON DELETE SET NULL,
        device_token         TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'active',
        app_version          TEXT,
        os_info              TEXT,
        last_heartbeat_at    TIMESTAMP,
        last_seen_ip         TEXT,
        last_sync_at         TIMESTAMP,
        metadata             JSONB,
        created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMP NOT NULL DEFAULT NOW(),
        deactivated_at       TIMESTAMP
      )` },
    { label: "pos_devices_token_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS pos_devices_token_uniq ON pos_devices (device_token)` },
    { label: "pos_devices_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS pos_devices_company_idx ON pos_devices (company_id)` },
    { label: "pos_devices_fp_idx",
      sql:   `CREATE INDEX IF NOT EXISTS pos_devices_fp_idx ON pos_devices (company_id, fingerprint_hash)` },

    { label: "pos_sessions add last_heartbeat_at",
      sql:   `ALTER TABLE pos_sessions ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMP` },
    { label: "pos_sessions add close_reason",
      sql:   `ALTER TABLE pos_sessions ADD COLUMN IF NOT EXISTS close_reason TEXT` },
    { label: "pos_sessions_open_stale_idx",
      sql:   `CREATE INDEX IF NOT EXISTS pos_sessions_open_stale_idx ON pos_sessions (status, last_heartbeat_at) WHERE status = 'open'` },

    { label: "create sync_queue_log table",
      sql:   `CREATE TABLE IF NOT EXISTS sync_queue_log (
        id              SERIAL PRIMARY KEY,
        company_id      INTEGER REFERENCES companies(id) ON DELETE CASCADE,
        device_id       INTEGER REFERENCES pos_devices(id) ON DELETE SET NULL,
        direction       TEXT NOT NULL,
        entity_type     TEXT,
        payload_count   INTEGER NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'ok',
        error_message   TEXT,
        duration_ms     INTEGER,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "sync_queue_log_device_idx",
      sql:   `CREATE INDEX IF NOT EXISTS sync_queue_log_device_idx ON sync_queue_log (device_id, created_at)` },
    { label: "sync_queue_log_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS sync_queue_log_company_idx ON sync_queue_log (company_id, created_at)` },

    { label: "create device_invoice_ranges table",
      sql:   `CREATE TABLE IF NOT EXISTS device_invoice_ranges (
        id             SERIAL PRIMARY KEY,
        company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        device_id      INTEGER NOT NULL REFERENCES pos_devices(id) ON DELETE CASCADE,
        doc_type       TEXT NOT NULL DEFAULT 'pos_invoice',
        range_start    BIGINT NOT NULL,
        range_end      BIGINT NOT NULL,
        next_number    BIGINT NOT NULL,
        exhausted_at   TIMESTAMP,
        created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "device_invoice_ranges_device_idx",
      sql:   `CREATE INDEX IF NOT EXISTS device_invoice_ranges_device_idx ON device_invoice_ranges (device_id, doc_type)` },

    { label: "create download_releases table",
      sql:   `CREATE TABLE IF NOT EXISTS download_releases (
        id                 SERIAL PRIMARY KEY,
        country_code       TEXT NOT NULL,
        platform           TEXT NOT NULL DEFAULT 'win-x64',
        version            TEXT NOT NULL,
        download_url       TEXT NOT NULL,
        file_size_bytes    BIGINT,
        checksum_sha256    TEXT,
        release_notes      TEXT,
        is_active          BOOLEAN NOT NULL DEFAULT TRUE,
        published_at       TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "download_releases_country_platform_idx",
      sql:   `CREATE INDEX IF NOT EXISTS download_releases_country_platform_idx ON download_releases (country_code, platform, is_active)` },

    { label: "create mobile_app_releases table",
      sql:   `CREATE TABLE IF NOT EXISTS mobile_app_releases (
        id                 SERIAL PRIMARY KEY,
        platform           TEXT NOT NULL,
        latest_version     TEXT NOT NULL DEFAULT '1.0.0',
        min_version        TEXT NOT NULL DEFAULT '1.0.0',
        download_url       TEXT NOT NULL,
        is_active          BOOLEAN NOT NULL DEFAULT TRUE,
        created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "mobile_app_releases_platform_uq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS mobile_app_releases_platform_uq ON mobile_app_releases (platform)` },

    // ─── OSH / Safety module (see lib/db/src/schema/safety.ts). ISO 45001 core:
    // risk register + hierarchy of controls, incident management + 5-Whys, and
    // CAPA. No journal entries (operational, not financial). CREATE here because
    // ensureColumns only ALTERs existing tables. Idempotent — safe per boot.
    { label: "create safety_risk_assessments table",
      sql:   `CREATE TABLE IF NOT EXISTS safety_risk_assessments (
        id                  SERIAL PRIMARY KEY,
        company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        branch_id           INTEGER REFERENCES branches(id) ON DELETE SET NULL,
        code                TEXT NOT NULL,
        title               TEXT NOT NULL,
        process_area        TEXT,
        work_center_id      INTEGER REFERENCES work_centers(id) ON DELETE SET NULL,
        hazard_description  TEXT,
        hazard_category     TEXT NOT NULL DEFAULT 'other',
        likelihood          INTEGER NOT NULL DEFAULT 1,
        severity            INTEGER NOT NULL DEFAULT 1,
        risk_score          INTEGER NOT NULL DEFAULT 1,
        risk_level          TEXT NOT NULL DEFAULT 'low',
        existing_controls   TEXT,
        residual_likelihood INTEGER,
        residual_severity   INTEGER,
        residual_score      INTEGER,
        residual_level      TEXT,
        responsible_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        assessment_date     DATE,
        review_date         DATE,
        status              TEXT NOT NULL DEFAULT 'open',
        notes               TEXT,
        created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "safety_ra_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS safety_ra_company_idx ON safety_risk_assessments (company_id)` },
    { label: "safety_ra_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS safety_ra_status_idx ON safety_risk_assessments (company_id, status)` },

    { label: "create safety_risk_controls table",
      sql:   `CREATE TABLE IF NOT EXISTS safety_risk_controls (
        id            SERIAL PRIMARY KEY,
        company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        assessment_id INTEGER NOT NULL REFERENCES safety_risk_assessments(id) ON DELETE CASCADE,
        control_type  TEXT NOT NULL DEFAULT 'administrative',
        description   TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'planned',
        owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        due_date      DATE,
        created_at    TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "safety_rc_assessment_idx",
      sql:   `CREATE INDEX IF NOT EXISTS safety_rc_assessment_idx ON safety_risk_controls (assessment_id)` },

    { label: "create safety_incidents table",
      sql:   `CREATE TABLE IF NOT EXISTS safety_incidents (
        id                  SERIAL PRIMARY KEY,
        company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        branch_id           INTEGER REFERENCES branches(id) ON DELETE SET NULL,
        incident_number     TEXT NOT NULL,
        incident_type       TEXT NOT NULL DEFAULT 'near_miss',
        severity_class      TEXT NOT NULL DEFAULT 'no_treatment',
        title               TEXT NOT NULL,
        description         TEXT,
        location            TEXT,
        work_center_id      INTEGER REFERENCES work_centers(id) ON DELETE SET NULL,
        production_order_id INTEGER REFERENCES production_orders(id) ON DELETE SET NULL,
        injured_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        occurred_at         TIMESTAMP NOT NULL,
        reported_at         TIMESTAMP NOT NULL DEFAULT NOW(),
        reported_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        immediate_actions   TEXT,
        root_cause          TEXT,
        whys                JSONB DEFAULT '[]'::jsonb,
        lost_days           INTEGER NOT NULL DEFAULT 0,
        is_recordable       BOOLEAN NOT NULL DEFAULT FALSE,
        status              TEXT NOT NULL DEFAULT 'open',
        created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "safety_inc_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS safety_inc_company_idx ON safety_incidents (company_id)` },
    { label: "safety_inc_occurred_idx",
      sql:   `CREATE INDEX IF NOT EXISTS safety_inc_occurred_idx ON safety_incidents (company_id, occurred_at)` },

    { label: "create safety_incident_actions table",
      sql:   `CREATE TABLE IF NOT EXISTS safety_incident_actions (
        id           SERIAL PRIMARY KEY,
        company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        incident_id  INTEGER NOT NULL REFERENCES safety_incidents(id) ON DELETE CASCADE,
        action_type  TEXT NOT NULL DEFAULT 'corrective',
        description  TEXT NOT NULL,
        owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        due_date     DATE,
        status       TEXT NOT NULL DEFAULT 'open',
        completed_at TIMESTAMP,
        created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "safety_act_incident_idx",
      sql:   `CREATE INDEX IF NOT EXISTS safety_act_incident_idx ON safety_incident_actions (incident_id)` },

    // ─── taxes: dynamic tax catalog (see schema/taxes.ts). ensureColumns only
    // ALTERs existing tables, never CREATEs new ones, so we materialise the
    // table here. Idempotent — safe to re-run on every boot.
    { label: "create taxes table",
      sql:   `CREATE TABLE IF NOT EXISTS taxes (
        id                      SERIAL PRIMARY KEY,
        company_id              INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        code                    TEXT NOT NULL,
        name_ar                 TEXT NOT NULL,
        name_en                 TEXT,
        rate                    NUMERIC(9,4) NOT NULL DEFAULT '15',
        rate_type               TEXT NOT NULL DEFAULT 'percent',
        currency_code           TEXT,
        branch_id               INTEGER,
        cost_center             TEXT,
        account_id              INTEGER,
        sales_tax_account_id    INTEGER,
        purchase_tax_account_id INTEGER,
        is_active               BOOLEAN NOT NULL DEFAULT TRUE,
        is_default              BOOLEAN NOT NULL DEFAULT FALSE,
        is_system               BOOLEAN NOT NULL DEFAULT FALSE,
        notes                   TEXT,
        created_at              TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "taxes_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS taxes_company_idx ON taxes (company_id)` },
    // At most one default tax per company.
    { label: "taxes_company_default_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS taxes_company_default_uniq ON taxes (company_id) WHERE is_default = TRUE` },

    // ── Reseller (Agent) Network — Task #237 (additive only) ──────────────
    { label: "create resellers table",
      sql:   `CREATE TABLE IF NOT EXISTS resellers (
        id              SERIAL PRIMARY KEY,
        code            TEXT NOT NULL UNIQUE,
        name_ar         TEXT NOT NULL,
        name_en         TEXT,
        phone           TEXT,
        email           TEXT,
        address         TEXT,
        username        TEXT NOT NULL UNIQUE,
        password_hash   TEXT NOT NULL,
        session_token   TEXT,
        session_id      TEXT,
        commission_rate NUMERIC(6,3) NOT NULL DEFAULT '0',
        status          TEXT NOT NULL DEFAULT 'active',
        activated_at    DATE,
        permissions     JSONB NOT NULL DEFAULT '{}'::jsonb,
        notes           TEXT,
        is_active       BOOLEAN NOT NULL DEFAULT TRUE,
        last_login_at   TIMESTAMP,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "resellers_token_idx",
      sql:   `CREATE INDEX IF NOT EXISTS resellers_token_idx ON resellers (session_token)` },
    { label: "create reseller_companies table",
      sql:   `CREATE TABLE IF NOT EXISTS reseller_companies (
        id          SERIAL PRIMARY KEY,
        reseller_id INTEGER NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
        company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        linked_at   TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "reseller_companies_company_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS reseller_companies_company_uniq ON reseller_companies (company_id)` },
    { label: "reseller_companies_reseller_idx",
      sql:   `CREATE INDEX IF NOT EXISTS reseller_companies_reseller_idx ON reseller_companies (reseller_id)` },
    { label: "create reseller_commissions table",
      sql:   `CREATE TABLE IF NOT EXISTS reseller_commissions (
        id                SERIAL PRIMARY KEY,
        reseller_id       INTEGER NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
        company_id        INTEGER REFERENCES companies(id) ON DELETE SET NULL,
        subscription_id   INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
        event_type        TEXT NOT NULL,
        description       TEXT,
        base_amount       NUMERIC(15,2) NOT NULL DEFAULT '0',
        commission_rate   NUMERIC(6,3) NOT NULL DEFAULT '0',
        commission_amount NUMERIC(15,2) NOT NULL DEFAULT '0',
        period_month      INTEGER NOT NULL,
        period_year       INTEGER NOT NULL,
        status            TEXT NOT NULL DEFAULT 'accrued',
        created_at        TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "reseller_commissions_reseller_idx",
      sql:   `CREATE INDEX IF NOT EXISTS reseller_commissions_reseller_idx ON reseller_commissions (reseller_id)` },
    { label: "reseller_commissions_period_idx",
      sql:   `CREATE INDEX IF NOT EXISTS reseller_commissions_period_idx ON reseller_commissions (reseller_id, period_year, period_month)` },
    { label: "create reseller_tickets table",
      sql:   `CREATE TABLE IF NOT EXISTS reseller_tickets (
        id             SERIAL PRIMARY KEY,
        reseller_id    INTEGER NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
        company_id     INTEGER REFERENCES companies(id) ON DELETE SET NULL,
        subject        TEXT NOT NULL,
        body           TEXT NOT NULL,
        category       TEXT NOT NULL DEFAULT 'general',
        priority       TEXT NOT NULL DEFAULT 'normal',
        status         TEXT NOT NULL DEFAULT 'open',
        admin_reply    TEXT,
        admin_reply_at TIMESTAMP,
        created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "reseller_tickets_reseller_idx",
      sql:   `CREATE INDEX IF NOT EXISTS reseller_tickets_reseller_idx ON reseller_tickets (reseller_id)` },
    { label: "create reseller_activation_requests table",
      sql:   `CREATE TABLE IF NOT EXISTS reseller_activation_requests (
        id              SERIAL PRIMARY KEY,
        reseller_id     INTEGER NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
        company_name_ar TEXT NOT NULL,
        contact_phone   TEXT,
        contact_email   TEXT,
        plan            TEXT,
        notes           TEXT,
        status          TEXT NOT NULL DEFAULT 'pending',
        admin_note      TEXT,
        resolved_at     TIMESTAMP,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "reseller_activation_requests_reseller_idx",
      sql:   `CREATE INDEX IF NOT EXISTS reseller_activation_requests_reseller_idx ON reseller_activation_requests (reseller_id)` },

    // ── Developer & Partner Control Center — Phase 1 (additive; SA-only) ──
    { label: "create platform_partners table",
      sql:   `CREATE TABLE IF NOT EXISTS platform_partners (
        id                  SERIAL PRIMARY KEY,
        kind                TEXT NOT NULL DEFAULT 'developer',
        partner_code        TEXT UNIQUE,
        name_ar             TEXT NOT NULL,
        name_en             TEXT,
        contact_name        TEXT,
        phone               TEXT,
        email               TEXT,
        address             TEXT,
        website             TEXT,
        commission_rate     NUMERIC(6,3) NOT NULL DEFAULT 0,
        status              TEXT NOT NULL DEFAULT 'draft',
        permissions         JSONB NOT NULL DEFAULT '{}',
        notes               TEXT,
        approved_at         TIMESTAMP,
        partner_id_issued_at TIMESTAMP,
        is_active           BOOLEAN NOT NULL DEFAULT TRUE,
        created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "platform_partners_kind_idx",
      sql:   `CREATE INDEX IF NOT EXISTS platform_partners_kind_idx ON platform_partners (kind)` },
    { label: "platform_partners_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS platform_partners_status_idx ON platform_partners (status)` },
    // Self-service portal credentials (additive — see partners.ts). Each ALTER
    // is independent + IF NOT EXISTS so re-runs and partial states are safe.
    { label: "platform_partners.username",
      sql:   `ALTER TABLE platform_partners ADD COLUMN IF NOT EXISTS username TEXT` },
    { label: "platform_partners.password_hash",
      sql:   `ALTER TABLE platform_partners ADD COLUMN IF NOT EXISTS password_hash TEXT` },
    { label: "platform_partners.session_token",
      sql:   `ALTER TABLE platform_partners ADD COLUMN IF NOT EXISTS session_token TEXT` },
    { label: "platform_partners.session_id",
      sql:   `ALTER TABLE platform_partners ADD COLUMN IF NOT EXISTS session_id TEXT` },
    { label: "platform_partners.last_login_at",
      sql:   `ALTER TABLE platform_partners ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP` },
    { label: "platform_partners_username_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS platform_partners_username_uniq ON platform_partners (username) WHERE username IS NOT NULL` },
    { label: "platform_partners_session_token_idx",
      sql:   `CREATE INDEX IF NOT EXISTS platform_partners_session_token_idx ON platform_partners (session_token)` },
    { label: "create partner_documents table",
      sql:   `CREATE TABLE IF NOT EXISTS partner_documents (
        id          SERIAL PRIMARY KEY,
        partner_id  INTEGER NOT NULL REFERENCES platform_partners(id) ON DELETE CASCADE,
        doc_type    TEXT NOT NULL,
        title       TEXT,
        file_url    TEXT,
        status      TEXT NOT NULL DEFAULT 'pending',
        note        TEXT,
        reviewed_at TIMESTAMP,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "partner_documents_partner_idx",
      sql:   `CREATE INDEX IF NOT EXISTS partner_documents_partner_idx ON partner_documents (partner_id)` },
    { label: "create partner_companies table",
      sql:   `CREATE TABLE IF NOT EXISTS partner_companies (
        id         SERIAL PRIMARY KEY,
        partner_id INTEGER NOT NULL REFERENCES platform_partners(id) ON DELETE CASCADE,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        role       TEXT NOT NULL DEFAULT 'served',
        linked_at  TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "partner_companies_pair_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS partner_companies_pair_uniq ON partner_companies (partner_id, company_id)` },
    { label: "partner_companies_partner_idx",
      sql:   `CREATE INDEX IF NOT EXISTS partner_companies_partner_idx ON partner_companies (partner_id)` },
    { label: "partner_companies_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS partner_companies_company_idx ON partner_companies (company_id)` },
    { label: "create partner_commissions table",
      sql:   `CREATE TABLE IF NOT EXISTS partner_commissions (
        id                SERIAL PRIMARY KEY,
        partner_id        INTEGER NOT NULL REFERENCES platform_partners(id) ON DELETE CASCADE,
        company_id        INTEGER REFERENCES companies(id) ON DELETE SET NULL,
        extension_id      TEXT,
        event_type        TEXT NOT NULL,
        description       TEXT,
        base_amount       NUMERIC(15,2) NOT NULL DEFAULT 0,
        commission_rate   NUMERIC(6,3) NOT NULL DEFAULT 0,
        commission_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
        period_month      INTEGER NOT NULL,
        period_year       INTEGER NOT NULL,
        status            TEXT NOT NULL DEFAULT 'accrued',
        created_at        TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "partner_commissions_partner_idx",
      sql:   `CREATE INDEX IF NOT EXISTS partner_commissions_partner_idx ON partner_commissions (partner_id)` },
    { label: "partner_commissions_period_idx",
      sql:   `CREATE INDEX IF NOT EXISTS partner_commissions_period_idx ON partner_commissions (partner_id, period_year, period_month)` },

    // ── Extension Platform — Phase 0 (additive "outer shell"; default OFF) ──
    { label: "create platform_extensions table",
      sql:   `CREATE TABLE IF NOT EXISTS platform_extensions (
        id            SERIAL PRIMARY KEY,
        extension_id  TEXT NOT NULL UNIQUE,
        name_ar       TEXT NOT NULL,
        name_en       TEXT,
        version       TEXT NOT NULL DEFAULT '1.0.0',
        vendor        TEXT,
        manifest      JSONB NOT NULL,
        signature     TEXT,
        public_key_id TEXT,
        status        TEXT NOT NULL DEFAULT 'active',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
    { label: "create company_extensions table",
      sql:   `CREATE TABLE IF NOT EXISTS company_extensions (
        id           SERIAL PRIMARY KEY,
        company_id   INTEGER NOT NULL,
        extension_id TEXT NOT NULL,
        enabled      BOOLEAN NOT NULL DEFAULT FALSE,
        settings     JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
    { label: "company_extensions_company_ext_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS company_extensions_company_ext_uniq ON company_extensions (company_id, extension_id)` },
    { label: "create ext_data table",
      sql:   `CREATE TABLE IF NOT EXISTS ext_data (
        id           SERIAL PRIMARY KEY,
        company_id   INTEGER,
        extension_id TEXT NOT NULL,
        key          TEXT NOT NULL,
        value        JSONB,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
    { label: "ext_data_scope_idx",
      sql:   `CREATE INDEX IF NOT EXISTS ext_data_scope_idx ON ext_data (company_id, extension_id, key)` },
    // ── Extension Platform — Phase 2 runtime: ext_records ("ext_* tables") ──
    { label: "create ext_records table",
      sql:   `CREATE TABLE IF NOT EXISTS ext_records (
        id           SERIAL PRIMARY KEY,
        company_id   INTEGER NOT NULL,
        extension_id TEXT NOT NULL,
        collection   TEXT NOT NULL,
        record_id    TEXT NOT NULL,
        data         JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
    { label: "ext_records_scope_idx",
      sql:   `CREATE INDEX IF NOT EXISTS ext_records_scope_idx ON ext_records (company_id, extension_id, collection)` },
    { label: "ext_records_record_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS ext_records_record_uniq ON ext_records (company_id, extension_id, collection, record_id)` },

    // ── Developer Cloud (Workspaces) — Phase 5 (additive; SA-only) ───────────
    // One isolated workspace per partner company (sandbox + git + storage + test
    // env), multi-role developer seats, and Publish-engine-only deployments.
    // Stores only opaque provider references — never credentials/SSH/RDP/DB.
    { label: "create dev_workspaces table",
      sql:   `CREATE TABLE IF NOT EXISTS dev_workspaces (
        id                    SERIAL PRIMARY KEY,
        company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        provider              TEXT NOT NULL DEFAULT 'replit',
        external_workspace_id TEXT,
        sandbox_id            TEXT,
        git_repo_url          TEXT,
        storage_bucket        TEXT,
        test_env_url          TEXT,
        region                TEXT,
        tier                  TEXT NOT NULL DEFAULT 'standard',
        status                TEXT NOT NULL DEFAULT 'pending',
        provisioned_at        TIMESTAMP,
        last_error            TEXT,
        notes                 TEXT,
        is_active             BOOLEAN NOT NULL DEFAULT TRUE,
        created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "dev_workspaces_company_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS dev_workspaces_company_uniq ON dev_workspaces (company_id)` },
    { label: "dev_workspaces_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS dev_workspaces_status_idx ON dev_workspaces (status)` },
    { label: "create dev_workspace_seats table",
      sql:   `CREATE TABLE IF NOT EXISTS dev_workspace_seats (
        id           SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES dev_workspaces(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        email        TEXT NOT NULL,
        role         TEXT NOT NULL DEFAULT 'backend',
        permissions  JSONB NOT NULL DEFAULT '{}',
        status       TEXT NOT NULL DEFAULT 'active',
        invited_at   TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "dev_workspace_seats_ws_email_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS dev_workspace_seats_ws_email_uniq ON dev_workspace_seats (workspace_id, email)` },
    { label: "dev_workspace_seats_workspace_idx",
      sql:   `CREATE INDEX IF NOT EXISTS dev_workspace_seats_workspace_idx ON dev_workspace_seats (workspace_id)` },
    { label: "create dev_deployments table",
      sql:   `CREATE TABLE IF NOT EXISTS dev_deployments (
        id                   SERIAL PRIMARY KEY,
        workspace_id         INTEGER NOT NULL REFERENCES dev_workspaces(id) ON DELETE CASCADE,
        environment          TEXT NOT NULL DEFAULT 'test',
        ref                  TEXT,
        status               TEXT NOT NULL DEFAULT 'queued',
        method               TEXT NOT NULL DEFAULT 'publish_engine',
        triggered_by_seat_id INTEGER REFERENCES dev_workspace_seats(id) ON DELETE SET NULL,
        notes                TEXT,
        last_error           TEXT,
        published_at         TIMESTAMP,
        created_at           TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "dev_deployments_workspace_idx",
      sql:   `CREATE INDEX IF NOT EXISTS dev_deployments_workspace_idx ON dev_deployments (workspace_id)` },
    { label: "dev_deployments_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS dev_deployments_status_idx ON dev_deployments (status)` },
    // ── Extension Platform — Phase 3: Publish Engine (extension_publishes) ──
    { label: "create extension_publishes table",
      sql:   `CREATE TABLE IF NOT EXISTS extension_publishes (
        id                  SERIAL PRIMARY KEY,
        extension_id        TEXT NOT NULL,
        version             TEXT NOT NULL,
        partner_id          INTEGER,
        submitted_manifest  JSONB NOT NULL,
        status              TEXT NOT NULL DEFAULT 'pending',
        current_stage       TEXT,
        gates               JSONB NOT NULL DEFAULT '[]'::jsonb,
        report              JSONB,
        package_digest      TEXT,
        signature           TEXT,
        public_key_id       TEXT,
        deployed_at         TIMESTAMPTZ,
        created_by          INTEGER,
        created_by_username TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
    { label: "extension_publishes_extension_idx",
      sql:   `CREATE INDEX IF NOT EXISTS extension_publishes_extension_idx ON extension_publishes (extension_id)` },
    { label: "extension_publishes_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS extension_publishes_status_idx ON extension_publishes (status)` },
    { label: "extension_publishes_created_idx",
      sql:   `CREATE INDEX IF NOT EXISTS extension_publishes_created_idx ON extension_publishes (created_at)` },

    // ── Marketplace — Phase 4: App Store (extension_listings / extension_purchases) ──
    { label: "create extension_listings table",
      sql:   `CREATE TABLE IF NOT EXISTS extension_listings (
        id              SERIAL PRIMARY KEY,
        extension_id    TEXT NOT NULL UNIQUE,
        partner_id      INTEGER,
        category        TEXT NOT NULL DEFAULT 'other',
        summary_ar      TEXT,
        summary_en      TEXT,
        description_ar  TEXT,
        icon_url        TEXT,
        pricing_model   TEXT NOT NULL DEFAULT 'free',
        price           NUMERIC(15,2) NOT NULL DEFAULT 0,
        currency        TEXT NOT NULL DEFAULT 'SAR',
        commission_rate NUMERIC(6,3),
        status          TEXT NOT NULL DEFAULT 'draft',
        featured        BOOLEAN NOT NULL DEFAULT FALSE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
    { label: "extension_listings_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS extension_listings_status_idx ON extension_listings (status)` },
    { label: "extension_listings_partner_idx",
      sql:   `CREATE INDEX IF NOT EXISTS extension_listings_partner_idx ON extension_listings (partner_id)` },
    { label: "create extension_purchases table",
      sql:   `CREATE TABLE IF NOT EXISTS extension_purchases (
        id                   SERIAL PRIMARY KEY,
        company_id           INTEGER NOT NULL,
        extension_id         TEXT NOT NULL,
        listing_id           INTEGER,
        partner_id           INTEGER,
        pricing_model        TEXT NOT NULL DEFAULT 'free',
        amount               NUMERIC(15,2) NOT NULL DEFAULT 0,
        currency             TEXT NOT NULL DEFAULT 'SAR',
        commission_rate      NUMERIC(6,3) NOT NULL DEFAULT 0,
        commission_amount    NUMERIC(15,2) NOT NULL DEFAULT 0,
        status               TEXT NOT NULL DEFAULT 'active',
        billing_cycle_end    TIMESTAMPTZ,
        purchased_by         INTEGER,
        purchased_by_username TEXT,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
    { label: "extension_purchases_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS extension_purchases_company_idx ON extension_purchases (company_id)` },
    { label: "extension_purchases_scope_idx",
      sql:   `CREATE INDEX IF NOT EXISTS extension_purchases_scope_idx ON extension_purchases (company_id, extension_id)` },
    { label: "extension_purchases_partner_idx",
      sql:   `CREATE INDEX IF NOT EXISTS extension_purchases_partner_idx ON extension_purchases (partner_id)` },

    // ── DevStudio — "التطوير من خلال زاكود" (additive, SuperAdmin-governed) ──
    { label: "create dev_studio_packages table",
      sql:   `CREATE TABLE IF NOT EXISTS dev_studio_packages (
        id               SERIAL PRIMARY KEY,
        name_ar          TEXT NOT NULL,
        name_en          TEXT,
        offices          INTEGER NOT NULL DEFAULT 1,
        units            INTEGER NOT NULL DEFAULT 1,
        read_line_quota  INTEGER NOT NULL DEFAULT 5000,
        write_line_quota INTEGER NOT NULL DEFAULT 1000,
        price_monthly    INTEGER NOT NULL DEFAULT 0,
        price_annual     INTEGER NOT NULL DEFAULT 0,
        is_active        BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order       INTEGER NOT NULL DEFAULT 0,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
    { label: "dev_studio_packages_active_idx",
      sql:   `CREATE INDEX IF NOT EXISTS dev_studio_packages_active_idx ON dev_studio_packages (is_active)` },

    { label: "create dev_studio_developers table",
      sql:   `CREATE TABLE IF NOT EXISTS dev_studio_developers (
        id               SERIAL PRIMARY KEY,
        name             TEXT NOT NULL,
        phone            TEXT NOT NULL,
        country          TEXT NOT NULL,
        package_id       INTEGER REFERENCES dev_studio_packages(id) ON DELETE SET NULL,
        password_hash    TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'pending',
        entitlements     JSONB,
        billing_cycle    TEXT NOT NULL DEFAULT 'monthly',
        snapshot_id      INTEGER,
        nda_accepted_at  TIMESTAMPTZ,
        approved_at      TIMESTAMPTZ,
        suspended_at     TIMESTAMPTZ,
        notes            TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
    { label: "dev_studio_developers_phone_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS dev_studio_developers_phone_uniq ON dev_studio_developers (phone)` },
    { label: "dev_studio_developers_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS dev_studio_developers_status_idx ON dev_studio_developers (status)` },

    { label: "create dev_studio_visibility table",
      sql:   `CREATE TABLE IF NOT EXISTS dev_studio_visibility (
        id           SERIAL PRIMARY KEY,
        developer_id INTEGER NOT NULL REFERENCES dev_studio_developers(id) ON DELETE CASCADE,
        path_prefix  TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
    { label: "dev_studio_visibility_dev_path_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS dev_studio_visibility_dev_path_uniq ON dev_studio_visibility (developer_id, path_prefix)` },
    { label: "dev_studio_visibility_dev_idx",
      sql:   `CREATE INDEX IF NOT EXISTS dev_studio_visibility_dev_idx ON dev_studio_visibility (developer_id)` },

    { label: "create dev_studio_snapshots table",
      sql:   `CREATE TABLE IF NOT EXISTS dev_studio_snapshots (
        id           SERIAL PRIMARY KEY,
        version      TEXT NOT NULL,
        label        TEXT,
        status       TEXT NOT NULL DEFAULT 'draft',
        file_count   INTEGER NOT NULL DEFAULT 0,
        byte_size    INTEGER NOT NULL DEFAULT 0,
        content      TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published_at TIMESTAMPTZ
      )` },
    { label: "dev_studio_snapshots_version_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS dev_studio_snapshots_version_uniq ON dev_studio_snapshots (version)` },
    { label: "dev_studio_snapshots_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS dev_studio_snapshots_status_idx ON dev_studio_snapshots (status)` },

    { label: "create dev_studio_sessions table",
      sql:   `CREATE TABLE IF NOT EXISTS dev_studio_sessions (
        id           SERIAL PRIMARY KEY,
        developer_id INTEGER NOT NULL REFERENCES dev_studio_developers(id) ON DELETE CASCADE,
        token        TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'active',
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
    { label: "dev_studio_sessions_token_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS dev_studio_sessions_token_uniq ON dev_studio_sessions (token)` },
    { label: "dev_studio_sessions_dev_idx",
      sql:   `CREATE INDEX IF NOT EXISTS dev_studio_sessions_dev_idx ON dev_studio_sessions (developer_id)` },

    { label: "create dev_studio_usage table",
      sql:   `CREATE TABLE IF NOT EXISTS dev_studio_usage (
        id               SERIAL PRIMARY KEY,
        developer_id     INTEGER NOT NULL REFERENCES dev_studio_developers(id) ON DELETE CASCADE,
        period_key       TEXT NOT NULL,
        read_lines_used  INTEGER NOT NULL DEFAULT 0,
        write_lines_used INTEGER NOT NULL DEFAULT 0,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
    { label: "dev_studio_usage_dev_period_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS dev_studio_usage_dev_period_uniq ON dev_studio_usage (developer_id, period_key)` },

    // ── Employee portal (zacodehr) credentials + HR seat limit ─────────────
    { label: "employees.login_username",
      sql:   `ALTER TABLE employees ADD COLUMN IF NOT EXISTS login_username TEXT` },
    { label: "employees.login_password_hash",
      sql:   `ALTER TABLE employees ADD COLUMN IF NOT EXISTS login_password_hash TEXT` },
    { label: "employees.portal_active",
      sql:   `ALTER TABLE employees ADD COLUMN IF NOT EXISTS portal_active BOOLEAN DEFAULT TRUE` },
    { label: "subscriptions.max_hr_users",
      sql:   `ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS max_hr_users INTEGER NOT NULL DEFAULT 10` },
    { label: "employees.user_id",
      sql:   `ALTER TABLE employees ADD COLUMN IF NOT EXISTS user_id INTEGER` },
    // One ERP user ↔ at most one employee per company (تقرير حضوري الموبايل).
    { label: "employees_company_user_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS employees_company_user_uniq ON employees (company_id, user_id) WHERE user_id IS NOT NULL` },
    // ZacodeHR portal face punch (بصمة الوجه في بوابة الموظف)
    { label: "attendance_ai_settings.portal_face_required",
      sql:   `ALTER TABLE attendance_ai_settings ADD COLUMN IF NOT EXISTS portal_face_required BOOLEAN NOT NULL DEFAULT false` },
    { label: "attendance_movements.selfie_url",
      sql:   `ALTER TABLE attendance_movements ADD COLUMN IF NOT EXISTS selfie_url TEXT` },
    { label: "attendance_movements.face_verified",
      sql:   `ALTER TABLE attendance_movements ADD COLUMN IF NOT EXISTS face_verified BOOLEAN` },
    // Auto-absence policy (اعتبار المتأخر غائباً بعد X دقيقة)
    { label: "attendance_ai_settings.absent_after_min",
      sql:   `ALTER TABLE attendance_ai_settings ADD COLUMN IF NOT EXISTS absent_after_min INTEGER` },
    { label: "employees_company_login_username_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS employees_company_login_username_uniq ON employees (company_id, lower(login_username)) WHERE login_username IS NOT NULL` },

    { label: "create dev_studio_audit table",
      sql:   `CREATE TABLE IF NOT EXISTS dev_studio_audit (
        id           SERIAL PRIMARY KEY,
        developer_id INTEGER REFERENCES dev_studio_developers(id) ON DELETE SET NULL,
        action       TEXT NOT NULL,
        path         TEXT,
        lines        INTEGER NOT NULL DEFAULT 0,
        detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
    { label: "dev_studio_audit_dev_idx",
      sql:   `CREATE INDEX IF NOT EXISTS dev_studio_audit_dev_idx ON dev_studio_audit (developer_id)` },
    { label: "dev_studio_audit_action_idx",
      sql:   `CREATE INDEX IF NOT EXISTS dev_studio_audit_action_idx ON dev_studio_audit (action)` },

    { label: "create dev_studio_proposals table",
      sql:   `CREATE TABLE IF NOT EXISTS dev_studio_proposals (
        id           SERIAL PRIMARY KEY,
        developer_id INTEGER NOT NULL REFERENCES dev_studio_developers(id) ON DELETE CASCADE,
        snapshot_id  INTEGER REFERENCES dev_studio_snapshots(id) ON DELETE SET NULL,
        title        TEXT NOT NULL,
        description  TEXT,
        target_path  TEXT,
        diff         TEXT,
        status       TEXT NOT NULL DEFAULT 'draft',
        write_lines  INTEGER NOT NULL DEFAULT 0,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        submitted_at TIMESTAMPTZ
      )` },
    { label: "dev_studio_proposals_dev_idx",
      sql:   `CREATE INDEX IF NOT EXISTS dev_studio_proposals_dev_idx ON dev_studio_proposals (developer_id)` },
    { label: "dev_studio_proposals_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS dev_studio_proposals_status_idx ON dev_studio_proposals (status)` },
    // Phase 2 — SuperAdmin review/approval gate (additive columns).
    { label: "dev_studio_proposals.review_report",
      sql:   `ALTER TABLE dev_studio_proposals ADD COLUMN IF NOT EXISTS review_report JSONB` },
    { label: "dev_studio_proposals.review_verdict",
      sql:   `ALTER TABLE dev_studio_proposals ADD COLUMN IF NOT EXISTS review_verdict TEXT` },
    { label: "dev_studio_proposals.diff_hash",
      sql:   `ALTER TABLE dev_studio_proposals ADD COLUMN IF NOT EXISTS diff_hash TEXT` },
    { label: "dev_studio_proposals.reviewed_by",
      sql:   `ALTER TABLE dev_studio_proposals ADD COLUMN IF NOT EXISTS reviewed_by INTEGER` },
    { label: "dev_studio_proposals.reviewed_at",
      sql:   `ALTER TABLE dev_studio_proposals ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ` },
    { label: "dev_studio_proposals.decision_reason",
      sql:   `ALTER TABLE dev_studio_proposals ADD COLUMN IF NOT EXISTS decision_reason TEXT` },
    // ─── قاعة التدريب المباشر (LiveKit training room) — additive module ───
    { label: "create training_sessions table",
      sql:   `CREATE TABLE IF NOT EXISTS training_sessions (
        id               SERIAL PRIMARY KEY,
        company_id       INTEGER NOT NULL,
        trainer_user_id  INTEGER NOT NULL,
        trainer_name     TEXT,
        title            TEXT NOT NULL,
        description      TEXT,
        room_name        TEXT NOT NULL UNIQUE,
        status           TEXT NOT NULL DEFAULT 'scheduled',
        allow_registered BOOLEAN NOT NULL DEFAULT TRUE,
        allow_public     BOOLEAN NOT NULL DEFAULT FALSE,
        public_token     TEXT UNIQUE,
        scheduled_at     TIMESTAMPTZ,
        started_at       TIMESTAMPTZ,
        ended_at         TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        meta             JSONB
      )` },
    { label: "training_sessions_company_idx",
      sql:   `CREATE INDEX IF NOT EXISTS training_sessions_company_idx ON training_sessions (company_id, created_at)` },
    { label: "training_sessions_status_idx",
      sql:   `CREATE INDEX IF NOT EXISTS training_sessions_status_idx ON training_sessions (status)` },
    { label: "create training_attendance table",
      sql:   `CREATE TABLE IF NOT EXISTS training_attendance (
        id           SERIAL PRIMARY KEY,
        session_id   INTEGER NOT NULL,
        company_id   INTEGER NOT NULL,
        user_id      INTEGER,
        display_name TEXT NOT NULL,
        identity     TEXT NOT NULL,
        is_public    BOOLEAN NOT NULL DEFAULT FALSE,
        joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        left_at      TIMESTAMPTZ
      )` },
    { label: "training_attendance_session_idx",
      sql:   `CREATE INDEX IF NOT EXISTS training_attendance_session_idx ON training_attendance (session_id, joined_at)` },
    // ─── سجل مكالمات الدعم الفني (LiveKit support room) ───
    { label: "create support_call_logs table",
      sql:   `CREATE TABLE IF NOT EXISTS support_call_logs (
        id                SERIAL PRIMARY KEY,
        agent_user_id     INTEGER NOT NULL,
        agent_username    TEXT,
        target_user_id    INTEGER,
        target_company_id INTEGER,
        target_label      TEXT,
        room_name         TEXT NOT NULL UNIQUE,
        status            TEXT NOT NULL DEFAULT 'pending',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        joined_at         TIMESTAMPTZ,
        ended_at          TIMESTAMPTZ,
        end_reason        TEXT,
        meta              JSONB
      )` },
    { label: "support_call_logs_agent_idx",
      sql:   `CREATE INDEX IF NOT EXISTS support_call_logs_agent_idx ON support_call_logs (agent_user_id, created_at)` },
    { label: "support_call_logs_target_idx",
      sql:   `CREATE INDEX IF NOT EXISTS support_call_logs_target_idx ON support_call_logs (target_user_id, created_at)` },
    // ─── سيرفرات الوكلاء (Agent Instances — SuperAdmin platform module) ───
    { label: "create agent_instances table",
      sql:   `CREATE TABLE IF NOT EXISTS agent_instances (
        id                 SERIAL PRIMARY KEY,
        name               TEXT NOT NULL,
        contact_phone      TEXT,
        contact_email      TEXT,
        domain             TEXT NOT NULL,
        extra_domains      JSONB,
        auto_domain_setup  BOOLEAN NOT NULL DEFAULT FALSE,
        auto_domain_proxy_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        auto_domain_status TEXT NOT NULL DEFAULT 'disabled',
        auto_domain_zone_name TEXT,
        auto_domain_zone_id TEXT,
        auto_domain_record_id TEXT,
        auto_domain_origin_ip TEXT,
        auto_domain_last_check_at TIMESTAMP,
        auto_domain_last_success_at TIMESTAMP,
        auto_domain_last_error TEXT,
        auto_domain_log TEXT,
        auto_domain_lease_at TIMESTAMP,
        status             TEXT NOT NULL DEFAULT 'active',
        mode               TEXT NOT NULL DEFAULT 'frontend_only',
        package_source     TEXT NOT NULL DEFAULT 'central',
        local_superadmin_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        local_superadmin_screens JSONB,
        external_package_meta JSONB,
        installation_id    TEXT NOT NULL,
        license_key        TEXT,
        license_expires_at TIMESTAMP,
        max_companies      INTEGER,
        db_url_enc         TEXT,
        db_status          TEXT NOT NULL DEFAULT 'not_configured',
        db_last_check_at   TIMESTAMP,
        db_last_error      TEXT,
        db_fingerprint     TEXT,
        ssh_host           TEXT,
        ssh_port           INTEGER,
        ssh_user           TEXT,
        ssh_secret_enc     TEXT,
        ssh_status         TEXT NOT NULL DEFAULT 'not_configured',
        ssh_last_check_at  TIMESTAMP,
        brand_name         TEXT,
        brand_logo_url     TEXT,
        brand_color        TEXT,
        last_heartbeat_at  TIMESTAMP,
        last_seen_ip       TEXT,
        deployed_version   TEXT,
        notes              TEXT,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "agent_instances.local_superadmin_enabled column",
      sql:   `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS local_superadmin_enabled BOOLEAN NOT NULL DEFAULT TRUE` },
    { label: "agent_instances.local_superadmin_screens column",
      sql:   `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS local_superadmin_screens JSONB` },
    { label: "agent_instances.auto_domain_setup column",
      sql:   `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS auto_domain_setup BOOLEAN NOT NULL DEFAULT FALSE` },
    { label: "agent_instances.auto_domain_proxy_enabled column",
      sql:   `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS auto_domain_proxy_enabled BOOLEAN NOT NULL DEFAULT FALSE` },
    { label: "agent_instances.auto_domain_status column",
      sql:   `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS auto_domain_status TEXT NOT NULL DEFAULT 'disabled'` },
    { label: "agent_instances.auto_domain_zone_name column",
      sql:   `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS auto_domain_zone_name TEXT` },
    { label: "agent_instances.auto_domain_zone_id column",
      sql:   `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS auto_domain_zone_id TEXT` },
    { label: "agent_instances.auto_domain_record_id column",
      sql:   `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS auto_domain_record_id TEXT` },
    { label: "agent_instances.auto_domain_origin_ip column",
      sql:   `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS auto_domain_origin_ip TEXT` },
    { label: "agent_instances.auto_domain_last_check_at column",
      sql:   `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS auto_domain_last_check_at TIMESTAMP` },
    { label: "agent_instances.auto_domain_last_success_at column",
      sql:   `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS auto_domain_last_success_at TIMESTAMP` },
    { label: "agent_instances.auto_domain_last_error column",
      sql:   `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS auto_domain_last_error TEXT` },
    { label: "agent_instances.auto_domain_log column",
      sql:   `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS auto_domain_log TEXT` },
    { label: "agent_instances.auto_domain_lease_at column",
      sql:   `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS auto_domain_lease_at TIMESTAMP` },
    { label: "agent_instances.deploy_lease_id column",
      sql:   `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS deploy_lease_id TEXT` },
    { label: "agent_instances.deploy_operation_phase column",
      sql:   `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS deploy_operation_phase TEXT` },
    { label: "agent_instances.deploy_provider_mutation_until column",
      sql:   `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS deploy_provider_mutation_until TIMESTAMP` },
    { label: "agent_instances_domain_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS agent_instances_domain_uniq ON agent_instances (domain)` },
    { label: "agent_instances_install_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS agent_instances_install_uniq ON agent_instances (installation_id)` },
    { label: "create agent_security_events table",
      sql:   `CREATE TABLE IF NOT EXISTS agent_security_events (
        id         SERIAL PRIMARY KEY,
        agent_id   INTEGER REFERENCES agent_instances(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        detail     JSONB,
        host       TEXT,
        ip         TEXT,
        resolved   BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "agent_security_events_agent_idx",
      sql:   `CREATE INDEX IF NOT EXISTS agent_security_events_agent_idx ON agent_security_events (agent_id, created_at DESC)` },
    { label: "create agent_platform_link_invites table",
      sql:   `CREATE TABLE IF NOT EXISTS agent_platform_link_invites (
        invite_id TEXT PRIMARY KEY, target_platform_id TEXT NOT NULL, target_origin TEXT NOT NULL,
        secret_verifier TEXT NOT NULL, secret_enc TEXT NOT NULL, expires_at TIMESTAMP NOT NULL, consumed_at TIMESTAMP,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "agent_platform_link_invites.secret_enc column",
      sql:   `ALTER TABLE agent_platform_link_invites ADD COLUMN IF NOT EXISTS secret_enc TEXT` },
    { label: "agent_platform_link_invites_expiry_idx",
      sql:   `CREATE INDEX IF NOT EXISTS agent_platform_link_invites_expiry_idx ON agent_platform_link_invites (expires_at)` },
    { label: "create agent_controller_links table",
      sql:   `CREATE TABLE IF NOT EXISTS agent_controller_links (
        id SERIAL PRIMARY KEY, link_id TEXT NOT NULL, direction TEXT NOT NULL,
        local_agent_id INTEGER REFERENCES agent_instances(id) ON DELETE CASCADE,
        source_platform_id TEXT NOT NULL, source_origin TEXT NOT NULL,
        target_platform_id TEXT NOT NULL, target_origin TEXT NOT NULL,
        name TEXT NOT NULL, domain TEXT NOT NULL, extra_domains JSONB,
        installation_id TEXT NOT NULL, db_fingerprint TEXT, license_verifier TEXT NOT NULL,
        controller_token_verifier TEXT NOT NULL, controller_token_enc TEXT,
        platform_control_token_verifier TEXT, platform_control_token_enc TEXT,
        source_signing_public_key TEXT, source_signing_private_key_enc TEXT,
        license_expires_at TIMESTAMP, max_companies INTEGER, agent_version TEXT,
        status TEXT NOT NULL, package_source TEXT NOT NULL,
        controller_epoch INTEGER NOT NULL DEFAULT 0, active_controller_id TEXT NOT NULL,
        last_heartbeat_at TIMESTAMP, last_seen_ip TEXT, deployed_version TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(), updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "agent_controller_links.controller_token_verifier column",
      sql:   `ALTER TABLE agent_controller_links ADD COLUMN IF NOT EXISTS controller_token_verifier TEXT` },
    { label: "agent_controller_links.controller_token_enc column",
      sql:   `ALTER TABLE agent_controller_links ADD COLUMN IF NOT EXISTS controller_token_enc TEXT` },
    { label: "agent_controller_links.platform control columns",
      sql:   `ALTER TABLE agent_controller_links
        ADD COLUMN IF NOT EXISTS platform_control_token_verifier TEXT,
        ADD COLUMN IF NOT EXISTS platform_control_token_enc TEXT,
        ADD COLUMN IF NOT EXISTS source_signing_public_key TEXT,
        ADD COLUMN IF NOT EXISTS source_signing_private_key_enc TEXT` },
    { label: "agent_controller_links_link_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS agent_controller_links_link_uniq ON agent_controller_links (link_id, direction)` },
    { label: "agent_controller_links_install_idx",
      sql:   `CREATE INDEX IF NOT EXISTS agent_controller_links_install_idx ON agent_controller_links (installation_id)` },
    { label: "agent_controller_links_domain_idx",
      sql:   `CREATE INDEX IF NOT EXISTS agent_controller_links_domain_idx ON agent_controller_links (domain)` },
    { label: "create agent_servers table",
      sql:   `CREATE TABLE IF NOT EXISTS agent_servers (
        id                SERIAL PRIMARY KEY,
        agent_id          INTEGER NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
        label             TEXT NOT NULL,
        role              TEXT NOT NULL DEFAULT 'standby',
        ssh_host          TEXT,
        ssh_port          INTEGER,
        ssh_user          TEXT,
        ssh_secret_enc    TEXT,
        ssh_status        TEXT NOT NULL DEFAULT 'not_configured',
        ssh_last_check_at TIMESTAMP,
        ssh_host_key_fp   TEXT,
        deploy_status     TEXT NOT NULL DEFAULT 'never',
        deploy_log        TEXT,
        last_deploy_at    TIMESTAMP,
        hb_marker         TEXT NOT NULL,
        last_heartbeat_at TIMESTAMP,
        last_seen_ip      TEXT,
        deployed_version  TEXT,
        notes             TEXT,
        created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "agent_servers_agent_idx",
      sql:   `CREATE INDEX IF NOT EXISTS agent_servers_agent_idx ON agent_servers (agent_id)` },
    { label: "agent_servers_marker_idx",
      sql:   `CREATE INDEX IF NOT EXISTS agent_servers_marker_idx ON agent_servers (agent_id, hb_marker)` },
    { label: "supplier_settlements provenance columns",
      sql:   `ALTER TABLE supplier_settlements
        ADD COLUMN IF NOT EXISTS source_type TEXT,
        ADD COLUMN IF NOT EXISTS source_record_id INTEGER,
        ADD COLUMN IF NOT EXISTS source_key TEXT` },
    { label: "supplier_settlements commercial journal linkage",
      sql:   `ALTER TABLE supplier_settlements
        ADD COLUMN IF NOT EXISTS journal_entry_id INTEGER,
        ADD COLUMN IF NOT EXISTS reversal_journal_entry_id INTEGER;
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'supplier_settlements_journal_entry_id_fkey'
              AND conrelid = 'supplier_settlements'::regclass
          ) THEN
            ALTER TABLE supplier_settlements
              ADD CONSTRAINT supplier_settlements_journal_entry_id_fkey
              FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id)
              ON DELETE SET NULL;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'supplier_settlements_reversal_journal_entry_id_fkey'
              AND conrelid = 'supplier_settlements'::regclass
          ) THEN
            ALTER TABLE supplier_settlements
              ADD CONSTRAINT supplier_settlements_reversal_journal_entry_id_fkey
              FOREIGN KEY (reversal_journal_entry_id) REFERENCES journal_entries(id)
              ON DELETE SET NULL;
          END IF;
        END $$` },
    { label: "supplier_settlements_company_source_key_uniq",
      sql:   `CREATE UNIQUE INDEX IF NOT EXISTS supplier_settlements_company_source_key_uniq
        ON supplier_settlements (company_id, source_key)
        WHERE source_key IS NOT NULL` },
    { label: "notifications delivery scope columns",
      sql:   `ALTER TABLE notifications
        ADD COLUMN IF NOT EXISTS module_key TEXT,
        ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL` },
    { label: "notifications_company_module_branch_idx",
      sql:   `CREATE INDEX IF NOT EXISTS notifications_company_module_branch_idx
        ON notifications (company_id, module_key, branch_id)` },
    { label: "journal_entry_lines bank-only cost-center lock",
      sql: BANK_JE_COST_CENTER_LOCK_DDL },
  ];
  for (const { label, sql: stmt } of stmts) {
    try {
      await execDDL(stmt);
      applied.push(label);
    } catch (err) {
      logger.warn({ err, label, stmt }, "ensureSchema: tenant-identity step failed (continuing)");
    }
  }
  return applied;
}

/**
 * Acceleration state and telemetry belong to the CENTRAL control plane only.
 * Keep this out of ensureTenantIdentityIndexes(): that function also runs
 * during full external-agent schema setup inside runWithExternalDb().
 */
async function ensureCentralAgentInvoiceAccelerationSchema(): Promise<void> {
  const stmts: { label: string; sql: string }[] = [
    { label: "agent_instances.invoice_acceleration_mode column",
      sql: `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS invoice_acceleration_mode TEXT NOT NULL DEFAULT 'off'` },
    { label: "agent_instances.invoice_trial_remaining column",
      sql: `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS invoice_trial_remaining INTEGER` },
    { label: "agent_instances.invoice_acceleration_last_error column",
      sql: `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS invoice_acceleration_last_error TEXT` },
    { label: "agent_instances.invoice_acceleration_reason column",
      sql: `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS invoice_acceleration_reason TEXT` },
    { label: "agent_instances.invoice_acceleration_updated_at column",
      sql: `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS invoice_acceleration_updated_at TIMESTAMP` },
    { label: "agent_instances.invoice_acceleration_generation column",
      sql: `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS invoice_acceleration_generation INTEGER NOT NULL DEFAULT 0` },
    { label: "agent_instances.invoice_acceleration_baseline column",
      sql: `ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS invoice_acceleration_baseline JSONB` },
    { label: "create central agent_invoice_samples table",
      sql: `CREATE TABLE IF NOT EXISTS agent_invoice_samples (
        id           SERIAL PRIMARY KEY,
        agent_id     INTEGER NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
        operation    TEXT NOT NULL,
        accelerated  BOOLEAN NOT NULL DEFAULT FALSE,
        status       INTEGER NOT NULL,
        total_ms     INTEGER NOT NULL,
        stages       JSONB,
        line_count   INTEGER,
        pool_start   JSONB,
        pool_end     JSONB,
        created_at   TIMESTAMP NOT NULL DEFAULT NOW()
      )` },
    { label: "central agent_invoice_samples_agent_created_idx",
      sql: `CREATE INDEX IF NOT EXISTS agent_invoice_samples_agent_created_idx ON agent_invoice_samples (agent_id, created_at)` },
    { label: "central agent_invoice_samples_agent_op_idx",
      sql: `CREATE INDEX IF NOT EXISTS agent_invoice_samples_agent_op_idx ON agent_invoice_samples (agent_id, operation, accelerated)` },
    { label: "central agent_invoice_samples_agent_claim_idx",
      sql: `CREATE INDEX IF NOT EXISTS agent_invoice_samples_agent_claim_idx ON agent_invoice_samples (agent_id, status, created_at)` },
  ];
  for (const { label, sql: stmt } of stmts) {
    try {
      await execCentralDDL(stmt);
    } catch (err) {
      logger.warn({ err, label, stmt }, "ensureSchema: central invoice-acceleration step failed (continuing)");
    }
  }
}

/**
 * Registration-transfer envelopes are central control-plane material.  Do not
 * move this DDL into the shared tenant setup list: external agents only receive
 * the company-side transfer gate columns, never a copy of encrypted envelopes.
 */
async function ensureCentralZatcaRegistrationTransferSchema(): Promise<void> {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS zatca_registration_transfers (
      id UUID PRIMARY KEY,
      source_company_id INTEGER NOT NULL REFERENCES companies(id),
      target_agent_id INTEGER NOT NULL REFERENCES agent_instances(id),
      target_company_id INTEGER NOT NULL,
      target_installation_id TEXT NOT NULL,
      target_db_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'completed', 'cancelled', 'expired')),
      payload_enc TEXT,
      payload_hash TEXT NOT NULL,
      target_binding TEXT NOT NULL,
      chain_snapshot JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      completed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      cancelled_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      error TEXT,
      audit_meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS zatca_registration_transfers_source_state_idx
       ON zatca_registration_transfers (source_company_id, state)`,
    `CREATE INDEX IF NOT EXISTS zatca_registration_transfers_expiry_idx
       ON zatca_registration_transfers (expires_at)`,
  ];
  for (const stmt of stmts) {
    try { await execCentralDDL(stmt); }
    catch (err) { logger.warn({ err }, "ensureSchema: central ZATCA transfer step failed (continuing)"); }
  }
}

/** Demo telemetry is central control-plane data, never part of an agent tenant DB. */
async function ensureCentralDemoAnalyticsSchema(): Promise<void> {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS demo_analytics_profiles (
      id SERIAL PRIMARY KEY, source_kind VARCHAR(12) NOT NULL, source_instance_id INTEGER,
      local_company_id INTEGER, local_user_id INTEGER, phone VARCHAR(32), device VARCHAR(32),
      lead_status VARCHAR(32) NOT NULL DEFAULT 'new', lead_notes TEXT, follow_up_at TIMESTAMPTZ,
      login_count INTEGER NOT NULL DEFAULT 0, total_duration_ms INTEGER NOT NULL DEFAULT 0,
      interest_score INTEGER NOT NULL DEFAULT 0, interest_category VARCHAR(24) NOT NULL DEFAULT 'new_visitor',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    // NULL source_instance_id is the central source. NULLS are normally
    // distinct in PostgreSQL unique indexes, so coalesce it explicitly.
    `CREATE UNIQUE INDEX IF NOT EXISTS demo_analytics_profiles_identity_uq ON demo_analytics_profiles(source_kind, COALESCE(source_instance_id, -1), local_company_id, local_user_id)`,
    `CREATE INDEX IF NOT EXISTS demo_analytics_profiles_phone_idx ON demo_analytics_profiles(phone)`,
    `CREATE TABLE IF NOT EXISTS demo_analytics_policies (
      id SERIAL PRIMARY KEY, profile_id INTEGER REFERENCES demo_analytics_profiles(id) ON DELETE CASCADE,
       enabled BOOLEAN NOT NULL DEFAULT TRUE, limit_enabled BOOLEAN NOT NULL DEFAULT FALSE, action_limit INTEGER,
      warning_remaining INTEGER NOT NULL DEFAULT 5, subscription_message TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `ALTER TABLE demo_analytics_policies ADD COLUMN IF NOT EXISTS profile_id INTEGER REFERENCES demo_analytics_profiles(id) ON DELETE CASCADE`,
    `ALTER TABLE demo_analytics_policies ADD COLUMN IF NOT EXISTS limit_enabled BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE demo_analytics_policies ALTER COLUMN action_limit DROP DEFAULT`,
    `ALTER TABLE demo_analytics_policies ALTER COLUMN action_limit DROP NOT NULL`,
    `DO $$ BEGIN
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'demo_analytics_policies'
           AND column_name = 'source_kind'
       ) THEN
         ALTER TABLE demo_analytics_policies ALTER COLUMN source_kind DROP NOT NULL;
       END IF;
     END $$`,
    `CREATE UNIQUE INDEX IF NOT EXISTS demo_analytics_policies_profile_uq ON demo_analytics_policies(profile_id)`,
    `CREATE TABLE IF NOT EXISTS demo_analytics_sessions (
      id SERIAL PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES demo_analytics_profiles(id) ON DELETE CASCADE,
      session_key VARCHAR(128) NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      device_type VARCHAR(16), os VARCHAR(80), browser VARCHAR(80), user_agent VARCHAR(300),
      last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ended_at TIMESTAMPTZ, duration_ms INTEGER NOT NULL DEFAULT 0)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS demo_analytics_sessions_key_uq ON demo_analytics_sessions(profile_id, session_key)`,
    `ALTER TABLE demo_analytics_sessions ADD COLUMN IF NOT EXISTS device_type VARCHAR(16)`,
    `ALTER TABLE demo_analytics_sessions ADD COLUMN IF NOT EXISTS os VARCHAR(80)`,
    `ALTER TABLE demo_analytics_sessions ADD COLUMN IF NOT EXISTS browser VARCHAR(80)`,
    `ALTER TABLE demo_analytics_sessions ADD COLUMN IF NOT EXISTS user_agent VARCHAR(300)`,
    `CREATE TABLE IF NOT EXISTS demo_analytics_events (
      id SERIAL PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES demo_analytics_profiles(id) ON DELETE CASCADE,
      event_id VARCHAR(128) NOT NULL, type VARCHAR(48) NOT NULL, module_key VARCHAR(80), screen_key VARCHAR(120),
      action_key VARCHAR(120), route VARCHAR(240), duration_ms INTEGER, occurred_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE UNIQUE INDEX IF NOT EXISTS demo_analytics_events_profile_event_uq ON demo_analytics_events(profile_id, event_id)`,
    `CREATE TABLE IF NOT EXISTS demo_action_reservations (
      id SERIAL PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES demo_analytics_profiles(id) ON DELETE CASCADE,
      idempotency_key VARCHAR(160) NOT NULL, route VARCHAR(240) NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'reserved',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finalized_at TIMESTAMPTZ)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS demo_action_reservations_key_uq ON demo_action_reservations(profile_id, idempotency_key)`,
    `CREATE TABLE IF NOT EXISTS demo_action_ledger (
      id SERIAL PRIMARY KEY, reservation_id INTEGER NOT NULL REFERENCES demo_action_reservations(id) ON DELETE CASCADE,
      profile_id INTEGER NOT NULL REFERENCES demo_analytics_profiles(id) ON DELETE CASCADE, action_key VARCHAR(120) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE UNIQUE INDEX IF NOT EXISTS demo_action_ledger_reservation_uq ON demo_action_ledger(reservation_id)`,
    `CREATE TABLE IF NOT EXISTS demo_agent_batch_receipts (
      id SERIAL PRIMARY KEY, source_instance_id INTEGER NOT NULL, receipt_key VARCHAR(160) NOT NULL,
      event_count INTEGER NOT NULL DEFAULT 0, status VARCHAR(16) NOT NULL DEFAULT 'processing', error VARCHAR(300), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `ALTER TABLE demo_agent_batch_receipts ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'processing'`,
    `ALTER TABLE demo_agent_batch_receipts ADD COLUMN IF NOT EXISTS error VARCHAR(300)`,
    `ALTER TABLE demo_agent_batch_receipts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `CREATE UNIQUE INDEX IF NOT EXISTS demo_agent_batch_receipts_uq ON demo_agent_batch_receipts(source_instance_id, receipt_key)`,
  ];
  for (const stmt of stmts) {
    try { await execCentralDDL(stmt); }
    catch (err) { logger.warn({ err }, "ensureSchema: central demo analytics step failed (continuing)"); }
  }
}

if (false) {
async function runHeal(options: {
  includeIdentitySteps?: boolean;
  strictSchema?: boolean;
  optionalMissingTables?: readonly string[];
  excludedColumns?: readonly string[];
} = {}): Promise<void> {
  const includeIdentitySteps = options.includeIdentitySteps !== false;
  const strictSchema = options.strictSchema === true;
  const { tables, enums } = collectSchemaEntities();
  logger.info({ tableCount: tables.length, enumCount: enums.length }, "ensureSchema: starting schema reconciliation");

  // Run this compatibility DDL before generic inspection. Purchase-invoice
  // posting writes these JE-line fields during the same request that follows an
  // agent package update, so a partially-upgraded agent must heal first.
  await ensureSupplierMetadataCompatibility();
  await ensureIndustrialPurchaseCostCompatibility();
  await ensureInvoiceCreateIdempotencySchema();
  // Request-replay claims are operational state, but their additive table must
  // exist in the shared heal pass before strict reconciliation and backup
  // catalog checks. The POST helper retains its lazy fallback for test/agent
  // callers which invoke a route without bootstrapping the full server.
  await ensureContractCreateIdempotencySchema();
  await ensureBillCreateIdempotencySchema();
  await ensureContractingResourceInventoryCompatibility();
  await ensureContractingProjectCustomerCompatibility();
  await ensureContractingCostCenterCompatibility();
  await ensureContractingAdvanceRecoveryCompatibility();
  await ensureContractingSettingsTable();
  // A newly upgraded external-agent database may not yet contain the BOQ
  // table. Accounting/cost-allocation DDL references it, and strict column
  // validation cannot create a missing release-managed table. Central BOQ
  // remains Publish-managed; do not create it as a new central migration here.
  if (getActiveExternalDb()) await ensureContractingBoqTables();
  // Required application tables must exist on the active database BEFORE
  // generic validation. Keep this in the shared pass: startup, manual agent
  // upgrades and strict request readiness all use it (without a central-only
  // memoized promise). Do not suppress missing tables via the optional list.
  await ensureContractingBillDetailsTables();
  // Accounting storage is exported declaratively and must be reconciled on
  // every active database before strict column inspection (startup, agent
  // upgrade, and request readiness), not only on the first accounting route.
  await ensureContractingAccountingTables();
  await ensureContractingExecutionSchema();
  await ensureContractingCostAllocationTables();
  await ensureContractingGuaranteeTables();
  await ensureContractingProjectIntegrityPrerequisites();

  // These release-managed tables have complete additive DDL here, unlike
  // generic schema entities. Create them before strict missing-table
  // validation so an already-initialized agent DB can heal itself on its
  // first request after a central release instead of entering a permanent
  // AGENT_SCHEMA_FAILED loop.
  try {
    await ensurePayrollAllocationSchema({ strict: strictSchema });
  } catch (err) {
    logger.error({ err }, "ensureSchema: payroll-allocation reconciliation failed");
    if (strictSchema) throw err;
  }

  let appliedEnumStmts: string[] = [];
  try {
    appliedEnumStmts = await ensureEnums(enums, { strict: strictSchema });
  } catch (err) {
    logger.error({ err }, "ensureSchema: enum reconciliation failed");
    if (strictSchema) throw err;
  }

  let appliedColStmts: string[] = [];
  let missingTables: string[] = [];
  try {
    const r = await ensureColumns(tables, {
      strict: strictSchema,
      optionalMissingTables: options.optionalMissingTables,
      excludedColumns: options.excludedColumns,
    });
    appliedColStmts = r.applied;
    missingTables = r.missingTables;
  } catch (err) {
    logger.error({ err }, "ensureSchema: column reconciliation failed");
    throw err;
  }
  // Integrity diagnostics and constraints read columns introduced by generic
  // reconciliation (legacy_contract_link_pending in particular). Validate only
  // after those columns exist; required runtime tables were created above so
  // strict missing-table checks still cannot strand an external agent.
  await ensureContractingProjectIntegrity();
  // Generic reconciliation materializes any newly declared snapshot/factor
  // columns first; this pass then widens existing numeric columns and performs
  // the guarded legacy item-unit backfill.
  await ensureItemUnitConversionCompatibility();

  // Tenant identity indexes depend on the columns above (companies.code in
  // particular), so they must run AFTER ensureColumns.
  let appliedIdentitySteps: string[] = [];
  if (includeIdentitySteps) {
    try {
      appliedIdentitySteps = await ensureTenantIdentityIndexes();
    } catch (err) {
      logger.error({ err }, "ensureSchema: tenant identity reconciliation failed (continuing)");
    }
  }

  const optionalMissing = new Set(options.optionalMissingTables ?? []);
  const requiredMissingTables = missingTables.filter(name => !optionalMissing.has(name));
  if (requiredMissingTables.length) {
    logger.warn(
      { missingTables: requiredMissingTables },
      "ensureSchema: schema declares tables that don't exist in DB — run `pnpm db:push` or write a migration",
    );
  }
  logger.info(
    {
      enums: appliedEnumStmts.length,
      columns: appliedColStmts.length,
      sample: [...appliedEnumStmts, ...appliedColStmts].slice(0, 10),
    },
    "ensureSchema: reconciliation complete",
  );
}
}
async function runHeal(options: {
  includeIdentitySteps?: boolean;
  strictSchema?: boolean;
  optionalMissingTables?: readonly string[];
  excludedColumns?: readonly string[];
} = {}): Promise<void> {
  const includeIdentitySteps = options.includeIdentitySteps !== false;
  const strictSchema = options.strictSchema === true;
  const { tables, enums } = collectSchemaEntities();
  logger.info({ tableCount: tables.length, enumCount: enums.length }, "ensureSchema: starting schema reconciliation");

  // Run this compatibility DDL before generic inspection. Purchase-invoice
  // posting writes these JE-line fields during the same request that follows an
  // agent package update, so a partially-upgraded agent must heal first.
  await ensureSupplierMetadataCompatibility();
  await ensureIndustrialPurchaseCostCompatibility();
  await ensureInvoiceCreateIdempotencySchema();
  // Request-replay claims are operational state, but their additive table must
  // exist in the shared heal pass before strict reconciliation and backup
  // catalog checks. The POST helper retains its lazy fallback for test/agent
  // callers which invoke a route without bootstrapping the full server.
  await ensureContractCreateIdempotencySchema();
  await ensureBillCreateIdempotencySchema();
  await ensureContractingResourceInventoryCompatibility();
  await ensureContractingProjectCustomerCompatibility();
  await ensureContractingCostCenterCompatibility();
  await ensureContractingAdvanceRecoveryCompatibility();
  await ensureContractingSettingsTable();
  if (getActiveExternalDb()) await ensureContractingBoqTables();
  // Required application tables must exist on the active database BEFORE
  // generic validation. Keep this in the shared pass: startup, manual agent
  // upgrades and strict request readiness all use it (without a central-only
  // memoized promise). Do not suppress missing tables via the optional list.
  await ensureContractingBillDetailsTables();
  await ensureContractingAccountingTables();
  await ensureContractingExecutionSchema();
  await ensureContractingCostAllocationTables();
  await ensureContractingGuaranteeTables();
  await ensureContractingProjectIntegrityPrerequisites();

  // These release-managed tables have complete additive DDL here, unlike
  // generic schema entities. Create them before strict missing-table
  // validation so an already-initialized agent DB can heal itself on its
  // first request after a central release instead of entering a permanent
  // AGENT_SCHEMA_FAILED loop.
  try {
    await ensurePayrollAllocationSchema({ strict: strictSchema });
  } catch (err) {
    logger.error({ err }, "ensureSchema: payroll-allocation reconciliation failed");
    if (strictSchema) throw err;
  }

  let appliedEnumStmts: string[] = [];
  try {
    appliedEnumStmts = await ensureEnums(enums, { strict: strictSchema });
  } catch (err) {
    logger.error({ err }, "ensureSchema: enum reconciliation failed");
    if (strictSchema) throw err;
  }

  let appliedColStmts: string[] = [];
  let missingTables: string[] = [];
  try {
    const r = await ensureColumns(tables, {
      strict: strictSchema,
      optionalMissingTables: options.optionalMissingTables,
      excludedColumns: options.excludedColumns,
    });
    appliedColStmts = r.applied;
    missingTables = r.missingTables;
  } catch (err) {
    logger.error({ err }, "ensureSchema: column reconciliation failed");
    throw err;
  }
  // Integrity diagnostics and constraints read columns introduced by generic
  // reconciliation (legacy_contract_link_pending in particular). Validate only
  // after those columns exist; required runtime tables were created above so
  // strict missing-table checks still cannot strand an external agent.
  await ensureContractingProjectIntegrity();
  // Generic reconciliation materializes any newly declared snapshot/factor
  // columns first; this pass then widens existing numeric columns and performs
  // the guarded legacy item-unit backfill.
  await ensureItemUnitConversionCompatibility();

  // Tenant identity indexes depend on the columns above (companies.code in
  // particular), so they must run AFTER ensureColumns.
  let appliedIdentitySteps: string[] = [];
  if (includeIdentitySteps) {
    try {
      appliedIdentitySteps = await ensureTenantIdentityIndexes();
    } catch (err) {
      logger.error({ err }, "ensureSchema: tenant identity reconciliation failed (continuing)");
    }
  }

  const optionalMissing = new Set(options.optionalMissingTables ?? []);
  const requiredMissingTables = missingTables.filter(name => !optionalMissing.has(name));
  if (requiredMissingTables.length) {
    logger.warn(
      { missingTables: requiredMissingTables },
      "ensureSchema: schema declares tables that don't exist in DB — run `pnpm db:push` or write a migration",
    );
  }
  logger.info(
    {
      enums: appliedEnumStmts.length,
      columns: appliedColStmts.length,
      sample: [...appliedEnumStmts, ...appliedColStmts].slice(0, 10),
    },
    "ensureSchema: reconciliation complete",
  );
}

/**
 * Request ids are application data, not a control-plane facility, so this runs
 * for both central and external tenant databases. Keep it additive: older
 * agent databases can create the table before accepting a retried POST.
 */
export async function ensureInvoiceCreateIdempotencySchema(): Promise<void> {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS invoice_create_idempotency (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      invoice_kind VARCHAR(32) NOT NULL CHECK (invoice_kind IN ('sales_invoice', 'purchase_invoice')),
      client_request_id VARCHAR(128) NOT NULL,
      sales_invoice_id INTEGER REFERENCES sales_invoices(id) ON DELETE CASCADE,
      purchase_invoice_id INTEGER REFERENCES purchase_invoices(id) ON DELETE CASCADE,
      CHECK (
        (invoice_kind = 'sales_invoice' AND purchase_invoice_id IS NULL)
        OR (invoice_kind = 'purchase_invoice' AND sales_invoice_id IS NULL)
      ),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, invoice_kind, client_request_id)
    )`,
    // Keep an already-created early-release table compatible without a
    // destructive rewrite. The typed FKs make invoice ids remappable during a
    // full-company restore; the legacy generic invoice_id is intentionally
    // left alone if it exists.
    `ALTER TABLE invoice_create_idempotency
       ADD COLUMN IF NOT EXISTS sales_invoice_id INTEGER REFERENCES sales_invoices(id) ON DELETE CASCADE`,
    `ALTER TABLE invoice_create_idempotency
       ADD COLUMN IF NOT EXISTS purchase_invoice_id INTEGER REFERENCES purchase_invoices(id) ON DELETE CASCADE`,
    `DO $$
     BEGIN
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'invoice_create_idempotency'
            AND column_name = 'invoice_id'
       ) THEN
         UPDATE invoice_create_idempotency
            SET sales_invoice_id = invoice_id
          WHERE invoice_kind = 'sales_invoice'
            AND sales_invoice_id IS NULL
            AND invoice_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM sales_invoices invoice
               WHERE invoice.id = invoice_create_idempotency.invoice_id
                 AND invoice.company_id = invoice_create_idempotency.company_id
            );
         UPDATE invoice_create_idempotency
            SET purchase_invoice_id = invoice_id
          WHERE invoice_kind = 'purchase_invoice'
            AND purchase_invoice_id IS NULL
            AND invoice_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM purchase_invoices invoice
               WHERE invoice.id = invoice_create_idempotency.invoice_id
                 AND invoice.company_id = invoice_create_idempotency.company_id
            );
       END IF;
     END $$`,
    `CREATE INDEX IF NOT EXISTS invoice_create_idempotency_invoice_idx
       ON invoice_create_idempotency
         (company_id, invoice_kind, sales_invoice_id, purchase_invoice_id)`,
  ];
  for (const stmt of stmts) {
    try {
      await db.execute(sql.raw(stmt));
    } catch (err) {
      logger.error({ err }, "ensureSchema: invoice-create idempotency reconciliation failed");
      throw err;
    }
  }
}

/**
 * Idempotent self-healing migration that runs once on startup.
 *
 * Strategy (additive-only, safe for production):
 *   1. Walk the compiled-in `@workspace/db` schema and collect every pgTable
 *      and pgEnum.
 *   2. CREATE TYPE for any enum that's missing in the live DB; ALTER TYPE
 *      ADD VALUE IF NOT EXISTS for any enum label that was extended.
 *   3. ALTER TABLE ADD COLUMN IF NOT EXISTS for every column declared in the
 *      schema but missing in the DB. NOT NULL is only emitted when we have
 *      a usable DEFAULT, so legacy rows never block the migration.
 *   4. Tables that exist in code but not in the DB are surfaced as a warning
 *      — creating them safely requires a real migration tool because of
 *      foreign keys and constraints. (Adding columns is the >99% case for
 *      drift, and that *is* handled here.)
 *
 * The HTTP server awaits this before binding to `PORT`, so no request can
 * race the migration. Safe to call repeatedly.
 */
export function ensureSchemaUpToDate(): Promise<void> {
  if (!healPromise) {
    healPromise = (async () => {
      schemaReconciliationState = { state: "running" };
      try {
        // Create central-only control-plane tables before generic schema
        // inspection, so they are never reported as missing on startup.
        await ensureCentralDemoAnalyticsSchema();
        await ensureCentralZatcaRegistrationTransferSchema();
        await runHeal();
        await ensureCentralAgentInvoiceAccelerationSchema();
        schemaReconciliationState = { state: "ready", completedAt: new Date().toISOString() };
      } catch (error) {
        schemaReconciliationState = {
          state: "failed",
          error: String((error as any)?.message ?? error).slice(0, 500),
        };
        throw error;
      }
    })();
  }
  return healPromise;
}

/**
 * NON-memoized heal pass for EXTERNAL databases (agent instances).
 * Call inside `runWithExternalDb(ctx, ...)` so the proxied `db`/`pool`
 * point at the agent's PostgreSQL. Never touches the boot-time single-flight
 * promise (which is bound to the central DB).
 */
export async function runSchemaHealOnActiveDb(): Promise<void> {
  await runHeal({
    optionalMissingTables: ["integration_invoice_queue", "agent_invoice_samples", "demo_analytics_profiles", "demo_analytics_policies", "demo_analytics_sessions", "demo_analytics_events", "demo_action_reservations", "demo_action_ledger", "demo_agent_batch_receipts", ...CENTRAL_ONLY_ZATCA_TRANSFER_TABLES],
    excludedColumns: CENTRAL_ONLY_AGENT_ACCELERATION_COLUMNS,
  });
  // Sequence reconciliation takes table locks while comparing MAX(id) with an
  // owned sequence. Keep all of those locks in one external-agent transaction.
  await db.transaction(async (tx) => {
    await reconcilePostgresSequences(tx);
  });
}

/**
 * Fast request-readiness pass for an EXISTING shell-agent database.
 *
 * The full heal includes a long legacy list of idempotent CREATE TABLE/INDEX
 * statements. Running that list serially over a remote PostgreSQL connection
 * can take minutes even when every object already exists. Request routing only
 * needs to close the common central-release race (new columns / enum labels);
 * full structural setup remains the responsibility of init-db / release
 * preflight, which continues to call runSchemaHealOnActiveDb().
 */
export function runAgentRequestSchemaHealOnActiveDb(): Promise<void> {
  return runHeal({
    includeIdentitySteps: false,
    strictSchema: true,
    // This queue is intentionally lazy-created by its integration module and
    // is unrelated to the shell-agent request path.
    // Both are intentionally lazy/control-plane-only and must not block an
    // external agent request. agent_invoice_samples is created only on the
    // central DB by ensureCentralAgentInvoiceAccelerationSchema().
    optionalMissingTables: ["integration_invoice_queue", "agent_invoice_samples", "demo_analytics_profiles", "demo_analytics_policies", "demo_analytics_sessions", "demo_analytics_events", "demo_action_reservations", "demo_action_ledger", "demo_agent_batch_receipts", ...CENTRAL_ONLY_ZATCA_TRANSFER_TABLES],
    excludedColumns: CENTRAL_ONLY_AGENT_ACCELERATION_COLUMNS,
  });
}
