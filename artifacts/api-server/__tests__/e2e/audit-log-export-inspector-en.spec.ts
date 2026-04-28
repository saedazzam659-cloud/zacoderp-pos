// E2E for the friendly export-CSV inspector inside /admin/audit-log's
// details dialog (task #137 — English-locale mirror of #130).
//
// Background:
//   The Arabic verification of the friendly export inspector lives in
//   `audit-log-export-inspector.spec.ts`. The SPA also supports an
//   English UI (toggled by the `app:lang` localStorage key the i18n
//   module reads on boot). Task #137 asks for an end-to-end check that
//   exercises the same export_csv inspector flow with the SPA language
//   forced to English, so the EN copies of the truncation pill, the
//   "Full file downloaded" pill, the metric-grid labels, the
//   empty-filters message, and the friendly action/entity labels all
//   render the way reviewers expect.
//
// What this verifies (English locale):
//   1. Clicking an export_csv row whose metadata has truncated===true
//      opens the dialog with:
//        • the friendly export inspector body (NOT the raw JSON pre)
//        • the amber "Export was truncated" pill carrying the
//          "{cap} / {total} rows" subtitle in English
//        • the metric grid (count / total / cap)
//        • the filters block resolving the action+entityType to
//          friendly English labels via the auditLog.historyActions /
//          historyEntityTypes blocks (e.g. "fix" -> "Fix",
//          "journal_pending" -> "Pending journal entries")
//   2. Clicking a non-truncated export_csv row renders the green
//      "Full file downloaded" pill, the metric grid, and the English
//      empty-filters copy ("No filters applied — exported the full
//      available range.").
//
// Determinism:
//   - Seeded usernames carry a per-run TEST_TAG (with the `_en` suffix
//     so it never collides with the Arabic spec) so the page's `?q=`
//     filter scopes the listing to exactly our seeded rows on the
//     shared dev DB.
//   - All seeded ids are tracked in seededAuditIds for strict-by-PK
//     cleanup. We deliberately do NOT call pool.end() — sibling specs
//     share the singleton pool exported by `@workspace/db`.

import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import {
  db,
  usersTable,
  companiesTable,
  auditLogTable,
  superAdminSessionsTable,
} from "@workspace/db";

const TEST_TAG = `e2e_task137_${randomBytes(4).toString("hex")}`;
const SEED_USERNAME_TRUNCATED = `${TEST_TAG}_clipped`;
const SEED_USERNAME_FULL      = `${TEST_TAG}_full`;
const SEED_ROW_CAP     = 1000;
const SEED_TOTAL_AVAIL = 1500;
const SEED_FULL_COUNT  = 42;

let saSessionRowId: number | null = null;
let saSessionToken: string | null = null;
let testCompanyId: number | null  = null;
const seededAuditIds: number[]    = [];

test.beforeAll(async () => {
  // Sweep debris from a prior interrupted run.
  await db
    .delete(auditLogTable)
    .where(like(auditLogTable.username, "e2e_task137_%"));
  await db
    .delete(superAdminSessionsTable)
    .where(like(superAdminSessionsTable.sessionToken, "e2e_task137_%"));
  await db
    .delete(companiesTable)
    .where(like(companiesTable.nameAr, "e2e_task137_%"));

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

  saSessionToken = "e2e_task137_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task137",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  const [co] = await db
    .insert(companiesTable)
    .values({
      nameAr:         `${TEST_TAG} شركة الاختبار للمفتش EN`,
      nameEn:         `${TEST_TAG} Audit Inspector Co EN`,
      vatNumber:      "300000000000137",
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

  // (1) Truncated export_csv row.
  const [truncatedRow] = await db
    .insert(auditLogTable)
    .values({
      userId:     sa.id,
      username:   SEED_USERNAME_TRUNCATED,
      role:       "superadmin",
      companyId:  testCompanyId,
      module:     "maintenance",
      action:     "export_csv",
      method:     "GET",
      path:       "/api/admin/maintenance/history",
      entityType: "maintenance_history",
      entityId:   null,
      statusCode: 200,
      ip:         "127.0.0.1",
      userAgent:  "playwright/task137",
      metadata: {
        count:          SEED_ROW_CAP,
        totalAvailable: SEED_TOTAL_AVAIL,
        truncated:      true,
        rowCap:         SEED_ROW_CAP,
        format:         "csv",
        filters: {
          from:       null,
          to:         null,
          action:     "fix",
          entityType: "journal_pending",
        },
      },
      createdAt: new Date(now),
    })
    .returning({ id: auditLogTable.id });
  seededAuditIds.push(truncatedRow.id);

  // (2) Non-truncated export_csv row.
  const [fullRow] = await db
    .insert(auditLogTable)
    .values({
      userId:     sa.id,
      username:   SEED_USERNAME_FULL,
      role:       "superadmin",
      companyId:  testCompanyId,
      module:     "maintenance",
      action:     "export_csv",
      method:     "GET",
      path:       "/api/admin/maintenance/history",
      entityType: "maintenance_history",
      entityId:   null,
      statusCode: 200,
      ip:         "127.0.0.1",
      userAgent:  "playwright/task137",
      metadata: {
        count:          SEED_FULL_COUNT,
        totalAvailable: SEED_FULL_COUNT,
        truncated:      false,
        rowCap:         SEED_ROW_CAP,
        format:         "csv",
        filters: {
          from:       null,
          to:         null,
          action:     null,
          entityType: null,
        },
      },
      createdAt: new Date(now - 1000),
    })
    .returning({ id: auditLogTable.id });
  seededAuditIds.push(fullRow.id);
});

test.afterAll(async () => {
  if (seededAuditIds.length) {
    await db
      .delete(auditLogTable)
      .where(inArray(auditLogTable.id, seededAuditIds));
  }
  if (testCompanyId !== null) {
    await db
      .delete(auditLogTable)
      .where(eq(auditLogTable.companyId, testCompanyId));
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

// Inject the SA session AND force the SPA's i18n into English before
// the bundle mounts. The i18n module reads `app:lang` from
// localStorage in `getInitialLang()` so seeding it here guarantees the
// English copies render on first paint without us having to click a
// language switcher.
async function installSuperAdminSessionEn(page: Page): Promise<void> {
  await page.addInitScript(
    ({ token, sessionId }) => {
      localStorage.setItem("zatca_token", token);
      localStorage.setItem("zatca_session", sessionId);
      localStorage.setItem("app:lang", "en");
    },
    { token: saSessionToken!, sessionId: `sa-${saSessionRowId!}` },
  );
}

const PAGE_HEADING_TEXT_EN = "Activity Log (Audit Log)";

test("audit-log details dialog (EN): export_csv rows render the friendly inspector with English copy + friendly filter labels", async ({ page }) => {
  await installSuperAdminSessionEn(page);
  await page.goto("/admin/audit-log", { waitUntil: "networkidle" });
  await expect(page.getByText(PAGE_HEADING_TEXT_EN)).toBeVisible();

  // Scope the listing to our seeded rows.
  const searchInput = page.getByPlaceholder(/karm|sales-invoices/);
  await searchInput.fill(TEST_TAG);
  await expect(page.locator("tbody tr").first()).toBeVisible();

  await expect(page.getByText(SEED_USERNAME_TRUNCATED).first()).toBeVisible();
  await expect(page.getByText(SEED_USERNAME_FULL).first()).toBeVisible();

  // ── 1) Truncated export_csv row ──────────────────────────────────────
  const truncatedRow = page.locator("tbody tr", { hasText: SEED_USERNAME_TRUNCATED });
  await expect(truncatedRow).toHaveCount(1);
  await truncatedRow.click();

  const dialog = page.getByTestId("audit-details-dialog");
  await expect(dialog).toBeVisible();

  // Friendly inspector body present, raw JSON metadata absent.
  const inspector = dialog.getByTestId("audit-details-export-inspector");
  await expect(inspector).toBeVisible();
  await expect(dialog.getByTestId("audit-details-metadata")).toHaveCount(0);

  // Truncation pill with cap/total subtitle (English locale).
  const truncatedPill = dialog.getByTestId("audit-details-export-truncated-pill");
  await expect(truncatedPill).toBeVisible();
  await expect(truncatedPill).toContainText("Export was truncated");
  await expect(truncatedPill).toContainText(
    `${SEED_ROW_CAP.toLocaleString("en-US")} / ${SEED_TOTAL_AVAIL.toLocaleString("en-US")} rows`,
  );

  // Inspector title + metric-grid labels render in English.
  await expect(inspector).toContainText("CSV export details");
  const metrics = dialog.getByTestId("audit-details-export-metrics");
  await expect(metrics).toContainText("Rows in file");
  await expect(metrics).toContainText("Total rows available");
  await expect(metrics).toContainText("Truncation cap");
  await expect(metrics).toContainText(SEED_ROW_CAP.toLocaleString("en-US"));
  await expect(metrics).toContainText(SEED_TOTAL_AVAIL.toLocaleString("en-US"));

  // Filters block resolves action+entityType to friendly EN labels via
  // the auditLog.historyActions / historyEntityTypes blocks.
  const filtersBlock = dialog.getByTestId("audit-details-export-filters");
  await expect(filtersBlock).toContainText("Filters applied at export time");
  await expect(filtersBlock).toContainText("Action");
  await expect(filtersBlock).toContainText("Fix");
  await expect(filtersBlock).toContainText("Category");
  await expect(filtersBlock).toContainText("Pending journal entries");
  // Confirm the raw machine values are NOT leaking through — the
  // friendly labels must replace them.
  await expect(filtersBlock).not.toContainText("journal_pending");

  // Close before opening the next dialog.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // ── 2) Non-truncated export_csv row ──────────────────────────────────
  const fullRow = page.locator("tbody tr", { hasText: SEED_USERNAME_FULL });
  await expect(fullRow).toHaveCount(1);
  await fullRow.click();
  await expect(dialog).toBeVisible();

  // Inspector body present, no truncation pill, full pill instead.
  await expect(dialog.getByTestId("audit-details-export-inspector")).toBeVisible();
  await expect(dialog.getByTestId("audit-details-export-truncated-pill")).toHaveCount(0);
  const fullPill = dialog.getByTestId("audit-details-export-full-pill");
  await expect(fullPill).toBeVisible();
  await expect(fullPill).toContainText("Full file downloaded");

  // Metric grid still renders with the row's count, in EN locale.
  await expect(dialog.getByTestId("audit-details-export-metrics"))
    .toContainText(SEED_FULL_COUNT.toLocaleString("en-US"));

  // No filters were applied — English empty-state copy is shown.
  await expect(dialog.getByTestId("audit-details-export-filters"))
    .toContainText("No filters applied — exported the full available range.");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
