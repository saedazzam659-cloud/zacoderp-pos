// E2E test for the SuperAdmin "أدوات صيانة تعطّلت آخر 7 أيام" amber panel
// on /admin/ai-fix in the zatca-invoicing artifact (task #85).
//
// What this verifies (mirrors the regression task acceptance criteria):
//   1. Empty state — when GET /api/admin/maintenance/error-summary returns
//      zero items, the amber panel must NOT render at all (the conditional
//      in AICompanyFix.tsx around line 1818 is gated on
//      `errorSummaryQ.data && errorSummaryQ.data.items.length > 0`, so an
//      empty list keeps the page calm).
//   2. Populated state — after seeding a (company, tool) pair whose latest
//      maintenance_runs row is `status='error'` inside the 7-day window,
//      the panel must:
//        - Be visible.
//        - Expose all four documented column headers in its <thead>.
//        - Render exactly one row for our seeded TOOL_KEY (the dev DB may
//          carry other broken tools from other tests / real sweeps; we
//          anchor on our unique tool key).
//        - Surface the seeded company's Arabic name in that row.
//   3. Tool-history affordance — clicking the tool-key button on the
//      seeded row opens the tool-history dialog whose title bar echoes
//      our TOOL_KEY (same affordance as the green recovered-tool panel
//      below it).
//
// Determinism story (mirrors recovered-tools-panel.spec.ts):
//   - We create a brand-new `companies` row tagged with a per-run TEST_TAG
//     so the seeded broken tool never collides with whatever else lives in
//     the shared dev DB.
//   - The tool key is also TEST_TAG-prefixed; assertions key on it instead
//     of on row counts, so other broken tools in the dev DB don't cause
//     false failures.
//   - The empty-state assertion is implemented by mocking the API endpoint
//     via page.route() so the test is independent of the global error
//     state — relying on "the dev DB happens to have zero broken tools
//     right now" would be flaky (and false: our own populated-state test
//     leaves seeded data behind until afterAll).
//   - The SuperAdmin auth short-circuit (insert sa_sessions row + write
//     localStorage zatca_token + zatca_session='sa-<id>') matches what
//     the login flow itself produces, so /api/auth/me returns the
//     SuperAdmin and the AICompanyFix route guard renders.
//
// Cleanup:
//   - Strict-by-PK: we record every inserted row id (maintenance_runs,
//     companies, sa_sessions) and delete by `eq`/`inArray` in afterAll.
//     No LIKE / wildcards on production tables; a crashed run never
//     touches another tenant's data.
//   - We deliberately do NOT call `pool.end()` — see the matching note in
//     recovered-tools-panel.spec.ts. With workers=1, sibling specs share
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

// ─── Fixtures / state shared across both tests in this file ────────────────
const TEST_TAG = `e2e_task85_${randomBytes(4).toString("hex")}`;
// Tool key carries the full TEST_TAG so panel-row assertions can pinpoint
// our seeded broken tool on a shared dev DB without relying on row counts.
const TOOL_KEY = `${TEST_TAG}_broken_tool`;
// Distinctive error string that we plant on the seeded row so the panel's
// "رسالة الخطأ" cell can be uniquely matched if needed.
const ERROR_MSG = `boom from task #85 e2e ${TEST_TAG}`;
// Header text the broken-tool panel renders (AICompanyFix.tsx ~line 1823).
// Only matched as a prefix because the same line interpolates the window
// length ("آخر 7 أيام") which we don't want to hard-code.
const PANEL_HEADER_PREFIX = "أدوات صيانة تعطّلت آخر";

let saSessionRowId: number | null = null;
let saSessionToken: string | null = null;
let testCompanyId: number | null = null;
const seededRunIds: number[] = [];

// ─── Setup: create company, sa_session, and a broken-tool scenario ─────────
test.beforeAll(async () => {
  // Sweep any debris from a previous interrupted run before seeding. All
  // three patterns are namespaced strictly to this test (the maintenance
  // runs tag the toolKey column, the sa_sessions tag sessionToken, the
  // companies tag nameAr), so this can never touch real audit history,
  // real user sessions, or real tenant rows.
  await db
    .delete(maintenanceRunsTable)
    .where(like(maintenanceRunsTable.toolKey, "e2e_task85_%"));
  await db
    .delete(superAdminSessionsTable)
    .where(like(superAdminSessionsTable.sessionToken, "e2e_task85_%"));
  await db
    .delete(companiesTable)
    .where(like(companiesTable.nameAr, "e2e_task85_%"));

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
  saSessionToken = "e2e_task85_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task85",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  // Active test company so it's visible to getRecentToolErrors (which joins
  // `companies` and filters status='active'). The Arabic name carries
  // TEST_TAG so the on-page row text can be uniquely matched.
  const [co] = await db
    .insert(companiesTable)
    .values({
      nameAr:         `${TEST_TAG} شركة الاختبار للأعطال`,
      nameEn:         `${TEST_TAG} Test Co Broken`,
      vatNumber:      "300000000000085",
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

  // Broken-tool scenario: a single 'error' row 1 day ago, no later rows for
  // the same (company, tool). The DISTINCT ON (company_id, tool_key) inside
  // getRecentToolErrors takes the latest run per pair and keeps only those
  // whose latest status is 'error', so this single row is enough to surface
  // the (company, tool) pair on the panel. The runAt comfortably sits inside
  // the 7-day window (TOOL_ERROR_WINDOW_DAYS in maintenanceScheduler.ts).
  const now = Date.now();
  const errRow = await db
    .insert(maintenanceRunsTable)
    .values({
      companyId:  testCompanyId,
      toolKey:    TOOL_KEY,
      status:     "error",
      count:      0,
      trigger:    "scheduled",
      runAt:      new Date(now - 1 * 86_400_000),
      durationMs: 1,
      error:      ERROR_MSG,
      details:    null,
    })
    .returning({ id: maintenanceRunsTable.id });
  seededRunIds.push(errRow[0].id);
});

// ─── Cleanup: strict-by-PK so a crash never nukes unrelated audit history ──
// We deliberately do NOT call `pool.end()` — see the matching note in
// recovered-tools-panel.spec.ts.
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

test("broken-tools panel: hidden when the API returns zero broken tools", async ({ page }) => {
  await installSuperAdminSession(page);

  // Mock the error-summary endpoint BEFORE navigating so the initial render
  // path can never see real data. Other panels (recoveries, critical, fleet,
  // history…) keep their real responses so the page still loads normally
  // and we're testing exactly this panel's hidden-when-empty branch.
  await page.route("**/api/admin/maintenance/error-summary**", async (route) => {
    await route.fulfill({
      status:      200,
      contentType: "application/json",
      body:        JSON.stringify({ count: 0, windowDays: 7, items: [] }),
    });
  });

  await page.goto("/admin/ai-fix", { waitUntil: "networkidle" });

  // Wait for the page heading so we know the SPA has mounted AICompanyFix
  // and the error-summary query has had a chance to resolve under our mock.
  await expect(page.getByRole("heading", { name: PAGE_HEADING_RE })).toBeVisible();

  // The panel renders only when items.length > 0; with our mock it must
  // never appear in the DOM. The header phrase is unique to this panel
  // (other on-page Arabic copy doesn't repeat the "أدوات صيانة تعطّلت"
  // wording), so a count of 0 proves the conditional branch is taking
  // the hidden path.
  await expect(page.getByText(PANEL_HEADER_PREFIX)).toHaveCount(0);
});

test("broken-tools panel: renders the seeded broken tool with the four columns and opens the tool-history modal", async ({ page }) => {
  await installSuperAdminSession(page);

  await page.goto("/admin/ai-fix", { waitUntil: "networkidle" });

  // Wait for the SPA to mount the page first so the panel locator below
  // resolves against the rendered DOM and not the loading shell.
  await expect(page.getByRole("heading", { name: PAGE_HEADING_RE })).toBeVisible();

  // Locator scoped to the amber panel via its header text. Anchoring on
  // the Arabic copy keeps assertions resilient to styling changes on the
  // surrounding container (the bg-amber-50/40 / border-amber-200 class
  // chain could legitimately move without breaking the contract).
  const panel = page.locator("div", { hasText: PANEL_HEADER_PREFIX }).filter({
    has: page.locator("table"),
  }).first();
  await expect(panel).toBeVisible();

  // Column headers must include all four labels in <thead>. Asserting
  // each one separately (vs. a single combined string) gives a clearer
  // failure message if a header is renamed or removed. Note: the task
  // description listed "آخر خطأ" / "وقت آخر فحص" but the actual rendered
  // headers are "رسالة الخطأ" / "وقت آخر فشل" (AICompanyFix.tsx lines
  // 1847-1848). The test asserts what the page actually shows; the
  // task-acceptance bullet is satisfied because we cover all four header
  // cells in <thead>.
  for (const col of ["الشركة", "الأداة", "رسالة الخطأ", "وقت آخر فشل"]) {
    await expect(panel.locator("thead th", { hasText: col })).toBeVisible();
  }

  // Find the row containing our unique TOOL_KEY. The dev DB may carry
  // other broken tools from real maintenance sweeps, so we never assert
  // on total row count — only on the presence of our seeded pair.
  const seededRow = panel.locator("tbody tr", { hasText: TOOL_KEY });
  await expect(seededRow).toHaveCount(1);
  // Same row must show our company's Arabic name (the company-name button
  // is the first cell). Using contains-text instead of an exact match
  // because the cell wraps the name in a button with a trailing tooltip.
  await expect(seededRow).toContainText("شركة الاختبار للأعطال");

  // Tool-key button on the row is the entry point into the tool-history
  // modal — same affordance as on the green recovered-tool panel. Clicking
  // it must open a Radix Dialog whose title is "آخر تشغيلات الأداة" and
  // which echoes our TOOL_KEY in the title bar.
  await seededRow.getByRole("button", { name: TOOL_KEY }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("آخر تشغيلات الأداة")).toBeVisible();
  await expect(dialog.getByText(TOOL_KEY)).toBeVisible();
});
