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
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { assertWritableForDate } from "./periodGuard.js";
import { resolvePostingStatus } from "./postingStatus.js";
import { fullAuditFor } from "./journalAudit.js";
import { nextSequenceNumber } from "./sequences.js";

/** Advisory-lock class shared by ALL accounting-adjustment mutators. */
export const ADJ_LOCK_CLASS = 74001;

const pad = (n: number) => String(n).padStart(2, "0");
const lastDayUTC = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

export function* monthsBetween(startISO: string, endISO: string): Generator<{ ym: string; isoDate: string }> {
  const [sy, sm] = startISO.split("-").map(Number);
  const [ey, em] = endISO.split("-").map(Number);
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
        const jeDocNumber = (await nextSequenceNumber(cid, "journal_entry", {
          userId: (req as any)?.authUser?.id ?? null, refTable: "journal_entries",
          branchId: null, docDate: isoDate,
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
          { entryId: entry.id, accountId: adj.expenseAccountId, debit: monthly, credit: "0", sortOrder: 0,
            description: `قسط ${ym} لـ ${adj.name}` },
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
