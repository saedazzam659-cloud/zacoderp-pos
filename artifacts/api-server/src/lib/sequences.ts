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

/** Escape the LIKE wildcards in a literal prefix so a prefix that happens to
 *  contain `%`, `_` or `\` can never widen the match. Paired with `ESCAPE '\'`. */
function escapeLike(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1");
}

/** Highest running number ALREADY issued for a given (sequence, rendered-month)
 *  bucket, read from the append-only `sequence_logs`. This is what lets a
 *  per-month counter self-heal: the first time a month is touched after the
 *  per-period upgrade (or when an old corrupted single-counter row was cleared),
 *  the new month counter is seeded just above the true maximum already issued
 *  that month — so it can never re-emit a number a document already used.
 *
 *  `renderedPrefix` is `${prefix}${renderMonthPattern(...)}` (e.g. "QU-05-"),
 *  so the LIKE isolates exactly the rows belonging to this month's stream. The
 *  trailing-digits regex pulls the padded running number off the formatted
 *  string. Returns `null` when this month has never been issued.
 *
 *  Note: `sequence_logs` is company/sequence-scoped but NOT branch-scoped, so
 *  in a multi-branch tenant this returns the company-wide max for the month.
 *  That only ever seeds a NEW branch's month counter slightly HIGHER (a gap),
 *  never lower — gaps are acceptable, reuse is not. */
async function maxIssuedForPeriod(
  exec: { execute: (q: any) => Promise<{ rows?: Array<{ mx: number | null }> }> },
  sequenceId: number,
  renderedPrefix: string,
): Promise<number | null> {
  const like = `${escapeLike(renderedPrefix)}%`;
  const r = await exec.execute(sql`
    SELECT MAX((regexp_match(generated_number, '(\\d+)$'))[1]::int) AS mx
    FROM sequence_logs
    WHERE sequence_id = ${sequenceId}
      AND generated_number LIKE ${like} ESCAPE '\\'
  `);
  return r.rows?.[0]?.mx ?? null;
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

    // 2. Resolve the counter BUCKET for this issuance:
    //      • monthly_reset OFF → the single continuous "" sentinel row
    //        (identical to the pre-period behaviour).
    //      • monthly_reset ON  → a per-month row keyed by "YYYY-MM", so each
    //        month is an independent stream that out-of-order / backdated entry
    //        can never disturb.
    const monthlyReset  = seq.monthly_reset === true;
    const currentPeriod = periodKey(effectiveDate);          // "YYYY-MM"
    const counterPeriod = monthlyReset ? currentPeriod : ""; // bucket key

    // Look up (or create) the per-(branch, period) counter row, locking it so
    // two concurrent issuances on the SAME bucket serialize.
    const counterRows = await tx.execute<{ id: number; current_number: number }>(sql`
      SELECT id, current_number
      FROM sequence_counters
      WHERE sequence_id = ${seq.id} AND branch_id = ${branchKey} AND period = ${counterPeriod}
      FOR UPDATE
    `);

    let counterId: number;
    let issuedNumber: number;

    const existingCounter = counterRows.rows?.[0];
    if (existingCounter) {
      // Hot path: the bucket already exists — just issue its running number.
      counterId    = existingCounter.id;
      issuedNumber = existingCounter.current_number;
    } else {
      // First issuance into this bucket — compute the seed.
      let seed: number;
      if (monthlyReset) {
        // Each month starts at start_number, but NEVER below what has already
        // been issued this month (logs) nor below a legacy "" counter that is
        // being adopted on a monthly_reset toggle (see below).
        seed = seq.start_number;

        const renderedPrefix = `${seq.prefix ?? ""}${renderMonthPattern(seq.month_pattern, effectiveDate)}`;
        const logMax = await maxIssuedForPeriod(tx, seq.id, renderedPrefix);
        if (logMax != null) seed = Math.max(seed, logMax + 1);

        // Legacy adoption: a sequence that ran WITHOUT monthly reset has a
        // single "" row. The first issuance after the toggle is turned ON must
        // adopt that running number for the CURRENT month (so it never reuses an
        // already-issued number), then retire the "" row so later months reset
        // cleanly. We only adopt when the "" row has never been stamped (NULL)
        // or was last stamped in THIS very month.
        const legacyRows = await tx.execute<{ id: number; current_number: number; last_period: string | null }>(sql`
          SELECT id, current_number, last_period
          FROM sequence_counters
          WHERE sequence_id = ${seq.id} AND branch_id = ${branchKey} AND period = ''
          FOR UPDATE
        `);
        const legacy = legacyRows.rows?.[0];
        if (legacy && (legacy.last_period == null || legacy.last_period === counterPeriod)) {
          seed = Math.max(seed, legacy.current_number);
          await tx.execute(sql`
            UPDATE sequence_counters
            SET last_period = ${counterPeriod}, updated_at = NOW()
            WHERE id = ${legacy.id}
          `);
        }
      } else {
        // Non-reset: identical seeding to the pre-period engine.
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
        seed = hasAnyCounter
          ? seq.start_number
          : Math.max(seq.start_number, seq.current_number);
      }

      const inserted = await tx.execute<{ id: number; current_number: number }>(sql`
        INSERT INTO sequence_counters (sequence_id, branch_id, period, current_number, last_period, created_at, updated_at)
        VALUES (${seq.id}, ${branchKey}, ${counterPeriod}, ${seed}, ${counterPeriod === "" ? null : counterPeriod}, NOW(), NOW())
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

    // 4. Bump the per-(branch, period) counter only. Master sequences row is
    //    NEVER written to during issuance (per spec).
    await tx.update(sequenceCountersTable)
      .set({
        currentNumber: issuedNumber + 1,
        // Stamp the bucket's own period (NULL for the non-reset "" sentinel) so
        // the legacy-adoption path can tell a stamped row from a fresh one.
        lastPeriod:    counterPeriod === "" ? null : counterPeriod,
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

// ──────────────────────────────────────────────────────────────────────────
// Per-payment-method numbering (opt-in)
//
// Companies may optionally configure SEPARATE numbering series per payment
// method (cash / credit / bank). When such a series exists we draw the
// human-readable document number from it; otherwise we transparently fall
// back to the unified base series. This NEVER touches the ZATCA ICV/PIH
// cryptographic chain — only the visible doc number is affected.
//
// Base types that support the split and their allowed payment methods:
//   sales_invoice     → cash | credit | bank
//   purchase_invoice  → cash | credit | bank
//   receipt_voucher   → cash | bank          (vouchers have no credit)
//   payment_voucher   → cash | bank
// ──────────────────────────────────────────────────────────────────────────

const PAYMENT_SPLIT_METHODS: Record<string, readonly string[]> = {
  sales_invoice:    ["cash", "credit", "bank"],
  purchase_invoice: ["cash", "credit", "bank"],
  receipt_voucher:  ["cash", "bank"],
  payment_voucher:  ["cash", "bank"],
};

/**
 * Resolve the payment-specific sub-type for a base transaction type, or null
 * when the combination is not a recognised split (so the caller uses the base
 * type unchanged). Normalises the payment method and rejects unsupported
 * pairings (e.g. a "credit" voucher).
 */
export function subTypeFor(
  baseType: string,
  paymentType: string | null | undefined,
): string | null {
  const pt = String(paymentType ?? "").trim().toLowerCase();
  const allowed = PAYMENT_SPLIT_METHODS[baseType];
  if (!allowed || !pt || !allowed.includes(pt)) return null;
  return `${baseType}_${pt}`;
}

/**
 * Generate the next document number honouring an OPTIONAL per-payment-method
 * series. Tries the payment-specific sub-type first; if no active sequence is
 * bound to it (returns null), falls back to the unified base type. Each branch
 * is its own short transaction, and the sub-type attempt consumes nothing when
 * it returns null — so there is no number/sequence gap on fallback.
 *
 * Returns null only when NEITHER the sub-type NOR the base type has an active
 * sequence (i.e. the caller's legacy "no sequence configured" path).
 */
export async function nextSequenceForPayment(
  companyId: number,
  baseType: string,
  paymentType: string | null | undefined,
  ctx: NextSequenceCtx = {},
): Promise<string | null> {
  const sub = subTypeFor(baseType, paymentType);
  if (sub) {
    const fromSub = await nextSequenceNumber(companyId, sub, ctx);
    if (fromSub != null) return fromSub;
  }
  return await nextSequenceNumber(companyId, baseType, ctx);
}

/**
 * Same as {@link nextSequenceForPayment} but falls back to the supplied legacy
 * generator when no sequence (sub-type or base) is configured.
 */
export async function nextSequenceForPaymentOrFallback(
  companyId: number,
  baseType: string,
  paymentType: string | null | undefined,
  ctx: NextSequenceCtx,
  fallback: () => string | Promise<string>,
): Promise<string> {
  const fromSeq = await nextSequenceForPayment(companyId, baseType, paymentType, ctx);
  if (fromSeq != null) return fromSeq;
  return await fallback();
}
