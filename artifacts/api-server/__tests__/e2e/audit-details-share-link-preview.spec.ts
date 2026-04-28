// E2E test for the share-link hover/focus preview tooltip rendered inside
// the audit details dialog (task #155, follow-up coverage task #158).
//
// Background:
//   Task #144 added a hover/focus preview to the row-level share-link
//   icon on /admin/audit-log. Task #155 mirrors that preview onto the
//   share-link copy button rendered *inside* `AuditDetailsDialog`, so a
//   reviewer who opens the dialog from a permalink can also hover-confirm
//   id / action / module / timestamp / link before pasting. Without this
//   spec a regression that broke the new `<Tooltip>` wrapper (e.g. lost
//   data-testid, broken click-to-copy, missing field) would slip through CI.
//
// What this verifies:
//   1. Sign in as the SuperAdmin (via the same kind of seeded
//      sa_session row the rest of the audit-log E2E suite uses), open
//      `/admin/audit-log`, scope to a known seeded entry, click it to
//      open the details dialog.
//   2. Hovering the share-link copy button reveals the
//      `audit-details-share-link-preview` tooltip with the same Entry ID /
//      Action / Module / Timestamp / Link grid the row-level preview shows.
//   3. The wrapped CopyIconButton still fires its click-to-copy success
//      toast (regression check that the new <Tooltip> wrapper didn't
//      break the underlying click handler).
//   4. Both LTR (English) and RTL (Arabic) renderings show the right
//      localized labels, including `dir="rtl"` on the tooltip body in
//      Arabic.
//
// Determinism:
//   - One audit row per locale, both seeded with a per-run TEST_TAG so
//     the audit-log page's `?q=` filter scopes the listing to exactly
//     those rows on the shared dev DB.
//   - All seeded ids are tracked for strict-by-PK cleanup. We
//     deliberately do NOT call `pool.end()` — sibling specs share the
//     singleton pool exported by `@workspace/db`.
//
// How to run:
//   1. Ensure the api-server and zatca-invoicing dev workflows are running.
//   2. `pnpm --filter @workspace/api-server run test:e2e -- audit-details-share-link-preview`

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

const TEST_TAG = `e2e_task158_${randomBytes(4).toString("hex")}`;
const SEED_USERNAME_AR = `${TEST_TAG}_ar`;
const SEED_USERNAME_EN = `${TEST_TAG}_en`;
const SEED_MODULE      = `${TEST_TAG}_module`;

let saSessionRowId: number | null = null;
let saSessionToken: string | null = null;
let testCompanyId: number | null  = null;
let seededRowIdAr: number | null  = null;
let seededRowIdEn: number | null  = null;
const seededAuditIds: number[]    = [];

test.beforeAll(async () => {
  // Sweep debris from a prior interrupted run.
  await db
    .delete(auditLogTable)
    .where(like(auditLogTable.username, "e2e_task158_%"));
  await db
    .delete(superAdminSessionsTable)
    .where(like(superAdminSessionsTable.sessionToken, "e2e_task158_%"));
  await db
    .delete(companiesTable)
    .where(like(companiesTable.nameAr, "e2e_task158_%"));

  // Reuse the first existing superadmin to hang the SA session off of —
  // the seedSuperAdmin() bootstrap in api-server's index.ts always
  // creates one (`superadmin` / `SuperAdmin@2026`), and other E2E
  // specs in this directory follow the same pattern.
  const [sa] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.role, "superadmin"))
    .limit(1);
  if (!sa) {
    throw new Error(
      "No superadmin user exists in the DB; seedSuperAdmin() should have created one at api-server boot.",
    );
  }

  saSessionToken = "e2e_task158_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task158",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  const [co] = await db
    .insert(companiesTable)
    .values({
      nameAr:         `${TEST_TAG} شركة معاينة الرابط`,
      nameEn:         `${TEST_TAG} Share Preview Co`,
      vatNumber:      "300000000000158",
      crNumber:       `CR_${TEST_TAG}`,
      city:           "Riyadh",
      street:         "Test St",
      buildingNumber: "1",
      postalCode:     "12345",
    })
    .returning({ id: companiesTable.id });
  testCompanyId = co.id;

  // One audit row per locale — keeping them separate means each locale
  // test can scope by its own TEST_TAG-suffixed username and never race
  // with the other.
  const now = Date.now();
  const [arRow] = await db
    .insert(auditLogTable)
    .values({
      userId:     sa.id,
      username:   SEED_USERNAME_AR,
      role:       "superadmin",
      companyId:  testCompanyId,
      module:     SEED_MODULE,
      action:     "view",
      method:     "GET",
      path:       "/api/test/share-preview/ar",
      entityType: "share_preview_test",
      entityId:   "ar",
      statusCode: 200,
      ip:         "127.0.0.1",
      userAgent:  "playwright/task158",
      metadata:   { seed: TEST_TAG, locale: "ar" },
      createdAt:  new Date(now),
    })
    .returning({ id: auditLogTable.id });
  seededRowIdAr = arRow.id;
  seededAuditIds.push(arRow.id);

  const [enRow] = await db
    .insert(auditLogTable)
    .values({
      userId:     sa.id,
      username:   SEED_USERNAME_EN,
      role:       "superadmin",
      companyId:  testCompanyId,
      module:     SEED_MODULE,
      action:     "view",
      method:     "GET",
      path:       "/api/test/share-preview/en",
      entityType: "share_preview_test",
      entityId:   "en",
      statusCode: 200,
      ip:         "127.0.0.1",
      userAgent:  "playwright/task158",
      metadata:   { seed: TEST_TAG, locale: "en" },
      createdAt:  new Date(now - 1000),
    })
    .returning({ id: auditLogTable.id });
  seededRowIdEn = enRow.id;
  seededAuditIds.push(enRow.id);
});

test.afterAll(async () => {
  if (seededAuditIds.length) {
    await db
      .delete(auditLogTable)
      .where(inArray(auditLogTable.id, seededAuditIds));
  }
  if (testCompanyId !== null) {
    // Belt-and-braces: delete any audit rows that ended up pinned to the
    // test tenant via the seeded SA action above before dropping the row.
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

// Inject the SA session AND force the SPA's i18n into the requested
// locale before the bundle mounts. The i18n module reads `app:lang`
// from localStorage in `getInitialLang()` so seeding it here guarantees
// the right copies render on first paint without us having to drive a
// language switcher.
async function installSuperAdminSession(
  page: Page,
  lang: "ar" | "en",
): Promise<void> {
  await page.addInitScript(
    ({ token, sessionId, lang }) => {
      localStorage.setItem("zatca_token", token);
      localStorage.setItem("zatca_session", sessionId);
      localStorage.setItem("app:lang", lang);
    },
    { token: saSessionToken!, sessionId: `sa-${saSessionRowId!}`, lang },
  );
}

const PAGE_HEADING_AR = "سجل النشاط (Audit Log)";
const PAGE_HEADING_EN = "Activity Log (Audit Log)";

// Shared assertion helper: opens the dialog for the seeded row, hovers
// the share-link copy button, and verifies the preview tooltip shows the
// expected localized labels + field values. The toast assertion lives in
// the caller so we can use the locale's translated success title.
async function openDialogAndCheckPreview(
  page: Page,
  opts: {
    seedUsername: string;
    seedRowId: number;
    headingText: string;
    expectedDir: "rtl" | "ltr";
    expectedTitle: string;
    expectedLabels: { id: string; action: string; module: string; time: string; link: string };
    expectedActionValue: string;
  },
) {
  await page.goto("/admin/audit-log", { waitUntil: "networkidle" });
  await expect(page.getByText(opts.headingText)).toBeVisible();

  // Scope the listing to our single seeded row.
  const searchInput = page.getByPlaceholder(/karm|sales-invoices/);
  await searchInput.fill(opts.seedUsername);
  await expect(page.locator("tbody tr").first()).toBeVisible();

  const seedRow = page.locator("tbody tr", { hasText: opts.seedUsername });
  await expect(seedRow).toHaveCount(1);
  await seedRow.click();

  const dialog = page.getByTestId("audit-details-dialog");
  await expect(dialog).toBeVisible();

  // The share-link block (and its copy button) is always rendered inside
  // the details dialog. Hovering it should reveal the new preview tooltip.
  const copyBtn = dialog.getByTestId("audit-details-copy-share-link");
  await expect(copyBtn).toBeVisible();

  // Hover (and force-show via focus as a belt-and-braces — Radix exposes
  // tooltips on either trigger).
  await copyBtn.hover();
  await copyBtn.focus();

  // Tooltip body — Radix renders tooltips in a portal so we look it up
  // page-wide rather than scoped to the dialog.
  const preview = page.getByTestId("audit-details-share-link-preview");
  await expect(preview).toBeVisible();

  // Direction marker on the tooltip body (the inner <div dir=…>).
  await expect(preview.locator(`div[dir="${opts.expectedDir}"]`).first()).toBeVisible();

  // Localized title and field labels.
  await expect(preview).toContainText(opts.expectedTitle);
  await expect(preview).toContainText(opts.expectedLabels.id);
  await expect(preview).toContainText(opts.expectedLabels.action);
  await expect(preview).toContainText(opts.expectedLabels.module);
  await expect(preview).toContainText(opts.expectedLabels.time);
  await expect(preview).toContainText(opts.expectedLabels.link);

  // Field values: id, friendly action, module verbatim, and live share
  // link with `entry=N`. We don't pin the timestamp string because it
  // depends on the runner's locale formatting; the label assertion above
  // already proves the row is being rendered.
  await expect(preview).toContainText(String(opts.seedRowId));
  await expect(preview).toContainText(opts.expectedActionValue);
  await expect(preview).toContainText(SEED_MODULE);
  await expect(preview).toContainText(`entry=${opts.seedRowId}`);

  return { dialog, copyBtn };
}

test("audit-details share-link preview tooltip renders with Arabic copy + dir=\"rtl\" and click-to-copy still works", async ({ page, context, baseURL }) => {
  // The wrapped CopyIconButton uses navigator.clipboard.writeText for its
  // primary path; without an explicit grant Playwright Chromium rejects
  // the call and the button silently falls through to the execCommand
  // textarea fallback. Granting clipboard-write up front guarantees the
  // success branch (and the toast we assert on below) is the one
  // actually exercised — same pattern as audit-log-bulk-copy.spec.ts.
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: baseURL!,
  });

  await installSuperAdminSession(page, "ar");

  const { copyBtn } = await openDialogAndCheckPreview(page, {
    seedUsername:   SEED_USERNAME_AR,
    seedRowId:      seededRowIdAr!,
    headingText:    PAGE_HEADING_AR,
    expectedDir:    "rtl",
    expectedTitle:  "مشاركة هذا السجل",
    expectedLabels: {
      id:     "رقم السجل",
      action: "الإجراء",
      module: "الوحدة",
      time:   "التاريخ والوقت",
      link:   "الرابط",
    },
    // Friendly Arabic label for the "view" action.
    expectedActionValue: "عرض",
  });

  // Click-to-copy regression check — the new <Tooltip> wrapper must NOT
  // break the inner button's onClick. We assert via the success toast
  // (Arabic copy) which the CopyIconButton fires on a successful write.
  await copyBtn.click();
  await expect(page.getByText("تم النسخ إلى الحافظة").first()).toBeVisible();
});

test("audit-details share-link preview tooltip renders with English copy + dir=\"ltr\" and click-to-copy still works", async ({ page, context, baseURL }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: baseURL!,
  });

  await installSuperAdminSession(page, "en");

  const { copyBtn } = await openDialogAndCheckPreview(page, {
    seedUsername:   SEED_USERNAME_EN,
    seedRowId:      seededRowIdEn!,
    headingText:    PAGE_HEADING_EN,
    expectedDir:    "ltr",
    expectedTitle:  "Share this entry",
    expectedLabels: {
      id:     "Entry ID",
      action: "Action",
      module: "Module",
      time:   "Timestamp",
      link:   "Link",
    },
    // Friendly English label for the "view" action.
    expectedActionValue: "View",
  });

  await copyBtn.click();
  await expect(page.getByText("Copied to clipboard").first()).toBeVisible();
});
