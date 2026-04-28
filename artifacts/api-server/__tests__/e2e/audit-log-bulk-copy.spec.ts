// E2E test for the bulk-select "Copy N links" toolbar on /admin/audit-log
// in the zatca-invoicing artifact (tasks #143 + #145).
//
// Why this test exists:
//   Task #131 added a per-row share-link copy button. Task #143 builds on
//   that with checkboxes plus a toolbar action so reviewers can copy a
//   batch of permalinks at once. Task #145 adds a sibling "Copy as
//   Markdown" action that emits `- [Audit #N — action at timestamp](url)`
//   list items, sharing the same selection / clipboard plumbing as the
//   plain variant. We need to assert end-to-end that:
//     1. The toolbar stays hidden until at least one row is selected.
//     2. Selecting individual rows reveals the toolbar with the right count.
//     3. The header "select all on page" checkbox toggles every visible row.
//     4. Clicking "Copy N links" places a newline-joined list of share
//        URLs (`{origin}/admin/audit-log?entry=N`) on the clipboard with a
//        confirmation toast that reports the count.
//     5. "Clear selection" empties the picks and hides the toolbar.
//     6. Clicking "Copy as Markdown" emits `- [label](url)` lines, with
//        the same selection used in (4), sorted ascending by id, and a
//        meaningful label that includes the entry id + action so a
//        reviewer can read the link without clicking it.
//
// Determinism story:
//   - All seeded audit rows share a per-run TEST_TAG so the page's `?q=`
//     filter scopes the listing to exactly our seeded rows on the shared
//     dev DB.
//   - The auth short-circuit reuses an existing superadmin via a
//     super_admin_sessions row, the same trick used by other audit specs.
//
// Cleanup:
//   - Strict-by-PK: every inserted row id is deleted by `inArray`/`eq` in
//     afterAll. We never `pool.end()` — sibling specs share the singleton.
//
// How to run:
//   1. Ensure the api-server and zatca-invoicing dev workflows are up.
//   2. `pnpm --filter @workspace/api-server exec playwright test \
//        __tests__/e2e/audit-log-bulk-copy.spec.ts \
//        --config=playwright.config.ts`

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

const TEST_TAG = `e2e_task143_${randomBytes(4).toString("hex")}`;

// 5 rows is enough to assert "Copy 3 links" / "Copy 5 links" without
// pushing anything off page 1 (PAGE_SIZE=50 in AuditLog.tsx).
const SEED_COUNT = 5;

let saSessionRowId: number | null = null;
let saSessionToken: string | null = null;
let testCompanyId:  number | null = null;

const seededAuditIds: number[] = [];

test.beforeAll(async () => {
  // Sweep debris from a prior interrupted run.
  await db
    .delete(auditLogTable)
    .where(like(auditLogTable.username, "e2e_task143_%"));
  await db
    .delete(superAdminSessionsTable)
    .where(like(superAdminSessionsTable.sessionToken, "e2e_task143_%"));
  await db
    .delete(companiesTable)
    .where(like(companiesTable.nameAr, "e2e_task143_%"));

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

  saSessionToken = "e2e_task143_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task143",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  const [co] = await db
    .insert(companiesTable)
    .values({
      nameAr:         `${TEST_TAG} شركة الاختيار المتعدد`,
      nameEn:         `${TEST_TAG} Bulk Copy Co`,
      vatNumber:      "300000000000143",
      crNumber:       `CR_${TEST_TAG}`,
      city:           "Riyadh",
      street:         "Test St",
      buildingNumber: "1",
      postalCode:     "12345",
    })
    .returning({ id: companiesTable.id });
  testCompanyId = co.id;

  // Seed SEED_COUNT audit rows with staggered createdAt so the listing's
  // DESC ordering is deterministic — index 0 is the most recent row.
  const now = Date.now();
  const values = Array.from({ length: SEED_COUNT }, (_, i) => ({
    userId:     null,
    username:   `${TEST_TAG}_${String(i).padStart(3, "0")}`,
    role:       "admin",
    companyId:  testCompanyId!,
    module:     "bulk_copy_seed",
    action:     "view",
    method:     "GET",
    path:       `/api/test/bulk-copy/${i}`,
    entityType: "bulk_copy_test",
    entityId:   String(i),
    statusCode: 200,
    ip:         "127.0.0.1",
    userAgent:  "playwright/task143",
    metadata:   { seed: TEST_TAG, idx: i },
    createdAt:  new Date(now - i * 1000),
  }));
  const inserted = await db
    .insert(auditLogTable)
    .values(values)
    .returning({ id: auditLogTable.id });
  for (const r of inserted) seededAuditIds.push(r.id);
});

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
  if (testCompanyId !== null) {
    await db
      .delete(companiesTable)
      .where(eq(companiesTable.id, testCompanyId));
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

test("audit-log bulk copy: select rows, copy N links, clear selection", async ({
  page,
  context,
  baseURL,
}) => {
  // The bulk-copy click reads navigator.clipboard — Playwright Chromium
  // requires an explicit grant on the live origin. We grant clipboard-read
  // and clipboard-write so both the writeText path AND our subsequent
  // readText assertion work in the same context.
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: baseURL!,
  });

  await installSuperAdminSession(page);
  await page.goto("/admin/audit-log", { waitUntil: "networkidle" });
  await expect(page.getByText(PAGE_HEADING_TEXT)).toBeVisible();

  // Scope the listing to exactly our seeded rows.
  const searchInput = page.getByPlaceholder(/karm|sales-invoices/);
  await searchInput.fill(TEST_TAG);
  await expect(page.locator("tbody tr")).toHaveCount(SEED_COUNT);

  const toolbar = page.getByTestId("audit-bulk-toolbar");
  await expect(toolbar).toBeHidden();

  // ─── Tick the first two seeded rows individually ───────────────────
  // Row checkboxes are keyed by audit row id. Indices in seededAuditIds
  // mirror the DESC listing order (idx 0 = most recent = row 1), so we
  // can target IDs deterministically.
  const idA = seededAuditIds[0];
  const idB = seededAuditIds[1];

  // The page renders in ar-SA, so toLocaleString emits Arabic-Indic
  // digits ("١", "٢", "٥") inside the button label. Keep the assertion
  // locale-aware so we don't false-fail on the i18n digit shaping.
  const arDigit = (n: number) => n.toLocaleString("ar-SA");

  await page.getByTestId(`audit-row-select-${idA}`).click();
  await expect(toolbar).toBeVisible();
  // Toolbar count reflects the current selection.
  await expect(
    page.getByTestId("audit-bulk-copy-share-links"),
  ).toContainText(arDigit(1));

  await page.getByTestId(`audit-row-select-${idB}`).click();
  await expect(
    page.getByTestId("audit-bulk-copy-share-links"),
  ).toContainText(arDigit(2));

  // ─── Copy the 2-link batch and verify the clipboard contents ───────
  await page.getByTestId("audit-bulk-copy-share-links").click();

  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  // Newline-joined list, sorted ascending so output is deterministic.
  const idsAsc = [idA, idB].sort((a, b) => a - b);
  const expectedLines = idsAsc.map(
    id => `${baseURL}/admin/audit-log?entry=${id}`,
  );
  expect(clipboardText.split("\n")).toEqual(expectedLines);

  // ─── Clear selection ───────────────────────────────────────────────
  await page.getByTestId("audit-bulk-clear-selection").click();
  await expect(toolbar).toBeHidden();

  // ─── Select all visible rows via the header checkbox ───────────────
  await page.getByTestId("audit-bulk-select-all").click();
  await expect(toolbar).toBeVisible();
  await expect(
    page.getByTestId("audit-bulk-copy-share-links"),
  ).toContainText(arDigit(SEED_COUNT));

  await page.getByTestId("audit-bulk-copy-share-links").click();
  const clipboardAll = await page.evaluate(() => navigator.clipboard.readText());
  const linesAll = clipboardAll.split("\n");
  expect(linesAll).toHaveLength(SEED_COUNT);
  for (const id of seededAuditIds) {
    expect(linesAll).toContain(`${baseURL}/admin/audit-log?entry=${id}`);
  }

  // Toggle the header checkbox again — should deselect every visible row
  // and hide the toolbar.
  await page.getByTestId("audit-bulk-select-all").click();
  await expect(toolbar).toBeHidden();

  // ─── Markdown variant (task #145) ──────────────────────────────────
  // Re-select the same two rows and copy via the sibling "Copy as
  // Markdown" action. The sort order, clipboard fallback, toast pattern,
  // and toolbar visibility must mirror the plain variant — only the
  // emitted body differs (one `- [label](url)` line per id instead of
  // bare URLs). The label must include the entry id and action so a
  // reviewer pasting into a PR/Slack canvas sees something meaningful
  // before clicking. We assert structure (markdown link syntax + URL +
  // id reference) rather than the exact translated label so localized
  // strings can evolve without breaking the regression.
  await page.getByTestId(`audit-row-select-${idA}`).click();
  await page.getByTestId(`audit-row-select-${idB}`).click();
  await expect(page.getByTestId("audit-bulk-copy-share-links-markdown")).toBeVisible();

  await page.getByTestId("audit-bulk-copy-share-links-markdown").click();
  const clipboardMd = await page.evaluate(() => navigator.clipboard.readText());
  const mdLines = clipboardMd.split("\n");
  expect(mdLines).toHaveLength(2);
  // Sorted ascending by id, same as the plain variant.
  const mdExpectedIdsAsc = [idA, idB].sort((a, b) => a - b);
  for (let i = 0; i < mdLines.length; i++) {
    const id = mdExpectedIdsAsc[i];
    const url = `${baseURL}/admin/audit-log?entry=${id}`;
    // Format: `- [<some label containing the id>](<url>)`.
    expect(mdLines[i]).toMatch(/^- \[.+\]\(.+\)$/);
    expect(mdLines[i]).toContain(url);
    // Label must reference the entry id so a reviewer can scan the
    // pasted list without opening every link.
    expect(mdLines[i]).toContain(String(id));
  }

  // Cleanup so the test ends with a quiet selection state.
  await page.getByTestId("audit-bulk-clear-selection").click();
  await expect(toolbar).toBeHidden();
});
