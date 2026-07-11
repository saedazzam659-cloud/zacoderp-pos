// ─────────────────────────────────────────────────────────────────────────
// Shared helper that posts the monthly depreciation run for a single
// company. Extracted from POST /api/fixed-assets/depreciation/post so the
// auto-depreciation scheduler can call the exact same logic without going
// through HTTP / auth — keeping behaviour identical between manual and
// scheduled runs.
//
// The operation is naturally idempotent: for each active asset we first
// check fa_depreciation_runs for an existing (companyId, assetId, month,
// year) row and skip the asset if one is already there. So calling this
// helper twice on the same day for the same period is safe.
// ─────────────────────────────────────────────────────────────────────────
import { and, eq, or, gt, lt } from "drizzle-orm";
import {
  db,
  fixedAssetsTable,
  faDepreciationRunsTable,
  journalEntriesTable,
  journalEntryLinesTable,
} from "@workspace/db";
import { buildDepreciationRunJournal } from "./fa-journals.js";
import { computePeriodDepreciation } from "./depreciationCalc.js";
import { reserveJeNumberFromEntry } from "./sequences.js";
import { logger } from "./logger.js";

export interface PostDepreciationResult {
  posted: number;          // number of new run rows inserted
  skipped: number;         // assets that already had a run for this period
  jeFailed: number;        // run rows saved but the matching JE build failed
  period: { month: number; year: number };
}

export async function postDepreciationForCompany(
  cid: number,
  month: number,
  year: number,
  postedBy: string | null,
  opts: { userId?: number | null } = {},
): Promise<PostDepreciationResult> {
  const userId = opts.userId ?? null;
  if (month < 1 || month > 12 || year < 2000) {
    throw new Error("فترة غير صالحة");
  }
  const assets = await db.select().from(fixedAssetsTable)
    .where(and(eq(fixedAssetsTable.companyId, cid), eq(fixedAssetsTable.status, "active" as any)));

  let posted = 0, skipped = 0, jeFailed = 0;

  for (const a of assets) {
    // Skip if already posted for this period (per-asset idempotency).
    const existing = await db.select().from(faDepreciationRunsTable)
      .where(and(
        eq(faDepreciationRunsTable.companyId, cid),
        eq(faDepreciationRunsTable.assetId, a.id),
        eq(faDepreciationRunsTable.periodMonth, month),
        eq(faDepreciationRunsTable.periodYear, year),
      ));
    if (existing.length > 0) { skipped += 1; continue; }

    // Skip if asset's depreciation start is after the requested period.
    if (a.depreciationStart) {
      const ds = new Date(a.depreciationStart as any);
      const dsYear = ds.getFullYear();
      const dsMonth = ds.getMonth() + 1;
      if (year < dsYear || (year === dsYear && month < dsMonth)) { skipped += 1; continue; }
    }

    const purchase = Number(a.purchaseValue || 0);
    const scrap    = Number(a.scrapValue || 0);
    const accum    = Number(a.accumulatedDepreciation || 0);
    // Day-based (pro-rata) depreciation for straight_line; legacy monthly for
    // declining_balance. Shared with the preview + schedule so all three agree.
    const { amount: monthly } = computePeriodDepreciation({
      purchaseValue: purchase,
      scrapValue: scrap,
      lifeYears: Number(a.lifeYears || 1),
      depreciationMethod: String(a.depreciationMethod || "straight_line"),
      depreciationStart: a.depreciationStart as any,
      purchaseDate: a.purchaseDate as any,
      accumulatedDepreciation: accum,
    }, month, year);
    const remaining = Math.max(0, purchase - scrap - accum);
    const apply    = Number(Math.min(monthly, remaining).toFixed(2));
    if (apply <= 0) { skipped += 1; continue; }

    const newAccum = accum + apply;
    const newBook  = Math.max(scrap, purchase - newAccum);
    const [run] = await db.insert(faDepreciationRunsTable).values({
      companyId: cid, assetId: a.id,
      periodMonth: month, periodYear: year,
      depreciationAmount: String(apply.toFixed(2)),
      bookValueBefore: String((purchase - accum).toFixed(2)),
      bookValueAfter:  String(newBook.toFixed(2)),
      postedBy,
    }).returning();

    const newStatus = newBook <= scrap + 0.01 ? "fully_depreciated" : a.status;
    await db.update(fixedAssetsTable).set({
      accumulatedDepreciation: String(newAccum.toFixed(2)),
      bookValue: String(newBook.toFixed(2)),
      status: newStatus as any,
      updatedAt: new Date(),
    }).where(and(eq(fixedAssetsTable.id, a.id), eq(fixedAssetsTable.companyId, cid)));

    // Phase-2: post the matching depreciation JE. Failures are non-fatal —
    // the run row is already saved and the user can retry from مركز الترحيل
    // once any missing FA accounts are mapped on /fixed-assets/settings.
    try {
      await buildDepreciationRunJournal(cid, run.id, db, { userId });
    } catch (e: any) {
      jeFailed += 1;
      logger.warn({ err: e, runId: run.id, companyId: cid }, "fa depreciation JE failed");
    }
    posted += 1;
  }

  return { posted, skipped, jeFailed, period: { month, year } };
}

// ═════════════════════════════════════════════════════════════════════════
// UNPOST a single depreciation run (fully reverse its economic effect).
// ═════════════════════════════════════════════════════════════════════════
// Atomically:
//   1. reverse the asset's accumulated depreciation (-= run amount) and restore
//      its book value, reverting fully_depreciated → active if it was auto-set;
//   2. reserve the run's JE number (keyed fa_depreciation:runId) so a later
//      re-post reuses the SAME number, then delete the JE (+lines) after nulling
//      the run's journalEntryId FK first;
//   3. flip the run row to status='unposted' (KEEPING the row so it can be
//      re-posted, recomputed day-based, from the current restored state).
//
// Chain integrity: refuses if a LATER posted run exists for the same asset —
// accumulated depreciation is a running chain, so the newest period must be
// unposted first (mirrors the block-on-child guards elsewhere).
export async function unpostDepreciationRun(
  cid: number,
  runId: number,
  opts: { userId?: number | null } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(faDepreciationRunsTable)
      .where(and(eq(faDepreciationRunsTable.id, runId), eq(faDepreciationRunsTable.companyId, cid)))
      .for("update");
    if (!run) throw new Error("سجل الإهلاك غير موجود");
    if (run.status !== "posted") throw new Error("السجل غير مُرحَّل بالفعل");

    // Guard: no later posted run for this asset (must unpost newest-first).
    const later = await tx.select({ id: faDepreciationRunsTable.id }).from(faDepreciationRunsTable)
      .where(and(
        eq(faDepreciationRunsTable.companyId, cid),
        eq(faDepreciationRunsTable.assetId, run.assetId),
        eq(faDepreciationRunsTable.status, "posted"),
        or(
          gt(faDepreciationRunsTable.periodYear, run.periodYear),
          and(
            eq(faDepreciationRunsTable.periodYear, run.periodYear),
            gt(faDepreciationRunsTable.periodMonth, run.periodMonth),
          ),
        ),
      )).limit(1);
    if (later.length > 0) {
      throw new Error("لا يمكن فك الترحيل: يوجد إهلاك مُرحَّل لفترة أحدث لنفس الأصل — افكّ ترحيل الفترة الأحدث أولاً");
    }

    // Reverse the asset's accumulated depreciation + book value.
    const [a] = await tx.select().from(fixedAssetsTable)
      .where(and(eq(fixedAssetsTable.id, run.assetId), eq(fixedAssetsTable.companyId, cid)))
      .for("update");
    if (!a) throw new Error("الأصل الثابت غير موجود");
    const purchase = Number(a.purchaseValue || 0);
    const scrap    = Number(a.scrapValue || 0);
    const amount   = Number(run.depreciationAmount || 0);
    const newAccum = Math.max(0, Number(a.accumulatedDepreciation || 0) - amount);
    const newBook  = Math.max(scrap, purchase - newAccum);
    const newAssetStatus = a.status === "fully_depreciated" ? "active" : a.status;
    await tx.update(fixedAssetsTable).set({
      accumulatedDepreciation: String(newAccum.toFixed(2)),
      bookValue: String(newBook.toFixed(2)),
      status: newAssetStatus as any,
      updatedAt: new Date(),
    }).where(and(eq(fixedAssetsTable.id, a.id), eq(fixedAssetsTable.companyId, cid)));

    // Reverse the JE: stash its number for reuse (in-tx via dx), null the FK
    // FIRST, then delete lines + entry.
    if (run.journalEntryId) {
      await reserveJeNumberFromEntry(cid, "fa_depreciation", run.id, run.journalEntryId, tx as any);
      await tx.update(faDepreciationRunsTable)
        .set({ journalEntryId: null })
        .where(and(eq(faDepreciationRunsTable.id, run.id), eq(faDepreciationRunsTable.companyId, cid)));
      await tx.delete(journalEntryLinesTable)
        .where(eq(journalEntryLinesTable.entryId, run.journalEntryId));
      await tx.delete(journalEntriesTable)
        .where(and(eq(journalEntriesTable.id, run.journalEntryId), eq(journalEntriesTable.companyId, cid)));
    }

    await tx.update(faDepreciationRunsTable)
      .set({ status: "unposted" })
      .where(and(eq(faDepreciationRunsTable.id, run.id), eq(faDepreciationRunsTable.companyId, cid)));
  });
}

// ═════════════════════════════════════════════════════════════════════════
// RE-POST a single depreciation run (recompute day-based + reapply).
// ═════════════════════════════════════════════════════════════════════════
// Atomically recomputes the run amount from the asset's CURRENT (restored)
// accumulated depreciation — so re-posting after an unpost yields the correct
// day-based figure — reapplies it to the asset, flips the run to posted, then
// rebuilds its JE (forced posted, reusing the stashed number).
//
// Chain integrity: refuses if an EARLIER unposted run exists for the same asset
// (must re-post oldest-first so the running accumulated chain stays correct).
export async function repostDepreciationRun(
  cid: number,
  runId: number,
  opts: { userId?: number | null; postedBy?: string | null } = {},
): Promise<void> {
  const userId = opts.userId ?? null;
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(faDepreciationRunsTable)
      .where(and(eq(faDepreciationRunsTable.id, runId), eq(faDepreciationRunsTable.companyId, cid)))
      .for("update");
    if (!run) throw new Error("سجل الإهلاك غير موجود");
    if (run.status !== "unposted") throw new Error("السجل مُرحَّل بالفعل");

    // Guard: no earlier unposted run for this asset (must re-post oldest-first).
    const earlier = await tx.select({ id: faDepreciationRunsTable.id }).from(faDepreciationRunsTable)
      .where(and(
        eq(faDepreciationRunsTable.companyId, cid),
        eq(faDepreciationRunsTable.assetId, run.assetId),
        eq(faDepreciationRunsTable.status, "unposted"),
        or(
          lt(faDepreciationRunsTable.periodYear, run.periodYear),
          and(
            eq(faDepreciationRunsTable.periodYear, run.periodYear),
            lt(faDepreciationRunsTable.periodMonth, run.periodMonth),
          ),
        ),
      )).limit(1);
    if (earlier.length > 0) {
      throw new Error("لا يمكن الترحيل: يوجد إهلاك غير مُرحَّل لفترة أقدم لنفس الأصل — رحّل الفترة الأقدم أولاً");
    }

    const [a] = await tx.select().from(fixedAssetsTable)
      .where(and(eq(fixedAssetsTable.id, run.assetId), eq(fixedAssetsTable.companyId, cid)))
      .for("update");
    if (!a) throw new Error("الأصل الثابت غير موجود");

    const purchase = Number(a.purchaseValue || 0);
    const scrap    = Number(a.scrapValue || 0);
    const accum    = Number(a.accumulatedDepreciation || 0);
    const { amount: monthly } = computePeriodDepreciation({
      purchaseValue: purchase,
      scrapValue: scrap,
      lifeYears: Number(a.lifeYears || 1),
      depreciationMethod: String(a.depreciationMethod || "straight_line"),
      depreciationStart: a.depreciationStart as any,
      purchaseDate: a.purchaseDate as any,
      accumulatedDepreciation: accum,
    }, run.periodMonth, run.periodYear);
    const remaining = Math.max(0, purchase - scrap - accum);
    const apply    = Number(Math.min(monthly, remaining).toFixed(2));
    const newAccum = accum + apply;
    const newBook  = Math.max(scrap, purchase - newAccum);

    await tx.update(faDepreciationRunsTable).set({
      depreciationAmount: String(apply.toFixed(2)),
      bookValueBefore: String((purchase - accum).toFixed(2)),
      bookValueAfter:  String(newBook.toFixed(2)),
      status: "posted",
      journalEntryId: null,
      postedBy: opts.postedBy ?? run.postedBy ?? null,
      postedAt: new Date(),
    }).where(and(eq(faDepreciationRunsTable.id, run.id), eq(faDepreciationRunsTable.companyId, cid)));

    const newAssetStatus = newBook <= scrap + 0.01 ? "fully_depreciated" : (a.status === "fully_depreciated" ? "active" : a.status);
    await tx.update(fixedAssetsTable).set({
      accumulatedDepreciation: String(newAccum.toFixed(2)),
      bookValue: String(newBook.toFixed(2)),
      status: newAssetStatus as any,
      updatedAt: new Date(),
    }).where(and(eq(fixedAssetsTable.id, a.id), eq(fixedAssetsTable.companyId, cid)));

    // Rebuild the JE inside the same tx (forced posted). Only build when there
    // is something to depreciate; a zero-amount re-post stays posted with no JE.
    if (apply > 0) {
      await buildDepreciationRunJournal(cid, run.id, tx as any, { userId, forcePosted: true });
    }
  });
}
