// Integration test for the KSA-day bucketing in BOTH branches of
// GET /api/admin/maintenance/trend (artifacts/api-server/src/routes/admin.ts:
//   • per-company branch ~L4634 — `(run_at AT TIME ZONE 'Asia/Riyadh')::date`
//   • fleet branch       ~L4658 — same expression on the cross-tenant CTE).
//
// Why this exists:
//   The two existing trend tests (maintenance-per-company-trend.test.ts and
//   maintenance-fleet-trend.test.ts) deliberately anchor every seeded run at
//   KSA noon — far from any midnight boundary — so that the day-bucket the
//   SQL computes cannot drift between when we seed and when the route reads.
//   That keeps THOSE tests stable, but it means a regression that drops the
//   `AT TIME ZONE 'Asia/Riyadh'` clause (leaving the SQL bucketing by UTC
//   date instead) would NOT fail either of them: KSA-noon runs land on the
//   same calendar day under both bucketing strategies.
//
//   The real-world impact of such a regression is loud, though — every
//   per-tool sparkline and the cross-tenant leaderboard would silently
//   chart any 21:00–23:59 UTC run under "yesterday" instead of the KSA-day
//   it actually fired on. This file pins both branches against that
//   regression by deliberately seeding boundary-crossing instants.
//
// What this protects:
//   For each branch we seed maintenance_runs at carefully chosen UTC
//   instants so their UTC calendar date and KSA wall-clock date diverge:
//     • 10:00 UTC day X  →  13:00 KSA day X   (UTC date == KSA date)
//     • 22:30 UTC day X  →  01:30 KSA day X+1 (UTC date == X, KSA date == X+1)
//
//   Per-company branch:
//     One tool with both runs above. With KSA bucketing the response carries
//     TWO rows on TWO distinct KSA days. If the AT TIME ZONE clause is
//     dropped, both runs collapse into a single UTC-day bucket and DISTINCT
//     ON folds them to ONE row — the assertions fire loudly.
//
//   Fleet branch:
//     Many distinct tool keys, each with the same boundary pair (all
//     status=critical). The fleet projection groups by (company, tool,
//     day_str) and exposes the count as `criticalRuns`. With KSA bucketing
//     each tool yields 2 distinct buckets → criticalRuns == 2*N. Under a
//     UTC-bucketing regression each tool's pair collapses to 1 bucket →
//     criticalRuns == N. The integer assertion pinpoints the regression
//     even though the response never exposes `day_str` directly.
//
// How to run:
//   pnpm --filter @workspace/api-server test
//
// Notes:
//   - Boots the Express app in-process on a random port. Uses the real DB
//     (DATABASE_URL).
//   - Strict-by-PK cleanup mirrors the two existing trend tests; a crashed
//     run leaves orphan tagged rows that this run cannot match — they
//     remain inert and visible for human inspection.
//   - We seed `FLEET_TOOL_COUNT` distinct critical tools so our company's
//     KSA-correct criticalRuns total (200) sits well above the 80 max that
//     the sibling fleet test seeds, keeping us safely inside the LIMIT-5
//     leaderboard regardless of test interleaving.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";

import bcrypt from "bcryptjs";
import { inArray } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  companiesTable,
  maintenanceRunsTable,
} from "@workspace/db";

import app from "../src/app.ts";

// ─── Test scoping ───────────────────────────────────────────────────────────
const TEST_TAG = `tt_ksaday_${randomBytes(4).toString("hex")}`;

let server: http.Server;
let baseUrl: string;
let saToken: string;
let companyId: number;
let companyName: string;

const insertedCompanyIds:        number[] = [];
const insertedUserIds:           number[] = [];
const insertedMaintenanceRunIds: number[] = [];

// Per-company branch — one boundary tool keeps the assertion crystal clear.
const TOOL_PC = `${TEST_TAG}_pc_boundary`;

// Fleet branch — seed enough distinct critical tools to safely top the
// LIMIT-5 leaderboard regardless of what the other concurrent tests in this
// file glob have seeded. Each tool gets the same boundary pair, so under
// KSA-correct bucketing our company accumulates 2 * FLEET_TOOL_COUNT
// distinct critical buckets — comfortably above the 80 max profile in
// `maintenance-fleet-trend.test.ts`.
const FLEET_TOOL_COUNT = 100;
const fleetToolKey = (i: number): string => `${TEST_TAG}_fleet_tool_${i}`;

// ─── Time helpers ───────────────────────────────────────────────────────────
// Build a UTC `Date` at a given UTC hour/minute on the UTC calendar day that
// is `daysAgo` UTC days before today. Anchoring on the UTC calendar day (not
// the KSA-day) is the WHOLE POINT of this helper: we deliberately want the
// resulting instant's UTC date and KSA date to diverge for some choices of
// hour/minute (e.g. anything ≥ 21:00 UTC tips into the next KSA day).
function utcInstantDaysAgo(daysAgo: number, hour: number, minute = 0): Date {
  const now = new Date();
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - daysAgo,
    hour, minute, 0, 0,
  ));
}

// KSA wall-clock YYYY-MM-DD for a given UTC instant. Mirrors what the route
// emits via `to_char((run_at AT TIME ZONE 'Asia/Riyadh')::date, 'YYYY-MM-DD')`.
// KSA is UTC+3 with no DST, so the conversion is a flat 3-hour shift.
function ksaDayString(d: Date): string {
  const ksa = new Date(d.getTime() + 3 * 3600 * 1000);
  const y   = ksa.getUTCFullYear().toString().padStart(4, "0");
  const m   = (ksa.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = ksa.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// UTC wall-clock YYYY-MM-DD for a given UTC instant. Used purely as a
// regression hint in error messages — if the route ever buckets by UTC date
// instead of KSA date, this is the day-string the boundary-crossing rows
// would surface as.
function utcDayString(d: Date): string {
  const y   = d.getUTCFullYear().toString().padStart(4, "0");
  const m   = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ─── Boundary-crossing instants ─────────────────────────────────────────────
// Both seeded runs share the SAME UTC calendar day (3 UTC-days ago, well
// inside the route's default 14-day window) but live on DIFFERENT KSA days:
//   • 10:00 UTC day X  →  13:00 KSA day X   — UTC date == KSA date
//   • 22:30 UTC day X  →  01:30 KSA day X+1 — UTC date == X, KSA date == X+1
// That divergence is exactly what makes a missing AT TIME ZONE clause visible.
const UTC_DAYS_AGO = 3;
const earlyRunAt   = utcInstantDaysAgo(UTC_DAYS_AGO, 10,  0);
const lateRunAt    = utcInstantDaysAgo(UTC_DAYS_AGO, 22, 30);

const expectedKsaDayEarly = ksaDayString(earlyRunAt); // == sharedUtcDay
const expectedKsaDayLate  = ksaDayString(lateRunAt);  // == sharedUtcDay + 1
const sharedUtcDay        = utcDayString(earlyRunAt);

// Premise checks — fail loudly at module load if the chosen instants don't
// actually exhibit the divergence the test relies on. Both invariants hold
// for ANY current date (KSA = UTC+3, no DST), so these throws are dead
// code in practice; they exist to document intent and to convert a future
// "someone tweaked UTC_DAYS_AGO/hours and broke the premise" into a clear
// startup error instead of a silent false-pass.
if (utcDayString(lateRunAt) !== sharedUtcDay) {
  throw new Error(
    `seed precondition failed: 10:00 UTC and 22:30 UTC are not on the same UTC ` +
    `day (${sharedUtcDay} vs ${utcDayString(lateRunAt)}); the test premise is broken`,
  );
}
if (expectedKsaDayEarly === expectedKsaDayLate) {
  throw new Error(
    `seed precondition failed: 10:00 UTC and 22:30 UTC bucket to the same KSA day ` +
    `(${expectedKsaDayEarly}); pick a later UTC hour so 22:30 UTC tips into the next KSA day`,
  );
}

// ─── Fetch helper ───────────────────────────────────────────────────────────
async function api<T = unknown>(path: string, token: string): Promise<{ status: number; body: T }> {
  const res = await fetch(baseUrl + path, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  return { status: res.status, body: body as T };
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

  // SuperAdmin user with a deterministic sessionToken (bypasses login),
  // mirroring the auth pattern in the sibling trend tests.
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
  insertedUserIds.push(sa.id);

  // One active company under TEST_TAG. The fleet branch filters on
  // `c.status = 'active'`, so anything else here would silently exclude us.
  companyName = `${TEST_TAG} شركة الاختبار TZ`;
  const [co] = await db.insert(companiesTable).values({
    nameAr:         companyName,
    nameEn:         `${TEST_TAG} TZ Boundary Co`,
    vatNumber:      `30000000${randomBytes(3).toString("hex")}`,
    crNumber:       `CR_${TEST_TAG}`,
    city:           "Riyadh",
    street:         "Test St",
    buildingNumber: "1",
    postalCode:     "12345",
    country:        "SA",
    invoiceType:    "both",
    status:         "active",
  }).returning({ id: companiesTable.id });
  companyId = co.id;
  insertedCompanyIds.push(companyId);

  // Per-company tool: ONE tool with TWO runs at the cross-boundary pair.
  // The per-company branch returns one row per (toolKey, day_str), so:
  //   • KSA-correct → 2 rows (one per KSA day)
  //   • UTC-bug     → 1 row  (both runs collapse to the same UTC-day bucket
  //                          and DISTINCT ON keeps the latest)
  // We use status='ok' for both runs so this tool contributes ZERO to the
  // company's `criticalRuns` total — keeping the fleet assertion below
  // immune to "did the per-company tool's status pollute the count?".
  const pcRows = [
    { companyId, toolKey: TOOL_PC, status: "ok", count: 1,
      trigger: "scheduled" as const, runAt: earlyRunAt, durationMs: 1, error: null, details: null },
    { companyId, toolKey: TOOL_PC, status: "ok", count: 2,
      trigger: "scheduled" as const, runAt: lateRunAt,  durationMs: 1, error: null, details: null },
  ];

  // Fleet tools: FLEET_TOOL_COUNT distinct toolKeys, each with the SAME
  // boundary pair, all status=critical. Every tool yields:
  //   • KSA-correct → 2 distinct (company, tool, day_str) critical buckets
  //   • UTC-bug     → 1 distinct (company, tool, day_str) critical bucket
  // So the company's `criticalRuns` becomes 2*N (correct) vs N (bug) — a
  // dead-simple integer assertion that pinpoints the regression.
  const fleetRows = Array.from({ length: FLEET_TOOL_COUNT }, (_, i) => i).flatMap((i) => {
    const tk = fleetToolKey(i);
    return [
      { companyId, toolKey: tk, status: "critical", count: 10,
        trigger: "scheduled" as const, runAt: earlyRunAt, durationMs: 1, error: null, details: null },
      { companyId, toolKey: tk, status: "critical", count: 10,
        trigger: "scheduled" as const, runAt: lateRunAt,  durationMs: 1, error: null, details: null },
    ];
  });

  const inserted = await db
    .insert(maintenanceRunsTable)
    .values([...pcRows, ...fleetRows])
    .returning({ id: maintenanceRunsTable.id });
  for (const r of inserted) insertedMaintenanceRunIds.push(r.id);
});

after(async () => {
  try { await cleanup(); } finally {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    try { await pool.end(); } catch { /* already ended is fine */ }
  }
});

async function cleanup(): Promise<void> {
  // Strict-by-PK cleanup. We delete maintenance_runs explicitly first even
  // though the FK to companies cascades — it makes intent obvious and means
  // a future schema change that drops the cascade doesn't silently leak rows
  // into the shared dev DB. Mirrors the sibling trend tests.
  if (insertedMaintenanceRunIds.length) {
    await db.delete(maintenanceRunsTable)
      .where(inArray(maintenanceRunsTable.id, insertedMaintenanceRunIds));
  }
  if (insertedUserIds.length) {
    await db.delete(usersTable).where(inArray(usersTable.id, insertedUserIds));
  }
  if (insertedCompanyIds.length) {
    await db.delete(companiesTable).where(inArray(companiesTable.id, insertedCompanyIds));
  }
}

// ─── Response shapes ────────────────────────────────────────────────────────
interface PerCompanyRow {
  toolKey: string;
  day:     string;
  count:   number;
  status:  string;
}
interface PerCompanyResponse {
  days:      number;
  companyId: number;
  items:     PerCompanyRow[];
}

interface FleetRow {
  companyId:     number;
  companyName:   string;
  criticalCount: number;
  criticalRuns:  number;
  toolCount:     number;
  lastRunAt:     string | null;
}
interface FleetResponse {
  days:  number;
  fleet: FleetRow[];
}

// ════════════════════════════════════════════════════════════════════════════
// Per-company branch — `day` strings must be KSA wall-clock dates, not UTC.
// ════════════════════════════════════════════════════════════════════════════
test("GET /maintenance/trend (per-company): cross-midnight UTC runs bucket by KSA wall-clock day, not UTC date", async () => {
  const r = await api<PerCompanyResponse>(
    `/api/admin/maintenance/trend?companyId=${companyId}&days=14`,
    saToken,
  );
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  assert.equal(r.body.companyId, companyId, "response companyId must echo the query");
  assert.ok(Array.isArray(r.body.items), "items must be an array");

  // Narrow to OUR boundary tool. The per-company branch is already scoped
  // to a single companyId, but the same company also carries the fleet
  // tools — filtering by toolKey keeps the per-company assertions immune
  // to that and to any unrelated noise on this company in the dev DB.
  const ours = r.body.items.filter((x) => x.toolKey === TOOL_PC);

  // KSA-correct → TWO rows (one per KSA day).
  // UTC-bug     → ONE row (both runs collapse into one UTC-day bucket and
  //               DISTINCT ON folds them to the latest).
  assert.equal(
    ours.length, 2,
    `expected 2 per-(toolKey, day) rows for the boundary tool (one per KSA day); ` +
    `got ${ours.length}: ${JSON.stringify(ours)}. ` +
    `If this collapsed to 1, the SQL has likely been bucketing by UTC date — ` +
    `look for a missing \`AT TIME ZONE 'Asia/Riyadh'\` clause in the per-company branch.`,
  );

  const days = new Set(ours.map((x) => x.day));

  // The early run's KSA date == its UTC date (no boundary crossed). It's
  // here mostly to make the "two rows" assertion meaningful — under both
  // bucketing strategies it would land on this date, so it's not a
  // discriminator on its own.
  assert.ok(
    days.has(expectedKsaDayEarly),
    `boundary tool missing the early-run day (${expectedKsaDayEarly}); got days=${[...days].join(",")}`,
  );

  // The LATE run is the discriminator. Its KSA date is one day AHEAD of
  // its UTC date. If the route ever drops the AT TIME ZONE clause, this
  // row's `day` would surface as the UTC date (= sharedUtcDay = expectedKsaDayEarly)
  // instead, and `expectedKsaDayLate` would be ABSENT from the response.
  assert.ok(
    days.has(expectedKsaDayLate),
    `boundary tool missing the late-run KSA day (${expectedKsaDayLate}); got days=${[...days].join(",")}. ` +
    `The 22:30 UTC run sits at 01:30 KSA on the NEXT KSA day; if it bucketed under ` +
    `the UTC date (${sharedUtcDay}) instead, the AT TIME ZONE 'Asia/Riyadh' clause ` +
    `is missing from the per-company branch.`,
  );

  // Defence-in-depth: explicitly confirm the surfaced day-strings are
  // EXACTLY the KSA-correct pair and nothing else. A regression that
  // somehow yields the right count of rows but with two UTC-shaped
  // day-strings (e.g. via some other broken aggregation) would still fail
  // here.
  assert.deepEqual(
    [...days].sort(),
    [expectedKsaDayEarly, expectedKsaDayLate].sort(),
    "boundary tool surfaced unexpected day strings — KSA bucketing produced something other than the expected pair",
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Fleet branch — `criticalRuns` (= count of distinct (company, tool, day_str)
// critical buckets) must reflect KSA-day bucketing too.
// ════════════════════════════════════════════════════════════════════════════
test("GET /maintenance/trend (fleet): cross-midnight UTC critical runs are counted as separate KSA days, not collapsed by UTC date", async () => {
  const r = await api<FleetResponse>("/api/admin/maintenance/trend?days=14", saToken);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.fleet), "fleet must be an array");

  // Find OUR seeded company in the leaderboard. With FLEET_TOOL_COUNT=100
  // distinct critical tools each producing 2 KSA-day buckets, our company
  // accumulates 200 criticalRuns under correct KSA bucketing — well above
  // the 80 max that the sibling fleet test seeds — so the LIMIT-5 cap is
  // not a worry. Under a UTC-bucketing regression we'd accumulate only
  // 100 criticalRuns, which would either still surface us in the top-5
  // (and the count assertion below catches the regression) or push us off
  // the leaderboard entirely (and the "must be present" assertion catches
  // it instead). Either way the test fails loudly.
  const ours = r.body.fleet.find((row) => row.companyId === companyId);
  if (!ours) {
    assert.fail(
      `seeded boundary company (#${companyId}, "${companyName}") absent from fleet response. ` +
      `That can happen if the fleet branch buckets by UTC date instead of KSA wall-clock day ` +
      `(criticalRuns would be ${FLEET_TOOL_COUNT} instead of ${FLEET_TOOL_COUNT * 2}, demoting us out of the top-5). ` +
      `Response companies: ${r.body.fleet.map((x) => `${x.companyId}:${x.companyName}=${x.criticalRuns}`).join(" | ")}`,
    );
  }

  // KSA-correct: each of the FLEET_TOOL_COUNT tools contributes 2 distinct
  // (company, tool, day_str) critical buckets — so criticalRuns == 2*N.
  // UTC-bug:    each tool's two runs collapse to ONE UTC-day bucket — so
  //             criticalRuns == N.
  assert.equal(
    ours.criticalRuns, FLEET_TOOL_COUNT * 2,
    `fleet criticalRuns=${ours.criticalRuns}, expected ${FLEET_TOOL_COUNT * 2}. ` +
    `If criticalRuns=${FLEET_TOOL_COUNT}, the fleet CTE has been bucketing by UTC date — ` +
    `look for a missing \`AT TIME ZONE 'Asia/Riyadh'\` clause around window_runs.day_str.`,
  );

  // Defence-in-depth: toolCount is a COUNT(DISTINCT tool_key) and is
  // INDEPENDENT of the day_str bucketing. Pinning it to FLEET_TOOL_COUNT
  // makes a future regression that confuses tool_key with day_str (e.g.
  // accidentally COUNTing day_str instead of tool_key) fail loudly here
  // too, even if criticalRuns somehow still happens to land on the
  // expected number.
  assert.equal(
    ours.toolCount, FLEET_TOOL_COUNT,
    `fleet toolCount=${ours.toolCount}, expected ${FLEET_TOOL_COUNT}`,
  );
});
