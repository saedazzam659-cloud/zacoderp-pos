// E2E test for the SuperAdmin AI Company Fix page (/admin/ai-fix in the
// zatca-invoicing artifact) — locks down the green "أدوات صيانة تعافت"
// recovered-tools panel's "آخر تحديث: HH:MM:SS" timestamp, plus the matching
// timestamps on its two sibling panels (red critical-alerts, amber broken-
// tools). Task #102.
//
// Why this test exists:
//   The three sibling panels (red criticals, amber broken-tool, green
//   recoveries) all carry an "آخر تحديث: …" badge sourced from
//   `<query>.dataUpdatedAt > 0`. The recovered-tool badge was the most
//   recently added of the three (data-testid="recovery-summary-last-updated"
//   in AICompanyFix.tsx around line 1971). There was no automated UI test
//   guarding that this badge actually renders once data loads, so a future
//   refactor that drops the `dataUpdatedAt > 0` guard or removes the span
//   could regress the three-panel visual consistency unnoticed.
//
//   The auto-refresh siblings (critical-alerts-auto-refresh.spec.ts /
//   broken-tools-auto-refresh.spec.ts) already check the timestamp ADVANCES
//   on the polling tick — they do not check what the timestamp looks like
//   on first paint, and they don't surface the recovered-tool panel at all.
//   This spec covers the gap by asserting all three badges:
//     - render once their data loads,
//     - carry a colon-separated time string (matches the
//       toLocaleTimeString("ar-SA") output the panels use),
//     - are scoped to the right panel container (so a refactor that moves
//       a badge into the wrong panel is also caught).
//
// What this verifies (mirrors the regression task acceptance criteria):
//   1. With a seeded recovery scenario in the DB, the green panel renders
//      and its data-testid="recovery-summary-last-updated" element is
//      visible AND contains a colon (the locale time format the panel
//      uses always emits HH:MM:SS for "ar-SA").
//   2. Under the same conditions, both sibling timestamps
//      (critical-summary-last-updated, error-summary-last-updated) also
//      render with a colon-separated time string — locking down the
//      three-panel consistency together.
//   3. Each timestamp lives inside its OWN panel container (asserted via a
//      panel-scoped locator), so a refactor that moves one into the wrong
//      colour is caught.
//
// Determinism story:
//   - We seed a brand-new `companies` row tagged with a per-run TEST_TAG so
//     none of the seeded maintenance rows collide with whatever else lives
//     in the shared dev DB.
//   - Three distinct tool keys on that one company drive the three panels:
//       * RECOVERY_TOOL_KEY   — error 3d ago + ok 1d ago → recovery panel
//       * ERROR_TOOL_KEY      — error now              → broken-tool panel
//       * CRITICAL_TOOL_KEY   — critical now           → critical panel
//     All three keys carry the full TEST_TAG so panel-row assertions
//     pinpoint our seeds without depending on overall row counts (the dev
//     DB may already have other criticals/errors/recoveries on the page).
//   - The SuperAdmin auth short-circuit (insert sa_sessions row + write
//     localStorage zatca_token + zatca_session='sa-<id>') matches what the
//     login flow itself produces, so /api/auth/me returns the SuperAdmin
//     and the AICompanyFix route guard renders.
//
// Cleanup:
//   - Strict-by-PK: we record every inserted row id (maintenance_runs,
//     companies, sa_sessions) and delete by `eq`/`inArray` in the afterAll
//     hook. No LIKE / wildcards on production tables; a crashed run never
//     touches another tenant's data.
//   - We deliberately do NOT call `pool.end()` — see the matching note in
//     email-history-pagination.spec.ts. With workers=1, sibling specs share
//     the singleton pool exported by `@workspace/db`.
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
const TEST_TAG = `e2e_task102_${randomBytes(4).toString("hex")}`;
// One tool key per panel so each panel surfaces our seed independently of
// whatever else lives in the shared dev DB. All three carry the full
// TEST_TAG so assertions can pinpoint our rows without row-count math.
const RECOVERY_TOOL_KEY = `${TEST_TAG}_recovered_tool`;
const ERROR_TOOL_KEY    = `${TEST_TAG}_broken_tool`;
const CRITICAL_TOOL_KEY = `${TEST_TAG}_critical_tool`;
// Header text each panel renders (AICompanyFix.tsx around lines 1782 /
// 1861 / 1962). The recovery and error headers are matched as a prefix
// only because the same line interpolates the window length
// ("آخر 7 أيام") which we don't want to hard-code here.
const CRITICAL_HEADER          = "تنبيهات حرجة حالياً";
const ERROR_HEADER_PREFIX      = "أدوات صيانة تعطّلت آخر";
const RECOVERY_HEADER_PREFIX   = "أدوات صيانة تعافت آخر";

let saSessionRowId: number | null = null;
let saSessionToken: string | null = null;
let testCompanyId:   number | null = null;
const seededRunIds: number[] = [];

// ─── Setup: create company, sa_session, and rows for all three panels ──────
test.beforeAll(async () => {
  // Sweep any debris from a previous interrupted run before seeding. All
  // three patterns are namespaced strictly to this test (the maintenance
  // runs tag the toolKey column, the sa_sessions tag sessionToken, the
  // companies tag nameAr), so this can never touch real audit history,
  // real user sessions, or real tenant rows.
  await db
    .delete(maintenanceRunsTable)
    .where(like(maintenanceRunsTable.toolKey, "e2e_task102_%"));
  await db
    .delete(superAdminSessionsTable)
    .where(like(superAdminSessionsTable.sessionToken, "e2e_task102_%"));
  await db
    .delete(companiesTable)
    .where(like(companiesTable.nameAr, "e2e_task102_%"));

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
  saSessionToken = "e2e_task102_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task102",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  // Active test company so the seeded maintenance rows are visible to
  // getRecentToolRecoveries / getRecentToolErrors / getCriticalAlerts
  // (each joins `companies` and filters status='active'). The Arabic name
  // carries TEST_TAG so the on-page row text can be uniquely matched.
  const [co] = await db
    .insert(companiesTable)
    .values({
      nameAr:         `${TEST_TAG} شركة الاختبار للطوابع الزمنية`,
      nameEn:         `${TEST_TAG} Test Co Timestamps`,
      vatNumber:      "300000000000102",
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

  const now = Date.now();

  // Recovery scenario for the green panel: an 'error' row 3 days ago
  // followed by an 'ok' row 1 day ago. The LAG window function in
  // getRecentToolRecoveries pairs them, sees status='ok' with prev_status
  // ='error', and surfaces the (company, tool) pair. Both timestamps sit
  // comfortably inside the 7-day TOOL_ERROR_WINDOW_DAYS window.
  const recoveryErrRow = await db
    .insert(maintenanceRunsTable)
    .values({
      companyId:  testCompanyId,
      toolKey:    RECOVERY_TOOL_KEY,
      status:     "error",
      count:      0,
      trigger:    "scheduled",
      runAt:      new Date(now - 3 * 86_400_000),
      durationMs: 1,
      error:      "boom from task #102 e2e",
      details:    null,
    })
    .returning({ id: maintenanceRunsTable.id });
  const recoveryOkRow = await db
    .insert(maintenanceRunsTable)
    .values({
      companyId:  testCompanyId,
      toolKey:    RECOVERY_TOOL_KEY,
      status:     "ok",
      count:      0,
      trigger:    "scheduled",
      runAt:      new Date(now - 1 * 86_400_000),
      durationMs: 1,
      error:      null,
      details:    null,
    })
    .returning({ id: maintenanceRunsTable.id });
  // Broken-tool row for the amber panel: latest run is 'error' inside the
  // 7-day window, no follow-up success — getRecentToolErrors picks this up.
  // runAt set to "now" so this row outranks anything older for the same
  // (company, tool) pair on the top-50 cap.
  const brokenRow = await db
    .insert(maintenanceRunsTable)
    .values({
      companyId:  testCompanyId,
      toolKey:    ERROR_TOOL_KEY,
      status:     "error",
      count:      0,
      trigger:    "scheduled",
      runAt:      new Date(now),
      durationMs: 1,
      error:      `boom (broken) from task #102 e2e ${TEST_TAG}`,
      details:    null,
    })
    .returning({ id: maintenanceRunsTable.id });
  // Critical-alert row for the red panel: latest run is 'critical' — the
  // per-(company, tool) latest projection in getCriticalAlerts will pick
  // this up and the panel should render it on first paint.
  const criticalRow = await db
    .insert(maintenanceRunsTable)
    .values({
      companyId:  testCompanyId,
      toolKey:    CRITICAL_TOOL_KEY,
      status:     "critical",
      count:      5,
      trigger:    "scheduled",
      runAt:      new Date(now),
      durationMs: 1,
      error:      null,
      details:    null,
    })
    .returning({ id: maintenanceRunsTable.id });
  seededRunIds.push(
    recoveryErrRow[0].id,
    recoveryOkRow[0].id,
    brokenRow[0].id,
    criticalRow[0].id,
  );
});

// ─── Cleanup: strict-by-PK so a crash never nukes unrelated audit history ──
// We deliberately do NOT call `pool.end()` — see the matching note in
// email-history-pagination.spec.ts.
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

// "ar-SA" toLocaleTimeString output always carries colons between H/M/S
// (the locale uses Arabic-Indic digits but ASCII colons as the time
// separator). Asserting on a literal ":" is the most stable way to check
// "this looks like a clock-style timestamp" without hard-coding the
// digit shapes the locale chooses.
const TIME_SEPARATOR = ":";

test("recovered-tools panel: 'آخر تحديث' timestamp renders alongside its critical/broken siblings on first paint", async ({ page }) => {
  await installSuperAdminSession(page);
  await page.goto("/admin/ai-fix", { waitUntil: "networkidle" });

  // Wait for the SPA to mount the AICompanyFix page first so the panel and
  // timestamp locators below resolve against the rendered DOM and not the
  // loading shell.
  await expect(page.getByRole("heading", { name: PAGE_HEADING_RE })).toBeVisible();

  // ─── Locators scoped to each coloured panel ──────────────────────────────
  // We anchor on each panel's unique colour border class
  // (border-red-200 / border-amber-200 / border-emerald-200 in
  // AICompanyFix.tsx around lines 1778, 1857, 1958) AND its Arabic header
  // text. Both filters are needed:
  //   - The class alone isn't unique on the page (other red/amber accents
  //     exist), so we layer the header text on top.
  //   - The header text alone matches any ancestor div that *contains*
  //     the header somewhere inside (because `hasText` is recursive),
  //     which would let the timestamp-scope assertion weaken to "the
  //     testid is somewhere on the page" instead of "the testid is
  //     inside the right panel". Pinning to the panel's own border-*
  //     class collapses the locator to the single root div the panel
  //     renders into.
  const criticalPanel = page.locator("div.border-red-200")
    .filter({ hasText: CRITICAL_HEADER });
  const errorPanel = page.locator("div.border-amber-200")
    .filter({ hasText: ERROR_HEADER_PREFIX });
  const recoveryPanel = page.locator("div.border-emerald-200")
    .filter({ hasText: RECOVERY_HEADER_PREFIX });

  // All three panels must be visible — proves the seeded scenarios reached
  // the page before we assert on per-panel timestamps. If a panel was
  // hidden because its query returned zero items, the timestamp inside
  // would never render either and the assertion below would fail with
  // a more confusing message ("element not found") than this one.
  await expect(criticalPanel).toBeVisible();
  await expect(errorPanel).toBeVisible();
  await expect(recoveryPanel).toBeVisible();

  // The seeded rows must actually be in each panel — proves we're looking
  // at our own data, not pre-existing dev-DB rows that happened to render.
  await expect(criticalPanel.locator("tbody tr", { hasText: CRITICAL_TOOL_KEY })).toHaveCount(1);
  await expect(errorPanel.locator("tbody tr", { hasText: ERROR_TOOL_KEY })).toHaveCount(1);
  await expect(recoveryPanel.locator("tbody tr", { hasText: RECOVERY_TOOL_KEY })).toHaveCount(1);

  // ─── Timestamp lock-down — the contract this task is protecting ──────────
  // For each panel, the data-testid hook must be visible AND its rendered
  // text must contain a colon. The colon check matches the
  // toLocaleTimeString("ar-SA") output the panels use (HH:MM:SS); a
  // refactor that drops the time and leaves a date-only label, or removes
  // the timestamp entirely, would fail this assertion.
  //
  // Each timestamp is queried THROUGH its panel locator so a regression
  // that moves the badge into the wrong colour (e.g. swaps the recovery
  // testid into the critical panel) is also caught — the testid would
  // exist on the page but not inside its expected panel.

  // Recovery panel — the testid the task explicitly calls out. This is
  // the primary contract being locked down; the other two are protected
  // alongside it for sibling consistency (per the task's "ideally also
  // asserts the sibling timestamps" line).
  const recoveryTimestamp = recoveryPanel.locator(
    '[data-testid="recovery-summary-last-updated"]',
  );
  await expect(recoveryTimestamp).toBeVisible();
  const recoveryText = (await recoveryTimestamp.textContent())?.trim() ?? "";
  expect(recoveryText.length).toBeGreaterThan(0);
  expect(recoveryText).toContain("آخر تحديث");
  expect(recoveryText).toContain(TIME_SEPARATOR);

  // Critical-alerts panel sibling.
  const criticalTimestamp = criticalPanel.locator(
    '[data-testid="critical-summary-last-updated"]',
  );
  await expect(criticalTimestamp).toBeVisible();
  const criticalText = (await criticalTimestamp.textContent())?.trim() ?? "";
  expect(criticalText.length).toBeGreaterThan(0);
  expect(criticalText).toContain("آخر تحديث");
  expect(criticalText).toContain(TIME_SEPARATOR);

  // Broken-tool panel sibling.
  const errorTimestamp = errorPanel.locator(
    '[data-testid="error-summary-last-updated"]',
  );
  await expect(errorTimestamp).toBeVisible();
  const errorText = (await errorTimestamp.textContent())?.trim() ?? "";
  expect(errorText.length).toBeGreaterThan(0);
  expect(errorText).toContain("آخر تحديث");
  expect(errorText).toContain(TIME_SEPARATOR);
});
