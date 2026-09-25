import { db, getActiveExternalDb } from "@workspace/db";
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
const externalReady = new WeakMap<object, Promise<void>>();

export function ensureContractingAccountingTables(): Promise<void> {
  const externalContext = getActiveExternalDb();
  const current = externalContext ? externalReady.get(externalContext) : ready;
  if (current) return current;
  const initialization = (async () => {
    // Existing agent tables predate these declarations; reconcile before any
    // Drizzle SELECT * or fiscal query references the new fields.
    for (const table of ["contracting_owner_contracts", "contracting_sub_contracts", "contracting_progress_bills"]) {
      await db.execute(sql.raw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS price_includes_vat BOOLEAN NOT NULL DEFAULT FALSE`));
    }
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
        application_origin TEXT NOT NULL DEFAULT 'manual',
        reversal_journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
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
        ADD COLUMN IF NOT EXISTS idempotency_payload_hash TEXT,
        ADD COLUMN IF NOT EXISTS application_origin TEXT NOT NULL DEFAULT 'manual',
        ADD COLUMN IF NOT EXISTS reversal_journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT
    `);
    // Source line identity is immutable accounting evidence. Draft voucher
    // edits may replace lines; posted settlements retain this reference.
    await db.execute(sql`ALTER TABLE contracting_accounting_settlements
      ADD COLUMN IF NOT EXISTS source_voucher_type TEXT,
      ADD COLUMN IF NOT EXISTS source_voucher_id INTEGER,
      ADD COLUMN IF NOT EXISTS source_voucher_line_id INTEGER,
      ADD COLUMN IF NOT EXISTS source_line_snapshot JSONB,
      ADD COLUMN IF NOT EXISTS taxable_advance_invoice_id INTEGER,
      ADD COLUMN IF NOT EXISTS taxable_base_amount NUMERIC(18,2),
      ADD COLUMN IF NOT EXISTS taxable_vat_amount NUMERIC(18,2),
      ADD COLUMN IF NOT EXISTS applied_vat_amount NUMERIC(18,2) NOT NULL DEFAULT 0`);
    await db.execute(sql`ALTER TABLE receipt_voucher_lines
      ADD COLUMN IF NOT EXISTS taxable_advance_invoice_id INTEGER`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS contracting_fiscal_invoices (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL, project_id INTEGER NOT NULL, owner_contract_id INTEGER NOT NULL,
      bill_id INTEGER, intent_key VARCHAR(128), kind TEXT NOT NULL,
      invoice_number TEXT NOT NULL, invoice_date DATE NOT NULL, invoice_time TEXT NOT NULL,
      customer_id INTEGER NOT NULL, taxable_amount NUMERIC(18,2) NOT NULL,
      price_includes_vat BOOLEAN NOT NULL DEFAULT FALSE,
      vat_percent NUMERIC(5,2) NOT NULL DEFAULT 15,
      vat_amount NUMERIC(18,2) NOT NULL, gross_amount NUMERIC(18,2) NOT NULL,
      prepayment_adjustments JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'issued', journal_entry_id INTEGER,
      zatca_uuid TEXT, zatca_icv INTEGER,
      invoice_hash TEXT, zatca_pih TEXT, xml_content TEXT, zatca_response JSONB,
      created_by INTEGER, created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT ctg_fiscal_company_intent_uq UNIQUE (company_id, intent_key),
      CONSTRAINT ctg_fiscal_company_bill_uq UNIQUE (company_id, bill_id),
      CONSTRAINT ctg_fiscal_company_number_uq UNIQUE (company_id, invoice_number)
    )`);
    await db.execute(sql`ALTER TABLE contracting_fiscal_invoices
      ADD COLUMN IF NOT EXISTS journal_entry_id INTEGER`);
    await db.execute(sql`ALTER TABLE contracting_fiscal_invoices
      ADD COLUMN IF NOT EXISTS price_includes_vat BOOLEAN NOT NULL DEFAULT FALSE`);
    await db.execute(sql`ALTER TABLE contracting_fiscal_invoices
      ADD COLUMN IF NOT EXISTS vat_percent NUMERIC(5,2) NOT NULL DEFAULT 15`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS ctg_fiscal_contract_idx
      ON contracting_fiscal_invoices(company_id,owner_contract_id)`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS contracting_settlement_voucher_line_uq
      ON contracting_accounting_settlements(company_id, source_voucher_type, source_voucher_line_id)
      WHERE source_voucher_line_id IS NOT NULL AND status = 'posted'`);
    // Recovery policy/snapshot columns are additive so an external agent can
    // heal an older tenant without a declarative schema publish first.
    await db.execute(sql`
      ALTER TABLE IF EXISTS contracting_owner_contracts
        ADD COLUMN IF NOT EXISTS advance_recovery_method TEXT NOT NULL DEFAULT 'percentage',
        ADD COLUMN IF NOT EXISTS advance_recovery_fixed_amount NUMERIC(14,2) NOT NULL DEFAULT 0
    `);
    await db.execute(sql`
      ALTER TABLE IF EXISTS contracting_sub_contracts
        ADD COLUMN IF NOT EXISTS advance_recovery_method TEXT NOT NULL DEFAULT 'percentage',
        ADD COLUMN IF NOT EXISTS advance_recovery_fixed_amount NUMERIC(14,2) NOT NULL DEFAULT 0
    `);
    await db.execute(sql`
      ALTER TABLE IF EXISTS contracting_progress_bills
        ADD COLUMN IF NOT EXISTS advance_recovery_method TEXT NOT NULL DEFAULT 'percentage',
        ADD COLUMN IF NOT EXISTS advance_recovery_fixed_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS advance_recovery_contract_advance_amount NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS advance_recovery_total_previously_recovered NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS advance_recovery_override_amount NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS advance_recovery_override_reason TEXT
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
        owner_contract_id INTEGER REFERENCES contracting_owner_contracts(id) ON DELETE RESTRICT,
        subcontractor_contract_id INTEGER REFERENCES contracting_sub_contracts(id) ON DELETE RESTRICT,
        boq_line_id INTEGER REFERENCES contracting_contract_boq_lines(id) ON DELETE RESTRICT,
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
          CHECK (direction IN ('issue','return')),
        CONSTRAINT contracting_material_movements_contract_side_check
          CHECK (owner_contract_id IS NULL OR subcontractor_contract_id IS NULL)
      )
    `);
    await db.execute(sql`
      ALTER TABLE contracting_material_movements
        ADD COLUMN IF NOT EXISTS idempotency_payload_hash TEXT
    `);
    await db.execute(sql`
      ALTER TABLE contracting_material_movements
        ADD COLUMN IF NOT EXISTS project_branch_id INTEGER REFERENCES branches(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS warehouse_branch_id INTEGER REFERENCES branches(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS owner_contract_id INTEGER REFERENCES contracting_owner_contracts(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS subcontractor_contract_id INTEGER REFERENCES contracting_sub_contracts(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS boq_line_id INTEGER REFERENCES contracting_contract_boq_lines(id) ON DELETE RESTRICT
    `);
    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conname = 'contracting_material_movements_contract_side_check'
             AND conrelid = 'contracting_material_movements'::regclass
        ) THEN
          ALTER TABLE contracting_material_movements
            ADD CONSTRAINT contracting_material_movements_contract_side_check
            CHECK (owner_contract_id IS NULL OR subcontractor_contract_id IS NULL);
        END IF;
      END $$;
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
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS contracting_material_contract_idx
        ON contracting_material_movements(
          company_id, project_id, owner_contract_id, subcontractor_contract_id, boq_line_id
        )
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
    if (externalContext) externalReady.delete(externalContext);
    else ready = null;
    throw error;
  });
  if (externalContext) externalReady.set(externalContext, initialization);
  else ready = initialization;
  return initialization;
}