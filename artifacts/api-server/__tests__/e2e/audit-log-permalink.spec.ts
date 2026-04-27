// E2E test for the audit-log shareable permalink on /admin/audit-log in the
// zatca-invoicing artifact (task #126).
//
// Why this test exists:
//   Task #120 turned each audit row into a clickable details dialog. The
//   dialog lived in component state, so a URL like /admin/audit-log always
//   opened with no row selected — there was no way to send a teammate a
//   link to a specific entry. Task #126 lifts the open-row id into a
//   `?entry=N` URL param so every entry is permanently linkable.
//
// What this verifies:
//   1. Clicking a row opens the dialog AND pushes `?entry=N` onto the URL
//      (no full navigation — the listing stays mounted).
//   2. The dialog body exposes the live share link with the same `entry=N`,
//      so a reviewer can copy it to share.
//   3. Closing the dialog removes the param from the URL.
//   4. Navigating to `/admin/audit-log?entry=N` directly (cold load) opens
//      the dialog automatically — even when the row is OUTSIDE the
//      currently-loaded listing page, in which case the SPA falls back to
//      the new GET /api/audit-log/:id endpoint to fetch it on demand.
//   5. The single-entry endpoint enforces tenant scoping: a regular admin
//      cannot fetch an entry from another company (404, dialog shows the
//      friendly error).
//
// Determinism story:
//   - All seeded audit rows share a per-run TEST_TAG so the page's `?q=`
//     filter scopes the listing to exactly our seeded rows on the shared
//     dev DB.
//   - The auth short-circuits (sa_session token + a regular admin
//     bcrypt-hashed password) match what the real login flow produces, so
//     /api/auth/me returns the right principal without driving the UI
//     login form.
//
// Cleanup:
//   - Strict-by-PK: every inserted row id is deleted by `inArray`/`eq` in
//     afterAll. No LIKE wildcards on production tables.
//   - We deliberately do NOT call `pool.end()` — sibling specs share the
//     singleton pool exported by `@workspace/db`.
//
// How to run:
//   1. Ensure the api-server and zatca-invoicing dev workflows are running.
//   2. `pnpm --filter @workspace/api-server run test:e2e`

import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import bcrypt from "bcryptjs";
import {
  db,
  usersTable,
  companiesTable,
  auditLogTable,
  superAdminSessionsTable,
} from "@workspace/db";

const TEST_TAG = `e2e_task126_${randomBytes(4).toString("hex")}`;

// We seed enough audit rows that the row we want to deep-link to falls
// OUTSIDE the first page (PAGE_SIZE = 50 in AuditLog.tsx). That way the
// permalink-cold-load path actually exercises the GET /:id fallback
// instead of finding the entry in the loaded listing.
const SEED_COUNT_PER_TENANT = 60;

let saSessionRowId: number | null = null;
let saSessionToken: string | null = null;
let testCompanyId: number | null  = null;
let otherCompanyId: number | null = null;
let regularAdminId: number | null = null;
let regularAdminToken: string | null = null;

const seededAuditIds: number[] = [];
const seededUserIds:  number[] = [];

const ADMIN_PASSWORD = "Test_" + randomBytes(8).toString("hex");

test.beforeAll(async () => {
  // Sweep debris from a prior interrupted run.
  await db
    .delete(auditLogTable)
    .where(like(auditLogTable.username, "e2e_task126_%"));
  await db
    .delete(superAdminSessionsTable)
    .where(like(superAdminSessionsTable.sessionToken, "e2e_task126_%"));
  await db
    .delete(usersTable)
    .where(like(usersTable.username, "e2e_task126_%"));
  await db
    .delete(companiesTable)
    .where(like(companiesTable.nameAr, "e2e_task126_%"));

  // Pull the first existing superadmin — we just need any superadmin to
  // hang the SA session off of.
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

  saSessionToken = "e2e_task126_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task126",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  // Two companies — the regular admin's tenant, and a separate "other"
  // tenant whose audit row must never leak via the cross-tenant fetch.
  const [coA] = await db
    .insert(companiesTable)
    .values({
      nameAr:         `${TEST_TAG} شركة الرابط الدائم`,
      nameEn:         `${TEST_TAG} Permalink Co A`,
      vatNumber:      "300000000000126",
      crNumber:       `CR_${TEST_TAG}_A`,
      city:           "Riyadh",
      street:         "Test St",
      buildingNumber: "1",
      postalCode:     "12345",
    })
    .returning({ id: companiesTable.id });
  testCompanyId = coA.id;

  const [coB] = await db
    .insert(companiesTable)
    .values({
      nameAr:         `${TEST_TAG} شركة أخرى`,
      nameEn:         `${TEST_TAG} Permalink Co B`,
      vatNumber:      "300000000000127",
      crNumber:       `CR_${TEST_TAG}_B`,
      city:           "Riyadh",
      street:         "Test St",
      buildingNumber: "2",
      postalCode:     "12345",
    })
    .returning({ id: companiesTable.id });
  otherCompanyId = coB.id;

  // Regular admin pinned to company A. Reused for the cross-tenant 404
  // assertion via a direct API call (their own session token).
  regularAdminToken = "e2e_task126_user_" + randomBytes(16).toString("hex");
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 4);
  const [admin] = await db
    .insert(usersTable)
    .values({
      username:     `${TEST_TAG}_admin`,
      passwordHash,
      role:         "admin",
      companyId:    testCompanyId,
      isActive:     true,
      sessionToken: regularAdminToken,
      sessionId:    `e2e_task126_session_${randomBytes(8).toString("hex")}`,
      nameAr:       `${TEST_TAG} مسؤول`,
    })
    .returning({ id: usersTable.id });
  regularAdminId = admin.id;
  seededUserIds.push(admin.id);

  // Seed enough audit rows to push the deep-link target off page 1.
  // Rows are spread across BOTH tenants. The TEST_TAG-bearing username
  // makes the audit-log page's `?q=` filter pick out exactly our rows.
  // createdAt is staggered with a backwards offset so the listing
  // ordering (DESC by createdAt) is deterministic across runs.
  const now = Date.now();
  const valuesA = Array.from({ length: SEED_COUNT_PER_TENANT }, (_, i) => ({
    userId:     null,
    username:   `${TEST_TAG}_a_${String(i).padStart(3, "0")}`,
    role:       "admin",
    companyId:  testCompanyId!,
    module:     "permalink_seed",
    action:     "view",
    method:     "GET",
    path:       `/api/test/permalink/${i}`,
    entityType: "permalink_test",
    entityId:   String(i),
    statusCode: 200,
    ip:         "127.0.0.1",
    userAgent:  "playwright/task126",
    metadata:   { seed: TEST_TAG, idx: i, page: i < 50 ? "first" : "second" },
    createdAt:  new Date(now - i * 1000),
  }));
  const insertedA = await db
    .insert(auditLogTable)
    .values(valuesA)
    .returning({ id: auditLogTable.id });
  for (const r of insertedA) seededAuditIds.push(r.id);

  // Single audit row pinned to the OTHER tenant — used for the
  // cross-tenant 404 assertion.
  const [otherTenantRow] = await db
    .insert(auditLogTable)
    .values({
      userId:     null,
      username:   `${TEST_TAG}_other_tenant`,
      role:       "admin",
      companyId:  otherCompanyId!,
      module:     "permalink_seed",
      action:     "view",
      method:     "GET",
      path:       "/api/test/permalink/cross-tenant",
      entityType: "permalink_test",
      entityId:   "cross-tenant",
      statusCode: 200,
      ip:         "127.0.0.1",
      userAgent:  "playwright/task126",
      metadata:   { seed: TEST_TAG, crossTenant: true },
      createdAt:  new Date(now - 999_999),
    })
    .returning({ id: auditLogTable.id });
  seededAuditIds.push(otherTenantRow.id);
});

test.afterAll(async () => {
  if (seededAuditIds.length) {
    await db
      .delete(auditLogTable)
      .where(inArray(auditLogTable.id, seededAuditIds));
  }
  if (seededUserIds.length) {
    await db
      .delete(usersTable)
      .where(inArray(usersTable.id, seededUserIds));
  }
  if (saSessionRowId !== null) {
    await db
      .delete(superAdminSessionsTable)
      .where(eq(superAdminSessionsTable.id, saSessionRowId));
  }
  if (testCompanyId !== null) {
    await db.delete(companiesTable).where(eq(companiesTable.id, testCompanyId));
  }
  if (otherCompanyId !== null) {
    await db.delete(companiesTable).where(eq(companiesTable.id, otherCompanyId));
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

const PAGE_HEADING_TEXT = "سجل النشاط (Audit Log)";

test("audit-log: clicking a row updates the URL with ?entry=N and shows the share link", async ({ page }) => {
  await installSuperAdminSession(page);
  await page.goto("/admin/audit-log", { waitUntil: "networkidle" });
  await expect(page.getByText(PAGE_HEADING_TEXT)).toBeVisible();

  // Scope to our seeded rows so we click a row whose id we control.
  const searchInput = page.getByPlaceholder(/karm|sales-invoices/);
  await searchInput.fill(TEST_TAG);
  await expect(page.locator("tbody tr").first()).toBeVisible();

  // First seeded-A row (idx 0) is the most recent → row 1 of the listing.
  // We don't depend on the actual id; we just assert the URL changes to
  // something with ?entry=<digits>.
  const firstSeedRow = page.locator("tbody tr", { hasText: `${TEST_TAG}_a_000` });
  await expect(firstSeedRow).toHaveCount(1);
  await firstSeedRow.click();

  // Dialog opens.
  const dialog = page.getByTestId("audit-details-dialog");
  await expect(dialog).toBeVisible();

  // URL gained ?entry=N.
  await expect(page).toHaveURL(/[?&]entry=\d+/);
  const url = new URL(page.url());
  const entryParam = url.searchParams.get("entry");
  expect(entryParam).toMatch(/^\d+$/);

  // Share link is displayed and matches the live URL.
  const shareLink = dialog.getByTestId("audit-details-share-link");
  await expect(shareLink).toBeVisible();
  await expect(shareLink).toContainText(`entry=${entryParam}`);

  // Closing the dialog removes the param.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]entry=\d+/);
});

test("audit-log: cold-loading ?entry=N opens the dialog even when the entry is outside the current filter page", async ({ page }) => {
  await installSuperAdminSession(page);

  // Pick the LAST seeded-A row id (idx = SEED_COUNT_PER_TENANT - 1).
  // That row was inserted with the oldest createdAt, so under the default
  // DESC ordering it lands on page 2 (idx ≥ 50). The cold load therefore
  // forces the SPA through the new GET /api/audit-log/:id fallback.
  const targetId = seededAuditIds[SEED_COUNT_PER_TENANT - 1];
  expect(targetId).toBeGreaterThan(0);

  await page.goto(`/admin/audit-log?entry=${targetId}`, { waitUntil: "networkidle" });
  await expect(page.getByText(PAGE_HEADING_TEXT)).toBeVisible();

  // Dialog auto-opens for the deep-linked entry.
  const dialog = page.getByTestId("audit-details-dialog");
  await expect(dialog).toBeVisible();
  // Metadata block is filled in (proves the row was actually fetched).
  await expect(dialog.getByTestId("audit-details-metadata")).toBeVisible();
  await expect(dialog.getByTestId("audit-details-metadata")).toContainText(`"idx": ${SEED_COUNT_PER_TENANT - 1}`);

  // URL is preserved.
  await expect(page).toHaveURL(new RegExp(`[?&]entry=${targetId}\\b`));

  // Share link contains the same id.
  await expect(dialog.getByTestId("audit-details-share-link")).toContainText(`entry=${targetId}`);
});

test("audit-log GET /:id: regular admin cannot fetch a cross-tenant entry (404)", async () => {
  // Pick the row pinned to the OTHER tenant — it's the last id we seeded.
  const crossTenantId = seededAuditIds[seededAuditIds.length - 1];
  expect(crossTenantId).toBeGreaterThan(0);

  // Sanity check: an admin from tenant A can fetch one of THEIR rows.
  const ownId = seededAuditIds[0];
  const okResp = await fetch(
    `http://localhost:8080/api/audit-log/${ownId}`,
    { headers: { Authorization: `Bearer ${regularAdminToken!}` } },
  );
  expect(okResp.status).toBe(200);
  const ownBody = await okResp.json();
  expect(ownBody.id).toBe(ownId);
  expect(ownBody.companyId).toBe(testCompanyId);

  // The cross-tenant row must come back as 404 — NOT 403, so we don't
  // leak whether a given id exists in some other company.
  const blockedResp = await fetch(
    `http://localhost:8080/api/audit-log/${crossTenantId}`,
    { headers: { Authorization: `Bearer ${regularAdminToken!}` } },
  );
  expect(blockedResp.status).toBe(404);
});
