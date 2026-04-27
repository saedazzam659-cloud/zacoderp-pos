// E2E test for the SuperAdmin /admin/ai-fix panel boundary on the
// zatca-invoicing artifact (task #113).
//
// What this verifies:
//   The two helpers behind the page — `getRecentToolErrors` (amber broken-
//   tool panel) and `getRecentToolRecoveries` (green recovered-tool panel)
//   in artifacts/api-server/src/lib/maintenanceScheduler.ts — are
//   *mutually exclusive*: a (company, tool_key) pair appears in at most
//   one panel at a time. The recoveries helper enforces this with
//   `r.rn = 1 AND r.status <> 'error'` (the LATEST run for the pair must
//   be non-error); a re-broken tool whose latest run is 'error' must
//   instead be routed to the broken-tool helper.
//
//   The three sibling specs already in this directory each seed scenarios
//   that land in exactly one panel — none of them seed an
//   error → ok → error sequence, so a future refactor of the LAG /
//   ROW_NUMBER guards in `getRecentToolRecoveries` could quietly let a
//   re-broken pair appear in BOTH panels and we wouldn't notice until an
//   operator complained about a duplicated row. This spec locks that
//   boundary down.
//
// Sibling specs:
//   - broken-tools-auto-refresh.spec.ts (task #96): amber-panel polling +
//     panel-locator pattern reused here.
//   - recovered-tools-auto-refresh.spec.ts (task #108): green-panel
//     polling + tagging / cleanup template reused here.
//   - recovery-summary-timestamp.spec.ts (task #102): first-paint
//     timestamp render contract for the green panel.
//
// Determinism story:
//   - We seed a brand-new `companies` row tagged with a per-run TEST_TAG
//     so the seeded rows never collide with whatever else lives in the
//     shared dev DB.
//   - The single seeded TOOL_KEY carries the full TEST_TAG so panel-row
//     assertions pinpoint our seed without relying on overall row counts
//     (the dev DB may already have other broken / recovered tools on the
//     page legitimately).
//   - We insert THREE rows for the same (company, tool_key) pair within
//     the 7-day TOOL_ERROR_WINDOW_DAYS window:
//       (a) older  'error' at now-2d
//       (b) middle 'ok'    at now-1d   ← would have been a recovery
//       (c) latest 'error' at now      ← re-break; latest run is error
//     Spaced by ~1 day so the LAG window function pairs them in the
//     intended order regardless of insertion-time tie-breaking.
//   - On this seed the broken-tool helper picks the (company, tool_key)
//     pair (latest run is 'error', inside the window). The recovery
//     helper, even though run (b) recovered run (a), MUST exclude the
//     pair because the latest run (c) is 'error' (its `rn = 1` row would
//     have status='error', failing the `status <> 'error'` guard).
//   - The SuperAdmin auth short-circuit (insert sa_sessions row + write
//     localStorage zatca_token + zatca_session='sa-<id>') matches what
//     the login flow itself produces, so /api/auth/me returns the
//     SuperAdmin and the AICompanyFix route guard renders. Same hook the
//     sibling specs use.
//
// Cleanup:
//   - Strict-by-PK: every inserted row id (maintenance_runs, companies,
//     sa_sessions) is recorded and deleted by `eq` / `inArray` in the
//     afterAll hook. No LIKE / wildcards on production tables; a crashed
//     run never touches another tenant's data.
//   - We deliberately do NOT call `pool.end()` — see the matching note
//     in critical-alerts-auto-refresh.spec.ts. With workers=1, sibling
//     specs share the singleton pool exported by `@workspace/db`.
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
const TEST_TAG = `e2e_task113_${randomBytes(4).toString("hex")}`;
// One (company, tool) pair is enough to prove the mutual-exclusion
// boundary: we seed an error → ok → error sequence on it and assert it
// shows up in the amber panel exactly once and never on the green panel.
const TOOL_KEY = `${TEST_TAG}_rebroken`;
const ERROR_MSG_OLD = `older break from task #113 e2e ${TEST_TAG}`;
const ERROR_MSG_RECENT = `re-break from task #113 e2e ${TEST_TAG}`;
// Header text the amber broken-tool panel renders (AICompanyFix.tsx
// around line 1891). Matched as a prefix only because the same line
// interpolates the window length ("آخر 7 أيام") which we don't want to
// hard-code here.
const BROKEN_PANEL_HEADER_PREFIX = "أدوات صيانة تعطّلت آخر";
// Header text the green recovery panel renders (AICompanyFix.tsx around
// line 1992). Same prefix-only matching reasoning as above.
const RECOVERED_PANEL_HEADER_PREFIX = "أدوات صيانة تعافت آخر";

let saSessionRowId: number | null = null;
let saSessionToken: string | null = null;
let testCompanyId: number | null = null;
const seededRunIds: number[] = [];

// ─── Setup: create company, sa_session, and the error → ok → error trio ────
test.beforeAll(async () => {
  // Sweep any debris from a previous interrupted run before seeding. All
  // three patterns are namespaced strictly to this test (the maintenance
  // runs tag the toolKey column, the sa_sessions tag sessionToken, the
  // companies tag nameAr), so this can never touch real audit history,
  // real user sessions, or real tenant rows.
  await db
    .delete(maintenanceRunsTable)
    .where(like(maintenanceRunsTable.toolKey, "e2e_task113_%"));
  await db
    .delete(superAdminSessionsTable)
    .where(like(superAdminSessionsTable.sessionToken, "e2e_task113_%"));
  await db
    .delete(companiesTable)
    .where(like(companiesTable.nameAr, "e2e_task113_%"));

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

  // Random-token sa_sessions row drives auth without going through the
  // real multi-factor login. resolveBearerToken() in artifacts/api-server/
  // src/middleware/auth.ts accepts this token and returns sessionId='sa-
  // <id>', matching what /api/auth/me will emit.
  saSessionToken = "e2e_task113_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task113",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  // Active test company so it's visible to both helpers (each joins
  // `companies` and filters status='active'). The Arabic name carries
  // TEST_TAG so the on-page row text can be uniquely matched.
  const [co] = await db
    .insert(companiesTable)
    .values({
      nameAr:         `${TEST_TAG} شركة الاختبار لإعادة الكسر`,
      nameEn:         `${TEST_TAG} Test Co Re-broken Tool`,
      vatNumber:      "300000000000113",
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

  // Three rows for the SAME (company, tool_key) pair, all inside the 7-
  // day window, spaced ~1 day apart so the LAG window function in
  // `getRecentToolRecoveries` pairs them as
  //   (prev='error', curr='ok')   ← row b vs row a, NOT the latest pair
  //   (prev='ok',    curr='error')← row c vs row b, IS the latest pair
  // The recovery helper additionally keeps only `rn = 1` (i.e. the
  // latest row per pair). Row c carries rn=1 with status='error', so
  // the `status <> 'error'` guard MUST drop it — which is exactly the
  // boundary this spec is locking down.
  const now = Date.now();
  const oldErr = await db
    .insert(maintenanceRunsTable)
    .values({
      companyId:  testCompanyId,
      toolKey:    TOOL_KEY,
      status:     "error",
      count:      0,
      trigger:    "scheduled",
      runAt:      new Date(now - 2 * 86_400_000),
      durationMs: 1,
      error:      ERROR_MSG_OLD,
      details:    null,
    })
    .returning({ id: maintenanceRunsTable.id });
  const midOk = await db
    .insert(maintenanceRunsTable)
    .values({
      companyId:  testCompanyId,
      toolKey:    TOOL_KEY,
      status:     "ok",
      count:      0,
      trigger:    "scheduled",
      runAt:      new Date(now - 86_400_000),
      durationMs: 1,
      error:      null,
      details:    null,
    })
    .returning({ id: maintenanceRunsTable.id });
  const newErr = await db
    .insert(maintenanceRunsTable)
    .values({
      companyId:  testCompanyId,
      toolKey:    TOOL_KEY,
      status:     "error",
      count:      0,
      trigger:    "scheduled",
      runAt:      new Date(now),
      durationMs: 1,
      error:      ERROR_MSG_RECENT,
      details:    null,
    })
    .returning({ id: maintenanceRunsTable.id });
  seededRunIds.push(oldErr[0].id, midOk[0].id, newErr[0].id);
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

// Inject the SuperAdmin session into localStorage *before* the SPA mounts
// so AuthContext.checkSession() finds the token on first paint and
// AICompanyFix renders without us having to drive the login form. The
// session id format (`sa-<row id>`) matches what resolveBearerToken
// returns from /api/auth/me, so the single-session check inside
// checkSession passes.
async function installSuperAdminSession(page: Page): Promise<void> {
  await page.addInitScript(
    ({ token, sessionId }) => {
      localStorage.setItem("zatca_token", token);
      localStorage.setItem("zatca_session", sessionId);
    },
    { token: saSessionToken!, sessionId: `sa-${saSessionRowId!}` },
  );
}

// Stable anchor for the SuperAdmin AI Company Fix page so we can wait
// for the SPA to settle on the right route before asserting panel
// visibility.
const PAGE_HEADING_RE = /إصلاح مشاكل الشركات بالذكاء الاصطناعي/;

test("re-broken tool stays in the amber broken-tool panel and never appears in the green recovered-tool panel", async ({ page }) => {
  await installSuperAdminSession(page);
  await page.goto("/admin/ai-fix", { waitUntil: "networkidle" });

  // Wait for the SPA to mount the AICompanyFix page first so panel
  // locators below resolve against the rendered DOM and not the loading
  // shell.
  await expect(page.getByRole("heading", { name: PAGE_HEADING_RE })).toBeVisible();

  // Locator scoped to the amber broken-tool panel via its unique border
  // colour AND header text. Anchoring on `border-amber-200` collapses
  // the locator to the single panel root (mirrors the panel-scoping
  // done in recovered-tools-auto-refresh.spec.ts for the green side),
  // and layering the Arabic header keeps the scope explicit if a future
  // refactor reuses the colour elsewhere on the page.
  const brokenPanel = page.locator("div.border-amber-200")
    .filter({ hasText: BROKEN_PANEL_HEADER_PREFIX });
  await expect(brokenPanel).toBeVisible();

  // The seeded TOOL_KEY's latest run is 'error', so the broken-tool
  // helper MUST surface it. Per-(company, tool_key) DISTINCT ON in
  // `getRecentToolErrors` collapses our three seeded rows down to one
  // — the row count must be exactly 1, not 3.
  const brokenRow = brokenPanel.locator("tbody tr", { hasText: TOOL_KEY });
  await expect(brokenRow).toHaveCount(1);

  // Same panel-scoping treatment for the green recovery panel — the
  // two panels would render side-by-side on the page so a page-wide
  // locator could legitimately match either.
  //
  // IMPORTANT: the green panel is hidden entirely when there are no
  // recoveries (AICompanyFix.tsx ~L1987 only renders the
  // `border-emerald-200` block when `recoverySummaryQ.data.items.length
  // > 0`). On a fresh dev DB, our seed alone produces zero recoveries
  // (the latest run for TOOL_KEY is 'error'), so the panel won't exist
  // at all — and that's a perfectly valid pass for this contract. We
  // therefore assert against `<panel> with our TOOL_KEY` rather than
  // requiring the panel itself to be visible: if the panel is absent,
  // the count is 0; if it's present (other tenants legitimately have
  // recoveries on this shared dev DB), the count is still 0 because
  // our re-broken pair is excluded. Either way, a regression that lets
  // a re-broken tool leak into the recovery projection would push the
  // count above 0 and fail this assertion.
  const leakedRecoveredRow = page.locator("div.border-emerald-200")
    .filter({ hasText: RECOVERED_PANEL_HEADER_PREFIX })
    .locator("tbody tr", { hasText: TOOL_KEY });
  await expect(leakedRecoveredRow).toHaveCount(0);
});
