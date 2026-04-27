// E2E test for the SuperAdmin email-history "تصدير CSV" button on
// /admin/ai-fix in the zatca-invoicing artifact (task #80).
//
// What this verifies (mirrors the regression task acceptance criteria):
//   1. With the date filter narrowed to a far-past day that only the seeded
//      rows occupy, clicking "تصدير CSV" downloads a
//      `maintenance-email-history-*.csv` file whose data rows are EXACTLY
//      the seeded rows (and no others). The on-screen filter is honoured by
//      the export.
//   2. Changing the status filter to "فاشلة" before exporting again yields
//      a CSV with zero data rows — the seeded rows are status='ok' and the
//      date filter pins the universe to those rows, so the new bucket is
//      empty. This proves the export honours the *current* on-screen
//      filters, not just the date inputs.
//
// Why we read the CSV bytes through `page.waitForResponse` instead of
// `page.waitForEvent('download')`:
//   - The button JS does `fetch(...)`, reads `.blob()`, then triggers a
//     synthetic anchor click against a `blob:` URL. The fetch response
//     itself is the file the user ends up saving — capturing it via
//     waitForResponse is deterministic across Playwright versions and lets
//     us assert both the `Content-Disposition` filename (the user-visible
//     "downloaded as …") and the body (the bytes that hit disk) from the
//     same network record.
//
// Determinism story:
//   - We seed exactly TOTAL_ROWS maintenance_email_runs rows on a fixed
//     historical calendar day (1985-02-15) — deliberately a *different*
//     day from task #66's pagination spec (1985-01-15) so debris from a
//     crashed sibling spec on a shared dev DB can never inflate this
//     export's row count.
//   - Each row carries a unique per-run TEST_TAG in its `criticalSignature`
//     so cell-level assertions can pinpoint our seed without colliding
//     with anything else that happens to live in the dev DB.
//   - The SuperAdmin auth short-circuit (insert sa_sessions row + write
//     localStorage zatca_token + zatca_session='sa-<id>') matches what the
//     login flow itself produces, so /api/auth/me returns the SuperAdmin
//     and the AICompanyFix route guard renders.
//
// Cleanup:
//   - Strict-by-PK: we record every inserted row id and delete by
//     `inArray(table.id, ids)` in the afterAll hook. No LIKE / wildcards;
//     a crashed run never touches another tenant's data.
//   - We deliberately do NOT call `pool.end()` — see the matching note in
//     email-history-pagination.spec.ts. With workers=1, sibling specs share
//     the singleton pool exported by `@workspace/db`.
//
// How to run:
//   1. Ensure the api-server and zatca-invoicing dev workflows are running.
//   2. `pnpm --filter @workspace/api-server run test:e2e`

import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { and, eq, gt, gte, inArray, like } from "drizzle-orm";
import {
  db,
  usersTable,
  auditLogTable,
  maintenanceEmailRunsTable,
  superAdminSessionsTable,
} from "@workspace/db";

// ─── Fixtures / state shared across the single test in this file ───────────
const TEST_TAG = `e2e_task80_${randomBytes(4).toString("hex")}`;
// Seed onto a far-past day that no real audit row would ever fall on, and
// deliberately *different* from task #66's 1985-01-15 so leftover rows
// from a crashed sibling spec can never contaminate the export.
const SEED_DATE = "1985-02-15";
// Three seeded rows is enough to verify "the export contains exactly the
// seeded rows and no others" without inflating the test runtime. The CSV
// branch ignores the JSON pagination limit, so we don't need to cross any
// page boundary to exercise it.
const TOTAL_ROWS = 3;

let saSessionRowId: number | null = null;
let saSessionToken: string | null = null;
const seededEmailRunIds: number[] = [];
// Audit-log rows our two test cases write (one export_csv per click) are
// tracked so afterAll can strip them by PK without LIKE wildcards. The
// email-history endpoint records exports with companyId=null, so we can't
// scope cleanup by tenant — strict-by-PK is the only safe option on a
// shared dev DB.
const seededAuditIds: number[] = [];

// ─── Setup: insert sa_session for the existing superadmin user + 3 rows ────
test.beforeAll(async () => {
  // Sweep any debris from a previous interrupted run before seeding. Both
  // `e2e_task80_*` patterns are namespaced strictly to this test (the email
  // runs use the criticalSignature column, the sa_sessions use the sessionToken
  // column), so this can never touch real audit history or user sessions.
  await db
    .delete(maintenanceEmailRunsTable)
    .where(like(maintenanceEmailRunsTable.criticalSignature, "e2e_task80_%"));
  await db
    .delete(superAdminSessionsTable)
    .where(like(superAdminSessionsTable.sessionToken, "e2e_task80_%"));

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
  saSessionToken = "e2e_task80_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task80",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  // TOTAL_ROWS seeded rows on the same calendar day, each with a unique
  // second-offset so ORDER BY ranAt DESC produces a stable order.
  // status='ok' keeps them out of the "failed" status bucket — the second
  // assertion below relies on that to prove the status filter narrows the
  // export to zero rows on the same date window.
  const rows = Array.from({ length: TOTAL_ROWS }, (_, i) => ({
    ranAt:             new Date(`${SEED_DATE}T12:00:${String(i).padStart(2, "0")}.000Z`),
    trigger:           "scheduled" as const,
    status:            "ok",
    recipients:        1,
    criticalCount:     0,
    error:             null as string | null,
    reason:            "digest_sent",
    criticalSignature: TEST_TAG,
  }));
  const inserted = await db
    .insert(maintenanceEmailRunsTable)
    .values(rows)
    .returning({ id: maintenanceEmailRunsTable.id });
  for (const r of inserted) seededEmailRunIds.push(r.id);
});

// ─── Cleanup: strict-by-PK so a crash never nukes unrelated audit history ──
test.afterAll(async () => {
  if (seededEmailRunIds.length) {
    await db
      .delete(maintenanceEmailRunsTable)
      .where(inArray(maintenanceEmailRunsTable.id, seededEmailRunIds));
  }
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

// Stable selector for the email-history panel header card. Anchoring against
// the Arabic title "سجل تنبيهات البريد" makes the assertions resilient to
// other panels above/below moving around.
function panel(page: Page) {
  return page.locator("div", { hasText: "سجل تنبيهات البريد" }).first();
}

test("email-history CSV export: respects date filter (exact seeded rows) and status filter (drops to zero)", async ({ page }) => {
  await installSuperAdminSession(page);

  // The mutation consumes the fetch response with `await r.blob()` inside
  // page JS, which leaves Playwright's `response.body()`/`text()` reading
  // an empty buffer (the body has already been drained by the time we ask
  // for it). To get the actual bytes the user "downloaded", we intercept
  // every CSV request, refetch it from the test context, capture the body,
  // and forward it on so the page sees the same response. Each captured
  // entry records the request URL plus the body bytes so the assertions
  // below can pair the right capture with the right click.
  const csvCaptures: { url: string; body: Buffer; contentDisposition: string }[] = [];
  await page.route("**/api/admin/maintenance/email-history**", async (route, request) => {
    if (!request.url().includes("format=csv")) {
      await route.continue();
      return;
    }
    const upstream = await route.fetch();
    const body     = await upstream.body();
    csvCaptures.push({
      url:                request.url(),
      body,
      contentDisposition: upstream.headers()["content-disposition"] ?? "",
    });
    await route.fulfill({ response: upstream, body });
  });

  await page.goto("/admin/ai-fix", { waitUntil: "networkidle" });

  // Wait for the email-history panel to render. Its presence implies the
  // first /api/admin/maintenance/email-history fetch has resolved (the panel
  // is gated on `emailHistoryQ.data &&` in AICompanyFix.tsx).
  await expect(panel(page)).toBeVisible();

  // ─── Apply the date filter so only the TOTAL_ROWS seeded rows are in scope.
  // Inputs are <Input type="date">; setting both `from` and `to` to the same
  // calendar day (SEED_DATE) keeps the assertions deterministic on a shared
  // dev DB regardless of any other rows already in maintenance_email_runs.
  const fromInput = panel(page).locator('input[type="date"]').nth(0);
  const toInput   = panel(page).locator('input[type="date"]').nth(1);
  await fromInput.fill(SEED_DATE);
  await toInput.fill(SEED_DATE);

  // Sync barrier: wait for the on-screen table to settle to exactly our
  // seeded rows before triggering the export. The visible signature cell is
  // truncated by the UI so we anchor on the cell's full `title` attribute,
  // identical to how task #66's spec scopes its row counts.
  const seededRows = panel(page).locator("tbody tr").filter({
    has: page.locator(`td[title="${TEST_TAG}"]`),
  });
  await expect(seededRows).toHaveCount(TOTAL_ROWS);

  // ─── Click "تصدير CSV" → the route handler above captures the bytes ───
  // Three "تصدير CSV" buttons exist on /admin/ai-fix (email-history,
  // recovered-tools, maintenance-history). Only the email-history button
  // carries this exact `title` attribute, so anchoring on it picks the
  // right one without depending on DOM order or visibility heuristics.
  const csvButton = page.getByTitle(
    "تنزيل سجل البريد الكامل كملف CSV (يحترم الفلاتر أدناه)",
  );
  // Anchor a wall-clock moment just before the click so the audit-row
  // lookup below can scope itself to this run. writeAudit() uses
  // defaultNow for created_at; a >= filter on this anchor (combined with
  // entityType='maintenance_email_history') matches only the row this
  // export produced. 1s slack covers clock skew between the test process
  // and the api-server.
  const okAuditAnchor = new Date(Date.now() - 1_000);
  await csvButton.click();
  // Wait for the route handler to record this click's response. We poll
  // until the captures array grows to length 1 instead of using
  // page.waitForResponse so we read the buffered body the handler stored
  // (Playwright's own response.body() returns empty once the page JS
  // consumed the response via .blob()).
  await expect.poll(() => csvCaptures.length, { timeout: 15_000 }).toBe(1);
  const okExport = csvCaptures[0];

  // The export must echo the on-screen date filter back into its query
  // string; mismatched filters here would mean the audit file diverges
  // from what the admin saw.
  const csvUrl = new URL(okExport.url);
  expect(csvUrl.searchParams.get("from")).toBe(SEED_DATE);
  expect(csvUrl.searchParams.get("to")).toBe(SEED_DATE);
  expect(csvUrl.searchParams.get("status")).toBeNull();

  // Filename advertised to the browser via Content-Disposition must follow
  // the `maintenance-email-history-<unix-ms>.csv` pattern — that's the name
  // the AICompanyFix mutation falls back to and that auditors recognise.
  expect(okExport.contentDisposition).toMatch(
    /filename="maintenance-email-history-\d+\.csv"/,
  );

  // Body assertions: the server uses CRLF line endings and prepends a
  // UTF-8 BOM (so Excel renders Arabic correctly). We assert both via the
  // raw bytes captured before any decoder could strip the BOM signature.
  const csvBuf = okExport.body;
  expect(csvBuf.length).toBeGreaterThan(3);
  expect(csvBuf[0]).toBe(0xEF);
  expect(csvBuf[1]).toBe(0xBB);
  expect(csvBuf[2]).toBe(0xBF);
  const csvLines = csvBuf
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .split("\r\n")
    .filter(Boolean);
  // Header row contains the eight documented Arabic columns.
  expect(csvLines[0]).toContain("بصمة القائمة الحرجة");
  const dataLines = csvLines.slice(1);
  // Exactly the seeded rows — no more, no less. The date filter universe
  // (SEED_DATE..SEED_DATE) excludes everything else in the dev DB.
  expect(dataLines).toHaveLength(TOTAL_ROWS);
  for (const line of dataLines) {
    // criticalSignature column carries our unique TEST_TAG; every data row
    // must reference it. This catches a regression where the export
    // silently dropped a column or returned someone else's audit history.
    expect(line).toContain(TEST_TAG);
    // Trigger and reason on every seeded row.
    expect(line).toContain("scheduled");
    expect(line).toContain("ok");
    expect(line).toContain("digest_sent");
  }

  // ─── Audit-row metadata — non-truncated branch ────────────────────────
  // The export must record an audit entry under
  // module='maintenance' / action='export_csv' /
  // entityType='maintenance_email_history'. The endpoint scopes its
  // audit row to companyId=null (email-history is a global, cross-tenant
  // resource), so the lookup is anchored by createdAt + entityType only.
  // We also lock in the new `truncated`/`rowCap`/`totalAvailable` shape
  // so a regression that drops any of those fields fails loudly here
  // instead of silently shipping — matching the contract enforced on
  // /maintenance/error-summary, /maintenance/recent-recoveries,
  // /maintenance/tool-history, and /maintenance/history.
  const okAuditRows = await db
    .select({
      id:       auditLogTable.id,
      metadata: auditLogTable.metadata,
    })
    .from(auditLogTable)
    .where(and(
      eq(auditLogTable.module, "maintenance"),
      eq(auditLogTable.action, "export_csv"),
      eq(auditLogTable.entityType, "maintenance_email_history"),
      gte(auditLogTable.createdAt, okAuditAnchor),
    ));
  expect(okAuditRows).toHaveLength(1);
  const okMeta = (okAuditRows[0].metadata ?? {}) as Record<string, unknown>;
  expect(okMeta.format).toBe("csv");
  expect(okMeta.rowCap).toBe(1000);
  expect(okMeta.truncated).toBe(false);
  // count must equal totalAvailable when not truncated — the route uses
  // rows.length for both rather than re-running a COUNT query in the
  // common (cheap) path.
  expect(typeof okMeta.count).toBe("number");
  expect(typeof okMeta.totalAvailable).toBe("number");
  expect(okMeta.count).toBe(okMeta.totalAvailable);
  // The SEED_DATE..SEED_DATE date window pins the universe to exactly
  // the TOTAL_ROWS seeded rows, so count / totalAvailable are bounded.
  expect(okMeta.count).toBe(TOTAL_ROWS);
  for (const r of okAuditRows) seededAuditIds.push(r.id);

  // ─── Variant: change the status filter to "فاشلة" and re-export. The
  //     seeded rows are status='ok' so they fall outside the "failed"
  //     bucket; combined with the SEED_DATE date window, the export must
  //     return zero data rows. ───
  // Same Radix Select handle as task #66's pagination spec uses.
  const statusCombo = panel(page).locator('button:has-text("كل الحالات")').first();
  await statusCombo.click();
  await expect(statusCombo).toHaveAttribute("data-state", "open");
  await page.locator('[role="option"]').filter({ hasText: "فاشلة" }).first().click();

  // Sync barrier: wait for the panel to flip to the empty-state copy so we
  // know React state for `emailHistStatus` has propagated *before* we
  // trigger the second export (the export reads the same state).
  await expect(
    panel(page).getByText("لا توجد محاولات إرسال مطابقة للفلاتر."),
  ).toBeVisible();

  // Capture the first export's audit-row id so the second lookup can
  // scope itself by `id > okAuditRowId` instead of by createdAt. A
  // wall-clock anchor with any slack risks straddling the first audit
  // row when the two clicks fall within the slack window — id-based
  // scoping is unconditionally monotonic and immune to clock skew.
  const okAuditRowId = okAuditRows[0].id;
  await csvButton.click();
  // Wait for the second capture to land via the same route handler.
  await expect.poll(() => csvCaptures.length, { timeout: 15_000 }).toBe(2);
  const failedExport = csvCaptures[1];

  // All three filter values that were on the wire — proves the export
  // reads the *current* on-screen filter state, not a stale snapshot.
  const failedCsvUrl = new URL(failedExport.url);
  expect(failedCsvUrl.searchParams.get("from")).toBe(SEED_DATE);
  expect(failedCsvUrl.searchParams.get("to")).toBe(SEED_DATE);
  expect(failedCsvUrl.searchParams.get("status")).toBe("failed");

  // Filename pattern still holds for the second export.
  expect(failedExport.contentDisposition).toMatch(
    /filename="maintenance-email-history-\d+\.csv"/,
  );

  // Body must contain ONLY the header line — zero data rows, because the
  // status=failed bucket within the SEED_DATE window is empty. BOM is
  // emitted even on an empty result so Excel still opens the file in
  // UTF-8 mode.
  const failedBuf = failedExport.body;
  expect(failedBuf[0]).toBe(0xEF);
  expect(failedBuf[1]).toBe(0xBB);
  expect(failedBuf[2]).toBe(0xBF);
  const failedCsvLines = failedBuf
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .split("\r\n")
    .filter(Boolean);
  expect(failedCsvLines).toHaveLength(1); // header only
  expect(failedCsvLines[0]).toContain("بصمة القائمة الحرجة");

  // ─── Audit-row metadata — empty-result, non-truncated branch ──────────
  // The empty-result export still writes a `truncated=false` audit row
  // with count=0 and totalAvailable=0; the truncation fields are
  // unconditionally emitted, not gated on a non-empty result. Without
  // this assertion, a regression that only emitted the truncation fields
  // when rows.length > 0 would slip through.
  const failedAuditRows = await db
    .select({
      id:       auditLogTable.id,
      metadata: auditLogTable.metadata,
    })
    .from(auditLogTable)
    .where(and(
      eq(auditLogTable.module, "maintenance"),
      eq(auditLogTable.action, "export_csv"),
      eq(auditLogTable.entityType, "maintenance_email_history"),
      gt(auditLogTable.id, okAuditRowId),
    ));
  expect(failedAuditRows).toHaveLength(1);
  const failedMeta = (failedAuditRows[0].metadata ?? {}) as Record<string, unknown>;
  expect(failedMeta.format).toBe("csv");
  expect(failedMeta.rowCap).toBe(1000);
  expect(failedMeta.truncated).toBe(false);
  expect(failedMeta.count).toBe(0);
  expect(failedMeta.totalAvailable).toBe(0);
  for (const r of failedAuditRows) seededAuditIds.push(r.id);
});

// ─── Second test: 1000-row server-side cap on the email-history CSV branch ─
// We seed 1001 maintenance_email_runs rows on a brand-new isolated calendar
// day (1985-02-16, distinct from the first test's 1985-02-15 SEED_DATE so
// the two tests can't interfere) and then exercise the CSV branch with a
// from=to date filter pinned to that day. EMAIL_HISTORY_CSV_ROW_CAP=1000
// must clip the body to exactly 1000 data rows and the audit row must
// carry truncated=true / totalAvailable=1001 / rowCap=1000. Mirrors the
// truncation tests in tool-history-csv-export.spec.ts and
// broken-tools-panel.spec.ts.
//
// We trigger the export directly via a page-context fetch (Bearer token
// from localStorage) rather than driving the UI a second time — the click
// flow is already covered above; here the focus is purely the server cap.
const TRUNC_DATE = "1985-02-16";
const TRUNC_TAG  = `e2e_task80_trunc_${randomBytes(4).toString("hex")}`;

test("email-history CSV export: caps body at 1000 rows and records truncation in the audit row", async ({ page }) => {
  await installSuperAdminSession(page);

  // Seed 1001 rows (strictly > EMAIL_HISTORY_CSV_ROW_CAP=1000) on a
  // dedicated calendar day. Each row carries a per-test tag in
  // criticalSignature so cleanup-by-PK and any debugging stays scoped.
  // Bulk insert in chunks to stay under Postgres's 65k bind-parameter
  // limit (each row ≈ 8 params → 200 rows ≈ 1.6k params per batch).
  const SEED_COUNT = 1001;
  const truncDayStartMs = new Date(`${TRUNC_DATE}T00:00:00.000Z`).getTime();
  const truncRows = Array.from({ length: SEED_COUNT }, (_, i) => ({
    // Stagger seconds across the day so ORDER BY ranAt DESC is stable.
    // 1001 seconds < 24h, so every row stays inside TRUNC_DATE.
    ranAt:             new Date(truncDayStartMs + i * 1_000),
    trigger:           "scheduled" as const,
    status:            "ok",
    recipients:        1,
    criticalCount:     0,
    error:             null as string | null,
    reason:            "digest_sent",
    criticalSignature: TRUNC_TAG,
  }));
  const CHUNK = 200;
  for (let i = 0; i < truncRows.length; i += CHUNK) {
    const inserted = await db
      .insert(maintenanceEmailRunsTable)
      .values(truncRows.slice(i, i + CHUNK))
      .returning({ id: maintenanceEmailRunsTable.id });
    for (const r of inserted) seededEmailRunIds.push(r.id);
  }

  // Navigate so addInitScript installs the bearer token; we don't need
  // to drive the AICompanyFix UI here — the cap behavior is exercised
  // purely via a page-context fetch against the same /api route the
  // email-history "تصدير CSV" button hits.
  await page.goto("/", { waitUntil: "domcontentloaded" });

  // Anchor a wall-clock moment just before the fetch so the audit-row
  // lookup can scope itself to this run.
  const truncAuditAnchor = new Date(Date.now() - 1_000);

  // Fire the CSV fetch from inside the page context so localStorage
  // (where the SPA stores the SuperAdmin bearer token) is available.
  // Returning the body as a number[] keeps the marshal across the page
  // boundary trivial; we rebuild the Buffer on the test side. Headers
  // are also returned so we can lock in the X-Csv-* response headers
  // the page-side mutation reads to build its truncation toast.
  const csvUrl = `/api/admin/maintenance/email-history?format=csv&from=${TRUNC_DATE}&to=${TRUNC_DATE}`;
  const csvFetch = await page.evaluate(async ({ url }) => {
    const token = localStorage.getItem("zatca_token");
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token ?? ""}` },
    });
    const buf = await r.arrayBuffer();
    return {
      status:         r.status,
      bytes:          Array.from(new Uint8Array(buf)),
      contentType:    r.headers.get("content-type") ?? "",
      truncatedHdr:   r.headers.get("x-csv-truncated") ?? "",
      rowCapHdr:      r.headers.get("x-csv-row-cap") ?? "",
      totalAvailHdr:  r.headers.get("x-csv-total-available") ?? "",
    };
  }, { url: csvUrl });
  expect(csvFetch.status).toBe(200);
  expect(csvFetch.contentType.toLowerCase()).toContain("text/csv");

  // Response headers — these drive the "تم الاقتطاع عند 1,000 من 1,001
  // صف" toast suffix in AICompanyFix.tsx (emailHistoryCsvMut, after task
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
  // empty element from a final CRLF (if any). Our seed payload is plain
  // ASCII for every column except criticalSignature (also ASCII), so no
  // cell can contain a CRLF — split("\r\n") yields exactly one entry per
  // logical row.
  const csvLines = csvText.split("\r\n").filter(Boolean);
  // 1000-row cap: EMAIL_HISTORY_CSV_ROW_CAP=1000 in admin.ts. We seeded
  // 1001 raw runs on TRUNC_DATE, so the LIMIT clause must clip the CSV
  // output to exactly 1000 data rows. Asserting on === 1000 (not >= or
  // <=) catches accidental cap drift in either direction.
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
      eq(auditLogTable.entityType, "maintenance_email_history"),
      gte(auditLogTable.createdAt, truncAuditAnchor),
    ));
  expect(truncAuditRows).toHaveLength(1);
  const truncMeta = (truncAuditRows[0].metadata ?? {}) as Record<string, unknown>;
  expect(truncMeta.format).toBe("csv");
  expect(truncMeta.count).toBe(1000);
  expect(truncMeta.rowCap).toBe(1000);
  expect(truncMeta.truncated).toBe(true);
  // We seeded exactly 1001 rows on TRUNC_DATE and the date filter pins
  // the COUNT(*) universe to that day, so totalAvailable is bounded.
  expect(truncMeta.totalAvailable).toBe(1001);
  for (const r of truncAuditRows) seededAuditIds.push(r.id);
});
