// E2E test for the SuperAdmin "أدوات صيانة تعطّلت آخر 7 أيام" amber panel
// on /admin/ai-fix in the zatca-invoicing artifact (tasks #85, #104).
//
// What this verifies (mirrors the regression task acceptance criteria):
//   1. Empty state — when GET /api/admin/maintenance/error-summary returns
//      zero items, the amber panel must NOT render at all (the conditional
//      in AICompanyFix.tsx around line 1818 is gated on
//      `errorSummaryQ.data && errorSummaryQ.data.items.length > 0`, so an
//      empty list keeps the page calm).
//   2. Populated state — after seeding a (company, tool) pair whose latest
//      maintenance_runs row is `status='error'` inside the 7-day window,
//      the panel must:
//        - Be visible.
//        - Expose all four documented column headers in its <thead>.
//        - Render exactly one row for our seeded TOOL_KEY (the dev DB may
//          carry other broken tools from other tests / real sweeps; we
//          anchor on our unique tool key).
//        - Surface the seeded company's Arabic name in that row.
//   3. Tool-history affordance — clicking the tool-key button on the
//      seeded row opens the tool-history dialog whose title bar echoes
//      our TOOL_KEY (same affordance as the green recovered-tool panel
//      below it).
//   4. CSV export (task #104) — clicking the "تنزيل CSV" button on the
//      panel triggers GET /maintenance/error-summary?format=csv, which
//      must return:
//        - filename `maintenance-broken-tools-<unix-ms>.csv`
//        - body prefixed with the UTF-8 BOM
//        - the four headers الشركة / الأداة / رسالة الخطأ / وقت آخر فشل
//          in that exact order
//        - at most BROKEN_CSV_ROW_CAP=1000 data rows even when the
//          underlying helper returns more (we seed 1000 extra broken
//          (company, tool) pairs to push the total past the cap)
//        - exactly one `export_csv` audit row with module=maintenance,
//          entityType=maintenance_error_summary, companyId=null
//      Mirrors the structure of the recovered-tools CSV spec so future
//      maintenance is consistent across the two panels.
//
// Determinism story (mirrors recovered-tools-panel.spec.ts):
//   - We create a brand-new `companies` row tagged with a per-run TEST_TAG
//     so the seeded broken tool never collides with whatever else lives in
//     the shared dev DB.
//   - The tool key is also TEST_TAG-prefixed; assertions key on it instead
//     of on row counts, so other broken tools in the dev DB don't cause
//     false failures.
//   - The empty-state assertion is implemented by mocking the API endpoint
//     via page.route() so the test is independent of the global error
//     state — relying on "the dev DB happens to have zero broken tools
//     right now" would be flaky (and false: our own populated-state test
//     leaves seeded data behind until afterAll).
//   - The SuperAdmin auth short-circuit (insert sa_sessions row + write
//     localStorage zatca_token + zatca_session='sa-<id>') matches what
//     the login flow itself produces, so /api/auth/me returns the
//     SuperAdmin and the AICompanyFix route guard renders.
//
// Cleanup:
//   - Strict-by-PK: we record every inserted row id (maintenance_runs,
//     companies, sa_sessions) and delete by `eq`/`inArray` in afterAll.
//     No LIKE / wildcards on production tables; a crashed run never
//     touches another tenant's data.
//   - We deliberately do NOT call `pool.end()` — see the matching note in
//     recovered-tools-panel.spec.ts. With workers=1, sibling specs share
//     the singleton pool exported by `@workspace/db`.
//
// How to run:
//   1. Ensure the api-server and zatca-invoicing dev workflows are running.
//   2. `pnpm --filter @workspace/api-server run test:e2e`

import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { and, eq, gte, inArray, isNull, like } from "drizzle-orm";
import {
  db,
  usersTable,
  companiesTable,
  maintenanceRunsTable,
  superAdminSessionsTable,
  auditLogTable,
} from "@workspace/db";

// ─── Fixtures / state shared across both tests in this file ────────────────
const TEST_TAG = `e2e_task85_${randomBytes(4).toString("hex")}`;
// Tool key carries the full TEST_TAG so panel-row assertions can pinpoint
// our seeded broken tool on a shared dev DB without relying on row counts.
const TOOL_KEY = `${TEST_TAG}_broken_tool`;
// Distinctive error string that we plant on the seeded row so the panel's
// "رسالة الخطأ" cell can be uniquely matched if needed.
const ERROR_MSG = `boom from task #85 e2e ${TEST_TAG}`;
// Header text the broken-tool panel renders (AICompanyFix.tsx ~line 1823).
// Only matched as a prefix because the same line interpolates the window
// length ("آخر 7 أيام") which we don't want to hard-code.
const PANEL_HEADER_PREFIX = "أدوات صيانة تعطّلت آخر";

let saSessionRowId: number | null = null;
let saSessionToken: string | null = null;
let testCompanyId: number | null = null;
const seededRunIds: number[] = [];
// audit_log row id(s) the maintenance/error-summary CSV export writes
// during the CSV test below. Tracked so afterAll can strip them by PK
// and the dev DB doesn't accumulate test-only audit rows over time.
const seededAuditIds: number[] = [];
// Anchor moment captured before the CSV export click so the audit-row
// lookup can scope its query to this test run instead of relying on a
// LIKE pattern (the export helper doesn't accept caller-supplied tags).
let csvAuditAnchor: Date | null = null;

// ─── Setup: create company, sa_session, and a broken-tool scenario ─────────
test.beforeAll(async () => {
  // Sweep any debris from a previous interrupted run before seeding. All
  // three patterns are namespaced strictly to this test (the maintenance
  // runs tag the toolKey column, the sa_sessions tag sessionToken, the
  // companies tag nameAr), so this can never touch real audit history,
  // real user sessions, or real tenant rows.
  await db
    .delete(maintenanceRunsTable)
    .where(like(maintenanceRunsTable.toolKey, "e2e_task85_%"));
  await db
    .delete(superAdminSessionsTable)
    .where(like(superAdminSessionsTable.sessionToken, "e2e_task85_%"));
  await db
    .delete(companiesTable)
    .where(like(companiesTable.nameAr, "e2e_task85_%"));

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
  saSessionToken = "e2e_task85_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task85",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  // Active test company so it's visible to getRecentToolErrors (which joins
  // `companies` and filters status='active'). The Arabic name carries
  // TEST_TAG so the on-page row text can be uniquely matched.
  const [co] = await db
    .insert(companiesTable)
    .values({
      nameAr:         `${TEST_TAG} شركة الاختبار للأعطال`,
      nameEn:         `${TEST_TAG} Test Co Broken`,
      vatNumber:      "300000000000085",
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

  // Broken-tool scenario: a single 'error' row 1 day ago, no later rows for
  // the same (company, tool). The DISTINCT ON (company_id, tool_key) inside
  // getRecentToolErrors takes the latest run per pair and keeps only those
  // whose latest status is 'error', so this single row is enough to surface
  // the (company, tool) pair on the panel. The runAt comfortably sits inside
  // the 7-day window (TOOL_ERROR_WINDOW_DAYS in maintenanceScheduler.ts).
  const now = Date.now();
  const errRow = await db
    .insert(maintenanceRunsTable)
    .values({
      companyId:  testCompanyId,
      toolKey:    TOOL_KEY,
      status:     "error",
      count:      0,
      trigger:    "scheduled",
      runAt:      new Date(now - 1 * 86_400_000),
      durationMs: 1,
      error:      ERROR_MSG,
      details:    null,
    })
    .returning({ id: maintenanceRunsTable.id });
  seededRunIds.push(errRow[0].id);
});

// ─── Cleanup: strict-by-PK so a crash never nukes unrelated audit history ──
// We deliberately do NOT call `pool.end()` — see the matching note in
// recovered-tools-panel.spec.ts.
test.afterAll(async () => {
  if (seededAuditIds.length) {
    // Strip the export_csv audit row(s) the CSV test triggered. Done
    // before the maintenance_runs / companies cleanup because audit rows
    // hold no FK back to those tables — but ordering this first keeps the
    // teardown narrative ("test artefacts → fixtures") readable.
    await db
      .delete(auditLogTable)
      .where(inArray(auditLogTable.id, seededAuditIds));
  }
  if (seededRunIds.length) {
    // Chunk the delete so a CSV-test run that seeded ~1000 padding rows
    // stays comfortably below Postgres's 65k bind-parameter ceiling on a
    // single statement.
    const CHUNK = 500;
    for (let i = 0; i < seededRunIds.length; i += CHUNK) {
      await db
        .delete(maintenanceRunsTable)
        .where(inArray(maintenanceRunsTable.id, seededRunIds.slice(i, i + CHUNK)));
    }
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
// the SPA to settle on the right route before asserting panel visibility.
const PAGE_HEADING_RE = /إصلاح مشاكل الشركات بالذكاء الاصطناعي/;

test("broken-tools panel: hidden when the API returns zero broken tools", async ({ page }) => {
  await installSuperAdminSession(page);

  // Mock the error-summary endpoint BEFORE navigating so the initial render
  // path can never see real data. Other panels (recoveries, critical, fleet,
  // history…) keep their real responses so the page still loads normally
  // and we're testing exactly this panel's hidden-when-empty branch.
  await page.route("**/api/admin/maintenance/error-summary**", async (route) => {
    await route.fulfill({
      status:      200,
      contentType: "application/json",
      body:        JSON.stringify({ count: 0, windowDays: 7, items: [] }),
    });
  });

  await page.goto("/admin/ai-fix", { waitUntil: "networkidle" });

  // Wait for the page heading so we know the SPA has mounted AICompanyFix
  // and the error-summary query has had a chance to resolve under our mock.
  await expect(page.getByRole("heading", { name: PAGE_HEADING_RE })).toBeVisible();

  // The panel renders only when items.length > 0; with our mock it must
  // never appear in the DOM. The header phrase is unique to this panel
  // (other on-page Arabic copy doesn't repeat the "أدوات صيانة تعطّلت"
  // wording), so a count of 0 proves the conditional branch is taking
  // the hidden path.
  await expect(page.getByText(PANEL_HEADER_PREFIX)).toHaveCount(0);
});

test("broken-tools panel: renders the seeded broken tool with the four columns and opens the tool-history modal", async ({ page }) => {
  await installSuperAdminSession(page);

  await page.goto("/admin/ai-fix", { waitUntil: "networkidle" });

  // Wait for the SPA to mount the page first so the panel locator below
  // resolves against the rendered DOM and not the loading shell.
  await expect(page.getByRole("heading", { name: PAGE_HEADING_RE })).toBeVisible();

  // Locator scoped to the amber panel via its header text. Anchoring on
  // the Arabic copy keeps assertions resilient to styling changes on the
  // surrounding container (the bg-amber-50/40 / border-amber-200 class
  // chain could legitimately move without breaking the contract).
  const panel = page.locator("div", { hasText: PANEL_HEADER_PREFIX }).filter({
    has: page.locator("table"),
  }).first();
  await expect(panel).toBeVisible();

  // Column headers must include all four labels in <thead>. Asserting
  // each one separately (vs. a single combined string) gives a clearer
  // failure message if a header is renamed or removed. Note: the task
  // description listed "آخر خطأ" / "وقت آخر فحص" but the actual rendered
  // headers are "رسالة الخطأ" / "وقت آخر فشل" (AICompanyFix.tsx lines
  // 1847-1848). The test asserts what the page actually shows; the
  // task-acceptance bullet is satisfied because we cover all four header
  // cells in <thead>.
  for (const col of ["الشركة", "الأداة", "رسالة الخطأ", "وقت آخر فشل"]) {
    await expect(panel.locator("thead th", { hasText: col })).toBeVisible();
  }

  // Find the row containing our unique TOOL_KEY. The dev DB may carry
  // other broken tools from real maintenance sweeps, so we never assert
  // on total row count — only on the presence of our seeded pair.
  const seededRow = panel.locator("tbody tr", { hasText: TOOL_KEY });
  await expect(seededRow).toHaveCount(1);
  // Same row must show our company's Arabic name (the company-name button
  // is the first cell). Using contains-text instead of an exact match
  // because the cell wraps the name in a button with a trailing tooltip.
  await expect(seededRow).toContainText("شركة الاختبار للأعطال");

  // Tool-key button on the row is the entry point into the tool-history
  // modal — same affordance as on the green recovered-tool panel. Clicking
  // it must open a Radix Dialog whose title is "آخر تشغيلات الأداة" and
  // which echoes our TOOL_KEY in the title bar.
  await seededRow.getByRole("button", { name: TOOL_KEY }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("آخر تشغيلات الأداة")).toBeVisible();
  await expect(dialog.getByText(TOOL_KEY)).toBeVisible();
});

test("broken-tools panel: 'تنزيل CSV' downloads the broken-tools list with the four Arabic headers, BOM, the 1000-row cap, and one audit row", async ({ page }) => {
  await installSuperAdminSession(page);

  // Seed enough additional broken (company, tool) pairs to push the total
  // count past the BROKEN_CSV_ROW_CAP=1000 server-side cap. Combined with
  // the row from beforeAll plus any unrelated dev-DB rows, the helper will
  // now see >1000 candidate pairs and the LIMIT clause inside
  // getRecentToolErrors must clip the CSV output to exactly 1000 rows.
  //
  // Each padding row uses a unique tool_key so DISTINCT ON
  // (company_id, tool_key) keeps every one of them. Crucially the padding
  // prefix does *not* contain TOOL_KEY as a substring (we use
  // `${TEST_TAG}_pad_…` instead of `${TOOL_KEY}_pad_…`) so the
  // `hasText: TOOL_KEY` panel-row probe below uniquely matches the
  // beforeAll row and not the padding rows. runAt is staggered strictly
  // *older* than the beforeAll row so that row stays the most recent and
  // remains visible on the on-screen 50-row panel — important for the
  // "panel is visible" gate before we click the export. All padding
  // runAts sit comfortably inside the 7-day window.
  const EXTRA_PAIRS = 1000;
  const now = Date.now();
  const extraRows = Array.from({ length: EXTRA_PAIRS }, (_, i) => ({
    companyId:  testCompanyId!,
    toolKey:    `${TEST_TAG}_pad_${i.toString().padStart(4, "0")}`,
    status:     "error" as const,
    count:      0,
    trigger:    "scheduled" as const,
    // 2 days ago, then minus 60s per index → all between -2d and -2.7d.
    runAt:      new Date(now - 2 * 86_400_000 - i * 60_000),
    durationMs: 1,
    error:      `pad ${i} ${ERROR_MSG}`,
    details:    null,
  }));
  // Bulk insert in chunks to keep parameter counts well within Postgres's
  // 65k bind-parameter ceiling (each row ≈ 9 parameters → 200 rows ≈ 1.8k).
  const CHUNK = 200;
  for (let i = 0; i < extraRows.length; i += CHUNK) {
    const inserted = await db
      .insert(maintenanceRunsTable)
      .values(extraRows.slice(i, i + CHUNK))
      .returning({ id: maintenanceRunsTable.id });
    for (const r of inserted) seededRunIds.push(r.id);
  }

  // Capture the CSV bytes the user would have saved. The mutation in
  // AICompanyFix.tsx (errorSummaryCsvMut) does fetch → .blob() → anchor
  // click, which drains Playwright's response body before we can read it
  // — so we intercept the network round-trip, refetch upstream, snapshot
  // the bytes + headers, then forward the same response to the page.
  // Mirrors the recovered-tools CSV spec's capture pattern.
  const csvCaptures: {
    body: Buffer;
    contentType: string;
    contentDisposition: string;
  }[] = [];
  await page.route("**/api/admin/maintenance/error-summary**", async (route, request) => {
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

  // Wait for the SPA + the amber panel to render before clicking the
  // export button — the button only exists inside the panel, which is
  // gated on `errorSummaryQ.data.items.length > 0`.
  await expect(page.getByRole("heading", { name: PAGE_HEADING_RE })).toBeVisible();
  const panel = page.locator("div", { hasText: PANEL_HEADER_PREFIX }).filter({
    has: page.locator("table"),
  }).first();
  await expect(panel).toBeVisible();
  // Stable handle on the seeded row so we know the broken-tool scenario
  // is on screen before exporting (the server pulls all rows via the same
  // helper, but waiting here guarantees the test isn't racing the initial
  // query and that the export button is mounted).
  await expect(panel.locator("tbody tr", { hasText: TOOL_KEY })).toHaveCount(1);

  // Anchor a wall-clock moment just before the export so the audit-row
  // lookup below can scope itself to this run; writeAudit() uses defaultNow
  // for created_at so a >= filter on this anchor will only match rows the
  // export we triggered (or a concurrent test run, which is impossible
  // here because workers=1).
  csvAuditAnchor = new Date(Date.now() - 1_000); // 1s slack for clock skew

  // Click the CSV export button by its data-testid (added on AICompanyFix
  // for exactly this hook). page.route() above will record the bytes.
  // The 1000-row cap means the upstream query has to scan + serialise
  // more rows than usual, so allow a generous timeout.
  await page.locator('[data-testid="error-summary-csv-button"]').click();
  await expect.poll(() => csvCaptures.length, { timeout: 30_000 }).toBe(1);
  const csvCapture = csvCaptures[0];

  // ─── Response headers — Content-Type and the filename pattern ───────────
  // sendCsv() sets `text/csv; charset=utf-8`; the substring check tolerates
  // case differences in the charset clause without depending on order.
  expect(csvCapture.contentType.toLowerCase()).toContain("text/csv");
  // Filename advertised to the browser must follow the
  // `maintenance-broken-tools-<unix-ms>.csv` pattern — the same identifier
  // the page-side mutation falls back to and that operators recognise when
  // reviewing downloads.
  expect(csvCapture.contentDisposition).toMatch(
    /filename="maintenance-broken-tools-\d+\.csv"/,
  );

  // ─── Body bytes — UTF-8 BOM, header row in order, 1000-row cap ──────────
  // Excel needs the BOM to render Arabic correctly; assert on the raw
  // bytes before any decoder strips the signature.
  const csvBuf = csvCapture.body;
  expect(csvBuf.length).toBeGreaterThan(3);
  expect(csvBuf[0]).toBe(0xEF);
  expect(csvBuf[1]).toBe(0xBB);
  expect(csvBuf[2]).toBe(0xBF);

  const csvText = csvBuf.toString("utf8").replace(/^\uFEFF/, "");
  // sendCsv emits CRLF row separators; filter(Boolean) drops the trailing
  // empty element from a final CRLF (if any).
  const csvLines = csvText.split("\r\n").filter(Boolean);
  // Header row carries the four documented Arabic columns in this exact
  // order — toEqual asserts both content and order in one shot, mirroring
  // the route handler's `headers` array.
  const headerCells = csvLines[0].split(",");
  expect(headerCells).toEqual([
    "الشركة",
    "الأداة",
    "رسالة الخطأ",
    "وقت آخر فشل",
  ]);

  // 1000-row cap: BROKEN_CSV_ROW_CAP=1000 in admin.ts. We seeded 1000
  // padding pairs plus the beforeAll row (1001 ours alone) so the helper
  // sees ≥1001 candidates and must clip to exactly 1000 data rows. We
  // assert on the data-row count (not >= or <=) because any drift in the
  // cap — accidental bump, accidental removal, off-by-one — would change
  // this number and silently ship.
  //
  // Note: this assumes none of our padding rows contain CRLFs that would
  // split a logical CSV line into two physical lines. The padding's
  // `error` cells are simple ASCII ("pad <i> <ERROR_MSG>") and the helper
  // never inserts CRLFs into other columns (companyName/toolKey/runAt),
  // so split("\r\n") yields exactly one entry per row.
  expect(csvLines.length - 1).toBe(1000);

  // ─── Audit assertion — exactly one export_csv row was written ─────────
  // Mirrors the server-side comment on /maintenance/error-summary: the
  // export must record an audit entry under module='maintenance' /
  // action='export_csv' / entityType='maintenance_error_summary' with
  // companyId=null (broken tools span the whole fleet). Scoping the
  // lookup by createdAt >= our anchor avoids LIKE-style matches against
  // the JSON metadata column and keeps the assertion stable on a shared
  // dev DB.
  const auditRows = await db
    .select({
      id: auditLogTable.id,
      companyId: auditLogTable.companyId,
      metadata: auditLogTable.metadata,
    })
    .from(auditLogTable)
    .where(and(
      eq(auditLogTable.module, "maintenance"),
      eq(auditLogTable.action, "export_csv"),
      eq(auditLogTable.entityType, "maintenance_error_summary"),
      isNull(auditLogTable.companyId),
      gte(auditLogTable.createdAt, csvAuditAnchor!),
    ));
  expect(auditRows).toHaveLength(1);
  // Truncation visibility: when the cap kicks in, the audit row must
  // record both the *capped* row count AND the underlying total so a
  // SuperAdmin reviewing past exports can tell the data was clipped.
  // Without this assertion, the route could silently drop the new
  // metadata fields and the audit log would once again say "1000"
  // without any indication that 1500+ candidates existed.
  const meta = (auditRows[0].metadata ?? {}) as Record<string, unknown>;
  expect(meta.format).toBe("csv");
  expect(meta.count).toBe(1000);
  expect(meta.rowCap).toBe(1000);
  expect(meta.truncated).toBe(true);
  // We seeded 1000 padding rows + the beforeAll seed row (1001 ours),
  // and the dev DB may carry additional broken (company, tool) pairs
  // unrelated to this run. The real total must therefore be at least
  // 1001 — strictly greater than the cap, which is what truncation
  // means.
  expect(typeof meta.totalAvailable).toBe("number");
  expect(meta.totalAvailable as number).toBeGreaterThan(1000);
  // Track the id so afterAll can strip it by PK and the dev DB doesn't
  // accumulate test-only audit rows over time.
  for (const r of auditRows) seededAuditIds.push(r.id);
});

// ─── Task #128: unified truncation toast on the broken-tools CSV button ─────
// The page-side `errorSummaryCsvMut` reads X-Csv-Truncated / X-Csv-Row-Cap /
// X-Csv-Total-Available from the CSV response and renders a unified
// "تم الاقتطاع عند 1,000 من 1,001 صف" toast description (AICompanyFix.tsx
// ~line 1204), the same wording the four sibling export mutations use after
// task #121. The third test above already proves the server-side cap and
// audit-row contract on real data, but it can't assert the *exact* toast
// string because the underlying error-summary endpoint scopes globally and
// totalAvailable depends on however many other broken (company, tool) pairs
// the dev DB carries — a "من <unpredictable>" total would defeat the whole
// point of the assertion.
//
// This test fills that gap by mocking the CSV response with deterministic
// headers (truncated=1, rowCap=1000, totalAvailable=1001) and a minimal
// CSV body. The button is a real, on-screen button (the panel renders
// because the beforeAll seed ensures at least one broken tool exists), the
// click is a real React-driven click, and the toast assertion is on the
// same Sonner portal the user sees — so a regression that drops or mistypes
// the truncation copy in `errorSummaryCsvMut`'s onSuccess (e.g. forgets
// to read totalAvailable, falls back to the cap-only branch, or rewords
// the Arabic phrase) fails this test loudly. Mirrors the toast assertion
// in tool-history-csv-export.spec.ts ~line 698.
test("broken-tools panel: unified truncation toast renders after the actual CSV button click", async ({ page }) => {
  await installSuperAdminSession(page);

  // Mock the CSV response only — leave the JSON poll alone so the panel
  // still renders against real data (the beforeAll seed guarantees the
  // panel is visible). The page-side mutation builds its toast purely
  // from the X-Csv-* headers, so the body content is irrelevant beyond
  // satisfying the `await r.blob()` call inside `errorSummaryCsvMut`.
  await page.route("**/api/admin/maintenance/error-summary**", async (route, request) => {
    if (!request.url().includes("format=csv")) {
      await route.continue();
      return;
    }
    // Minimal valid CSV: BOM + header row only. The mutation just needs
    // a successful 200 + readable headers; it never inspects the body.
    const body = "\uFEFF" + "الشركة,الأداة,رسالة الخطأ,وقت آخر فشل\r\n";
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type":          "text/csv; charset=utf-8",
        "Content-Disposition":   `attachment; filename="maintenance-broken-tools-${Date.now()}.csv"`,
        // The three headers the mutation reads to drive the toast.
        // 1000 < 1001 so the `totalAvailable > rowCap` branch fires and
        // the description renders the "من 1,001" suffix — the exact
        // wording task #121 unified across all five export mutations.
        "X-Csv-Truncated":       "1",
        "X-Csv-Row-Cap":         "1000",
        "X-Csv-Total-Available": "1001",
      },
      body,
    });
  });

  await page.goto("/admin/ai-fix", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: PAGE_HEADING_RE })).toBeVisible();

  // Wait for the amber panel to render — gated on errorSummaryQ.data.items
  // .length > 0, which the beforeAll seed satisfies. Without this barrier
  // we'd race the React tree and the CSV button might not yet be mounted.
  const panel = page.locator("div", { hasText: PANEL_HEADER_PREFIX }).filter({
    has: page.locator("table"),
  }).first();
  await expect(panel).toBeVisible();

  // Click the export button via its data-testid (added on AICompanyFix
  // for exactly this hook). The click flows through the real React tree
  // and the real `errorSummaryCsvMut` mutation; only the network response
  // is controlled.
  await page.locator('[data-testid="error-summary-csv-button"]').click();

  // ─── Toast assertion — the whole point of task #128 ────────────────────
  // The unified "تم الاقتطاع عند 1,000 من 1,001 صف" copy must appear in
  // the document scope (Toaster lives at the root via App.tsx ~line 563
  // so the toast portals out of the panel and is queried from `page`).
  // Numeric formatting uses Number.toLocaleString("en-US") in
  // AICompanyFix.tsx so 1000 stays as "1,000" — the comma matters for
  // any total ≥ 4 digits. Mirrors the assertion in
  // tool-history-csv-export.spec.ts.
  await expect(
    page.getByText("تم الاقتطاع عند 1,000 من 1,001 صف"),
  ).toBeVisible();
  // Also assert the success title rendered, so a regression that flipped
  // the mutation into onError (and silently swallowed the truncation
  // suffix) would still trip this expectation.
  await expect(page.getByText("تم تنزيل ملف CSV").first()).toBeVisible();
});
