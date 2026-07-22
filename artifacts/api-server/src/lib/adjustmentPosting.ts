// ─────────────────────────────────────────────────────────────────────────
// Monthly accounting-adjustments generation core (prepaid / accrued).
//
// Extracted from the POST /api/adjustments/run-due route so the exact same
// logic backs BOTH the manual UI button and the in-process auto scheduler
// (adjustmentScheduler.ts) — mirroring how depreciationPosting.ts backs the
// FA depreciation button + fa-auto-dep scheduler.
//
// Concurrency model:
//   - each adjustment is processed inside ONE transaction that first takes
//     pg_advisory_xact_lock(ADJ_LOCK_CLASS, adjustment.id) — the same lock
//     the financial-edit PUT and the /:id/generate route take, so a
//     re-spread edit can never interleave with month posting
//   - the adjustment row is RE-READ under the lock (monthlyAmount/endDate
//     may have just been re-spread by a concurrent edit)
//   - months that already have a run row are skipped
//   - future months (isoDate > today) are never pre-booked
//   - the (adjustment_id, period_month) unique index is the final arbiter
//     (orphan JE rolled back on conflict)
// ─────────────────────────────────────────────────────────────────────────
import type { Request } from "express";
import { db } from "@workspace/db";
import {
  accountingAdjustmentsTable, accountingAdjustmentRunsTable,
  journalEntriesTable, journalEntryLinesTable,
  costCentersTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { assertWritableForDate } from "./periodGuard.js";
import { resolvePostingStatus } from "./postingStatus.js";
import { fullAuditFor } from "./journalAudit.js";
import { nextJeSubSequence } from "./sequences.js";

/** Advisory-lock class shared by ALL accounting-adjustment mutators. */
export const ADJ_LOCK_CLASS = 74001;

const pad = (n: number) => String(n).padStart(2, "0");
const lastDayUTC = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

export function* monthsBetween(startISO: string, endISO: string): Generator<{ ym: string; isoDate: string }> {
  const [sy, sm, sd] = startISO.split("-").map(Number);
  let [ey, em, ed] = endISO.split("-").map(Number);
  // Day-aware month count: an installment month only counts if the period
  // actually covers it. 2025-11-22 → 2026-05-21 is EXACTLY 6 months —
  // when the end day is before the start day, the end month is partial
  // and is dropped from the schedule.
  if (ed < sd) {
    em -= 1;
    if (em < 1) { em = 12; ey -= 1; }
  }
  const count = Math.max(0, (ey - sy) * 12 + (em - sm) + 1);
  // ANNIVERSARY recognition (user requirement): installment k falls one
  // FULL month after the previous one, on the START DAY of month —
  // start 2025-11-22 → first installment 2025-12-22, then 2026-01-22 …
  // (day clamped to short months, e.g. day 31 → Feb 28/29).
  for (let k = 1; k <= count; k++) {
    const mAbs = sm + k;
    const y = sy + Math.floor((mAbs - 1) / 12);
    const m = ((mAbs - 1) % 12) + 1;
    const day = Math.min(sd, lastDayUTC(y, m - 1));
    yield { ym: `${y}-${pad(m)}`, isoDate: `${y}-${pad(m)}-${pad(day)}` };
  }
}

// ─── Periodicity extension (ADDITIVE — 'monthly' keeps legacy behavior) ───
export type AdjPeriodicity = "monthly" | "quarterly" | "semiannual" | "annual";
export const PERIODICITY_MONTHS: Record<AdjPeriodicity, number> = {
  monthly: 1, quarterly: 3, semiannual: 6, annual: 12,
};
export const normalizePeriodicity = (raw: unknown): AdjPeriodicity =>
  raw === "quarterly" || raw === "semiannual" || raw === "annual" ? raw : "monthly";

export interface AdjInstallment { ym: string; isoDate: string; monthsCovered: number }

/**
 * Group the anniversary month schedule into installments of `P` months.
 * Each installment falls on the FIRST month of its group (start of the
 * quarter / half / year relative to startDate) and covers up to P monthly
 * slices — the final installment may cover fewer when the span is not an
 * exact multiple. For 'monthly' this degenerates to monthsBetween 1:1.
 */
export function installmentsBetween(
  startISO: string, endISO: string, periodicity: AdjPeriodicity,
): AdjInstallment[] {
  const months = [...monthsBetween(startISO, endISO)];
  const p = PERIODICITY_MONTHS[periodicity] ?? 1;
  if (p <= 1) return months.map(m => ({ ...m, monthsCovered: 1 }));
  const out: AdjInstallment[] = [];
  for (let i = 0; i < months.length; i += p) {
    const covered = Math.min(p, months.length - i);
    out.push({ ym: months[i].ym, isoDate: months[i].isoDate, monthsCovered: covered });
  }
  return out;
}

const r2n = (x: number) => Math.round(x * 100) / 100;

/**
 * Amount of installment at `slotIndex` within `schedule`.
 * 'monthly' keeps the LEGACY rule verbatim (every run = monthlyAmount, no
 * closure absorb — the reschedule endpoint remains the corrective lever).
 * Grouped periodicities: amount = monthly × monthsCovered, and the FINAL
 * scheduled installment closes the balance exactly against totalAmount
 * (total − Σ previously recognized), so no residue is stranded.
 */
export function installmentAmount(
  adj: { monthlyAmount: string; totalAmount: string; periodicity?: string | null },
  schedule: AdjInstallment[],
  slotIndex: number,
  recognizedSoFar: number,
): string {
  const periodicity = normalizePeriodicity(adj.periodicity);
  const monthly = Number(adj.monthlyAmount) || 0;
  if (periodicity === "monthly") return adj.monthlyAmount;
  const slot = schedule[slotIndex];
  if (slotIndex === schedule.length - 1) {
    const closing = r2n((Number(adj.totalAmount) || 0) - recognizedSoFar);
    if (closing > 0) return closing.toFixed(2);
  }
  return r2n(monthly * slot.monthsCovered).toFixed(2);
}

export interface CcSplitEntry { costCenterId: number; pct: number }

/** Parse + sanity-check a stored costCenterSplit jsonb value. */
export function parseCcSplit(raw: unknown): CcSplitEntry[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const entries: CcSplitEntry[] = [];
  for (const e of raw) {
    const ccId = Number((e as any)?.costCenterId);
    const pct = Number((e as any)?.pct);
    if (!Number.isInteger(ccId) || ccId <= 0 || !Number.isFinite(pct) || pct <= 0) return null;
    entries.push({ costCenterId: ccId, pct });
  }
  const sum = entries.reduce((s, e) => s + e.pct, 0);
  if (Math.abs(sum - 100) > 0.01) return null;
  return entries;
}

/**
 * Build the EXPENSE (debit) side lines of a periodic adjustment JE.
 * With a valid costCenterSplit the installment is split pro-rata across the
 * given cost centers (codes resolved by the caller); the LAST split line
 * absorbs the rounding delta so Σdebits === amount exactly. Otherwise one
 * line carrying the single ccCode (legacy behavior).
 */
export function buildExpenseDebitLines(
  entryId: number,
  expenseAccountId: number,
  amountStr: string,
  desc: string,
  singleCcCode: string | null,
  split: { code: string | null; pct: number }[] | null,
): { entryId: number; accountId: number; debit: string; credit: string; sortOrder: number; costCenter: string | null; description: string }[] {
  if (!split || split.length === 0) {
    return [{ entryId, accountId: expenseAccountId, debit: amountStr, credit: "0",
      sortOrder: 0, costCenter: singleCcCode, description: desc }];
  }
  const amount = Number(amountStr) || 0;
  const lines: ReturnType<typeof buildExpenseDebitLines> = [];
  let allocated = 0;
  for (let i = 0; i < split.length; i++) {
    const part = i === split.length - 1
      ? r2n(amount - allocated)
      : r2n(amount * split[i].pct / 100);
    allocated = r2n(allocated + part);
    lines.push({ entryId, accountId: expenseAccountId, debit: part.toFixed(2), credit: "0",
      sortOrder: i, costCenter: split[i].code, description: desc });
  }
  return lines;
}

/**
 * Resolve cost-center CODES for a stored costCenterSplit (id → code).
 * Any unknown id degrades that entry to a code-less line rather than
 * failing the whole posting run.
 */
export async function resolveCcSplitCodes(
  tx: any, cid: number, raw: unknown,
): Promise<{ code: string | null; pct: number }[] | null> {
  const split = parseCcSplit(raw);
  if (!split) return null;
  const rows = await tx.select({ id: costCentersTable.id, code: costCentersTable.code })
    .from(costCentersTable).where(eq(costCentersTable.companyId, cid));
  const byId = new Map<number, string>(rows.map((r: any) => [r.id, r.code]));
  return split.map(s => ({ code: byId.get(s.costCenterId) ?? null, pct: s.pct }));
}

/**
 * Resolve the sequence-counter BRANCH bucket the company's manual JEs
 * actually run on. Passing branchId:null to nextSequenceNumber issues from
 * the branch-0 sentinel bucket — a FRESH counter starting at 0001 — while
 * the real JE stream lives on the user's branch counter (e.g. QYD-1258 /
 * QYD/07/2027). Adjustment JEs must CONTINUE the existing series, so pick
 * the real-branch bucket with the highest running number for any active
 * journal_entry sequence; fall back to the sentinel only when the company
 * has never issued a branch-scoped JE number.
 */
export async function resolveJeIssuingBranch(
  cid: number,
  docDate: string,
  // When the company binds a sequence to the adjustment sub-type series
  // ("adjustment_entry"), the number will DRAW from that sequence — so the
  // branch bucket must be resolved against it, not the journal_entry one.
  subType: string | null = null,
): Promise<number | null> {
  // 1. Resolve the SAME sequence nextSequenceNumber will pick for this date
  //    (period-scoped sequence for the doc's fiscal period wins, else the
  //    universal one; ties break by lowest id — mirrors sequences.ts).
  const periodRows = await db.execute<{ id: number }>(sql`
    SELECT id FROM fiscal_periods
    WHERE company_id = ${cid} AND start_date <= ${docDate} AND end_date >= ${docDate}
    ORDER BY id ASC LIMIT 1
  `);
  const periodId = periodRows.rows?.[0]?.id ?? null;
  const periodMatchSql = periodId != null
    ? sql`OR fiscal_period_ids @> ${JSON.stringify([periodId])}::jsonb`
    : sql``;
  const pickSeq = async (txType: string): Promise<number | undefined> => {
    const seqRows = await db.execute<{ id: number }>(sql`
      SELECT id FROM sequences
      WHERE company_id = ${cid}
        AND is_active = true
        AND transaction_types ? ${txType}
        AND (jsonb_array_length(fiscal_period_ids) = 0 ${periodMatchSql})
      ORDER BY
        CASE WHEN jsonb_array_length(fiscal_period_ids) > 0 THEN 0 ELSE 1 END ASC,
        id ASC
      LIMIT 1
    `);
    return seqRows.rows?.[0]?.id;
  };
  // Sub-type series wins when bound (mirrors nextJeSubSequence resolution).
  const seqId = (subType ? await pickSeq(subType) : undefined) ?? await pickSeq("journal_entry");
  if (!seqId) return null;

  // 2. Within THAT sequence, pick the real-branch bucket with the highest
  //    running number — the stream the company's manual JEs actually use.
  const rows = await db.execute<{ branch_id: number }>(sql`
    SELECT branch_id
    FROM sequence_counters
    WHERE sequence_id = ${seqId} AND branch_id > 0
    ORDER BY current_number DESC
    LIMIT 1
  `);
  return rows.rows?.[0]?.branch_id ?? null;
}

export interface AdjustmentRunSummaryItem {
  adjustmentId: number;
  name: string;
  type: string;
  created: string[];
  skipped: { ym: string; reason: string }[];
}

export interface RunDueResult {
  summary: AdjustmentRunSummaryItem[];
  total: number;
}

/**
 * Generate all DUE (isoDate <= today) monthly JEs for every active
 * auto-generate adjustment of a company. `req` is optional — scheduler
 * calls pass undefined, so the JE audit trail simply records no user
 * (same convention as background depreciation posting).
 */
export async function runDueAdjustmentsForCompany(
  cid: number,
  req?: Request | null,
  onlyAdjustmentId?: number,
): Promise<RunDueResult> {
  const candidates = await db.select({ id: accountingAdjustmentsTable.id })
    .from(accountingAdjustmentsTable).where(and(
      eq(accountingAdjustmentsTable.companyId, cid),
      eq(accountingAdjustmentsTable.status, "active"),
      eq(accountingAdjustmentsTable.autoGenerate, true),
      ...(onlyAdjustmentId ? [eq(accountingAdjustmentsTable.id, onlyAdjustmentId)] : []),
    ));

  const summary: AdjustmentRunSummaryItem[] = [];
  const today = new Date().toISOString().slice(0, 10);
  // Date-aware branch resolution, memoized per docDate (one adjustment can
  // span fiscal years whose sequences live on different branch buckets).
  const branchCache = new Map<string, number | null>();
  const issuingBranchFor = async (isoDate: string): Promise<number | null> => {
    if (!branchCache.has(isoDate)) branchCache.set(isoDate, await resolveJeIssuingBranch(cid, isoDate, "adjustment_entry"));
    return branchCache.get(isoDate) ?? null;
  };

  for (const { id: adjId } of candidates) {
    const item = await db.transaction(async (tx): Promise<AdjustmentRunSummaryItem | null> => {
      // Serialize against financial-edit PUT and /:id/generate.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADJ_LOCK_CLASS}, ${adjId})`);

      // Re-read UNDER the lock — a concurrent edit may have re-spread the
      // monthly amount / extended the end date / cancelled the adjustment.
      const [adj] = await tx.select().from(accountingAdjustmentsTable).where(and(
        eq(accountingAdjustmentsTable.id, adjId),
        eq(accountingAdjustmentsTable.companyId, cid),
        eq(accountingAdjustmentsTable.status, "active"),
        eq(accountingAdjustmentsTable.autoGenerate, true),
      ));
      if (!adj) return null;

      const existingRuns = await tx.select({
        ym: accountingAdjustmentRunsTable.periodMonth,
        amount: accountingAdjustmentRunsTable.amount,
      })
        .from(accountingAdjustmentRunsTable)
        .where(eq(accountingAdjustmentRunsTable.adjustmentId, adj.id));
      const generated = new Set(existingRuns.map(r => r.ym));
      // Recognized-so-far tracker: only consulted by NON-monthly schedules
      // (final installment closes the balance exactly against totalAmount).
      let recognizedSoFar = existingRuns.reduce((s, r) => s + (Number(r.amount) || 0), 0);
      const created: string[] = [];
      const skipped: { ym: string; reason: string }[] = [];

      // Resolve the adjustment's cost-center CODE once (JE lines store the
      // CODE, not the id). Missing → null (line simply carries no CC).
      let ccCode: string | null = null;
      if (adj.costCenterId != null) {
        const [cc] = await tx.select({ code: costCentersTable.code }).from(costCentersTable)
          .where(and(eq(costCentersTable.id, adj.costCenterId), eq(costCentersTable.companyId, cid)));
        ccCode = cc?.code ?? null;
      }
      // Optional multi-cost-center split (deferred-expense lines) — resolved
      // to CODES once; overrides the single ccCode when present.
      const ccSplit = await resolveCcSplitCodes(tx, cid, (adj as any).costCenterSplit);

      // Periodicity-aware installment schedule ('monthly' == legacy months).
      const schedule = installmentsBetween(
        adj.startDate, adj.endDate, normalizePeriodicity((adj as any).periodicity));
      const totalMonths = schedule.length;

      for (let slot = 0; slot < schedule.length; slot++) {
        const { ym, isoDate } = schedule[slot];
        // NEVER exceed the scheduled installment count — legacy runs booked
        // under the old end-of-month scheme carry shifted period keys, so
        // without this cap the anniversary schedule would mint one extra run.
        if (generated.size >= totalMonths) break;
        if (generated.has(ym)) continue;
        // Never pre-book future months — a month becomes due on its date.
        if (isoDate > today) break;

        const writability = await assertWritableForDate(cid, isoDate);
        if (!writability.ok) { skipped.push({ ym, reason: writability.reason }); continue; }

        const amount = installmentAmount(adj as any, schedule, slot, recognizedSoFar);

        const jeStatus = await resolvePostingStatus(cid, "adjustment");
        // Continuous "journal_entry" sequence — same series as manual JEs and
        // FA depreciation (null preserves prior numberless behavior).
        const jeDocNumber = (await nextJeSubSequence(cid, "adjustment_entry", {
          userId: (req as any)?.authUser?.id ?? null, refTable: "journal_entries",
          branchId: await issuingBranchFor(isoDate), docDate: isoDate,
        })) ?? null;
        const [entry] = await tx.insert(journalEntriesTable).values({
          companyId: cid, docNumber: jeDocNumber, entryDate: isoDate,
          description: `${adj.type === "prepaid" ? "تسوية مصروف مقدم" : "تسوية مصروف مستحق"} — ${adj.name} (${ym})`,
          entryType: adj.type === "prepaid" ? "adjustment_prepaid" : "adjustment_accrued",
          status: jeStatus,
          periodId: writability.period?.id ?? null,
          ...fullAuditFor(req ?? null, jeStatus),
        }).returning();
        // Cost center rides the EXPENSE (debit) side only — either one line
        // (single ccCode) or a pro-rata split across several cost centers.
        const debitLines = buildExpenseDebitLines(
          entry.id, adj.expenseAccountId, amount, `قسط ${ym} لـ ${adj.name}`, ccCode, ccSplit);
        await tx.insert(journalEntryLinesTable).values([
          ...debitLines,
          { entryId: entry.id, accountId: adj.contraAccountId,  debit: "0", credit: amount,
            sortOrder: debitLines.length, description: `قسط ${ym} لـ ${adj.name}` },
        ]);
        const inserted = await tx.insert(accountingAdjustmentRunsTable).values({
          adjustmentId: adj.id, companyId: cid, periodMonth: ym,
          journalEntryId: entry.id, amount,
        }).onConflictDoNothing().returning();
        if (inserted.length === 0) {
          // Concurrent caller already created this month — undo the orphan JE.
          await tx.delete(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, entry.id));
          await tx.delete(journalEntriesTable).where(eq(journalEntriesTable.id, entry.id));
          skipped.push({ ym, reason: "race" });
          continue;
        }
        created.push(ym);
        generated.add(ym);
        recognizedSoFar = r2n(recognizedSoFar + (Number(amount) || 0));
      }

      // Flip to "completed" once every scheduled month has a run — mirrors
      // the single-adjustment /generate endpoint.
      if (generated.size >= totalMonths && totalMonths > 0) {
        await tx.update(accountingAdjustmentsTable)
          .set({ status: "completed", updatedAt: new Date() })
          .where(eq(accountingAdjustmentsTable.id, adj.id));
      }

      return { adjustmentId: adj.id, name: adj.name, type: adj.type, created, skipped };
    });
    if (item) summary.push(item);
  }

  return { summary, total: summary.reduce((s, x) => s + x.created.length, 0) };
}

/**
 * Unpost ONE generated adjustment month starting from its JE id — used by
 * the JE unpost cascade. Per explicit user requirement, unposting must NOT
 * delete the JE or burn its document number: the JE flips to a DRAFT that
 * KEEPS its docNumber, so the user can edit it and re-post it onto the very
 * same sequence number (plain POST /:id/post status flip).
 *
 * The run row is KEPT on purpose: the month still counts as "generated", so
 * neither the hourly scheduler nor /:id/generate will mint a duplicate JE
 * (they skip months that already have a run row regardless of JE status).
 * Returns null when the JE is not referenced by any adjustment run.
 */
export async function unpostAdjustmentRunJe(
  cid: number,
  jeId: number,
): Promise<{ adjustmentId: number; ym: string } | null> {
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(accountingAdjustmentRunsTable).where(and(
      eq(accountingAdjustmentRunsTable.companyId, cid),
      eq(accountingAdjustmentRunsTable.journalEntryId, jeId),
    )).limit(1);
    if (!run) return null;

    // Same lock class/id as generation + financial edit — no interleaving.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADJ_LOCK_CLASS}, ${run.adjustmentId})`);

    await tx.update(journalEntriesTable)
      .set({ status: "draft", updatedAt: new Date() })
      .where(and(
        eq(journalEntriesTable.id, jeId),
        eq(journalEntriesTable.companyId, cid),
      ));

    return { adjustmentId: run.adjustmentId, ym: run.periodMonth };
  });
}

/**
 * Re-sync the run row after a manual edit of its draft JE: the recognized
 * amount reported by the adjustments screen comes from run.amount, so it
 * must follow the (possibly changed) expense-side total of the JE lines.
 */
export async function syncAdjustmentRunAmountForJe(
  cid: number,
  jeId: number,
  newAmount: string,
): Promise<void> {
  await db.update(accountingAdjustmentRunsTable)
    .set({ amount: newAmount })
    .where(and(
      eq(accountingAdjustmentRunsTable.companyId, cid),
      eq(accountingAdjustmentRunsTable.journalEntryId, jeId),
    ));
}
