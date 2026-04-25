import { db } from "@workspace/db";
import { companiesTable, maintenanceRunsTable, maintenanceScheduleTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { logger } from "./logger.js";
import { runAllChecks, MAINTENANCE_TOOL_KEYS, type ToolRunOutcome } from "./maintenanceChecks.js";

// Single-row config primary key — matches the report-scheduler convention.
export const MAINTENANCE_SCHEDULE_ID = 1;

// KSA is fixed UTC+3 (no DST), so we can compare without a tz library.
const KSA_OFFSET_MIN = 3 * 60;
// Polling cadence — 5 min strikes a balance between fast pickup of config
// changes and not hammering the DB for the daily tick.
const TICK_MS  = 5 * 60_000;
const STARTUP_DELAY_MS = 30_000;

export async function ensureMaintenanceScheduleRow() {
  const [existing] = await db.select().from(maintenanceScheduleTable)
    .where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));
  if (existing) return existing;
  const [created] = await db.insert(maintenanceScheduleTable).values({
    id: MAINTENANCE_SCHEDULE_ID,
    enabled: true,
    hourOfDay: 3,
    minuteOfHour: 0,
  }).returning();
  return created;
}

// ─── Time utilities (KSA-local) ──────────────────────────────────────────────
// Returns "minutes since midnight" in KSA local time for a given Date.
function ksaMinutesOfDay(now: Date): number {
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (utcMinutes + KSA_OFFSET_MIN) % (24 * 60);
}
// Returns the YYYY-MM-DD KSA-local date string for a given Date.
function ksaDateKey(now: Date): string {
  const shifted = new Date(now.getTime() + KSA_OFFSET_MIN * 60_000);
  return shifted.toISOString().slice(0, 10);
}

// Decides whether the daily tick should fire right now: schedule is enabled,
// we've crossed the configured local time of day, and we haven't already run
// today (lastRunAt is on a different KSA-local date).
function isDailyDue(
  now: Date,
  cfg: { enabled: boolean; hourOfDay: number; minuteOfHour: number; lastRunAt: Date | null },
): boolean {
  if (!cfg.enabled) return false;
  const target = (cfg.hourOfDay ?? 3) * 60 + (cfg.minuteOfHour ?? 0);
  if (ksaMinutesOfDay(now) < target) return false;
  if (!cfg.lastRunAt) return true;
  return ksaDateKey(cfg.lastRunAt) !== ksaDateKey(now);
}

// ─── Persistence helper — one INSERT per (company, tool) outcome ─────────────
async function persistRunOutcomes(
  companyId: number,
  trigger: "scheduled" | "manual",
  outcomes: ToolRunOutcome[],
): Promise<void> {
  if (!outcomes.length) return;
  await db.insert(maintenanceRunsTable).values(outcomes.map(o => ({
    companyId,
    toolKey: o.toolKey,
    status: o.status,
    count: o.count,
    trigger,
    durationMs: o.durationMs,
    error: o.error ?? null,
    details: o.extras ?? null,
  })));
}

// ─── Public: run the full sweep across all active companies ──────────────────
export interface SweepSummary {
  companies: number;
  toolsRun: number;
  criticalCount: number;
  warnCount: number;
  errorCount: number;
  failedCompanies: number;
}

export async function runMaintenanceSweep(trigger: "scheduled" | "manual"): Promise<SweepSummary> {
  const companies = await db.select({ id: companiesTable.id })
    .from(companiesTable)
    .where(eq(companiesTable.status, "active"));
  let toolsRun = 0, criticalCount = 0, warnCount = 0, errorCount = 0, failedCompanies = 0;
  for (const c of companies) {
    try {
      const outcomes = await runAllChecks(c.id);
      await persistRunOutcomes(c.id, trigger, outcomes);
      toolsRun += outcomes.length;
      for (const o of outcomes) {
        if (o.status === "critical") criticalCount += 1;
        else if (o.status === "warn") warnCount += 1;
        else if (o.status === "error") errorCount += 1;
      }
    } catch (e: any) {
      failedCompanies += 1;
      logger.error({ err: e, companyId: c.id }, "maintenance-sweep: company failed");
    }
  }
  // Update schedule row's "last run" snapshot so the UI can display it.
  await db.update(maintenanceScheduleTable).set({
    lastRunAt: new Date(),
    lastRunStatus: failedCompanies > 0 || errorCount > 0 ? "partial" : "ok",
    lastRunCompanies: companies.length,
    lastRunCriticalCount: criticalCount,
    lastError: null,
    updatedAt: new Date(),
  }).where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));
  // Any new criticals lift the snooze flag so the dashboard banner reappears.
  if (criticalCount > 0) {
    await db.update(maintenanceScheduleTable)
      .set({ alertsMutedUntil: null, updatedAt: new Date() })
      .where(and(
        eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID),
        sql`${maintenanceScheduleTable.alertsMutedUntil} IS NOT NULL`,
      ));
  }
  return { companies: companies.length, toolsRun, criticalCount, warnCount, errorCount, failedCompanies };
}

// ─── Latest-result query (used by the UI badges + dashboard banner) ──────────
export interface LatestResultRow {
  toolKey: string;
  status: string;
  count: number;
  trigger: string;
  runAt: Date;
}

export async function getLatestResultsForCompany(
  companyId: number,
  opts: { trigger?: "scheduled" | "manual" } = {},
): Promise<LatestResultRow[]> {
  // Pick the most recent run per tool_key for this company. DISTINCT ON is
  // the natural fit in Postgres and keeps this O(rows-per-tool). Callers can
  // narrow to a specific trigger so the dashboard "آخر فحص تلقائي" badge
  // doesn't get masked by a more-recent ad-hoc manual run.
  const triggerFilter = opts.trigger ? sql`AND trigger = ${opts.trigger}` : sql``;
  const exec = await db.execute<any>(sql`
    SELECT DISTINCT ON (tool_key)
           tool_key  AS "toolKey",
           status,
           count,
           trigger,
           run_at    AS "runAt"
      FROM maintenance_runs
     WHERE company_id = ${companyId}
       ${triggerFilter}
     ORDER BY tool_key, run_at DESC
  `);
  return ((exec as any).rows ?? []) as LatestResultRow[];
}

// ─── Dashboard banner — companies whose latest run hit "critical" ────────────
export interface CriticalAlertRow {
  companyId: number;
  companyName: string;
  toolKey: string;
  count: number;
  runAt: Date;
}

export async function getCriticalAlerts(limit = 20): Promise<CriticalAlertRow[]> {
  // For each (company, tool), only the most recent row matters. We take the
  // latest per pair, keep those whose status='critical', and join the company
  // name for display. Limit defends against an extreme worst-case payload.
  const exec = await db.execute<any>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (company_id, tool_key)
             company_id, tool_key, status, count, run_at
        FROM maintenance_runs
       ORDER BY company_id, tool_key, run_at DESC
    )
    SELECT l.company_id AS "companyId",
           c.name_ar    AS "companyName",
           l.tool_key   AS "toolKey",
           l.count,
           l.run_at     AS "runAt"
      FROM latest l
      JOIN companies c ON c.id = l.company_id
     WHERE l.status = 'critical'
       AND c.status = 'active'
     ORDER BY l.run_at DESC
     LIMIT ${limit}
  `);
  return ((exec as any).rows ?? []) as CriticalAlertRow[];
}

// ─── Scheduler boot (called once from index.ts) ──────────────────────────────
let started = false;
export function startMaintenanceScheduler() {
  if (started) return;
  started = true;

  async function tick() {
    try {
      const cfg = await ensureMaintenanceScheduleRow();
      // Always advance lastTickAt so we can tell from the UI when the loop
      // last evaluated, even on days the schedule is off.
      await db.update(maintenanceScheduleTable)
        .set({ lastTickAt: new Date() })
        .where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));
      if (!isDailyDue(new Date(), cfg)) return;
      const summary = await runMaintenanceSweep("scheduled");
      logger.info({ summary }, "maintenance-scheduler: scheduled sweep complete");
    } catch (e: any) {
      logger.error({ err: e }, "maintenance-scheduler: tick error");
      try {
        await db.update(maintenanceScheduleTable)
          .set({ lastError: e?.message ?? String(e), updatedAt: new Date() })
          .where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));
      } catch { /* swallow — already logged */ }
    }
  }

  setTimeout(() => {
    void tick();
    setInterval(() => { void tick(); }, TICK_MS);
  }, STARTUP_DELAY_MS);
}

// Re-export for routes that want to enumerate tool keys.
export { MAINTENANCE_TOOL_KEYS };
