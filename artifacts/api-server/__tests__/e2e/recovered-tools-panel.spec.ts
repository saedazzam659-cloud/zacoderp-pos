// E2E test for the SuperAdmin "أدوات صيانة تعافت آخر 7 أيام" panel on
// /admin/ai-fix in the zatca-invoicing artifact (task #71).
//
// What this verifies (mirrors the regression task acceptance criteria):
//   1. Empty state — when GET /api/admin/maintenance/recent-recoveries
//      returns zero items, the green panel must NOT render at all (the
//      conditional in AICompanyFix.tsx around line 1841 is gated on
//      `recoverySummaryQ.data && recoverySummaryQ.data.items.length > 0`,
//      so an empty list keeps the page calm).
//   2. Populated state — after seeding a (company, tool) pair whose latest
//      maintenance_runs row is non-error and whose immediate predecessor
//      inside the 7-day window was 'error', the panel must:
//        - Be visible.
//        - Expose the four documented columns الشركة / الأداة / آخر خطأ /
//          وقت التعافي in its <thead>.
//        - Render exactly one row for our seeded TOOL_KEY (the dev DB may
//          carry other recoveries; we anchor on our unique tool key).
//        - Surface the seeded company's Arabic name in that row.
//   3. Tool-history affordance — clicking the tool-key button on the
//      seeded row opens the tool-history dialog, matching the equivalent
//      affordance on the amber broken-tool panel above.
//
// Determinism story:
//   - We create a brand-new `companies` row tagged with a per-run TEST_TAG
//     so the seeded recovery never collides with whatever else lives in the
//     shared dev DB.
//   - The tool key is also TEST_TAG-prefixed; assertions key on it instead
//     of on row counts, so other recoveries in the dev DB don't cause
//     false failures.
//   - The empty-state assertion is implemented by mocking the API endpoint
//     via page.route() so the test is independent of the global recovery
//     state — relying on "the dev DB happens to have zero recoveries right
//     now" would be flaky.
//   - The SuperAdmin auth short-circuit (insert sa_sessions row + write
//     localStorage zatca_token + zatca_session='sa-<id>') matches what the
//     login flow itself produces, so /api/auth/me returns the SuperAdmin
//     and the AICompanyFix route guard renders.
//
// Cleanup:
//   - Strict-by-PK: we record every inserted row id (maintenance_runs,
//     companies, sa_sessions) and delete by `eq`/`inArray` in the afterAll
//     hook. No LIKE / wildcards on production tables; a crashed run never
//     touches another tenant's data.
//   - We deliberately do NOT call `pool.end()` — see the matching note in
//     email-history-pagination.spec.ts. With workers=1, sibling specs share
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
const TEST_TAG = `e2e_task71_${randomBytes(4).toString("hex")}`;
// Tool key carries the full TEST_TAG so panel-row assertions can pinpoint
// our seeded recovery on a shared dev DB without relying on row counts.
const TOOL_KEY = `${TEST_TAG}_recovered_tool`;
// Header text the recovered-tool panel renders (AICompanyFix.tsx ~line 1846).
// Only matched as a prefix because the same line interpolates the window
// length ("آخر 7 أيام") which we don't want to hard-code.
const PANEL_HEADER_PREFIX = "أدوات صيانة تعافت آخر";

let saSessionRowId: number | null = null;
let saSessionToken: string | null = null;
let testCompanyId: number | null = null;
const seededRunIds: number[] = [];
// audit_log row id(s) the maintenance/recent-recoveries CSV export writes
// during the third test below. Tracked so afterAll can strip them by PK
// and the dev DB doesn't accumulate test-only audit rows over time.
const seededAuditIds: number[] = [];
// Anchor moment captured before the CSV export click so the audit-row
// lookup can scope its query to this test run instead of relying on a
// LIKE pattern (the export helper doesn't accept caller-supplied tags).
let recoveryAuditAnchor: Date | null = null;

// ─── Setup: create company, sa_session, and a recovery scenario ────────────
test.beforeAll(async () => {
  // Sweep any debris from a previous interrupted run before seeding. All
  // three patterns are namespaced strictly to this test (the maintenance
  // runs tag the toolKey column, the sa_sessions tag sessionToken, the
  // companies tag nameAr), so this can never touch real audit history,
  // real user sessions, or real tenant rows.
  await db
    .delete(maintenanceRunsTable)
    .where(like(maintenanceRunsTable.toolKey, "e2e_task71_%"));
  await db
    .delete(superAdminSessionsTable)
    .where(like(superAdminSessionsTable.sessionToken, "e2e_task71_%"));
  await db
    .delete(companiesTable)
    .where(like(companiesTable.nameAr, "e2e_task71_%"));

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
  saSessionToken = "e2e_task71_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task71",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  // Active test company so it's visible to getRecentToolRecoveries (which
  // joins `companies` and filters status='active'). The Arabic name carries
  // TEST_TAG so the on-page row text can be uniquely matched.
  const [co] = await db
    .insert(companiesTable)
    .values({
      nameAr:         `${TEST_TAG} شركة الاختبار للتعافي`,
      nameEn:         `${TEST_TAG} Test Co Recovery`,
      vatNumber:      "300000000000071",
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

  // Recovery scenario: an 'error' row 3 days ago followed by an 'ok' row 1
  // day ago. The LAG window function in getRecentToolRecoveries pairs them,
  // sees status='ok' with prev_status='error', and surfaces the (company,
  // tool) pair. Both timestamps sit comfortably inside the 7-day window
  // (TOOL_ERROR_WINDOW_DAYS in maintenanceScheduler.ts).
  const now = Date.now();
  const errRow = await db
    .insert(maintenanceRunsTable)
    .values({
      companyId:  testCompanyId,
      toolKey:    TOOL_KEY,
      status:     "error",
      count:      0,
      trigger:    "scheduled",
      runAt:      new Date(now - 3 * 86_400_000),
      durationMs: 1,
      error:      "boom from task #71 e2e",
      details:    null,
    })
    .returning({ id: maintenanceRunsTable.id });
  const okRow = await db
    .insert(maintenanceRunsTable)
    .values({
      companyId:  testCompanyId,
      toolKey:    TOOL_KEY,
      status:     "ok",
      count:      0,
      trigger:    "scheduled",
      runAt:      new Date(now - 1 * 86_400_000),
      durationMs: 1,
      error:      null,
      details:    null,
    })
    .returning({ id: maintenanceRunsTable.id });
  seededRunIds.push(errRow[0].id, okRow[0].id);
});

// ─── Cleanup: strict-by-PK so a crash never nukes unrelated audit history ──
// We deliberately do NOT call `pool.end()` — see the matching note in
// email-history-pagination.spec.ts.
test.afterAll(async () => {
  if (seededAuditIds.length) {
    // Strip the export_csv audit row(s) the third test triggered. Done
    // before the maintenance_runs / companies cleanup because audit rows
    // hold no FK back to those tables — but ordering this first keeps the
    // teardown narrative ("test artefacts → fixtures") readable.
    await db
      .delete(auditLogTable)
      .where(inArray(auditLogTable.id, seededAuditIds));
  }
  if (seededRunIds.length) {
    await db
      .delete(maintenanceRunsTable)
      .where(inArray(maintenanceRunsTable.id, seededRunIds));
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

test("recovered-tools panel: hidden when the API returns zero recoveries", async ({ page }) => {
  await installSuperAdminSession(page);

  // Mock the recovery endpoint BEFORE navigating so the initial render
  // path can never see real data. Other panels (errors, critical, fleet,
  // history…) keep their real responses so the page still loads normally
  // and we're testing exactly this panel's hidden-when-empty branch.
  await page.route("**/api/admin/maintenance/recent-recoveries**", async (route) => {
    await route.fulfill({
      status:      200,
      contentType: "application/json",
      body:        JSON.stringify({ count: 0, windowDays: 7, items: [] }),
    });
  });

  await page.goto("/admin/ai-fix", { waitUntil: "networkidle" });

  // Wait for the page heading so we know the SPA has mounted AICompanyFix
  // and the recovery query has had a chance to resolve under our mock.
  await expect(page.getByRole("heading", { name: PAGE_HEADING_RE })).toBeVisible();

  // The panel renders only when items.length > 0; with our mock it must
  // never appear in the DOM. The header phrase is unique to this panel
  // (other on-page Arabic copy doesn't repeat the "أدوات صيانة تعافت"
  // wording), so a count of 0 proves the conditional branch is taking
  // the hidden path.
  await expect(page.getByText(PANEL_HEADER_PREFIX)).toHaveCount(0);
});

test("recovered-tools panel: renders the seeded recovery with the four columns and opens the tool-history modal", async ({ page }) => {
  await installSuperAdminSession(page);

  await page.goto("/admin/ai-fix", { waitUntil: "networkidle" });

  // Wait for the SPA to mount the page first so the panel locator below
  // resolves against the rendered DOM and not the loading shell.
  await expect(page.getByRole("heading", { name: PAGE_HEADING_RE })).toBeVisible();

  // Locator scoped to the green panel via its header text. Anchoring on
  // the Arabic copy keeps assertions resilient to styling changes on the
  // surrounding container (the bg-emerald-50/40 / border-emerald-200
  // class chain could legitimately move without breaking the contract).
  const panel = page.locator("div", { hasText: PANEL_HEADER_PREFIX }).filter({
    has: page.locator("table"),
  }).first();
  await expect(panel).toBeVisible();

  // Column headers must include all four labels in <thead>. Asserting
  // each one separately (vs. a single combined string) gives a clearer
  // failure message if a header is renamed or removed.
  for (const col of ["الشركة", "الأداة", "آخر خطأ", "وقت التعافي"]) {
    await expect(panel.locator("thead th", { hasText: col })).toBeVisible();
  }

  // Find the row containing our unique TOOL_KEY. The dev DB may carry
  // other recoveries from real maintenance sweeps, so we never assert on
  // total row count — only on the presence of our seeded pair.
  const seededRow = panel.locator("tbody tr", { hasText: TOOL_KEY });
  await expect(seededRow).toHaveCount(1);
  // Same row must show our company's Arabic name (the company-name button
  // is the first cell). Using contains-text instead of an exact match
  // because the cell wraps the name in a button with a trailing tooltip.
  await expect(seededRow).toContainText("شركة الاختبار للتعافي");

  // Tool-key button on the row is the entry point into the tool-history
  // modal — same affordance as on the amber broken-tool panel. Clicking
  // it must open a Radix Dialog whose title is "آخر تشغيلات الأداة" and
  // which echoes our TOOL_KEY in the title bar.
  await seededRow.getByRole("button", { name: TOOL_KEY }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("آخر تشغيلات الأداة")).toBeVisible();
  await expect(dialog.getByText(TOOL_KEY)).toBeVisible();
});

test("recovered-tools panel: 'تنزيل CSV' downloads the recovered-tools list with the five Arabic headers, BOM, and the seeded row", async ({ page }) => {
  await installSuperAdminSession(page);

  // Capture the CSV bytes the user would have saved. The mutation in
  // AICompanyFix.tsx (recoverySummaryCsvMut) does fetch → .blob() → anchor
  // click, which drains Playwright's response body before we can read it
  // — so we intercept the network round-trip, refetch upstream, snapshot
  // the bytes + headers, then forward the same response to the page.
  // Mirrors the email-history CSV spec's capture pattern.
  const csvCaptures: {
    body: Buffer;
    contentType: string;
    contentDisposition: string;
  }[] = [];
  await page.route("**/api/admin/maintenance/recent-recoveries**", async (route, request) => {
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

  // Wait for the SPA + the green panel to render before clicking the
  // export button — the button only exists inside the panel, which is
  // gated on `recoverySummaryQ.data.items.length > 0`.
  await expect(page.getByRole("heading", { name: PAGE_HEADING_RE })).toBeVisible();
  const panel = page.locator("div", { hasText: PANEL_HEADER_PREFIX }).filter({
    has: page.locator("table"),
  }).first();
  await expect(panel).toBeVisible();
  // Stable handle on the seeded row so we know the recovery scenario is on
  // screen before exporting (the server pulls all rows via the same helper,
  // but waiting here guarantees the test isn't racing the initial query).
  await expect(panel.locator("tbody tr", { hasText: TOOL_KEY })).toHaveCount(1);

  // Anchor a wall-clock moment just before the export so the audit-row
  // lookup below can scope itself to this run; writeAudit() uses defaultNow
  // for created_at so a >= filter on this anchor will only match rows the
  // export we triggered (or a concurrent test run, which is impossible
  // here because workers=1).
  recoveryAuditAnchor = new Date(Date.now() - 1_000); // 1s slack for clock skew

  // Click the CSV export button by its data-testid (added in task #73 for
  // exactly this hook). page.route() above will record the bytes.
  await page.locator('[data-testid="recent-recoveries-csv-button"]').click();
  await expect.poll(() => csvCaptures.length, { timeout: 15_000 }).toBe(1);
  const csvCapture = csvCaptures[0];

  // ─── Response headers — Content-Type and the filename pattern ───────────
  // sendCsv() sets `text/csv; charset=utf-8`; the substring check tolerates
  // case differences in the charset clause without depending on order.
  expect(csvCapture.contentType.toLowerCase()).toContain("text/csv");
  // Filename advertised to the browser must follow the
  // `maintenance-recent-recoveries-<unix-ms>.csv` pattern — the same
  // identifier the page-side mutation falls back to and that operators
  // recognise when reviewing downloads.
  expect(csvCapture.contentDisposition).toMatch(
    /filename="maintenance-recent-recoveries-\d+\.csv"/,
  );

  // ─── Body bytes — UTF-8 BOM, header row, seeded row ─────────────────────
  // Excel needs the BOM to render Arabic correctly; assert on the raw
  // bytes before any decoder strips the signature.
  const csvBuf = csvCapture.body;
  expect(csvBuf.length).toBeGreaterThan(3);
  expect(csvBuf[0]).toBe(0xEF);
  expect(csvBuf[1]).toBe(0xBB);
  expect(csvBuf[2]).toBe(0xBF);

  const csvText = csvBuf.toString("utf8").replace(/^\uFEFF/, "");
  const csvLines = csvText.split("\r\n").filter(Boolean);
  // Header line carries the five documented Arabic columns in order.
  // Asserting each column individually gives a clearer failure message
  // than a single combined-string check if a header is renamed.
  const headerCells = csvLines[0].split(",");
  for (const col of ["الشركة", "الأداة", "آخر خطأ", "وقت التعافي", "حالة الفحص الحالي"]) {
    expect(headerCells).toContain(col);
  }
  expect(headerCells).toHaveLength(5);

  // The seeded recovery must be in the body. We don't assert on total row
  // count because the dev DB may carry other recent recoveries — only on
  // the presence of *our* (company, tool) pair, identified by the unique
  // TOOL_KEY plus the company's Arabic name on the same line.
  const seededLine = csvLines.slice(1).find(
    (line) => line.includes(TOOL_KEY) && line.includes("شركة الاختبار للتعافي"),
  );
  expect(seededLine, `expected a CSV row containing TOOL_KEY=${TOOL_KEY} and the seeded company name`).toBeDefined();

  // ─── Audit assertion — exactly one export_csv row was written ─────────
  // Mirrors the server-side comment on /maintenance/recent-recoveries:
  // the export must record an audit entry under module='maintenance' /
  // action='export_csv' / entityType='maintenance_recent_recoveries'
  // with companyId=null (recoveries are global). Scoping the lookup by
  // createdAt >= our anchor avoids LIKE-style matches against the JSON
  // metadata column and keeps the assertion stable on a shared dev DB.
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
      eq(auditLogTable.entityType, "maintenance_recent_recoveries"),
      isNull(auditLogTable.companyId),
      gte(auditLogTable.createdAt, recoveryAuditAnchor!),
    ));
  expect(auditRows).toHaveLength(1);
  // Truncation visibility — even when the cap doesn't kick in, the audit
  // row must carry the new `truncated`/`rowCap`/`totalAvailable` fields
  // so a future SuperAdmin reviewing past exports can tell at a glance
  // whether the data was clipped (the broken-tools spec covers the
  // truncated=true branch with 1000+ seeded pairs; here we lock in the
  // shape of the non-truncated branch). Without this assertion, the
  // route could silently drop the truncation fields and a real clipped
  // export would once again be indistinguishable from a complete one.
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
  // The dev DB may carry other recoveries unrelated to this run, so we
  // can't assert an exact row count — but our seeded recovery must be
  // included, which means at least one row was exported.
  expect(meta.count as number).toBeGreaterThanOrEqual(1);
  // Track the id so afterAll can strip it by PK and the dev DB doesn't
  // accumulate test-only audit rows over time.
  for (const r of auditRows) seededAuditIds.push(r.id);
});

// ─── Task #128: unified truncation toast on the recovered-tools CSV button ──
// The page-side `recoverySummaryCsvMut` reads X-Csv-Truncated / X-Csv-Row-Cap /
// X-Csv-Total-Available from the CSV response and renders the unified
// "تم الاقتطاع عند 1,000 من 1,001 صف" toast description (AICompanyFix.tsx
// ~line 1287), the same wording the four sibling export mutations use after
// task #121. The third test above proves the on-screen click + body bytes
// + audit row contract on real data, but never asserts the toast text — and
// the recent-recoveries endpoint scopes globally so totalAvailable depends
// on however many other recoveries the dev DB carries, which would defeat
// any "من <N>" assertion built on top of real data.
//
// This test fills that gap by mocking the CSV response with deterministic
// headers (truncated=1, rowCap=1000, totalAvailable=1001) and a minimal
// CSV body. The button is the real on-screen button (panel renders because
// the beforeAll seed ensures at least one recovery exists), the click is a
// real React-driven click, and the toast assertion is on the same Sonner
// portal the user sees — so a regression that drops or mistypes the
// truncation copy in `recoverySummaryCsvMut`'s onSuccess fails this test
// loudly. Mirrors the toast assertion in tool-history-csv-export.spec.ts
// ~line 698.
test("recovered-tools panel: unified truncation toast renders after the actual CSV button click", async ({ page }) => {
  await installSuperAdminSession(page);

  // Mock the CSV response only — leave the JSON poll alone so the panel
  // still renders against real data (the beforeAll seed guarantees the
  // panel is visible). The page-side mutation builds its toast purely
  // from the X-Csv-* headers, so the body content is irrelevant beyond
  // satisfying the `await r.blob()` call inside `recoverySummaryCsvMut`.
  await page.route("**/api/admin/maintenance/recent-recoveries**", async (route, request) => {
    if (!request.url().includes("format=csv")) {
      await route.continue();
      return;
    }
    // Minimal valid CSV: BOM + header row only. The mutation just needs
    // a successful 200 + readable headers; it never inspects the body.
    const body = "\uFEFF" + "الشركة,الأداة,آخر خطأ,وقت التعافي,حالة الفحص الحالي\r\n";
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type":          "text/csv; charset=utf-8",
        "Content-Disposition":   `attachment; filename="maintenance-recent-recoveries-${Date.now()}.csv"`,
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

  // Wait for the green panel to render — gated on
  // recoverySummaryQ.data.items.length > 0, which the beforeAll seed
  // satisfies. Without this barrier we'd race the React tree and the
  // CSV button might not yet be mounted.
  const panel = page.locator("div", { hasText: PANEL_HEADER_PREFIX }).filter({
    has: page.locator("table"),
  }).first();
  await expect(panel).toBeVisible();

  // Click the export button via its data-testid (added on AICompanyFix
  // for exactly this hook). The click flows through the real React tree
  // and the real `recoverySummaryCsvMut` mutation; only the network
  // response is controlled.
  await page.locator('[data-testid="recent-recoveries-csv-button"]').click();

  // ─── Toast assertion — the whole point of task #128 ────────────────────
  // The unified "تم الاقتطاع عند 1,000 من 1,001 صف" copy must appear in
  // the document scope (Toaster lives at the root via App.tsx so the
  // toast portals out of the panel and is queried from `page`). Numeric
  // formatting uses Number.toLocaleString("en-US") in AICompanyFix.tsx
  // so 1000 stays as "1,000" — the comma matters for any total ≥ 4
  // digits. Mirrors the assertion in tool-history-csv-export.spec.ts.
  await expect(
    page.getByText("تم الاقتطاع عند 1,000 من 1,001 صف"),
  ).toBeVisible();
  // Also assert the success title rendered, so a regression that flipped
  // the mutation into onError (and silently swallowed the truncation
  // suffix) would still trip this expectation.
  await expect(page.getByText("تم تنزيل ملف CSV").first()).toBeVisible();
});
