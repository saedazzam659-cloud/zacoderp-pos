// E2E test for the SuperAdmin AI Company Fix page's maintenance-history
// filter dropdowns ("الإجراء" / "الفئة") on /admin/ai-fix in the
// zatca-invoicing artifact (task #100).
//
// Why this test exists:
//   /api/admin/maintenance/history/facets has full server-side coverage for
//   the `?includeSystem=1` branch (task #89), but no UI test confirms that
//   the AICompanyFix page actually:
//     (a) sets the flag on its outgoing fetch, and
//     (b) maps the response into the correct two `<Select>`s (actions →
//         "الإجراء" trigger, entityTypes → "الفئة" trigger).
//   A regression that drops the flag from the front-end fetch would silently
//   hide system-wide options like `edit_retention` / `auto_prune` (logged at
//   companyId=0 by the daily auto-prune and the retention-settings PUT) from
//   SuperAdmins, even though the backend keeps returning them. Swapping the
//   two response arrays into the wrong triggers would silently mislabel the
//   filter the SuperAdmin actually applies.
//
// What this verifies:
//   1. The page issues a GET to /api/admin/maintenance/history/facets that
//      carries `includeSystem=1` in the query string. Captured via a
//      page.waitForRequest filter that fails the test if the flag is dropped.
//   2. Opening the "الإجراء" Radix `<Select>` lists BOTH seeded system-wide
//      actions, and lists NEITHER of the seeded system-wide entityTypes
//      (catches the binding-swap regression on the action dropdown).
//   3. Opening the "الفئة" Radix `<Select>` lists BOTH seeded system-wide
//      entityTypes, and lists NEITHER of the seeded system-wide actions
//      (catches the binding-swap regression on the entity dropdown).
//   4. By using two distinct sentinel rows we also catch a mapper that
//      drops a value: missing either sentinel from its dropdown fails.
//
// Determinism story (mirrors the sibling e2e specs):
//   - We create a brand-new `companies` row tagged with a per-run TEST_TAG
//     so the tenant has zero of its own maintenance audit rows. The
//     dropdown vocabulary in the default branch (without includeSystem) is
//     "tenant rows only" — empty for our company. So if the front-end ever
//     drops the flag, the seeded sentinels won't surface and the test
//     fails. The waitForRequest filter is the explicit guard for the same
//     regression.
//   - The seeded action / entityType strings are TEST_TAG-prefixed so they
//     are unique on the shared dev DB. Other test runs' system-wide rows
//     can sit alongside them in the dropdown without confusing assertions
//     (we use `.toContain` / `.not.toContain`, never row-count equality).
//   - The SuperAdmin auth short-circuit (insert sa_sessions row + write
//     localStorage zatca_token + zatca_session='sa-<id>') matches what the
//     login flow itself produces, so /api/auth/me returns the SuperAdmin
//     and the AICompanyFix route guard renders.
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
import { eq, inArray, like } from "drizzle-orm";
import {
  db,
  usersTable,
  companiesTable,
  auditLogTable,
  superAdminSessionsTable,
} from "@workspace/db";

// ─── Fixtures / state shared across the single test in this file ───────────
const TEST_TAG = `e2e_task100_${randomBytes(4).toString("hex")}`;

// Two sentinel pairs of (action, entityType) seeded as system-wide rows
// (companyId = 0). Keeping each value globally unique on the dev DB lets us
// pin both "appears in the right dropdown" AND "does NOT appear in the
// other dropdown" assertions without depending on row counts. Production
// uses `edit_retention` / `auto_prune` for the retention-settings PUT and
// the daily auto-prune; the test-tag prefix keeps us decoupled from those
// real values while exercising the same code path.
const SYS_ACTION_1 = `facet_sys_act1_${TEST_TAG}`;
const SYS_ACTION_2 = `facet_sys_act2_${TEST_TAG}`;
const SYS_ENTITY_1 = `facet_sys_ent1_${TEST_TAG}`;
const SYS_ENTITY_2 = `facet_sys_ent2_${TEST_TAG}`;

let saSessionRowId: number | null = null;
let saSessionToken: string | null = null;
let testCompanyId: number | null  = null;
const seededAuditIds: number[]    = [];

// ─── Setup: create company, sa_session, and two system-wide audit rows ─────
test.beforeAll(async () => {
  // Sweep any debris from a previous interrupted run before seeding. The
  // three patterns are namespaced strictly to this test (audit rows tag the
  // username column, sa_sessions tag the sessionToken column, companies tag
  // the nameAr column), so this can never touch real audit history, real
  // user sessions, or real tenant rows.
  await db
    .delete(auditLogTable)
    .where(like(auditLogTable.username, "e2e_task100_%"));
  await db
    .delete(superAdminSessionsTable)
    .where(like(superAdminSessionsTable.sessionToken, "e2e_task100_%"));
  await db
    .delete(companiesTable)
    .where(like(companiesTable.nameAr, "e2e_task100_%"));

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
  saSessionToken = "e2e_task100_" + randomBytes(16).toString("hex");
  const [s] = await db
    .insert(superAdminSessionsTable)
    .values({
      userId:       sa.id,
      sessionToken: saSessionToken,
      deviceName:   "playwright-e2e",
      userAgent:    "playwright/task100",
    })
    .returning({ id: superAdminSessionsTable.id });
  saSessionRowId = s.id;

  // Active test tenant — listable in /api/admin/companies and selectable in
  // the page's "اختر الشركة" dropdown. The Arabic name carries TEST_TAG so
  // the dropdown option text is unique on the page. Crucially, NO audit
  // rows are seeded against this tenant, so the default-branch facets
  // response (without includeSystem) is empty — that guarantees an
  // includeSystem-dropped regression cannot accidentally pass via tenant
  // rows that happen to share the sentinel vocabulary.
  const [co] = await db
    .insert(companiesTable)
    .values({
      nameAr:         `${TEST_TAG} شركة فلاتر النظام`,
      nameEn:         `${TEST_TAG} Sys Facets Co`,
      vatNumber:      "300000000000100",
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

  // Two system-wide rows (companyId = 0). The route's includeSystem branch
  // unions companyId=0 rows on top of the tenant's, so both pairs of
  // sentinels are expected to appear in the two dropdowns when the flag
  // is sent. The sentinel values mirror the API-test pattern in
  // maintenance.test.ts (`facet_sys_action_only` / `facet_sys_entity_only`).
  const sysRows = await db
    .insert(auditLogTable)
    .values([
      {
        userId:     sa.id,
        username:   `${TEST_TAG}_sysrow1`,
        role:       "superadmin",
        companyId:  0,
        module:     "maintenance",
        action:     SYS_ACTION_1,
        method:     "PUT",
        path:       "/api/admin/maintenance/retention-settings/old-audit-logs",
        entityType: SYS_ENTITY_1,
        entityId:   "old-audit-logs",
        statusCode: 200,
        ip:         "127.0.0.1",
        metadata:   { tag: TEST_TAG, kind: "system-wide-1" },
      },
      {
        userId:     sa.id,
        username:   `${TEST_TAG}_sysrow2`,
        role:       "superadmin",
        companyId:  0,
        module:     "maintenance",
        action:     SYS_ACTION_2,
        method:     "POST",
        path:       "/api/admin/maintenance/auto-prune",
        entityType: SYS_ENTITY_2,
        entityId:   null,
        statusCode: 200,
        ip:         "127.0.0.1",
        metadata:   { tag: TEST_TAG, kind: "system-wide-2" },
      },
    ])
    .returning({ id: auditLogTable.id });
  for (const r of sysRows) seededAuditIds.push(r.id);
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
// the SPA to settle on the right route before driving the dropdowns.
const PAGE_HEADING_RE = /إصلاح مشاكل الشركات بالذكاء الاصطناعي/;

test("history-facets dropdowns: SuperAdmin page sends includeSystem=1 and renders the system-wide actions / entityTypes into the right Selects", async ({ page }) => {
  await installSuperAdminSession(page);

  // ─── Guard #1 (the includeSystem flag is being sent) ────────────────────
  // Set up the request listener BEFORE any action that could trigger the
  // facets fetch. Only requests whose URL contains BOTH the facets path AND
  // `includeSystem=1` satisfy this promise — a regression that drops the
  // flag would never resolve it and the awaited timeout fails the test.
  // We don't pin the value to "=1" in the regex because the route also
  // accepts "=true"; the front-end's hard-coded literal is "=1" today, but
  // either truthy spelling keeps the contract intact.
  const facetsRequestPromise = page.waitForRequest(
    (req) =>
      req.url().includes("/api/admin/maintenance/history/facets")
      && /[?&]includeSystem=(1|true)\b/.test(req.url()),
    { timeout: 20_000 },
  );

  await page.goto("/admin/ai-fix", { waitUntil: "networkidle" });

  // Wait for the page heading so we know the SPA has mounted AICompanyFix
  // and the /api/admin/companies fetch that drives the company dropdown
  // has resolved.
  await expect(page.getByRole("heading", { name: PAGE_HEADING_RE })).toBeVisible();

  // ─── Pick our seeded company in the "اختر الشركة" Radix Select ──────────
  // The trigger renders as a <button> wrapping the placeholder text inside
  // a <SelectValue>. With nothing selected the visible text is the
  // placeholder ("— اختر الشركة —"), which is the easiest unambiguous
  // handle for this trigger. The open dropdown is portalled to the
  // document root with role="listbox" and option items with role="option".
  // Mirrors the company-pick pattern in maintenance-history-csv-export.spec.ts.
  const companyTrigger = page.locator('button:has-text("— اختر الشركة —")').first();
  await companyTrigger.click();
  await expect(companyTrigger).toHaveAttribute("data-state", "open");
  await page.locator('[role="option"]').filter({ hasText: TEST_TAG }).first().click();

  // ─── Open the history accordion so historyOpen flips true ──────────────
  // The facets query in AICompanyFix.tsx is gated on
  // `enabled: !!companyId && historyOpen`. Without opening the accordion
  // the request is never issued, so the waitForRequest above would never
  // resolve. Anchor by the visible label "سجل الإصلاحات".
  await page.getByRole("button", { name: "سجل الإصلاحات" }).first().click();

  // Resolve guard #1 — the page must have fired a facets request that
  // carries includeSystem=1. A regression that drops the flag would
  // surface as a timeout here.
  const facetsRequest = await facetsRequestPromise;
  expect(facetsRequest.url()).toContain(`companyId=${testCompanyId}`);
  expect(facetsRequest.url()).toMatch(/[?&]includeSystem=(1|true)\b/);

  // ─── Guard #2 (action dropdown is bound to the `actions` array) ─────────
  // The action SelectTrigger always renders the placeholder/active-item
  // text "كل الإجراءات" because value defaults to "__all" → SelectItem
  // labelled "كل الإجراءات". That string is unique on the page (no other
  // visible button repeats it), so we can pin the trigger by its text.
  // Open it, then assert against the portalled <listbox> options:
  //   - both seeded SYS_ACTION sentinels appear (catches a mapper that
  //     drops a value)
  //   - neither seeded SYS_ENTITY sentinel appears (catches the bindings-
  //     swapped regression where entityTypes was rendered into this Select)
  // The seeded sentinels carry TEST_TAG, so they cannot collide with any
  // real edit_retention / auto_prune-style values in the dev DB.
  const actionTrigger = page
    .locator('button:has-text("كل الإجراءات")')
    .first();
  await actionTrigger.click();
  await expect(actionTrigger).toHaveAttribute("data-state", "open");
  // Radix portals the listbox at the document root; scope option lookups
  // to the open listbox to avoid matching closed-state DOM remnants.
  const actionListbox = page.locator('[role="listbox"]').last();
  await expect(actionListbox).toBeVisible();
  // SelectItem renders historyActionLabelAr(value); for sentinels not in
  // the lookup map the helper falls back to the raw value. So we assert
  // on the raw sentinel strings.
  await expect(
    actionListbox.locator('[role="option"]', { hasText: SYS_ACTION_1 }),
  ).toHaveCount(1);
  await expect(
    actionListbox.locator('[role="option"]', { hasText: SYS_ACTION_2 }),
  ).toHaveCount(1);
  // Anti-swap check — the entityType sentinels MUST NOT show up in the
  // action dropdown. If the front-end accidentally renders
  // facetEntityTypes into this Select, this assertion fails.
  await expect(
    actionListbox.locator('[role="option"]', { hasText: SYS_ENTITY_1 }),
  ).toHaveCount(0);
  await expect(
    actionListbox.locator('[role="option"]', { hasText: SYS_ENTITY_2 }),
  ).toHaveCount(0);
  // Close the action dropdown without applying a filter — pressing Escape
  // restores Radix's idle state so the next trigger we click resolves
  // against a quiet DOM (a still-open listbox can intercept clicks).
  await page.keyboard.press("Escape");
  await expect(actionTrigger).toHaveAttribute("data-state", "closed");

  // ─── Guard #3 (entity dropdown is bound to the `entityTypes` array) ─────
  // Same play, against the sibling "الفئة" trigger (placeholder
  // "كل الفئات", also unique on the page). We assert the inverse of the
  // action dropdown: both entity sentinels must show, neither action
  // sentinel may show.
  const entityTrigger = page
    .locator('button:has-text("كل الفئات")')
    .first();
  await entityTrigger.click();
  await expect(entityTrigger).toHaveAttribute("data-state", "open");
  const entityListbox = page.locator('[role="listbox"]').last();
  await expect(entityListbox).toBeVisible();
  await expect(
    entityListbox.locator('[role="option"]', { hasText: SYS_ENTITY_1 }),
  ).toHaveCount(1);
  await expect(
    entityListbox.locator('[role="option"]', { hasText: SYS_ENTITY_2 }),
  ).toHaveCount(1);
  // Anti-swap check — the action sentinels MUST NOT show up in the
  // entity dropdown. If the front-end accidentally renders facetActions
  // into this Select, this assertion fails.
  await expect(
    entityListbox.locator('[role="option"]', { hasText: SYS_ACTION_1 }),
  ).toHaveCount(0);
  await expect(
    entityListbox.locator('[role="option"]', { hasText: SYS_ACTION_2 }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(entityTrigger).toHaveAttribute("data-state", "closed");
});
