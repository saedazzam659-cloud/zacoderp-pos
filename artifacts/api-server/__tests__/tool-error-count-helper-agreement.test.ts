// Integration tests pinning the COUNT helpers behind the SuperAdmin tool-list
// CSV exports — `countRecentToolErrors` / `countRecentToolRecoveries` in
// artifacts/api-server/src/lib/maintenanceScheduler.ts (~L869 and ~L969) — to
// the row helpers they're supposed to mirror — `getRecentToolErrors` /
// `getRecentToolRecoveries` (~L828 / ~L917).
//
// Why this exists (task #118):
//   The two CSV-export paths on /admin/ai-fix (broken-tools and recovered-
//   tools) report a "real underlying total" alongside the clipped row count,
//   sourced from the COUNT helpers. Each COUNT helper duplicates the full
//   WHERE clause of its row-returning sibling. If a future refactor tweaks
//   the projection in only one of the two helpers (e.g. extends the recency
//   window, adds a soft-delete filter, or adjusts the rn=1 / status<>'error'
//   guards in the recoveries helper that task #113 just locked the panel
//   boundary on), the COUNT will silently drift away from the real underlying
//   number. Operators reviewing past audit rows would then see a misleading
//   "data was clipped: real total = N" without any test failing.
//
//   `maintenance.test.ts` already has two thin tests (~L1891 / ~L1906) that
//   compare the helpers' results on whatever happens to live in the dev DB.
//   Those would pass vacuously if no dev-DB rows fell in a newly-diverging
//   region (e.g. if the row helper was extended to surface errors from
//   `rejected` companies but the COUNT helper wasn't, and no rejected company
//   currently has any 'error' rows). This file plants explicit rows on each
//   side of every documented WHERE-clause boundary so a regression in either
//   helper's filter MUST flip the equality.
//
// Boundaries seeded:
//   Active-vs-rejected company filter (`c.status = 'active'`):
//     - active   broken         → counted by errors helper, not recoveries
//     - rejected broken         → must be filtered out by errors helper
//     - rejected recovered      → must be filtered out by recoveries helper
//   Recency window (`l.run_at >= now() - 7d`):
//     - active stale-broken     → must be filtered out by errors helper
//     - active stale-recovered  → must be filtered out by recoveries helper
//   Latest-run / per-(company, tool) projection (DISTINCT ON / rn=1):
//     - active recovered-to-ok  → must NOT appear in errors (latest=ok),
//                                 MUST   appear in recoveries
//     - active recovered-to-warn → must NOT appear in errors (latest=warn),
//                                  MUST   appear in recoveries (status<>'error',
//                                  currentStatus='warn')
//   Status guards on the recovery side:
//     - active re-broken (err→ok→err) → MUST appear in errors (latest=err),
//                                       must NOT appear in recoveries
//                                       (rn=1's status='error' fails the
//                                       `status <> 'error'` guard).
//     - active always-ok (no prior error) → must NOT appear in either
//                                           (prev_status null fails the
//                                           `prev_status = 'error'` guard).
//
// Determinism:
//   - Two brand-new `companies` rows tagged with a per-run TEST_TAG so the
//     seeded data never collides with whatever else lives on the shared dev
//     DB. The `rejected` company carries status='rejected' (one of the three
//     documented company statuses in lib/db/src/schema/companies.ts L69:
//     pending | active | rejected) so the active-only filter has something
//     concrete to exclude.
//   - Tool keys are TEST_TAG-prefixed so the sanity assertions below can
//     pinpoint our seed without depending on overall row counts (the dev DB
//     may already have unrelated broken / recovered tools on the page
//     legitimately).
//   - Run timestamps are spaced ~1 day apart inside the 7-day window so the
//     LAG / DISTINCT ON projections pair them in the intended order
//     regardless of insertion-time tie-breaking. Stale rows are placed
//     at `windowDays + 1` days back so a clock skew wouldn't accidentally
//     pull them inside the window.
//
// Cleanup:
//   - Strict-by-PK: every inserted row id (maintenance_runs, companies) is
//     recorded and deleted by `inArray` in the after() hook. No LIKE /
//     wildcards on production tables; a crashed run never touches another
//     tenant's data. Mirrors the hygiene used by the recovered-then-
//     rebroken e2e spec (task #113) and sequence-per-branch-counter.test.ts.
//   - `pool.end()` is called in after() because `node --test` runs each
//     `__tests__/*.test.ts` file in its own process; the pool we tear down
//     is local to this test file.
//
// How to run:
//   pnpm --filter @workspace/api-server test

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { inArray } from "drizzle-orm";
import {
  db,
  pool,
  companiesTable,
  maintenanceRunsTable,
} from "@workspace/db";

import {
  getRecentToolErrors,
  getRecentToolRecoveries,
  countRecentToolErrors,
  countRecentToolRecoveries,
  TOOL_ERROR_WINDOW_DAYS,
} from "../src/lib/maintenanceScheduler.ts";

// ─── Test scoping ───────────────────────────────────────────────────────────
const TEST_TAG = `tt_t118_${randomBytes(4).toString("hex")}`;

// Limit the row helpers to a deliberately huge cap so they can't be the ones
// doing the capping — any difference between count and rows.length must come
// from a divergence in their WHERE clauses, which would silently break the
// CSV-export route's "real underlying total" audit metadata.
const VERY_HIGH_LIMIT = 10_000;

// Tool keys we expect to surface in the errors helper after seeding. Anchored
// on TEST_TAG so the sanity check ignores whatever else is in the dev DB.
const TOOL_BROKEN          = `${TEST_TAG}_broken`;          // active + latest=err in window  → error helper
const TOOL_REBROKEN        = `${TEST_TAG}_rebroken`;        // active + err→ok→err in window  → error helper, NOT recoveries
// Tool keys we expect to surface in the recoveries helper after seeding.
const TOOL_REC_OK          = `${TEST_TAG}_rec_ok`;          // active + err→ok in window      → recoveries helper
const TOOL_REC_WARN        = `${TEST_TAG}_rec_warn`;        // active + err→warn in window    → recoveries helper
// Tool keys that must be filtered out by BOTH helpers (boundary cases). We
// don't assert their *absence* explicitly per row — instead we assert that
// no rows in either helper carry any of these (companyId, toolKey) pairs.
const TOOL_STALE_BROKEN    = `${TEST_TAG}_stale_broken`;    // active + err outside window
const TOOL_STALE_RECOVERED = `${TEST_TAG}_stale_recovered`; // active + err→ok both outside window
const TOOL_ALWAYS_OK       = `${TEST_TAG}_always_ok`;       // active + only ok run, no prior err
const TOOL_REJECTED_BROKEN     = `${TEST_TAG}_rej_broken`;     // rejected + latest=err in window
const TOOL_REJECTED_RECOVERED  = `${TEST_TAG}_rej_recovered`;  // rejected + err→ok in window

let activeCompanyId:   number;
let rejectedCompanyId: number;

const insertedCompanyIds: number[] = [];
const insertedRunIds:     number[] = [];

// ─── Lifecycle ──────────────────────────────────────────────────────────────
before(async () => {
  // Two brand-new companies. The "rejected" one is for the active-only filter
  // boundary: every row we seed against it must be excluded by both helpers.
  const baseCompany = (suffix: string, status: string): typeof companiesTable.$inferInsert => ({
    nameAr:         `${TEST_TAG} شركة ${suffix}`,
    nameEn:         `${TEST_TAG} Test Co ${suffix}`,
    vatNumber:      `300000000000${suffix.charCodeAt(0) % 10}`,
    crNumber:       `CR_${TEST_TAG}_${suffix}`,
    city:           "Riyadh",
    street:         "Test St",
    buildingNumber: "1",
    postalCode:     "12345",
    country:        "SA",
    invoiceType:    "both",
    status,
  });
  const cos = await db
    .insert(companiesTable)
    .values([baseCompany("A", "active"), baseCompany("R", "rejected")])
    .returning({ id: companiesTable.id });
  activeCompanyId   = cos[0].id;
  rejectedCompanyId = cos[1].id;
  insertedCompanyIds.push(activeCompanyId, rejectedCompanyId);

  const now    = Date.now();
  const day    = 86_400_000;
  const inWin1 = new Date(now - 1 * day);
  const inWin2 = new Date(now - 2 * day);
  const inWin3 = new Date(now - 3 * day);
  const inWin4 = new Date(now - 4 * day);
  // Strictly OUTSIDE the 7-day window — `+ 1` day guards against clock skew
  // between this process and Postgres `now()`.
  const stale1 = new Date(now - (TOOL_ERROR_WINDOW_DAYS + 1) * day);
  const stale2 = new Date(now - (TOOL_ERROR_WINDOW_DAYS + 2) * day);

  // Helper to keep the seed table compact and readable.
  const insertRun = async (
    companyId: number,
    toolKey:   string,
    status:    "ok" | "warn" | "critical" | "error",
    runAt:     Date,
    error:     string | null,
  ): Promise<void> => {
    const [r] = await db.insert(maintenanceRunsTable).values({
      companyId,
      toolKey,
      status,
      count:      0,
      trigger:    "scheduled",
      runAt,
      durationMs: 1,
      error,
      details:    null,
    }).returning({ id: maintenanceRunsTable.id });
    insertedRunIds.push(r.id);
  };

  // ── Active company seed ─────────────────────────────────────────────────
  // Latest=error in window → MUST appear in errors helper.
  await insertRun(activeCompanyId, TOOL_BROKEN, "error", inWin1, "boom");
  // err→ok→err all in window → MUST appear in errors helper (latest=err);
  // MUST NOT appear in recoveries (rn=1's status='error' fails the
  // `status <> 'error'` guard — the boundary task #113 locked down).
  await insertRun(activeCompanyId, TOOL_REBROKEN, "error", inWin3, "first");
  await insertRun(activeCompanyId, TOOL_REBROKEN, "ok",    inWin2, null);
  await insertRun(activeCompanyId, TOOL_REBROKEN, "error", inWin1, "again");
  // err→ok in window → MUST appear in recoveries helper; MUST NOT appear in
  // errors helper (DISTINCT ON / latest=ok). currentStatus contract is
  // covered by the dedicated test in maintenance.test.ts; here we just need
  // it to be one of the recovery rows so the COUNT must include it.
  await insertRun(activeCompanyId, TOOL_REC_OK, "error", inWin3, "boom");
  await insertRun(activeCompanyId, TOOL_REC_OK, "ok",    inWin1, null);
  // err→warn in window → MUST appear in recoveries helper (status<>'error',
  // currentStatus='warn' — operators still want this; honest reporting).
  await insertRun(activeCompanyId, TOOL_REC_WARN, "error", inWin4, "kaboom");
  await insertRun(activeCompanyId, TOOL_REC_WARN, "warn",  inWin2, null);
  // Stale broken — latest run outside window → MUST be filtered out by the
  // errors helper's recency clause. Without this seed a regression that
  // dropped the `run_at >= now() - window` filter would still pass on a
  // dev DB that happens to have no stale 'error' rows.
  await insertRun(activeCompanyId, TOOL_STALE_BROKEN, "error", stale1, "ancient");
  // Stale recovered — both runs outside window. The recovery helper's
  // `r.run_at >= now() - window` filter (applied to the recovery row's
  // run_at) must drop this. err first, ok second so LAG sees the right
  // pairing if the helper ever loses the recency filter.
  await insertRun(activeCompanyId, TOOL_STALE_RECOVERED, "error", stale2, "older");
  await insertRun(activeCompanyId, TOOL_STALE_RECOVERED, "ok",    stale1, null);
  // Always-ok — only an ok run with no prior error. The recovery helper's
  // `prev_status = 'error'` guard must drop it (LAG returns NULL for the
  // first row in the window). Errors helper trivially excludes it
  // (status<>'error').
  await insertRun(activeCompanyId, TOOL_ALWAYS_OK, "ok", inWin1, null);

  // ── Rejected company seed ───────────────────────────────────────────────
  // Both rows MUST be filtered out by the `c.status = 'active'` join clause
  // shared by all four helpers. Without this seed a regression that dropped
  // the active-only filter from the COUNT helper (but not the row helper,
  // or vice-versa) could go undetected on a dev DB whose only rejected
  // companies have no maintenance_runs at all.
  await insertRun(rejectedCompanyId, TOOL_REJECTED_BROKEN, "error", inWin1, "rejected co");
  await insertRun(rejectedCompanyId, TOOL_REJECTED_RECOVERED, "error", inWin3, "rejected co");
  await insertRun(rejectedCompanyId, TOOL_REJECTED_RECOVERED, "ok",    inWin1, null);
});

after(async () => {
  try {
    if (insertedRunIds.length) {
      await db
        .delete(maintenanceRunsTable)
        .where(inArray(maintenanceRunsTable.id, insertedRunIds));
    }
    if (insertedCompanyIds.length) {
      await db
        .delete(companiesTable)
        .where(inArray(companiesTable.id, insertedCompanyIds));
    }
  } finally {
    await pool.end();
  }
});

// ─── Sanity helper ──────────────────────────────────────────────────────────
// Keys uniquely identify a (companyId, toolKey) pair across both helpers'
// projections (recovery rows omit the maintenance_runs PK by design — see
// the helper's comment around L944-L949).
const key = (r: { companyId: number; toolKey: string }): string =>
  `${r.companyId}|${r.toolKey}`;

// ════════════════════════════════════════════════════════════════════════════
//  Errors helper: COUNT must agree with row count under a generous limit
// ════════════════════════════════════════════════════════════════════════════
test("countRecentToolErrors agrees with getRecentToolErrors row count after seeding all error-helper boundary cases", async () => {
  const rows  = await getRecentToolErrors(VERY_HIGH_LIMIT, TOOL_ERROR_WINDOW_DAYS);
  const total = await countRecentToolErrors(TOOL_ERROR_WINDOW_DAYS);

  // ── Sanity: our seed actually exercised the boundaries the equality
  //    is supposed to defend. Without these the headline assertion could
  //    pass vacuously (e.g. helper got an unrelated bug that drops every
  //    row, leaving 0 === 0).
  const ourActiveKeys = new Set(
    rows
      .filter((r) => r.companyId === activeCompanyId)
      .map((r) => r.toolKey),
  );
  assert.ok(
    ourActiveKeys.has(TOOL_BROKEN),
    `seeded still-broken tool ${TOOL_BROKEN} must be returned by the errors helper — sanity check for the COUNT-vs-rows assertion below`,
  );
  assert.ok(
    ourActiveKeys.has(TOOL_REBROKEN),
    `seeded re-broken tool ${TOOL_REBROKEN} must be returned by the errors helper (latest run is 'error') — sanity check for the COUNT-vs-rows assertion below`,
  );
  // Boundaries that MUST stay out of the errors helper. Each one would
  // expand the row-helper's projection if its filter were dropped — and the
  // COUNT helper would only follow if its WHERE clause is kept in sync.
  for (const excludedKey of [
    `${activeCompanyId}|${TOOL_REC_OK}`,           // latest=ok          → DISTINCT ON / latest projection
    `${activeCompanyId}|${TOOL_REC_WARN}`,         // latest=warn        → status='error' guard
    `${activeCompanyId}|${TOOL_STALE_BROKEN}`,     // outside window     → recency filter
    `${activeCompanyId}|${TOOL_STALE_RECOVERED}`,  // outside window
    `${activeCompanyId}|${TOOL_ALWAYS_OK}`,        // never errored
    `${rejectedCompanyId}|${TOOL_REJECTED_BROKEN}`,    // active-only company filter
    `${rejectedCompanyId}|${TOOL_REJECTED_RECOVERED}`, // active-only company filter
  ]) {
    assert.ok(
      !rows.some((r) => key(r) === excludedKey),
      `seeded boundary case ${excludedKey} must NOT appear in the errors helper — sanity check for the COUNT-vs-rows assertion below`,
    );
  }

  // ── Headline contract: the two helpers must agree row-for-row. A future
  //    refactor that tweaks the WHERE clause of one but not the other would
  //    flip this equality, telling SuperAdmins reviewing past audit rows
  //    that "real total = N" is now misleading.
  assert.equal(typeof total, "number", "count helper must return a number");
  assert.ok(Number.isFinite(total), `count helper must return a finite number, got ${total}`);
  assert.equal(
    total, rows.length,
    `countRecentToolErrors (${total}) must match getRecentToolErrors(${VERY_HIGH_LIMIT}).length (${rows.length}) — a divergence here would silently corrupt the "real underlying total" the SuperAdmin CSV-export audit row records when the broken-tools download gets clipped.`,
  );
});

// ════════════════════════════════════════════════════════════════════════════
//  Recoveries helper: COUNT must agree with row count under a generous limit
// ════════════════════════════════════════════════════════════════════════════
test("countRecentToolRecoveries agrees with getRecentToolRecoveries row count after seeding all recovery-helper boundary cases", async () => {
  const rows  = await getRecentToolRecoveries(VERY_HIGH_LIMIT, TOOL_ERROR_WINDOW_DAYS);
  const total = await countRecentToolRecoveries(TOOL_ERROR_WINDOW_DAYS);

  // ── Sanity: the recovery-side boundaries are present in the row helper's
  //    output, so the equality below is forced through them rather than
  //    passing vacuously on whatever the dev DB happens to contain.
  const ourActiveKeys = new Set(
    rows
      .filter((r) => r.companyId === activeCompanyId)
      .map((r) => r.toolKey),
  );
  assert.ok(
    ourActiveKeys.has(TOOL_REC_OK),
    `seeded recovered-to-ok tool ${TOOL_REC_OK} must be returned by the recoveries helper — sanity check for the COUNT-vs-rows assertion below`,
  );
  assert.ok(
    ourActiveKeys.has(TOOL_REC_WARN),
    `seeded recovered-to-warn tool ${TOOL_REC_WARN} must be returned by the recoveries helper — sanity check for the COUNT-vs-rows assertion below`,
  );
  // Boundaries that MUST stay out of the recoveries helper.
  for (const excludedKey of [
    `${activeCompanyId}|${TOOL_BROKEN}`,           // never recovered
    `${activeCompanyId}|${TOOL_REBROKEN}`,         // re-broken — task #113 boundary
    `${activeCompanyId}|${TOOL_STALE_BROKEN}`,     // never recovered + outside window
    `${activeCompanyId}|${TOOL_STALE_RECOVERED}`,  // recovery outside window
    `${activeCompanyId}|${TOOL_ALWAYS_OK}`,        // no prior error
    `${rejectedCompanyId}|${TOOL_REJECTED_BROKEN}`,    // active-only company filter
    `${rejectedCompanyId}|${TOOL_REJECTED_RECOVERED}`, // active-only company filter
  ]) {
    assert.ok(
      !rows.some((r) => key(r) === excludedKey),
      `seeded boundary case ${excludedKey} must NOT appear in the recoveries helper — sanity check for the COUNT-vs-rows assertion below`,
    );
  }

  // ── Headline contract.
  assert.equal(typeof total, "number", "count helper must return a number");
  assert.ok(Number.isFinite(total), `count helper must return a finite number, got ${total}`);
  assert.equal(
    total, rows.length,
    `countRecentToolRecoveries (${total}) must match getRecentToolRecoveries(${VERY_HIGH_LIMIT}).length (${rows.length}) — a divergence here would silently corrupt the "real underlying total" the SuperAdmin CSV-export audit row records when the recovered-tools download gets clipped.`,
  );
});
