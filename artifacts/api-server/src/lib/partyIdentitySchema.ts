import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Additive bootstrap for optional shared party identities. Existing role rows
 * stay untouched; their nullable links are empty until a manager links them.
 */
export async function ensurePartyIdentitySchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '4s'`);
    await tx.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS party_identities (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        code TEXT NOT NULL,
        name_ar TEXT NOT NULL,
        name_en TEXT,
        vat_number TEXT,
        cr_number TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT party_identities_company_code_uq UNIQUE (company_id, code),
        CONSTRAINT party_identities_company_id_id_uq UNIQUE (company_id, id)
      );
      ALTER TABLE companies
        ADD COLUMN IF NOT EXISTS shared_party_identity_enabled BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS party_identity_id INTEGER;
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS party_identity_id INTEGER;
      CREATE UNIQUE INDEX IF NOT EXISTS customers_party_identity_uq
        ON customers(company_id, party_identity_id);
      CREATE UNIQUE INDEX IF NOT EXISTS suppliers_party_identity_uq
        ON suppliers(company_id, party_identity_id);
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_party_identity_fk') THEN
          ALTER TABLE customers ADD CONSTRAINT customers_party_identity_fk
            FOREIGN KEY (party_identity_id) REFERENCES party_identities(id) ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'suppliers_party_identity_fk') THEN
          ALTER TABLE suppliers ADD CONSTRAINT suppliers_party_identity_fk
            FOREIGN KEY (party_identity_id) REFERENCES party_identities(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `));
  });
}
