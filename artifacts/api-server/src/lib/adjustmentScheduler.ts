// ─────────────────────────────────────────────────────────────────────────
// Auto Monthly-Adjustments Scheduler (prepaid / accrued expenses)
//
// Runs in-process, mirroring depreciationScheduler.ts. Every TICK_MS it
// sweeps all ACTIVE companies and calls `runDueAdjustmentsForCompany` —
// the exact same helper backing the manual "تشغيل التسويات المستحقة"
// button — so behaviour is identical between manual and scheduled runs.
//
// No per-company day-of-month config is needed: a month's adjustment JE
// becomes due on the LAST day of that month (its canonical entry date),
// so the hourly tick naturally posts each month's installment at month
// end. The helper is idempotent (skips already-generated months, never
// pre-books future months), so multiple ticks per day are safe.
//
// Only adjustments with `auto_generate = true` participate — the per-
// adjustment checkbox remains the opt-in lever, same as before.
// ─────────────────────────────────────────────────────────────────────────
import { db } from "@workspace/db";
import { companiesTable, accountingAdjustmentsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { logger } from "./logger.js";
import { runDueAdjustmentsForCompany } from "./adjustmentPosting.js";

const TICK_MS = 60 * 60_000;      // hourly — missed windows self-heal next tick
const STARTUP_DELAY_MS = 60_000;  // stagger after fa-auto-dep's 45s

export interface AdjustmentSweepSummary {
  companies: number;        // companies with eligible adjustments
  created: number;          // JEs created across all companies
  failedCompanies: number;  // companies whose run threw
}

export async function runAutoAdjustmentsSweep(): Promise<AdjustmentSweepSummary> {
  // Only bother with companies that actually have an active auto-generate
  // adjustment — one grouped query instead of sweeping every tenant.
  const rows = await db.selectDistinct({ companyId: accountingAdjustmentsTable.companyId })
    .from(accountingAdjustmentsTable)
    .where(and(
      eq(accountingAdjustmentsTable.status, "active"),
      eq(accountingAdjustmentsTable.autoGenerate, true),
    ));
  if (rows.length === 0) return { companies: 0, created: 0, failedCompanies: 0 };

  const activeCompanies = await db.select({ id: companiesTable.id })
    .from(companiesTable)
    .where(and(
      eq(companiesTable.status, "active"),
      inArray(companiesTable.id, rows.map(r => r.companyId)),
    ));

  let created = 0, failedCompanies = 0;
  for (const c of activeCompanies) {
    try {
      const out = await runDueAdjustmentsForCompany(c.id);
      created += out.total;
      if (out.total > 0) {
        logger.info({ companyId: c.id, created: out.total }, "adj-auto: posted");
      }
    } catch (err) {
      failedCompanies += 1;
      logger.error({ err, companyId: c.id }, "adj-auto: company failed");
    }
  }
  return { companies: activeCompanies.length, created, failedCompanies };
}

let intervalHandle: NodeJS.Timeout | null = null;

export function startAdjustmentScheduler(): void {
  if (intervalHandle) return;
  // Skip in test runs to avoid background DB writes during vitest.
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  setTimeout(() => {
    runAutoAdjustmentsSweep().catch((err) =>
      logger.error({ err }, "adj-auto: initial sweep failed"));
    intervalHandle = setInterval(() => {
      runAutoAdjustmentsSweep().catch((err) =>
        logger.error({ err }, "adj-auto: tick failed"));
    }, TICK_MS);
    logger.info({ tickMs: TICK_MS }, "adj-auto: scheduler started");
  }, STARTUP_DELAY_MS);
}

export function stopAdjustmentScheduler(): void {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}
