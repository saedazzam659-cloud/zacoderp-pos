// E2E test for the SuperAdmin email-history "تحميل المزيد" pagination on
// /admin/ai-fix in the zatca-invoicing artifact (task #66).
//
// What this verifies (mirrors the regression task acceptance criteria):
//   1. The first page renders EMAIL_HISTORY_PAGE_SIZE (= 20) rows when more
//      data exists, with the "تحميل المزيد" button visible.
//   2. Clicking "تحميل المزيد" appends the second page in-place; the button
//      disappears once the server reports hasMore=false.
//   3. Changing a filter resets pagination back to the first page (the
//      useInfiniteQuery key includes every filter; switching the status
//      bucket must rebuild from offset=0, not append). With a filter that
//      excludes every seeded row, the empty-state copy must replace the
//      table and the load-more button must hide.
//
// Determinism story:
//   - We seed exactly 25 maintenance_email_runs rows on a fixed historical
//     calendar day (1985-01-15) with a unique `criticalSignature` tag so the
//     test owns its dataset and never collides with whatever else is in the
//     shared dev DB.
//   - The UI date filter (from=1985-01-15, to=1985-01-15) keeps the
//     assertions scoped to *only* the seeded rows: any unrelated existing
//     row in maintenance_email_runs sits outside that day and is invisible
//     to every assertion below.
//   - The SuperAdmin auth short-circuit (insert sa_sessions row + write
//     localStorage zatca_token + zatca_session='sa-<id>') matches what the
//     login flow itself produces, so /api/auth/me returns the SuperAdmin
//     and the AICompanyFix route guard renders.
//
// Cleanup:
//   - Strict-by-PK: we record every inserted row id and delete by
//     `inArray(table.id, ids)` in the afterAll hook. No LIKE / wildcards;
//     a crashed run never touches another tenant's data.
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
  maintenanceEmailRunsTable,
  superAdminSessionsTable,
} from "@workspace/db";

// ─── Fixtures / state shared across the single test in this file ───────────
const TEST_TAG = `e2e_task66_${randomBytes(4).toString("hex")}`;
const SEED_DATE = "1985-01-15";
// EMAIL_HISTORY_PAGE_SIZE is 20 (artifacts/zatca-invoicing/src/pages/admin/
// AICompanyFix.tsx line 913). Seeding exactly 25 rows gives:
//   - page 1: 20 rows + hasMore=true   (load-more visible)
//   - page 2: 5 rows + hasMore=false   (load-more hidden, total = 25)
const PAGE_SIZE = 20;
const TOTAL_ROWS = 25;

let saSessionRowId: number | null = null;
let saSessionToken: string | null = null;
const seededEmailRunIds: number[] = [];

// ─── Setup: insert sa_session for the existing superadmin user + 25 rows ───
test.beforeAll(async () => {
  // Sweep any debris from a previous interrupted run before seeding. Both
  // `e2e_task66_*` patterns are namespaced strictly to this test (the email
  // runs use the criticalSignature column, the sa_sessions use the sessionToken
  // column), so this can never touch real audit history or user sessions.
  // Without this sweep, leftover rows on SEED_DATE could contaminate the
  // *global* count chip assertions ("20 محاولة...+", "25 محاولة...", etc.)
  // even though the row-level assertions are TEST_TAG-scoped via the
  // criticalSignature title attribute.
  await db
    .delete(maintenanceEmailRunsTable)
    .where(like(maintenanceEmailRunsTable.criticalSignature, "e2e_task66_%"));
  await db
    .delete(superAdminSessionsTable)
    .where(like(superAdminSessionsTable.sessionToken, "e2e_task66_%"));

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
  saSessionToken = "e2e_task66_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task66",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  // 25 seeded rows on the same calendar day, each with a unique second-offset
  // so ORDER BY ranAt DESC produces a stable order. status='ok' keeps them
  // out of the "failed" status bucket, which the third assertion relies on
  // to prove the filter-reset returns 0 matching rows (and the empty-state
  // copy renders).
  const rows = Array.from({ length: TOTAL_ROWS }, (_, i) => ({
    ranAt:             new Date(`${SEED_DATE}T12:00:${String(i).padStart(2, "0")}.000Z`),
    trigger:           "scheduled" as const,
    status:            "ok",
    recipients:        1,
    criticalCount:     0,
    error:             null as string | null,
    reason:            "digest_sent",
    criticalSignature: TEST_TAG,
  }));
  const inserted = await db
    .insert(maintenanceEmailRunsTable)
    .values(rows)
    .returning({ id: maintenanceEmailRunsTable.id });
  for (const r of inserted) seededEmailRunIds.push(r.id);
});

// ─── Cleanup: strict-by-PK so a crash never nukes unrelated audit history ──
//
// We deliberately do NOT call `pool.end()` here. Playwright runs spec files
// inside the same worker process (workers=1 in playwright.config.ts), and
// `@workspace/db` exports a singleton `pool`. Ending it would break any
// sibling spec (e.g. recovered-tools-panel.spec.ts) that runs afterwards in
// the same worker — its first query would throw "Cannot use a pool after
// calling end on the pool". Letting Node's process exit close the pg
// connections is harmless for a short-lived test process.
test.afterAll(async () => {
  if (seededEmailRunIds.length) {
    await db
      .delete(maintenanceEmailRunsTable)
      .where(inArray(maintenanceEmailRunsTable.id, seededEmailRunIds));
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

// Stable selector for the email-history panel header card. Anchoring against
// the Arabic title "سجل تنبيهات البريد" makes the assertions resilient to
// other panels above/below moving around.
function panel(page: Page) {
  return page.locator("div", { hasText: "سجل تنبيهات البريد" }).first();
}

test("email-history pagination: first page renders 20, load more appends, filter resets to page 1", async ({ page }) => {
  await installSuperAdminSession(page);

  await page.goto("/admin/ai-fix", { waitUntil: "networkidle" });

  // Wait for the email-history panel to render. Its presence implies the
  // first /api/admin/maintenance/email-history fetch has resolved (the panel
  // is gated on `emailHistoryQ.data &&` in AICompanyFix.tsx).
  await expect(panel(page)).toBeVisible();

  // ─── Apply the date filter so only the 25 seeded rows are in scope ───
  // Inputs are <Input type="date">; setting both `from` and `to` to the same
  // calendar day (1985-01-15) keeps the assertions deterministic on a shared
  // dev DB regardless of any other rows already in maintenance_email_runs.
  const fromInput = panel(page).locator('input[type="date"]').nth(0);
  const toInput   = panel(page).locator('input[type="date"]').nth(1);
  await fromInput.fill(SEED_DATE);
  await toInput.fill(SEED_DATE);

  // After the filter applies, the count chip reads
  // "تم تحميل 20 من 25 محاولة مطابقة للفلاتر" (task #67 replaced the older
  // "20 محاولة مطابقة للفلاتر+" hasMore-suffix copy with an explicit
  // "loaded N of T" format; hasMore is now implied by loadedCount<totalCount
  // rather than a trailing `+`) and the table renders exactly PAGE_SIZE
  // rows. To count *only* this run's seeded rows — never colliding with
  // leftover rows from a crashed prior run, even though the 1985-01-15 date
  // filter already isolates the day — we match on the full unique TEST_TAG
  // carried by the criticalSignature column. The visible cell text is
  // intentionally truncated to 8 chars + "…" by the UI (see AICompanyFix.tsx
  // around the email-history tbody), so we anchor on the cell's `title`
  // attribute, which is set to the full untruncated signature.
  const seededRows = panel(page).locator("tbody tr").filter({
    has: page.locator(`td[title="${TEST_TAG}"]`),
  });

  await expect(seededRows).toHaveCount(PAGE_SIZE);
  await expect(
    panel(page).getByText(
      `تم تحميل ${PAGE_SIZE} من ${TOTAL_ROWS} محاولة مطابقة للفلاتر`,
      { exact: true },
    ),
  ).toBeVisible();

  // The button label now also surfaces the remaining count (task #67):
  // "تحميل المزيد (5 متبقّية)" before the second page is loaded, then plain
  // "تحميل المزيد" if remaining ever drops to 0 while hasMore is still true.
  // getByRole's `name` does substring matching on the accessible name, so
  // matching on the stable "تحميل المزيد" prefix covers both shapes.
  const loadMore = panel(page).getByRole("button", { name: "تحميل المزيد" });
  await expect(loadMore).toBeVisible();

  // ─── Click "تحميل المزيد" → second page is appended in-place ───
  await loadMore.click();
  await expect(seededRows).toHaveCount(TOTAL_ROWS);
  // hasMore=false now, so the count chip flips from
  // "تم تحميل 20 من 25 محاولة مطابقة للفلاتر" to
  // "تم تحميل 25 من 25 محاولة مطابقة للفلاتر".
  await expect(
    panel(page).getByText(
      `تم تحميل ${TOTAL_ROWS} من ${TOTAL_ROWS} محاولة مطابقة للفلاتر`,
      { exact: true },
    ),
  ).toBeVisible();
  await expect(loadMore).toBeHidden();

  // ─── Change the status filter to "فاشلة" → useInfiniteQuery key changes
  //     → React Query rebuilds page 0 from offset=0 (this is the "filter
  //     resets to page 1" behaviour). The seeded rows have status='ok' so
  //     they fall outside the "failed" bucket; the API returns 0 items and
  //     the empty-state copy replaces the table. The load-more button must
  //     stay hidden because hasMore=false on the new first page. ───
  // Radix Select renders the trigger as a <button> wrapping the placeholder
  // text inside a <SelectValue>. With no status selected the trigger's
  // visible text is the placeholder ("كل الحالات"), which is the easiest
  // unambiguous handle for the *status* trigger (the sibling "المصدر"
  // trigger shows "كل المصادر"). The open dropdown is portalled to the
  // document root with role="listbox" and option items with role="option".
  const statusCombo = panel(page).locator('button:has-text("كل الحالات")').first();
  await statusCombo.click();
  // Wait for the portal listbox to mount before clicking the option, then
  // click the "فاشلة" item.
  await expect(statusCombo).toHaveAttribute("data-state", "open");
  await page.locator('[role="option"]').filter({ hasText: "فاشلة" }).first().click();

  await expect(seededRows).toHaveCount(0);
  await expect(
    panel(page).getByText("لا توجد محاولات إرسال مطابقة للفلاتر."),
  ).toBeVisible();
  await expect(
    panel(page).getByText("تم تحميل 0 من 0 محاولة مطابقة للفلاتر", { exact: true }),
  ).toBeVisible();
  await expect(
    panel(page).getByRole("button", { name: "تحميل المزيد" }),
  ).toBeHidden();
});
