import { db, getActiveExternalDb } from "@workspace/db";
import { sql } from "drizzle-orm";

let centralReady: Promise<void> | null = null;
const externalReady = new WeakMap<object, Promise<void>>();

/**
 * Readiness is cached per active database, never globally across tenants.
 * DDL is additive only and mirrors the declarative schema.
 */
export async function ensureContractingGuaranteeTables(): Promise<void> {
  const external = getActiveExternalDb();
  const current = external ? externalReady.get(external) : centralReady;
  if (current) return current;
  const initialization = createTables();
  if (external) externalReady.set(external, initialization);
  else centralReady = initialization;
  try {
    await initialization;
  } catch (error) {
    if (external && externalReady.get(external) === initialization) externalReady.delete(external);
    if (!external && centralReady === initialization) centralReady = null;
    throw error;
  }
}

async function createTables(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(20831, 4)`);
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS contracting_tenders (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES contracting_projects(id) ON DELETE RESTRICT,
        customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        tender_number TEXT NOT NULL,
        title TEXT NOT NULL,
        tender_date DATE NOT NULL,
        submission_date DATE,
        estimated_value NUMERIC(14,2) NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft',
        awarded_contract_kind TEXT,
        awarded_owner_contract_id INTEGER REFERENCES contracting_owner_contracts(id) ON DELETE RESTRICT,
        awarded_subcontract_id INTEGER REFERENCES contracting_sub_contracts(id) ON DELETE RESTRICT,
        awarded_at TIMESTAMP,
        notes TEXT,
        archived_at TIMESTAMP,
        archived_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS contracting_guarantees (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES contracting_projects(id) ON DELETE RESTRICT,
        tender_id INTEGER REFERENCES contracting_tenders(id) ON DELETE RESTRICT,
        contract_kind TEXT,
        owner_contract_id INTEGER REFERENCES contracting_owner_contracts(id) ON DELETE RESTRICT,
        subcontract_id INTEGER REFERENCES contracting_sub_contracts(id) ON DELETE RESTRICT,
        parent_guarantee_id INTEGER REFERENCES contracting_guarantees(id) ON DELETE RESTRICT,
        bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
        beneficiary_customer_id INTEGER REFERENCES customers(id) ON DELETE RESTRICT,
        guarantee_number TEXT NOT NULL,
        guarantee_type TEXT NOT NULL,
        amount NUMERIC(14,2) NOT NULL,
        issue_date DATE NOT NULL,
        expiry_date DATE NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        purpose TEXT,
        notes TEXT,
        released_at TIMESTAMP,
        archived_at TIMESTAMP,
        archived_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ctg_tender_company_project_idx ON contracting_tenders(company_id, project_id);
      CREATE INDEX IF NOT EXISTS ctg_tender_status_idx ON contracting_tenders(company_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS ctg_tender_company_project_id_uq ON contracting_tenders(company_id, project_id, id);
      CREATE INDEX IF NOT EXISTS ctg_guarantee_company_project_idx ON contracting_guarantees(company_id, project_id);
      CREATE INDEX IF NOT EXISTS ctg_guarantee_contract_idx ON contracting_guarantees(company_id, contract_kind, owner_contract_id, subcontract_id);
      CREATE INDEX IF NOT EXISTS ctg_guarantee_tender_idx ON contracting_guarantees(company_id, tender_id);
      CREATE INDEX IF NOT EXISTS ctg_guarantee_bank_idx ON contracting_guarantees(company_id, bank_account_id);
      CREATE INDEX IF NOT EXISTS ctg_guarantee_status_idx ON contracting_guarantees(company_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS ctg_guarantee_company_project_id_uq ON contracting_guarantees(company_id, project_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS ctg_guarantee_one_performance_child_uq
        ON contracting_guarantees(parent_guarantee_id)
        WHERE guarantee_type = 'performance' AND parent_guarantee_id IS NOT NULL AND archived_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS bank_accounts_company_id_id_uq ON bank_accounts(company_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS customers_company_id_id_uq ON customers(company_id, id);
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_tender_award_shape_ck') THEN
          ALTER TABLE contracting_tenders ADD CONSTRAINT ctg_tender_award_shape_ck CHECK (
            (awarded_contract_kind IS NULL AND awarded_owner_contract_id IS NULL AND awarded_subcontract_id IS NULL)
            OR (awarded_contract_kind = 'owner' AND awarded_owner_contract_id IS NOT NULL AND awarded_subcontract_id IS NULL)
            OR (awarded_contract_kind = 'subcontract' AND awarded_owner_contract_id IS NULL AND awarded_subcontract_id IS NOT NULL)
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_tender_status_ck') THEN
          ALTER TABLE contracting_tenders ADD CONSTRAINT ctg_tender_status_ck CHECK (
            status IN ('draft', 'submitted', 'under_review', 'awarded', 'lost', 'cancelled')
            AND ((status = 'awarded') = (awarded_contract_kind IS NOT NULL))
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_tender_owner_contract_project_fk') THEN
          ALTER TABLE contracting_tenders ADD CONSTRAINT ctg_tender_owner_contract_project_fk
            FOREIGN KEY (company_id, project_id, awarded_owner_contract_id)
            REFERENCES contracting_owner_contracts(company_id, project_id, id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_tender_subcontract_project_fk') THEN
          ALTER TABLE contracting_tenders ADD CONSTRAINT ctg_tender_subcontract_project_fk
            FOREIGN KEY (company_id, project_id, awarded_subcontract_id)
            REFERENCES contracting_sub_contracts(company_id, project_id, id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_guarantee_relationship_shape_ck') THEN
          ALTER TABLE contracting_guarantees ADD CONSTRAINT ctg_guarantee_relationship_shape_ck CHECK (
            (guarantee_type = 'initial' AND tender_id IS NOT NULL AND contract_kind IS NULL
              AND owner_contract_id IS NULL AND subcontract_id IS NULL AND parent_guarantee_id IS NULL)
            OR
            (guarantee_type <> 'initial' AND (
              (contract_kind = 'owner' AND owner_contract_id IS NOT NULL AND subcontract_id IS NULL)
              OR
              (contract_kind = 'subcontract' AND owner_contract_id IS NULL AND subcontract_id IS NOT NULL)
            ))
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_guarantee_values_ck') THEN
          ALTER TABLE contracting_guarantees ADD CONSTRAINT ctg_guarantee_values_ck CHECK (
            guarantee_type IN ('initial', 'performance', 'advance_payment', 'maintenance', 'other')
            AND status IN ('draft', 'issued', 'active', 'extended', 'released', 'expired', 'cancelled')
            AND amount > 0 AND expiry_date >= issue_date
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_guarantee_parent_shape_ck') THEN
          ALTER TABLE contracting_guarantees ADD CONSTRAINT ctg_guarantee_parent_shape_ck CHECK (
            (parent_guarantee_id IS NULL OR guarantee_type = 'performance')
            AND (tender_id IS NULL OR guarantee_type = 'initial'
              OR (guarantee_type = 'performance' AND parent_guarantee_id IS NOT NULL))
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_guarantee_tender_project_fk') THEN
          ALTER TABLE contracting_guarantees ADD CONSTRAINT ctg_guarantee_tender_project_fk
            FOREIGN KEY (company_id, project_id, tender_id)
            REFERENCES contracting_tenders(company_id, project_id, id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_guarantee_owner_contract_project_fk') THEN
          ALTER TABLE contracting_guarantees ADD CONSTRAINT ctg_guarantee_owner_contract_project_fk
            FOREIGN KEY (company_id, project_id, owner_contract_id)
            REFERENCES contracting_owner_contracts(company_id, project_id, id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_guarantee_subcontract_project_fk') THEN
          ALTER TABLE contracting_guarantees ADD CONSTRAINT ctg_guarantee_subcontract_project_fk
            FOREIGN KEY (company_id, project_id, subcontract_id)
            REFERENCES contracting_sub_contracts(company_id, project_id, id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_guarantee_parent_project_fk') THEN
          ALTER TABLE contracting_guarantees ADD CONSTRAINT ctg_guarantee_parent_project_fk
            FOREIGN KEY (company_id, project_id, parent_guarantee_id)
            REFERENCES contracting_guarantees(company_id, project_id, id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_guarantee_bank_company_fk') THEN
          ALTER TABLE contracting_guarantees ADD CONSTRAINT ctg_guarantee_bank_company_fk
            FOREIGN KEY (company_id, bank_account_id)
            REFERENCES bank_accounts(company_id, id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_guarantee_customer_company_fk') THEN
          ALTER TABLE contracting_guarantees ADD CONSTRAINT ctg_guarantee_customer_company_fk
            FOREIGN KEY (company_id, beneficiary_customer_id)
            REFERENCES customers(company_id, id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ctg_tender_customer_company_fk') THEN
          ALTER TABLE contracting_tenders ADD CONSTRAINT ctg_tender_customer_company_fk
            FOREIGN KEY (company_id, customer_id)
            REFERENCES customers(company_id, id) ON DELETE RESTRICT;
        END IF;
      END $$;
      CREATE OR REPLACE FUNCTION ctg_guarantee_integrity_guard()
      RETURNS trigger LANGUAGE plpgsql AS $guard$
      DECLARE
        parent_row contracting_guarantees%ROWTYPE;
        tender_row contracting_tenders%ROWTYPE;
      BEGIN
        IF TG_OP = 'UPDATE' AND OLD.guarantee_type = 'initial' AND (
          NEW.guarantee_type IS DISTINCT FROM OLD.guarantee_type
          OR NEW.company_id IS DISTINCT FROM OLD.company_id
          OR NEW.project_id IS DISTINCT FROM OLD.project_id
          OR NEW.tender_id IS DISTINCT FROM OLD.tender_id
          OR NEW.contract_kind IS DISTINCT FROM OLD.contract_kind
          OR NEW.owner_contract_id IS DISTINCT FROM OLD.owner_contract_id
          OR NEW.subcontract_id IS DISTINCT FROM OLD.subcontract_id
          OR NEW.parent_guarantee_id IS DISTINCT FROM OLD.parent_guarantee_id
        ) THEN
          RAISE EXCEPTION 'ctg_initial_guarantee_is_immutable';
        END IF;

        IF NEW.parent_guarantee_id IS NOT NULL THEN
          SELECT * INTO parent_row FROM contracting_guarantees
           WHERE id = NEW.parent_guarantee_id FOR KEY SHARE;
          IF NOT FOUND OR parent_row.company_id <> NEW.company_id
            OR parent_row.project_id <> NEW.project_id
            OR parent_row.guarantee_type <> 'initial'
            OR NEW.guarantee_type <> 'performance'
            OR NEW.tender_id IS DISTINCT FROM parent_row.tender_id THEN
            RAISE EXCEPTION 'ctg_performance_parent_mismatch';
          END IF;
          SELECT * INTO tender_row FROM contracting_tenders
           WHERE id = parent_row.tender_id FOR KEY SHARE;
          IF NOT FOUND OR tender_row.status <> 'awarded'
            OR NEW.contract_kind IS DISTINCT FROM tender_row.awarded_contract_kind
            OR NEW.owner_contract_id IS DISTINCT FROM tender_row.awarded_owner_contract_id
            OR NEW.subcontract_id IS DISTINCT FROM tender_row.awarded_subcontract_id THEN
            RAISE EXCEPTION 'ctg_performance_awarded_contract_mismatch';
          END IF;
        END IF;

        IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
          IF NOT (
            (OLD.status = 'draft' AND NEW.status IN ('issued', 'cancelled'))
            OR (OLD.status = 'issued' AND NEW.status IN ('active', 'cancelled'))
            OR (OLD.status = 'active' AND NEW.status IN ('extended', 'released', 'expired', 'cancelled'))
            OR (OLD.status = 'extended' AND NEW.status IN ('active', 'released', 'expired', 'cancelled'))
            OR (OLD.status = 'expired' AND NEW.status = 'released')
          ) THEN
            RAISE EXCEPTION 'ctg_guarantee_invalid_lifecycle_transition';
          END IF;
          IF NEW.status = 'extended' AND NEW.expiry_date <= OLD.expiry_date THEN
            RAISE EXCEPTION 'ctg_guarantee_extension_requires_later_expiry';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $guard$;
      DROP TRIGGER IF EXISTS ctg_guarantee_integrity_guard_trg ON contracting_guarantees;
      CREATE TRIGGER ctg_guarantee_integrity_guard_trg
        BEFORE INSERT OR UPDATE ON contracting_guarantees
        FOR EACH ROW EXECUTE FUNCTION ctg_guarantee_integrity_guard();
    `);
  });
}