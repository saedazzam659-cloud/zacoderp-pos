// E2E for the export_csv audit-log inspector inside the maintenance-history
// accordion on /admin/ai-fix (task #122).
//
// Verifies:
//   1. export_csv row with metadata.truncated===true renders the amber
//      "تم الاقتطاع" pill with the cap/total subtitle.
//   2. export_csv row with truncated===false does NOT render the pill.
//   3. Non-export 'fix' row does NOT render a "تفاصيل" link.
//   4. Clicking "تفاصيل" opens the inspector dialog with metric grid,
//      truncation pill, and a filters snapshot rendered in Arabic.

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

const TEST_TAG = `e2e_task122_${randomBytes(4).toString("hex")}`;
const SEED_USERNAME_TRUNCATED  = `${TEST_TAG}_clipped`;
const SEED_USERNAME_FULL       = `${TEST_TAG}_full`;
const SEED_USERNAME_NON_EXPORT = `${TEST_TAG}_fix`;
const SEED_ROW_CAP     = 1000;
const SEED_TOTAL_AVAIL = 1500;

let saSessionRowId: number | null = null;
let saSessionToken: string | null = null;
let testCompanyId: number | null  = null;
const seededAuditIds: number[]    = [];

test.beforeAll(async () => {
  // Sweep debris from a prior interrupted run. All three patterns are
  // strictly namespaced to this test.
  await db
    .delete(auditLogTable)
    .where(like(auditLogTable.username, "e2e_task122_%"));
  await db
    .delete(superAdminSessionsTable)
    .where(like(superAdminSessionsTable.sessionToken, "e2e_task122_%"));
  await db
    .delete(companiesTable)
    .where(like(companiesTable.nameAr, "e2e_task122_%"));

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

  saSessionToken = "e2e_task122_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task122",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  const [co] = await db
    .insert(companiesTable)
    .values({
      nameAr:         `${TEST_TAG} شركة الاختبار للمفتش`,
      nameEn:         `${TEST_TAG} Test Co Inspector`,
      vatNumber:      "300000000000122",
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
      metadata: {
        count:          42,
        totalAvailable: 42,
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
    })
    .returning({ id: auditLogTable.id });
  seededAuditIds.push(fullRow.id);

  // (3) Non-export 'fix' row.
  const [fixRow] = await db
    .insert(auditLogTable)
    .values({
      userId:     sa.id,
      username:   SEED_USERNAME_NON_EXPORT,
      role:       "superadmin",
      companyId:  testCompanyId,
      module:     "maintenance",
      action:     "fix",
      method:     "POST",
      path:       "/api/admin/maintenance/journal-pending/fix",
      entityType: "journal_pending",
      entityId:   null,
      metadata: { tag: TEST_TAG, source: "task122-e2e-seed-fix" },
    })
    .returning({ id: auditLogTable.id });
  seededAuditIds.push(fixRow.id);
});

// Strict-by-PK cleanup. We deliberately do NOT call pool.end() — see
// the matching note in email-history-pagination.spec.ts.
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

const PAGE_HEADING_RE = /إصلاح مشاكل الشركات بالذكاء الاصطناعي/;

test("audit-log inspector: pill on truncated export_csv rows + inspector modal surfaces the captured metadata", async ({ page }) => {
  await installSuperAdminSession(page);

  await page.goto("/admin/ai-fix", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: PAGE_HEADING_RE })).toBeVisible();

  const companyTrigger = page.locator('button:has-text("— اختر الشركة —")').first();
  await companyTrigger.click();
  await expect(companyTrigger).toHaveAttribute("data-state", "open");
  await page.locator('[role="option"]').filter({ hasText: TEST_TAG }).first().click();

  // Open the history accordion (historyOpen gates the JSON history fetch).
  await page.getByRole("button", { name: "سجل الإصلاحات" }).first().click();

  // Sync barrier: wait for all three seeded rows to surface.
  await expect(page.getByText(SEED_USERNAME_TRUNCATED).first()).toBeVisible();
  await expect(page.getByText(SEED_USERNAME_FULL).first()).toBeVisible();
  await expect(page.getByText(SEED_USERNAME_NON_EXPORT).first()).toBeVisible();

  // Truncated row: amber pill with cap/total subtitle.
  const truncatedRow = page.locator("tr", { hasText: SEED_USERNAME_TRUNCATED });
  await expect(truncatedRow).toHaveCount(1);
  const truncatedPill = truncatedRow.locator(
    '[data-testid="maint-history-truncated-pill"]',
  );
  await expect(truncatedPill).toBeVisible();
  await expect(truncatedPill).toContainText("تم الاقتطاع");
  await expect(truncatedPill).toContainText(
    `${SEED_ROW_CAP.toLocaleString("ar-SA")} / ${SEED_TOTAL_AVAIL.toLocaleString("ar-SA")}`,
  );

  // Non-truncated row must NOT render the pill.
  const fullRow = page.locator("tr", { hasText: SEED_USERNAME_FULL });
  await expect(fullRow).toHaveCount(1);
  await expect(
    fullRow.locator('[data-testid="maint-history-truncated-pill"]'),
  ).toHaveCount(0);

  // Non-export 'fix' row must NOT render a "تفاصيل" link.
  const fixRow = page.locator("tr", { hasText: SEED_USERNAME_NON_EXPORT });
  await expect(fixRow).toHaveCount(1);
  await expect(
    fixRow.locator('[data-testid="maint-history-details-link"]'),
  ).toHaveCount(0);

  // Open the inspector dialog from the truncated row.
  await truncatedRow
    .locator('[data-testid="maint-history-details-link"]')
    .click();

  const dialog = page.locator('[data-testid="maint-history-inspector-dialog"]');
  await expect(dialog).toBeVisible();

  const dialogPill = dialog.locator(
    '[data-testid="maint-history-inspector-truncated-pill"]',
  );
  await expect(dialogPill).toBeVisible();
  await expect(dialogPill).toContainText("تم اقتطاع التصدير");
  await expect(dialogPill).toContainText(
    `${SEED_ROW_CAP.toLocaleString("ar-SA")} / ${SEED_TOTAL_AVAIL.toLocaleString("ar-SA")} صف`,
  );

  const metrics = dialog.locator(
    '[data-testid="maint-history-inspector-metrics"]',
  );
  await expect(metrics).toContainText(SEED_ROW_CAP.toLocaleString("ar-SA"));
  await expect(metrics).toContainText(SEED_TOTAL_AVAIL.toLocaleString("ar-SA"));

  // Filters snapshot resolves action/entityType to friendly Arabic labels.
  const filtersBlock = dialog.locator(
    '[data-testid="maint-history-inspector-filters"]',
  );
  await expect(filtersBlock).toContainText("الإجراء");
  await expect(filtersBlock).toContainText("إصلاح");
  await expect(filtersBlock).toContainText("الفئة");
  await expect(filtersBlock).toContainText("قيود معلّقة");
});
