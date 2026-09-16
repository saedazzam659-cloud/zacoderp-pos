import { createHash } from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type ContractCreateOperation = "owner_contract_create" | "subcontract_create";

const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

function resultRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
}

function idempotencyFailure(message: string, status = 409): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/**
 * Contract creation uses the same client-generated request-id convention as
 * invoice creation. Accept the body field used by the web form and the
 * standard header so a retrying API client can use either representation.
 */
export function parseContractCreateIdempotencyKey(req: {
  body?: unknown;
  get?: (name: string) => string | undefined;
}): string {
  const body = req.body as {
    idempotencyKey?: unknown;
    clientRequestId?: unknown;
  } | null | undefined;
  const headerValue = req.get?.("Idempotency-Key")?.trim() || null;
  const bodyValue = body?.idempotencyKey ?? body?.clientRequestId;
  if (bodyValue != null && typeof bodyValue !== "string") {
    throw idempotencyFailure("مفتاح العملية يجب أن يكون نصاً", 400);
  }
  const bodyKey = typeof bodyValue === "string" ? bodyValue.trim() : null;
  if (headerValue && bodyKey && headerValue !== bodyKey) {
    throw idempotencyFailure("مفتاح العملية في الترويسة لا يطابق جسم الطلب", 400);
  }
  const key = headerValue || bodyKey;
  if (!key || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw idempotencyFailure(
      `مفتاح العملية مطلوب وبحد أقصى ${MAX_IDEMPOTENCY_KEY_LENGTH} حرفاً`,
      400,
    );
  }
  return key;
}

/**
 * Keep the fingerprint based on the normalized values that are actually
 * persisted, not on incidental JSON property ordering or the request key.
 * The operation, tenant, and user are columns in the claim's unique scope.
 */
export function contractCreateFingerprint(payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(payload, Object.keys(payload).sort()))
    .digest("hex");
}

/**
 * Additive storage for create claims. This intentionally stores the response
 * snapshot as well as the target id: a replay must return the original result
 * even if the contract is edited later. No contract-number uniqueness is
 * introduced here, so existing duplicate historical numbers remain valid.
 */
export async function ensureContractCreateIdempotencySchema(): Promise<void> {
  await db.execute(sql`
      CREATE TABLE IF NOT EXISTS contracting_contract_create_idempotency (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        operation TEXT NOT NULL CHECK (operation IN ('owner_contract_create', 'subcontract_create')),
        idempotency_key VARCHAR(128) NOT NULL,
        payload_hash TEXT NOT NULL,
        owner_contract_id INTEGER,
        subcontractor_contract_id INTEGER,
        result JSONB NOT NULL,
        status_code INTEGER NOT NULL DEFAULT 201,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (company_id, user_id, operation, idempotency_key)
      )
  `);
  await db.execute(sql`
      CREATE INDEX IF NOT EXISTS contracting_contract_create_idempotency_result_idx
        ON contracting_contract_create_idempotency(company_id, operation, owner_contract_id, subcontractor_contract_id)
  `);
}

if (false) {
async function createContractIdempotentlyRebaseAlternative<T extends { id: number }>(options: {
  companyId: number;
  userId: number;
  operation: ContractCreateOperation;
  idempotencyKey: string;
  payloadHash: string;
  create: (tx: any) => Promise<T>;
}): Promise<
  | { created: true; row: T }
  | { created: false; result: T; statusCode: number }
> {
  await ensureContractCreateIdempotencySchema();
  return db.transaction(async (tx: any) => {
    const claimed = resultRows(await tx.execute(sql`
      INSERT INTO contracting_contract_create_idempotency
        (company_id, user_id, operation, idempotency_key, payload_hash, result)
      VALUES
        (${options.companyId}, ${options.userId}, ${options.operation},
         ${options.idempotencyKey}, ${options.payloadHash}, '{}'::jsonb)
      ON CONFLICT (company_id, user_id, operation, idempotency_key) DO NOTHING
      RETURNING id
    `));

    if (!claimed.length) {
      const existing = resultRows(await tx.execute(sql`
        SELECT payload_hash, result, status_code
          FROM contracting_contract_create_idempotency
         WHERE company_id = ${options.companyId}
           AND user_id = ${options.userId}
           AND operation = ${options.operation}
           AND idempotency_key = ${options.idempotencyKey}
         FOR UPDATE
      `))[0];
      if (!existing) {
        // A committed claim cannot disappear while this transaction is open.
        // If it did, retrying is safer than creating outside the claim.
        throw idempotencyFailure("تعذر استعادة نتيجة إنشاء العقد");
      }
      if (String(existing.payload_hash) !== options.payloadHash) {
        throw idempotencyFailure("مفتاح العملية مستخدم لبيانات مختلفة؛ استخدم مفتاحاً جديداً");
      }
      const result = existing.result as T;
      if (!result || !Number.isInteger(Number(result.id))) {
        throw idempotencyFailure("تعذر استعادة نتيجة إنشاء العقد");
      }
      return {
        created: false as const,
        result,
        statusCode: Number(existing.status_code) || 201,
      };
    }

    const row = await options.create(tx);
    await tx.execute(sql`
      UPDATE contracting_contract_create_idempotency
         SET owner_contract_id = CASE
               WHEN ${options.operation} = 'owner_contract_create' THEN ${row.id}
               ELSE NULL
             END,
             subcontractor_contract_id = CASE
               WHEN ${options.operation} = 'subcontract_create' THEN ${row.id}
               ELSE NULL
             END,
             result = ${JSON.stringify(row)}::jsonb
       WHERE company_id = ${options.companyId}
         AND user_id = ${options.userId}
         AND operation = ${options.operation}
         AND idempotency_key = ${options.idempotencyKey}
    `);
    return { created: true as const, row };
  });
}
}
export async function createContractIdempotently<T extends { id: number }>(options: {
  companyId: number;
  userId: number;
  operation: ContractCreateOperation;
  idempotencyKey: string;
  payloadHash: string;
  create: (tx: any) => Promise<T>;
}): Promise<
  | { created: true; row: T }
  | { created: false; result: T; statusCode: number }
> {
  await ensureContractCreateIdempotencySchema();
  return db.transaction(async (tx: any) => {
    const claimed = resultRows(await tx.execute(sql`
      INSERT INTO contracting_contract_create_idempotency
        (company_id, user_id, operation, idempotency_key, payload_hash, result)
      VALUES
        (${options.companyId}, ${options.userId}, ${options.operation},
         ${options.idempotencyKey}, ${options.payloadHash}, '{}'::jsonb)
      ON CONFLICT (company_id, user_id, operation, idempotency_key) DO NOTHING
      RETURNING id
    `));

    if (!claimed.length) {
      const existing = resultRows(await tx.execute(sql`
        SELECT payload_hash, result, status_code
          FROM contracting_contract_create_idempotency
         WHERE company_id = ${options.companyId}
           AND user_id = ${options.userId}
           AND operation = ${options.operation}
           AND idempotency_key = ${options.idempotencyKey}
         FOR UPDATE
      `))[0];
      if (!existing) {
        // A committed claim cannot disappear while this transaction is open.
        // If it did, retrying is safer than creating outside the claim.
        throw idempotencyFailure("تعذر استعادة نتيجة إنشاء العقد");
      }
      if (String(existing.payload_hash) !== options.payloadHash) {
        throw idempotencyFailure("مفتاح العملية مستخدم لبيانات مختلفة؛ استخدم مفتاحاً جديداً");
      }
      const result = existing.result as T;
      if (!result || !Number.isInteger(Number(result.id))) {
        throw idempotencyFailure("تعذر استعادة نتيجة إنشاء العقد");
      }
      return {
        created: false as const,
        result,
        statusCode: Number(existing.status_code) || 201,
      };
    }

    const row = await options.create(tx);
    await tx.execute(sql`
      UPDATE contracting_contract_create_idempotency
         SET owner_contract_id = CASE
                WHEN ${options.operation} = 'owner_contract_create' THEN ${row.id}::integer
               ELSE NULL
             END,
             subcontractor_contract_id = CASE
                WHEN ${options.operation} = 'subcontract_create' THEN ${row.id}::integer
               ELSE NULL
             END,
             result = ${JSON.stringify(row)}::jsonb
       WHERE company_id = ${options.companyId}
         AND user_id = ${options.userId}
         AND operation = ${options.operation}
         AND idempotency_key = ${options.idempotencyKey}
    `);
    return { created: true as const, row };
  });
}
