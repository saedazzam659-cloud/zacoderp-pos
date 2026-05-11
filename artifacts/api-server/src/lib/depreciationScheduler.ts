// ─────────────────────────────────────────────────────────────────────────
// Auto Fixed-Assets Depreciation Scheduler
//
// Runs in-process. Every TICK_MS the scheduler:
//   1. Reads all active companies with `autoPostFaDepreciation = true`.
//   2. Compares the KSA-local day-of-month with each company's
//      `faAutoDepDay` (1..28). When today's day >= configured day, the
//      scheduler posts depreciation for the PREVIOUS calendar month — that
//      mirrors normal accounting practice (close period N on day X of N+1).
//   3. Calls `postDepreciationForCompany` (the same helper backing the
//      manual UI button), so behaviour is identical between manual and
//      scheduled runs. The helper is idempotent: it skips assets that
//      already have a run row for that period, so multiple ticks per day
//      are safe.
//
// KSA is fixed UTC+3 (no DST), so day-of-month math is direct without a
// tz library — same convention used by maintenanceScheduler.ts.
// ─────────────────────────────────────────────────────────────────────────
import { db } from "@workspace/db";
import { companiesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger.js";
import { postDepreciationForCompany } from "./depreciationPosting.js";

const KSA_OFFSET_MIN = 3 * 60;
// Hourly tick is plenty — a missed window of up to one hour is harmless
// because the helper is idempotent and the next tick will catch it.
const TICK_MS = 60 * 60_000;
const STARTUP_DELAY_MS = 45_000;

interface KsaParts { year: number; month: number; day: number }

// Returns KSA-local { year, month (1..12), day (1..31) } for a given Date.
function ksaParts(now: Date): KsaParts {
  const shifted = new Date(now.getTime() + KSA_OFFSET_MIN * 60_000);
  return {
    year:  shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day:   shifted.getUTCDate(),
  };
}

// Given today's KSA parts, return the PREVIOUS calendar month/year.
function previousMonth(parts: KsaParts): { month: number; year: number } {
  if (parts.month === 1) return { month: 12, year: parts.year - 1 };
  return { month: parts.month - 1, year: parts.year };
}

// Pure decision function — exported so tests can pin behaviour.
export function shouldRunForCompany(
  now: Date,
  cfg: { autoPostFaDepreciation: boolean | null; faAutoDepDay: number | null },
): boolean {
  if (!cfg.autoPostFaDepreciation) return false;
  const day = Math.max(1, Math.min(28, Number(cfg.faAutoDepDay ?? 1)));
  return ksaParts(now).day >= day;
}

export interface SchedulerSweepSummary {
  companies: number;       // companies considered
  ran: number;             // companies for which we attempted a post
  posted: number;          // total run rows inserted across all companies
  skipped: number;         // assets skipped (already posted / start date / zero amount)
  failedCompanies: number; // companies whose attempt threw
}

export async function runAutoDepreciationSweep(now: Date = new Date()): Promise<SchedulerSweepSummary> {
  const rows = await db.select({
    id: companiesTable.id,
    autoPostFaDepreciation: companiesTable.autoPostFaDepreciation,
    faAutoDepDay: companiesTable.faAutoDepDay,
  })
    .from(companiesTable)
    .where(and(
      eq(companiesTable.status, "active"),
      eq(companiesTable.autoPostFaDepreciation, true),
    ));

  let ran = 0, posted = 0, skipped = 0, failedCompanies = 0;
  const target = previousMonth(ksaParts(now));

  for (const c of rows) {
    if (!shouldRunForCompany(now, c)) continue;
    ran += 1;
    try {
      const out = await postDepreciationForCompany(
        c.id, target.month, target.year, "system_auto",
      );
      posted += out.posted;
      skipped += out.skipped;
      if (out.posted > 0) {
        logger.info({
          companyId: c.id,
          period: out.period,
          posted: out.posted,
          jeFailed: out.jeFailed,
        }, "fa-auto-dep: posted");
      }
    } catch (err) {
      failedCompanies += 1;
      logger.error({ err, companyId: c.id, target }, "fa-auto-dep: company failed");
    }
  }

  return { companies: rows.length, ran, posted, skipped, failedCompanies };
}

let intervalHandle: NodeJS.Timeout | null = null;

export function startFaDepreciationScheduler(): void {
  if (intervalHandle) return;
  // Skip in test runs to avoid background DB writes during vitest.
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  setTimeout(() => {
    runAutoDepreciationSweep().catch((err) =>
      logger.error({ err }, "fa-auto-dep: initial sweep failed"));
    intervalHandle = setInterval(() => {
      runAutoDepreciationSweep().catch((err) =>
        logger.error({ err }, "fa-auto-dep: tick failed"));
    }, TICK_MS);
    logger.info({ tickMs: TICK_MS }, "fa-auto-dep: scheduler started");
  }, STARTUP_DELAY_MS);
}

export function stopFaDepreciationScheduler(): void {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}
