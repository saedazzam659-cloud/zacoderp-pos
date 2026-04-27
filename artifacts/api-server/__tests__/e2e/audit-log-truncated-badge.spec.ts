// E2E test for the audit-log viewer's truncation badge on /admin/audit-log
// in the zatca-invoicing artifact (task #115).
//
// Why this test exists:
//   Task #111 made the maintenance CSV exports record `truncated`/`rowCap`/
//   `totalAvailable` in audit metadata when the 1000-row cap clips the
//   download (see admin.ts ~line 5006 for maintenance_error_summary and
//   ~line 5090 for maintenance_recent_recoveries). The audit-log viewer
//   on /admin/audit-log used to render the metadata column as raw JSON, so
//   a SuperAdmin scanning past exports had to expand each row to spot a
//   clipped one. Task #115 added a visible "تم الاقتطاع" badge with a
//   "1000 / 1500 صف" subtitle on rows whose metadata.truncated is true.
//   This spec locks that in so a regression that drops the badge — or
//   accidentally renders it on every export — would fail loudly.
//
// What this verifies:
//   1. A seeded audit row with metadata.truncated=true (a clipped
//      maintenance_error_summary export) renders the truncation badge
//      with the cap "1000" and the underlying total "1500" in its
//      subtitle copy, so the reviewer doesn't have to drill into the
//      JSON to see how badly the export was clipped.
//   2. A second seeded audit row with metadata.truncated=false (a
//      non-truncated maintenance_recent_recoveries export from the same
//      session) does NOT render the badge — i.e. the badge isn't
//      indiscriminately attached to every export row.
//
// Determinism story (mirrors the sibling specs):
//   - All seeded audit rows share a per-run TEST_TAG in their `username`
//     column. The page's free-text filter (`?q=`, ILIKE on username/path
//     in audit-log.ts ~line 56) is used to scope the visible rows down
//     to *only* our two seeded rows, so other audit history on the
//     shared dev DB never contaminates the badge-count assertions.
//   - The SuperAdmin auth short-circuit (insert sa_sessions row + write
//     localStorage zatca_token + zatca_session='sa-<id>') matches what
//     the login flow itself produces, so /api/auth/me returns the
//     SuperAdmin and the AuditLog route guard renders.
//
// Cleanup:
//   - Strict-by-PK: every inserted row id (audit_log, sa_sessions) is
//     deleted by `inArray`/`eq` in afterAll. No LIKE / wildcards on
//     production tables; a crashed run never touches another tenant's
//     data.
//   - We deliberately do NOT call `pool.end()` — see the matching note
//     in email-history-pagination.spec.ts. With workers=1, sibling specs
//     share the singleton pool exported by `@workspace/db`.
//
// How to run:
//   1. Ensure the api-server and zatca-invoicing dev workflows are running.
//   2. `pnpm --filter @workspace/api-server run test:e2e`

import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  auditLogTable,
  superAdminSessionsTable,
} from "@workspace/db";

// ─── Fixtures / state shared across the single test in this file ───────────
const TEST_TAG = `e2e_task115_${randomBytes(4).toString("hex")}`;
// Distinctive usernames on the seeded audit rows — both carry the full
// TEST_TAG so the audit-log viewer's `?q=` filter (ILIKE on username) can
// pinpoint exactly our two seeded rows on a shared dev DB.
const SEED_USERNAME_TRUNCATED     = `${TEST_TAG}_truncated`;
const SEED_USERNAME_NOT_TRUNCATED = `${TEST_TAG}_full`;

// The cap and the underlying total we seed. The cap mirrors the production
// constants BROKEN_CSV_ROW_CAP / RECOVERY_CSV_ROW_CAP (admin.ts) so the
// rendered subtitle copy matches what a real clipped export would show.
const SEED_ROW_CAP   = 1000;
const SEED_TOTAL_AVAIL = 1500;

let saSessionRowId: number | null   = null;
let saSessionToken: string | null   = null;
const seededAuditIds: number[]      = [];

// ─── Setup: create sa_session and two contrasting audit rows ───────────────
test.beforeAll(async () => {
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
  saSessionToken = "e2e_task115_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task115",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  // Seed two contrasting audit rows that mirror the metadata shape
  // /maintenance/error-summary?format=csv writes (admin.ts ~line 5025) and
  // /maintenance/recent-recoveries?format=csv writes (~line 5110). Both
  // are companyId=null because those exports are global. The page-side
  // filter scopes by username, so both rows surface together.
  const [truncatedRow] = await db
    .insert(auditLogTable)
    .values({
      userId:     sa.id,
      username:   SEED_USERNAME_TRUNCATED,
      role:       "superadmin",
      companyId:  null,
      module:     "maintenance",
      action:     "export_csv",
      method:     "GET",
      path:       "/api/admin/maintenance/error-summary?format=csv",
      entityType: "maintenance_error_summary",
      entityId:   null,
      metadata: {
        count:          SEED_ROW_CAP,
        totalAvailable: SEED_TOTAL_AVAIL,
        truncated:      true,
        rowCap:         SEED_ROW_CAP,
        format:         "csv",
        windowDays:     7,
      },
    })
    .returning({ id: auditLogTable.id });
  const [fullRow] = await db
    .insert(auditLogTable)
    .values({
      userId:     sa.id,
      username:   SEED_USERNAME_NOT_TRUNCATED,
      role:       "superadmin",
      companyId:  null,
      module:     "maintenance",
      action:     "export_csv",
      method:     "GET",
      path:       "/api/admin/maintenance/recent-recoveries?format=csv",
      entityType: "maintenance_recent_recoveries",
      entityId:   null,
      metadata: {
        count:          42,
        totalAvailable: 42,
        truncated:      false,
        rowCap:         SEED_ROW_CAP,
        format:         "csv",
        windowDays:     7,
      },
    })
    .returning({ id: auditLogTable.id });
  seededAuditIds.push(truncatedRow.id, fullRow.id);
});

// ─── Cleanup: strict-by-PK so a crash never nukes unrelated audit history ──
// We deliberately do NOT call `pool.end()` — see the matching note in
// email-history-pagination.spec.ts.
test.afterAll(async () => {
  if (seededAuditIds.length) {
    await db
      .delete(auditLogTable)
      .where(inArray(auditLogTable.id, seededAuditIds));
  }
  if (saSessionRowId !== null) {
    await db
      .delete(superAdminSessionsTable)
      .where(eq(superAdminSessionsTable.id, saSessionRowId));
  }
});

// Inject the SuperAdmin session into localStorage *before* the SPA mounts so
// AuthContext.checkSession() finds the token on first paint and AuditLog
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

// Stable anchor for the SuperAdmin Audit Log page so we can wait for the
// SPA to settle on the right route before driving the search input. The
// page renders its title inside a CardTitle (a plain <div>) rather than
// a <h*> element, so we anchor on the literal interpolated text instead
// of getByRole("heading").
const PAGE_HEADING_TEXT = "سجل النشاط (Audit Log)";

test("audit-log viewer: truncation badge appears on truncated CSV-export rows and is absent on non-truncated ones", async ({ page }) => {
  await installSuperAdminSession(page);

  await page.goto("/admin/audit-log", { waitUntil: "networkidle" });
  await expect(page.getByText(PAGE_HEADING_TEXT)).toBeVisible();

  // Use the page's free-text search to scope the visible rows to *only* our
  // two seeded rows (the input fills the `?q=` query param, ILIKE on
  // username/path in audit-log.ts ~line 56). Without this, other audit
  // rows on the shared dev DB would interfere with the badge-count
  // assertions below.
  const searchInput = page.getByPlaceholder(/karm|sales-invoices/);
  await searchInput.fill(TEST_TAG);
  // Wait for the table to settle on exactly our two rows. Anchoring on
  // the row count instead of an arbitrary timeout avoids races against
  // React Query's debounce + fetch round-trip.
  await expect(page.locator("tbody tr")).toHaveCount(2);

  // ─── Truncated row carries the badge with cap/total subtitle ──────────
  // The badge sits inside the same cell as the action label so a reviewer
  // sees both at once. Anchoring on the seeded username makes this
  // assertion immune to row-ordering changes.
  const truncatedRow = page.locator("tbody tr", { hasText: SEED_USERNAME_TRUNCATED });
  await expect(truncatedRow).toHaveCount(1);
  const truncatedBadge = truncatedRow.locator('[data-testid="audit-truncated-badge"]');
  await expect(truncatedBadge).toBeVisible();
  // Localized label ("تم الاقتطاع") plus the documented "<cap> / <total> صف"
  // subtitle. Asserting both makes the test fail loudly if either piece
  // is silently dropped — the whole point of task #115 is the at-a-glance
  // visibility of *how badly* the export was clipped.
  await expect(truncatedBadge).toContainText("تم الاقتطاع");
  await expect(truncatedBadge).toContainText(`${SEED_ROW_CAP.toLocaleString("ar-SA")} / ${SEED_TOTAL_AVAIL.toLocaleString("ar-SA")} صف`);

  // ─── Non-truncated row must NOT carry the badge ───────────────────────
  // Catches the regression where the badge would render on every export
  // row (or every row regardless of action). Scoping by the seeded
  // username keeps this stable on a shared dev DB.
  const fullRow = page.locator("tbody tr", { hasText: SEED_USERNAME_NOT_TRUNCATED });
  await expect(fullRow).toHaveCount(1);
  await expect(fullRow.locator('[data-testid="audit-truncated-badge"]')).toHaveCount(0);
});
