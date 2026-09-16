import { createHash } from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { parseContractCreateIdempotencyKey } from "./contracting-contract-create-idempotency.js";

function rows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  return Array.isArray((result as { rows?: unknown[] } | null)?.rows)
    ? (result as { rows: Record<string, unknown>[] }).rows
    : [];
}

function failure(message: string, status = 409): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** Uses the same body/header contract as contract creation. */
export const parseBillCreateIdempotencyKey = parseContractCreateIdempotencyKey;

/** Hash only values that will be persisted by the route. */
export function billCreateFingerprint(payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(payload, Object.keys(payload).sort()))
    .digest("hex");
}

/** Shared startup/agent-heal hook; the route retains this lazy fallback. */
export async function ensureBillCreateIdempotencySchema(): Promise<void> {
  // Do not memoize this process-wide. `db` is an AsyncLocalStorage proxy and
  // this helper runs during both central and external-agent schema healing;
  // caching the first promise would silently skip the active datasource.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS contracting_bill_create_idempotency (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      idempotency_key VARCHAR(128) NOT NULL,
      payload_hash TEXT NOT NULL,
      bill_id INTEGER REFERENCES contracting_progress_bills(id) ON DELETE CASCADE,
      result JSONB NOT NULL,
      status_code INTEGER NOT NULL DEFAULT 201,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, user_id, idempotency_key)
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS contracting_bill_create_idempotency_bill_idx
      ON contracting_bill_create_idempotency(company_id, bill_id)
  `);
  // Early deployments used the PostgreSQL default restrictive FK name.
  // Claims are operational replay state, so a draft deletion must remove its
  // claim rather than becoming impossible because of it.
  await db.execute(sql`
    DO $$
    DECLARE constraint_name text;
    BEGIN
      FOR constraint_name IN
        SELECT con.conname
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_attribute col ON col.attrelid = rel.oid AND col.attnum = ANY(con.conkey)
         WHERE rel.relname = 'contracting_bill_create_idempotency'
           AND con.contype = 'f'
           AND col.attname = 'bill_id'
      LOOP
        EXECUTE format('ALTER TABLE contracting_bill_create_idempotency DROP CONSTRAINT %I', constraint_name);
      END LOOP;
      ALTER TABLE contracting_bill_create_idempotency
        ADD CONSTRAINT contracting_bill_create_idempotency_bill_fk
        FOREIGN KEY (bill_id) REFERENCES contracting_progress_bills(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);
}

export async function createBillIdempotently<T extends { id: number }>(options: {
  companyId: number;
  userId: number;
  idempotencyKey: string;
  payloadHash: string;
  create: (tx: any) => Promise<T>;
}): Promise<
  | { created: true; row: T }
  | { created: false; result: T; statusCode: number }
> {
  await ensureBillCreateIdempotencySchema();
  return db.transaction(async (tx: any) => {
    const claimed = rows(await tx.execute(sql`
      INSERT INTO contracting_bill_create_idempotency
        (company_id, user_id, idempotency_key, payload_hash, result)
      VALUES
        (${options.companyId}, ${options.userId}, ${options.idempotencyKey},
         ${options.payloadHash}, '{}'::jsonb)
      ON CONFLICT (company_id, user_id, idempotency_key) DO NOTHING
      RETURNING id
    `));
    if (!claimed.length) {
      const existing = rows(await tx.execute(sql`
        SELECT payload_hash, result, status_code
          FROM contracting_bill_create_idempotency
         WHERE company_id = ${options.companyId}
           AND user_id = ${options.userId}
           AND idempotency_key = ${options.idempotencyKey}
         FOR UPDATE
      `))[0];
      if (!existing || String(existing.payload_hash) !== options.payloadHash) {
        throw failure("مفتاح العملية مستخدم لبيانات مختلفة؛ استخدم مفتاحاً جديداً");
      }
      const result = existing.result as T;
      if (!result || !Number.isInteger(Number(result.id))) {
        throw failure("تعذر استعادة نتيجة إنشاء المستخلص");
      }
      return { created: false as const, result, statusCode: Number(existing.status_code) || 201 };
    }
    const row = await options.create(tx);
    await tx.execute(sql`
      UPDATE contracting_bill_create_idempotency
         SET bill_id = ${row.id}::integer,
             result = ${JSON.stringify(row)}::jsonb
       WHERE company_id = ${options.companyId}
         AND user_id = ${options.userId}
         AND idempotency_key = ${options.idempotencyKey}
    `);
    return { created: true as const, row };
  });
}