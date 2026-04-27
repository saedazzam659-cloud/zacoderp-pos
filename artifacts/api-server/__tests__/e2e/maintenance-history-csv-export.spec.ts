// E2E tests for the SuperAdmin maintenance-history "تصدير CSV" button on
// /admin/ai-fix in the zatca-invoicing artifact (tasks #99 and #106).
//
// Why these tests exist:
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
// What test 1 (task #99) verifies — no-filter happy path:
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
// What test 2 (task #106) verifies — filter pass-through:
//   The CSV button is documented to forward the four on-screen filters
//   (from / to / action / entityType) to the server via `historyFilterParams()`
//   so the file always matches what the admin saw. A regression that drops
//   one of those params would leave the audit file silently divergent from
//   the visible table. We exercise both directions:
//     - Variant A (narrow): set all four filters to a window that pinpoints
//       the seeded row only (from=TODAY, to=TODAY, action=fix,
//       entityType=journal_pending). Expect exactly one data row in the body
//       and all four query params present on the request URL with the
//       on-screen values.
//     - Variant B (flip): clear action+entityType and shift the date window
//       to TOMORROW so the seeded row falls out. Expect zero data rows in
//       the body, `from`/`to` present with the new dates, and `action`/
//       `entityType` ABSENT from the URL — proving the helper omits empty
//       params instead of forwarding stale or blank values.
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

let saSessionRowId: number | null    = null;
let saSessionToken: string | null    = null;
let testCompanyId: number | null     = null;
// Separate throwaway company used solely by the truncation test (third
// test in this file). Keeping it isolated from `testCompanyId` lets the
// other two tests continue to assert exact on-screen row counts without
// being inflated by the 1001 truncation-test seeds.
let truncCompanyId: number | null    = null;
const seededAuditIds: number[]       = [];
// Captured just before the export click so the audit-row lookup that
// confirms the export_csv row was written can scope its query to this run.
let exportAuditAnchor: Date | null  = null;
// Captured from the seeded audit row's createdAt (defaultNow() in PG, UTC)
// so the filter-pass-through test (task #106) can compute the date window
// that contains the seed without re-reading wall-clock time at assertion
// time. Anchoring on the seed's own timestamp eliminates a flake where a
// run crossing UTC midnight between seed insertion and filter assertion
// would compute a "TODAY" that no longer contains the seed.
let seedCreatedAt: Date | null      = null;

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
    .returning({ id: auditLogTable.id, createdAt: auditLogTable.createdAt });
  seededAuditIds.push(audit.id);
  // Pin the seed's wall-clock so the filter-pass-through test (task #106)
  // can derive its date window from it instead of re-reading Date.now() at
  // assertion time — see the seedCreatedAt declaration for the rationale.
  seedCreatedAt = audit.createdAt;
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
    // Also strip every audit row scoped to our throwaway test company —
    // catches the export_csv rows that each test's CSV click writes
    // (the second test, task #106, fires two such clicks). Safe because
    // the company was created fresh in beforeAll and is exclusively ours.
    await db
      .delete(auditLogTable)
      .where(eq(auditLogTable.companyId, testCompanyId));
    await db
      .delete(companiesTable)
      .where(eq(companiesTable.id, testCompanyId));
  }
  if (truncCompanyId !== null) {
    // Same wholesale strip for the truncation test's throwaway company
    // (1001 seeded audit rows + the export_csv row the truncation fetch
    // produced). Safe because this company is exclusively ours and was
    // created fresh during the truncation test.
    await db
      .delete(auditLogTable)
      .where(eq(auditLogTable.companyId, truncCompanyId));
    await db
      .delete(companiesTable)
      .where(eq(companiesTable.id, truncCompanyId));
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
  // dev DB. We project metadata so the truncation-flag shape can be
  // locked in below.
  const auditRows = await db
    .select({
      id:        auditLogTable.id,
      companyId: auditLogTable.companyId,
      metadata:  auditLogTable.metadata,
    })
    .from(auditLogTable)
    .where(and(
      eq(auditLogTable.module, "maintenance"),
      eq(auditLogTable.action, "export_csv"),
      eq(auditLogTable.entityType, "maintenance_history"),
      eq(auditLogTable.companyId, testCompanyId!),
      gte(auditLogTable.createdAt, exportAuditAnchor!),
    ));
  expect(auditRows).toHaveLength(1);
  // Truncation visibility — even when the cap doesn't kick in, the audit
  // row must carry the new `truncated`/`rowCap`/`totalAvailable` fields
  // so a SuperAdmin reviewing past exports can tell at a glance whether
  // the data was clipped (the truncated=true branch is covered by the
  // sibling truncation test below; here we lock in the shape of the
  // non-truncated branch). Without this assertion, the route could
  // silently drop the truncation fields and a real clipped export would
  // once again be indistinguishable from a complete one. Mirrors the
  // contract enforced on /maintenance/error-summary,
  // /maintenance/recent-recoveries, /maintenance/tool-history, and
  // /maintenance/email-history.
  const meta = (auditRows[0].metadata ?? {}) as Record<string, unknown>;
  expect(meta.format).toBe("csv");
  expect(meta.rowCap).toBe(1000);
  expect(meta.truncated).toBe(false);
  // count must equal totalAvailable when not truncated — the route uses
  // rows.length for both rather than re-running a COUNT query in the
  // common (cheap) path.
  expect(typeof meta.count).toBe("number");
  expect(typeof meta.totalAvailable).toBe("number");
  expect(meta.count).toBe(meta.totalAvailable);
  // Track the id so afterAll can strip it by PK and the dev DB doesn't
  // accumulate test-only audit rows over time.
  for (const r of auditRows) seededAuditIds.push(r.id);
});

// ─── Task #106: filter pass-through ─────────────────────────────────────────
// The maintenance-history CSV mutation in AICompanyFix.tsx (`historyCsvMut`)
// builds the request URL via the shared `historyFilterParams()` helper. That
// helper appends `from`, `to`, `action`, and `entityType` only when the
// matching React state is non-empty — so the file should always reflect the
// admin's on-screen filter state, with absent params for any cleared filter.
// The previous test only proves the no-filter path; this one drives the four
// filter inputs and asserts both the request URL shape and the body shape
// twice, so a regression that drops one of those four params from the CSV
// URL (which would silently desync the audit file from the visible table)
// would fail here.
test("maintenance-history CSV export: forwards on-screen filters (narrow + flip)", async ({ page }) => {
  await installSuperAdminSession(page);

  // Same buffered-bytes capture pattern as the happy-path test — the page
  // JS drains Playwright's response body via .blob(), so we refetch
  // upstream and snapshot URL + headers + body for each CSV request.
  // Captures here pair the request URL with the body so each variant's
  // assertions can pull both from the same network record.
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

  // Pick the same seeded company. Anchored on TEST_TAG which is unique to
  // this run (the company's nameAr carries the full tag).
  const companyTrigger = page.locator('button:has-text("— اختر الشركة —")').first();
  await companyTrigger.click();
  await expect(companyTrigger).toHaveAttribute("data-state", "open");
  await page.locator('[role="option"]').filter({ hasText: TEST_TAG }).first().click();

  // Open the history accordion so the JSON history feed AND the facets feed
  // both fire (both are gated on `historyOpen`). Without facets resolving
  // the action/entityType dropdowns wouldn't surface our seeded values.
  await page.getByRole("button", { name: "سجل الإصلاحات" }).first().click();

  // Sync barrier: wait for the seeded row to surface on screen so we know
  // the JSON history fetch has resolved against the now-selected
  // companyId. The username cell renders SEED_USERNAME verbatim (no
  // truncation), so anchoring on it is stable.
  await expect(page.getByText(SEED_USERNAME).first()).toBeVisible();

  // Scope every filter-input lookup to the maintenance-history accordion.
  // The page also renders an email-history panel above with its own
  // date inputs sharing the same Arabic labels ("من تاريخ" / "إلى تاريخ"),
  // so an unscoped locator would be ambiguous. The maintenance accordion
  // is the unique `.border.rounded` div whose header contains
  // "سجل الإصلاحات".
  const maintPanel = page.locator("div.border.rounded").filter({
    has: page.locator('button:has-text("سجل الإصلاحات")'),
  });
  const fromInput        = maintPanel.locator('input[type="date"]').nth(0);
  const toInput          = maintPanel.locator('input[type="date"]').nth(1);
  const actionTrigger    = maintPanel.locator('button:has-text("كل الإجراءات")').first();
  const entityTypeTrigger = maintPanel.locator('button:has-text("كل الفئات")').first();
  const resetBtn         = maintPanel.getByRole("button", { name: "مسح الفلاتر" });

  // The server parses both `from` and `to` as UTC midnight, and the seed
  // row's createdAt comes from PG's defaultNow() (also UTC). Anchor TODAY
  // on the seed row's actual createdAt (captured in beforeAll) instead of
  // wall-clock Date.now() at assertion time — that way a run that crosses
  // UTC midnight between insertion and the test still computes a window
  // that contains the seed.
  const SEED_DAY = seedCreatedAt!.toISOString().slice(0, 10);
  const NEXT_DAY = new Date(seedCreatedAt!.getTime() + 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  // ─── Variant A: narrow all four filters down to the seeded row ─────────
  await fromInput.fill(SEED_DAY);
  await toInput.fill(SEED_DAY);

  // Action dropdown — "إصلاح" is the Arabic label for action='fix'
  // (HISTORY_ACTION_LABELS_AR in AICompanyFix.tsx). The option only
  // materialises once the facets fetch has returned `fix` for our company,
  // so the click below auto-waits on the materialised <option>.
  await actionTrigger.click();
  await page.locator('[role="option"]').filter({ hasText: "إصلاح" }).first().click();

  // EntityType dropdown — "قيود معلّقة" is the Arabic label for
  // entityType='journal_pending'. Same rationale as the action click.
  await entityTypeTrigger.click();
  await page.locator('[role="option"]').filter({ hasText: "قيود معلّقة" }).first().click();

  // Sync barrier: wait for the on-screen table to settle to exactly one row
  // matching SEED_USERNAME — proves React state for all four filters has
  // propagated AND the filtered JSON re-fetch landed before we click
  // export. The export reads the very same React state, so this barrier
  // is the cheapest way to guarantee the URL we capture below was built
  // from the post-narrow filter state, not the pre-narrow state.
  await expect(maintPanel.locator(`tbody tr:has-text("${SEED_USERNAME}")`)).toHaveCount(1);

  const csvButton = page.getByTitle(
    "تنزيل سجل الإصلاحات الكامل كملف CSV (يحترم الفلاتر أدناه)",
  );
  await csvButton.click();
  await expect.poll(() => csvCaptures.length, { timeout: 15_000 }).toBe(1);
  const variantA = csvCaptures[0];

  // All four filter values must be on the wire, exactly as set on screen.
  // A regression that dropped any one of them (e.g. forgot to append the
  // entityType segment) would surface as a `null` here and fail loud.
  const variantAUrl = new URL(variantA.url);
  expect(variantAUrl.searchParams.get("from")).toBe(SEED_DAY);
  expect(variantAUrl.searchParams.get("to")).toBe(SEED_DAY);
  expect(variantAUrl.searchParams.get("action")).toBe("fix");
  expect(variantAUrl.searchParams.get("entityType")).toBe("journal_pending");

  // Body — exactly one data row (the seed), strip BOM before splitting.
  // The window action=fix + entityType=journal_pending + SEED_DAY pinpoints
  // our seed in the audit_log; no other row in the dev DB shares that
  // combination scoped to our brand-new test company.
  const aLines = variantA.body
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .split("\r\n")
    .filter(Boolean);
  expect(aLines).toHaveLength(2); // header + 1 data row
  expect(aLines[1]).toContain(SEED_USERNAME);

  // ─── Variant B: clear action+entityType, push date window forward ──────
  // "مسح الفلاتر" resets all four filters at once (date inputs blank,
  // both Selects back to "__all"). We then re-fill ONLY the date inputs
  // with NEXT_DAY (the day after the seed) so the URL has from+to but NOT
  // action/entityType — this exercises both directions of the helper's
  // append-when-non-empty rule.
  await resetBtn.click();
  // The reset button disappears the moment all filters are empty; waiting
  // for it to drop out is the cheapest barrier to confirm the click
  // committed all four state setters before we drive the next inputs.
  await expect(resetBtn).toHaveCount(0);

  await fromInput.fill(NEXT_DAY);
  await toInput.fill(NEXT_DAY);

  // Sync barrier: the NEXT_DAY window matches no audit row (the seed and
  // any export_csv rows from variant A are stamped on SEED_DAY), so the
  // panel must flip to its empty-state copy before we click export.
  await expect(
    maintPanel.getByText("لا توجد عمليات صيانة مسجّلة لهذه الشركة بعد."),
  ).toBeVisible();

  await csvButton.click();
  await expect.poll(() => csvCaptures.length, { timeout: 15_000 }).toBe(2);
  const variantB = csvCaptures[1];

  // `from` and `to` must reflect the on-screen NEXT_DAY values; `action`
  // and `entityType` must be ABSENT (URLSearchParams.get returns null when
  // a key is missing). This proves `historyFilterParams()` correctly
  // omits empty filters instead of forwarding stale or blank strings.
  const variantBUrl = new URL(variantB.url);
  expect(variantBUrl.searchParams.get("from")).toBe(NEXT_DAY);
  expect(variantBUrl.searchParams.get("to")).toBe(NEXT_DAY);
  expect(variantBUrl.searchParams.get("action")).toBeNull();
  expect(variantBUrl.searchParams.get("entityType")).toBeNull();

  // Body — header line only, zero data rows. The BOM is emitted even on
  // an empty result so Excel still opens the file in UTF-8 mode.
  const bBuf = variantB.body;
  expect(bBuf[0]).toBe(0xEF);
  expect(bBuf[1]).toBe(0xBB);
  expect(bBuf[2]).toBe(0xBF);
  const bLines = bBuf
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .split("\r\n")
    .filter(Boolean);
  expect(bLines).toHaveLength(1); // header only — no data rows
});

// ─── Third test: 1000-row server-side cap on the maintenance-history CSV ───
// We create a brand-new throwaway company and seed exactly 1001 audit rows
// scoped to it (strictly > MAINT_HISTORY_CSV_ROW_CAP=1000). The CSV branch
// must clip the body to exactly 1000 data rows and the audit row's
// metadata must record `truncated=true` / `totalAvailable=1001` /
// `rowCap=1000`. Mirrors the truncation tests in
// tool-history-csv-export.spec.ts and broken-tools-panel.spec.ts.
//
// We trigger the export directly via a page-context fetch (Bearer token
// from localStorage) rather than driving the dialog open through the UI
// for a third time — the click flow is already covered by the first two
// tests; here the focus is purely the server cap. This keeps the test
// fast (no extra dropdown/accordion navigation) while still exercising
// the exact /api route the UI hits.
test("maintenance-history CSV export: caps body at 1000 rows and records truncation in the audit row", async ({ page }) => {
  await installSuperAdminSession(page);

  // Brand-new company exclusively for this test. Keeping its audit_log
  // partition fully under our control means totalAvailable is exactly
  // SEED_COUNT — no co-tenant rows can inflate the COUNT(*) the route
  // runs when atCap. nameAr carries TEST_TAG so any leftover row in the
  // dev DB after a crash is traceable back to this spec.
  const [truncCo] = await db
    .insert(companiesTable)
    .values({
      nameAr:         `${TEST_TAG} شركة الاختبار للسجل (اقتطاع)`,
      nameEn:         `${TEST_TAG} Test Co Maint History Trunc`,
      vatNumber:      "300000000000199",
      crNumber:       `CR_${TEST_TAG}_trunc`,
      city:           "Riyadh",
      street:         "Test St",
      buildingNumber: "1",
      postalCode:     "12345",
      country:        "SA",
      invoiceType:    "both",
      status:         "active",
    })
    .returning({ id: companiesTable.id });
  truncCompanyId = truncCo.id;

  // Resolve the SuperAdmin user id once so every seeded audit row carries
  // a consistent userId. We can't reuse the beforeAll's `sa` binding here
  // because it lives in a different lexical scope.
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

  // Seed 1001 maintenance audit rows (strictly > MAINT_HISTORY_CSV_ROW_CAP
  // =1000) for the throwaway company. Each row mirrors the shape
  // logMaint() writes so the CSV body has plausible column values.
  // Bulk insert in chunks to stay well under Postgres's 65k bind-
  // parameter ceiling (each row ≈ 9 params → 200 rows ≈ 1.8k params per
  // batch).
  const SEED_COUNT = 1001;
  const truncSeedRows = Array.from({ length: SEED_COUNT }, (_, i) => ({
    userId:     sa.id,
    username:   `${TEST_TAG}_trunc_${i}`,
    role:       "superadmin",
    companyId:  truncCompanyId!,
    module:     "maintenance",
    action:     "fix",
    method:     "POST",
    path:       "/api/admin/maintenance/journal-pending/fix",
    entityType: "journal_pending",
    entityId:   null,
    metadata:   { tag: TEST_TAG, seq: i },
  }));
  const CHUNK = 200;
  for (let i = 0; i < truncSeedRows.length; i += CHUNK) {
    await db
      .insert(auditLogTable)
      .values(truncSeedRows.slice(i, i + CHUNK));
  }

  // Navigate so addInitScript installs the bearer token; we don't need
  // to drive the AICompanyFix UI here — the cap behavior is exercised
  // purely via a page-context fetch against the same /api route the
  // maintenance-history "تصدير CSV" button hits.
  await page.goto("/", { waitUntil: "domcontentloaded" });

  // Anchor a wall-clock moment just before the fetch so the audit-row
  // lookup can scope itself to this run.
  const truncAuditAnchor = new Date(Date.now() - 1_000); // 1s slack

  // Fire the CSV fetch from inside the page context so localStorage
  // (where the SPA stores the SuperAdmin bearer token) is available.
  // page.request lives outside the page and would need its own auth
  // setup. Returning the body as a number[] keeps the marshal across
  // the page boundary trivial; we rebuild the Buffer on the test side.
  // Headers are also returned so we can lock in the X-Csv-* response
  // headers the page-side mutation reads to build its truncation toast.
  //
  // Deliberately omit `includeSystem=1` — that flag widens the WHERE to
  // also include companyId=0 (system) rows, which would inflate the
  // route's COUNT(*) past our seeded 1001 in any environment that has
  // system maintenance rows (real dev DBs always do). Pinning the query
  // to companyId=truncCompanyId only keeps `totalAvailable` deterministic
  // at exactly the seed count regardless of co-tenant audit history.
  const csvUrl = `/api/admin/maintenance/history?companyId=${truncCompanyId}&format=csv`;
  const csvFetch = await page.evaluate(async ({ url }) => {
    const token = localStorage.getItem("zatca_token");
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token ?? ""}` },
    });
    const buf = await r.arrayBuffer();
    return {
      status:        r.status,
      bytes:         Array.from(new Uint8Array(buf)),
      contentType:   r.headers.get("content-type") ?? "",
      truncatedHdr:  r.headers.get("x-csv-truncated") ?? "",
      rowCapHdr:     r.headers.get("x-csv-row-cap") ?? "",
      totalAvailHdr: r.headers.get("x-csv-total-available") ?? "",
    };
  }, { url: csvUrl });
  expect(csvFetch.status).toBe(200);
  expect(csvFetch.contentType.toLowerCase()).toContain("text/csv");

  // Response headers — these drive the "تم الاقتطاع عند 1,000 من 1,001
  // صف" toast suffix in AICompanyFix.tsx (historyCsvMut, after task
  // #121 unified the copy across all five CSV-export mutations). A
  // regression that drops or mistypes any of these would silently
  // disable the user-visible truncation hint — and would also strip the
  // "من N" segment that tells operators *how many* rows were left out
  // (the whole point of task #121). The end-to-end UI toast assertion
  // for the unified copy lives in tool-history-csv-export.spec.ts; this
  // test stays at the header level because the same five mutations all
  // build the toast from these three headers (see AICompanyFix.tsx —
  // errorSummaryCsvMut, recoverySummaryCsvMut, historyCsvMut,
  // emailHistoryCsvMut, toolHistoryCsvMut).
  expect(csvFetch.truncatedHdr).toBe("1");
  expect(csvFetch.rowCapHdr).toBe("1000");
  expect(csvFetch.totalAvailHdr).toBe("1001");

  // ─── Body bytes — UTF-8 BOM and the 1000-row cap ────────────────────
  const csvBuf = Buffer.from(csvFetch.bytes);
  expect(csvBuf.length).toBeGreaterThan(3);
  expect(csvBuf[0]).toBe(0xEF);
  expect(csvBuf[1]).toBe(0xBB);
  expect(csvBuf[2]).toBe(0xBF);

  const csvText = csvBuf.toString("utf8").replace(/^\uFEFF/, "");
  // sendCsv emits CRLF row separators; filter(Boolean) drops the trailing
  // empty element from a final CRLF (if any). Our seed payload uses
  // simple ASCII for every column so no cell can contain a CRLF —
  // split("\r\n") yields exactly one entry per logical row.
  const csvLines = csvText.split("\r\n").filter(Boolean);
  // 1000-row cap: MAINT_HISTORY_CSV_ROW_CAP=1000 in admin.ts. We seeded
  // 1001 audit rows, so the LIMIT clause must clip the CSV output to
  // exactly 1000 data rows. Asserting on === 1000 (not >= or <=) catches
  // accidental cap drift in either direction.
  expect(csvLines.length - 1).toBe(1000);

  // ─── Audit assertion — exactly one export_csv row + truncation flag ──
  const truncAuditRows = await db
    .select({
      id:       auditLogTable.id,
      metadata: auditLogTable.metadata,
    })
    .from(auditLogTable)
    .where(and(
      eq(auditLogTable.module, "maintenance"),
      eq(auditLogTable.action, "export_csv"),
      eq(auditLogTable.entityType, "maintenance_history"),
      eq(auditLogTable.companyId, truncCompanyId!),
      gte(auditLogTable.createdAt, truncAuditAnchor),
    ));
  expect(truncAuditRows).toHaveLength(1);
  const truncMeta = (truncAuditRows[0].metadata ?? {}) as Record<string, unknown>;
  expect(truncMeta.format).toBe("csv");
  expect(truncMeta.count).toBe(1000);
  expect(truncMeta.rowCap).toBe(1000);
  expect(truncMeta.truncated).toBe(true);
  // We seeded exactly 1001 rows for this brand-new company; the
  // companyId WHERE in the route's COUNT(*) pins the universe to those
  // rows, so totalAvailable is exactly 1001.
  expect(truncMeta.totalAvailable).toBe(1001);
  // The export_csv audit row is on the throwaway company, so afterAll's
  // companyId-wholesale strip will catch it.
});
