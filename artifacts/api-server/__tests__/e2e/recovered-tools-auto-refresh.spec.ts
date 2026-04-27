// E2E test for the SuperAdmin green "أدوات صيانة تعافت" recovered-tools panel
// auto-refresh on /admin/ai-fix in the zatca-invoicing artifact (task #108).
//
// What this verifies (mirrors the regression task acceptance criteria):
//   1. The "آخر تحديث: …" timestamp surfaced via
//      data-testid="recovery-summary-last-updated" advances on its own (no
//      reload, no user interaction) after the configured polling interval —
//      proving `recoverySummaryQ` keeps `refetchInterval: MAINTENANCE_PANEL_
//      REFETCH_MS` (30s).
//   2. A NEW recovery scenario (an error → ok pair) inserted into the DB
//      for a fresh (company, tool) pair while the page is open appears in
//      the panel without a manual reload — proving the background refetch
//      actually fetches fresh data and the UI re-renders against it.
//      Combined with (1), this catches the silent regression the task is
//      worried about (someone drops the refetchInterval and the panel
//      goes stale).
//
// This is the green sibling of critical-alerts-auto-refresh.spec.ts (task
// #83) and broken-tools-auto-refresh.spec.ts (task #96). The first-paint
// render contract for the recovered-tool timestamp is already covered by
// recovery-summary-timestamp.spec.ts (task #102) — this spec exists to
// lock down the polling behaviour that first-paint tests can't observe.
//
// Determinism story:
//   - We seed a brand-new `companies` row tagged with a per-run TEST_TAG so
//     the seeded recoveries never collide with whatever else lives in the
//     shared dev DB.
//   - Both seeded tool keys carry the full TEST_TAG so panel-row assertions
//     pinpoint our seeds without relying on overall row counts (the dev DB
//     may already have other recoveries on the page).
//   - A recovery is surfaced by `getRecentToolRecoveries` only when the
//     LATEST run for a (company, tool) pair is non-error AND the previous
//     run was 'error' AND the latest run sits inside the 7-day
//     TOOL_ERROR_WINDOW_DAYS window. So for each tool key we insert TWO
//     rows: an older 'error' followed by a newer 'ok'. The 'ok' rows are
//     stamped at "now" so they comfortably outrank anything pre-existing
//     for the same (company, tool) pair on the LIMIT-50 cap, and the
//     paired 'error' rows are backdated 1 day so the LAG window function
//     pairs them as (prev='error', curr='ok').
//   - The SuperAdmin auth short-circuit (insert sa_sessions row + write
//     localStorage zatca_token + zatca_session='sa-<id>') matches what the
//     login flow itself produces, so /api/auth/me returns the SuperAdmin
//     and the AICompanyFix route guard renders.
//   - We give this single spec a generous timeout (`test.setTimeout`)
//     because we have to wait for at least one real polling tick (30s in
//     AICompanyFix.tsx) plus assertion buffers. The default 60s in
//     playwright.config.ts is borderline — explicit override here makes
//     the intent obvious to anyone tuning timeouts later.
//
// Cleanup:
//   - Strict-by-PK: we record every inserted row id (maintenance_runs,
//     companies, sa_sessions) and delete by `eq`/`inArray` in the afterAll
//     hook. No LIKE / wildcards on production tables; a crashed run never
//     touches another tenant's data.
//   - We deliberately do NOT call `pool.end()` — see the matching note in
//     critical-alerts-auto-refresh.spec.ts. With workers=1, sibling specs
//     share the singleton pool exported by `@workspace/db`.
//
// How to run:
//   1. Ensure the api-server and zatca-invoicing dev workflows are running.
//   2. `pnpm --filter @workspace/api-server run test:e2e`

import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import {
  db,
  usersTable,
  companiesTable,
  maintenanceRunsTable,
  superAdminSessionsTable,
} from "@workspace/db";

// ─── Fixtures / state shared across the single test in this file ───────────
const TEST_TAG = `e2e_task108_${randomBytes(4).toString("hex")}`;
// Two distinct tool keys on the same seeded company exercise the per-
// (company, tool) latest projection in `getRecentToolRecoveries` (artifacts/
// api-server/src/lib/maintenanceScheduler.ts ~L888). TOOL_KEY_A is seeded
// BEFORE the page loads so the panel shows up on first paint; TOOL_KEY_B
// is inserted DURING the test to verify the background refetch surfaces
// newly recovered tools without a manual reload.
const TOOL_KEY_A = `${TEST_TAG}_recovered_a`;
const TOOL_KEY_B = `${TEST_TAG}_recovered_b`;
// Header text the green recovery panel renders (AICompanyFix.tsx around
// line 1969). Matched as a prefix only because the same line interpolates
// the window length ("آخر 7 أيام") which we don't want to hard-code here.
const PANEL_HEADER_PREFIX = "أدوات صيانة تعافت آخر";

let saSessionRowId: number | null = null;
let saSessionToken: string | null = null;
let testCompanyId: number | null = null;
const seededRunIds: number[] = [];

// ─── Setup: create company, sa_session, and the first recovery scenario ────
test.beforeAll(async () => {
  // Sweep any debris from a previous interrupted run before seeding. All
  // three patterns are namespaced strictly to this test (the maintenance
  // runs tag the toolKey column, the sa_sessions tag sessionToken, the
  // companies tag nameAr), so this can never touch real audit history,
  // real user sessions, or real tenant rows.
  await db
    .delete(maintenanceRunsTable)
    .where(like(maintenanceRunsTable.toolKey, "e2e_task108_%"));
  await db
    .delete(superAdminSessionsTable)
    .where(like(superAdminSessionsTable.sessionToken, "e2e_task108_%"));
  await db
    .delete(companiesTable)
    .where(like(companiesTable.nameAr, "e2e_task108_%"));

  const [sa] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.role, "superadmin"))
    .limit(1);
  if (!sa) {
    throw new Error(
      "No superadmin user exists in the DB; create one before running the E2E suite.",
    );
  }

  // Random-token sa_sessions row drives auth without going through the real
  // multi-factor login. resolveBearerToken() in artifacts/api-server/src/
  // middleware/auth.ts accepts this token and returns sessionId='sa-<id>',
  // matching what /api/auth/me will emit.
  saSessionToken = "e2e_task108_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task108",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  // Active test company so it's visible to getRecentToolRecoveries (which
  // joins `companies` and filters status='active'). The Arabic name carries
  // TEST_TAG so the on-page row text can be uniquely matched.
  const [co] = await db
    .insert(companiesTable)
    .values({
      nameAr:         `${TEST_TAG} شركة الاختبار للأدوات المتعافية`,
      nameEn:         `${TEST_TAG} Test Co Recovery Refresh`,
      vatNumber:      "300000000000108",
      crNumber:       `CR_${TEST_TAG}`,
      city:           "Riyadh",
      street:         "Test St",
      buildingNumber: "1",
      postalCode:     "12345",
      country:        "SA",
      invoiceType:    "both",
      status:         "active",
    })
    .returning({ id: companiesTable.id });
  testCompanyId = co.id;

  // First recovery scenario — TOOL_KEY_A. The LAG window function in
  // `getRecentToolRecoveries` pairs runs by run_at within (company_id,
  // tool_key); we need the LATEST run to be 'ok' AND the prior run to be
  // 'error', AND the 'ok' run to sit inside TOOL_ERROR_WINDOW_DAYS (7d).
  // We backdate the error 1 day and stamp the ok at "now" so the pair
  // satisfies the projection AND the 'ok' outranks anything older for the
  // same pair on the LIMIT-50 cap (matching the determinism story used by
  // the broken-tool / critical-alerts auto-refresh templates).
  const now = Date.now();
  const aErr = await db
    .insert(maintenanceRunsTable)
    .values({
      companyId:  testCompanyId,
      toolKey:    TOOL_KEY_A,
      status:     "error",
      count:      0,
      trigger:    "scheduled",
      runAt:      new Date(now - 86_400_000),
      durationMs: 1,
      error:      `boom A from task #108 e2e ${TEST_TAG}`,
      details:    null,
    })
    .returning({ id: maintenanceRunsTable.id });
  const aOk = await db
    .insert(maintenanceRunsTable)
    .values({
      companyId:  testCompanyId,
      toolKey:    TOOL_KEY_A,
      status:     "ok",
      count:      0,
      trigger:    "scheduled",
      runAt:      new Date(now),
      durationMs: 1,
      error:      null,
      details:    null,
    })
    .returning({ id: maintenanceRunsTable.id });
  seededRunIds.push(aErr[0].id, aOk[0].id);
});

// ─── Cleanup: strict-by-PK so a crash never nukes unrelated audit history ──
// We deliberately do NOT call `pool.end()` — see the matching note in
// critical-alerts-auto-refresh.spec.ts.
test.afterAll(async () => {
  if (seededRunIds.length) {
    await db
      .delete(maintenanceRunsTable)
      .where(inArray(maintenanceRunsTable.id, seededRunIds));
  }
  if (testCompanyId !== null) {
    await db
      .delete(companiesTable)
      .where(eq(companiesTable.id, testCompanyId));
  }
  if (saSessionRowId !== null) {
    await db
      .delete(superAdminSessionsTable)
      .where(eq(superAdminSessionsTable.id, saSessionRowId));
  }
});

// Inject the SuperAdmin session into localStorage *before* the SPA mounts so
// AuthContext.checkSession() finds the token on first paint and AICompanyFix
// renders without us having to drive the login form. The session id format
// (`sa-<row id>`) matches what resolveBearerToken returns from /api/auth/me,
// so the single-session check inside checkSession passes.
async function installSuperAdminSession(page: Page): Promise<void> {
  await page.addInitScript(
    ({ token, sessionId }) => {
      localStorage.setItem("zatca_token", token);
      localStorage.setItem("zatca_session", sessionId);
    },
    { token: saSessionToken!, sessionId: `sa-${saSessionRowId!}` },
  );
}

// Stable anchor for the SuperAdmin AI Company Fix page so we can wait for
// the SPA to settle on the right route before asserting panel visibility.
const PAGE_HEADING_RE = /إصلاح مشاكل الشركات بالذكاء الاصطناعي/;

test("recovered-tools panel auto-refresh: timestamp advances and a newly recovered tool appears without reload", async ({ page }) => {
  // Allow ~90s — we need a full polling tick (30s configured in
  // AICompanyFix.tsx, MAINTENANCE_PANEL_REFETCH_MS) plus first-paint and
  // assertion buffers. The 60s default in playwright.config.ts is too
  // tight to give the second refetch a comfortable margin.
  test.setTimeout(90_000);

  await installSuperAdminSession(page);
  await page.goto("/admin/ai-fix", { waitUntil: "networkidle" });

  // Wait for the SPA to mount the AICompanyFix page first so panel and
  // timestamp locators below resolve against the rendered DOM and not the
  // loading shell.
  await expect(page.getByRole("heading", { name: PAGE_HEADING_RE })).toBeVisible();

  // Locator scoped to the green recovery panel via its unique border
  // colour AND header text. Anchoring on `border-emerald-200` collapses
  // the locator to the single panel root (mirrors the panel-scoping done
  // in recovery-summary-timestamp.spec.ts), and layering the Arabic
  // header keeps the scope explicit if a future refactor reuses the
  // colour elsewhere on the page.
  const panel = page.locator("div.border-emerald-200")
    .filter({ hasText: PANEL_HEADER_PREFIX });
  await expect(panel).toBeVisible();

  // The seeded TOOL_KEY_A row must be visible — proves the panel renders
  // the recovery projection on first paint, not just the header. We anchor
  // on the unique TOOL_KEY_A so the dev DB's own recoveries (which
  // legitimately may already exist) don't confuse the assertion.
  const rowA = panel.locator("tbody tr", { hasText: TOOL_KEY_A });
  await expect(rowA).toHaveCount(1);

  // Capture the initial "آخر تحديث: HH:MM:SS" text. The data-testid hook
  // is the contract the task explicitly calls out, and `dataUpdatedAt`
  // is sourced from TanStack Query so the rendered time advances on
  // every successful refetch.
  const timestamp = panel.locator('[data-testid="recovery-summary-last-updated"]');
  await expect(timestamp).toBeVisible();
  const initialTimestampText = (await timestamp.textContent())?.trim() ?? "";
  expect(initialTimestampText.length).toBeGreaterThan(0);
  // Sanity check: the rendered prefix is "آخر تحديث:" — if a future
  // refactor changes the label, this assertion catches it before we hang
  // on the "did the time change?" poll below.
  expect(initialTimestampText).toContain("آخر تحديث");

  // While the page is open, raise a NEW recovery scenario for a different
  // tool key on the same company. This must surface in the panel without
  // a manual reload — that's the auto-refresh behaviour the task is
  // protecting. Inserted AFTER capturing the initial timestamp so the
  // poll below can fail fast if the panel never refetches.
  //
  // Two rows are needed (error → ok pair) because that's what the LAG
  // window function in getRecentToolRecoveries pairs to detect a
  // recovery — a single 'ok' on a fresh tool key would have prev_status
  // = NULL and never surface. The 'error' is backdated 1 day; the 'ok'
  // is stamped at "now" so it outranks anything pre-existing for the
  // same (company, tool) pair on the LIMIT-50 cap.
  const tickNow = Date.now();
  const bErr = await db
    .insert(maintenanceRunsTable)
    .values({
      companyId:  testCompanyId!,
      toolKey:    TOOL_KEY_B,
      status:     "error",
      count:      0,
      trigger:    "scheduled",
      runAt:      new Date(tickNow - 86_400_000),
      durationMs: 1,
      error:      `boom B from task #108 e2e ${TEST_TAG}`,
      details:    null,
    })
    .returning({ id: maintenanceRunsTable.id });
  const bOk = await db
    .insert(maintenanceRunsTable)
    .values({
      companyId:  testCompanyId!,
      toolKey:    TOOL_KEY_B,
      status:     "ok",
      count:      0,
      trigger:    "scheduled",
      runAt:      new Date(tickNow),
      durationMs: 1,
      error:      null,
      details:    null,
    })
    .returning({ id: maintenanceRunsTable.id });
  seededRunIds.push(bErr[0].id, bOk[0].id);

  // Wait for the next polling tick (configured at 30s) to bring the new
  // recovery into view. We give 60s — comfortably more than one tick —
  // so a momentarily-slow fetch doesn't fail the spec, but well under
  // the 90s test budget. If `refetchInterval` was silently dropped, this
  // poll would hit its timeout and the test would fail with "expected 1,
  // received 0" — exactly the regression the task is worried about.
  const rowB = panel.locator("tbody tr", { hasText: TOOL_KEY_B });
  await expect(rowB).toHaveCount(1, { timeout: 60_000 });

  // Sanity: the original row is still there too — the refetch should have
  // appended TOOL_KEY_B alongside TOOL_KEY_A, not replaced one with the
  // other. This catches a subtle regression where a refetch wipes prior
  // state mid-render.
  await expect(rowA).toHaveCount(1);

  // After a successful refetch, dataUpdatedAt must change, so the rendered
  // toLocaleTimeString("ar-SA") string in the timestamp span must differ
  // from what we captured before raising TOOL_KEY_B. Polling instead of a
  // single read because the timestamp text and the new row are updated by
  // separate React renders — the row may flash in slightly before the
  // span re-renders depending on scheduling. Polling keeps the assertion
  // robust without admitting flakiness in either direction.
  await expect
    .poll(
      async () => ((await timestamp.textContent()) ?? "").trim(),
      { timeout: 15_000 },
    )
    .not.toBe(initialTimestampText);
});
