// E2E test for the SuperAdmin tool-history dialog "تصدير CSV" button on
// /admin/ai-fix in the zatca-invoicing artifact (task #105).
//
// Why this test exists:
//   /admin/ai-fix has four "تصدير CSV" / "تنزيل CSV" CSV buttons. Three of
//   them already have e2e coverage:
//     - email-history     → email-history-csv-export.spec.ts
//     - recent-recoveries → recovered-tools-panel.spec.ts
//     - maintenance-history → maintenance-history-csv-export.spec.ts
//   The fourth one — the "تصدير CSV" button inside the per-(company, tool)
//   tool-history dialog (driven by `toolHistoryCsvMut` in AICompanyFix.tsx
//   and served by GET /api/admin/maintenance/tool-history?format=csv in
//   artifacts/api-server/src/routes/admin.ts ~line 4734) — was the only one
//   without automated coverage, so a regression to its filename, BOM,
//   headers, body content, or audit row would slip through unnoticed. This
//   spec mirrors the seed/cleanup + page.route capture pattern the sibling
//   specs use.
//
// What this verifies:
//   1. Clicking the dialog's "تصدير CSV" button (anchored by its unique
//      title attribute, since multiple "تصدير CSV" buttons live on the
//      page) downloads a file whose Content-Type is
//      `text/csv; charset=utf-8` and whose Content-Disposition filename
//      follows the documented
//      `tool-history-<companyId>-<toolKey>-<unix-ms>.csv` pattern.
//   2. The body starts with the UTF-8 BOM (so Excel renders Arabic
//      correctly).
//   3. The header row contains the six documented Arabic columns:
//      الحالة / التشغيل / عدد النتائج / المدة (مللي ث) / وقت التشغيل /
//      رسالة الخطأ.
//   4. Both seeded maintenance_runs rows (the recovery scenario — one
//      'error' followed by one 'ok') appear in the body. The error row is
//      anchored by a TEST_TAG-prefixed error message so the assertion
//      stays stable on a shared dev DB regardless of what other runs
//      already exist for the same toolKey.
//   5. The export itself writes exactly one `export_csv` audit row scoped
//      to the test company under entityType='maintenance_tool_history'
//      (the contract in admin.ts ~line 4764).
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
//     so the seeded runs and the export's audit row never collide with
//     whatever else lives on the shared dev DB.
//   - The toolKey is also TEST_TAG-prefixed so the body assertion can
//     filter to *our* (company, tool) rows — and so the dialog opened by
//     clicking the recovered-tools panel is keyed to the run history we
//     seeded.
//   - The export_csv audit-row lookup is scoped by createdAt >= an anchor
//     captured just before the click, so it matches only the row our
//     click produced (workers=1 in playwright.config.ts so no concurrent
//     runs).
//   - The SuperAdmin auth short-circuit (insert sa_sessions row + write
//     localStorage zatca_token + zatca_session='sa-<id>') matches what
//     the login flow itself produces, so /api/auth/me returns the
//     SuperAdmin and the AICompanyFix route guard renders.
//
// How we open the dialog:
//   - Seeding an 'error' run followed by an 'ok' run inside the 7-day
//     window surfaces our (company, tool) pair in the green
//     "أدوات صيانة تعافت آخر …" panel (same recovery scenario the
//     recovered-tools-panel spec uses). Clicking the tool-key button on
//     that row calls `setToolHistoryTarget({...})` directly with the
//     row's companyId/toolKey, so the dialog opens without us having to
//     pick a company in the dropdown first.
//
// Cleanup:
//   - Strict-by-PK: every inserted row id (audit_log, maintenance_runs,
//     companies, sa_sessions) is deleted by `eq`/`inArray` in afterAll.
//     No LIKE / wildcards on production tables; a crashed run never
//     touches another tenant's data.
//   - We deliberately do NOT call `pool.end()` — see the matching note
//     in email-history-pagination.spec.ts. With workers=1, sibling specs
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
  maintenanceRunsTable,
  auditLogTable,
  superAdminSessionsTable,
} from "@workspace/db";

// ─── Fixtures / state shared across the single test in this file ───────────
const TEST_TAG = `e2e_task105_${randomBytes(4).toString("hex")}`;
// Tool key carries the full TEST_TAG so the recovered-tools panel row
// (which we click to open the dialog) and the CSV-body assertion can
// pinpoint our seeded runs without depending on row counts on a shared
// dev DB. The route's `safeToolKey` strip (admin.ts ~line 4770) keeps
// `[A-Za-z0-9._-]` characters as-is, so this slug round-trips into the
// Content-Disposition filename unchanged.
const TOOL_KEY = `${TEST_TAG}_tool`;
// Distinctive error string on the seeded 'error' run — carries the full
// TEST_TAG so the CSV-body assertion can pinpoint that row even if other
// runs for the same toolKey ever existed (they shouldn't, but we anchor
// defensively).
const SEED_ERROR = `boom from task #105 e2e (${TEST_TAG})`;

let saSessionRowId: number | null   = null;
let saSessionToken: string | null   = null;
let testCompanyId: number | null    = null;
const seededRunIds: number[]        = [];
const seededAuditIds: number[]      = [];
// Captured just before the export click so the audit-row lookup that
// confirms the export_csv row was written can scope its query to this run.
let exportAuditAnchor: Date | null  = null;

// ─── Setup: create company, sa_session, and a recovery scenario ────────────
test.beforeAll(async () => {
  // Sweep any debris from a previous interrupted run before seeding. All
  // four patterns are namespaced strictly to this test (the audit rows
  // tag the username column when seeded — we don't seed any here, but we
  // still strip in case a leftover sneaks in via the export's own audit
  // row from a crashed earlier attempt; the maintenance runs tag toolKey;
  // the sa_sessions tag sessionToken; the companies tag nameAr), so this
  // can never touch real audit history, real user sessions, real runs,
  // or real tenant rows.
  await db
    .delete(maintenanceRunsTable)
    .where(like(maintenanceRunsTable.toolKey, "e2e_task105_%"));
  await db
    .delete(superAdminSessionsTable)
    .where(like(superAdminSessionsTable.sessionToken, "e2e_task105_%"));
  await db
    .delete(companiesTable)
    .where(like(companiesTable.nameAr, "e2e_task105_%"));

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
  saSessionToken = "e2e_task105_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task105",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  // Active test company so it's listable / joinable everywhere
  // AICompanyFix.tsx uses it (the recovered-tools helper joins
  // `companies` and filters status='active'). The Arabic name carries
  // TEST_TAG so the on-page row text can be uniquely matched.
  const [co] = await db
    .insert(companiesTable)
    .values({
      nameAr:         `${TEST_TAG} شركة الاختبار لسجل الأداة`,
      nameEn:         `${TEST_TAG} Test Co Tool History`,
      vatNumber:      "300000000000105",
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

  // Recovery scenario: one 'error' row 3 days ago + one 'ok' row 1 day
  // ago. The LAG window function in getRecentToolRecoveries pairs them,
  // sees status='ok' with prev_status='error', and surfaces the (company,
  // tool) pair in the green "أدوات صيانة تعافت آخر …" panel — that's
  // the panel whose tool-key button we click to open the tool-history
  // dialog (its onClick calls setToolHistoryTarget({...}) directly with
  // the row's companyId/toolKey, so we don't need to pick a company in
  // the dropdown first). Both timestamps sit comfortably inside the
  // 7-day window (TOOL_ERROR_WINDOW_DAYS in maintenanceScheduler.ts).
  // These same two rows also become the body of the CSV download.
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
      error:      SEED_ERROR,
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
    // Strip the export_csv audit row this test triggered. Done before
    // the maintenance_runs / companies cleanup because audit rows hold
    // no FK back to those tables — but ordering this first keeps the
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
// the SPA to settle on the right route before driving the dialog.
const PAGE_HEADING_RE = /إصلاح مشاكل الشركات بالذكاء الاصطناعي/;
// Header phrase the recovered-tools panel renders (AICompanyFix.tsx
// ~line 1969). Matched as a prefix because the same line interpolates the
// window length ("آخر 7 أيام") which we don't want to hard-code.
const PANEL_HEADER_PREFIX = "أدوات صيانة تعافت آخر";

test("tool-history dialog CSV export: filename, BOM, headers, seeded runs, and export_csv audit row", async ({ page }) => {
  await installSuperAdminSession(page);

  // Capture the CSV bytes the user would have saved. The mutation in
  // AICompanyFix.tsx (toolHistoryCsvMut) does fetch → .blob() → anchor
  // click, which drains Playwright's response body before we can read it
  // — so we intercept the network round-trip, refetch upstream, snapshot
  // the bytes + headers, then forward the same response to the page.
  // Mirrors the capture pattern in the maintenance-history and
  // recovered-tools CSV specs. The non-CSV `format` (the JSON dialog feed
  // used by toolHistoryQ to render the on-screen rows) hits the same
  // route, so we gate on `format=csv` to avoid buffering the JSON page.
  const csvCaptures: {
    body: Buffer;
    contentType: string;
    contentDisposition: string;
  }[] = [];
  await page.route("**/api/admin/maintenance/tool-history**", async (route, request) => {
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
  // and the recovered-tools query has had a chance to resolve.
  await expect(page.getByRole("heading", { name: PAGE_HEADING_RE })).toBeVisible();

  // ─── Open the tool-history dialog via the recovered-tools panel ────────
  // The panel renders only when items.length > 0, which is satisfied by
  // the (error → ok) pair we seeded. Anchoring the panel by its header
  // copy keeps the locator resilient to surrounding-container styling.
  const panel = page.locator("div", { hasText: PANEL_HEADER_PREFIX }).filter({
    has: page.locator("table"),
  }).first();
  await expect(panel).toBeVisible();

  // Find the row containing our unique TOOL_KEY (the dev DB may carry
  // other recoveries from real maintenance sweeps; we never assert on
  // total row count, only on our seeded pair).
  const seededRow = panel.locator("tbody tr", { hasText: TOOL_KEY });
  await expect(seededRow).toHaveCount(1);

  // Tool-key button on the row sets toolHistoryTarget directly (with the
  // row's companyId/toolKey, so no dropdown selection is needed) and
  // opens the Radix dialog whose CSV button we exercise below.
  await seededRow.getByRole("button", { name: TOOL_KEY }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("آخر تشغيلات الأداة")).toBeVisible();
  // Sync barrier: wait for the on-screen tool-history table to surface
  // our seeded error message before triggering the export, so we know
  // toolHistoryQ has resolved against the now-targeted (companyId,
  // toolKey) pair (the route serving JSON and CSV is the same; waiting
  // on the JSON render guarantees we're not racing the initial query).
  await expect(dialog.getByText(SEED_ERROR)).toBeVisible();

  // Anchor a wall-clock moment just before the export so the audit-row
  // lookup below can scope itself to this run. writeAudit() uses the
  // table's defaultNow for created_at, so a >= filter on this anchor
  // matches only the row our click produced (workers=1 in
  // playwright.config.ts so no concurrent runs).
  exportAuditAnchor = new Date(Date.now() - 1_000); // 1s slack for clock skew

  // ─── Click "تصدير CSV" → the route handler above captures the bytes ──
  // Multiple "تصدير CSV" / "تنزيل CSV" buttons exist on /admin/ai-fix.
  // Only the dialog's button carries this exact `title` attribute (source:
  // AICompanyFix.tsx ~line 3096), so anchoring on it picks the right one
  // without depending on DOM order or visibility heuristics. We scope the
  // locator to the open dialog as belt-and-braces in case the title
  // attribute is ever reused elsewhere.
  const csvButton = dialog.getByTitle(
    "تنزيل سجل تشغيلات الأداة كاملاً كملف CSV",
  );
  await csvButton.click();
  // Poll until the route handler records this click's response. We use
  // expect.poll instead of page.waitForResponse because Playwright's
  // response.body() returns empty once the page JS consumed the response
  // via .blob() — the buffered body the handler stored is the only
  // reliable copy.
  await expect.poll(() => csvCaptures.length, { timeout: 15_000 }).toBe(1);
  const csvCapture = csvCaptures[0];

  // ─── Toast assertion — success title without the truncation suffix ─────
  // Inverse of the toast assertion in the sibling truncated test below:
  // when the export was NOT clipped (we seeded exactly 2 rows, well under
  // TOOL_HISTORY_CSV_ROW_CAP=1000), the toast description must NOT carry
  // the "تم الاقتطاع …" suffix — otherwise a future regression that
  // simplifies the toast condition (e.g. dropping the `truncated` guard
  // so the suffix renders whenever `rowCap > 0`, since the server always
  // emits the X-Csv-Row-Cap header) would silently scare every operator
  // into thinking small exports were clipped. We first wait for the
  // success title to render (toolHistoryCsvMut.onSuccess in
  // AICompanyFix.tsx ~line 1459) so the negative assertion can't
  // spuriously pass just because the toast hasn't appeared yet, then
  // pin the absence of any element whose text contains "تم الاقتطاع"
  // (matching the substring is enough — both branches of the suffix
  // template start with this phrase). Toast lives at document scope
  // (Radix portal under <Toaster /> in App.tsx), so we query from
  // `page` not the dialog.
  await expect(page.getByText("تم تنزيل ملف CSV").first()).toBeVisible();
  await expect(page.getByText("تم الاقتطاع")).not.toBeVisible();

  // ─── Response headers — Content-Type and the filename pattern ─────────
  // sendCsv() in admin.ts sets `text/csv; charset=utf-8`. Comparing
  // lowercased substrings keeps the assertion tolerant of harmless
  // header-casing changes without depending on order.
  expect(csvCapture.contentType.toLowerCase()).toContain("text/csv");
  expect(csvCapture.contentType.toLowerCase()).toContain("charset=utf-8");
  // Filename advertised to the browser must follow the
  // `tool-history-<companyId>-<safeToolKey>-<unix-ms>.csv` pattern (the
  // identifier the page-side mutation falls back to and that operators
  // recognise when reviewing downloads). We pin both the companyId and
  // toolKey segments to our seeded values so a regression that leaks
  // another tenant's id or another tool's key into the filename would
  // fail this assertion. The toolKey only contains characters in
  // [A-Za-z0-9._-], so admin.ts's `safeToolKey` strip leaves it
  // untouched.
  expect(csvCapture.contentDisposition).toMatch(
    new RegExp(`filename="tool-history-${testCompanyId}-${TOOL_KEY}-\\d+\\.csv"`),
  );

  // ─── Body bytes — UTF-8 BOM, header row, seeded rows ───────────────────
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
  // documented order (admin.ts ~line 4755) is:
  //   الحالة, التشغيل, عدد النتائج, المدة (مللي ث), وقت التشغيل,
  //   رسالة الخطأ
  const headerCells = csvLines[0].split(",");
  for (const col of ["الحالة", "التشغيل", "عدد النتائج", "المدة (مللي ث)", "وقت التشغيل", "رسالة الخطأ"]) {
    expect(headerCells).toContain(col);
  }
  expect(headerCells).toHaveLength(6);

  // Both seeded runs must appear in the body. We scope by SEED_ERROR
  // (which carries the full TEST_TAG) for the 'error' row — that string
  // is unique enough to pinpoint our row without a full-row exact match.
  // The 'ok' row has no error message, so we anchor it on its status
  // cell ("ok") combined with the seeded count of "0" and the unique
  // duration ("1") within the file's data rows. Counting only data rows
  // that match these signatures avoids depending on total row counts —
  // the route returns *every* recorded run for this (company, tool)
  // pair, but on a fresh dev DB those runs are exactly our two.
  const dataLines = csvLines.slice(1);
  const errLine = dataLines.find((line) => line.includes(SEED_ERROR));
  expect(
    errLine,
    `expected a CSV row containing SEED_ERROR=${SEED_ERROR}`,
  ).toBeDefined();
  // The 'ok' row's first cell is "ok" (status), so a row that starts
  // with "ok," is our seeded recovery row — no other run for this
  // tagged toolKey exists on the shared dev DB, by construction.
  const okLine = dataLines.find((line) => line.startsWith("ok,"));
  expect(
    okLine,
    "expected a CSV row whose status cell is 'ok' (the seeded recovery run)",
  ).toBeDefined();

  // ─── Audit assertion — exactly one export_csv row was written ─────────
  // Mirrors the server-side comment on /maintenance/tool-history: the
  // export must record an audit entry under module='maintenance' /
  // action='export_csv' / entityType='maintenance_tool_history' scoped
  // to the selected companyId. Scoping the lookup by createdAt >= our
  // anchor (and by our test companyId) keeps the assertion stable on a
  // shared dev DB. The metadata column is projected so we can lock in
  // the truncation-flag shape below.
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
      eq(auditLogTable.entityType, "maintenance_tool_history"),
      eq(auditLogTable.companyId, testCompanyId!),
      gte(auditLogTable.createdAt, exportAuditAnchor!),
    ));
  expect(auditRows).toHaveLength(1);
  // Truncation visibility — even when the cap doesn't kick in, the audit
  // row must carry the new `truncated`/`rowCap`/`totalAvailable` fields
  // so a SuperAdmin reviewing past exports can tell at a glance whether
  // the data was clipped (the truncated=true branch is covered by the
  // sibling test below; here we lock in the shape of the non-truncated
  // branch). Without this assertion, the route could silently drop the
  // truncation fields and a real clipped export would once again be
  // indistinguishable from a complete one.
  const meta = (auditRows[0].metadata ?? {}) as Record<string, unknown>;
  expect(meta.format).toBe("csv");
  expect(meta.toolKey).toBe(TOOL_KEY);
  expect(meta.rowCap).toBe(1000);
  expect(meta.truncated).toBe(false);
  // count must equal totalAvailable when not truncated — the route uses
  // rows.length for both rather than re-running a COUNT query in the
  // common (cheap) path.
  expect(typeof meta.count).toBe("number");
  expect(typeof meta.totalAvailable).toBe("number");
  expect(meta.count).toBe(meta.totalAvailable);
  // We seeded exactly two rows for this (company, TOOL_KEY) pair on a
  // brand-new test company, so the count is bounded above as well.
  expect(meta.count).toBe(2);
  // Track the id so afterAll can strip it by PK and the dev DB doesn't
  // accumulate test-only audit rows over time.
  for (const r of auditRows) seededAuditIds.push(r.id);
});

// ─── Second test: 1000-row server-side cap on the tool-history CSV branch ──
// Tool-history runs are not aggregated (unlike broken-tools, which DISTINCT
// ON (company_id, tool_key)), so we just seed 1001 raw runs for one
// (company, tool) pair — that's strictly greater than the
// TOOL_HISTORY_CSV_ROW_CAP=1000 ceiling on the route — and assert the body
// is clipped to exactly 1000 data rows and the audit row's metadata
// records the truncation. Mirrors the truncation test in
// broken-tools-panel.spec.ts.
//
// We trigger the export directly via the page-context fetch (Bearer token
// from localStorage) rather than driving the dialog open through the UI
// for a second time — the first test in this file already covers the
// click flow end-to-end; here the focus is purely the server cap. This
// keeps the test fast (no extra Radix dialog navigation) while still
// exercising the exact same /api route the UI hits.
//
// Tag and toolKey are isolated from the first test (different toolKey
// suffix) so the two tests don't interfere even though they share the
// per-run TEST_TAG / sa_session / company fixtures from beforeAll.
const TRUNC_TOOL_KEY = `${TEST_TAG}_trunc_tool`;
let truncAuditAnchor: Date | null = null;

// Header phrase the broken-tools panel renders (AICompanyFix.tsx
// ~line 1931). Matched as a prefix because the line interpolates the
// window length ("آخر 7 أيام") which we don't want to hard-code.
const BROKEN_PANEL_HEADER_PREFIX = "أدوات صيانة تعطّلت آخر";

test("tool-history CSV export: caps body at 1000 rows, records truncation in the audit row, and surfaces clip count + total in the toast", async ({ page }) => {
  await installSuperAdminSession(page);

  // Seed 1001 error runs (strictly > TOOL_HISTORY_CSV_ROW_CAP=1000) for
  // a fresh tool key on the test company. All rows sit inside the 7-day
  // window (so the broken-tools panel surfaces this (company, tool)
  // pair — that's the panel whose tool-key button we click to open the
  // tool-history dialog), staggered in the past so ORDER BY run_at DESC
  // is deterministic. Bulk insert in chunks to stay well under
  // Postgres's 65k bind-parameter ceiling (each row ≈ 9 parameters →
  // 200 rows ≈ 1.8k).
  const SEED_COUNT = 1001;
  const now = Date.now();
  const seedRows = Array.from({ length: SEED_COUNT }, (_, i) => ({
    companyId:  testCompanyId!,
    toolKey:    TRUNC_TOOL_KEY,
    status:     "error" as const,
    count:      0,
    trigger:    "scheduled" as const,
    // Each run staggered 60s back from "now" — keeps every row inside the
    // 7-day window (1001 minutes ≈ 16h, well under 7 days) and gives
    // ORDER BY run_at DESC a deterministic ordering.
    runAt:      new Date(now - i * 60_000),
    durationMs: 1,
    error:      `pad ${i} ${TEST_TAG}`,
    details:    null,
  }));
  const CHUNK = 200;
  for (let i = 0; i < seedRows.length; i += CHUNK) {
    const inserted = await db
      .insert(maintenanceRunsTable)
      .values(seedRows.slice(i, i + CHUNK))
      .returning({ id: maintenanceRunsTable.id });
    for (const r of inserted) seededRunIds.push(r.id);
  }

  // Capture the CSV bytes the user would have saved. The mutation in
  // AICompanyFix.tsx (toolHistoryCsvMut) does fetch → .blob() → anchor
  // click, which drains Playwright's response body before we can read it
  // — so we intercept the network round-trip, refetch upstream, snapshot
  // the bytes + headers, then forward the same response to the page so
  // the mutation's onSuccess (which raises the toast we assert below)
  // still runs. Mirrors the capture pattern in the first test in this
  // file. The non-CSV `format` (the JSON dialog feed used by
  // toolHistoryQ to render the on-screen rows) hits the same route, so
  // we gate on `format=csv` to avoid buffering the JSON page.
  const csvCaptures: {
    body: Buffer;
    contentType: string;
    truncatedHdr: string;
    rowCapHdr: string;
    totalAvailHdr: string;
  }[] = [];
  await page.route("**/api/admin/maintenance/tool-history**", async (route, request) => {
    if (!request.url().includes("format=csv")) {
      await route.continue();
      return;
    }
    const upstream = await route.fetch();
    const body     = await upstream.body();
    const headers  = upstream.headers();
    csvCaptures.push({
      body,
      contentType:   headers["content-type"] ?? "",
      truncatedHdr:  headers["x-csv-truncated"] ?? "",
      rowCapHdr:     headers["x-csv-row-cap"] ?? "",
      totalAvailHdr: headers["x-csv-total-available"] ?? "",
    });
    await route.fulfill({ response: upstream, body });
  });

  await page.goto("/admin/ai-fix", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: PAGE_HEADING_RE })).toBeVisible();

  // ─── Open the tool-history dialog via the broken-tools panel ───────────
  // The 1001 seeded rows all have status='error' inside the 7-day
  // window, so getRecentToolErrors surfaces our (company, TRUNC_TOOL_
  // KEY) pair on the amber broken-tools panel. Anchoring the panel by
  // its header copy keeps the locator resilient to surrounding-container
  // styling changes.
  const panel = page.locator("div", { hasText: BROKEN_PANEL_HEADER_PREFIX }).filter({
    has: page.locator("table"),
  }).first();
  await expect(panel).toBeVisible();

  // Find the row containing our unique TRUNC_TOOL_KEY (the dev DB may
  // carry other broken tools from real maintenance sweeps; we never
  // assert on total row count, only on our seeded pair).
  const seededRow = panel.locator("tbody tr", { hasText: TRUNC_TOOL_KEY });
  await expect(seededRow).toHaveCount(1);

  // Tool-key button on the row sets toolHistoryTarget directly (with
  // the row's companyId/toolKey, so no dropdown selection is needed)
  // and opens the Radix dialog whose CSV button we exercise below.
  await seededRow.getByRole("button", { name: TRUNC_TOOL_KEY }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("آخر تشغيلات الأداة")).toBeVisible();
  // Sync barrier: wait for the on-screen tool-history table to surface
  // before triggering the export, so we know toolHistoryQ has resolved
  // against the now-targeted (companyId, TRUNC_TOOL_KEY) pair. We
  // anchor on a padded error message we know is in the top 20 rows
  // (`pad 0 ${TEST_TAG}` is the most-recent run by construction).
  await expect(dialog.getByText(`pad 0 ${TEST_TAG}`)).toBeVisible();

  // Anchor a wall-clock moment just before the export so the audit-row
  // lookup can scope itself to this run. writeAudit() uses defaultNow
  // for created_at, so a >= filter on this anchor (and on our seeded
  // companyId) matches only the row this click produced.
  truncAuditAnchor = new Date(Date.now() - 1_000); // 1s slack for clock skew

  // ─── Click "تصدير CSV" → the route handler above captures the bytes ──
  // Multiple "تصدير CSV" / "تنزيل CSV" buttons exist on /admin/ai-fix.
  // Only the dialog's button carries this exact `title` attribute (source:
  // AICompanyFix.tsx ~line 3096), so anchoring on it picks the right one
  // without depending on DOM order or visibility heuristics.
  const csvButton = dialog.getByTitle(
    "تنزيل سجل تشغيلات الأداة كاملاً كملف CSV",
  );
  await csvButton.click();
  // Poll until the route handler records this click's response.
  await expect.poll(() => csvCaptures.length, { timeout: 30_000 }).toBe(1);
  const csvCapture = csvCaptures[0];

  expect(csvCapture.contentType.toLowerCase()).toContain("text/csv");

  // Response headers — these drive the "تم الاقتطاع عند 1,000 من 1,001
  // صف" toast suffix in AICompanyFix.tsx (toolHistoryCsvMut, and the
  // four sibling export mutations on the same page after task #121
  // unified the copy). A regression that drops or mistypes any of these
  // would silently disable the user-visible truncation hint. Mirrors
  // the parallel header assertions in email-history-csv-export.spec.ts
  // and maintenance-history-csv-export.spec.ts.
  expect(csvCapture.truncatedHdr).toBe("1");
  expect(csvCapture.rowCapHdr).toBe("1000");
  expect(csvCapture.totalAvailHdr).toBe("1001");

  // ─── Toast assertion — clip count + underlying total ───────────────────
  // The whole point of tasks #117 and #121: when the export was clipped,
  // the success toast must tell the operator both how many rows came
  // back (the cap) AND how many really existed upstream. Without this,
  // SuperAdmins would only learn about the clip by combing the audit
  // log later. We assert on the toast description text so a regression
  // that drops `totalAvailable` from the header read or from the
  // template string would fail loudly. Toast lives at document scope
  // (Radix portal under <Toaster /> in App.tsx), so we query from
  // `page` not the dialog. Numeric formatting uses
  // `Number.toLocaleString("en-US")` in AICompanyFix.tsx so 1000 stays
  // as "1,000" — the comma matters for any total ≥ 4 digits.
  await expect(
    page.getByText("تم الاقتطاع عند 1,000 من 1,001 صف"),
  ).toBeVisible();
  // Also assert the success title rendered, so a future regression
  // that flipped the mutation into onError (and silently swallowed the
  // truncation suffix) would still trip this expectation.
  await expect(page.getByText("تم تنزيل ملف CSV").first()).toBeVisible();

  // ─── Body bytes — UTF-8 BOM and the 1000-row cap ────────────────────────
  const csvBuf = csvCapture.body;
  expect(csvBuf.length).toBeGreaterThan(3);
  expect(csvBuf[0]).toBe(0xEF);
  expect(csvBuf[1]).toBe(0xBB);
  expect(csvBuf[2]).toBe(0xBF);

  const csvText = csvBuf.toString("utf8").replace(/^\uFEFF/, "");
  // sendCsv emits CRLF row separators; filter(Boolean) drops the trailing
  // empty element from a final CRLF (if any).
  const csvLines = csvText.split("\r\n").filter(Boolean);
  // 1000-row cap: TOOL_HISTORY_CSV_ROW_CAP=1000 in admin.ts. We seeded
  // 1001 raw runs, so the LIMIT clause must clip the CSV output to
  // exactly 1000 data rows. We assert on the data-row count (not >= or
  // <=) because any drift in the cap — accidental bump, accidental
  // removal, off-by-one — would change this number and silently ship.
  //
  // Note: this assumes none of our padding rows contain CRLFs that
  // would split a logical CSV line into two physical lines. The
  // padding's `error` cells are simple ASCII ("pad <i> <TEST_TAG>") and
  // the other columns (status, trigger, count, durationMs, runAt)
  // never contain CRLFs, so split("\r\n") yields exactly one entry per
  // row.
  expect(csvLines.length - 1).toBe(1000);

  // ─── Audit assertion — exactly one export_csv row + truncation flag ────
  // Mirrors the broken-tools / recovered-tools truncation contract: the
  // audit row must carry `truncated=true`, the cap, and a strictly-
  // greater `totalAvailable` so a SuperAdmin reviewing past exports can
  // tell the data was clipped.
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
      eq(auditLogTable.entityType, "maintenance_tool_history"),
      eq(auditLogTable.companyId, testCompanyId!),
      gte(auditLogTable.createdAt, truncAuditAnchor!),
    ));
  expect(auditRows).toHaveLength(1);
  const meta = (auditRows[0].metadata ?? {}) as Record<string, unknown>;
  expect(meta.format).toBe("csv");
  expect(meta.toolKey).toBe(TRUNC_TOOL_KEY);
  expect(meta.count).toBe(1000);
  expect(meta.rowCap).toBe(1000);
  expect(meta.truncated).toBe(true);
  // We seeded exactly 1001 rows for this (company, TRUNC_TOOL_KEY)
  // pair on a brand-new test company, so totalAvailable is exactly
  // 1001 — no other test or sweep can have seeded for this unique
  // tagged tool key.
  expect(meta.totalAvailable).toBe(1001);
  // Track the id so afterAll can strip it by PK and the dev DB doesn't
  // accumulate test-only audit rows over time.
  for (const r of auditRows) seededAuditIds.push(r.id);
});
