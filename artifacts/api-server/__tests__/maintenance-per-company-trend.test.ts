// Integration test for the "per-company" branch of GET /api/admin/maintenance/trend
// (artifacts/api-server/src/routes/admin.ts ~L4582 — the `hasCompany` arm).
// This is the sibling of `maintenance-fleet-trend.test.ts` (task #110, fleet
// branch) and protects the SQL that drives every per-tool sparkline rendered
// on the per-company maintenance page.
//
// What this protects:
//   The per-company projection is a `DISTINCT ON (tool_key, day_str)` query
//   ordered by `tool_key, day_str, run_at DESC`, which picks the *latest*
//   run of each (tool, KSA-day) as the day's badge. The contract is documented
//   right above the SQL: "a manual fix that flipped status from critical→ok
//   in the afternoon shows green for that day".
//
//   Today the only automated coverage is the fleet sibling above; nothing
//   pins:
//
//     - the latest-of-day tiebreak (flip ORDER BY run_at DESC → ASC and every
//       sparkline silently shows the day's *first* run instead of its final
//       state — old red badges where green ones are due),
//     - the (tool_key, day_str) uniqueness contract (drop DISTINCT ON or the
//       GROUP-equivalent and the same day starts surfacing twice, breaking
//       the per-tool sparkline's one-bar-per-day layout),
//     - the `run_at >= now() - days * '1 day'` window (drop it and old red
//       badges leak into "the last 14 days" view forever).
//
//   This file pins all three of those guarantees with a focused seed + a
//   handful of assertions — a regression in any of them fails the test
//   loudly instead of silently flipping a day's badge in the dashboard.
//
// How to run:
//   pnpm --filter @workspace/api-server test
//
// Notes:
//   - Boots the Express app in-process on a random port. Uses the real DB
//     (DATABASE_URL).
//   - Seeds ONE active company tagged with a per-run TEST_TAG so its toolKeys
//     can be picked out of the response without colliding with anything else
//     in the shared dev DB.
//   - All seeded run_at values are anchored to KSA noon on a known day-offset
//     so they cannot accidentally cross a midnight boundary at runtime — a
//     "two runs same day" assertion that flakes around 03:00 KSA would erode
//     trust in the test instead of in the code it's meant to defend.
//   - Cleanup is strict-by-PK on `maintenance_runs` and `companies` (mirrors
//     `maintenance-fleet-trend.test.ts`). A crashed run leaves orphan tagged
//     rows that this run cannot match — they remain inert and visible for
//     human inspection.

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
const TEST_TAG = `tt_pctrend_${randomBytes(4).toString("hex")}`;

let server: http.Server;
let baseUrl: string;
let saToken: string;
let companyId: number;

const insertedCompanyIds:        number[] = [];
const insertedUserIds:           number[] = [];
const insertedMaintenanceRunIds: number[] = [];

// Tool keys — namespaced under TEST_TAG so the response-side filter can pick
// them out regardless of what other rows the shared dev DB carries.
const TOOL_LATEST   = `${TEST_TAG}_latest_wins`;
const TOOL_MULTIDAY = `${TEST_TAG}_multi_day`;
const TOOL_OUTSIDE  = `${TEST_TAG}_outside_window`;

// Per-company response shape (matches the JSON the route emits).
interface TrendRow {
  toolKey: string;
  day:     string;
  count:   number;
  status:  string;
}
interface TrendResponse {
  days:      number;
  companyId: number;
  items:     TrendRow[];
}

// ─── Time helpers ───────────────────────────────────────────────────────────
// Build a UTC `Date` representing noon KSA (UTC+3, no DST) on the calendar
// day that is `daysAgo` KSA-days before today. Anchoring to noon KSA keeps
// every seeded row safely far from midnight in KSA so the day-bucket the
// SQL computes (via `(run_at AT TIME ZONE 'Asia/Riyadh')::date`) cannot
// drift between when we seed and when the route reads.
function ksaNoonDaysAgo(daysAgo: number): Date {
  const now = new Date();
  // Shift into KSA so the calendar arithmetic below operates on KSA-days.
  const ksa = new Date(now.getTime() + 3 * 3600 * 1000);
  ksa.setUTCHours(0, 0, 0, 0);
  ksa.setUTCDate(ksa.getUTCDate() - daysAgo);
  ksa.setUTCHours(12, 0, 0, 0); // noon KSA
  // Convert KSA wall-clock back to a UTC instant for storage.
  return new Date(ksa.getTime() - 3 * 3600 * 1000);
}

// Day-string the route emits for a given run_at (`YYYY-MM-DD` in KSA).
function ksaDayString(d: Date): string {
  const ksa = new Date(d.getTime() + 3 * 3600 * 1000);
  const y = ksa.getUTCFullYear().toString().padStart(4, "0");
  const m = (ksa.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = ksa.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
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
  // mirroring the auth pattern in the fleet sibling.
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

  // One active company under TEST_TAG. Status must be `active` so it is a
  // legitimate target of the per-company branch (the route doesn't filter
  // by company status here, but seeding `inactive` would muddy intent).
  const [co] = await db.insert(companiesTable).values({
    nameAr:         `${TEST_TAG} شركة الاختبار`,
    nameEn:         `${TEST_TAG} Per-Company Trend Co`,
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

  // Seed plan — three tool buckets, each pinning a different SQL guarantee:
  //
  //   TOOL_LATEST (latest-of-day tiebreak):
  //     two runs on the SAME KSA day (3 days ago):
  //       • earlier (10:00 KSA): status=critical, count=10
  //       • later   (15:00 KSA): status=ok,       count=0
  //     → expected: ONE row for that day with status='ok' and count=0.
  //       Flipping ORDER BY run_at DESC → ASC would give status='critical'
  //       count=10 — the assertion fires loudly.
  //
  //   TOOL_MULTIDAY (one row per (toolKey, day_str)):
  //     two runs on TWO DIFFERENT KSA days (7 and 10 days ago), each a
  //     single run so the latest-of-day tiebreak isn't even exercised:
  //       • day-7 (noon KSA): status=warn,     count=3
  //       • day-10 (noon KSA): status=critical, count=5
  //     → expected: TWO rows, one per day. Catches a regression that drops
  //       DISTINCT ON and lets the same (tool, day) repeat in the response.
  //
  //   TOOL_OUTSIDE (window predicate):
  //     ONE run 20 KSA-days ago (well past the default 14-day window AND
  //     a sibling 14-day request below).
  //     → expected at days=14: ABSENT (proves the window predicate is alive).
  //     → expected at days=30: PRESENT exactly once (proves the window
  //       parameter actually moves with the `days` query value).
  const latestDay   = ksaNoonDaysAgo(3);
  const latestEarly = new Date(latestDay.getTime() - 5 * 3600 * 1000);  // 07:00 KSA same day
  const latestLate  = new Date(latestDay.getTime() + 3 * 3600 * 1000);  // 15:00 KSA same day

  const multiA = ksaNoonDaysAgo(7);
  const multiB = ksaNoonDaysAgo(10);
  const outside = ksaNoonDaysAgo(20);

  const inserted = await db.insert(maintenanceRunsTable).values([
    // TOOL_LATEST — earlier critical, later ok, both same KSA day.
    { companyId, toolKey: TOOL_LATEST, status: "critical", count: 10,
      trigger: "scheduled", runAt: latestEarly, durationMs: 1, error: null, details: null },
    { companyId, toolKey: TOOL_LATEST, status: "ok", count: 0,
      trigger: "manual",    runAt: latestLate,  durationMs: 1, error: null, details: null },

    // TOOL_MULTIDAY — one run on each of two different KSA days.
    { companyId, toolKey: TOOL_MULTIDAY, status: "warn",     count: 3,
      trigger: "scheduled", runAt: multiA, durationMs: 1, error: null, details: null },
    { companyId, toolKey: TOOL_MULTIDAY, status: "critical", count: 5,
      trigger: "scheduled", runAt: multiB, durationMs: 1, error: null, details: null },

    // TOOL_OUTSIDE — one run 20 days ago, well outside the default window.
    { companyId, toolKey: TOOL_OUTSIDE, status: "critical", count: 99,
      trigger: "scheduled", runAt: outside, durationMs: 1, error: null, details: null },
  ]).returning({ id: maintenanceRunsTable.id });
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
  // into the shared dev DB. Mirrors the fleet sibling.
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

// Helper: filter a per-company trend response down to rows whose toolKey is
// one of ours. The per-company branch is scoped to a single companyId so it
// won't return other tenants' rows, but other tests / dev noise on the same
// company would (e.g. a parallel run of maintenance.test.ts seeding the same
// company id would not — companies are unique per run — but production-shape
// data left behind by ad-hoc scripts could). Filtering by TEST_TAG-prefixed
// toolKey keeps the assertions immune to that.
function onlySeeded(items: TrendRow[]): TrendRow[] {
  return items.filter((r) =>
    r.toolKey === TOOL_LATEST ||
    r.toolKey === TOOL_MULTIDAY ||
    r.toolKey === TOOL_OUTSIDE,
  );
}

// ════════════════════════════════════════════════════════════════════════════
// GET /maintenance/trend?companyId=… — latest-of-day tiebreak + per-pair
// uniqueness + window predicate
// ════════════════════════════════════════════════════════════════════════════
test("GET /maintenance/trend (per-company): latest run wins the day, one row per (toolKey, day), out-of-window runs excluded", async () => {
  // No `days` → exercises the route's default of 14, matching first paint
  // on the per-company maintenance page.
  const r = await api<TrendResponse>(`/api/admin/maintenance/trend?companyId=${companyId}`, saToken);
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  assert.equal(r.body.days,      14,        "default days window must be 14");
  assert.equal(r.body.companyId, companyId, "response companyId must echo the query");
  assert.ok(Array.isArray(r.body.items), "items must be an array");

  const ours = onlySeeded(r.body.items);

  // Expected exactly 3 of our rows in the default window:
  //   - 1 for TOOL_LATEST   (the day's latest, status=ok)
  //   - 2 for TOOL_MULTIDAY (one per day)
  //   - 0 for TOOL_OUTSIDE  (filtered by the window predicate)
  assert.equal(ours.length, 3,
    `expected exactly 3 seeded rows, got ${ours.length}: ${JSON.stringify(ours)}`);

  // ── Latest-of-day tiebreak ────────────────────────────────────────────
  // The earlier seed for TOOL_LATEST is `critical`/count=10; the later is
  // `ok`/count=0. The day's row MUST reflect the later run. Flipping the
  // ORDER BY tiebreak to `run_at ASC` (or removing it altogether — Postgres
  // would then pick whichever row it scanned first) would surface
  // `critical`/10 here and fail the test loudly.
  const latestRows = ours.filter((x) => x.toolKey === TOOL_LATEST);
  assert.equal(latestRows.length, 1,
    `TOOL_LATEST must collapse to one row per day (DISTINCT ON), got ${latestRows.length}`);
  const latestRow = latestRows[0];
  assert.equal(latestRow.day,    ksaDayString(ksaNoonDaysAgo(3)),
    "TOOL_LATEST row landed on an unexpected KSA day");
  assert.equal(latestRow.status, "ok",
    "TOOL_LATEST status must be 'ok' (the LATER run); flipping ORDER BY run_at DESC→ASC would surface 'critical' here");
  assert.equal(latestRow.count,  0,
    "TOOL_LATEST count must come from the LATER run (=0); a stale-pick regression would surface 10");

  // ── One row per (toolKey, day_str) ─────────────────────────────────────
  // Across ALL rows in the response (not just ours) the (toolKey, day)
  // tuple must be unique — that's the DISTINCT ON contract. We assert it
  // globally because a regression that drops DISTINCT ON would surface as
  // duplicates regardless of tenant; and we assert it specifically on our
  // TOOL_MULTIDAY rows so a duplication regression that only manifests
  // when there are multiple distinct days for one tool also fails.
  const seen = new Set<string>();
  for (const row of r.body.items) {
    const key = `${row.toolKey}\u0000${row.day}`;
    assert.ok(!seen.has(key),
      `duplicate (toolKey, day) pair in response — DISTINCT ON regressed: ${key}`);
    seen.add(key);
  }
  const multiRows = ours.filter((x) => x.toolKey === TOOL_MULTIDAY);
  assert.equal(multiRows.length, 2,
    `TOOL_MULTIDAY must produce one row per distinct day (expected 2), got ${multiRows.length}`);
  const multiDays = new Set(multiRows.map((x) => x.day));
  assert.equal(multiDays.size, 2, "TOOL_MULTIDAY rows must be on two distinct days");
  assert.ok(multiDays.has(ksaDayString(ksaNoonDaysAgo(7))),
    "TOOL_MULTIDAY missing day-7 row");
  assert.ok(multiDays.has(ksaDayString(ksaNoonDaysAgo(10))),
    "TOOL_MULTIDAY missing day-10 row");

  // ── Window predicate (exclusion side) ──────────────────────────────────
  // The 20-day-old run must be ABSENT under days=14. A regression that
  // drops `WHERE run_at >= now() - days * '1 day'` would surface this row
  // and fail here.
  const outsideRows = ours.filter((x) => x.toolKey === TOOL_OUTSIDE);
  assert.equal(outsideRows.length, 0,
    `TOOL_OUTSIDE (20 days old) leaked into days=14 response — window predicate regressed: ${JSON.stringify(outsideRows)}`);
});

// ════════════════════════════════════════════════════════════════════════════
// GET /maintenance/trend?companyId=…&days=30 — `days` parameter widens the
// window and brings the previously-excluded row into view.
// ════════════════════════════════════════════════════════════════════════════
test("GET /maintenance/trend (per-company): widening `days` to 30 brings the 20-day-old run into the response (window honours the parameter)", async () => {
  const r = await api<TrendResponse>(`/api/admin/maintenance/trend?companyId=${companyId}&days=30`, saToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.days, 30, "echoed `days` must move with the parameter");
  assert.equal(r.body.companyId, companyId);

  const ours = onlySeeded(r.body.items);

  // Now we expect 4 rows: the same 3 as before PLUS the previously-excluded
  // TOOL_OUTSIDE day. Anything less means the `days` parameter isn't being
  // threaded through to the SQL window.
  assert.equal(ours.length, 4,
    `expected 4 seeded rows at days=30, got ${ours.length}: ${JSON.stringify(ours)}`);

  const outsideRows = ours.filter((x) => x.toolKey === TOOL_OUTSIDE);
  assert.equal(outsideRows.length, 1,
    `TOOL_OUTSIDE must surface exactly once at days=30, got ${outsideRows.length}`);
  assert.equal(outsideRows[0].day, ksaDayString(ksaNoonDaysAgo(20)),
    "TOOL_OUTSIDE row landed on an unexpected KSA day");
  assert.equal(outsideRows[0].status, "critical");
  assert.equal(outsideRows[0].count,  99);
});
