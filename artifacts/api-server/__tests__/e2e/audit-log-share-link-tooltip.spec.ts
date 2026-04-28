// E2E test for the entity-aware share-link tooltip / aria-label on the
// per-row copy button on /admin/audit-log (task #154 — coverage added by
// task #157, extended by task #162 to also cover the audit-details
// dialog's share-link button).
//
// Why this test exists:
//   Task #131 added a per-row share-link copy button to the audit-log
//   listing. Task #154 then made that button's tooltip / aria-label
//   entity-aware: instead of the generic "Copy link to this entry" the
//   button announces what record the reviewer is about to share — e.g.
//   "Copy link to invoice #45" / "نسخ رابط فاتورة #45". The label flows
//   through `shareLinkLabelForRow` which routes the row's `entityType`
//   through the `auditLog.entityTypes.*` translation registry (the same
//   registry the bulk Markdown copy in task #148 uses), and falls back
//   to the generic key when the row carries no `entityType`.
//
//   Task #162 then made the IDENTICAL button inside the audit-details
//   dialog (testId `audit-details-copy-share-link`) use the same
//   `shareLinkLabelForRow` helper so the two surfaces stay consistent —
//   previously the dialog button always rendered the generic
//   "Copy link to this entry" regardless of entityType, which was
//   confusing for a reviewer hovering the dialog icon.
//
//   There was no automated coverage for either label, so a future
//   refactor of `shareLinkLabelForRow` or the `entityTypes` registry
//   could silently regress the tooltip until a reviewer happened to
//   hover one in production. This spec locks down both the entity-aware
//   and the fallback shapes, in both Arabic (default) and English
//   locales, on BOTH the per-row button and the dialog button, and
//   re-asserts that the per-row click still copies the bare share URL
//   so the cosmetic change didn't break the underlying behavior.
//
// What this verifies:
//   1. Arabic (default locale)
//      • Row with entityType="invoice", entityId="45" — the per-row
//        share-link button's `aria-label` AND `title` read
//        "نسخ رابط فاتورة #45" (via `entityTypes.invoice` → "فاتورة" +
//        the `copyShareLinkWithEntity` template).
//      • Row with no entityType — the per-row button falls back to the
//        generic "نسخ رابط هذا السجل" (via `copyShareLink`).
//      • Clicking the entity row's button still places the bare share
//        URL (`{origin}/admin/audit-log?entry=N`) on the clipboard, so
//        the cosmetic label change didn't alter the copied payload.
//      • Opening each row's details dialog and inspecting its
//        `audit-details-copy-share-link` button yields the SAME
//        entity-aware / generic labels — i.e. the dialog button now
//        mirrors the per-row button (task #162).
//   2. English (forced via `app:lang=en`)
//      • Same row pair, English copies: "Copy link to invoice #45" and
//        "Copy link to this entry", asserted on both the per-row button
//        and the dialog button.
//
// Determinism story:
//   - Both seeded audit rows share a per-run TEST_TAG so the page's
//     `?q=` filter scopes the listing to exactly our two rows on the
//     shared dev DB. createdAt is staggered so the listing's
//     DESC-by-createdAt ordering is stable across runs.
//   - The auth short-circuit reuses an existing superadmin via a
//     super_admin_sessions row, the same trick used by the sibling
//     audit-log specs.
//
// Cleanup:
//   - Strict-by-PK: every inserted row id is deleted by `inArray`/`eq`
//     in afterAll. No LIKE wildcards on production tables. We
//     deliberately do NOT call `pool.end()` — sibling specs share the
//     singleton pool exported by `@workspace/db`.
//
// How to run:
//   1. Ensure the api-server and zatca-invoicing dev workflows are up.
//   2. `pnpm --filter @workspace/api-server exec playwright test \
//        __tests__/e2e/audit-log-share-link-tooltip.spec.ts \
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

const TEST_TAG = `e2e_task157_${randomBytes(4).toString("hex")}`;

// Two seeded rows: one with entityType + entityId (invoice #45), one
// with no entityType so we can assert the fallback label.
const SEED_ENTITY_USERNAME      = `${TEST_TAG}_entity`;
const SEED_NO_ENTITY_USERNAME   = `${TEST_TAG}_noentity`;
const SEED_ENTITY_TYPE          = "invoice";
const SEED_ENTITY_ID            = "45";

// Friendly entity labels registered in the i18n catalogues for
// entityType="invoice". Sourced from
// artifacts/zatca-invoicing/src/i18n/locales/{ar,en}.json under
// adminPages.auditLog.entityTypes.invoice. Hard-coding the expected
// Arabic / English noun keeps this regression spec independent of the
// SPA's runtime translation lookup — if either copy or the upstream
// `shareLinkLabelForRow` helper changes, this assertion catches it.
const EXPECTED_ENTITY_AR = "فاتورة";
const EXPECTED_ENTITY_EN = "invoice";

// Expected button labels — must mirror `copyShareLink` /
// `copyShareLinkWithEntity` in the i18n catalogues. The `#${id}` suffix
// only appears when the row has BOTH an entityType AND an entityId
// (matches the helper in AuditLog.tsx).
const EXPECTED_LABEL_ENTITY_AR    = `نسخ رابط ${EXPECTED_ENTITY_AR} #${SEED_ENTITY_ID}`;
const EXPECTED_LABEL_NO_ENTITY_AR = "نسخ رابط هذا السجل";
const EXPECTED_LABEL_ENTITY_EN    = `Copy link to ${EXPECTED_ENTITY_EN} #${SEED_ENTITY_ID}`;
const EXPECTED_LABEL_NO_ENTITY_EN = "Copy link to this entry";

let saSessionRowId: number | null = null;
let saSessionToken: string | null = null;
let testCompanyId:  number | null = null;

let entityRowId:    number | null = null;
let noEntityRowId:  number | null = null;
const seededAuditIds: number[]    = [];

test.beforeAll(async () => {
  // Sweep debris from a prior interrupted run.
  await db
    .delete(auditLogTable)
    .where(like(auditLogTable.username, "e2e_task157_%"));
  await db
    .delete(superAdminSessionsTable)
    .where(like(superAdminSessionsTable.sessionToken, "e2e_task157_%"));
  await db
    .delete(companiesTable)
    .where(like(companiesTable.nameAr, "e2e_task157_%"));

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

  saSessionToken = "e2e_task157_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task157",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  const [co] = await db
    .insert(companiesTable)
    .values({
      nameAr:         `${TEST_TAG} شركة وسم الرابط`,
      nameEn:         `${TEST_TAG} Share-Link Tooltip Co`,
      vatNumber:      "300000000000157",
      crNumber:       `CR_${TEST_TAG}`,
      city:           "Riyadh",
      street:         "Test St",
      buildingNumber: "1",
      postalCode:     "12345",
    })
    .returning({ id: companiesTable.id });
  testCompanyId = co.id;

  // Stagger createdAt so the entity row sorts ABOVE the no-entity row in
  // the DESC listing (idx 0 = newest). We don't actually rely on order
  // for the assertions (they're keyed by row id) but a stable order
  // makes the rendered table easier to reason about when debugging.
  const now = Date.now();

  const [entityRow] = await db
    .insert(auditLogTable)
    .values({
      userId:     null,
      username:   SEED_ENTITY_USERNAME,
      role:       "admin",
      companyId:  testCompanyId!,
      module:     "share_link_tooltip_seed",
      action:     "view",
      method:     "GET",
      path:       "/api/test/share-link-tooltip/entity",
      entityType: SEED_ENTITY_TYPE,
      entityId:   SEED_ENTITY_ID,
      statusCode: 200,
      ip:         "127.0.0.1",
      userAgent:  "playwright/task157",
      metadata:   { seed: TEST_TAG, shape: "entity" },
      createdAt:  new Date(now),
    })
    .returning({ id: auditLogTable.id });
  entityRowId = entityRow.id;
  seededAuditIds.push(entityRow.id);

  const [noEntityRow] = await db
    .insert(auditLogTable)
    .values({
      userId:     null,
      username:   SEED_NO_ENTITY_USERNAME,
      role:       "admin",
      companyId:  testCompanyId!,
      module:     "share_link_tooltip_seed",
      action:     "view",
      method:     "GET",
      path:       "/api/test/share-link-tooltip/no-entity",
      // Both null so we exercise the early-return fallback branch in
      // `shareLinkLabelForRow`.
      entityType: null,
      entityId:   null,
      statusCode: 200,
      ip:         "127.0.0.1",
      userAgent:  "playwright/task157",
      metadata:   { seed: TEST_TAG, shape: "no-entity" },
      createdAt:  new Date(now - 1000),
    })
    .returning({ id: auditLogTable.id });
  noEntityRowId = noEntityRow.id;
  seededAuditIds.push(noEntityRow.id);
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

// Default Arabic locale — the SPA boots in `ar` when no `app:lang` key
// is present in localStorage (see artifacts/zatca-invoicing/src/i18n/index.ts).
async function installSuperAdminSession(page: Page): Promise<void> {
  await page.addInitScript(
    ({ token, sessionId }) => {
      localStorage.setItem("zatca_token", token);
      localStorage.setItem("zatca_session", sessionId);
    },
    { token: saSessionToken!, sessionId: `sa-${saSessionRowId!}` },
  );
}

// English variant — seeds `app:lang=en` so `getInitialLang()` picks
// English on first paint. Mirrors the helper in
// audit-log-export-inspector-en.spec.ts so behavior stays consistent
// across the audit-log English specs.
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

const PAGE_HEADING_TEXT_AR = "سجل النشاط (Audit Log)";
const PAGE_HEADING_TEXT_EN = "Activity Log (Audit Log)";

test("audit-log share-link tooltip (AR): entity row announces 'نسخ رابط فاتورة #45', entity-less row falls back to the generic label, click still copies the bare URL", async ({
  page,
  context,
  baseURL,
}) => {
  // The per-row click reads navigator.clipboard — Playwright Chromium
  // requires an explicit grant on the live origin so both writeText
  // (during the click) and our subsequent readText assertion succeed.
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: baseURL!,
  });

  await installSuperAdminSession(page);
  await page.goto("/admin/audit-log", { waitUntil: "networkidle" });
  await expect(page.getByText(PAGE_HEADING_TEXT_AR)).toBeVisible();

  // Scope the listing to exactly our two seeded rows.
  const searchInput = page.getByPlaceholder(/karm|sales-invoices/);
  await searchInput.fill(TEST_TAG);
  await expect(page.locator("tbody tr")).toHaveCount(2);

  // ── Entity row ────────────────────────────────────────────────────
  const entityCopyBtn = page.getByTestId(`audit-row-copy-share-link-${entityRowId}`);
  await expect(entityCopyBtn).toBeVisible();
  // The CopyIconButton in AuditLog.tsx puts the same friendly label on
  // both `aria-label` (screen readers) and `title` (mouse hover
  // tooltip). We assert both so a future refactor that drops one
  // surface still trips the regression.
  await expect(entityCopyBtn).toHaveAttribute("aria-label", EXPECTED_LABEL_ENTITY_AR);
  await expect(entityCopyBtn).toHaveAttribute("title",      EXPECTED_LABEL_ENTITY_AR);

  // ── Entity-less row ───────────────────────────────────────────────
  const noEntityCopyBtn = page.getByTestId(`audit-row-copy-share-link-${noEntityRowId}`);
  await expect(noEntityCopyBtn).toBeVisible();
  await expect(noEntityCopyBtn).toHaveAttribute("aria-label", EXPECTED_LABEL_NO_ENTITY_AR);
  await expect(noEntityCopyBtn).toHaveAttribute("title",      EXPECTED_LABEL_NO_ENTITY_AR);

  // ── Click still copies the bare URL ───────────────────────────────
  // The label change is purely cosmetic — the underlying clipboard
  // payload must remain `${origin}/admin/audit-log?entry=${id}` so the
  // pasted link still resolves to the entry. We click the entity row's
  // button (the more interesting case — its label changed shape) and
  // verify the clipboard contents directly.
  await entityCopyBtn.click();
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toBe(`${baseURL}/admin/audit-log?entry=${entityRowId}`);

  // ── Dialog share-link button mirrors the per-row label (task #162) ─
  // Open the entity row's details dialog by clicking the row itself
  // (the row has role="button" and an onClick that sets selectedId).
  // The dialog's `audit-details-copy-share-link` button must now use
  // the same entity-aware label as the per-row button instead of the
  // generic "Copy link to this entry" it used before task #162.
  const entityRow = page
    .getByTestId("audit-row")
    .filter({ has: page.getByTestId(`audit-row-copy-share-link-${entityRowId}`) });
  await entityRow.click();
  const dialog = page.getByTestId("audit-details-dialog");
  await expect(dialog).toBeVisible();
  const dialogCopyBtn = dialog.getByTestId("audit-details-copy-share-link");
  await expect(dialogCopyBtn).toBeVisible();
  await expect(dialogCopyBtn).toHaveAttribute("aria-label", EXPECTED_LABEL_ENTITY_AR);
  await expect(dialogCopyBtn).toHaveAttribute("title",      EXPECTED_LABEL_ENTITY_AR);
  // Close so the next assertion isn't intercepted by the open dialog.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Now verify the entity-less row's dialog button falls back to the
  // generic label, matching the per-row fallback above.
  const noEntityRow = page
    .getByTestId("audit-row")
    .filter({ has: page.getByTestId(`audit-row-copy-share-link-${noEntityRowId}`) });
  await noEntityRow.click();
  await expect(dialog).toBeVisible();
  await expect(dialogCopyBtn).toBeVisible();
  await expect(dialogCopyBtn).toHaveAttribute("aria-label", EXPECTED_LABEL_NO_ENTITY_AR);
  await expect(dialogCopyBtn).toHaveAttribute("title",      EXPECTED_LABEL_NO_ENTITY_AR);
});

test("audit-log share-link tooltip (EN): entity row announces 'Copy link to invoice #45', entity-less row falls back to 'Copy link to this entry'", async ({
  page,
}) => {
  await installSuperAdminSessionEn(page);
  await page.goto("/admin/audit-log", { waitUntil: "networkidle" });
  await expect(page.getByText(PAGE_HEADING_TEXT_EN)).toBeVisible();

  // Scope the listing to exactly our two seeded rows.
  const searchInput = page.getByPlaceholder(/karm|sales-invoices/);
  await searchInput.fill(TEST_TAG);
  await expect(page.locator("tbody tr")).toHaveCount(2);

  // ── Entity row ────────────────────────────────────────────────────
  const entityCopyBtn = page.getByTestId(`audit-row-copy-share-link-${entityRowId}`);
  await expect(entityCopyBtn).toBeVisible();
  await expect(entityCopyBtn).toHaveAttribute("aria-label", EXPECTED_LABEL_ENTITY_EN);
  await expect(entityCopyBtn).toHaveAttribute("title",      EXPECTED_LABEL_ENTITY_EN);

  // ── Entity-less row ───────────────────────────────────────────────
  const noEntityCopyBtn = page.getByTestId(`audit-row-copy-share-link-${noEntityRowId}`);
  await expect(noEntityCopyBtn).toBeVisible();
  await expect(noEntityCopyBtn).toHaveAttribute("aria-label", EXPECTED_LABEL_NO_ENTITY_EN);
  await expect(noEntityCopyBtn).toHaveAttribute("title",      EXPECTED_LABEL_NO_ENTITY_EN);

  // ── Dialog share-link button mirrors the per-row label (task #162) ─
  // English variant of the same dialog assertions added above for
  // Arabic. The dialog button must echo the per-row entity-aware label
  // (entity row) and the generic fallback (entity-less row).
  const entityRow = page
    .getByTestId("audit-row")
    .filter({ has: page.getByTestId(`audit-row-copy-share-link-${entityRowId}`) });
  await entityRow.click();
  const dialog = page.getByTestId("audit-details-dialog");
  await expect(dialog).toBeVisible();
  const dialogCopyBtn = dialog.getByTestId("audit-details-copy-share-link");
  await expect(dialogCopyBtn).toBeVisible();
  await expect(dialogCopyBtn).toHaveAttribute("aria-label", EXPECTED_LABEL_ENTITY_EN);
  await expect(dialogCopyBtn).toHaveAttribute("title",      EXPECTED_LABEL_ENTITY_EN);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  const noEntityRow = page
    .getByTestId("audit-row")
    .filter({ has: page.getByTestId(`audit-row-copy-share-link-${noEntityRowId}`) });
  await noEntityRow.click();
  await expect(dialog).toBeVisible();
  await expect(dialogCopyBtn).toBeVisible();
  await expect(dialogCopyBtn).toHaveAttribute("aria-label", EXPECTED_LABEL_NO_ENTITY_EN);
  await expect(dialogCopyBtn).toHaveAttribute("title",      EXPECTED_LABEL_NO_ENTITY_EN);
});
