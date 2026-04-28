// E2E for the "إعادة التصدير بنفس الفلاتر" replay button inside the
// maintenance-history audit-log inspector dialog on /admin/ai-fix (task #129).
//
// Verifies:
//   1. Clicking the replay button issues /maintenance/history?format=csv with
//      from/to/action/entityType taken verbatim from the seeded
//      metadata.filters snapshot — proving the button forwards the saved
//      values, not the (empty) live toolbar state.
//   2. The reproduction writes a fresh export_csv audit row whose own
//      metadata.filters mirrors the snapshot we replayed from.

import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { and, eq, gte, inArray, like } from "drizzle-orm";
import {
  db,
  usersTable,
  companiesTable,
  auditLogTable,
  superAdminSessionsTable,
} from "@workspace/db";

const TEST_TAG = `e2e_task129_${randomBytes(4).toString("hex")}`;
const SEED_USERNAME = `${TEST_TAG}_replay`;
// Filter snapshot the replay button must forward verbatim.
const SEED_FILTERS = {
  from:       "2026-04-01",
  to:         "2026-04-30",
  action:     "fix",
  entityType: "journal_pending",
} as const;

let saSessionRowId: number | null = null;
let saSessionToken: string | null = null;
let testCompanyId: number | null  = null;
const seededAuditIds: number[]    = [];
let replayAuditAnchor: Date | null = null;

test.beforeAll(async () => {
  // Sweep debris from a prior interrupted run.
  await db
    .delete(auditLogTable)
    .where(like(auditLogTable.username, "e2e_task129_%"));
  await db
    .delete(superAdminSessionsTable)
    .where(like(superAdminSessionsTable.sessionToken, "e2e_task129_%"));
  await db
    .delete(companiesTable)
    .where(like(companiesTable.nameAr, "e2e_task129_%"));

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

  saSessionToken = "e2e_task129_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task129",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  const [co] = await db
    .insert(companiesTable)
    .values({
      nameAr:         `${TEST_TAG} شركة الاختبار للإعادة`,
      nameEn:         `${TEST_TAG} Test Co Replay`,
      vatNumber:      "300000000000129",
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

  // Seed the export_csv row the inspector dialog opens against. Metadata
  // shape mirrors the maintenance-history CSV writer in admin.ts (~line 4528).
  const [seedRow] = await db
    .insert(auditLogTable)
    .values({
      userId:     sa.id,
      username:   SEED_USERNAME,
      role:       "superadmin",
      companyId:  testCompanyId,
      module:     "maintenance",
      action:     "export_csv",
      method:     "GET",
      path:       "/api/admin/maintenance/history",
      entityType: "maintenance_history",
      entityId:   null,
      metadata: {
        count:          17,
        totalAvailable: 17,
        truncated:      false,
        rowCap:         1000,
        format:         "csv",
        filters:        { ...SEED_FILTERS },
      },
    })
    .returning({ id: auditLogTable.id });
  seededAuditIds.push(seedRow.id);
});

// Strict-by-PK cleanup. No pool.end() — see email-history-pagination.spec.ts.
test.afterAll(async () => {
  if (seededAuditIds.length) {
    await db
      .delete(auditLogTable)
      .where(inArray(auditLogTable.id, seededAuditIds));
  }
  if (testCompanyId !== null) {
    // Wholesale strip of the test company's audit history catches the
    // export_csv row written by the replay click.
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

test("audit-log inspector replay: forwards saved filters and writes a new export_csv audit row", async ({ page }) => {
  await installSuperAdminSession(page);

  // Refetch-and-buffer pattern: page-side mutation drains the response body
  // via .blob(), so we capture URL+body upstream for assertions.
  const csvCaptures: { url: string; body: Buffer }[] = [];
  await page.route("**/api/admin/maintenance/history**", async (route, request) => {
    if (!request.url().includes("format=csv")) {
      await route.continue();
      return;
    }
    const upstream = await route.fetch();
    const body     = await upstream.body();
    csvCaptures.push({ url: request.url(), body });
    await route.fulfill({ response: upstream, body });
  });

  await page.goto("/admin/ai-fix", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: PAGE_HEADING_RE })).toBeVisible();

  const companyTrigger = page.locator('button:has-text("— اختر الشركة —")').first();
  await companyTrigger.click();
  await expect(companyTrigger).toHaveAttribute("data-state", "open");
  await page.locator('[role="option"]').filter({ hasText: TEST_TAG }).first().click();

  // Open the history accordion (gates historyOpen → JSON history fetch).
  await page.getByRole("button", { name: "سجل الإصلاحات" }).first().click();

  // Sync barrier: wait for the seeded row before clicking "تفاصيل".
  await expect(page.getByText(SEED_USERNAME).first()).toBeVisible();

  const seedTableRow = page.locator("tr", { hasText: SEED_USERNAME });
  await expect(seedTableRow).toHaveCount(1);
  await seedTableRow
    .locator('[data-testid="maint-history-details-link"]')
    .click();

  const dialog = page.locator('[data-testid="maint-history-inspector-dialog"]');
  await expect(dialog).toBeVisible();

  // Anchor wall-clock just before the click so the new-row lookup matches
  // only this run. 1s slack for clock skew vs Postgres.
  replayAuditAnchor = new Date(Date.now() - 1_000);

  const replayBtn = dialog.locator(
    '[data-testid="maint-history-inspector-replay"]',
  );
  await expect(replayBtn).toBeVisible();
  await expect(replayBtn).toBeEnabled();
  await replayBtn.click();

  // The replay mutation closes the inspector on success.
  await expect(dialog).toBeHidden();

  await expect.poll(() => csvCaptures.length, { timeout: 15_000 }).toBe(1);
  const capturedUrl = new URL(csvCaptures[0].url);
  expect(capturedUrl.searchParams.get("format")).toBe("csv");
  expect(capturedUrl.searchParams.get("companyId")).toBe(String(testCompanyId));
  expect(capturedUrl.searchParams.get("from")).toBe(SEED_FILTERS.from);
  expect(capturedUrl.searchParams.get("to")).toBe(SEED_FILTERS.to);
  expect(capturedUrl.searchParams.get("action")).toBe(SEED_FILTERS.action);
  expect(capturedUrl.searchParams.get("entityType")).toBe(SEED_FILTERS.entityType);

  // Exactly one new export_csv row, with metadata.filters mirroring the seed.
  const newAuditRows = await db
    .select({
      id:       auditLogTable.id,
      metadata: auditLogTable.metadata,
    })
    .from(auditLogTable)
    .where(and(
      eq(auditLogTable.module, "maintenance"),
      eq(auditLogTable.action, "export_csv"),
      eq(auditLogTable.entityType, "maintenance_history"),
      eq(auditLogTable.companyId, testCompanyId!),
      gte(auditLogTable.createdAt, replayAuditAnchor!),
    ));
  expect(newAuditRows).toHaveLength(1);
  const newMeta = (newAuditRows[0].metadata ?? {}) as Record<string, unknown>;
  expect(newMeta.format).toBe("csv");
  const newFilters = (newMeta.filters ?? {}) as Record<string, unknown>;
  expect(newFilters.from).toBe(SEED_FILTERS.from);
  expect(newFilters.to).toBe(SEED_FILTERS.to);
  expect(newFilters.action).toBe(SEED_FILTERS.action);
  expect(newFilters.entityType).toBe(SEED_FILTERS.entityType);

  for (const r of newAuditRows) seededAuditIds.push(r.id);
});
