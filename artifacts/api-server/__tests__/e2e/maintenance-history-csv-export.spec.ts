// E2E test for the SuperAdmin maintenance-history "تصدير CSV" button on
// /admin/ai-fix in the zatca-invoicing artifact (task #99).
//
// Why this test exists:
//   /admin/ai-fix has three "تصدير CSV" / "تنزيل CSV" buttons. The
//   email-history one is covered by email-history-csv-export.spec.ts and the
//   recovered-tools one is covered by recovered-tools-panel.spec.ts. The
//   maintenance-history button — driven by `historyCsvMut` in
//   AICompanyFix.tsx and served by GET /api/admin/maintenance/history?format=csv
//   in artifacts/api-server/src/routes/admin.ts — was the only one without
//   automated coverage, so a regression to its filename, BOM, headers, or
//   filter handling would slip through unnoticed. This spec mirrors the
//   capture pattern from the other two.
//
// What this verifies:
//   1. Clicking the maintenance-history "تصدير CSV" button (anchored by its
//      unique title attribute, since all three CSV buttons share the same
//      visible label) downloads a file whose Content-Type is
//      `text/csv; charset=utf-8` and whose Content-Disposition filename
//      follows the documented `maintenance-history-<companyId>-<unix-ms>.csv`
//      pattern.
//   2. The body starts with the UTF-8 BOM (so Excel renders Arabic
//      correctly).
//   3. The header row contains the six documented Arabic columns:
//      التاريخ / المستخدم / الفئة / الإجراء / مدة الاحتفاظ / التفاصيل.
//   4. The seeded audit row appears in the body. We anchor on a unique
//      TEST_TAG-prefixed username so this assertion stays stable on a
//      shared dev DB regardless of what other maintenance audit history
//      already exists for the test company.
//   5. The export itself writes exactly one `export_csv` audit row scoped
//      to the test company under entityType='maintenance_history' (the
//      contract documented inline in admin.ts ~line 4429).
//
// Why we read the CSV bytes through a route handler instead of
// `page.waitForEvent('download')`:
//   - The button JS does `fetch(...)`, reads `.blob()`, then triggers a
//     synthetic anchor click against a `blob:` URL. The fetch response
//     itself is the file the user ends up saving — Playwright's own
//     `response.body()` returns empty once the page JS consumed the
//     response via `.blob()`. Refetching upstream from the route handler,
//     buffering the bytes, then forwarding the same body to the page
//     gives us deterministic access to both the headers and the body.
//
// Determinism story (mirrors the sibling specs):
//   - We create a brand-new `companies` row tagged with a per-run TEST_TAG
//     so the seeded audit row never collides with whatever else lives on
//     the shared dev DB. The /api/admin/companies dropdown is sorted by
//     nameAr, but we always select by exact text — no positional indexing.
//   - The seeded audit row's `username` carries the full TEST_TAG so the
//     CSV-body assertion can pinpoint our row without depending on row
//     counts (the tenant could legitimately accumulate other maintenance
//     audit history during the test if a sibling spec ran first).
//   - The export_csv audit-row lookup is scoped by createdAt >= an anchor
//     captured just before the click, so it matches only the row our click
//     produced (workers=1 in playwright.config.ts so no concurrent runs).
//   - The SuperAdmin auth short-circuit (insert sa_sessions row + write
//     localStorage zatca_token + zatca_session='sa-<id>') matches what
//     the login flow itself produces, so /api/auth/me returns the
//     SuperAdmin and the AICompanyFix route guard renders.
//
// Cleanup:
//   - Strict-by-PK: every inserted row id (audit_log, companies,
//     sa_sessions) is deleted by `eq`/`inArray` in afterAll. No LIKE /
//     wildcards on production tables; a crashed run never touches another
//     tenant's data.
//   - We deliberately do NOT call `pool.end()` — see the matching note in
//     email-history-pagination.spec.ts. With workers=1, sibling specs
//     share the singleton pool exported by `@workspace/db`.
//
// How to run:
//   1. Ensure the api-server and zatca-invoicing dev workflows are running.
//   2. `pnpm --filter @workspace/api-server run test:e2e`

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

// ─── Fixtures / state shared across the single test in this file ───────────
const TEST_TAG = `e2e_task99_${randomBytes(4).toString("hex")}`;
// Distinctive username on the seeded audit row — carries the full TEST_TAG
// so the CSV-body assertion can pinpoint our row without colliding with
// other maintenance audit history that may already exist for the test
// company on a shared dev DB.
const SEED_USERNAME = `${TEST_TAG}_admin`;
// The seeded audit row's metadata carries this marker too, so an inspector
// can trace any leftover row in the dev DB back to this spec if cleanup
// ever fails. Not asserted directly — the username is the stable anchor.
const SEED_METADATA = { tag: TEST_TAG, source: "task99-e2e-seed" };

let saSessionRowId: number | null   = null;
let saSessionToken: string | null   = null;
let testCompanyId: number | null    = null;
const seededAuditIds: number[]      = [];
// Captured just before the export click so the audit-row lookup that
// confirms the export_csv row was written can scope its query to this run.
let exportAuditAnchor: Date | null  = null;

// ─── Setup: create company, sa_session, and a seed audit row ───────────────
test.beforeAll(async () => {
  // Sweep any debris from a previous interrupted run before seeding. All
  // three patterns are namespaced strictly to this test (the audit rows
  // tag the username column, the sa_sessions tag the sessionToken column,
  // the companies tag the nameAr column), so this can never touch real
  // audit history, real user sessions, or real tenant rows.
  await db
    .delete(auditLogTable)
    .where(like(auditLogTable.username, "e2e_task99_%"));
  await db
    .delete(superAdminSessionsTable)
    .where(like(superAdminSessionsTable.sessionToken, "e2e_task99_%"));
  await db
    .delete(companiesTable)
    .where(like(companiesTable.nameAr, "e2e_task99_%"));

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
  saSessionToken = "e2e_task99_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task99",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  // Active test company so it's listable in /api/admin/companies (which
  // SELECTs the whole table without status filter, but the dropdown still
  // appends "(<status>)" to non-active labels — keeping it active makes
  // the on-screen label match exactly what we asked for). The Arabic name
  // carries TEST_TAG so the dropdown option text is unique on the page.
  const [co] = await db
    .insert(companiesTable)
    .values({
      nameAr:         `${TEST_TAG} شركة الاختبار للسجل`,
      nameEn:         `${TEST_TAG} Test Co Maint History`,
      vatNumber:      "300000000000099",
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

  // Seed one maintenance audit row scoped to the test company so the
  // history accordion renders a non-empty table — the table is what the
  // export reads from, and the unique username gives us a stable anchor
  // inside the CSV body. action='fix' / entityType='journal_pending'
  // mirrors the production helper logMaint() which the admin endpoints
  // call when a SuperAdmin runs a maintenance fix.
  const [audit] = await db
    .insert(auditLogTable)
    .values({
      userId:     sa.id,
      username:   SEED_USERNAME,
      role:       "superadmin",
      companyId:  testCompanyId,
      module:     "maintenance",
      action:     "fix",
      method:     "POST",
      path:       "/api/admin/maintenance/journal-pending/fix",
      entityType: "journal_pending",
      entityId:   null,
      metadata:   SEED_METADATA,
    })
    .returning({ id: auditLogTable.id });
  seededAuditIds.push(audit.id);
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
  if (testCompanyId !== null) {
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

// Stable anchor for the SuperAdmin AI Company Fix page so we can wait for
// the SPA to settle on the right route before driving the dropdown.
const PAGE_HEADING_RE = /إصلاح مشاكل الشركات بالذكاء الاصطناعي/;

test("maintenance-history CSV export: filename, BOM, headers, seeded row, and export_csv audit row", async ({ page }) => {
  await installSuperAdminSession(page);

  // Capture the CSV bytes the user would have saved. The mutation in
  // AICompanyFix.tsx (historyCsvMut) does fetch → .blob() → anchor click,
  // which drains Playwright's response body before we can read it — so we
  // intercept the network round-trip, refetch upstream, snapshot the bytes
  // + headers, then forward the same response to the page. Mirrors the
  // capture pattern in the email-history and recovered-tools CSV specs.
  // The non-CSV `format` (the JSON history feed used by the on-screen
  // table and the facets endpoint) is handled by the same admin route but
  // lives at a separate path; the URL guard keeps us from buffering the
  // JSON pages too.
  const csvCaptures: {
    body: Buffer;
    contentType: string;
    contentDisposition: string;
  }[] = [];
  await page.route("**/api/admin/maintenance/history**", async (route, request) => {
    if (!request.url().includes("format=csv")) {
      await route.continue();
      return;
    }
    const upstream = await route.fetch();
    const body     = await upstream.body();
    const headers  = upstream.headers();
    csvCaptures.push({
      body,
      contentType:        headers["content-type"] ?? "",
      contentDisposition: headers["content-disposition"] ?? "",
    });
    await route.fulfill({ response: upstream, body });
  });

  await page.goto("/admin/ai-fix", { waitUntil: "networkidle" });

  // Wait for the page heading so we know the SPA has mounted AICompanyFix
  // and the /api/admin/companies fetch that drives the dropdown has
  // resolved (the dropdown is rendered inside the same component).
  await expect(page.getByRole("heading", { name: PAGE_HEADING_RE })).toBeVisible();

  // ─── Pick our seeded company in the "اختر الشركة" Radix Select ────────
  // The trigger renders as a <button> wrapping the placeholder text inside
  // a <SelectValue>. With nothing selected the visible text is the
  // placeholder ("— اختر الشركة —"), which is the easiest unambiguous
  // handle for this trigger. The open dropdown is portalled to the
  // document root with role="listbox" and option items with role="option".
  const companyTrigger = page.locator('button:has-text("— اختر الشركة —")').first();
  await companyTrigger.click();
  await expect(companyTrigger).toHaveAttribute("data-state", "open");
  // Option text is `{nameAr}` for active companies; we anchor on the
  // TEST_TAG which is unique on the page.
  await page.locator('[role="option"]').filter({ hasText: TEST_TAG }).first().click();

  // ─── Open the history accordion so historyOpen flips true ─────────────
  // The accordion is collapsed by default (`useState(false)` on
  // historyOpen) and the JSON history feed is gated on
  // `enabled: !!companyId && historyOpen`. Without opening it the
  // on-screen table never renders — the CSV button still exists in the
  // header bar (and would still produce a valid file), but waiting for
  // the seeded row to appear on screen is the cleanest pre-export sync
  // barrier. Anchor by the visible label "سجل الإصلاحات".
  await page.getByRole("button", { name: "سجل الإصلاحات" }).first().click();

  // Sync barrier: wait for the on-screen history table to surface our
  // seeded username before triggering the export, so we know the
  // historyQ data has resolved against the now-selected companyId.
  // The seeded row's "المستخدم" cell renders our SEED_USERNAME verbatim
  // (no truncation in that column).
  await expect(page.getByText(SEED_USERNAME).first()).toBeVisible();

  // Anchor a wall-clock moment just before the export so the audit-row
  // lookup below can scope itself to this run. writeAudit() uses the
  // table's defaultNow for created_at, so a >= filter on this anchor
  // matches only the row our click produced (workers=1 in
  // playwright.config.ts so no concurrent runs).
  exportAuditAnchor = new Date(Date.now() - 1_000); // 1s slack for clock skew

  // ─── Click "تصدير CSV" → the route handler above captures the bytes ──
  // Three "تصدير CSV" / "تنزيل CSV" buttons exist on /admin/ai-fix
  // (email-history, recovered-tools, maintenance-history). Only the
  // maintenance-history button carries this exact `title` attribute, so
  // anchoring on it picks the right one without depending on DOM order
  // or visibility heuristics. Source of the title:
  //   AICompanyFix.tsx ~line 2865
  //   title="تنزيل سجل الإصلاحات الكامل كملف CSV (يحترم الفلاتر أدناه)"
  const csvButton = page.getByTitle(
    "تنزيل سجل الإصلاحات الكامل كملف CSV (يحترم الفلاتر أدناه)",
  );
  await csvButton.click();
  // Poll until the route handler records this click's response. We use
  // expect.poll instead of page.waitForResponse because Playwright's
  // response.body() returns empty once the page JS consumed the response
  // via .blob() — the buffered body the handler stored is the only
  // reliable copy.
  await expect.poll(() => csvCaptures.length, { timeout: 15_000 }).toBe(1);
  const csvCapture = csvCaptures[0];

  // ─── Response headers — Content-Type and the filename pattern ─────────
  // sendCsv() in admin.ts sets `text/csv; charset=utf-8`. Comparing
  // lowercased substrings keeps the assertion tolerant of harmless
  // header-casing changes without depending on order.
  expect(csvCapture.contentType.toLowerCase()).toContain("text/csv");
  expect(csvCapture.contentType.toLowerCase()).toContain("charset=utf-8");
  // Filename advertised to the browser must follow the
  // `maintenance-history-<companyId>-<unix-ms>.csv` pattern — the same
  // identifier the page-side mutation falls back to and that operators
  // recognise when reviewing downloads. We pin the companyId segment to
  // our seeded company so a regression that leaks another tenant's id
  // into the filename would fail this assertion.
  expect(csvCapture.contentDisposition).toMatch(
    new RegExp(`filename="maintenance-history-${testCompanyId}-\\d+\\.csv"`),
  );

  // ─── Body bytes — UTF-8 BOM, header row, seeded row ────────────────────
  // Excel needs the BOM to render Arabic correctly; assert on the raw
  // bytes before any decoder strips the signature.
  const csvBuf = csvCapture.body;
  expect(csvBuf.length).toBeGreaterThan(3);
  expect(csvBuf[0]).toBe(0xEF);
  expect(csvBuf[1]).toBe(0xBB);
  expect(csvBuf[2]).toBe(0xBF);

  const csvText = csvBuf.toString("utf8").replace(/^\uFEFF/, "");
  const csvLines = csvText.split("\r\n").filter(Boolean);
  // Header line carries the six documented Arabic columns in order.
  // Asserting each column individually gives a clearer failure message
  // than a single combined-string check if a header is renamed. The
  // documented order (admin.ts ~line 4420) is:
  //   التاريخ, المستخدم, الفئة, الإجراء, مدة الاحتفاظ, التفاصيل
  const headerCells = csvLines[0].split(",");
  for (const col of ["التاريخ", "المستخدم", "الفئة", "الإجراء", "مدة الاحتفاظ", "التفاصيل"]) {
    expect(headerCells).toContain(col);
  }
  expect(headerCells).toHaveLength(6);

  // The seeded audit row must be in the body. We don't assert on total
  // row count because the dev DB / our own export click may legitimately
  // have added other maintenance audit rows for this tenant — only on
  // the presence of *our* seeded row, identified by the unique
  // SEED_USERNAME (no other row in audit_log shares that username).
  const seededLine = csvLines.slice(1).find((line) => line.includes(SEED_USERNAME));
  expect(
    seededLine,
    `expected a CSV row containing SEED_USERNAME=${SEED_USERNAME}`,
  ).toBeDefined();

  // ─── Audit assertion — exactly one export_csv row was written ─────────
  // Mirrors the server-side comment on /maintenance/history: the export
  // must record an audit entry under module='maintenance' /
  // action='export_csv' / entityType='maintenance_history' scoped to the
  // selected companyId. Scoping the lookup by createdAt >= our anchor
  // (and by our test companyId) keeps the assertion stable on a shared
  // dev DB without inspecting the JSON metadata column.
  const auditRows = await db
    .select({ id: auditLogTable.id, companyId: auditLogTable.companyId })
    .from(auditLogTable)
    .where(and(
      eq(auditLogTable.module, "maintenance"),
      eq(auditLogTable.action, "export_csv"),
      eq(auditLogTable.entityType, "maintenance_history"),
      eq(auditLogTable.companyId, testCompanyId!),
      gte(auditLogTable.createdAt, exportAuditAnchor!),
    ));
  expect(auditRows).toHaveLength(1);
  // Track the id so afterAll can strip it by PK and the dev DB doesn't
  // accumulate test-only audit rows over time.
  for (const r of auditRows) seededAuditIds.push(r.id);
});
