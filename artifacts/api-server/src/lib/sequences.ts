// Centralized document-number generator (مسلسل الحركات) — branch-aware.
//
// Every operational route that needs a business document number (sales
// invoice, purchase invoice, journal entry, etc.) calls `nextSequenceNumber`
// with the active branch in `ctx.branchId`. Each (sequence, branch) pair
// gets its OWN independent counter row in `sequence_counters`, so two
// branches running on the same sequence config produce two completely
// independent number streams (e.g. branch A: INV-0001..0050 while branch B
// is still on INV-0001..0010).
//
// Flow inside one short-lived transaction:
//   1. Lock the master sequence row (FOR UPDATE) — keeps the existing
//      serialization story intact and prevents the PATCH endpoint from
//      racing with issuance.
//   2. Validate the sequence still has capacity (issuedNumber <= endNumber).
//   3. Look up `sequence_counters` by (sequenceId, branchId) FOR UPDATE.
//      • If absent: seed a NEW row.
//          - If NO counter exists yet for this sequence (first issuance ever
//            after the per-branch upgrade), seed at MAX(start_number,
//            sequences.current_number) so existing tenants never re-issue
//            a number their old single-counter system already consumed.
//          - Otherwise seed at sequences.start_number (per spec).
//      • If present: use its current_number directly.
//   4. Format the number as `${prefix}${pad(currentNumber, padLength)}`.
//   5. Increment the per-branch counter (NOT the master) and write the
//      sequence_logs row. The master `sequences.current_number` is NEVER
//      modified during issuance — per spec ("لا يتم تعديل Sequence Master").
//
// `branchId` resolution: callers should pass the active branch id from the
// request body (or the user's session). When the operation is not branch-
// scoped (e.g. stock_transfer / stock_adjustment / stock_count, which target
// warehouses rather than branches), pass `null` — the helper coalesces to
// the sentinel value 0 to keep the unique index on (sequenceId, branchId)
// usable as a plain b-tree.
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

import { db, sequencesTable, sequenceLogsTable, sequenceCountersTable } from "@workspace/db";
import { sql, and, eq } from "drizzle-orm";

export type NextSequenceCtx = {
  userId?: number | null;
  refTable?: string | null;
  refId?: string | number | null;
  /** Active branch for this operation. `null`/`undefined` → company-wide
   *  counter (sentinel branchId = 0 in the table). */
  branchId?: number | null;
  /** The date the user actually entered on the document (e.g. entryDate
   *  for JEs, invoiceDate for sales/purchase invoices, deliveryDate for
   *  goods deliveries…).  When the company has opted into
   *  `sequenceDateSource = "document"` in General Settings, this is the
   *  date used to render `{MM}/{YY}/{YYYY}` tokens in the sequence
   *  pattern — so a backdated JE produces the month it actually belongs
   *  to, not the month it was entered. When omitted (or when the company
   *  is on the default `"system"` setting), today's date is used. */
  docDate?: Date | string | null;
};

export class SequenceCapacityExceededError extends Error {
  constructor(public sequenceCode: string) {
    super(`تم بلوغ الحد الأقصى لمسلسل "${sequenceCode}"`);
    this.name = "SequenceCapacityExceededError";
  }
}

/**
 * Render the configured `monthPattern` with current-date tokens substituted.
 * Returns "" when the pattern is null/empty, preserving the legacy format.
 *
 * Supported tokens: {MM} {M} {YY} {YYYY}.
 * Unknown tokens are left as-is so a typo never silently disappears.
 */
function renderMonthPattern(pattern: string | null | undefined, now: Date = new Date()): string {
  if (!pattern) return "";
  const m  = now.getMonth() + 1;          // 1..12
  const y  = now.getFullYear();           // e.g. 2026
  const MM = String(m).padStart(2, "0");
  const YY = String(y).slice(-2);
  return pattern
    .replace(/\{MM\}/g,   MM)
    .replace(/\{M\}/g,    String(m))
    .replace(/\{YYYY\}/g, String(y))
    .replace(/\{YY\}/g,   YY);
}

function format(prefix: string, n: number, padLength: number, monthPattern: string | null | undefined, effectiveDate: Date): string {
  const padded = padLength > 0 ? String(n).padStart(padLength, "0") : String(n);
  const month  = renderMonthPattern(monthPattern, effectiveDate);
  return `${prefix ?? ""}${month}${padded}`;
}

/** Resolve the date to feed into the `{MM}/{YY}/{YYYY}` substitution.
 *  When the company opted into "document" date AND the caller supplied
 *  a usable `docDate`, that date wins. Otherwise we use today.  Invalid
 *  date inputs are silently ignored so a bad client payload can never
 *  corrupt the issued number. */
function resolveEffectiveDate(source: string | null | undefined, docDate: Date | string | null | undefined): Date {
  if (source === "document" && docDate != null && docDate !== "") {
    const d = docDate instanceof Date ? docDate : new Date(String(docDate));
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** "YYYY-MM" period key for the monthly-reset feature. Uses the same local
 *  month/year basis as `renderMonthPattern` so the reset boundary always lines
 *  up with the `{MM}` token rendered into the number. */
function periodKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Generate the next business document number for the given transaction type
 * scoped to `ctx.branchId`. Each (sequence, branch) pair has its own counter.
 *
 * @returns The formatted number string (e.g. "INV-0023") or `null` when no
 *          active sequence is configured — the caller MUST fall back to its
 *          legacy numbering in that case.
 * @throws  SequenceCapacityExceededError when the sequence is configured but
 *          the per-branch counter has reached endNumber. Surface this to the
 *          user so an admin can extend or rotate the sequence.
 */
export async function nextSequenceNumber(
  companyId: number,
  transactionType: string,
  ctx: NextSequenceCtx = {},
): Promise<string | null> {
  // Coalesce missing branch to the company-wide sentinel (0). Real branches
  // are always > 0 (branches.id is serial). Negative values are coerced to 0
  // defensively — the index treats them as a single bucket regardless.
  const branchKey = ctx.branchId != null && Number(ctx.branchId) > 0
    ? Number(ctx.branchId)
    : 0;

  return await db.transaction(async (tx) => {
    // Pull the company-wide date-source setting once per issuance. The
    // column was added in Phase-2 print/sequence settings and defaults
    // to "system" so existing tenants keep their legacy behaviour.
    const cfgRows = await tx.execute<{ sequence_date_source: string | null }>(sql`
      SELECT sequence_date_source FROM companies WHERE id = ${companyId} LIMIT 1
    `);
    const dateSource = cfgRows.rows?.[0]?.sequence_date_source ?? "system";
    const effectiveDate = resolveEffectiveDate(dateSource, ctx.docDate);

    // Resolve the fiscal period for routing. CRITICAL: we use the document
    // date here unconditionally, NOT `effectiveDate` — `sequence_date_source`
    // only controls whether `{YY}/{MM}` pattern tokens render today's date
    // or the document's date. The fiscal-period filter is a hard business
    // rule ("this sequence is for FY 2026 docs only"), so a backdated 2025
    // entry must always pick the 2025-eligible sequence regardless of the
    // pattern-token setting. Falling back to `effectiveDate` (today) would
    // let a 2026-scoped sequence steal numbers from 2025 documents — the
    // exact bug we hit when `sequence_date_source = "system"`.
    const periodResolveDate: Date = (() => {
      if (ctx.docDate != null && ctx.docDate !== "") {
        const d = ctx.docDate instanceof Date ? ctx.docDate : new Date(String(ctx.docDate));
        if (!isNaN(d.getTime())) return d;
      }
      return effectiveDate;
    })();
    const periodDateStr = `${periodResolveDate.getUTCFullYear()}-${String(periodResolveDate.getUTCMonth() + 1).padStart(2, "0")}-${String(periodResolveDate.getUTCDate()).padStart(2, "0")}`;
    const periodRows = await tx.execute<{ id: number }>(sql`
      SELECT id FROM fiscal_periods
      WHERE company_id = ${companyId}
        AND start_date <= ${periodDateStr}
        AND end_date   >= ${periodDateStr}
      ORDER BY id ASC
      LIMIT 1
    `);
    const periodId = periodRows.rows?.[0]?.id ?? null;
    // When the date falls outside every configured period (early tenants,
    // pre-fiscal-year data), only universal sequences may match.
    const periodMatchSql = periodId != null
      ? sql`OR fiscal_period_ids @> ${JSON.stringify([periodId])}::jsonb`
      : sql``;

    // 1. Lock the candidate master sequence row.
    //    Resolution preference (mirrors /peek/:txType):
    //      • scoped sequence whose fiscal_period_ids includes this date's period → wins
    //      • universal sequence (empty fiscal_period_ids)                        → fallback
    //    Ties within the same bucket break by lowest id (deterministic).
    const seqRows = await tx.execute<{
      id: number; prefix: string; start_number: number; current_number: number;
      end_number: number; pad_length: number; code: string; month_pattern: string | null;
      monthly_reset: boolean;
    }>(sql`
      SELECT id, prefix, start_number, current_number, end_number, pad_length, code, month_pattern, monthly_reset
      FROM sequences
      WHERE company_id = ${companyId}
        AND is_active = true
        AND transaction_types ? ${transactionType}
        AND (jsonb_array_length(fiscal_period_ids) = 0 ${periodMatchSql})
      ORDER BY
        CASE WHEN jsonb_array_length(fiscal_period_ids) > 0 THEN 0 ELSE 1 END ASC,
        id ASC
      LIMIT 1
      FOR UPDATE
    `);

    const seq = seqRows.rows?.[0];
    if (!seq) return null;

    // 2. Look up (or create) the per-branch counter row, locking it so two
    //    concurrent issuances on the SAME (sequence, branch) serialize.
    const counterRows = await tx.execute<{ id: number; current_number: number; last_period: string | null }>(sql`
      SELECT id, current_number, last_period
      FROM sequence_counters
      WHERE sequence_id = ${seq.id} AND branch_id = ${branchKey}
      FOR UPDATE
    `);

    // Monthly-reset period key for THIS issuance, derived from the same
    // effective date that renders the {MM} token, so the reset boundary and
    // the printed month always agree.
    const currentPeriod = periodKey(effectiveDate);

    let counterId: number;
    let issuedNumber: number;

    const existingCounter = counterRows.rows?.[0];
    if (existingCounter) {
      counterId    = existingCounter.id;
      issuedNumber = existingCounter.current_number;
      // Monthly reset: when the parent sequence opted in AND we already have a
      // recorded period that differs from the current one, restart at
      // startNumber. A NULL last_period (counter pre-dates the feature, or was
      // created before the toggle was on) is treated as "adopt current month
      // without resetting" — so flipping the toggle on never retroactively
      // reuses a number already issued earlier this month.
      if (
        seq.monthly_reset &&
        existingCounter.last_period != null &&
        existingCounter.last_period !== currentPeriod
      ) {
        issuedNumber = seq.start_number;
      }
    } else {
      // No counter yet for this (sequence, branch). Decide the seed value:
      //   • If this sequence has NO counters at all → first issuance ever
      //     after the per-branch upgrade. Inherit the master's currentNumber
      //     to avoid re-issuing numbers an existing tenant already used.
      //   • Otherwise → fresh per-branch start, seed at start_number per spec.
      const anyExisting = await tx.execute<{ exists_flag: boolean }>(sql`
        SELECT EXISTS(
          SELECT 1 FROM sequence_counters WHERE sequence_id = ${seq.id}
        ) AS exists_flag
      `);
      const hasAnyCounter = !!anyExisting.rows?.[0]?.exists_flag;
      const seed = hasAnyCounter
        ? seq.start_number
        : Math.max(seq.start_number, seq.current_number);

      // Seed `last_period` with the current period so a brand-new counter
      // adopts the month without resetting on its very first issuance.
      const inserted = await tx.execute<{ id: number; current_number: number }>(sql`
        INSERT INTO sequence_counters (sequence_id, branch_id, current_number, last_period, created_at, updated_at)
        VALUES (${seq.id}, ${branchKey}, ${seed}, ${currentPeriod}, NOW(), NOW())
        RETURNING id, current_number
      `);
      const newRow = inserted.rows?.[0];
      if (!newRow) throw new Error("تعذر إنشاء عداد فرع للمسلسل");
      counterId    = newRow.id;
      issuedNumber = newRow.current_number;
    }

    // 3. Capacity check uses the PER-BRANCH counter against the master cap.
    if (issuedNumber > seq.end_number) {
      throw new SequenceCapacityExceededError(seq.code);
    }

    const generated = format(seq.prefix ?? "", issuedNumber, seq.pad_length ?? 0, seq.month_pattern, effectiveDate);

    // 4. Bump the per-branch counter only. Master sequences row is NEVER
    //    written to during issuance (per spec).
    await tx.update(sequenceCountersTable)
      .set({
        currentNumber: issuedNumber + 1,
        // Stamp the period this number belongs to so the NEXT issuance can
        // detect a month rollover (only acted upon when monthlyReset is on).
        lastPeriod:    currentPeriod,
        updatedAt:     new Date(),
      })
      .where(eq(sequenceCountersTable.id, counterId));

    // 5. Append-only audit row.
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
