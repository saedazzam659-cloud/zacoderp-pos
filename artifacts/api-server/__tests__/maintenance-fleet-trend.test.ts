// Integration test for the "fleet" branch of GET /api/admin/maintenance/trend
// (artifacts/api-server/src/routes/admin.ts ~L4585) — the SuperAdmin
// "أكثر الشركات نتائج حرجة" leaderboard the cross-tenant maintenance page
// relies on.
//
// What this protects:
//   The fleet projection is a non-trivial CTE-based query that:
//     • restricts to active companies only,
//     • groups maintenance_runs into distinct (company, tool, KSA-day) buckets
//       where status='critical',
//     • ranks by (criticalRuns DESC, criticalCount DESC), and
//     • caps the result at LIMIT 5 inside a `days`-day window.
//
//   Today the only automated coverage is an E2E test
//   (`__tests__/e2e/fleet-leaderboard-auto-refresh.spec.ts`, task #103) which
//   only checks that *some* seeded company appears. That alone cannot detect:
//
//     - flipping `ORDER BY "criticalRuns" DESC, "criticalCount" DESC` to
//       `criticalCount` first (silently re-orders the panel),
//     - dropping the `WHERE c.status = 'active'` filter (inactive tenants
//       contaminate the leaderboard),
//     - raising/lowering the `LIMIT 5` cap (the panel grows or shrinks
//       silently),
//     - dropping the `m.run_at >= now() - days * '1 day'` window predicate
//       (old critical findings re-pollute the panel forever).
//
//   This file pins all four of those guarantees with a focused seed + a few
//   assertions — a regression in any of them fails the test loudly instead of
//   silently re-ranking the SuperAdmin leaderboard.
//
// How to run:
//   pnpm --filter @workspace/api-server test
//
// Notes:
//   - Boots the Express app in-process on a random port. Uses the real DB
//     (DATABASE_URL).
//   - Seeds 6 active + 1 inactive + 1 "old" company tagged with a per-run
//     TEST_TAG so they don't collide with anything else in the shared dev DB.
//   - Each seeded company gets enough distinct critical (toolKey, day) pairs
//     (64..90) to FAR outrank natural noise in dev — the e2e sibling uses
//     20 per company, we use 64+ here so the assertions about top-5 ordering
//     stay robust even on a fairly busy dev DB.
//   - Cleanup is strict-by-PK (no LIKE / wildcards on shared tables), mirroring
//     the pattern in admin-email-runs-retention.test.ts and the e2e fleet
//     spec. A crashed run leaves orphan tagged rows that this run cannot
//     match — they remain inert and visible for human inspection.

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
// Per-run tag so seeded company names + toolKeys are uniquely identifiable in
// the shared dev DB. Cleanup deletes by recorded primary key only — TEST_TAG
// is purely for human inspection / response filtering.
const TEST_TAG = `tt_fleet_${randomBytes(4).toString("hex")}`;

let server: http.Server;
let baseUrl: string;
let saToken: string;

const insertedCompanyIds:        number[] = [];
const insertedUserIds:           number[] = [];
const insertedMaintenanceRunIds: number[] = [];

// Seed sizing — chosen so each seeded company has FAR more distinct critical
// (toolKey, day) pairs than any real tenant accrues in a 14-day window in
// dev. The e2e sibling (task #103) uses 20 per company and notes that's
// "well above what any real tenant accrues in a 14-day window in dev"; we
// scale up to 64..90 here because, unlike the e2e spec, this file has to
// reason about the LIMIT 5 cap with six seeded companies competing for the
// top slots — extra headroom keeps the per-row ordering assertions robust
// even on a busy dev DB.
//
// Profiles encode both the criticalRuns rank AND a tiebreak on criticalCount:
//   A: 80 distinct toolKeys (today), count=10  → criticalRuns=80, criticalCount=800
//   B: 76 distinct toolKeys (today), count=10  → criticalRuns=76, criticalCount=760
//   C: 76 distinct toolKeys (today), count=5   → criticalRuns=76, criticalCount=380
//   D: 72 distinct toolKeys (today), count=10  → criticalRuns=72, criticalCount=720
//   E: 68 distinct toolKeys (today), count=10  → criticalRuns=68, criticalCount=680
//   F: 64 distinct toolKeys (today), count=10  → criticalRuns=64 (excluded by LIMIT 5)
//   INACTIVE: 80 distinct toolKeys (today), count=10 — would be #1 if active,
//             so its absence proves the WHERE c.status='active' filter is alive.
//   OLD: 90 distinct toolKeys, all runAt = 20 days ago, count=10 — invisible to
//        days=14 (so it must NOT appear) but visible to days=30 (and at
//        criticalRuns=90 it must be #1 in that response, proving the window
//        actually moves with the parameter).
const PROFILES = {
  A:        { distinct: 80, count: 10, ageDays:  0, status: "active"   as const, label: "A" },
  B:        { distinct: 76, count: 10, ageDays:  0, status: "active"   as const, label: "B" },
  C:        { distinct: 76, count: 5,  ageDays:  0, status: "active"   as const, label: "C" },
  D:        { distinct: 72, count: 10, ageDays:  0, status: "active"   as const, label: "D" },
  E:        { distinct: 68, count: 10, ageDays:  0, status: "active"   as const, label: "E" },
  F:        { distinct: 64, count: 10, ageDays:  0, status: "active"   as const, label: "F" },
  INACTIVE: { distinct: 80, count: 10, ageDays:  0, status: "inactive" as const, label: "INACTIVE" },
  OLD:      { distinct: 90, count: 10, ageDays: 20, status: "active"   as const, label: "OLD" },
} as const;

type ProfileKey = keyof typeof PROFILES;
const companyIds = {} as Record<ProfileKey, number>;
const companyNames = {} as Record<ProfileKey, string>;

// Fleet response shape (matches the JSON the route emits).
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

  // SuperAdmin user with a deterministic sessionToken (bypasses login).
  // Mirrors the auth pattern in admin-email-runs-retention.test.ts.
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

  // Seed all eight tenants. CR/VAT numbers are namespaced under TEST_TAG so
  // they cannot collide with real rows or with another concurrent test run.
  // Companies' nameAr carries TEST_TAG so the response-side filter below can
  // pick out exactly the rows this run inserted, regardless of natural noise.
  for (const key of Object.keys(PROFILES) as ProfileKey[]) {
    const p = PROFILES[key];
    const nameAr = `${TEST_TAG} شركة الاختبار ${p.label}`;
    const [co] = await db.insert(companiesTable).values({
      nameAr,
      nameEn:         `${TEST_TAG} Fleet Co ${p.label}`,
      vatNumber:      `30000000${randomBytes(3).toString("hex")}`,
      crNumber:       `CR_${TEST_TAG}_${p.label}`,
      city:           "Riyadh",
      street:         "Test St",
      buildingNumber: "1",
      postalCode:     "12345",
      country:        "SA",
      invoiceType:    "both",
      status:         p.status,
    }).returning({ id: companiesTable.id });
    companyIds[key]   = co.id;
    companyNames[key] = nameAr;
    insertedCompanyIds.push(co.id);
  }

  // Seed the maintenance_runs rows for every profile in one batch insert per
  // company. Each (toolKey) is unique within the company so it counts as a
  // distinct (toolKey, day_str) pair in the fleet CTE — driving the
  // criticalRuns rank we assert below.
  for (const key of Object.keys(PROFILES) as ProfileKey[]) {
    const p = PROFILES[key];
    const runAt = p.ageDays === 0
      ? new Date()
      : new Date(Date.now() - p.ageDays * 86_400_000);
    const rows = Array.from({ length: p.distinct }, (_, i) => ({
      companyId:  companyIds[key],
      toolKey:    `${TEST_TAG}_${p.label}_tool_${i}`,
      status:     "critical" as const,
      count:      p.count,
      trigger:    "scheduled" as const,
      runAt,
      durationMs: 1,
      error:      null,
      details:    null,
    }));
    const inserted = await db
      .insert(maintenanceRunsTable)
      .values(rows)
      .returning({ id: maintenanceRunsTable.id });
    for (const r of inserted) insertedMaintenanceRunIds.push(r.id);
  }
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
  // into the shared dev DB.
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

// Helper: filter a fleet response down to rows we seeded so noise from other
// tenants in the shared dev DB cannot confuse the assertions. We deliberately
// do NOT filter by `companyId` lookup — matching on the TEST_TAG prefix in
// `companyName` mirrors what an operator would see on the panel and catches a
// regression where the SQL stops projecting `c.name_ar AS "companyName"` too.
function onlySeeded(fleet: FleetRow[]): FleetRow[] {
  return fleet.filter((r) => typeof r.companyName === "string" && r.companyName.startsWith(TEST_TAG));
}

// ════════════════════════════════════════════════════════════════════════════
// GET /maintenance/trend (fleet branch) — order, active filter, LIMIT 5 cap
// ════════════════════════════════════════════════════════════════════════════
test("GET /maintenance/trend (fleet): orders by criticalRuns DESC then criticalCount DESC, excludes inactive, caps at 5", async () => {
  // No `companyId` query → fleet branch (the per-tenant branch needs one).
  // No `days` either → exercises the route's default of 14, matching the
  // panel's first-paint behaviour.
  const r = await api<FleetResponse>("/api/admin/maintenance/trend", saToken);
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  assert.equal(r.body.days, 14, "default days window must be 14");
  assert.ok(Array.isArray(r.body.fleet), "fleet must be an array");

  // LIMIT 5 cap — even with six seeded high-burst companies competing for
  // the top slots PLUS whatever noise the dev DB carries, the response can
  // never exceed 5 rows. A regression that raises the LIMIT (e.g. to 10)
  // would surface here as `length=6` and fail the test loudly.
  assert.ok(r.body.fleet.length <= 5,
    `LIMIT 5 violated: response has ${r.body.fleet.length} rows`);

  // Filter to rows we own. With 6 active seeded companies all carrying
  // 64..80 distinct critical (toolKey, day) pairs — far above natural dev
  // noise — and the LIMIT 5 cap, exactly 5 of our seeds must land in the
  // response. If natural noise managed to squeeze a real tenant into the
  // top-5 ahead of one of our seeds, we'd see fewer than 5 here and the
  // assertion would point at the noise rather than silently passing.
  const ours = onlySeeded(r.body.fleet);
  assert.equal(ours.length, 5,
    `expected exactly 5 seeded companies in top-5, got ${ours.length}: ${ours.map((x) => x.companyName).join(" | ")}`);

  // Inactive seeded company (would be #1 by criticalRuns if it weren't
  // filtered) MUST be absent — proves WHERE c.status='active' is alive.
  const inactiveId = companyIds.INACTIVE;
  for (const row of r.body.fleet) {
    assert.notEqual(row.companyId, inactiveId,
      "inactive seeded company leaked into fleet response — active filter regressed");
  }

  // Order assertion — by `criticalRuns DESC, criticalCount DESC`. We assert
  // the exact order of OUR rows (filtered above). A regression that flips
  // the ORDER BY to `criticalCount` first would re-rank B above C, and
  // crucially would also push C ahead of D when count is high — but the
  // critical contract for the panel is `criticalRuns` first, and that's
  // what this assertion pins.
  //
  // Expected order:
  //   A (criticalRuns=80) — top
  //   B (76, criticalCount=760)
  //   C (76, criticalCount=380) — same criticalRuns as B, lower
  //                                criticalCount → tiebreak places it after B
  //   D (72)
  //   E (68)
  // F (64) excluded by LIMIT 5.
  const expectedOrder: ProfileKey[] = ["A", "B", "C", "D", "E"];
  assert.deepEqual(
    ours.map((r) => r.companyName),
    expectedOrder.map((k) => companyNames[k]),
    "fleet rows are not in (criticalRuns DESC, criticalCount DESC) order — re-ranking regression",
  );

  // Spot-check the per-row aggregates so a regression that nukes one of the
  // SELECT-list columns (e.g. dropping COUNT(*) AS "criticalRuns") fails
  // here even if the order somehow still happens to come out right.
  const findRow = (k: ProfileKey): FleetRow => {
    const row = ours.find((r) => r.companyName === companyNames[k]);
    if (!row) {
      assert.fail(`expected seeded company ${k} (${companyNames[k]}) in top-5, none found`);
    }
    return row;
  };
  const rowA = findRow("A");
  const rowB = findRow("B");
  const rowC = findRow("C");
  assert.equal(rowA.criticalRuns,  PROFILES.A.distinct);
  assert.equal(rowA.criticalCount, PROFILES.A.distinct * PROFILES.A.count);
  assert.equal(rowB.criticalRuns,  PROFILES.B.distinct);
  assert.equal(rowB.criticalCount, PROFILES.B.distinct * PROFILES.B.count);
  assert.equal(rowC.criticalRuns,  PROFILES.C.distinct);
  assert.equal(rowC.criticalCount, PROFILES.C.distinct * PROFILES.C.count);
  // F is the LIMIT-5 victim — its 64 critical pairs put it just below E,
  // and only LIMIT can keep it out. If LIMIT was raised, F would surface.
  assert.equal(
    r.body.fleet.find((x) => x.companyId === companyIds.F),
    undefined,
    "company F leaked into the response — LIMIT 5 cap regressed",
  );
});

// ════════════════════════════════════════════════════════════════════════════
// GET /maintenance/trend (fleet branch) — `days` query parameter window
// ════════════════════════════════════════════════════════════════════════════
test("GET /maintenance/trend (fleet): honours the `days` query parameter — 20-day-old runs are out at days=14, in at days=30", async () => {
  // Default window (days=14): the OLD seed has all rows aged 20 days, so
  // none of them survive `m.run_at >= now() - 14 * '1 day'`. OLD must be
  // entirely absent — not just outranked, ABSENT — from the fleet list.
  const oldId = companyIds.OLD;
  {
    const r = await api<FleetResponse>("/api/admin/maintenance/trend?days=14", saToken);
    assert.equal(r.status, 200);
    assert.equal(r.body.days, 14);
    for (const row of r.body.fleet) {
      assert.notEqual(row.companyId, oldId,
        "OLD seed (20-day-old runs) leaked into days=14 response — window predicate regressed");
    }
  }

  // Wider window (days=30): OLD's 20-day-old rows are now inside the window,
  // and OLD has 90 distinct critical (toolKey, day) pairs — more than any of
  // A-F. So OLD must surface as the #1 row in the response. Anything less
  // (OLD missing OR OLD demoted) means either the window predicate didn't
  // move with the parameter or the days param is being ignored by the SQL.
  {
    const r = await api<FleetResponse>("/api/admin/maintenance/trend?days=30", saToken);
    assert.equal(r.status, 200);
    assert.equal(r.body.days, 30);
    assert.ok(r.body.fleet.length <= 5, `LIMIT 5 still enforced at days=30, got ${r.body.fleet.length}`);

    const ours = onlySeeded(r.body.fleet);
    // OLD must be present somewhere in our subset. With 90 critical pairs vs
    // A's 80, OLD outranks every other seed and, given LIMIT 5, must land
    // at index 0 of the seeded subset.
    assert.ok(ours.length >= 1, "no seeded rows at all in days=30 response — fleet projection broken");
    assert.equal(ours[0].companyId, oldId,
      `OLD did not rank #1 at days=30 (criticalRuns=90); response order: ${ours.map((x) => x.companyName).join(" | ")}`);
    assert.equal(ours[0].criticalRuns, PROFILES.OLD.distinct,
      "OLD criticalRuns mismatch — window may be aggregating wrong rows");
  }
});
