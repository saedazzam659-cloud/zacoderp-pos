import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Additive storage used by the contracting accounting facade.
 *
 * Contracting was originally shipped with planning tables only.  These
 * tables deliberately live outside the planning schema so a material issue,
 * advance, retention settlement, reversal, and their audit trail can be
 * introduced without changing the meaning of an existing resource row.
 */
let ready: Promise<void> | null = null;

export function ensureContractingAccountingTables(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS contracting_accounting_settlements (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES contracting_projects(id) ON DELETE RESTRICT,
        bill_id INTEGER REFERENCES contracting_progress_bills(id) ON DELETE RESTRICT,
        owner_contract_id INTEGER REFERENCES contracting_owner_contracts(id) ON DELETE RESTRICT,
        subcontractor_contract_id INTEGER REFERENCES contracting_sub_contracts(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL,
        direction TEXT NOT NULL,
        amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
        applied_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (applied_amount >= 0),
        settlement_date DATE NOT NULL,
        payment_type TEXT,
        cash_box_id INTEGER REFERENCES cash_boxes(id) ON DELETE RESTRICT,
        bank_account_id INTEGER REFERENCES bank_accounts(id) ON DELETE RESTRICT,
        journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
        source_settlement_id INTEGER REFERENCES contracting_accounting_settlements(id) ON DELETE RESTRICT,
        idempotency_key TEXT,
        idempotency_payload_hash TEXT,
        status TEXT NOT NULL DEFAULT 'posted',
        notes TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT contracting_settlement_kind_ck
          CHECK (kind IN ('advance_receipt','advance_payment','advance_application',
                          'retention_receipt','retention_payment',
                          'bill_receipt','bill_payment')),
        CONSTRAINT contracting_settlement_direction_ck
          CHECK (direction IN ('outgoing','incoming')),
        CONSTRAINT contracting_settlement_payment_ck
          CHECK (payment_type IS NULL OR payment_type IN ('cash','bank'))
      )
    `);
    await db.execute(sql`
      ALTER TABLE contracting_accounting_settlements
        ADD COLUMN IF NOT EXISTS owner_contract_id INTEGER REFERENCES contracting_owner_contracts(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS subcontractor_contract_id INTEGER REFERENCES contracting_sub_contracts(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS idempotency_payload_hash TEXT
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS contracting_settlements_project_idx
        ON contracting_accounting_settlements(company_id, project_id, created_at DESC)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS contracting_settlements_bill_idx
        ON contracting_accounting_settlements(company_id, bill_id)
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS contracting_settlements_idempotency_idx
        ON contracting_accounting_settlements(company_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS contracting_material_movements (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES contracting_projects(id) ON DELETE RESTRICT,
        project_branch_id INTEGER REFERENCES branches(id) ON DELETE RESTRICT,
        resource_id INTEGER REFERENCES contracting_resources(id) ON DELETE SET NULL,
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
        unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
        warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
        warehouse_branch_id INTEGER REFERENCES branches(id) ON DELETE RESTRICT,
        direction TEXT NOT NULL,
        movement_date DATE NOT NULL,
        qty NUMERIC(30,18) NOT NULL CHECK (qty > 0),
        qty_base NUMERIC(30,18) NOT NULL CHECK (qty_base > 0),
        unit_cost NUMERIC(30,18) NOT NULL CHECK (unit_cost >= 0),
        total_cost NUMERIC(60,36) NOT NULL CHECK (total_cost >= 0),
        source_movement_id INTEGER REFERENCES contracting_material_movements(id) ON DELETE RESTRICT,
        journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
        idempotency_key TEXT NOT NULL,
        idempotency_payload_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'posted',
        notes TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT contracting_material_direction_ck
          CHECK (direction IN ('issue','return'))
      )
    `);
    await db.execute(sql`
      ALTER TABLE contracting_material_movements
        ADD COLUMN IF NOT EXISTS idempotency_payload_hash TEXT
    `);
    await db.execute(sql`
      ALTER TABLE contracting_material_movements
        ADD COLUMN IF NOT EXISTS project_branch_id INTEGER REFERENCES branches(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS warehouse_branch_id INTEGER REFERENCES branches(id) ON DELETE RESTRICT
    `);
    await db.execute(sql`
      ALTER TABLE contracting_material_movements
        ALTER COLUMN qty TYPE NUMERIC(30,18),
        ALTER COLUMN qty_base TYPE NUMERIC(30,18),
        ALTER COLUMN total_cost TYPE NUMERIC(60,36),
        ALTER COLUMN unit_cost TYPE NUMERIC(30,18)
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS contracting_material_idempotency_idx
        ON contracting_material_movements(company_id, idempotency_key)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS contracting_material_project_idx
        ON contracting_material_movements(company_id, project_id, movement_date DESC)
    `);

    // Immutable per-lot provenance.  An issue has one row per valuation-layer
    // pick; a return points back to the exact issue allocation it restores.
    // This is deliberately separate from stock_balance: lot balances remain
    // derived from the existing stock_ledger, never synthetic balance rows.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS contracting_material_movement_allocations (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        movement_id INTEGER NOT NULL REFERENCES contracting_material_movements(id) ON DELETE RESTRICT,
        source_movement_id INTEGER REFERENCES contracting_material_movements(id) ON DELETE RESTRICT,
        source_allocation_id INTEGER REFERENCES contracting_material_movement_allocations(id) ON DELETE RESTRICT,
        source_ledger_id INTEGER REFERENCES stock_ledger(id) ON DELETE RESTRICT,
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
        warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
        batch_number TEXT,
        expiry_date DATE,
        qty_base NUMERIC(30,18) NOT NULL CHECK (qty_base > 0),
        unit_cost NUMERIC(30,18) NOT NULL CHECK (unit_cost >= 0),
        total_cost NUMERIC(60,36) NOT NULL CHECK (total_cost >= 0),
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS contracting_material_alloc_movement_idx
        ON contracting_material_movement_allocations(company_id, movement_id, id)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS contracting_material_alloc_source_idx
        ON contracting_material_movement_allocations(company_id, source_movement_id, source_allocation_id)
    `);
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION reject_contracting_material_allocation_mutation() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'contracting material cost allocations are immutable'; END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS contracting_material_allocations_no_mutation
        ON contracting_material_movement_allocations;
      CREATE TRIGGER contracting_material_allocations_no_mutation
        BEFORE UPDATE OR DELETE ON contracting_material_movement_allocations
        FOR EACH ROW EXECUTE FUNCTION reject_contracting_material_allocation_mutation()
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS contracting_accounting_audit (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        project_id INTEGER REFERENCES contracting_projects(id) ON DELETE SET NULL,
        bill_id INTEGER REFERENCES contracting_progress_bills(id) ON DELETE SET NULL,
        settlement_id INTEGER REFERENCES contracting_accounting_settlements(id) ON DELETE SET NULL,
        material_movement_id INTEGER REFERENCES contracting_material_movements(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        original_journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
        reversal_journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
        amount NUMERIC(18,2),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS contracting_accounting_audit_source_idx
        ON contracting_accounting_audit(company_id, bill_id, created_at DESC)
    `);
  })().catch((error) => {
    ready = null;
    throw error;
  });
  return ready;
}