// E2E for the friendly export-CSV inspector inside /admin/audit-log's
// details dialog (task #130).
//
// Background:
//   The dedicated /admin/audit-log page already opens an AuditDetailsDialog
//   when a row is clicked (task #120 + permalink in #126). For
//   `action === "export_csv"` rows the metadata used to be pretty-printed
//   as raw JSON. Task #122 introduced a friendly inspector on the
//   maintenance-history accordion (/admin/ai-fix). Task #130 brings the
//   same metric grid + filters block to /admin/audit-log so power users
//   stop bouncing between the two surfaces.
//
// What this verifies:
//   1. Clicking an export_csv row whose metadata has truncated===true
//      opens the dialog with:
//        • the friendly export inspector body (NOT the raw JSON pre)
//        • the amber "Export was truncated" pill carrying the cap/total
//          subtitle in the active locale
//        • the metric grid (count / total / cap)
//        • the filters block resolving the action+entityType to friendly
//          Arabic labels
//   2. Clicking a non-truncated export_csv row renders the green
//      "Full file downloaded" pill and the same metric grid (no
//      truncation pill).
//   3. Clicking a non-export ("view") row keeps the EXISTING raw JSON
//      metadata view — the inspector body is NOT rendered.
//
// Determinism:
//   - The seeded usernames carry a per-run TEST_TAG so the page's `?q=`
//     filter scopes the listing to exactly our seeded rows on the shared
//     dev DB.
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

const TEST_TAG = `e2e_task130_${randomBytes(4).toString("hex")}`;
const SEED_USERNAME_TRUNCATED = `${TEST_TAG}_clipped`;
const SEED_USERNAME_FULL      = `${TEST_TAG}_full`;
const SEED_USERNAME_VIEW      = `${TEST_TAG}_view`;
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
    .where(like(auditLogTable.username, "e2e_task130_%"));
  await db
    .delete(superAdminSessionsTable)
    .where(like(superAdminSessionsTable.sessionToken, "e2e_task130_%"));
  await db
    .delete(companiesTable)
    .where(like(companiesTable.nameAr, "e2e_task130_%"));

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

  saSessionToken = "e2e_task130_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task130",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  const [co] = await db
    .insert(companiesTable)
    .values({
      nameAr:         `${TEST_TAG} شركة الاختبار للمفتش`,
      nameEn:         `${TEST_TAG} Audit Inspector Co`,
      vatNumber:      "300000000000130",
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

  // Stagger createdAt so the listing ordering (DESC by createdAt) is
  // deterministic: truncated row is newest, then full, then the view
  // row last. That's not strictly required (the page filters by `?q=`
  // and we click rows by username), but it keeps the snapshot stable
  // across re-runs.
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
      userAgent:  "playwright/task130",
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
      userAgent:  "playwright/task130",
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

  // (3) Non-export "view" row — must keep the existing raw JSON
  // metadata view (the inspector must NOT render).
  const [viewRow] = await db
    .insert(auditLogTable)
    .values({
      userId:     sa.id,
      username:   SEED_USERNAME_VIEW,
      role:       "superadmin",
      companyId:  testCompanyId,
      module:     "permalink_seed",
      action:     "view",
      method:     "GET",
      path:       "/api/test/task130/view",
      entityType: "permalink_test",
      entityId:   null,
      statusCode: 200,
      ip:         "127.0.0.1",
      userAgent:  "playwright/task130",
      metadata:   { tag: TEST_TAG, source: "task130-e2e-seed-view" },
      createdAt:  new Date(now - 2000),
    })
    .returning({ id: auditLogTable.id });
  seededAuditIds.push(viewRow.id);
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

// Inject the SA session before the SPA mounts so AuthContext.checkSession()
// finds the token on first paint.
async function installSuperAdminSession(page: Page): Promise<void> {
  await page.addInitScript(
    ({ token, sessionId }) => {
      localStorage.setItem("zatca_token", token);
      localStorage.setItem("zatca_session", sessionId);
    },
    { token: saSessionToken!, sessionId: `sa-${saSessionRowId!}` },
  );
}

const PAGE_HEADING_TEXT = "سجل النشاط (Audit Log)";

test("audit-log details dialog: export_csv rows render the friendly inspector with metric grid + filters", async ({ page }) => {
  await installSuperAdminSession(page);
  await page.goto("/admin/audit-log", { waitUntil: "networkidle" });
  await expect(page.getByText(PAGE_HEADING_TEXT)).toBeVisible();

  // Scope the listing to our seeded rows.
  const searchInput = page.getByPlaceholder(/karm|sales-invoices/);
  await searchInput.fill(TEST_TAG);
  await expect(page.locator("tbody tr").first()).toBeVisible();

  // Wait until all three seeded rows are visible.
  await expect(page.getByText(SEED_USERNAME_TRUNCATED).first()).toBeVisible();
  await expect(page.getByText(SEED_USERNAME_FULL).first()).toBeVisible();
  await expect(page.getByText(SEED_USERNAME_VIEW).first()).toBeVisible();

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

  // Truncation pill with cap/total subtitle (Arabic locale on the SPA).
  const truncatedPill = dialog.getByTestId("audit-details-export-truncated-pill");
  await expect(truncatedPill).toBeVisible();
  await expect(truncatedPill).toContainText("تم اقتطاع التصدير");
  await expect(truncatedPill).toContainText(
    `${SEED_ROW_CAP.toLocaleString("ar-SA")} / ${SEED_TOTAL_AVAIL.toLocaleString("ar-SA")} صف`,
  );

  // Metric grid carries count + totalAvailable + rowCap.
  const metrics = dialog.getByTestId("audit-details-export-metrics");
  await expect(metrics).toContainText(SEED_ROW_CAP.toLocaleString("ar-SA"));
  await expect(metrics).toContainText(SEED_TOTAL_AVAIL.toLocaleString("ar-SA"));

  // Filters block resolves action+entityType to friendly Arabic labels.
  const filtersBlock = dialog.getByTestId("audit-details-export-filters");
  await expect(filtersBlock).toContainText("الإجراء");
  await expect(filtersBlock).toContainText("إصلاح");
  await expect(filtersBlock).toContainText("الفئة");
  await expect(filtersBlock).toContainText("قيود معلّقة");

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
  await expect(fullPill).toContainText("تم تنزيل الملف بالكامل");

  // Metric grid still renders with the row's count.
  await expect(dialog.getByTestId("audit-details-export-metrics"))
    .toContainText(SEED_FULL_COUNT.toLocaleString("ar-SA"));

  // No filters were applied — empty-state copy is shown.
  await expect(dialog.getByTestId("audit-details-export-filters"))
    .toContainText("لم يتم تطبيق أي فلتر");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // ── 3) Non-export "view" row keeps the raw JSON metadata view ────────
  const viewRow = page.locator("tbody tr", { hasText: SEED_USERNAME_VIEW });
  await expect(viewRow).toHaveCount(1);
  await viewRow.click();
  await expect(dialog).toBeVisible();

  // Inspector body MUST NOT render for non-export rows.
  await expect(dialog.getByTestId("audit-details-export-inspector")).toHaveCount(0);
  // Existing raw JSON metadata view must still render and contain the
  // seeded payload verbatim.
  const metaPre = dialog.getByTestId("audit-details-metadata");
  await expect(metaPre).toBeVisible();
  await expect(metaPre).toContainText(`"tag": "${TEST_TAG}"`);
  await expect(metaPre).toContainText(`"source": "task130-e2e-seed-view"`);
});
