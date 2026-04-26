// Integration tests for the SuperAdmin "Reports Hub email schedule" endpoints
// (artifacts/api-server/src/routes/admin.ts):
//
//   GET  /api/admin/reports/email-schedule         (config + recent history)
//   PUT  /api/admin/reports/email-schedule         (update enabled/reports/
//                                                    frequency/recipients)
//   POST /api/admin/reports/email-schedule/run-now (manual trigger)
//
// What this protects:
//   • These three routes own the same `report_email_schedule_runs` table that
//     the maintenance "old-report-email-runs" prune card consumes. A
//     regression here (missed validation, schedule not persisted, run-now
//     failing to append a history row, missing audit-log entry) would only be
//     caught by manual QA today — the prune-card tests don't exercise the
//     write path.
//
//     The tests pin the contract:
//       - GET returns the persisted singleton config + recent history with
//         the documented response shape (schedule, availableReports,
//         smtpConfigured, history).
//       - PUT validates required fields (enabled flag, recognised report
//         keys, frequency in {weekly,monthly}, well-formed recipient
//         emails, "enabled requires ≥1 report and ≥1 recipient"), persists
//         changes back to `report_email_schedules`, AND writes an
//         `entity_type=report_email_schedule action=edit` audit row tagged
//         to the calling SuperAdmin so the change-of-record is preserved.
//       - POST /run-now appends a row to `report_email_schedule_runs` with
//         trigger="manual" and a known status, AND writes an
//         `entity_type=report_email_schedule action=export` audit row
//         carrying the outcome metadata.
//       - Auth gates: 401 without a bearer token, 403 for any non-superadmin.
//
// How to run:
//   pnpm --filter @workspace/api-server test
//
// Notes:
//   - Boots the Express app in-process on a random port (no external server
//     required). Uses the real DB (DATABASE_URL).
//   - `report_email_schedules` is a global singleton (id=1). The setup
//     snapshots whatever row exists today, the tests freely mutate id=1,
//     and teardown restores the original row exactly. If no row exists at
//     setup time we delete id=1 in teardown so a fresh DB stays fresh.
//   - History rows + audit rows are tracked by primary key and cleaned up
//     strictly via inArray — never via tag/like — so a crashed run can
//     never touch another tenant's data.
//   - Run-now is exercised in the "no recipients" branch (status="skipped")
//     so the test never depends on SMTP being configured in the dev env.
//     Skipped is still recorded in `report_email_schedule_runs`, which is
//     exactly the row-shape we want to lock in.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";

import bcrypt from "bcryptjs";
import { eq, inArray, and, sql } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  companiesTable,
  auditLogTable,
  reportEmailSchedulesTable,
  reportEmailScheduleRunsTable,
} from "@workspace/db";

import app from "../src/app.ts";

// ─── Test scoping ───────────────────────────────────────────────────────────
const TEST_TAG = `tt_email_sched_${randomBytes(4).toString("hex")}`;

// Singleton id used by the production code (REPORT_SCHEDULE_ID in
// reportScheduler.ts). Hardcoded here on purpose so a future code change
// that silently switches to a different id surfaces as a failing test.
const REPORT_SCHEDULE_ID = 1;

let server: http.Server;
let baseUrl: string;

let saUserId: number;
let saToken: string;

let regularUserId: number;
let regularToken: string;

let testCompanyId: number;

// Snapshot of the `report_email_schedules` id=1 row taken at test start so
// teardown can put the dev DB back exactly as it found it. `null` means the
// row didn't exist when we began (fresh DB) and teardown should delete it.
let scheduleSnapshot: typeof reportEmailSchedulesTable.$inferSelect | null = null;

// PK lists used by cleanup() — strict-by-PK, never wildcards.
const insertedCompanyIds:   number[] = [];
const insertedUserIds:      number[] = [];
const insertedAuditLogIds:  number[] = [];
const insertedRunIds:       number[] = [];

// ─── Fetch helper ───────────────────────────────────────────────────────────
interface FetchOpts {
  token?: string;
  body?: unknown;
}
interface ApiResponse<T = unknown> {
  status:  number;
  body:    T;
  headers: Headers;
  text:    string;
}

async function api<T = unknown>(
  path: string,
  method: "GET" | "PUT" | "POST",
  opts: FetchOpts = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: res.status, body: body as T, headers: res.headers, text };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────
before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server did not bind");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // Snapshot the singleton schedule row (or capture "doesn't exist") so
  // teardown can put the DB back exactly as we found it.
  const [existing] = await db.select().from(reportEmailSchedulesTable)
    .where(eq(reportEmailSchedulesTable.id, REPORT_SCHEDULE_ID));
  scheduleSnapshot = existing ?? null;

  // SuperAdmin caller — uses sessionToken bearer (matches the existing
  // sibling test suite admin-email-runs-retention.test.ts).
  saToken = "tt_sa_" + randomBytes(16).toString("hex");
  const saHash = await bcrypt.hash("ignored-test-pw", 4);
  const [sa] = await db.insert(usersTable).values({
    username:     `${TEST_TAG}_sa`,
    email:        null,
    passwordHash: saHash,
    role:         "superadmin",
    isActive:     true,
    sessionToken: saToken,
    sessionId:    "test",
    companyId:    null,
  }).returning({ id: usersTable.id });
  saUserId = sa.id;
  insertedUserIds.push(saUserId);

  // Tenant + non-superadmin user for the 403 cases. These endpoints don't
  // take a companyId (they're singleton/global) but a valid FK target keeps
  // the user insert clean.
  const companyValues: typeof companiesTable.$inferInsert = {
    nameAr:         `${TEST_TAG} شركة`,
    nameEn:         `${TEST_TAG} Co`,
    vatNumber:      "300000000000003",
    crNumber:       `CR_${TEST_TAG}`,
    city:           "Riyadh",
    street:         "Test St",
    buildingNumber: "1",
    postalCode:     "12345",
    country:        "SA",
    invoiceType:    "both",
    status:         "active",
  };
  const [co] = await db.insert(companiesTable).values(companyValues).returning({ id: companiesTable.id });
  testCompanyId = co.id;
  insertedCompanyIds.push(testCompanyId);

  regularToken = "tt_user_" + randomBytes(16).toString("hex");
  const userHash = await bcrypt.hash("ignored-test-pw", 4);
  const [u] = await db.insert(usersTable).values({
    username:     `${TEST_TAG}_user`,
    email:        null,
    passwordHash: userHash,
    role:         "admin",
    isActive:     true,
    sessionToken: regularToken,
    sessionId:    "test",
    companyId:    testCompanyId,
  }).returning({ id: usersTable.id });
  regularUserId = u.id;
  insertedUserIds.push(regularUserId);
});

after(async () => {
  try { await cleanup(); } finally {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    try { await pool.end(); } catch { /* already ended is fine */ }
  }
});

async function cleanup(): Promise<void> {
  if (insertedAuditLogIds.length) {
    await db.delete(auditLogTable).where(inArray(auditLogTable.id, insertedAuditLogIds));
  }
  if (insertedRunIds.length) {
    await db.delete(reportEmailScheduleRunsTable)
      .where(inArray(reportEmailScheduleRunsTable.id, insertedRunIds));
  }
  if (insertedUserIds.length) {
    await db.delete(usersTable).where(inArray(usersTable.id, insertedUserIds));
  }
  if (insertedCompanyIds.length) {
    await db.delete(companiesTable).where(inArray(companiesTable.id, insertedCompanyIds));
  }

  // Restore the singleton schedule row exactly as we found it.
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
    // Row didn't exist before our run — get rid of the one our tests created.
    await db.delete(reportEmailSchedulesTable)
      .where(eq(reportEmailSchedulesTable.id, REPORT_SCHEDULE_ID));
  }
}

// Capture the current MAX(audit_log.id) so audit-log assertions can scope
// to "rows added after this call" without depending on a TEST_TAG match.
async function maxAuditId(): Promise<number> {
  const r = await db.execute<{ max_id: number | null }>(sql`
    SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM audit_log
  `);
  const rows = (r as { rows?: Array<{ max_id: number | null }> }).rows ?? [{ max_id: 0 }];
  return Number(rows[0]?.max_id ?? 0);
}

// Shared response shapes — typed so a column drift surfaces at compile.
interface ScheduleBlock {
  enabled:        boolean;
  reports:        string[];
  frequency:      string;
  recipients:     string[];
  lastSentAt:     string | null;
  lastStatus:     string | null;
  lastError:      string | null;
  lastReports:    string[];
  lastRecipients: number | null;
}
interface AvailableReport { key: string; label: string }
interface HistoryItem {
  id:         number;
  ranAt:      string;
  trigger:    string;
  status:     string;
  reports:    string[];
  recipients: number;
  message:    string | null;
}
interface GetResponse {
  schedule:         ScheduleBlock;
  availableReports: AvailableReport[];
  smtpConfigured:   boolean;
  history:          HistoryItem[];
}
interface PutResponse {
  schedule: ScheduleBlock;
}
interface RunNowResponse {
  ok:      boolean;
  outcome: {
    status:     "ok" | "failed" | "no_data" | "skipped";
    message:    string;
    reports:    string[];
    recipients: number;
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  Auth gates — applied to all three endpoints
// ════════════════════════════════════════════════════════════════════════════
test("GET /api/admin/reports/email-schedule: 401 without bearer token", async () => {
  const r = await api("/api/admin/reports/email-schedule", "GET");
  assert.equal(r.status, 401);
});

test("GET /api/admin/reports/email-schedule: 403 for non-superadmin", async () => {
  const r = await api("/api/admin/reports/email-schedule", "GET", { token: regularToken });
  assert.equal(r.status, 403);
});

test("PUT /api/admin/reports/email-schedule: 401 without bearer token", async () => {
  const r = await api("/api/admin/reports/email-schedule", "PUT",
    { body: { enabled: false, reports: [], frequency: "weekly", recipients: [] } });
  assert.equal(r.status, 401);
});

test("PUT /api/admin/reports/email-schedule: 403 for non-superadmin", async () => {
  const r = await api("/api/admin/reports/email-schedule", "PUT",
    { token: regularToken, body: { enabled: false, reports: [], frequency: "weekly", recipients: [] } });
  assert.equal(r.status, 403);
});

test("POST /api/admin/reports/email-schedule/run-now: 401 without bearer token", async () => {
  const r = await api("/api/admin/reports/email-schedule/run-now", "POST", { body: {} });
  assert.equal(r.status, 401);
});

test("POST /api/admin/reports/email-schedule/run-now: 403 for non-superadmin", async () => {
  const r = await api("/api/admin/reports/email-schedule/run-now", "POST",
    { token: regularToken, body: {} });
  assert.equal(r.status, 403);
});

// ════════════════════════════════════════════════════════════════════════════
//  GET — returns persisted config + recent history with the documented shape
// ════════════════════════════════════════════════════════════════════════════
test("GET /api/admin/reports/email-schedule: returns persisted config + recent history with documented shape", async () => {
  // Seed the singleton with a known config so the assertions read off real
  // values rather than whatever was in the DB before this test ran.
  await db.insert(reportEmailSchedulesTable).values({
    id:         REPORT_SCHEDULE_ID,
    enabled:    true,
    reports:    ["operational-summary"],
    frequency:  "monthly",
    recipients: [`${TEST_TAG}+1@example.com`, `${TEST_TAG}+2@example.com`],
  }).onConflictDoUpdate({
    target: reportEmailSchedulesTable.id,
    set: {
      enabled:    true,
      reports:    ["operational-summary"],
      frequency:  "monthly",
      recipients: [`${TEST_TAG}+1@example.com`, `${TEST_TAG}+2@example.com`],
      updatedAt:  new Date(),
    },
  });

  // Seed a history row so the `history` array is provably populated by us.
  const [run] = await db.insert(reportEmailScheduleRunsTable).values({
    ranAt:      new Date(),
    trigger:    "manual",
    status:     "ok",
    reports:    ["operational-summary"],
    recipients: 2,
    message:    `${TEST_TAG} get-history-seed`,
  }).returning({ id: reportEmailScheduleRunsTable.id });
  insertedRunIds.push(run.id);

  const r = await api<GetResponse>("/api/admin/reports/email-schedule", "GET",
    { token: saToken });
  assert.equal(r.status, 200);
  assert.ok(isObject(r.body), "response must be a JSON object");

  // ── schedule block: documented shape + the values we just persisted ──────
  const sch = r.body.schedule;
  assert.ok(isObject(sch), "response.schedule must be an object");
  assert.equal(sch.enabled,   true);
  assert.equal(sch.frequency, "monthly");
  assert.deepEqual(sch.reports,    ["operational-summary"]);
  assert.deepEqual(sch.recipients, [`${TEST_TAG}+1@example.com`, `${TEST_TAG}+2@example.com`]);
  // The last* fields exist in the response even when no run has updated
  // them — a regression that drops them would break the UI.
  assert.ok("lastSentAt"     in sch, "schedule.lastSentAt must always be present");
  assert.ok("lastStatus"     in sch, "schedule.lastStatus must always be present");
  assert.ok("lastError"      in sch, "schedule.lastError must always be present");
  assert.ok(Array.isArray(sch.lastReports),
    "schedule.lastReports must always be an array (even if empty)");
  assert.ok("lastRecipients" in sch, "schedule.lastRecipients must always be present");

  // ── availableReports: must include every key the validator accepts ──────
  // We assert presence of the two known keys rather than exact length so the
  // test stays passing if a future release adds a third. A regression that
  // drops one of these would still fail.
  assert.ok(Array.isArray(r.body.availableReports));
  const keys = r.body.availableReports.map((it) => it.key);
  assert.ok(keys.includes("operational-summary"),
    "availableReports must expose 'operational-summary'");
  assert.ok(keys.includes("revenue-by-plan"),
    "availableReports must expose 'revenue-by-plan'");
  for (const ar of r.body.availableReports) {
    assert.equal(typeof ar.key,   "string");
    assert.equal(typeof ar.label, "string", "label must be the Arabic display string");
    assert.ok(ar.label.length > 0, "label must not be empty");
  }

  // ── smtpConfigured: a documented boolean (env-dependent value) ──────────
  assert.equal(typeof r.body.smtpConfigured, "boolean",
    "smtpConfigured must always be a boolean (true|false depends on env)");

  // ── history: capped at 20, ordered desc by ranAt, includes our seed ─────
  assert.ok(Array.isArray(r.body.history));
  assert.ok(r.body.history.length <= 20,
    `history must be capped at 20, got ${r.body.history.length}`);
  const seeded = r.body.history.find((h) => h.id === run.id);
  assert.ok(seeded, "history must include the run we just inserted");
  assert.equal(seeded!.trigger, "manual");
  assert.equal(seeded!.status,  "ok");
  assert.equal(seeded!.recipients, 2);
  assert.deepEqual(seeded!.reports, ["operational-summary"]);
  assert.equal(seeded!.message, `${TEST_TAG} get-history-seed`);
  assert.equal(typeof seeded!.ranAt, "string");
  assert.ok(!Number.isNaN(new Date(seeded!.ranAt).getTime()),
    "history.ranAt must be an ISO-parseable string");
});

// ════════════════════════════════════════════════════════════════════════════
//  PUT — validation
// ════════════════════════════════════════════════════════════════════════════
test("PUT /api/admin/reports/email-schedule: rejects unknown report keys", async () => {
  const r = await api("/api/admin/reports/email-schedule", "PUT", {
    token: saToken,
    body:  { enabled: false, reports: ["not-a-real-report"], frequency: "weekly", recipients: [] },
  });
  assert.equal(r.status, 400);
});

test("PUT /api/admin/reports/email-schedule: rejects non-string entries in reports[]", async () => {
  const r = await api("/api/admin/reports/email-schedule", "PUT", {
    token: saToken,
    body:  { enabled: false, reports: [42], frequency: "weekly", recipients: [] },
  });
  assert.equal(r.status, 400);
});

test("PUT /api/admin/reports/email-schedule: rejects bad frequency", async () => {
  const r = await api("/api/admin/reports/email-schedule", "PUT", {
    token: saToken,
    body:  { enabled: false, reports: [], frequency: "daily", recipients: [] },
  });
  assert.equal(r.status, 400);
});

test("PUT /api/admin/reports/email-schedule: rejects malformed recipient email", async () => {
  const r = await api("/api/admin/reports/email-schedule", "PUT", {
    token: saToken,
    body:  { enabled: false, reports: [], frequency: "weekly", recipients: ["not-an-email"] },
  });
  assert.equal(r.status, 400);
});

test("PUT /api/admin/reports/email-schedule: when enabled, requires ≥1 report", async () => {
  const r = await api("/api/admin/reports/email-schedule", "PUT", {
    token: saToken,
    body:  { enabled: true, reports: [], frequency: "weekly", recipients: [`${TEST_TAG}@example.com`] },
  });
  assert.equal(r.status, 400);
});

test("PUT /api/admin/reports/email-schedule: when enabled, requires ≥1 recipient", async () => {
  const r = await api("/api/admin/reports/email-schedule", "PUT", {
    token: saToken,
    body:  { enabled: true, reports: ["operational-summary"], frequency: "weekly", recipients: [] },
  });
  assert.equal(r.status, 400);
});

test("PUT /api/admin/reports/email-schedule: enabled flag uses strict-true contract (truthy non-bools are coerced to false)", async () => {
  // The route reads `body.enabled === true`. That means anything other than
  // a literal boolean `true` — including the strings "true"/"false", `1`, or
  // a missing field — is persisted as `enabled=false`. Pinning this guards
  // against a future refactor to `Boolean(body.enabled)` which would silently
  // start treating string "false" as enabled.
  const r = await api<PutResponse>("/api/admin/reports/email-schedule", "PUT", {
    token: saToken,
    body:  { enabled: "true", reports: [], frequency: "weekly", recipients: [] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.schedule.enabled, false,
    "non-boolean 'enabled' must be coerced to false (strict-true contract)");
});

// ════════════════════════════════════════════════════════════════════════════
//  PUT — persists changes + writes a SuperAdmin audit row
// ════════════════════════════════════════════════════════════════════════════
test("PUT /api/admin/reports/email-schedule: persists changes, normalises recipients, writes a SuperAdmin audit row", async () => {
  const beforeMax = await maxAuditId();

  // Note: the route lower-cases + de-dupes recipients. We send the same
  // address twice in different cases so the dedupe + lowercase contract is
  // pinned by the persistence assertion below.
  const recipientsRaw = [
    `${TEST_TAG}+Persist@Example.com`,
    `${TEST_TAG}+persist@example.com`, // duplicate after normalisation
    `   ${TEST_TAG}+second@example.com   `, // gets trimmed
  ];
  const expectedRecipients = [
    `${TEST_TAG}+persist@example.com`,
    `${TEST_TAG}+second@example.com`,
  ];

  const r = await api<PutResponse>("/api/admin/reports/email-schedule", "PUT", {
    token: saToken,
    body:  {
      enabled:    true,
      // Send the same key twice — the route also de-dupes report keys.
      reports:    ["operational-summary", "revenue-by-plan", "operational-summary"],
      frequency:  "monthly",
      recipients: recipientsRaw,
    },
  });
  assert.equal(r.status, 200);
  assert.ok(isObject(r.body) && isObject(r.body.schedule),
    "PUT response must echo the new schedule");
  assert.equal(r.body.schedule.enabled,   true);
  assert.equal(r.body.schedule.frequency, "monthly");
  assert.deepEqual(r.body.schedule.reports,    ["operational-summary", "revenue-by-plan"],
    "report keys must be de-duplicated in insert order");
  assert.deepEqual(r.body.schedule.recipients, expectedRecipients,
    "recipients must be lower-cased, trimmed, and de-duplicated");

  // ── persistence: read back from the DB and assert the same values ──────
  const [persisted] = await db.select().from(reportEmailSchedulesTable)
    .where(eq(reportEmailSchedulesTable.id, REPORT_SCHEDULE_ID));
  assert.ok(persisted, "schedule row must exist after PUT");
  assert.equal(persisted.enabled,   true);
  assert.equal(persisted.frequency, "monthly");
  assert.deepEqual(persisted.reports as unknown as string[],
    ["operational-summary", "revenue-by-plan"]);
  assert.deepEqual(persisted.recipients as unknown as string[], expectedRecipients);

  // ── audit row: exactly one new edit row scoped to this entity_type ─────
  const auditRows = await db.select({
    id:         auditLogTable.id,
    action:     auditLogTable.action,
    module:     auditLogTable.module,
    entityType: auditLogTable.entityType,
    entityId:   auditLogTable.entityId,
    userId:     auditLogTable.userId,
    role:       auditLogTable.role,
    metadata:   auditLogTable.metadata,
  })
    .from(auditLogTable)
    .where(and(
      sql`${auditLogTable.id} > ${beforeMax}`,
      eq(auditLogTable.module,     "reports"),
      eq(auditLogTable.action,     "edit"),
      eq(auditLogTable.entityType, "report_email_schedule"),
    ));
  assert.equal(auditRows.length, 1,
    `expected exactly one new edit audit row, got ${auditRows.length}`);
  const audit = auditRows[0];
  insertedAuditLogIds.push(audit.id);
  assert.equal(audit.userId,   saUserId,   "audit row must be attributed to the calling SuperAdmin");
  assert.equal(audit.role,     "superadmin");
  assert.equal(audit.entityId, String(REPORT_SCHEDULE_ID),
    "audit.entityId must point at the singleton schedule row");
  assert.ok(isObject(audit.metadata), "audit.metadata must be a JSON object");
  const meta = audit.metadata as Record<string, unknown>;
  assert.equal(meta.enabled,   true,      "metadata.enabled must echo the new value");
  assert.equal(meta.frequency, "monthly", "metadata.frequency must echo the new value");
  assert.deepEqual(meta.reports as unknown as string[],
    ["operational-summary", "revenue-by-plan"],
    "metadata.reports must echo the de-duplicated keys");
  assert.equal(meta.recipientsCount, expectedRecipients.length,
    "metadata.recipientsCount must reflect the persisted (normalised) list size");
});

// ════════════════════════════════════════════════════════════════════════════
//  POST /run-now — appends a row to report_email_schedule_runs + audit row
// ════════════════════════════════════════════════════════════════════════════
test("POST /api/admin/reports/email-schedule/run-now: appends a manual-trigger run to history and writes an export audit row", async () => {
  // Force a deterministic, SMTP-independent outcome: clear the schedule so
  // runReportDigest("manual") short-circuits to status="skipped" via the
  // "no reports selected" guard. That branch still:
  //   • inserts a row into report_email_schedule_runs (trigger="manual",
  //     status="skipped", recipients=0)
  //   • returns 200 with `outcome` populated
  //   • lets the route write an `action=export` audit row with metadata
  // Picking a guard branch (rather than a real send) means the test never
  // depends on outbound SMTP being configured in the dev environment.
  await db.insert(reportEmailSchedulesTable).values({
    id:         REPORT_SCHEDULE_ID,
    enabled:    false,
    reports:    [],
    frequency:  "weekly",
    recipients: [],
  }).onConflictDoUpdate({
    target: reportEmailSchedulesTable.id,
    set: {
      enabled:    false,
      reports:    [],
      frequency:  "weekly",
      recipients: [],
      updatedAt:  new Date(),
    },
  });

  const beforeMax = await maxAuditId();
  const beforeMaxRun = await db.execute<{ max_id: number | null }>(sql`
    SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM report_email_schedule_runs
  `);
  const beforeRunMax = Number(
    ((beforeMaxRun as { rows?: Array<{ max_id: number | null }> }).rows ?? [{ max_id: 0 }])[0]?.max_id ?? 0,
  );

  const r = await api<RunNowResponse>("/api/admin/reports/email-schedule/run-now", "POST",
    { token: saToken, body: {} });
  assert.equal(r.status, 200);
  assert.ok(isObject(r.body), "response must be a JSON object");
  assert.ok(isObject(r.body.outcome), "response.outcome must be an object");
  assert.equal(typeof r.body.ok, "boolean");
  // With no reports configured, the digest cannot succeed — `ok` must be
  // false and the status must reflect the early-return path.
  assert.equal(r.body.ok, false);
  assert.equal(r.body.outcome.status, "skipped",
    `expected status="skipped" from the empty-reports guard, got ${r.body.outcome.status}`);
  assert.equal(typeof r.body.outcome.message, "string");
  assert.ok(Array.isArray(r.body.outcome.reports));
  assert.equal(typeof r.body.outcome.recipients, "number");

  // ── new history row: trigger="manual", scoped to the route call ────────
  // Filter strictly on (id > beforeRunMax) AND trigger="manual" so a
  // concurrent test/process that happens to insert a "scheduled" row in the
  // same window doesn't get swept into our cleanup list. Only OUR run-now
  // call inserts a manual-trigger row in this test file's lifecycle, and
  // the route-level code path inserts exactly one row per call.
  const newRuns = await db.select({
    id:         reportEmailScheduleRunsTable.id,
    trigger:    reportEmailScheduleRunsTable.trigger,
    status:     reportEmailScheduleRunsTable.status,
    recipients: reportEmailScheduleRunsTable.recipients,
    reports:    reportEmailScheduleRunsTable.reports,
  })
    .from(reportEmailScheduleRunsTable)
    .where(and(
      sql`${reportEmailScheduleRunsTable.id} > ${beforeRunMax}`,
      eq(reportEmailScheduleRunsTable.trigger, "manual"),
    ));
  assert.equal(newRuns.length, 1,
    `run-now must append exactly one manual-trigger row to report_email_schedule_runs, got ${newRuns.length}`);
  const ourRun = newRuns[0];
  insertedRunIds.push(ourRun.id);
  assert.equal(ourRun.status,     r.body.outcome.status);
  assert.equal(ourRun.recipients, r.body.outcome.recipients);

  // ── audit row: exactly one new export row scoped to this entity_type ───
  const auditRows = await db.select({
    id:         auditLogTable.id,
    action:     auditLogTable.action,
    module:     auditLogTable.module,
    entityType: auditLogTable.entityType,
    entityId:   auditLogTable.entityId,
    userId:     auditLogTable.userId,
    role:       auditLogTable.role,
    metadata:   auditLogTable.metadata,
  })
    .from(auditLogTable)
    .where(and(
      sql`${auditLogTable.id} > ${beforeMax}`,
      eq(auditLogTable.module,     "reports"),
      eq(auditLogTable.action,     "export"),
      eq(auditLogTable.entityType, "report_email_schedule"),
    ));
  assert.equal(auditRows.length, 1,
    `expected exactly one new export audit row, got ${auditRows.length}`);
  const audit = auditRows[0];
  insertedAuditLogIds.push(audit.id);
  assert.equal(audit.userId,   saUserId);
  assert.equal(audit.role,     "superadmin");
  assert.equal(audit.entityId, String(REPORT_SCHEDULE_ID),
    "audit.entityId must point at the singleton schedule row");
  assert.ok(isObject(audit.metadata), "audit.metadata must be a JSON object");
  const meta = audit.metadata as Record<string, unknown>;
  assert.equal(meta.trigger, "manual",
    "metadata.trigger must be 'manual' for the run-now route");
  assert.equal(meta.status,  r.body.outcome.status,
    "metadata.status must match the outcome.status returned to the caller");
});
