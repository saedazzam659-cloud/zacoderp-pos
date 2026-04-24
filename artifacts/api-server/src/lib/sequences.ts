// Centralized document-number generator (مسلسل الحركات).
//
// Every operational route that needs a business document number (sales
// invoice, purchase invoice, journal entry, etc.) calls `nextSequenceNumber`.
// The helper:
//   1. Locks the FIRST active sequence bound to the requested transaction
//      type (lowest id) using SELECT … FOR UPDATE — guarantees no two
//      concurrent requests get the same number.
//   2. Validates the sequence still has capacity (currentNumber <= endNumber).
//   3. Formats the number as `${prefix}${pad(currentNumber, padLength)}`.
//   4. Increments `currentNumber` and writes a row to `sequence_logs`.
//   5. Returns the formatted string.
//
// If NO active sequence is configured for the given type the helper returns
// `null` so callers can fall back to their legacy auto-numbering. This makes
// the rollout non-breaking — until an admin creates a sequence the system
// behaves exactly as before.
//
// The whole operation runs in its own short transaction. We deliberately do
// NOT join the caller's transaction: a failed downstream insert should not
// rewind a sequence — gaps in business numbering are acceptable and far
// safer than reusing a previously-issued number.

import { db, sequencesTable, sequenceLogsTable } from "@workspace/db";
import { sql, and, eq } from "drizzle-orm";

export type NextSequenceCtx = {
  userId?: number | null;
  refTable?: string | null;
  refId?: string | number | null;
};

export class SequenceCapacityExceededError extends Error {
  constructor(public sequenceCode: string) {
    super(`تم بلوغ الحد الأقصى لمسلسل "${sequenceCode}"`);
    this.name = "SequenceCapacityExceededError";
  }
}

function format(prefix: string, n: number, padLength: number): string {
  const padded = padLength > 0 ? String(n).padStart(padLength, "0") : String(n);
  return `${prefix ?? ""}${padded}`;
}

/**
 * Generate the next business document number for the given transaction type.
 *
 * @returns The formatted number string (e.g. "INV-0023") or `null` when no
 *          active sequence is configured — the caller MUST fall back to its
 *          legacy numbering in that case.
 * @throws  SequenceCapacityExceededError when the sequence is configured but
 *          its currentNumber has reached endNumber. Surface this to the user
 *          so an admin can extend or rotate the sequence.
 */
export async function nextSequenceNumber(
  companyId: number,
  transactionType: string,
  ctx: NextSequenceCtx = {},
): Promise<string | null> {
  return await db.transaction(async (tx) => {
    // Lock the candidate row. We match on companyId + isActive + the type
    // being present in the JSONB array. Order by id so the choice is
    // deterministic and concurrent callers wait on the SAME row.
    const rows = await tx.execute<{
      id: number; prefix: string; current_number: number;
      end_number: number; pad_length: number; code: string;
    }>(sql`
      SELECT id, prefix, current_number, end_number, pad_length, code
      FROM sequences
      WHERE company_id = ${companyId}
        AND is_active = true
        AND transaction_types ? ${transactionType}
      ORDER BY id ASC
      LIMIT 1
      FOR UPDATE
    `);

    const seq = rows.rows?.[0];
    if (!seq) return null;

    if (seq.current_number > seq.end_number) {
      throw new SequenceCapacityExceededError(seq.code);
    }

    const generated = format(seq.prefix ?? "", seq.current_number, seq.pad_length ?? 0);

    await tx.update(sequencesTable)
      .set({
        currentNumber: seq.current_number + 1,
        updatedAt: new Date(),
      })
      .where(eq(sequencesTable.id, seq.id));

    await tx.insert(sequenceLogsTable).values({
      sequenceId:      seq.id,
      companyId,
      transactionType,
      generatedNumber: generated,
      userId:          ctx.userId ?? null,
      refTable:        ctx.refTable ?? null,
      refId:           ctx.refId != null ? String(ctx.refId) : null,
    });

    return generated;
  });
}

/**
 * Convenience wrapper: try to generate a sequence number, swallow any
 * configuration errors, and fall back to the supplied legacy generator.
 * Capacity errors are NOT swallowed — those must surface to the user.
 */
export async function nextSequenceOrFallback(
  companyId: number,
  transactionType: string,
  ctx: NextSequenceCtx,
  fallback: () => string | Promise<string>,
): Promise<string> {
  const fromSeq = await nextSequenceNumber(companyId, transactionType, ctx);
  if (fromSeq != null) return fromSeq;
  return await fallback();
}
