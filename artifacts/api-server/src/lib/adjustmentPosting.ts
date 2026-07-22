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
  // actually covers it. 2025-11-04 → 2026-05-03 is EXACTLY 6 months
  // (Nov..Apr), not 7 — when the end day is before the start day, the end
  // month is partial and is dropped from the schedule.
  if (ed < sd) {
    em -= 1;
    if (em < 1) { em = 12; ey -= 1; }
  }
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    const ym = `${y}-${pad(m)}`;
    // Last day of the month = canonical recognition date.
    const isoDate = `${y}-${pad(m)}-${pad(lastDayUTC(y, m - 1))}`;
    yield { ym, isoDate };
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
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

      const existingRuns = await tx.select({ ym: accountingAdjustmentRunsTable.periodMonth })
        .from(accountingAdjustmentRunsTable)
        .where(eq(accountingAdjustmentRunsTable.adjustmentId, adj.id));
      const generated = new Set(existingRuns.map(r => r.ym));
      const monthly = adj.monthlyAmount;
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

      let totalMonths = 0;
      for (const _ of monthsBetween(adj.startDate, adj.endDate)) totalMonths++;

      for (const { ym, isoDate } of monthsBetween(adj.startDate, adj.endDate)) {
        if (generated.has(ym)) continue;
        // Never pre-book future months — a month becomes due on its last day.
        if (isoDate > today) break;

        const writability = await assertWritableForDate(cid, isoDate);
        if (!writability.ok) { skipped.push({ ym, reason: writability.reason }); continue; }

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
        await tx.insert(journalEntryLinesTable).values([
          // Cost center rides the EXPENSE (debit) line only — stored as the
          // cost-center CODE (manual-JE convention).
          { entryId: entry.id, accountId: adj.expenseAccountId, debit: monthly, credit: "0", sortOrder: 0,
            costCenter: ccCode, description: `قسط ${ym} لـ ${adj.name}` },
          { entryId: entry.id, accountId: adj.contraAccountId,  debit: "0", credit: monthly, sortOrder: 1,
            description: `قسط ${ym} لـ ${adj.name}` },
        ]);
        const inserted = await tx.insert(accountingAdjustmentRunsTable).values({
          adjustmentId: adj.id, companyId: cid, periodMonth: ym,
          journalEntryId: entry.id, amount: monthly,
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
