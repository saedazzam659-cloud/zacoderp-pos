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
import { and, eq } from "drizzle-orm";
import {
  db,
  fixedAssetsTable,
  faDepreciationRunsTable,
} from "@workspace/db";
import { buildDepreciationRunJournal } from "./fa-journals.js";
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
): Promise<PostDepreciationResult> {
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
    const years    = Math.max(1, Number(a.lifeYears || 1));
    const months   = years * 12;
    const method   = String(a.depreciationMethod || "straight_line");
    const book     = Math.max(scrap, purchase - accum);
    let monthly: number;
    if (method === "declining_balance") {
      monthly = (book * (2 / years)) / 12;
    } else {
      monthly = (purchase - scrap) / months;
    }
    const remaining = Math.max(0, purchase - scrap - accum);
    const apply    = Math.min(monthly, remaining);
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
      await buildDepreciationRunJournal(cid, run.id);
    } catch (e: any) {
      jeFailed += 1;
      logger.warn({ err: e, runId: run.id, companyId: cid }, "fa depreciation JE failed");
    }
    posted += 1;
  }

  return { posted, skipped, jeFailed, period: { month, year } };
}
