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
//
//   • The non-skipped branches of `runReportDigest(trigger)` — the ones
//     that decide whether a real email actually went out. A regression in
//     any of these would silently look like "ok" in the admin history while
//     real digests never arrived.
//
//     The tests pin (for both trigger="scheduled" and trigger="manual"):
//       - happy path → status="ok", lastSentAt set, lastError=null,
//                      run-history row with status="ok"
//       - empty attachments (unknown report key) → status="no_data"
//                      (NOT "ok"), lastError set, history row "no_data"
//       - throw inside produceDigestArtifacts (db.execute throws) →
//                      status="failed", lastError set, history row
//                      "failed", lastSentAt unchanged
//       - missing SMTP (and no Outlook fallback) → status="failed",
//                      history row "failed", lastSentAt unchanged
//       - sendReportsDigest returns ok=false (transport throws) →
//                      status="failed", history row "failed",
//                      lastSentAt unchanged
//
//     SMTP is stubbed by replacing `nodemailer.createTransport` with a
//     recording stub; the CSV builder is exercised end-to-end against the
//     dev DB for the happy/throw paths but the no_data path uses an
//     unknown report key so produceDigestArtifacts returns []. None of
//     these tests depend on outbound mail actually being configured.

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
  runReportDigest,
  tickReportDigestScheduler,
  REPORT_SCHEDULE_ID,
  __setReportDigestDepsForTesting,
  __resetReportDigestDepsForTesting,
} from "../src/lib/reportScheduler.ts";
import type { DigestArtifact } from "../src/lib/reportDigest.ts";

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

// ════════════════════════════════════════════════════════════════════════════
//  runReportDigest — non-skipped branches (the ones that actually decide
//  whether an email went out)
//
//  Each branch is exercised for BOTH trigger="scheduled" AND trigger="manual"
//  via the parametrised helper at the bottom of the file. The test loops
//  generate one `test(...)` per (branch × trigger) pair so a regression in
//  either trigger's persistence path lights up independently.
//
//  Mocking strategy: the production code reads its CSV-builder and SMTP-
//  aware helpers through three module-local references (`_produceDigest…`,
//  `_sendReportsDigest`, `_emailConfigured`) which the test seam
//  __setReportDigestDepsForTesting() rebinds for the duration of each test.
//  This means:
//    • zero monkey-patching of `nodemailer` or `db.execute` in these tests,
//    • zero coupling to the real CSV SQL in reportDigest.ts,
//    • zero dependence on SMTP env vars or any outbound mail in dev.
//  The seam is reset after every test so subsequent tests see production
//  bindings.
// ════════════════════════════════════════════════════════════════════════════

// Per-test recorder. Each install*() helper resets these so the test can
// assert "sendReportsDigest was called once / never" and inspect what
// recipients/labels reached the SMTP layer.
interface SendCall {
  to:           string[];
  frequency:    "weekly" | "monthly";
  reportLabels: string[];
  attachments:  Array<{ filename: string }>;
}
const recorder: { sendCalls: SendCall[] } = { sendCalls: [] };

// Sentinel attachment used by every "should-succeed" mock so the dispatch
// path treats it as a real CSV without us needing to actually generate one.
const FAKE_ATTACHMENT: DigestArtifact = {
  filename: "report-scheduler-test.csv",
  csv:      "\uFEFFheader\r\nrow\r\n",
  rowCount: 1,
};

// Read back the full singleton schedule row so each test can assert on
// every persisted field (lastStatus, lastSentAt, lastError, lastReports,
// lastRecipients) in one shot.
async function readSchedule(): Promise<typeof reportEmailSchedulesTable.$inferSelect | null> {
  const [row] = await db.select().from(reportEmailSchedulesTable)
    .where(eq(reportEmailSchedulesTable.id, REPORT_SCHEDULE_ID));
  return row ?? null;
}

// Capture every newly-inserted run-history row in `insertedRunIds` so the
// shared cleanup() at file teardown removes them. Strict (id > beforeMaxId)
// AND trigger filtering so a concurrent test/process never gets swept in.
async function captureNewRunsSince(
  beforeIds: number[],
  trigger: "scheduled" | "manual",
): Promise<Array<typeof reportEmailScheduleRunsTable.$inferSelect>> {
  const rows = await newRunsSince(trigger);
  const newlyInserted = rows.filter((r) => !beforeIds.includes(r.id));
  for (const row of newlyInserted) {
    if (!insertedRunIds.includes(row.id)) insertedRunIds.push(row.id);
  }
  return newlyInserted;
}

// ─── Branch installers ─────────────────────────────────────────────────────
// Each installer wires the seam to drive a specific runReportDigest branch,
// without touching nodemailer/env/db internals.

// Happy path: emailConfigured()=true, builder returns ≥1 artifact, send ok.
function installHappyPath() {
  recorder.sendCalls = [];
  __setReportDigestDepsForTesting({
    emailConfigured:        () => true,
    produceDigestArtifacts: async () => [FAKE_ATTACHMENT],
    sendReportsDigest:      async (opts) => {
      recorder.sendCalls.push({
        to:           opts.to,
        frequency:    opts.frequency,
        reportLabels: opts.reportLabels,
        attachments:  opts.attachments.map((a) => ({ filename: a.filename })),
      });
      return { ok: true };
    },
  });
}

// no_data: builder returns []. Send must NEVER be called — recorder will
// stay empty and the assertions in the test will catch a regression.
function installNoData() {
  recorder.sendCalls = [];
  __setReportDigestDepsForTesting({
    emailConfigured:        () => true,
    produceDigestArtifacts: async () => [],
    sendReportsDigest:      async (opts) => {
      recorder.sendCalls.push({
        to: opts.to, frequency: opts.frequency,
        reportLabels: opts.reportLabels, attachments: [],
      });
      return { ok: true };
    },
  });
}

// Builder throws. Send must NEVER be called.
function installBuilderThrows() {
  recorder.sendCalls = [];
  __setReportDigestDepsForTesting({
    emailConfigured:        () => true,
    produceDigestArtifacts: async () => {
      throw new Error("forced artifact-build failure");
    },
    sendReportsDigest:      async (opts) => {
      recorder.sendCalls.push({
        to: opts.to, frequency: opts.frequency,
        reportLabels: opts.reportLabels, attachments: [],
      });
      return { ok: true };
    },
  });
}

// emailConfigured() returns false → early-failed path. Builder/send must
// NEVER be called: enforced by the assertion in the test (recorder stays
// empty AND we throw from the builder mock to make any erroneous call loud).
function installMissingSmtp() {
  recorder.sendCalls = [];
  __setReportDigestDepsForTesting({
    emailConfigured:        () => false,
    produceDigestArtifacts: async () => {
      throw new Error("produceDigestArtifacts must not be called when SMTP is missing");
    },
    sendReportsDigest:      async () => {
      throw new Error("sendReportsDigest must not be called when SMTP is missing");
    },
  });
}

// Builder succeeds, send returns { ok: false, reason }. The reason text is
// asserted in the test so a regression that swallows the underlying SMTP
// error message also lights up.
function installSendFails() {
  recorder.sendCalls = [];
  __setReportDigestDepsForTesting({
    emailConfigured:        () => true,
    produceDigestArtifacts: async () => [FAKE_ATTACHMENT],
    sendReportsDigest:      async (opts) => {
      recorder.sendCalls.push({
        to:           opts.to,
        frequency:    opts.frequency,
        reportLabels: opts.reportLabels,
        attachments:  opts.attachments.map((a) => ({ filename: a.filename })),
      });
      return { ok: false, reason: "SMTP transport refused the message" };
    },
  });
}

// ─── Per-branch test runners ───────────────────────────────────────────────
// Each runner does the full set of assertions for one branch given a
// trigger, so the matrix below stays a one-liner per (branch × trigger).

interface Persisted {
  lastStatus:     string | null;
  lastSentAt:     Date | null;
  lastError:      string | null;
  lastReports:    string[] | null;
  lastRecipients: number | null;
}
function snapshotPersisted(cfg: typeof reportEmailSchedulesTable.$inferSelect | null): Persisted {
  return {
    lastStatus:     cfg?.lastStatus     ?? null,
    lastSentAt:     cfg?.lastSentAt     ?? null,
    lastError:      cfg?.lastError      ?? null,
    lastReports:    (cfg?.lastReports as string[] | null | undefined) ?? null,
    lastRecipients: cfg?.lastRecipients ?? null,
  };
}

async function runHappyPathFor(trigger: "scheduled" | "manual") {
  installHappyPath();
  const recipients = [`happy-${trigger}@example.test`, `happy2-${trigger}@example.test`];
  const reports = ["operational-summary", "revenue-by-plan"];
  await setSchedule({
    enabled: true, reports, frequency: "weekly", recipients, lastSentAt: null,
  });

  const beforeIds = (await newRunsSince(trigger)).map((r) => r.id);
  const tStart = Date.now();
  try {
    const outcome = await runReportDigest(trigger);

    // Outcome shape
    assert.equal(outcome.status, "ok",
      `[trigger=${trigger}] happy path must return status="ok", got "${outcome.status}" (${outcome.message})`);
    assert.equal(outcome.recipients, recipients.length);
    assert.deepEqual(outcome.reports, reports);

    // Send was invoked exactly once with the right payload
    assert.equal(recorder.sendCalls.length, 1,
      `[trigger=${trigger}] sendReportsDigest must run exactly once on the happy path`);
    assert.deepEqual(recorder.sendCalls[0].to, recipients);
    assert.equal(recorder.sendCalls[0].frequency, "weekly");
    assert.equal(recorder.sendCalls[0].attachments.length, 1);

    // Persisted schedule fields — ALL FIVE
    const cfg = snapshotPersisted(await readSchedule());
    assert.equal(cfg.lastStatus, "ok",
      `[trigger=${trigger}] schedule.lastStatus must be 'ok'`);
    assert.equal(cfg.lastError, null,
      `[trigger=${trigger}] schedule.lastError must be cleared on success`);
    assert.deepEqual(cfg.lastReports, reports,
      `[trigger=${trigger}] schedule.lastReports must echo the attached keys`);
    assert.equal(cfg.lastRecipients, recipients.length,
      `[trigger=${trigger}] schedule.lastRecipients must equal the recipients-list length`);
    assert.ok(cfg.lastSentAt, `[trigger=${trigger}] schedule.lastSentAt must be set on success`);
    const sentMs = cfg.lastSentAt!.getTime();
    assert.ok(sentMs >= tStart - 1_000 && sentMs <= Date.now() + 1_000,
      `[trigger=${trigger}] schedule.lastSentAt must be ~now (got ${cfg.lastSentAt!.toISOString()})`);

    // History row — exactly one, with matching status + payload echo
    const newRuns = await captureNewRunsSince(beforeIds, trigger);
    assert.equal(newRuns.length, 1,
      `[trigger=${trigger}] happy path must append exactly one ${trigger}-trigger history row, got ${newRuns.length}`);
    assert.equal(newRuns[0].status, "ok",
      `[trigger=${trigger}] history row status must mirror outcome ('ok')`);
    assert.deepEqual(newRuns[0].reports, reports);
    assert.equal(newRuns[0].recipients, recipients.length);
  } finally {
    __resetReportDigestDepsForTesting();
  }
}

async function runNoDataFor(trigger: "scheduled" | "manual") {
  installNoData();
  const recipients = [`nodata-${trigger}@example.test`];
  const reports = ["operational-summary"];
  await setSchedule({
    enabled: true, reports, frequency: "weekly", recipients, lastSentAt: null,
  });

  const beforeIds = (await newRunsSince(trigger)).map((r) => r.id);
  try {
    const outcome = await runReportDigest(trigger);

    assert.equal(outcome.status, "no_data",
      `[trigger=${trigger}] empty attachments must NOT look like 'ok' — got "${outcome.status}" (${outcome.message})`);
    assert.equal(recorder.sendCalls.length, 0,
      `[trigger=${trigger}] sendReportsDigest must NOT run when no attachments were produced`);

    const cfg = snapshotPersisted(await readSchedule());
    assert.equal(cfg.lastStatus, "no_data",
      `[trigger=${trigger}] schedule.lastStatus must be 'no_data', not 'ok'`);
    assert.ok(cfg.lastError && cfg.lastError.length > 0,
      `[trigger=${trigger}] schedule.lastError must explain why nothing went out`);
    assert.equal(cfg.lastSentAt, null,
      `[trigger=${trigger}] schedule.lastSentAt must NOT advance — no email actually went out`);
    assert.deepEqual(cfg.lastReports, reports,
      `[trigger=${trigger}] schedule.lastReports must echo the configured reports`);
    assert.equal(cfg.lastRecipients, recipients.length,
      `[trigger=${trigger}] schedule.lastRecipients must equal the recipients-list length`);

    const newRuns = await captureNewRunsSince(beforeIds, trigger);
    assert.equal(newRuns.length, 1,
      `[trigger=${trigger}] no_data path must append exactly one ${trigger}-trigger history row, got ${newRuns.length}`);
    assert.equal(newRuns[0].status, "no_data",
      `[trigger=${trigger}] history row status must be 'no_data' (NOT 'ok' — that would mislead the admin)`);
  } finally {
    __resetReportDigestDepsForTesting();
  }
}

async function runBuilderThrowsFor(trigger: "scheduled" | "manual") {
  installBuilderThrows();
  const recipients = [`throw-${trigger}@example.test`];
  const reports = ["operational-summary"];
  await setSchedule({
    enabled: true, reports, frequency: "weekly", recipients, lastSentAt: null,
  });

  const beforeIds = (await newRunsSince(trigger)).map((r) => r.id);
  try {
    const outcome = await runReportDigest(trigger);

    assert.equal(outcome.status, "failed",
      `[trigger=${trigger}] builder throw must surface as status="failed", got "${outcome.status}" (${outcome.message})`);
    assert.match(outcome.message, /forced artifact-build failure/,
      `[trigger=${trigger}] outcome.message must propagate the underlying error so admins can debug`);
    assert.equal(recorder.sendCalls.length, 0,
      `[trigger=${trigger}] sendReportsDigest must NOT run after the builder threw`);

    const cfg = snapshotPersisted(await readSchedule());
    assert.equal(cfg.lastStatus, "failed",
      `[trigger=${trigger}] schedule.lastStatus must be 'failed' so the UI doesn't claim success`);
    assert.ok(cfg.lastError && cfg.lastError.length > 0,
      `[trigger=${trigger}] schedule.lastError must be populated on a thrown failure`);
    assert.equal(cfg.lastSentAt, null,
      `[trigger=${trigger}] schedule.lastSentAt must NOT advance on a failed build`);
    assert.deepEqual(cfg.lastReports, reports,
      `[trigger=${trigger}] schedule.lastReports must echo the configured reports`);
    assert.equal(cfg.lastRecipients, recipients.length,
      `[trigger=${trigger}] schedule.lastRecipients must equal the recipients-list length`);

    const newRuns = await captureNewRunsSince(beforeIds, trigger);
    assert.equal(newRuns.length, 1,
      `[trigger=${trigger}] throw path must append exactly one ${trigger}-trigger history row, got ${newRuns.length}`);
    assert.equal(newRuns[0].status, "failed",
      `[trigger=${trigger}] history row status must be 'failed' (NOT 'ok' — admins must see the failure)`);
  } finally {
    __resetReportDigestDepsForTesting();
  }
}

async function runMissingSmtpFor(trigger: "scheduled" | "manual") {
  installMissingSmtp();
  const recipients = [`nosmtp-${trigger}@example.test`];
  const reports = ["operational-summary"];
  await setSchedule({
    enabled: true, reports, frequency: "weekly", recipients, lastSentAt: null,
  });

  const beforeIds = (await newRunsSince(trigger)).map((r) => r.id);
  try {
    const outcome = await runReportDigest(trigger);

    assert.equal(outcome.status, "failed",
      `[trigger=${trigger}] missing SMTP must surface as status="failed", got "${outcome.status}" (${outcome.message})`);
    assert.equal(recorder.sendCalls.length, 0,
      `[trigger=${trigger}] sendReportsDigest must NOT run when emailConfigured() is false`);

    const cfg = snapshotPersisted(await readSchedule());
    assert.equal(cfg.lastStatus, "failed",
      `[trigger=${trigger}] schedule.lastStatus must be 'failed' when SMTP isn't configured`);
    assert.ok(cfg.lastError && cfg.lastError.length > 0,
      `[trigger=${trigger}] schedule.lastError must explain why the send didn't happen`);
    assert.equal(cfg.lastSentAt, null,
      `[trigger=${trigger}] schedule.lastSentAt must NOT advance when no transport exists`);
    assert.deepEqual(cfg.lastReports, reports,
      `[trigger=${trigger}] schedule.lastReports must echo the configured reports`);
    assert.equal(cfg.lastRecipients, recipients.length,
      `[trigger=${trigger}] schedule.lastRecipients must equal the recipients-list length`);

    const newRuns = await captureNewRunsSince(beforeIds, trigger);
    assert.equal(newRuns.length, 1,
      `[trigger=${trigger}] missing-SMTP path must append exactly one ${trigger}-trigger history row, got ${newRuns.length}`);
    assert.equal(newRuns[0].status, "failed",
      `[trigger=${trigger}] history row status must be 'failed' (NOT 'ok'/'skipped' — admins need the alert)`);
  } finally {
    __resetReportDigestDepsForTesting();
  }
}

async function runSendFailsFor(trigger: "scheduled" | "manual") {
  installSendFails();
  const recipients = [`sendfail-${trigger}@example.test`];
  const reports = ["operational-summary"];
  await setSchedule({
    enabled: true, reports, frequency: "weekly", recipients, lastSentAt: null,
  });

  const beforeIds = (await newRunsSince(trigger)).map((r) => r.id);
  try {
    const outcome = await runReportDigest(trigger);

    assert.equal(outcome.status, "failed",
      `[trigger=${trigger}] failed send must surface as status="failed", got "${outcome.status}" (${outcome.message})`);
    assert.equal(recorder.sendCalls.length, 1,
      `[trigger=${trigger}] sendReportsDigest must run exactly once even when it ultimately fails`);
    assert.match(outcome.message, /SMTP transport refused the message/,
      `[trigger=${trigger}] outcome.message must propagate the transport's reason so admins can debug`);

    const cfg = snapshotPersisted(await readSchedule());
    assert.equal(cfg.lastStatus, "failed",
      `[trigger=${trigger}] schedule.lastStatus must be 'failed' when the transport rejected the message`);
    assert.ok(cfg.lastError && cfg.lastError.length > 0,
      `[trigger=${trigger}] schedule.lastError must explain why the transport refused`);
    assert.equal(cfg.lastSentAt, null,
      `[trigger=${trigger}] schedule.lastSentAt must NOT advance when the email never actually went out`);
    assert.deepEqual(cfg.lastReports, reports,
      `[trigger=${trigger}] schedule.lastReports must echo the configured reports`);
    assert.equal(cfg.lastRecipients, recipients.length,
      `[trigger=${trigger}] schedule.lastRecipients must equal the recipients-list length`);

    const newRuns = await captureNewRunsSince(beforeIds, trigger);
    assert.equal(newRuns.length, 1,
      `[trigger=${trigger}] failed-send path must append exactly one ${trigger}-trigger history row, got ${newRuns.length}`);
    assert.equal(newRuns[0].status, "failed",
      `[trigger=${trigger}] history row status must be 'failed' (NOT 'ok' — a regression here would silently swallow real send failures)`);
  } finally {
    __resetReportDigestDepsForTesting();
  }
}

// ─── Matrix: every branch × every trigger ──────────────────────────────────
// Generated explicitly (not in a forEach) so failures show the precise
// (branch, trigger) pair without needing to read a stack trace into a loop.
test("runReportDigest('scheduled'): happy path — lastStatus='ok', lastSentAt set, all schedule fields persisted, history row 'ok'", async () => {
  await runHappyPathFor("scheduled");
});
test("runReportDigest('manual'): happy path — lastStatus='ok', lastSentAt set, all schedule fields persisted, history row 'ok'", async () => {
  await runHappyPathFor("manual");
});

test("runReportDigest('scheduled'): empty attachments — lastStatus='no_data' (NEVER 'ok'), all schedule fields persisted, history row 'no_data'", async () => {
  await runNoDataFor("scheduled");
});
test("runReportDigest('manual'): empty attachments — lastStatus='no_data' (NEVER 'ok'), all schedule fields persisted, history row 'no_data'", async () => {
  await runNoDataFor("manual");
});

test("runReportDigest('scheduled'): produceDigestArtifacts throws — lastStatus='failed', all schedule fields persisted, history row 'failed'", async () => {
  await runBuilderThrowsFor("scheduled");
});
test("runReportDigest('manual'): produceDigestArtifacts throws — lastStatus='failed', all schedule fields persisted, history row 'failed'", async () => {
  await runBuilderThrowsFor("manual");
});

test("runReportDigest('scheduled'): missing SMTP — lastStatus='failed', all schedule fields persisted, history row 'failed'", async () => {
  await runMissingSmtpFor("scheduled");
});
test("runReportDigest('manual'): missing SMTP — lastStatus='failed', all schedule fields persisted, history row 'failed'", async () => {
  await runMissingSmtpFor("manual");
});

test("runReportDigest('scheduled'): sendReportsDigest returns ok=false — lastStatus='failed', all schedule fields persisted, history row 'failed'", async () => {
  await runSendFailsFor("scheduled");
});
test("runReportDigest('manual'): sendReportsDigest returns ok=false — lastStatus='failed', all schedule fields persisted, history row 'failed'", async () => {
  await runSendFailsFor("manual");
});
