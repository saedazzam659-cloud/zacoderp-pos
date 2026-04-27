// Unit + integration tests for the report-digest auto-fire scheduler in
// artifacts/api-server/src/lib/reportScheduler.ts.
//
// What this protects:
//   • The "is it due?" gate (`isDue(lastSentAt, frequency)`) decides whether
//     the weekly/monthly digest is sent on its own. A regression in the
//     interval math, the null-handling of `lastSentAt`, or the
//     weekly-vs-monthly dispatch would silently miss real customer emails
//     until manual QA noticed.
//   • The scheduler tick path (`tickReportDigestScheduler`) reads the
//     singleton config row and either short-circuits (disabled, not yet
//     due) or delegates to `runReportDigest("scheduled")`. A regression
//     that fires the digest while disabled — or fails to fire when due —
//     would only show up by checking `report_email_schedule_runs` in prod.
//
//     The tests pin:
//       - isDue(null, *)             → true   (first-ever run)
//       - isDue(weekly, > 7d ago)    → true
//       - isDue(monthly, > 30d ago)  → true
//       - isDue(weekly, < 7d ago)    → false
//       - isDue(monthly, < 30d ago)  → false
//       - tick with enabled=false    → MUST NOT append to
//                                      report_email_schedule_runs
//       - tick with enabled=true + due window → MUST append exactly one
//                                      row to report_email_schedule_runs
//                                      with trigger="scheduled".
//
// How to run:
//   pnpm --filter @workspace/api-server test
//
// Notes:
//   - `report_email_schedules` is a global singleton (id=1). Setup snapshots
//     whatever row exists today, the tests freely mutate id=1, and teardown
//     restores the original row exactly. If no row existed at setup we
//     delete id=1 in teardown so a fresh DB stays fresh.
//   - History rows are tracked by primary key and cleaned up strictly via
//     inArray on the recorded IDs — never via tag/like — so a crashed run
//     can never touch another tenant's data.
//   - The "tick fires" assertion drives the "no reports configured" guard
//     inside `runReportDigest` to land on status="skipped". That branch
//     still inserts into `report_email_schedule_runs` with
//     trigger="scheduled", which is exactly the row-shape we want to lock
//     in, AND it never depends on outbound SMTP being configured in dev.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { eq, inArray, sql } from "drizzle-orm";
import {
  db,
  pool,
  reportEmailSchedulesTable,
  reportEmailScheduleRunsTable,
} from "@workspace/db";

import {
  isDue,
  tickReportDigestScheduler,
  REPORT_SCHEDULE_ID,
} from "../src/lib/reportScheduler.ts";

// Window constants used by the production code. Mirrored here (not imported)
// so a drift in the constant in reportScheduler.ts shows up as a failing
// assertion rather than a silently-passing-but-wrong test.
const WEEK_MS  = 7  * 86_400_000;
const MONTH_MS = 30 * 86_400_000;

// Snapshot of the singleton schedule row taken at setup so teardown can put
// the dev DB back exactly as it found it. `null` means no row existed when
// we began (fresh DB) and teardown should delete id=1.
let scheduleSnapshot: typeof reportEmailSchedulesTable.$inferSelect | null = null;

// PK list used by cleanup() — strict-by-PK, never wildcards. We capture the
// MAX(id) of report_email_schedule_runs at setup AND record any new rows we
// observe during tests so cleanup deletes only what we caused.
let beforeRunMaxId = 0;
const insertedRunIds: number[] = [];

// ─── Lifecycle ──────────────────────────────────────────────────────────────
before(async () => {
  const [existing] = await db.select().from(reportEmailSchedulesTable)
    .where(eq(reportEmailSchedulesTable.id, REPORT_SCHEDULE_ID));
  scheduleSnapshot = existing ?? null;

  const r = await db.execute<{ max_id: number | null }>(sql`
    SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM report_email_schedule_runs
  `);
  const rows = (r as { rows?: Array<{ max_id: number | null }> }).rows ?? [{ max_id: 0 }];
  beforeRunMaxId = Number(rows[0]?.max_id ?? 0);
});

after(async () => {
  try { await cleanup(); } finally {
    try { await pool.end(); } catch { /* already ended is fine */ }
  }
});

async function cleanup(): Promise<void> {
  if (insertedRunIds.length) {
    await db.delete(reportEmailScheduleRunsTable)
      .where(inArray(reportEmailScheduleRunsTable.id, insertedRunIds));
  }

  if (scheduleSnapshot) {
    await db.update(reportEmailSchedulesTable).set({
      enabled:        scheduleSnapshot.enabled,
      reports:        scheduleSnapshot.reports ?? [],
      frequency:      scheduleSnapshot.frequency,
      recipients:     scheduleSnapshot.recipients ?? [],
      lastSentAt:     scheduleSnapshot.lastSentAt,
      lastStatus:     scheduleSnapshot.lastStatus,
      lastError:      scheduleSnapshot.lastError,
      lastReports:    scheduleSnapshot.lastReports,
      lastRecipients: scheduleSnapshot.lastRecipients,
      updatedAt:      scheduleSnapshot.updatedAt,
    }).where(eq(reportEmailSchedulesTable.id, REPORT_SCHEDULE_ID));
  } else {
    await db.delete(reportEmailSchedulesTable)
      .where(eq(reportEmailSchedulesTable.id, REPORT_SCHEDULE_ID));
  }
}

// Persist a known config to the singleton row. Used by the tick tests to
// drive deterministic outcomes without depending on whatever was in dev.
async function setSchedule(values: {
  enabled:    boolean;
  reports:    string[];
  frequency:  "weekly" | "monthly";
  recipients: string[];
  lastSentAt: Date | null;
}): Promise<void> {
  await db.insert(reportEmailSchedulesTable).values({
    id:         REPORT_SCHEDULE_ID,
    enabled:    values.enabled,
    reports:    values.reports,
    frequency:  values.frequency,
    recipients: values.recipients,
    lastSentAt: values.lastSentAt,
  }).onConflictDoUpdate({
    target: reportEmailSchedulesTable.id,
    set: {
      enabled:    values.enabled,
      reports:    values.reports,
      frequency:  values.frequency,
      recipients: values.recipients,
      lastSentAt: values.lastSentAt,
      updatedAt:  new Date(),
    },
  });
}

// Return rows added to report_email_schedule_runs since `beforeRunMaxId`.
// Caller passes the trigger they expect so we never sweep up unrelated
// concurrent rows in a shared dev DB.
async function newRunsSince(trigger: "scheduled" | "manual"): Promise<
  Array<typeof reportEmailScheduleRunsTable.$inferSelect>
> {
  return db.select().from(reportEmailScheduleRunsTable).where(
    sql`${reportEmailScheduleRunsTable.id} > ${beforeRunMaxId}
        AND ${reportEmailScheduleRunsTable.trigger} = ${trigger}`,
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  isDue — pure gate function
// ════════════════════════════════════════════════════════════════════════════
test("isDue: returns true when lastSentAt is null (first-ever run, weekly)", () => {
  assert.equal(isDue(null, "weekly"), true);
});

test("isDue: returns true when lastSentAt is null (first-ever run, monthly)", () => {
  assert.equal(isDue(null, "monthly"), true);
});

test("isDue: returns true for weekly when lastSentAt is older than the weekly window", () => {
  // 1 hour past the weekly window — comfortably outside any clock-skew margin.
  const lastSent = new Date(Date.now() - WEEK_MS - 60 * 60_000);
  assert.equal(isDue(lastSent, "weekly"), true);
});

test("isDue: returns true for monthly when lastSentAt is older than the monthly window", () => {
  const lastSent = new Date(Date.now() - MONTH_MS - 60 * 60_000);
  assert.equal(isDue(lastSent, "monthly"), true);
});

test("isDue: returns false for weekly when lastSentAt is inside the weekly window", () => {
  // 1 day ago — well inside a 7-day window.
  const lastSent = new Date(Date.now() - 1 * 86_400_000);
  assert.equal(isDue(lastSent, "weekly"), false);
});

test("isDue: returns false for monthly when lastSentAt is inside the monthly window", () => {
  // 10 days ago — outside the weekly window but inside the monthly one.
  // Doubles as a guard against a regression that uses the wrong constant.
  const lastSent = new Date(Date.now() - 10 * 86_400_000);
  assert.equal(isDue(lastSent, "monthly"), false);
});

// ════════════════════════════════════════════════════════════════════════════
//  tickReportDigestScheduler — the actual auto-fire path
// ════════════════════════════════════════════════════════════════════════════
test("tick with enabled=false does NOT append a row to report_email_schedule_runs", async () => {
  // Disabled config + a never-sent row (lastSentAt=null) so the ONLY thing
  // that can stop the tick from firing is the enabled gate. If the gate
  // regresses, the run-history insert downstream would happen and this
  // assertion would catch it.
  await setSchedule({
    enabled:    false,
    reports:    ["operational-summary"],
    frequency:  "weekly",
    recipients: ["scheduler-test@example.com"],
    lastSentAt: null,
  });

  // Snapshot existing rows on this trigger so we can assert "exactly zero
  // new rows" rather than depending on the table being empty in dev.
  const beforeRows = await newRunsSince("scheduled");
  await tickReportDigestScheduler();
  const afterRows = await newRunsSince("scheduled");

  // Track anything we see — even if the assertion fails we want cleanup to
  // remove rows we caused so the table is left clean for the next test run.
  for (const row of afterRows) {
    if (!beforeRows.find((r) => r.id === row.id) && !insertedRunIds.includes(row.id)) {
      insertedRunIds.push(row.id);
    }
  }

  assert.equal(
    afterRows.length,
    beforeRows.length,
    "tick must not append to report_email_schedule_runs when enabled=false",
  );
});

test("tick with enabled=true + due window appends exactly one trigger=\"scheduled\" row", async () => {
  // Enabled config with reports=[] forces runReportDigest("scheduled") down
  // the "no reports configured" guard, which records status="skipped" — a
  // deterministic outcome that never depends on outbound SMTP being set up
  // in the dev environment. The KEY contract this pins is that the gate
  // (enabled=true + due) produced a scheduled-trigger history row at all.
  await setSchedule({
    enabled:    true,
    reports:    [],
    frequency:  "weekly",
    recipients: [],
    lastSentAt: null, // null ⇒ definitely due, regardless of frequency
  });

  const beforeRows = await newRunsSince("scheduled");
  await tickReportDigestScheduler();
  const afterRows = await newRunsSince("scheduled");

  // Track what we caused so cleanup removes it.
  const newlyInserted = afterRows.filter((r) => !beforeRows.find((b) => b.id === r.id));
  for (const row of newlyInserted) {
    if (!insertedRunIds.includes(row.id)) insertedRunIds.push(row.id);
  }

  assert.equal(
    newlyInserted.length,
    1,
    `tick must append exactly one row when enabled=true and due, got ${newlyInserted.length}`,
  );
  const row = newlyInserted[0];
  assert.equal(row.trigger, "scheduled",
    "the appended row's trigger must be 'scheduled' (auto-fire path)");
});
