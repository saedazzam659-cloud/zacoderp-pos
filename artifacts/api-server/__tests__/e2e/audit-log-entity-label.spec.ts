// E2E test for the audit-log viewer's translated "Entity" column on
// /admin/audit-log in the zatca-invoicing artifact (task #153).
//
// Why this test exists:
//   Task #148 introduced a translated friendly-label dictionary for
//   audited entityTypes under `adminPages.auditLog.entityTypes`
//   (e.g. `invoice` → "invoice" / "فاتورة", `audit_log` → "audit log"
//   / "سجل تدقيق"). The Markdown bulk-copy label used it, but the
//   listing table itself rendered the raw enum, so reviewers scanning
//   the table saw `payment_voucher` instead of "payment voucher" /
//   "سند صرف". Task #153 added an "Entity" column that resolves the
//   raw enum through the same dictionary, with the raw enum kept
//   inline as a muted parens hint when the friendly label differs,
//   plus a whole-cell title= tooltip.
//
// What this verifies:
//   1. A seeded audit row whose entityType IS in the dictionary
//      (`audit_log`) renders the friendly Arabic label "سجل تدقيق"
//      as the primary text in the new Entity cell, with the raw enum
//      "(audit_log)" kept as the inline muted hint, and the cell's
//      title attribute set to the raw enum.
//   2. A second seeded row whose entityType is NOT in the dictionary
//      (a per-run unique synthetic key) falls back to rendering just
//      the raw enum WITHOUT the parens hint — proving the
//      defaultValue fallback works and the showRaw collapse logic
//      doesn't accidentally strip info for unregistered keys.
//
// Determinism story (mirrors the sibling specs):
//   - All seeded audit rows share a per-run TEST_TAG in their
//     `username` column. The page's free-text filter (`?q=`, ILIKE
//     on username/path in audit-log.ts ~line 56) is used to scope
//     the visible rows down to *only* our two seeded rows, so other
//     audit history on the shared dev DB never contaminates the
//     assertions.
//   - The unknown entityType also embeds the TEST_TAG so a parallel
//     run can never see another run's "unknown" key by mistake.
//   - The SuperAdmin auth short-circuit (insert sa_sessions row +
//     write localStorage zatca_token + zatca_session='sa-<id>')
//     matches what the login flow itself produces, so /api/auth/me
//     returns the SuperAdmin and the AuditLog route guard renders.
//
// Cleanup:
//   - Strict-by-PK: every inserted row id (audit_log, sa_sessions)
//     is deleted by `inArray`/`eq` in afterAll. No LIKE / wildcards
//     on production tables; a crashed run never touches another
//     tenant's data.
//   - We deliberately do NOT call `pool.end()` — see the matching
//     note in email-history-pagination.spec.ts. With workers=1,
//     sibling specs share the singleton pool exported by
//     `@workspace/db`.
//
// How to run:
//   1. Ensure the api-server and zatca-invoicing dev workflows are
//      running.
//   2. `pnpm --filter @workspace/api-server run test:e2e`

import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  auditLogTable,
  superAdminSessionsTable,
} from "@workspace/db";

// ─── Fixtures / state shared across the test in this file ──────────────────
const TEST_TAG = `e2e_task153_${randomBytes(4).toString("hex")}`;
// Distinctive usernames on the two seeded audit rows — both carry the
// full TEST_TAG so the audit-log viewer's `?q=` filter (ILIKE on
// username) can pinpoint exactly our two seeded rows on a shared dev DB.
const SEED_USERNAME_KNOWN   = `${TEST_TAG}_known`;
const SEED_USERNAME_UNKNOWN = `${TEST_TAG}_unknown`;

// `audit_log` is a registered key in
// adminPages.auditLog.entityTypes (en.json line ~5061, ar.json line
// ~5137). We assert the Arabic friendly label below, since the page
// defaults to RTL/Arabic, matching the sibling truncated-badge spec.
const KNOWN_ENTITY_TYPE              = "audit_log";
const KNOWN_ENTITY_FRIENDLY_AR       = "سجل تدقيق";
// Per-run unique unknown key — guaranteed to NOT be in the i18n
// dictionary and to NOT collide with parallel runs.
const UNKNOWN_ENTITY_TYPE = `xyz_unknown_${randomBytes(3).toString("hex")}`;

let saSessionRowId: number | null = null;
let saSessionToken: string | null = null;
const seededAuditIds: number[]    = [];

// ─── Setup: create sa_session and two contrasting audit rows ───────────────
test.beforeAll(async () => {
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

  // Random-token sa_sessions row drives auth without going through the
  // real multi-factor login. resolveBearerToken() in
  // artifacts/api-server/src/middleware/auth.ts accepts this token and
  // returns sessionId='sa-<id>', matching what /api/auth/me will emit.
  saSessionToken = "e2e_task153_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task153",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  // Seed two audit rows that differ only by entityType. companyId=null
  // because these are global SuperAdmin actions; the page-side filter
  // scopes by username, so both rows surface together regardless of
  // company.
  const [knownRow] = await db
    .insert(auditLogTable)
    .values({
      userId:     sa.id,
      username:   SEED_USERNAME_KNOWN,
      role:       "superadmin",
      companyId:  null,
      module:     "audit_log",
      action:     "view",
      method:     "GET",
      path:       "/api/admin/audit-log",
      entityType: KNOWN_ENTITY_TYPE,
      entityId:   null,
      metadata:   {},
    })
    .returning({ id: auditLogTable.id });
  const [unknownRow] = await db
    .insert(auditLogTable)
    .values({
      userId:     sa.id,
      username:   SEED_USERNAME_UNKNOWN,
      role:       "superadmin",
      companyId:  null,
      module:     "audit_log",
      action:     "view",
      method:     "GET",
      path:       "/api/admin/audit-log",
      entityType: UNKNOWN_ENTITY_TYPE,
      entityId:   null,
      metadata:   {},
    })
    .returning({ id: auditLogTable.id });
  seededAuditIds.push(knownRow.id, unknownRow.id);
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
  if (saSessionRowId !== null) {
    await db
      .delete(superAdminSessionsTable)
      .where(eq(superAdminSessionsTable.id, saSessionRowId));
  }
});

// Inject the SuperAdmin session into localStorage *before* the SPA mounts
// so AuthContext.checkSession() finds the token on first paint and
// AuditLog renders without us having to drive the login form. The
// session id format (`sa-<row id>`) matches what resolveBearerToken
// returns from /api/auth/me, so the single-session check inside
// checkSession passes.
async function installSuperAdminSession(page: Page): Promise<void> {
  await page.addInitScript(
    ({ token, sessionId }) => {
      localStorage.setItem("zatca_token", token);
      localStorage.setItem("zatca_session", sessionId);
    },
    { token: saSessionToken!, sessionId: `sa-${saSessionRowId!}` },
  );
}

// Stable anchor for the SuperAdmin Audit Log page so we can wait for the
// SPA to settle on the right route before driving the search input. The
// page renders its title inside a CardTitle (a plain <div>) rather than
// a <h*> element, so we anchor on the literal interpolated text instead
// of getByRole("heading").
const PAGE_HEADING_TEXT = "سجل النشاط (Audit Log)";

test("audit-log viewer: entity column renders friendly translated label for known entityTypes and falls back to raw enum for unknown ones", async ({ page }) => {
  await installSuperAdminSession(page);

  await page.goto("/admin/audit-log", { waitUntil: "networkidle" });
  await expect(page.getByText(PAGE_HEADING_TEXT)).toBeVisible();

  // Use the page's free-text search to scope the visible rows to *only*
  // our two seeded rows (the input fills the `?q=` query param, ILIKE
  // on username/path in audit-log.ts ~line 56). Without this, other
  // audit rows on the shared dev DB would interfere with the row-count
  // and per-row label assertions below.
  const searchInput = page.getByPlaceholder(/karm|sales-invoices/);
  await searchInput.fill(TEST_TAG);
  // Wait for the table to settle on exactly our two rows. Anchoring on
  // the row count instead of an arbitrary timeout avoids races against
  // React Query's debounce + fetch round-trip.
  await expect(page.locator("tbody tr")).toHaveCount(2);

  // ─── Known entityType row: friendly Arabic label + parens raw hint ────
  // The Entity cell carries data-testid="audit-row-entity" so we can
  // anchor directly on it instead of fishing through column indices.
  // Asserting the Arabic friendly label proves the dictionary lookup
  // (`tr(\`entityTypes.${row.entityType}\`)`) actually fired; asserting
  // the parens hint proves the `friendly !== row.entityType` showRaw
  // branch keeps the raw enum visible inline. The whole-cell title=
  // attribute backs the same info up via hover for power users.
  const knownRow = page.locator("tbody tr", { hasText: SEED_USERNAME_KNOWN });
  await expect(knownRow).toHaveCount(1);
  const knownEntityCell = knownRow.locator('[data-testid="audit-row-entity"]');
  await expect(knownEntityCell).toBeVisible();
  await expect(knownEntityCell).toContainText(KNOWN_ENTITY_FRIENDLY_AR);
  await expect(knownEntityCell).toContainText(`(${KNOWN_ENTITY_TYPE})`);
  await expect(knownEntityCell).toHaveAttribute("title", KNOWN_ENTITY_TYPE);

  // ─── Unknown entityType row: raw enum only, no parens hint ────────────
  // This locks in the spec's "Falls back to the raw enum when no
  // translation is registered" requirement and proves the showRaw
  // collapse (`friendly === row.entityType`) doesn't render a noisy
  // "(unknown_key)" duplicate when the dictionary returned the
  // defaultValue. Title attribute is still the raw enum so reviewers
  // hovering can copy the machine value.
  const unknownRow = page.locator("tbody tr", { hasText: SEED_USERNAME_UNKNOWN });
  await expect(unknownRow).toHaveCount(1);
  const unknownEntityCell = unknownRow.locator('[data-testid="audit-row-entity"]');
  await expect(unknownEntityCell).toBeVisible();
  await expect(unknownEntityCell).toContainText(UNKNOWN_ENTITY_TYPE);
  // No parens-wrapped duplicate hint — the friendly label collapsed
  // into just the raw enum, so we should never see "(<raw>)" in this
  // cell. We assert via the literal "(<raw>)" substring rather than a
  // CSS-based negative because the inline hint sits in a dedicated
  // <span> sibling we'd otherwise have to fingerprint by class name.
  await expect(unknownEntityCell).not.toContainText(`(${UNKNOWN_ENTITY_TYPE})`);
  await expect(unknownEntityCell).toHaveAttribute("title", UNKNOWN_ENTITY_TYPE);
});
