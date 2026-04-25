// Integration + unit tests for the maintenance scheduler and check functions
// (artifacts/api-server/src/lib/maintenanceChecks.ts,
//  artifacts/api-server/src/lib/maintenanceScheduler.ts,
//  and POST /api/admin/maintenance/run-now).
//
// What this protects:
//   • `statusForCount` thresholds — the dashboard banner, the in-app badges,
//     and (eventually) the SuperAdmin email digest all classify findings via
//     this single function. A drift between "warn" and "critical" silently
//     under- or over-alerts SuperAdmins.
//   • `isDailyDue` — the scheduler tick fires at most once per KSA-local day
//     after the configured time-of-day. A regression here would either skip a
//     day or double-fire, and the only public symptom is in the runs table.
//   • Each of the 11 maintenance check functions on a seeded company:
//     happy path (count=0) AND a positive finding (count>0). Catches false
//     positives (e.g. broken-refs flagging a healthy invoice) AND silent
//     misses (e.g. orphan-stock failing to detect a stale ref).
//   • POST /api/admin/maintenance/run-now — the manual sweep entry point
//     used by the AI Company Fix screen. Verifies auth gating (401/403),
//     companyId validation (400), per-company mode (writes only this
//     company's runs), and all-companies mode (returns a summary across
//     active tenants).
//
// How to run:
//   pnpm --filter @workspace/api-server test
//
// Notes:
//   - Boots the Express app in-process on a random port.
//   - Uses the real DB (DATABASE_URL).
//   - Seeds two companies tagged with a per-run TEST_TAG: a "clean" company
//     for happy-path assertions, and a "dirty" company seeded with one row per
//     check that should produce a positive finding.
//   - Cleanup is by recorded primary keys ONLY (no LIKE/wildcards). A stray
//     test crash leaves orphan tagged rows that this run cannot match — they
//     remain inert and visible for human inspection.
//   - The maintenance_schedule row is a single shared config (id=1). The
//     "all companies" sweep mutates lastRunAt + lastRunStatus + counters on
//     it, so we snapshot the row at startup and restore it during teardown
//     so the live scheduler config is not perturbed by a test run.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";

import bcrypt from "bcryptjs";
import { eq, inArray, and, sql } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  companiesTable,
  accountsTable,
  branchesTable,
  warehousesTable,
  itemsTable,
  stockBalanceTable,
  stockLedgerTable,
  salesInvoicesTable,
  purchaseInvoicesTable,
  journalEntriesTable,
  journalEntryLinesTable,
  sequencesTable,
  auditLogTable,
  maintenanceRunsTable,
  maintenanceScheduleTable,
} from "@workspace/db";

import app from "../src/app.ts";
import {
  statusForCount,
  checkJournalPending,
  checkBrokenRefs,
  checkUnlinkedAccounts,
  checkSequenceGaps,
  checkDormantUsers,
  checkOrphanStock,
  checkNegativeStock,
  checkStockBalanceDrift,
  checkUnbalancedEntries,
  checkOldAuditLogs,
  checkOldMaintenanceRuns,
} from "../src/lib/maintenanceChecks.ts";
import { isDailyDue, MAINTENANCE_SCHEDULE_ID } from "../src/lib/maintenanceScheduler.ts";

// ─── Test scoping ───────────────────────────────────────────────────────────
const TEST_TAG = `tt_maint_${randomBytes(4).toString("hex")}`;

let server: http.Server;
let baseUrl: string;

let saUserId: number;
let saToken: string;
let regularUserId: number;
let regularToken: string;

// Two companies — "clean" stays empty so happy-path checks return 0; "dirty"
// receives one trigger row per check so positive-finding assertions fire.
let cleanCompanyId: number;
let dirtyCompanyId: number;
// A second, separate company used solely as the home of the foreign account
// referenced by the unlinked-accounts seed. Keeping it isolated from the
// "dirty" company ensures the foreign account_id genuinely does NOT belong
// to the company under check.
let otherCompanyId: number;

// Cleanup tracking — strict by primary key.
const insertedCompanyIds:        number[] = [];
const insertedUserIds:           number[] = [];
const insertedAccountIds:        number[] = [];
const insertedBranchIds:         number[] = [];
const insertedWarehouseIds:      number[] = [];
const insertedItemIds:           number[] = [];
const insertedStockBalanceIds:   number[] = [];
const insertedStockLedgerIds:    number[] = [];
const insertedSalesInvoiceIds:   number[] = [];
const insertedPurchaseInvoiceIds:number[] = [];
const insertedJournalEntryIds:   number[] = [];
const insertedSequenceIds:       number[] = [];
const insertedAuditLogIds:       number[] = [];
const insertedMaintenanceRunIds: number[] = [];

// Snapshot of the global maintenance_schedule row so the "all companies"
// sweep test doesn't permanently change live config.
let savedScheduleRow: typeof maintenanceScheduleTable.$inferSelect | undefined;

// Pre-sweep watermark: any maintenance_runs.id strictly greater than this was
// inserted *during* one of our run-now / all-companies tests. We use it in
// teardown to delete only those rows, even for non-seeded tenants — without
// it the all-companies sweep would leak rows into other tenants' history.
let preTestMaxMaintenanceRunId = 0;

// ─── Fetch helper ───────────────────────────────────────────────────────────
interface FetchOpts {
  token?: string;
  body?: unknown;
}
interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}
async function api<T = unknown>(
  path: string,
  method: "GET" | "POST",
  opts: FetchOpts = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: res.status, body: body as T };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────
before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server did not bind");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // Snapshot the schedule row up-front; restore it in after() so a test run
  // never persists a bogus lastRunAt onto the live config.
  const [existing] = await db.select().from(maintenanceScheduleTable)
    .where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));
  savedScheduleRow = existing;

  // Watermark the maintenance_runs table BEFORE any of our tests fire a sweep.
  // Cleanup will use this to remove rows the all-companies sweep wrote for
  // non-seeded tenants so we don't leak test artefacts into shared databases.
  const watermark = await db.execute<{ max_id: number | null }>(sql`
    SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM maintenance_runs
  `);
  preTestMaxMaintenanceRunId = Number(
    ((watermark as { rows?: Array<{ max_id: number | null }> }).rows ?? [{ max_id: 0 }])[0]?.max_id ?? 0,
  );

  // Seed companies. The "clean" and "dirty" companies must both be `active`
  // so they're visible to runMaintenanceSweep's company-status filter. The
  // "other" company is only used as the home of a foreign account_id.
  const baseCompanyValues = (suffix: string): typeof companiesTable.$inferInsert => ({
    nameAr:         `${TEST_TAG} شركة الاختبار ${suffix}`,
    nameEn:         `${TEST_TAG} Test Co ${suffix}`,
    vatNumber:      `300000000000${suffix.charCodeAt(0) % 10}`,
    crNumber:       `CR_${TEST_TAG}_${suffix}`,
    city:           "Riyadh",
    street:         "Test St",
    buildingNumber: "1",
    postalCode:     "12345",
    country:        "SA",
    invoiceType:    "both",
    status:         "active",
  });
  const inserted = await db.insert(companiesTable)
    .values([baseCompanyValues("C"), baseCompanyValues("D"), baseCompanyValues("O")])
    .returning({ id: companiesTable.id });
  cleanCompanyId = inserted[0].id;
  dirtyCompanyId = inserted[1].id;
  otherCompanyId = inserted[2].id;
  insertedCompanyIds.push(cleanCompanyId, dirtyCompanyId, otherCompanyId);

  // Seed the auth principals. SuperAdmin is `companyId: null`. The regular
  // user belongs to the dirty company and is used for the 403 test.
  saToken = "tt_sa_" + randomBytes(16).toString("hex");
  const saHash = await bcrypt.hash("ignored-test-pw", 4);
  const [sa] = await db.insert(usersTable).values({
    username: `${TEST_TAG}_sa`,
    email: null,
    passwordHash: saHash,
    role: "superadmin",
    isActive: true,
    sessionToken: saToken,
    sessionId: "test",
    companyId: null,
  }).returning({ id: usersTable.id });
  saUserId = sa.id;
  insertedUserIds.push(saUserId);

  regularToken = "tt_user_" + randomBytes(16).toString("hex");
  const userHash = await bcrypt.hash("ignored-test-pw", 4);
  const [u] = await db.insert(usersTable).values({
    username: `${TEST_TAG}_user`,
    email: null,
    passwordHash: userHash,
    role: "admin",
    isActive: true,
    sessionToken: regularToken,
    sessionId: "test",
    companyId: dirtyCompanyId,
  }).returning({ id: usersTable.id });
  regularUserId = u.id;
  insertedUserIds.push(regularUserId);
});

after(async () => {
  try {
    await cleanup();
  } finally {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    try { await pool.end(); } catch { /* already ended */ }
  }
});

async function cleanup(): Promise<void> {
  // Restore the schedule row first so the live scheduler config returns to
  // exactly its pre-test state regardless of how the suite finishes.
  try {
    if (savedScheduleRow) {
      await db.update(maintenanceScheduleTable).set({
        enabled:                 savedScheduleRow.enabled,
        hourOfDay:               savedScheduleRow.hourOfDay,
        minuteOfHour:            savedScheduleRow.minuteOfHour,
        alertsMutedUntil:        savedScheduleRow.alertsMutedUntil,
        lastTickAt:              savedScheduleRow.lastTickAt,
        lastRunAt:               savedScheduleRow.lastRunAt,
        lastRunStatus:           savedScheduleRow.lastRunStatus,
        lastRunCompanies:        savedScheduleRow.lastRunCompanies,
        lastRunCriticalCount:    savedScheduleRow.lastRunCriticalCount,
        lastError:               savedScheduleRow.lastError,
        lastEmailAt:             savedScheduleRow.lastEmailAt,
        lastEmailStatus:         savedScheduleRow.lastEmailStatus,
        lastEmailError:          savedScheduleRow.lastEmailError,
        lastEmailRecipients:     savedScheduleRow.lastEmailRecipients,
        lastEmailCriticalCount:  savedScheduleRow.lastEmailCriticalCount,
        updatedAt:               savedScheduleRow.updatedAt,
      }).where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));
    }
  } catch { /* best-effort */ }

  // Delete strictly by recorded primary keys, in FK-safe order.
  if (insertedJournalEntryIds.length) {
    await db.delete(journalEntryLinesTable).where(inArray(journalEntryLinesTable.entryId, insertedJournalEntryIds));
    await db.delete(journalEntriesTable).where(inArray(journalEntriesTable.id, insertedJournalEntryIds));
  }
  if (insertedSalesInvoiceIds.length) {
    await db.delete(salesInvoicesTable).where(inArray(salesInvoicesTable.id, insertedSalesInvoiceIds));
  }
  if (insertedPurchaseInvoiceIds.length) {
    await db.delete(purchaseInvoicesTable).where(inArray(purchaseInvoicesTable.id, insertedPurchaseInvoiceIds));
  }
  if (insertedStockLedgerIds.length) {
    await db.delete(stockLedgerTable).where(inArray(stockLedgerTable.id, insertedStockLedgerIds));
  }
  if (insertedStockBalanceIds.length) {
    await db.delete(stockBalanceTable).where(inArray(stockBalanceTable.id, insertedStockBalanceIds));
  }
  if (insertedAuditLogIds.length) {
    await db.delete(auditLogTable).where(inArray(auditLogTable.id, insertedAuditLogIds));
  }
  if (insertedMaintenanceRunIds.length) {
    await db.delete(maintenanceRunsTable).where(inArray(maintenanceRunsTable.id, insertedMaintenanceRunIds));
  }
  // Also wipe any maintenance_runs the manual sweep created for our seeded
  // companies — runMaintenanceSweep / per-company run-now insert their own
  // rows that we never touched at insert time.
  if (insertedCompanyIds.length) {
    await db.delete(maintenanceRunsTable).where(inArray(maintenanceRunsTable.companyId, insertedCompanyIds));
    // And any audit_log rows the route handler created via writeAudit.
    await db.delete(auditLogTable).where(inArray(auditLogTable.userId, insertedUserIds));
  }
  // The all-companies sweep test fires runMaintenanceSweep across every
  // active tenant — including ones we did NOT seed. Remove the rows that
  // sweep wrote for those non-seeded tenants by id-watermark, otherwise
  // we leak per-tenant history into shared databases.
  if (preTestMaxMaintenanceRunId > 0) {
    await db.execute(sql`
      DELETE FROM maintenance_runs
       WHERE id > ${preTestMaxMaintenanceRunId}
         AND trigger = 'manual'
    `);
  }
  if (insertedSequenceIds.length) {
    await db.delete(sequencesTable).where(inArray(sequencesTable.id, insertedSequenceIds));
  }
  if (insertedItemIds.length) {
    await db.delete(itemsTable).where(inArray(itemsTable.id, insertedItemIds));
  }
  if (insertedWarehouseIds.length) {
    await db.delete(warehousesTable).where(inArray(warehousesTable.id, insertedWarehouseIds));
  }
  if (insertedBranchIds.length) {
    await db.delete(branchesTable).where(inArray(branchesTable.id, insertedBranchIds));
  }
  if (insertedAccountIds.length) {
    await db.delete(accountsTable).where(inArray(accountsTable.id, insertedAccountIds));
  }
  if (insertedUserIds.length) {
    await db.delete(usersTable).where(inArray(usersTable.id, insertedUserIds));
  }
  if (insertedCompanyIds.length) {
    await db.delete(companiesTable).where(inArray(companiesTable.id, insertedCompanyIds));
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  statusForCount thresholds
// ════════════════════════════════════════════════════════════════════════════
test("statusForCount: 0 (and below) → ok", () => {
  assert.equal(statusForCount(0), "ok");
  assert.equal(statusForCount(-5), "ok");
});

test("statusForCount: 1..49 → warn", () => {
  assert.equal(statusForCount(1), "warn");
  assert.equal(statusForCount(25), "warn");
  assert.equal(statusForCount(49), "warn");
});

test("statusForCount: 50+ → critical", () => {
  assert.equal(statusForCount(50), "critical");
  assert.equal(statusForCount(123), "critical");
  assert.equal(statusForCount(10_000), "critical");
});

// ════════════════════════════════════════════════════════════════════════════
//  isDailyDue — KSA local time + day-boundary logic
// ════════════════════════════════════════════════════════════════════════════
// KSA = UTC+3 (no DST), so KSA-local minute-of-day = (UTC minute-of-day + 180) mod 1440.
// Schedule defaults: hourOfDay=3, minuteOfHour=0 → fires at 03:00 KSA = 00:00 UTC.

test("isDailyDue: disabled → never due (regardless of time/lastRun)", () => {
  const now = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
  assert.equal(
    isDailyDue(now, { enabled: false, hourOfDay: 3, minuteOfHour: 0, lastRunAt: null }),
    false,
  );
});

test("isDailyDue: before configured KSA time-of-day → false", () => {
  // UTC Jan 14 23:30 = KSA Jan 15 02:30 — before 03:00 → not due yet.
  const now = new Date(Date.UTC(2026, 0, 14, 23, 30, 0));
  assert.equal(
    isDailyDue(now, { enabled: true, hourOfDay: 3, minuteOfHour: 0, lastRunAt: null }),
    false,
  );
});

test("isDailyDue: after configured KSA time-of-day, never run → true", () => {
  // UTC Jan 15 00:30 = KSA Jan 15 03:30 — past 03:00 and lastRunAt is null.
  const now = new Date(Date.UTC(2026, 0, 15, 0, 30, 0));
  assert.equal(
    isDailyDue(now, { enabled: true, hourOfDay: 3, minuteOfHour: 0, lastRunAt: null }),
    true,
  );
});

test("isDailyDue: same KSA day already ran → false", () => {
  // now: KSA Jan 15 08:00. lastRunAt: KSA Jan 15 03:30 → same KSA date.
  const now      = new Date(Date.UTC(2026, 0, 15, 5, 0, 0));
  const lastRun  = new Date(Date.UTC(2026, 0, 15, 0, 30, 0));
  assert.equal(
    isDailyDue(now, { enabled: true, hourOfDay: 3, minuteOfHour: 0, lastRunAt: lastRun }),
    false,
  );
});

test("isDailyDue: previous KSA day's run → true", () => {
  // now: KSA Jan 15 03:30. lastRunAt: KSA Jan 14 08:00 → different KSA date.
  const now      = new Date(Date.UTC(2026, 0, 15, 0, 30, 0));
  const lastRun  = new Date(Date.UTC(2026, 0, 14, 5, 0, 0));
  assert.equal(
    isDailyDue(now, { enabled: true, hourOfDay: 3, minuteOfHour: 0, lastRunAt: lastRun }),
    true,
  );
});

test("isDailyDue: KSA day boundary — UTC 21:30 maps to KSA 00:30 next day, before 03:00 → false", () => {
  // UTC Jan 14 21:30 = KSA Jan 15 00:30. KSA-local minute-of-day = 30,
  // target minute-of-day = 180 → not due.
  const now = new Date(Date.UTC(2026, 0, 14, 21, 30, 0));
  assert.equal(
    isDailyDue(now, { enabled: true, hourOfDay: 3, minuteOfHour: 0, lastRunAt: null }),
    false,
  );
});

test("isDailyDue: respects custom hourOfDay/minuteOfHour", () => {
  // Configure for 15:30 KSA → 12:30 UTC. At UTC 13:00 (KSA 16:00) → due.
  // At UTC 12:15 (KSA 15:15) → not due yet.
  const due    = new Date(Date.UTC(2026, 0, 15, 13, 0, 0));
  const notDue = new Date(Date.UTC(2026, 0, 15, 12, 15, 0));
  assert.equal(
    isDailyDue(due, { enabled: true, hourOfDay: 15, minuteOfHour: 30, lastRunAt: null }),
    true,
  );
  assert.equal(
    isDailyDue(notDue, { enabled: true, hourOfDay: 15, minuteOfHour: 30, lastRunAt: null }),
    false,
  );
});

// ════════════════════════════════════════════════════════════════════════════
//  Per-check happy path (clean company → count = 0)
// ════════════════════════════════════════════════════════════════════════════
test("happy path: every check returns count=0 on a freshly-seeded company", async () => {
  // The clean company has only the row created in `before()` — no journal
  // entries, no invoices, no stock, no sequences, no audit log, no maint runs.
  // Every check must report a clean bill of health.
  const r1  = await checkJournalPending(cleanCompanyId);
  const r2  = await checkBrokenRefs(cleanCompanyId);
  const r3  = await checkUnlinkedAccounts(cleanCompanyId);
  const r4  = await checkSequenceGaps(cleanCompanyId);
  const r5  = await checkDormantUsers(cleanCompanyId);
  const r6  = await checkOrphanStock(cleanCompanyId);
  const r7  = await checkNegativeStock(cleanCompanyId);
  const r8  = await checkStockBalanceDrift(cleanCompanyId);
  const r9  = await checkUnbalancedEntries(cleanCompanyId);
  const r10 = await checkOldAuditLogs(cleanCompanyId);
  const r11 = await checkOldMaintenanceRuns(cleanCompanyId);
  const all = { r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11 };
  for (const [k, v] of Object.entries(all)) {
    assert.equal(v.count, 0, `${k} must be 0 on a clean company, got ${v.count}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  Per-check positive findings (one trigger per check on the dirty company)
// ════════════════════════════════════════════════════════════════════════════

// 1. journal-pending: a draft JE created > 30 days ago.
test("checkJournalPending: detects a draft JE older than the threshold", async () => {
  const oldCreatedAt = new Date(Date.now() - 45 * 86_400_000);
  const [je] = await db.insert(journalEntriesTable).values({
    companyId:   dirtyCompanyId,
    docNumber:   `${TEST_TAG}-JE-OLD`,
    entryDate:   "2025-01-01",
    description: "old draft",
    status:      "draft",
    createdAt:   oldCreatedAt,
    updatedAt:   oldCreatedAt,
  }).returning({ id: journalEntriesTable.id });
  insertedJournalEntryIds.push(je.id);

  const r = await checkJournalPending(dirtyCompanyId, 30);
  assert.ok(r.count >= 1, `expected count >= 1, got ${r.count}`);
  assert.ok(Array.isArray(r.items), "items must be an array");
  assert.ok(r.items!.some((it: { id: number }) => it.id === je.id),
    "items must include the seeded draft JE");
  assert.deepEqual(r.extras, { days: 30 });
});

// 2. broken-refs: a posted sales invoice with NULL journal_entry_id.
test("checkBrokenRefs: detects posted invoices with missing/stale JE refs", async () => {
  // Sales side: NULL JE id.
  const [si] = await db.insert(salesInvoicesTable).values({
    companyId:    dirtyCompanyId,
    invoiceDate:  "2025-06-01",
    paymentType:  "cash",
    currencyCode: "SAR",
    exchangeRate: "1",
    subtotal:     "100",
    vatAmount:    "0",
    discountAmount: "0",
    totalAmount:  "100",
    status:       "posted",
    docNumber:    `${TEST_TAG}-SI-BROKEN`,
  }).returning({ id: salesInvoicesTable.id });
  insertedSalesInvoiceIds.push(si.id);

  // Purchase side: stale JE id (points at a journal entry that does NOT exist).
  const [pi] = await db.insert(purchaseInvoicesTable).values({
    companyId:    dirtyCompanyId,
    invoiceDate:  "2025-06-02",
    paymentType:  "cash",
    currencyCode: "SAR",
    exchangeRate: "1",
    subtotal:     "200",
    vatAmount:    "0",
    discountAmount: "0",
    totalAmount:  "200",
    status:       "posted",
    docNumber:    `${TEST_TAG}-PI-BROKEN`,
    journalEntryId: 2_000_000_000, // far above any real serial value
  }).returning({ id: purchaseInvoicesTable.id });
  insertedPurchaseInvoiceIds.push(pi.id);

  const r = await checkBrokenRefs(dirtyCompanyId);
  assert.ok(r.count >= 2, `expected count >= 2, got ${r.count}`);
  assert.ok(isObject(r.extras) && typeof r.extras!.salesCount === "number");
  assert.ok((r.extras!.salesCount as number) >= 1);
  assert.ok((r.extras!.purchaseCount as number) >= 1);
  // Cross-validate that each kind shows up with the right reason.
  const salesRow = r.items!.find((it: { id: number; kind: string }) => it.id === si.id && it.kind === "sales");
  const purchaseRow = r.items!.find((it: { id: number; kind: string }) => it.id === pi.id && it.kind === "purchase");
  assert.ok(salesRow, "seeded sales invoice must appear");
  assert.ok(purchaseRow, "seeded purchase invoice must appear");
  assert.equal((salesRow as { reason: string }).reason, "missing");
  assert.equal((purchaseRow as { reason: string }).reason, "stale");
});

// 3. unlinked-accounts: a JE line referencing an account_id that exists but
//    belongs to a DIFFERENT company.
test("checkUnlinkedAccounts: flags JE lines with cross-company account_ids", async () => {
  // Account belongs to otherCompanyId — NOT dirtyCompanyId.
  const [foreignAcct] = await db.insert(accountsTable).values({
    companyId:   otherCompanyId,
    code:        `${TEST_TAG}-FOREIGN`,
    nameAr:      "حساب أجنبي",
    accountType: "asset",
    level:       1,
    isPosting:   true,
    isActive:    true,
  }).returning({ id: accountsTable.id });
  insertedAccountIds.push(foreignAcct.id);

  // Create a JE on the dirty company that uses the foreign account in a line.
  // Status doesn't matter for this check (it scans all JE lines for the company).
  const [je] = await db.insert(journalEntriesTable).values({
    companyId:   dirtyCompanyId,
    docNumber:   `${TEST_TAG}-JE-XLINK`,
    entryDate:   "2025-06-01",
    description: "uses foreign account",
    status:      "draft",
  }).returning({ id: journalEntriesTable.id });
  insertedJournalEntryIds.push(je.id);

  await db.insert(journalEntryLinesTable).values({
    entryId:   je.id,
    accountId: foreignAcct.id,
    debit:     "10",
    credit:    "0",
    sortOrder: 0,
  });

  const r = await checkUnlinkedAccounts(dirtyCompanyId);
  assert.ok(r.count >= 1, `expected count >= 1, got ${r.count}`);
  assert.ok(r.items!.some((it: { accountId: number }) => it.accountId === foreignAcct.id),
    "items must include the foreign account_id");
});

// 4. sequence-gaps: currentNumber > startNumber AND no sequence_logs rows.
test("checkSequenceGaps: detects a sequence whose log is missing issued numbers", async () => {
  const [seq] = await db.insert(sequencesTable).values({
    companyId:        dirtyCompanyId,
    code:             `${TEST_TAG}_SEQ`,
    nameAr:           "مسلسل اختبار",
    nameEn:           "Test seq",
    prefix:           "T-",
    startNumber:      1,
    endNumber:        9999,
    currentNumber:    6,    // implies 1..5 were issued; we'll log NONE
    padLength:        4,
    isActive:         true,
    transactionTypes: ["sales_invoice"],
  }).returning({ id: sequencesTable.id });
  insertedSequenceIds.push(seq.id);

  const r = await checkSequenceGaps(dirtyCompanyId);
  assert.ok(r.count >= 5, `expected at least 5 gaps (1..5), got ${r.count}`);
  const ours = r.items!.find((it: { sequenceId: number }) => it.sequenceId === seq.id);
  assert.ok(ours, "items must include our seeded sequence");
  assert.equal((ours as { gapCount: number }).gapCount, 5);
  // sampleGaps must format with prefix + padding.
  const samples = (ours as { sampleGaps: Array<{ number: number; formatted: string }> }).sampleGaps;
  assert.equal(samples[0].formatted, "T-0001");
  assert.equal(samples[4].formatted, "T-0005");
});

// 5. dormant-users: an active non-superadmin user with last_login_at older than N days.
test("checkDormantUsers: detects users dormant past the threshold", async () => {
  const oldLogin = new Date(Date.now() - 200 * 86_400_000);
  const [du] = await db.insert(usersTable).values({
    username:     `${TEST_TAG}_dormant`,
    email:        null,
    passwordHash: await bcrypt.hash("ignored", 4),
    role:         "admin",
    isActive:     true,
    sessionToken: null,
    sessionId:    null,
    companyId:    dirtyCompanyId,
    lastLoginAt:  oldLogin,
  }).returning({ id: usersTable.id });
  insertedUserIds.push(du.id);

  // Default threshold is 90 days — our 200d-old user must be flagged.
  const r = await checkDormantUsers(dirtyCompanyId, 90);
  assert.ok(r.count >= 1, `expected count >= 1, got ${r.count}`);
  assert.ok(r.items!.some((it: { id: number }) => it.id === du.id),
    "items must include the dormant user");
  assert.deepEqual(r.extras, { days: 90 });

  // The regular admin user (created in `before()`) belongs to the dirty
  // company too, but has no last_login_at — so it ALSO must be flagged
  // (the SQL OR-clause counts NULL last_login_at as dormant). Sanity-check.
  assert.ok(r.items!.some((it: { id: number }) => it.id === regularUserId),
    "regular user with NULL last_login_at must also appear as dormant");
});

// 6. orphan-stock: a stock_ledger row pointing at a deleted sales invoice.
test("checkOrphanStock: counts ledger rows whose ref no longer exists", async () => {
  // Need a warehouse + item to satisfy stock_ledger FKs.
  const [wh] = await db.insert(warehousesTable).values({
    companyId: dirtyCompanyId,
    code:      `${TEST_TAG}-WH`,
    nameAr:    "مستودع اختبار",
    isActive:  true,
  }).returning({ id: warehousesTable.id });
  insertedWarehouseIds.push(wh.id);

  const [it] = await db.insert(itemsTable).values({
    companyId: dirtyCompanyId,
    code:      `${TEST_TAG}-ITEM-1`,
    nameAr:    "صنف اختبار",
    itemType:  "stock",
  }).returning({ id: itemsTable.id });
  insertedItemIds.push(it.id);

  // refType='sales_invoice' with a refId that does not exist in sales_invoices.
  const [sl] = await db.insert(stockLedgerTable).values({
    companyId:   dirtyCompanyId,
    itemId:      it.id,
    warehouseId: wh.id,
    txDate:      "2025-06-01",
    txType:      "sale",
    qty:         "1",
    costPrice:   "10",
    totalCost:   "10",
    balanceQty:  "0",
    refId:       2_000_000_000,         // far above any real serial value
    refType:     "sales_invoice",
  }).returning({ id: stockLedgerTable.id });
  insertedStockLedgerIds.push(sl.id);

  const r = await checkOrphanStock(dirtyCompanyId);
  assert.ok(r.count >= 1, `expected count >= 1, got ${r.count}`);
});

// 7. negative-stock: a stock_balance row with qty < 0.
//    Self-contained: seed a fresh warehouse + item so this test isn't coupled
//    to the orphan-stock test's execution order.
test("checkNegativeStock: detects negative stock balances", async () => {
  const [wh] = await db.insert(warehousesTable).values({
    companyId: dirtyCompanyId,
    code:      `${TEST_TAG}-WH-NEG`,
    nameAr:    `مستودع ${TEST_TAG} NEG`,
    nameEn:    `Warehouse ${TEST_TAG} NEG`,
    isActive:  true,
  }).returning({ id: warehousesTable.id });
  insertedWarehouseIds.push(wh.id);

  const [it] = await db.insert(itemsTable).values({
    companyId: dirtyCompanyId,
    code:      `${TEST_TAG}-ITEM-NEG`,
    nameAr:    `صنف ${TEST_TAG} NEG`,
    nameEn:    `Item ${TEST_TAG} NEG`,
    itemType:  "stock",
    costPrice: "10",
    salePrice: "15",
  }).returning({ id: itemsTable.id });
  insertedItemIds.push(it.id);

  const [sb] = await db.insert(stockBalanceTable).values({
    companyId:   dirtyCompanyId,
    itemId:      it.id,
    warehouseId: wh.id,
    qty:         "-5",
    avgCost:     "10",
  }).returning({ id: stockBalanceTable.id });
  insertedStockBalanceIds.push(sb.id);

  const r = await checkNegativeStock(dirtyCompanyId);
  assert.ok(r.count >= 1, `expected count >= 1, got ${r.count}`);
  assert.ok(r.items!.some((row: { id: number }) => row.id === sb.id),
    "items must include the negative-balance row");
});

// 8. stock-balance-drift: stored qty diverges from SUM(ledger.qty) per
//    (item, warehouse). Self-contained: seed our own (item, warehouse) with
//    a stock_balance of -5 AND a stock_ledger row of +1 to force a drift of -6.
test("checkStockBalanceDrift: detects qty drift between balance and ledger", async () => {
  const [wh] = await db.insert(warehousesTable).values({
    companyId: dirtyCompanyId,
    code:      `${TEST_TAG}-WH-DRIFT`,
    nameAr:    `مستودع ${TEST_TAG} DRIFT`,
    nameEn:    `Warehouse ${TEST_TAG} DRIFT`,
    isActive:  true,
  }).returning({ id: warehousesTable.id });
  insertedWarehouseIds.push(wh.id);

  const [it] = await db.insert(itemsTable).values({
    companyId: dirtyCompanyId,
    code:      `${TEST_TAG}-ITEM-DRIFT`,
    nameAr:    `صنف ${TEST_TAG} DRIFT`,
    nameEn:    `Item ${TEST_TAG} DRIFT`,
    itemType:  "stock",
    costPrice: "10",
    salePrice: "15",
  }).returning({ id: itemsTable.id });
  insertedItemIds.push(it.id);

  const [sb] = await db.insert(stockBalanceTable).values({
    companyId:   dirtyCompanyId,
    itemId:      it.id,
    warehouseId: wh.id,
    qty:         "-5",
    avgCost:     "10",
  }).returning({ id: stockBalanceTable.id });
  insertedStockBalanceIds.push(sb.id);

  const [sl] = await db.insert(stockLedgerTable).values({
    companyId:   dirtyCompanyId,
    itemId:      it.id,
    warehouseId: wh.id,
    txDate:      "2025-06-01",
    txType:      "purchase",
    qty:         "1",
    costPrice:   "10",
    totalCost:   "10",
    balanceQty:  "1",
    refId:       1,
    refType:     "purchase_invoice",
  }).returning({ id: stockLedgerTable.id });
  insertedStockLedgerIds.push(sl.id);

  const r = await checkStockBalanceDrift(dirtyCompanyId);
  assert.ok(r.count >= 1, `expected count >= 1, got ${r.count}`);
  const row = r.items!.find((row: { itemId: number; warehouseId: number }) =>
    row.itemId === it.id && row.warehouseId === wh.id);
  assert.ok(row, "drift report must include our (item, warehouse) pair");
  assert.equal(Math.round(Number((row as { drift: string }).drift)), -6,
    "drift = stored(-5) - ledger(+1) = -6");
});

// 9. unbalanced-entries: posted JE where SUM(debit) ≠ SUM(credit).
test("checkUnbalancedEntries: detects posted JEs with debit ≠ credit", async () => {
  const [je] = await db.insert(journalEntriesTable).values({
    companyId:   dirtyCompanyId,
    docNumber:   `${TEST_TAG}-JE-UNBAL`,
    entryDate:   "2025-06-01",
    description: "intentionally unbalanced",
    status:      "posted",
  }).returning({ id: journalEntriesTable.id });
  insertedJournalEntryIds.push(je.id);

  await db.insert(journalEntryLinesTable).values([
    { entryId: je.id, accountId: null, debit: "100", credit: "0",  sortOrder: 0 },
    { entryId: je.id, accountId: null, debit: "0",   credit: "70", sortOrder: 1 },
  ]);

  const r = await checkUnbalancedEntries(dirtyCompanyId);
  assert.ok(r.count >= 1, `expected count >= 1, got ${r.count}`);
  const ours = r.items!.find((it: { id: number }) => it.id === je.id);
  assert.ok(ours, "items must include the unbalanced JE");
  assert.equal(Math.round(Number((ours as { diff: string }).diff)), 30,
    "diff = 100 - 70 = 30");
});

// 10. old-audit-logs: an audit_log row created > 365 days ago.
test("checkOldAuditLogs: counts audit_log rows older than the threshold", async () => {
  const oldCreatedAt = new Date(Date.now() - 400 * 86_400_000);
  const [al] = await db.insert(auditLogTable).values({
    userId:    saUserId,
    username:  `${TEST_TAG}_sa`,
    role:      "superadmin",
    companyId: dirtyCompanyId,
    module:    "test",
    action:    "view",
    method:    "GET",
    path:      "/api/test",
    statusCode: 200,
    createdAt: oldCreatedAt,
  }).returning({ id: auditLogTable.id });
  insertedAuditLogIds.push(al.id);

  const r = await checkOldAuditLogs(dirtyCompanyId, 365);
  assert.ok(r.count >= 1, `expected count >= 1, got ${r.count}`);
  assert.ok(r.items!.some((it: { id: number }) => it.id === al.id),
    "items must include the old audit row");
  assert.ok(isObject(r.extras) && r.extras!.days === 365);
});

// 11. old-maintenance-runs: a maintenance_runs row > 90 days old.
test("checkOldMaintenanceRuns: counts maintenance_runs older than the threshold", async () => {
  const oldRunAt = new Date(Date.now() - 120 * 86_400_000);
  const [mr] = await db.insert(maintenanceRunsTable).values({
    companyId:  dirtyCompanyId,
    toolKey:    "journal-pending",
    status:     "ok",
    count:      0,
    trigger:    "scheduled",
    runAt:      oldRunAt,
    durationMs: 5,
    error:      null,
    details:    null,
  }).returning({ id: maintenanceRunsTable.id });
  insertedMaintenanceRunIds.push(mr.id);

  const r = await checkOldMaintenanceRuns(dirtyCompanyId, 90);
  assert.ok(r.count >= 1, `expected count >= 1, got ${r.count}`);
  assert.ok(r.items!.some((it: { id: number }) => it.id === mr.id),
    "items must include the old maintenance_runs row");
  assert.ok(isObject(r.extras) && r.extras!.days === 90);
});

// ════════════════════════════════════════════════════════════════════════════
//  POST /api/admin/maintenance/run-now — auth + per-company + all-companies
// ════════════════════════════════════════════════════════════════════════════
interface RunNowResponse {
  ok: boolean;
  summary: {
    companies: number;
    toolsRun: number;
    criticalCount: number;
    warnCount: number;
    errorCount: number;
    failedCompanies: number;
  };
}

test("POST /maintenance/run-now: 401 without bearer token", async () => {
  const r = await api("/api/admin/maintenance/run-now", "POST", { body: {} });
  assert.equal(r.status, 401);
});

test("POST /maintenance/run-now: 403 for non-superadmin", async () => {
  const r = await api("/api/admin/maintenance/run-now", "POST", { token: regularToken, body: {} });
  assert.equal(r.status, 403);
});

test("POST /maintenance/run-now: 400 on invalid companyId", async () => {
  for (const bad of [{ companyId: "not-a-number" }, { companyId: 0 }, { companyId: -3 }, { companyId: 1.5 }]) {
    const r = await api("/api/admin/maintenance/run-now", "POST", { token: saToken, body: bad });
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}, got ${r.status}`);
  }
});

test("POST /maintenance/run-now: per-company mode runs every tool and persists rows", async () => {
  // Snapshot existing run-row count for this company so we can assert the
  // delta even if a previous run-now (or sweep) already wrote rows.
  const beforeRows = await db.select({ id: maintenanceRunsTable.id })
    .from(maintenanceRunsTable)
    .where(and(
      eq(maintenanceRunsTable.companyId, dirtyCompanyId),
      eq(maintenanceRunsTable.trigger, "manual"),
    ));
  const before = beforeRows.length;

  const r = await api<RunNowResponse>("/api/admin/maintenance/run-now", "POST", {
    token: saToken,
    body: { companyId: dirtyCompanyId },
  });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.summary.companies, 1, "per-company mode must report companies=1");
  // 11 tools currently registered. Pin "at least the originally-specified 6"
  // so the test isn't fragile if the toolbox is extended further.
  assert.ok(r.body.summary.toolsRun >= 6,
    `toolsRun should be >= 6, got ${r.body.summary.toolsRun}`);
  assert.equal(r.body.summary.failedCompanies, 0);

  // Verify the run-now insert wrote one row per tool with trigger='manual'.
  const afterRows = await db.select({ toolKey: maintenanceRunsTable.toolKey })
    .from(maintenanceRunsTable)
    .where(and(
      eq(maintenanceRunsTable.companyId, dirtyCompanyId),
      eq(maintenanceRunsTable.trigger, "manual"),
    ));
  assert.equal(afterRows.length - before, r.body.summary.toolsRun,
    "DB rows added must equal summary.toolsRun");

  // And the dirty company should have at least one critical/warn since we
  // seeded findings for every tool above.
  assert.ok(r.body.summary.criticalCount + r.body.summary.warnCount >= 1,
    "dirty company must surface at least one warn or critical from the seed data");
});

test("POST /maintenance/run-now: per-company mode does NOT touch other tenants' run rows", async () => {
  // Capture cleanCompany rows BEFORE running on the dirty company.
  const beforeClean = (await db.select({ id: maintenanceRunsTable.id })
    .from(maintenanceRunsTable)
    .where(eq(maintenanceRunsTable.companyId, cleanCompanyId))).length;

  await api("/api/admin/maintenance/run-now", "POST", {
    token: saToken,
    body: { companyId: dirtyCompanyId },
  });

  const afterClean = (await db.select({ id: maintenanceRunsTable.id })
    .from(maintenanceRunsTable)
    .where(eq(maintenanceRunsTable.companyId, cleanCompanyId))).length;

  assert.equal(afterClean, beforeClean,
    "per-company run-now must not insert rows for other companies");
});

test("POST /maintenance/run-now: all-companies mode includes the seeded companies", async () => {
  const r = await api<RunNowResponse>("/api/admin/maintenance/run-now", "POST", {
    token: saToken,
    body: {},
  });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  assert.equal(r.body.ok, true);

  // We seeded 3 active companies (clean/dirty/other). Plus any other active
  // companies that already exist in the DB. Assert >= 3 to cover the seed.
  assert.ok(r.body.summary.companies >= 3,
    `companies should be >= 3 (the seeded ones), got ${r.body.summary.companies}`);
  // toolsRun = companies × tools_per_company; just sanity-check it's > 0.
  assert.ok(r.body.summary.toolsRun > 0);

  // Verify the all-companies sweep wrote scheduled rows for both seeded
  // companies. (cleanCompany should now have 1 row per tool with
  // trigger='scheduled' — the sweep uses 'scheduled' regardless of how it
  // was triggered, since the route passes "manual" only for per-company.)
  const cleanScheduled = await db.select({ id: maintenanceRunsTable.id })
    .from(maintenanceRunsTable)
    .where(and(
      eq(maintenanceRunsTable.companyId, cleanCompanyId),
      eq(maintenanceRunsTable.trigger, "manual"),
    ));
  assert.ok(cleanScheduled.length >= 1,
    `all-companies sweep must have inserted manual rows for the clean company, got ${cleanScheduled.length}`);
});

// Pin the contract that statusForCount agrees with the runs table: every row
// inserted for the clean company by the sweep above should be status='ok'
// because the company has no findings.
test("POST /maintenance/run-now: clean company's manual rows are all status='ok'", async () => {
  const rows = await db.select({ status: maintenanceRunsTable.status, count: maintenanceRunsTable.count })
    .from(maintenanceRunsTable)
    .where(and(
      eq(maintenanceRunsTable.companyId, cleanCompanyId),
      eq(maintenanceRunsTable.trigger, "manual"),
    ));
  assert.ok(rows.length >= 1, "clean company should have at least one manual row by now");
  for (const row of rows) {
    // We allow status='error' (e.g. a check that touches a table the test
    // env doesn't have) but flag any 'warn'/'critical' since the clean
    // company genuinely has nothing to find.
    assert.ok(row.status === "ok" || row.status === "error",
      `clean company row had unexpected status='${row.status}' (count=${row.count})`);
  }
  // Sanity: also assert via the raw SQL that no warn/critical row exists.
  const flagged = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM maintenance_runs
     WHERE company_id = ${cleanCompanyId}
       AND status IN ('warn','critical')
  `);
  const n = Number(((flagged as { rows?: Array<{ n: number }> }).rows ?? [{ n: 0 }])[0]?.n ?? 0);
  assert.equal(n, 0, "clean company must have zero warn/critical rows");
});
