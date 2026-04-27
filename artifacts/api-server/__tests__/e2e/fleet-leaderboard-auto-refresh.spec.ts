// E2E test for the SuperAdmin "أكثر الشركات نتائج حرجة آخر N يوماً" fleet
// leaderboard panel auto-refresh on /admin/ai-fix in the zatca-invoicing
// artifact (task #103).
//
// What this verifies (mirrors the regression task acceptance criteria):
//   1. The "آخر تحديث: …" timestamp surfaced via
//      data-testid="fleet-summary-last-updated" advances on its own (no
//      reload, no user interaction) after the configured polling interval —
//      proving `fleetQ` keeps `refetchInterval: MAINTENANCE_PANEL_REFETCH_
//      MS` (30s).
//   2. A NEW critical-finding burst inserted for a different active company
//      while the page is open promotes that company into the panel without a
//      manual reload — proving the background refetch actually fetches fresh
//      data and the UI re-renders against it. Combined with (1), if a future
//      change drops `refetchInterval: MAINTENANCE_PANEL_REFETCH_MS` from
//      `fleetQ` in AICompanyFix.tsx the leaderboard would silently freeze
//      between manual reloads — exactly the regression this spec is here to
//      catch.
//
// This is the fleet-leaderboard sibling of:
//   - critical-alerts-auto-refresh.spec.ts (task #83)
//   - broken-tools-auto-refresh.spec.ts   (task #96)
// The fleet panel now renders the same `data-testid` "آخر تحديث" timestamp
// as those two siblings (task #109), so the timestamp-advance assertion
// below mirrors their pattern — a row-level diff alone could miss a
// regression where the panel keeps refetching but the rendered surface
// stops re-rendering for the timestamp.
//
// Determinism story:
//   - We seed two brand-new `companies` rows tagged with a per-run TEST_TAG
//     so the seeded fleet entries never collide with whatever else lives in
//     the shared dev DB.
//   - The fleet endpoint orders by `criticalRuns DESC, criticalCount DESC`
//     and caps at LIMIT 5. To guarantee both seeded companies land inside
//     that cap regardless of background noise on the dev DB, each seeded
//     company gets `CRITICAL_TOOLS_PER_COMPANY` distinct critical
//     (tool, day) pairs — 20 is well above what any real tenant accrues in
//     a 14-day window in dev.
//   - All seeded toolKeys carry the full TEST_TAG so the strict-by-PK
//     cleanup never touches anything else.
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
const TEST_TAG = `e2e_task103_${randomBytes(4).toString("hex")}`;
// The fleet panel renders companies by `companyName` (joined from
// `companies.name_ar`). Tagging both names with TEST_TAG makes per-row
// assertions pinpoint our seeds without relying on overall row counts.
const COMPANY_A_NAME_AR = `${TEST_TAG} شركة الأسطول أ`;
const COMPANY_B_NAME_AR = `${TEST_TAG} شركة الأسطول ب`;
// Header text the blue (red-styled in current code) fleet panel renders
// (AICompanyFix.tsx around line 2053). We anchor on this prefix only —
// the surrounding span interpolates the trend window length
// ("آخر 14 يوماً") which is operator-tunable and shouldn't break the
// locator.
const PANEL_HEADER_PREFIX = "أكثر الشركات نتائج حرجة آخر";
// The /api/admin/maintenance/trend fleet branch caps at LIMIT 5 ordered by
// `criticalRuns DESC, criticalCount DESC`. Seeding this many DISTINCT
// critical (toolKey, day) pairs per seeded company guarantees both seeded
// companies outrank any natural critical noise in the shared dev DB and
// land inside the top-5 cap. 20 is far above what a real tenant accrues in
// a 14-day window in dev; bump if a false negative ever appears.
const CRITICAL_TOOLS_PER_COMPANY = 20;

let saSessionRowId: number | null = null;
let saSessionToken: string | null = null;
let companyAId: number | null = null;
let companyBId: number | null = null;
const seededRunIds: number[] = [];

// Helper — bulk-insert CRITICAL_TOOLS_PER_COMPANY distinct (toolKey)
// critical maintenance_runs rows for one company, recording their PKs so
// afterAll can delete strictly-by-id. `runAt = new Date()` keeps every row
// inside the 14-day default trend window.
async function seedCriticalRuns(companyId: number, label: string): Promise<void> {
  const inserted = await db
    .insert(maintenanceRunsTable)
    .values(
      Array.from({ length: CRITICAL_TOOLS_PER_COMPANY }, (_, i) => ({
        companyId,
        toolKey:    `${TEST_TAG}_${label}_${i}`,
        status:     "critical" as const,
        count:      1,
        trigger:    "scheduled" as const,
        runAt:      new Date(),
        durationMs: 1,
        error:      null,
        details:    null,
      })),
    )
    .returning({ id: maintenanceRunsTable.id });
  for (const r of inserted) seededRunIds.push(r.id);
}

// ─── Setup: create company A, sa_session, and the first critical burst ─────
test.beforeAll(async () => {
  // Sweep any debris from a previous interrupted run before seeding. All
  // three patterns are namespaced strictly to this test (the maintenance
  // runs tag the toolKey column, the sa_sessions tag sessionToken, the
  // companies tag nameAr), so this can never touch real audit history,
  // real user sessions, or real tenant rows.
  await db
    .delete(maintenanceRunsTable)
    .where(like(maintenanceRunsTable.toolKey, "e2e_task103_%"));
  await db
    .delete(superAdminSessionsTable)
    .where(like(superAdminSessionsTable.sessionToken, "e2e_task103_%"));
  await db
    .delete(companiesTable)
    .where(like(companiesTable.nameAr, "e2e_task103_%"));

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
  saSessionToken = "e2e_task103_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task103",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  // Active test company A so it's visible to the fleet projection (which
  // joins `companies` and filters status='active'). The Arabic name carries
  // TEST_TAG so the on-page row text can be uniquely matched.
  const [coA] = await db
    .insert(companiesTable)
    .values({
      nameAr:         COMPANY_A_NAME_AR,
      nameEn:         `${TEST_TAG} Fleet Co A`,
      vatNumber:      "300000000000103",
      crNumber:       `CR_A_${TEST_TAG}`,
      city:           "Riyadh",
      street:         "Test St",
      buildingNumber: "1",
      postalCode:     "12345",
      country:        "SA",
      invoiceType:    "both",
      status:         "active",
    })
    .returning({ id: companiesTable.id });
  companyAId = coA.id;

  // First critical burst — company A. Seeded BEFORE the page loads so the
  // panel shows up on first paint with company A in it; that anchor lets
  // the in-test assertion below detect when company B joins the panel
  // after a polling tick (proving the auto-refresh actually re-renders).
  await seedCriticalRuns(companyAId, "co_a");
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
  const companyIds = [companyAId, companyBId].filter(
    (x): x is number => x !== null,
  );
  if (companyIds.length) {
    await db
      .delete(companiesTable)
      .where(inArray(companiesTable.id, companyIds));
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

test("fleet leaderboard auto-refresh: a newly hammered company joins the panel without reload", async ({ page }) => {
  // Allow ~120s — we have to wait for one full polling tick (30s configured
  // in AICompanyFix.tsx, MAINTENANCE_PANEL_REFETCH_MS) PLUS the bulk insert
  // of CRITICAL_TOOLS_PER_COMPANY rows for company B PLUS first-paint and
  // assertion buffers. The 60s default in playwright.config.ts is too tight
  // to give the post-refetch margin we need on a slow dev DB.
  test.setTimeout(120_000);

  await installSuperAdminSession(page);
  await page.goto("/admin/ai-fix", { waitUntil: "networkidle" });

  // Wait for the SPA to mount the AICompanyFix page first so the panel
  // locators below resolve against the rendered DOM and not the loading
  // shell.
  await expect(page.getByRole("heading", { name: PAGE_HEADING_RE })).toBeVisible();

  // Locator scoped to the fleet leaderboard table itself, not a parent
  // div. We anchor on the unique "إجمالي الحرج" th — that column only
  // exists on the fleet panel (the sibling broken-tool, recovered-tool,
  // and critical-alerts tables don't render it), so this pinpoints the
  // fleet table even when the page-level wrapper happens to enclose
  // multiple tables that all transitively contain PANEL_HEADER_PREFIX.
  // We also assert the panel header is visible as a sanity check on the
  // surrounding container before reading rows — keeps the failure mode
  // crisp if a future refactor renames the table without renaming the
  // panel header.
  await expect(
    page.getByText(PANEL_HEADER_PREFIX, { exact: false }).first(),
  ).toBeVisible();
  const fleetTable = page
    .locator("table")
    .filter({ has: page.getByRole("columnheader", { name: "إجمالي الحرج" }) })
    .first();
  await expect(fleetTable).toBeVisible();

  // The seeded company A row must be visible — proves the table renders
  // the fleet projection on first paint, not just the header. Anchoring
  // on the unique Arabic name (carries TEST_TAG) avoids confusion with
  // the dev DB's own critical companies that may legitimately co-occupy
  // the top-5 cap.
  const rowA = fleetTable.locator("tbody tr", { hasText: COMPANY_A_NAME_AR });
  await expect(rowA).toHaveCount(1);

  // Sanity: company B is NOT in the fleet table yet — it doesn't exist in
  // the DB at all. Captures the "before" baseline so the post-refetch
  // assertion below isn't a vacuous truth.
  const rowB = fleetTable.locator("tbody tr", { hasText: COMPANY_B_NAME_AR });
  await expect(rowB).toHaveCount(0);

  // Capture the initial "آخر تحديث: HH:MM:SS" text. The data-testid hook
  // is the contract task #109 explicitly calls out, and `dataUpdatedAt`
  // is sourced from TanStack Query so the rendered time advances on
  // every successful refetch. The testid is unique on the page so we
  // locate it directly without re-scoping through the panel container.
  const timestamp = page.locator('[data-testid="fleet-summary-last-updated"]');
  await expect(timestamp).toBeVisible();
  const initialTimestampText = (await timestamp.textContent())?.trim() ?? "";
  expect(initialTimestampText.length).toBeGreaterThan(0);
  // Sanity check: the rendered prefix is "آخر تحديث:" — if a future
  // refactor changes the label, this assertion catches it before we hang
  // on the "did the time change?" poll below.
  expect(initialTimestampText).toContain("آخر تحديث");

  // While the page is open, create company B and seed its critical burst.
  // This must surface in the panel without a manual reload — that's the
  // auto-refresh behaviour the task is protecting. Inserted AFTER the
  // first-paint assertion so the poll below can fail fast if the panel
  // never refetches.
  const [coB] = await db
    .insert(companiesTable)
    .values({
      nameAr:         COMPANY_B_NAME_AR,
      nameEn:         `${TEST_TAG} Fleet Co B`,
      vatNumber:      "300000000000203",
      crNumber:       `CR_B_${TEST_TAG}`,
      city:           "Riyadh",
      street:         "Test St",
      buildingNumber: "2",
      postalCode:     "12345",
      country:        "SA",
      invoiceType:    "both",
      status:         "active",
    })
    .returning({ id: companiesTable.id });
  companyBId = coB.id;
  await seedCriticalRuns(companyBId, "co_b");

  // Wait for the next polling tick (configured at 30s) to bring company B
  // into view. We give 75s — comfortably more than two ticks — so a
  // momentarily-slow fetch doesn't fail the spec, but well under the 120s
  // test budget. If `refetchInterval` was silently dropped from `fleetQ`,
  // this poll would hit its timeout and the test would fail with
  // "expected 1, received 0" — exactly the regression the task is worried
  // about.
  await expect(rowB).toHaveCount(1, { timeout: 75_000 });

  // Sanity: company A is still there too — the refetch should have
  // promoted company B alongside company A inside the LIMIT 5 cap, not
  // replaced one with the other. This catches a subtle regression where a
  // refetch wipes prior state mid-render.
  await expect(rowA).toHaveCount(1);

  // After a successful refetch, dataUpdatedAt must change, so the rendered
  // toLocaleTimeString("ar-SA") string in the timestamp span must differ
  // from what we captured before raising company B. Polling instead of a
  // single read because the timestamp text and the new row are updated by
  // separate React renders — the row may flash in slightly before the
  // span re-renders depending on scheduling. Polling keeps the assertion
  // robust without admitting flakiness in either direction. Mirrors the
  // pattern used by critical-alerts-auto-refresh.spec.ts and
  // broken-tools-auto-refresh.spec.ts.
  await expect
    .poll(
      async () => ((await timestamp.textContent()) ?? "").trim(),
      { timeout: 15_000 },
    )
    .not.toBe(initialTimestampText);
});
