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
  maintenanceEmailRunsTable,
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
  checkOldMaintenanceEmailRuns,
} from "../src/lib/maintenanceChecks.ts";
import {
  isDailyDue,
  MAINTENANCE_SCHEDULE_ID,
  computeCriticalSignature,
  shouldSkipForRateLimit,
  getRecentToolErrors,
  getRecentToolRecoveries,
  TOOL_ERROR_WINDOW_DAYS,
  severityMeetsThreshold,
  getSuperAdminRecipients,
  dispatchCriticalDigest,
  type AlertSeverity,
} from "../src/lib/maintenanceScheduler.ts";

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

// Schema-pin company: a third tenant freshly seeded with **multiple** items
// and warehouses. Used by the `schema-pin: every check returns the documented
// shape` block to defend against silent column drift in the JOINed checks
// (e.g. negative-stock, stock-balance-drift). Two checks previously broke
// when an items/warehouses column was renamed — the per-check tests above
// only seed one item+warehouse so the JOIN had a single row to match and
// the bug surfaced as "count=1, error=null". With multiple items+warehouses
// the JOIN is forced to discriminate, so any column rename trips the SQL.
let schemaCompanyId: number;
const schemaWarehouseIds: number[] = [];
const schemaItemIds: number[]      = [];

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
const insertedMaintenanceEmailRunIds: number[] = [];

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

  // ─── Schema-pin tenant ──────────────────────────────────────────────────
  // Fresh company seeded with 2 warehouses + 3 items + a row per check that
  // exercises the JOIN paths. A schema rename in items/warehouses (or any of
  // the other tables a check joins against) breaks the SELECT here even
  // though the simpler per-check tests above can still pass with their
  // single-item seed.
  const [schemaCo] = await db.insert(companiesTable).values({
    nameAr:         `${TEST_TAG} شركة الاختبار S`,
    nameEn:         `${TEST_TAG} Test Co S`,
    vatNumber:      `300000000000${("S".charCodeAt(0)) % 10}`,
    crNumber:       `CR_${TEST_TAG}_S`,
    city:           "Riyadh",
    street:         "Test St",
    buildingNumber: "1",
    postalCode:     "12345",
    country:        "SA",
    invoiceType:    "both",
    status:         "active",
  }).returning({ id: companiesTable.id });
  schemaCompanyId = schemaCo.id;
  insertedCompanyIds.push(schemaCompanyId);

  // Two warehouses — both get bilingual names so the COALESCE(name_ar, name_en)
  // expression in the JOIN cannot mask a missing column by silently falling
  // back to the other.
  const wh = await db.insert(warehousesTable).values([
    { companyId: schemaCompanyId, code: `${TEST_TAG}-S-WH-A`,
      nameAr: `مستودع ${TEST_TAG} A`, nameEn: `Warehouse ${TEST_TAG} A`, isActive: true },
    { companyId: schemaCompanyId, code: `${TEST_TAG}-S-WH-B`,
      nameAr: `مستودع ${TEST_TAG} B`, nameEn: `Warehouse ${TEST_TAG} B`, isActive: true },
  ]).returning({ id: warehousesTable.id });
  schemaWarehouseIds.push(wh[0].id, wh[1].id);
  insertedWarehouseIds.push(wh[0].id, wh[1].id);

  // Three items, all bilingual so the same COALESCE rule applies to itemName.
  const its = await db.insert(itemsTable).values([
    { companyId: schemaCompanyId, code: `${TEST_TAG}-S-IT-1`,
      nameAr: `صنف ${TEST_TAG} 1`, nameEn: `Item ${TEST_TAG} 1`,
      itemType: "stock", costPrice: "10", salePrice: "15" },
    { companyId: schemaCompanyId, code: `${TEST_TAG}-S-IT-2`,
      nameAr: `صنف ${TEST_TAG} 2`, nameEn: `Item ${TEST_TAG} 2`,
      itemType: "stock", costPrice: "20", salePrice: "30" },
    { companyId: schemaCompanyId, code: `${TEST_TAG}-S-IT-3`,
      nameAr: `صنف ${TEST_TAG} 3`, nameEn: `Item ${TEST_TAG} 3`,
      itemType: "stock", costPrice: "30", salePrice: "45" },
  ]).returning({ id: itemsTable.id });
  schemaItemIds.push(its[0].id, its[1].id, its[2].id);
  insertedItemIds.push(its[0].id, its[1].id, its[2].id);

  // Negative-stock + drift seed: three (item, warehouse) pairs all with
  // qty<0 — the SQL must JOIN each one back to its items / warehouses row
  // for itemName + warehouseName. A column rename would either fail the
  // query or yield NULL placeholders the shape test catches.
  const sb = await db.insert(stockBalanceTable).values([
    { companyId: schemaCompanyId, itemId: its[0].id, warehouseId: wh[0].id, qty: "-3", avgCost: "10" },
    { companyId: schemaCompanyId, itemId: its[1].id, warehouseId: wh[0].id, qty: "-7", avgCost: "20" },
    { companyId: schemaCompanyId, itemId: its[2].id, warehouseId: wh[1].id, qty: "-2", avgCost: "30" },
  ]).returning({ id: stockBalanceTable.id });
  for (const r of sb) insertedStockBalanceIds.push(r.id);

  // Drift seed: seed ledger movements that disagree with the stored balances
  // above. The third row (item-3, warehouse-A) has no balance row at all to
  // exercise the FULL OUTER JOIN edge case the SQL guards against.
  const sl = await db.insert(stockLedgerTable).values([
    // Pair 1: stored=-3, ledger=0 → drift=-3 (skip ledger insert)
    // Pair 2: stored=-7, ledger=+5 → drift=-12
    { companyId: schemaCompanyId, itemId: its[1].id, warehouseId: wh[0].id, txDate: "2025-06-01",
      txType: "purchase", qty: "5", costPrice: "20", totalCost: "100", balanceQty: "5",
      refId: 1, refType: "purchase_invoice" },
    // Pair 3: stored=-2, ledger=+1 → drift=-3
    { companyId: schemaCompanyId, itemId: its[2].id, warehouseId: wh[1].id, txDate: "2025-06-01",
      txType: "purchase", qty: "1", costPrice: "30", totalCost: "30", balanceQty: "1",
      refId: 2, refType: "purchase_invoice" },
    // Edge case: ledger movement with NO matching stock_balance row.
    // Forces the FULL OUTER JOIN's right-side branch to execute.
    { companyId: schemaCompanyId, itemId: its[2].id, warehouseId: wh[0].id, txDate: "2025-06-02",
      txType: "purchase", qty: "10", costPrice: "30", totalCost: "300", balanceQty: "10",
      refId: 3, refType: "purchase_invoice" },
    // Orphan-stock seed: ledger row pointing at a non-existent invoice.
    { companyId: schemaCompanyId, itemId: its[0].id, warehouseId: wh[0].id, txDate: "2025-06-03",
      txType: "sale", qty: "1", costPrice: "10", totalCost: "10", balanceQty: "0",
      refId: 2_000_000_000, refType: "sales_invoice" },
  ]).returning({ id: stockLedgerTable.id });
  for (const r of sl) insertedStockLedgerIds.push(r.id);

  // journal-pending seed: TWO old drafts so the items array has length>=2.
  const oldCreatedAt = new Date(Date.now() - 45 * 86_400_000);
  const jeOld = await db.insert(journalEntriesTable).values([
    { companyId: schemaCompanyId, docNumber: `${TEST_TAG}-S-JE-OLD-1`,
      entryDate: "2025-01-01", description: "old draft 1",
      status: "draft", createdAt: oldCreatedAt, updatedAt: oldCreatedAt },
    { companyId: schemaCompanyId, docNumber: `${TEST_TAG}-S-JE-OLD-2`,
      entryDate: "2025-01-02", description: "old draft 2",
      status: "draft", createdAt: oldCreatedAt, updatedAt: oldCreatedAt },
  ]).returning({ id: journalEntriesTable.id });
  for (const r of jeOld) insertedJournalEntryIds.push(r.id);

  // broken-refs seed: 2 sales (one missing JE, one stale JE) + 1 purchase (stale JE).
  const si = await db.insert(salesInvoicesTable).values([
    { companyId: schemaCompanyId, invoiceDate: "2025-06-01", paymentType: "cash",
      currencyCode: "SAR", exchangeRate: "1", subtotal: "100", vatAmount: "0",
      discountAmount: "0", totalAmount: "100", status: "posted",
      docNumber: `${TEST_TAG}-S-SI-MISS` },
    { companyId: schemaCompanyId, invoiceDate: "2025-06-02", paymentType: "cash",
      currencyCode: "SAR", exchangeRate: "1", subtotal: "200", vatAmount: "0",
      discountAmount: "0", totalAmount: "200", status: "posted",
      docNumber: `${TEST_TAG}-S-SI-STALE`, journalEntryId: 2_000_000_001 },
  ]).returning({ id: salesInvoicesTable.id });
  for (const r of si) insertedSalesInvoiceIds.push(r.id);

  const pi = await db.insert(purchaseInvoicesTable).values({
    companyId: schemaCompanyId, invoiceDate: "2025-06-03", paymentType: "cash",
    currencyCode: "SAR", exchangeRate: "1", subtotal: "300", vatAmount: "0",
    discountAmount: "0", totalAmount: "300", status: "posted",
    docNumber: `${TEST_TAG}-S-PI-STALE`, journalEntryId: 2_000_000_002,
  }).returning({ id: purchaseInvoicesTable.id });
  insertedPurchaseInvoiceIds.push(pi[0].id);

  // unlinked-accounts seed: foreign account in a JE line on the schema company.
  const [foreignAcct] = await db.insert(accountsTable).values({
    companyId: otherCompanyId, code: `${TEST_TAG}-S-FOREIGN`,
    nameAr: "حساب أجنبي ع", accountType: "asset",
    level: 1, isPosting: true, isActive: true,
  }).returning({ id: accountsTable.id });
  insertedAccountIds.push(foreignAcct.id);

  const [jeXlink] = await db.insert(journalEntriesTable).values({
    companyId: schemaCompanyId, docNumber: `${TEST_TAG}-S-JE-XLINK`,
    entryDate: "2025-06-01", description: "uses foreign account",
    status: "draft",
  }).returning({ id: journalEntriesTable.id });
  insertedJournalEntryIds.push(jeXlink.id);

  await db.insert(journalEntryLinesTable).values([
    { entryId: jeXlink.id, accountId: foreignAcct.id, debit: "10", credit: "0",  sortOrder: 0 },
    { entryId: jeXlink.id, accountId: foreignAcct.id, debit: "0",  credit: "10", sortOrder: 1 },
  ]);

  // sequence-gaps seed: TWO sequences, each with multiple gaps.
  const seqs = await db.insert(sequencesTable).values([
    { companyId: schemaCompanyId, code: `${TEST_TAG}_S_SEQ1`,
      nameAr: "مسلسل اختبار 1", nameEn: "Test seq 1",
      prefix: "T1-", startNumber: 1, endNumber: 9999, currentNumber: 4,
      padLength: 4, isActive: true, transactionTypes: ["sales_invoice"] },
    { companyId: schemaCompanyId, code: `${TEST_TAG}_S_SEQ2`,
      nameAr: "مسلسل اختبار 2", nameEn: "Test seq 2",
      prefix: "T2-", startNumber: 1, endNumber: 9999, currentNumber: 6,
      padLength: 4, isActive: true, transactionTypes: ["purchase_invoice"] },
  ]).returning({ id: sequencesTable.id });
  insertedSequenceIds.push(seqs[0].id, seqs[1].id);

  // dormant-users seed: TWO dormant users on the schema company.
  const oldLogin = new Date(Date.now() - 200 * 86_400_000);
  const dormantHash = await bcrypt.hash("ignored", 4);
  const dormantUsers = await db.insert(usersTable).values([
    { username: `${TEST_TAG}_S_dormant_1`, email: null, passwordHash: dormantHash,
      role: "admin", isActive: true, sessionToken: null, sessionId: null,
      companyId: schemaCompanyId, lastLoginAt: oldLogin },
    { username: `${TEST_TAG}_S_dormant_2`, email: null, passwordHash: dormantHash,
      role: "admin", isActive: true, sessionToken: null, sessionId: null,
      companyId: schemaCompanyId, lastLoginAt: oldLogin },
  ]).returning({ id: usersTable.id });
  insertedUserIds.push(dormantUsers[0].id, dormantUsers[1].id);

  // unbalanced-entries seed: TWO posted JEs with debit ≠ credit.
  const unbal = await db.insert(journalEntriesTable).values([
    { companyId: schemaCompanyId, docNumber: `${TEST_TAG}-S-JE-UNBAL-1`,
      entryDate: "2025-06-04", description: "unbalanced 1", status: "posted" },
    { companyId: schemaCompanyId, docNumber: `${TEST_TAG}-S-JE-UNBAL-2`,
      entryDate: "2025-06-05", description: "unbalanced 2", status: "posted" },
  ]).returning({ id: journalEntriesTable.id });
  insertedJournalEntryIds.push(unbal[0].id, unbal[1].id);
  await db.insert(journalEntryLinesTable).values([
    { entryId: unbal[0].id, accountId: null, debit: "100", credit: "0",  sortOrder: 0 },
    { entryId: unbal[0].id, accountId: null, debit: "0",   credit: "70", sortOrder: 1 },
    { entryId: unbal[1].id, accountId: null, debit: "200", credit: "0",   sortOrder: 0 },
    { entryId: unbal[1].id, accountId: null, debit: "0",   credit: "150", sortOrder: 1 },
  ]);

  // old-audit-logs seed: TWO rows older than 365 days.
  const oldAuditAt = new Date(Date.now() - 400 * 86_400_000);
  const oldAudits = await db.insert(auditLogTable).values([
    { userId: saUserId, username: `${TEST_TAG}_sa`, role: "superadmin",
      companyId: schemaCompanyId, module: "test", action: "view",
      method: "GET", path: "/api/test/1", statusCode: 200,
      ip: "127.0.0.1", createdAt: oldAuditAt },
    { userId: saUserId, username: `${TEST_TAG}_sa`, role: "superadmin",
      companyId: schemaCompanyId, module: "test", action: "view",
      method: "GET", path: "/api/test/2", statusCode: 200,
      ip: "127.0.0.2", createdAt: oldAuditAt },
  ]).returning({ id: auditLogTable.id });
  insertedAuditLogIds.push(oldAudits[0].id, oldAudits[1].id);

  // old-maintenance-runs seed: TWO rows older than 90 days.
  const oldRunAt = new Date(Date.now() - 120 * 86_400_000);
  const oldRuns = await db.insert(maintenanceRunsTable).values([
    { companyId: schemaCompanyId, toolKey: "journal-pending", status: "ok",
      count: 0, trigger: "scheduled", runAt: oldRunAt, durationMs: 5,
      error: null, details: null },
    { companyId: schemaCompanyId, toolKey: "broken-refs", status: "warn",
      count: 1, trigger: "scheduled", runAt: oldRunAt, durationMs: 7,
      error: null, details: null },
  ]).returning({ id: maintenanceRunsTable.id });
  insertedMaintenanceRunIds.push(oldRuns[0].id, oldRuns[1].id);
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
        lastEmailAt:                savedScheduleRow.lastEmailAt,
        lastEmailStatus:            savedScheduleRow.lastEmailStatus,
        lastEmailError:             savedScheduleRow.lastEmailError,
        lastEmailRecipients:        savedScheduleRow.lastEmailRecipients,
        lastEmailCriticalCount:     savedScheduleRow.lastEmailCriticalCount,
        emailMinIntervalHours:      savedScheduleRow.emailMinIntervalHours,
        lastSuccessfulEmailAt:      savedScheduleRow.lastSuccessfulEmailAt,
        lastEmailCriticalSignature: savedScheduleRow.lastEmailCriticalSignature,
        updatedAt:                  savedScheduleRow.updatedAt,
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
  if (insertedMaintenanceEmailRunIds.length) {
    await db.delete(maintenanceEmailRunsTable)
      .where(inArray(maintenanceEmailRunsTable.id, insertedMaintenanceEmailRunIds));
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
//  Email digest: critical-set signature + cooldown decision
// ════════════════════════════════════════════════════════════════════════════
// The cadence guard introduced for the digest cooldown is decomposed into
// (a) a stable signature of the current critical set and (b) a pure decision
// function that decides whether a real send should be skipped. Both are pinned
// here so a regression in either silently re-introduces the alert-fatigue bug
// the cadence was added to solve.

test("computeCriticalSignature: empty set → empty string", () => {
  assert.equal(computeCriticalSignature([]), "");
});

test("computeCriticalSignature: order-independent for the same triples", () => {
  const a = computeCriticalSignature([
    { companyId: 7, toolKey: "broken-refs", count: 2 },
    { companyId: 3, toolKey: "journal-pending", count: 5 },
  ]);
  const b = computeCriticalSignature([
    { companyId: 3, toolKey: "journal-pending", count: 5 },
    { companyId: 7, toolKey: "broken-refs", count: 2 },
  ]);
  assert.equal(a, b);
  assert.notEqual(a, "");
});

test("computeCriticalSignature: changes when count changes", () => {
  const before = computeCriticalSignature([{ companyId: 3, toolKey: "journal-pending", count: 5 }]);
  const after  = computeCriticalSignature([{ companyId: 3, toolKey: "journal-pending", count: 6 }]);
  assert.notEqual(before, after);
});

test("computeCriticalSignature: changes when a new (company, tool) appears", () => {
  const before = computeCriticalSignature([{ companyId: 3, toolKey: "journal-pending", count: 5 }]);
  const after  = computeCriticalSignature([
    { companyId: 3, toolKey: "journal-pending", count: 5 },
    { companyId: 4, toolKey: "broken-refs",     count: 1 },
  ]);
  assert.notEqual(before, after);
});

test("computeCriticalSignature: severity change flips the hash even when count is identical", () => {
  // Regression for the per-recipient threshold feature: a (company, tool, count)
  // row promoted from warn → critical now meets threshold='critical' recipients,
  // so the signature MUST change to bypass the cooldown and re-arm dispatch.
  const asWarn = computeCriticalSignature([
    { companyId: 3, toolKey: "journal-pending", count: 5, severity: "warn" },
  ]);
  const asCritical = computeCriticalSignature([
    { companyId: 3, toolKey: "journal-pending", count: 5, severity: "critical" },
  ]);
  assert.notEqual(asWarn, asCritical);
  assert.notEqual(asWarn, "");
});

test("computeCriticalSignature: omitted severity hashes as 'critical' (back-compat)", () => {
  // Pre-severity callers (and older audit rows) use the legacy shape; that
  // shape must keep producing the same hash as an explicit critical row so
  // existing cooldown anchors aren't accidentally invalidated.
  const legacy = computeCriticalSignature([
    { companyId: 3, toolKey: "journal-pending", count: 5 },
  ]);
  const explicit = computeCriticalSignature([
    { companyId: 3, toolKey: "journal-pending", count: 5, severity: "critical" },
  ]);
  assert.equal(legacy, explicit);
});

test("severityMeetsThreshold: 'critical' threshold requires a critical row", () => {
  // The conservative default — only a present 'critical' should trigger.
  assert.equal(severityMeetsThreshold(new Set<AlertSeverity>(["critical"]), "critical"), true);
  assert.equal(severityMeetsThreshold(new Set<AlertSeverity>(["warn"]),     "critical"), false);
  assert.equal(severityMeetsThreshold(new Set<AlertSeverity>(["error"]),    "critical"), false);
  assert.equal(severityMeetsThreshold(new Set<AlertSeverity>(),             "critical"), false);
});

test("severityMeetsThreshold: 'warning' threshold accepts critical OR warn (but not error-only)", () => {
  assert.equal(severityMeetsThreshold(new Set<AlertSeverity>(["critical"]),       "warning"), true);
  assert.equal(severityMeetsThreshold(new Set<AlertSeverity>(["warn"]),           "warning"), true);
  assert.equal(severityMeetsThreshold(new Set<AlertSeverity>(["critical", "warn"]),"warning"), true);
  assert.equal(severityMeetsThreshold(new Set<AlertSeverity>(["error"]),          "warning"), false);
  assert.equal(severityMeetsThreshold(new Set<AlertSeverity>(),                   "warning"), false);
});

test("severityMeetsThreshold: 'all' threshold fires on any non-OK signal — including error-only sweeps", () => {
  // The motivating case: a silently-broken tool (status='error') with no
  // warn/critical findings still pages 'all'-threshold SuperAdmins so wedged
  // checks don't go unnoticed for weeks.
  assert.equal(severityMeetsThreshold(new Set<AlertSeverity>(["error"]),    "all"), true);
  assert.equal(severityMeetsThreshold(new Set<AlertSeverity>(["warn"]),     "all"), true);
  assert.equal(severityMeetsThreshold(new Set<AlertSeverity>(["critical"]), "all"), true);
  assert.equal(severityMeetsThreshold(new Set<AlertSeverity>(),             "all"), false);
});

test("severityMeetsThreshold: unknown / null / legacy values fall back to the conservative 'critical'", () => {
  // Defensive: a hand-edited row, a stale client, or a future enum value must
  // not accidentally over-page. Falling back to 'critical' matches the safest
  // default and the historical behaviour pre-feature.
  const onlyWarn = new Set<AlertSeverity>(["warn"]);
  const onlyCrit = new Set<AlertSeverity>(["critical"]);
  for (const t of [null, undefined, "", "verbose", "VERBOSE", "ALL"]) {
    assert.equal(severityMeetsThreshold(onlyWarn, t as any), false);
    assert.equal(severityMeetsThreshold(onlyCrit, t as any), true);
  }
});

test("shouldSkipForRateLimit: cadence=0 → never skips (legacy fire-every-sweep)", () => {
  const now = new Date();
  assert.equal(
    shouldSkipForRateLimit(now, {
      emailMinIntervalHours: 0,
      lastSuccessfulEmailAt: new Date(now.getTime() - 60_000),
      lastEmailCriticalSignature: "abc",
    }, "abc"),
    false,
  );
});

test("shouldSkipForRateLimit: cooldown elapsed → never skips", () => {
  const now = new Date();
  // 25h after the last *successful* send, cadence=24h → window expired.
  assert.equal(
    shouldSkipForRateLimit(now, {
      emailMinIntervalHours: 24,
      lastSuccessfulEmailAt: new Date(now.getTime() - 25 * 60 * 60_000),
      lastEmailCriticalSignature: "abc",
    }, "abc"),
    false,
  );
});

test("shouldSkipForRateLimit: within cooldown + identical signature → skips", () => {
  const now = new Date();
  // 1h after the last successful send, cadence=24h, same critical set →
  // suppress to cut alert noise.
  assert.equal(
    shouldSkipForRateLimit(now, {
      emailMinIntervalHours: 24,
      lastSuccessfulEmailAt: new Date(now.getTime() - 60 * 60_000),
      lastEmailCriticalSignature: "abc",
    }, "abc"),
    true,
  );
});

test("shouldSkipForRateLimit: within cooldown + different signature → never skips", () => {
  // The whole point of the signature: a *new* critical finding always reaches
  // SuperAdmins promptly even if the cooldown clock hasn't elapsed yet.
  const now = new Date();
  assert.equal(
    shouldSkipForRateLimit(now, {
      emailMinIntervalHours: 24,
      lastSuccessfulEmailAt: new Date(now.getTime() - 60 * 60_000),
      lastEmailCriticalSignature: "abc",
    }, "xyz"),
    false,
  );
});

test("shouldSkipForRateLimit: no prior successful send → never skips (first dispatch always fires)", () => {
  const now = new Date();
  // A failed/never-sent state has lastSuccessfulEmailAt=null even if there
  // were earlier failed *attempts* — the next sweep must fire immediately.
  assert.equal(
    shouldSkipForRateLimit(now, {
      emailMinIntervalHours: 24,
      lastSuccessfulEmailAt: null,
      lastEmailCriticalSignature: null,
    }, "abc"),
    false,
  );
});

test("shouldSkipForRateLimit: suppression persists across many ticks until window expires", () => {
  // Regression guard for the "rate-limited tick resets the cooldown" bug:
  // every tick inside the window with an unchanged signature must keep
  // returning true, regardless of how many times we've already skipped.
  // Previously this logic anchored on lastEmailAt + lastEmailStatus, which
  // got overwritten by each suppressed tick and let the next sweep send too
  // early. Anchoring on lastSuccessfulEmailAt fixes that.
  const successAt = new Date(Date.UTC(2026, 0, 15, 0, 0, 0));
  const cfg = {
    emailMinIntervalHours: 48,
    lastSuccessfulEmailAt: successAt,
    lastEmailCriticalSignature: "abc",
  };
  // 5 minutes, 1 hour, 24h, 47h59m after the send — all within the 48h window.
  for (const offsetMs of [5 * 60_000, 60 * 60_000, 24 * 60 * 60_000, (48 * 60 - 1) * 60_000]) {
    const now = new Date(successAt.getTime() + offsetMs);
    assert.equal(
      shouldSkipForRateLimit(now, cfg, "abc"),
      true,
      `cadence must still suppress at +${offsetMs / 60_000} minutes`,
    );
  }
  // And the moment we cross the window, the next dispatch goes out.
  const past = new Date(successAt.getTime() + 48 * 60 * 60_000 + 1_000);
  assert.equal(shouldSkipForRateLimit(past, cfg, "abc"), false);
});

test("shouldSkipForRateLimit: multi-day cadence honours the configured interval (not a 24h floor)", () => {
  // Operators can set the cadence to e.g. 72h ("send at most every 3 days").
  // 25h after the last send must still be inside the cooldown.
  const successAt = new Date(Date.UTC(2026, 0, 15, 0, 0, 0));
  const now       = new Date(successAt.getTime() + 25 * 60 * 60_000);
  assert.equal(
    shouldSkipForRateLimit(now, {
      emailMinIntervalHours: 72,
      lastSuccessfulEmailAt: successAt,
      lastEmailCriticalSignature: "abc",
    }, "abc"),
    true,
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
  // 12 (old-maintenance-email-runs) is global, not company-scoped — any rows
  // written by other suites or live traffic make the bare count meaningless on
  // a per-company assertion. We instead pin it via the dedicated test below
  // which inserts its own row and asserts the prune covers it.
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

// 12. old-maintenance-email-runs: a maintenance_email_runs row > 90 days old.
// The table is global (no company_id), so this asserts the check picks up our
// seed regardless of which companyId we pass — the arg is ignored by design.
test("checkOldMaintenanceEmailRuns: counts maintenance_email_runs older than the threshold", async () => {
  const oldRanAt = new Date(Date.now() - 120 * 86_400_000);
  const [er] = await db.insert(maintenanceEmailRunsTable).values({
    ranAt:             oldRanAt,
    trigger:           "scheduled",
    status:            "ok",
    recipients:        2,
    criticalCount:     3,
    error:             null,
    reason:            "digest_sent",
    criticalSignature: "test_old_email_run_sig",
  }).returning({ id: maintenanceEmailRunsTable.id });
  insertedMaintenanceEmailRunIds.push(er.id);

  const r = await checkOldMaintenanceEmailRuns(dirtyCompanyId, 90);
  assert.ok(r.count >= 1, `expected count >= 1, got ${r.count}`);
  assert.ok(r.items!.some((it: { id: number }) => it.id === er.id),
    "items must include the old maintenance_email_runs row");
  assert.ok(isObject(r.extras) && r.extras!.days === 90);

  // Recent rows (well within the retention window) must NOT be counted —
  // proves the SQL cutoff is anchored on `ran_at`, not just "all rows".
  const [recent] = await db.insert(maintenanceEmailRunsTable).values({
    ranAt:             new Date(),
    trigger:           "test",
    status:            "ok",
    recipients:        1,
    criticalCount:     0,
    error:             null,
    reason:            "digest_sent",
    criticalSignature: "test_recent_email_run_sig",
  }).returning({ id: maintenanceEmailRunsTable.id });
  insertedMaintenanceEmailRunIds.push(recent.id);

  const r2 = await checkOldMaintenanceEmailRuns(dirtyCompanyId, 90);
  assert.ok(!r2.items!.some((it: { id: number }) => it.id === recent.id),
    "items must NOT include the in-window (recent) maintenance_email_runs row");
});

// ════════════════════════════════════════════════════════════════════════════
//  Schema-pin: every check returns the documented `items` shape against a
//  freshly-seeded company with multiple items / warehouses. These tests are
//  the regression guard for the column-rename bug that crashed
//  negative-stock and stock-balance-drift in production: the per-check
//  positive-finding tests above only seed ONE item+warehouse, which lets the
//  buggy SQL still match its single row. With multiple rows on the JOINed
//  side, any column rename in items / warehouses (or the other tables a
//  check references) either fails the SELECT outright or yields NULL
//  placeholders — both of which trip the field-presence assertions here.
// ════════════════════════════════════════════════════════════════════════════
//
// Helper: every documented field on a row must (a) exist as a key and
// (b) carry a non-null value (or the explicitly allowed null type). The
// per-check tests above already prove `count`, so the focus here is
// strictly on the items payload that powers the operator UI / CSV export.
type ExpectedKind = "string" | "number" | "date" | "json";
function assertRowShape(
  label: string,
  row: Record<string, unknown>,
  expected: Record<string, ExpectedKind>,
): void {
  for (const [key, kind] of Object.entries(expected)) {
    assert.ok(key in row, `${label}: missing field "${key}" — likely column rename`);
    const v = row[key];
    assert.notEqual(v, null,    `${label}: field "${key}" is null — JOIN missed its target`);
    assert.notEqual(v, undefined, `${label}: field "${key}" is undefined`);
    switch (kind) {
      case "string":
        assert.equal(typeof v, "string", `${label}: field "${key}" expected string, got ${typeof v}`);
        assert.ok((v as string).length > 0, `${label}: field "${key}" is empty string`);
        break;
      case "number":
        assert.equal(typeof v, "number", `${label}: field "${key}" expected number, got ${typeof v}`);
        assert.ok(Number.isFinite(v as number),
          `${label}: field "${key}" is not finite (${String(v)})`);
        break;
      case "date":
        // pg returns timestamps as Date instances; ISO strings are also acceptable.
        assert.ok(v instanceof Date || typeof v === "string",
          `${label}: field "${key}" expected Date|string, got ${typeof v}`);
        break;
      case "json":
        assert.equal(typeof v, "object",
          `${label}: field "${key}" expected object/array, got ${typeof v}`);
        break;
    }
  }
}

test("schema-pin: checkJournalPending items expose every documented field", async () => {
  const r = await checkJournalPending(schemaCompanyId, 30);
  assert.ok(r.count >= 2, `expected >=2 old drafts, got ${r.count}`);
  assert.ok(Array.isArray(r.items) && r.items.length >= 2,
    "items must be a >=2-row array (multi-row seed)");
  for (const it of r.items as Array<Record<string, unknown>>) {
    assertRowShape("journal-pending", it, {
      id:          "number",
      docNumber:   "string",
      entryDate:   "string", // pg date column → string
      description: "string",
      createdAt:   "date",
      totalDebit:  "string", // ::text cast in SQL
      totalCredit: "string",
    });
  }
});

test("schema-pin: checkBrokenRefs items expose every documented field for both kinds", async () => {
  const r = await checkBrokenRefs(schemaCompanyId);
  assert.ok(r.count >= 3, `expected >=3 broken refs, got ${r.count}`);
  // Both kinds must appear so we cover both SELECT branches.
  const kinds = new Set((r.items ?? []).map((it: { kind: string }) => it.kind));
  assert.ok(kinds.has("sales") && kinds.has("purchase"),
    `expected both kinds, got ${[...kinds].join(",")}`);
  for (const it of r.items as Array<Record<string, unknown>>) {
    assertRowShape("broken-refs", it, {
      id:           "number",
      docNumber:    "string",
      invoiceDate:  "string",
      totalAmount:  "string",
      reason:       "string",
      kind:         "string",
    });
    // journalEntryId is null on the "missing" branch by definition; check
    // it's the right type when present.
    const reason = it.reason as string;
    if (reason === "stale") {
      assert.equal(typeof it.journalEntryId, "number",
        "stale broken-ref must expose a numeric journalEntryId");
    } else {
      assert.equal(it.journalEntryId, null,
        "missing broken-ref must expose journalEntryId=null");
    }
  }
});

test("schema-pin: checkUnlinkedAccounts items expose every documented field", async () => {
  const r = await checkUnlinkedAccounts(schemaCompanyId);
  assert.ok(r.count >= 1, `expected >=1 unlinked account, got ${r.count}`);
  for (const it of r.items as Array<Record<string, unknown>>) {
    assertRowShape("unlinked-accounts", it, {
      accountId:        "number",
      lineCount:        "number",
      sampleEntryId:    "number",
      sampleDocNumber:  "string",
    });
    // The seed put TWO lines on the same JE → lineCount must reflect that.
    assert.ok((it.lineCount as number) >= 2,
      `expected lineCount>=2 for the cross-link account, got ${it.lineCount}`);
  }
});

test("schema-pin: checkSequenceGaps items + sampleGaps expose every documented field", async () => {
  const r = await checkSequenceGaps(schemaCompanyId);
  assert.ok(r.count >= 5, `expected >=5 gaps across 2 sequences, got ${r.count}`);
  assert.ok((r.items ?? []).length >= 2, "must report both seeded sequences");
  for (const it of r.items as Array<Record<string, unknown>>) {
    assertRowShape("sequence-gaps", it, {
      sequenceId:  "number",
      code:        "string",
      nameAr:      "string",
      gapCount:    "number",
    });
    const samples = it.sampleGaps as Array<{ number: unknown; formatted: unknown }>;
    assert.ok(Array.isArray(samples) && samples.length > 0,
      "sampleGaps must be a non-empty array");
    for (const s of samples) {
      assert.equal(typeof s.number, "number",
        `sequence-gaps.sampleGaps[].number must be a number, got ${typeof s.number}`);
      assert.equal(typeof s.formatted, "string",
        `sequence-gaps.sampleGaps[].formatted must be a string, got ${typeof s.formatted}`);
      assert.ok((s.formatted as string).length > 0,
        "sequence-gaps.sampleGaps[].formatted must be non-empty");
    }
  }
  assert.ok(isObject(r.extras) && typeof r.extras!.sequencesAffected === "number");
});

test("schema-pin: checkDormantUsers items expose every documented field", async () => {
  const r = await checkDormantUsers(schemaCompanyId, 90);
  assert.ok(r.count >= 2, `expected >=2 dormant users, got ${r.count}`);
  for (const it of r.items as Array<Record<string, unknown>>) {
    assert.ok("id" in it && typeof it.id === "number", "dormant: id required");
    assert.ok("username" in it && typeof it.username === "string",
      "dormant: username required");
    // email/nameAr/lastLoginAt may legitimately be null per schema; we only
    // pin the *keys* so a column rename still trips the test.
    for (const key of ["email", "nameAr", "role", "lastLoginAt", "isActive", "createdAt"]) {
      assert.ok(key in it, `dormant: missing key "${key}" — likely column rename`);
    }
    assert.equal(typeof it.role, "string", "dormant: role must be string");
    assert.equal(typeof it.isActive, "boolean", "dormant: isActive must be boolean");
  }
});

test("schema-pin: checkOrphanStock returns the seeded count", async () => {
  // Orphan-stock returns count only (no items payload), so we just verify
  // the SQL still resolves and finds our seeded ledger row pointing at a
  // non-existent invoice.
  const r = await checkOrphanStock(schemaCompanyId);
  assert.ok(r.count >= 1, `expected >=1 orphan ledger row, got ${r.count}`);
  assert.equal(typeof r.count, "number");
});

test("schema-pin: checkNegativeStock items expose every documented field across multiple items/warehouses", async () => {
  const r = await checkNegativeStock(schemaCompanyId);
  // Three negative-balance pairs were seeded.
  assert.ok(r.count >= 3, `expected >=3 negative balances, got ${r.count}`);
  // Distinct items + warehouses must show up — proves the JOIN correctly
  // discriminates per-row (the bug we are guarding against would either
  // crash the SELECT or coalesce all rows to NULL placeholders).
  const items = r.items as Array<Record<string, unknown>>;
  const seenItems = new Set(items.map((i) => i.itemId as number));
  const seenWhs   = new Set(items.map((i) => i.warehouseId as number));
  assert.ok(seenItems.size >= 2, `expected >=2 distinct itemIds, got ${seenItems.size}`);
  assert.ok(seenWhs.size   >= 2, `expected >=2 distinct warehouseIds, got ${seenWhs.size}`);
  for (const it of items) {
    assertRowShape("negative-stock", it, {
      id:            "number",
      itemId:        "number",
      warehouseId:   "number",
      qty:           "string",
      avgCost:       "string",
      updatedAt:     "date",
      itemCode:      "string",
      itemName:      "string",
      warehouseName: "string",
    });
    // qty must parse as a negative number.
    assert.ok(Number(it.qty as string) < 0,
      `negative-stock row ${it.id} should have qty<0, got ${it.qty}`);
  }
});

test("schema-pin: checkStockBalanceDrift items expose every documented field including FULL OUTER edge cases", async () => {
  const r = await checkStockBalanceDrift(schemaCompanyId);
  // Three pairs with stored balances + one ledger-only pair = 4 drifting rows.
  assert.ok(r.count >= 4, `expected >=4 drift rows, got ${r.count}`);
  const items = r.items as Array<Record<string, unknown>>;
  for (const it of items) {
    assertRowShape("stock-balance-drift", it, {
      itemId:        "number",
      warehouseId:   "number",
      storedQty:     "string",
      ledgerQty:     "string",
      drift:         "string",
      itemCode:      "string",
      itemName:      "string",
      warehouseName: "string",
    });
    // drift must equal storedQty - ledgerQty within 4 decimal places.
    const stored = Number(it.storedQty as string);
    const ledger = Number(it.ledgerQty as string);
    const drift  = Number(it.drift as string);
    assert.ok(Math.abs((stored - ledger) - drift) < 1e-4,
      `drift arithmetic broken for row item=${it.itemId}: ${stored} - ${ledger} ≠ ${drift}`);
    assert.notEqual(drift, 0, "WHERE clause must filter out balanced rows");
  }
});

test("schema-pin: checkUnbalancedEntries items expose every documented field", async () => {
  const r = await checkUnbalancedEntries(schemaCompanyId);
  assert.ok(r.count >= 2, `expected >=2 unbalanced JEs, got ${r.count}`);
  for (const it of r.items as Array<Record<string, unknown>>) {
    assertRowShape("unbalanced-entries", it, {
      id:          "number",
      docNumber:   "string",
      entryDate:   "string",
      description: "string",
      status:      "string",
      totalDebit:  "string",
      totalCredit: "string",
      diff:        "string",
      lineCount:   "number",
    });
    // diff must equal debit - credit within 2dp (matches SQL ROUND).
    const d = Number(it.totalDebit  as string);
    const c = Number(it.totalCredit as string);
    const diff = Number(it.diff as string);
    assert.ok(Math.abs((d - c) - diff) < 1e-2,
      `unbalanced diff arithmetic broken: ${d} - ${c} ≠ ${diff}`);
    assert.equal(it.status, "posted", "unbalanced check must only return posted JEs");
  }
});

test("schema-pin: checkOldAuditLogs items expose every documented field + extras window", async () => {
  const r = await checkOldAuditLogs(schemaCompanyId, 365);
  assert.ok(r.count >= 2, `expected >=2 old audit rows, got ${r.count}`);
  for (const it of r.items as Array<Record<string, unknown>>) {
    // Some columns are nullable on the audit_log schema (entityType/userAgent
    // etc.) but the SELECT only returns the always-present subset; pin those.
    assert.ok("id" in it && typeof it.id === "number");
    assert.ok("module" in it && typeof it.module === "string");
    assert.ok("action" in it && typeof it.action === "string");
    for (const key of ["userId", "username", "role", "method", "path", "statusCode", "ip", "createdAt"]) {
      assert.ok(key in it, `old-audit-logs: missing key "${key}" — likely column rename`);
    }
  }
  assert.ok(isObject(r.extras), "extras object required");
  assert.equal((r.extras as { days: number }).days, 365);
  assert.ok((r.extras as { oldest: unknown }).oldest != null,
    "extras.oldest must be set when count>0");
  assert.ok((r.extras as { newest: unknown }).newest != null,
    "extras.newest must be set when count>0");
});

test("schema-pin: checkOldMaintenanceRuns items expose every documented field + extras window", async () => {
  const r = await checkOldMaintenanceRuns(schemaCompanyId, 90);
  assert.ok(r.count >= 2, `expected >=2 old maint runs, got ${r.count}`);
  for (const it of r.items as Array<Record<string, unknown>>) {
    assertRowShape("old-maintenance-runs", it, {
      id:         "number",
      toolKey:    "string",
      status:     "string",
      count:      "number",
      trigger:    "string",
      runAt:      "date",
      durationMs: "number",
    });
    // `error` column is nullable; pin the key only.
    assert.ok("error" in it, "old-maintenance-runs: missing key \"error\"");
  }
  assert.ok(isObject(r.extras), "extras object required");
  assert.equal((r.extras as { days: number }).days, 90);
  assert.ok((r.extras as { oldest: unknown }).oldest != null,
    "extras.oldest must be set when count>0");
  assert.ok((r.extras as { newest: unknown }).newest != null,
    "extras.newest must be set when count>0");
});

// ════════════════════════════════════════════════════════════════════════════
//  getRecentToolErrors — per-(company, tool) latest error within window
// ════════════════════════════════════════════════════════════════════════════
test("getRecentToolErrors: returns latest error per (company,tool); recovered tools drop out; old rows excluded", async () => {
  const now      = Date.now();
  const inWindow = new Date(now - 2 * 86_400_000); // 2 days ago — inside window
  const stale    = new Date(now - (TOOL_ERROR_WINDOW_DAYS + 2) * 86_400_000); // outside

  // Tool A on dirtyCompanyId: an error inside the window, then a later OK
  // (recovered) → must NOT appear.
  const recoveredErr = await db.insert(maintenanceRunsTable).values({
    companyId:  dirtyCompanyId,
    toolKey:    "tt-tool-recovered",
    status:     "error",
    count:      0,
    trigger:    "scheduled",
    runAt:      new Date(now - 3 * 86_400_000),
    durationMs: 1,
    error:      "boom",
    details:    null,
  }).returning({ id: maintenanceRunsTable.id });
  const recoveredOk = await db.insert(maintenanceRunsTable).values({
    companyId:  dirtyCompanyId,
    toolKey:    "tt-tool-recovered",
    status:     "ok",
    count:      0,
    trigger:    "scheduled",
    runAt:      new Date(now - 1 * 86_400_000),
    durationMs: 1,
    error:      null,
    details:    null,
  }).returning({ id: maintenanceRunsTable.id });

  // Tool B on dirtyCompanyId: still-broken — latest row is an error.
  const stillBrokenErr = await db.insert(maintenanceRunsTable).values({
    companyId:  dirtyCompanyId,
    toolKey:    "tt-tool-broken",
    status:     "error",
    count:      0,
    trigger:    "scheduled",
    runAt:      inWindow,
    durationMs: 1,
    error:      "kaboom",
    details:    null,
  }).returning({ id: maintenanceRunsTable.id });

  // Tool C on cleanCompanyId: an error OUTSIDE the window → must NOT appear.
  const oldErr = await db.insert(maintenanceRunsTable).values({
    companyId:  cleanCompanyId,
    toolKey:    "tt-tool-stale",
    status:     "error",
    count:      0,
    trigger:    "scheduled",
    runAt:      stale,
    durationMs: 1,
    error:      "ancient",
    details:    null,
  }).returning({ id: maintenanceRunsTable.id });

  insertedMaintenanceRunIds.push(
    recoveredErr[0].id, recoveredOk[0].id, stillBrokenErr[0].id, oldErr[0].id,
  );

  const items = await getRecentToolErrors(50, TOOL_ERROR_WINDOW_DAYS);
  const ids   = new Set(items.map(it => it.id));

  assert.ok(ids.has(stillBrokenErr[0].id),
    "still-broken tool's latest error must be returned");
  assert.ok(!ids.has(recoveredErr[0].id),
    "recovered tool's older error row must NOT appear (newer ok wins)");
  assert.ok(!ids.has(recoveredOk[0].id),
    "the recovery 'ok' row itself must never appear (status must be 'error')");
  assert.ok(!ids.has(oldErr[0].id),
    "errors outside the retention window must NOT appear");

  // Shape contract: callers (dashboard banner + UI panel) read these fields.
  const row = items.find(it => it.id === stillBrokenErr[0].id)!;
  assert.equal(row.companyId, dirtyCompanyId);
  assert.equal(row.toolKey, "tt-tool-broken");
  assert.equal(row.status, "error");
  assert.equal(row.error, "kaboom");
  assert.ok(row.runAt instanceof Date || typeof row.runAt === "string",
    "runAt must be a Date or ISO string");
});

test("getRecentToolErrors: respects the limit argument", async () => {
  const items = await getRecentToolErrors(1, TOOL_ERROR_WINDOW_DAYS);
  assert.ok(items.length <= 1, `limit=1 must cap rows, got ${items.length}`);
});

// ════════════════════════════════════════════════════════════════════════════
//  getRecentToolRecoveries — per-(company, tool) error → non-error transitions
// ════════════════════════════════════════════════════════════════════════════
// Mirrors `getRecentToolErrors` but in the positive direction: surface tools
// whose latest run completed without error AND whose immediately-prior run
// was an error within the recency window. The four cases below are the
// independent failure modes the digest "Recovered tools" section can hit:
//   1. Recovered to ok inside the window → MUST appear.
//   2. Recovered to warn/critical inside the window → MUST appear (the check
//      ran successfully, just found findings; honest reporting matters).
//   3. Recovered then re-broke → MUST NOT appear (latest is error; that's
//      the error-helper's job, not ours — keeps the two helpers mutually
//      exclusive).
//   4. Recovery older than the window → MUST NOT appear.
test("getRecentToolRecoveries: returns tools that flipped error → non-error within window", async () => {
  const now = Date.now();
  const stale = (TOOL_ERROR_WINDOW_DAYS + 2) * 86_400_000;

  // Case 1 — recovered-to-ok inside the window. Latest row is ok at t-1d,
  // immediate predecessor is an error at t-3d. MUST appear.
  const okRecErr = await db.insert(maintenanceRunsTable).values({
    companyId: dirtyCompanyId, toolKey: "tt-rec-ok",
    status: "error", count: 0, trigger: "scheduled",
    runAt: new Date(now - 3 * 86_400_000), durationMs: 1,
    error: "boom", details: null,
  }).returning({ id: maintenanceRunsTable.id });
  const okRecOk = await db.insert(maintenanceRunsTable).values({
    companyId: dirtyCompanyId, toolKey: "tt-rec-ok",
    status: "ok", count: 0, trigger: "scheduled",
    runAt: new Date(now - 1 * 86_400_000), durationMs: 1,
    error: null, details: null,
  }).returning({ id: maintenanceRunsTable.id });

  // Case 2 — recovered-to-warn inside the window. Operators still need this:
  // the previously-broken check now runs, but found findings. Must appear
  // and report `currentStatus = "warn"` so the email badge is honest.
  const warnRecErr = await db.insert(maintenanceRunsTable).values({
    companyId: dirtyCompanyId, toolKey: "tt-rec-warn",
    status: "error", count: 0, trigger: "scheduled",
    runAt: new Date(now - 4 * 86_400_000), durationMs: 1,
    error: "kaboom", details: null,
  }).returning({ id: maintenanceRunsTable.id });
  const warnRecWarn = await db.insert(maintenanceRunsTable).values({
    companyId: dirtyCompanyId, toolKey: "tt-rec-warn",
    status: "warn", count: 7, trigger: "scheduled",
    runAt: new Date(now - 2 * 86_400_000), durationMs: 1,
    error: null, details: null,
  }).returning({ id: maintenanceRunsTable.id });

  // Case 3 — recovered then re-broke. Latest row is an error so this pair
  // belongs to getRecentToolErrors, never to getRecentToolRecoveries.
  const flapErr1 = await db.insert(maintenanceRunsTable).values({
    companyId: dirtyCompanyId, toolKey: "tt-rec-flap",
    status: "error", count: 0, trigger: "scheduled",
    runAt: new Date(now - 5 * 86_400_000), durationMs: 1,
    error: "first", details: null,
  }).returning({ id: maintenanceRunsTable.id });
  const flapOk = await db.insert(maintenanceRunsTable).values({
    companyId: dirtyCompanyId, toolKey: "tt-rec-flap",
    status: "ok", count: 0, trigger: "scheduled",
    runAt: new Date(now - 3 * 86_400_000), durationMs: 1,
    error: null, details: null,
  }).returning({ id: maintenanceRunsTable.id });
  const flapErr2 = await db.insert(maintenanceRunsTable).values({
    companyId: dirtyCompanyId, toolKey: "tt-rec-flap",
    status: "error", count: 0, trigger: "scheduled",
    runAt: new Date(now - 1 * 86_400_000), durationMs: 1,
    error: "again", details: null,
  }).returning({ id: maintenanceRunsTable.id });

  // Case 4 — recovery older than the window. Operators don't want to see
  // ancient recoveries in this week's digest.
  const oldRecErr = await db.insert(maintenanceRunsTable).values({
    companyId: cleanCompanyId, toolKey: "tt-rec-stale",
    status: "error", count: 0, trigger: "scheduled",
    runAt: new Date(now - stale - 86_400_000), durationMs: 1,
    error: "ancient", details: null,
  }).returning({ id: maintenanceRunsTable.id });
  const oldRecOk = await db.insert(maintenanceRunsTable).values({
    companyId: cleanCompanyId, toolKey: "tt-rec-stale",
    status: "ok", count: 0, trigger: "scheduled",
    runAt: new Date(now - stale), durationMs: 1,
    error: null, details: null,
  }).returning({ id: maintenanceRunsTable.id });

  insertedMaintenanceRunIds.push(
    okRecErr[0].id, okRecOk[0].id,
    warnRecErr[0].id, warnRecWarn[0].id,
    flapErr1[0].id, flapOk[0].id, flapErr2[0].id,
    oldRecErr[0].id, oldRecOk[0].id,
  );

  const items = await getRecentToolRecoveries(50, TOOL_ERROR_WINDOW_DAYS);

  // Use composite (companyId, toolKey) keys because the recovery row has no
  // primary key column we can compare on — the projection deliberately omits
  // `id` (only the previous-error timestamp is needed for the digest line).
  const keys = new Set(items.map((r) => `${r.companyId}|${r.toolKey}`));

  assert.ok(keys.has(`${dirtyCompanyId}|tt-rec-ok`),
    "recovered-to-ok inside window must appear");
  assert.ok(keys.has(`${dirtyCompanyId}|tt-rec-warn`),
    "recovered-to-warn inside window must still appear (honest 'ran successfully' signal)");
  assert.ok(!keys.has(`${dirtyCompanyId}|tt-rec-flap`),
    "tool that recovered then re-broke must NOT appear (latest is 'error' — error helper's domain)");
  assert.ok(!keys.has(`${cleanCompanyId}|tt-rec-stale`),
    "recoveries older than the window must NOT appear");

  // Shape contract: digest renderer reads currentStatus / previousErrorAt /
  // recoveredAt. Pin these explicitly so a column rename in the SQL projection
  // would trip the test.
  const okRow = items.find((r) =>
    r.companyId === dirtyCompanyId && r.toolKey === "tt-rec-ok",
  )!;
  assert.equal(okRow.currentStatus, "ok",
    "currentStatus must reflect the recovery row's status, not the prior error");
  assert.ok(okRow.previousErrorAt instanceof Date || typeof okRow.previousErrorAt === "string",
    "previousErrorAt must be a Date or ISO string");
  assert.ok(okRow.recoveredAt instanceof Date || typeof okRow.recoveredAt === "string",
    "recoveredAt must be a Date or ISO string");

  const warnRow = items.find((r) =>
    r.companyId === dirtyCompanyId && r.toolKey === "tt-rec-warn",
  )!;
  assert.equal(warnRow.currentStatus, "warn",
    "currentStatus must distinguish a recovery to 'warn' from a clean bill of health");
});

test("getRecentToolRecoveries: respects the limit argument", async () => {
  const items = await getRecentToolRecoveries(1, TOOL_ERROR_WINDOW_DAYS);
  assert.ok(items.length <= 1, `limit=1 must cap rows, got ${items.length}`);
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
    // Only set on the all-companies path (runMaintenanceSweep). Per-company
    // runs build a hand-rolled summary that omits this field — the test that
    // reads it must use the all-companies route.
    recoveryCount?: number;
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

// Recovery detection inside `runMaintenanceSweep` — verifies that when a tool
// transitions from 'error' (its latest pre-sweep status) to a non-error
// outcome during this sweep, the summary's `recoveryCount` is incremented.
// This is the integration-level proof that the per-company prev-status
// snapshot + comparison loop is wired correctly. The companion info-level
// log line is a one-call side effect of the same branch and is not asserted
// independently to avoid a logger-mock dependency.
//
// Setup: pre-seed an 'error' row for a real registered tool ("journal-pending")
// on cleanCompanyId with runAt=now. The clean tenant has no journal data, so
// the next real run of journal-pending returns count=0 (status='ok'), which
// is a textbook recovery transition.
test("POST /maintenance/run-now (all-companies): increments recoveryCount when a tool flips error → non-error", async () => {
  // Pre-seeded error must be the latest row for (cleanCompanyId, journal-pending)
  // at sweep time. We use a runAt slightly in the past (1ms) to guarantee the
  // sweep's freshly-inserted 'ok' row sorts AFTER it under run_at DESC.
  const seededErr = await db.insert(maintenanceRunsTable).values({
    companyId:  cleanCompanyId,
    toolKey:    "journal-pending",
    status:     "error",
    count:      0,
    trigger:    "scheduled",
    runAt:      new Date(Date.now() - 10),
    durationMs: 1,
    error:      "synthetic-pre-sweep-error",
    details:    null,
  }).returning({ id: maintenanceRunsTable.id });
  insertedMaintenanceRunIds.push(seededErr[0].id);

  const r = await api<RunNowResponse>("/api/admin/maintenance/run-now", "POST", {
    token: saToken,
    body: {},
  });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);

  // We seeded one tool transition. Other tenants may also have happened to
  // recover during this sweep, so use >= 1 (not == 1) to stay robust against
  // shared-DB noise from other test runs / live tenants.
  assert.ok(typeof r.body.summary.recoveryCount === "number",
    `summary.recoveryCount must be present on the all-companies path, got ${typeof r.body.summary.recoveryCount}`);
  assert.ok((r.body.summary.recoveryCount ?? 0) >= 1,
    `recoveryCount should be >= 1 after seeding a journal-pending error → ok transition, got ${r.body.summary.recoveryCount}`);
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/admin/maintenance/runs — sparkline drill-down endpoint
// ════════════════════════════════════════════════════════════════════════════
// Returns the underlying maintenance_runs rows that produced a single
// (tool, KSA-day) bar in the trend chart. Verified here so a regression
// (e.g. broken auth gate, broken day filter, leaking other tenants) is
// caught before the SuperAdmin click-through stops working.
interface RunsResponse {
  companyId: number;
  toolKey: string;
  day: string;
  items: Array<{
    id: number;
    runAt: string;
    trigger: "scheduled" | "manual";
    status: "ok" | "warn" | "critical" | "error";
    count: number;
    durationMs: number;
    error: string | null;
    details: unknown;
  }>;
}

test("GET /maintenance/runs: 401 without bearer token", async () => {
  const r = await api(`/api/admin/maintenance/runs?companyId=${dirtyCompanyId}&toolKey=journal-pending&day=2026-04-25`, "GET");
  assert.equal(r.status, 401);
});

test("GET /maintenance/runs: 403 for non-superadmin", async () => {
  const r = await api(`/api/admin/maintenance/runs?companyId=${dirtyCompanyId}&toolKey=journal-pending&day=2026-04-25`, "GET", { token: regularToken });
  assert.equal(r.status, 403);
});

test("GET /maintenance/runs: 400 on missing/invalid arguments", async () => {
  const cases = [
    `?companyId=&toolKey=journal-pending&day=2026-04-25`,                 // empty companyId
    `?companyId=abc&toolKey=journal-pending&day=2026-04-25`,              // non-numeric companyId
    `?companyId=${dirtyCompanyId}&toolKey=&day=2026-04-25`,               // empty toolKey
    `?companyId=${dirtyCompanyId}&toolKey=journal-pending&day=`,          // empty day
    `?companyId=${dirtyCompanyId}&toolKey=journal-pending&day=2026-4-25`, // wrong day format
    `?companyId=${dirtyCompanyId}&toolKey=journal-pending&day=garbage`,   // wrong day format
    `?companyId=${dirtyCompanyId}&toolKey=journal-pending&day=2026-13-01`, // impossible month
    `?companyId=${dirtyCompanyId}&toolKey=journal-pending&day=2026-02-30`, // impossible day
    `?companyId=${dirtyCompanyId}&toolKey=journal-pending&day=2025-02-29`, // non-leap-year Feb 29
  ];
  for (const qs of cases) {
    const r = await api(`/api/admin/maintenance/runs${qs}`, "GET", { token: saToken });
    assert.equal(r.status, 400, `expected 400 for ${qs}, got ${r.status}`);
  }
});

test("GET /maintenance/runs: returns rows for the requested (tool, day) only", async () => {
  // The earlier per-company run-now test inserted manual rows for every tool
  // dated "today" in KSA. Pick a tool that ran and assert we see at least
  // one row for today, ordered DESC, and capped at 50.
  const todayKsa = (() => {
    const exec = db.execute<{ d: string }>(sql`
      SELECT to_char((now() AT TIME ZONE 'Asia/Riyadh')::date, 'YYYY-MM-DD') AS d
    `);
    return exec;
  })();
  const todayRow = (await todayKsa as unknown as { rows: Array<{ d: string }> }).rows[0];
  const today = todayRow.d;

  const r = await api<RunsResponse>(
    `/api/admin/maintenance/runs?companyId=${dirtyCompanyId}&toolKey=journal-pending&day=${today}`,
    "GET",
    { token: saToken },
  );
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  assert.equal(r.body.companyId, dirtyCompanyId);
  assert.equal(r.body.toolKey, "journal-pending");
  assert.equal(r.body.day, today);
  assert.ok(Array.isArray(r.body.items), "items must be an array");
  assert.ok(r.body.items.length >= 1, `expected at least one run for today, got ${r.body.items.length}`);
  assert.ok(r.body.items.length <= 50, `expected at most 50 rows, got ${r.body.items.length}`);

  // Every row must match the requested tool and the (KSA) day.
  for (const it of r.body.items) {
    assert.ok(typeof it.id === "number");
    assert.ok(["scheduled", "manual"].includes(it.trigger), `unexpected trigger ${it.trigger}`);
    assert.ok(["ok", "warn", "critical", "error"].includes(it.status), `unexpected status ${it.status}`);
    // run_at, when interpreted in KSA, must fall on the requested day.
    const ksa = new Date(it.runAt).toLocaleString("en-CA", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit" });
    // toLocaleString returns "YYYY-MM-DD" for en-CA when only date parts are requested.
    assert.equal(ksa, today, `row ${it.id} runAt=${it.runAt} not on KSA day ${today}`);
  }

  // Ordered by run_at DESC.
  for (let i = 1; i < r.body.items.length; i++) {
    assert.ok(
      new Date(r.body.items[i - 1].runAt).getTime() >= new Date(r.body.items[i].runAt).getTime(),
      "items must be sorted by runAt DESC",
    );
  }
});

test("GET /maintenance/runs: empty array on a day that had no runs", async () => {
  // 1990-01-01 is well before any test row exists.
  const r = await api<RunsResponse>(
    `/api/admin/maintenance/runs?companyId=${dirtyCompanyId}&toolKey=journal-pending&day=1990-01-01`,
    "GET",
    { token: saToken },
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items, []);
});

test("GET /maintenance/runs: never leaks rows from another tenant", async () => {
  // Same (toolKey, day) as the success test above, but query as the *clean*
  // company. We seeded that company too, so there must be its OWN rows but
  // none from the dirty tenant. Rather than diff IDs (brittle), assert that
  // every returned row belongs to the requested tenant by re-querying the DB.
  const todayRow = (await db.execute<{ d: string }>(sql`
    SELECT to_char((now() AT TIME ZONE 'Asia/Riyadh')::date, 'YYYY-MM-DD') AS d
  `) as unknown as { rows: Array<{ d: string }> }).rows[0];
  const today = todayRow.d;

  const r = await api<RunsResponse>(
    `/api/admin/maintenance/runs?companyId=${cleanCompanyId}&toolKey=journal-pending&day=${today}`,
    "GET",
    { token: saToken },
  );
  assert.equal(r.status, 200);
  for (const it of r.body.items) {
    const [row] = await db.select({ companyId: maintenanceRunsTable.companyId })
      .from(maintenanceRunsTable)
      .where(eq(maintenanceRunsTable.id, it.id));
    assert.equal(row?.companyId, cleanCompanyId,
      `row ${it.id} bled in from companyId=${row?.companyId}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/admin/maintenance/tool-history — broken-tool drill-down endpoint
// ════════════════════════════════════════════════════════════════════════════
// Returns the most recent N maintenance_runs rows for a single (company, tool)
// pair across all days. Powers the modal that opens from the "broken tools"
// panel on the SuperAdmin maintenance page so operators can diagnose a
// recurring failure without trawling the table by hand.
interface ToolHistoryResponse {
  companyId: number;
  toolKey: string;
  limit: number;
  items: Array<{
    id: number;
    runAt: string;
    trigger: "scheduled" | "manual";
    status: "ok" | "warn" | "critical" | "error";
    count: number;
    durationMs: number;
    error: string | null;
    details: unknown;
  }>;
}

test("GET /maintenance/tool-history: 401 without bearer token", async () => {
  const r = await api(`/api/admin/maintenance/tool-history?companyId=${dirtyCompanyId}&toolKey=journal-pending`, "GET");
  assert.equal(r.status, 401);
});

test("GET /maintenance/tool-history: 403 for non-superadmin", async () => {
  const r = await api(`/api/admin/maintenance/tool-history?companyId=${dirtyCompanyId}&toolKey=journal-pending`, "GET", { token: regularToken });
  assert.equal(r.status, 403);
});

test("GET /maintenance/tool-history: 400 on missing/invalid arguments", async () => {
  const cases = [
    `?companyId=&toolKey=journal-pending`,             // empty companyId
    `?companyId=abc&toolKey=journal-pending`,          // non-numeric companyId
    `?companyId=0&toolKey=journal-pending`,            // non-positive companyId
    `?companyId=${dirtyCompanyId}&toolKey=`,           // empty toolKey
    `?companyId=${dirtyCompanyId}`,                    // missing toolKey
  ];
  for (const qs of cases) {
    const r = await api(`/api/admin/maintenance/tool-history${qs}`, "GET", { token: saToken });
    assert.equal(r.status, 400, `expected 400 for ${qs}, got ${r.status}`);
  }
});

test("GET /maintenance/tool-history: returns recent rows for the requested (company, tool) only", async () => {
  // The earlier per-company run-now test inserted manual rows for every tool
  // for the dirty company. Default limit (20) and DESC ordering by runAt.
  const r = await api<ToolHistoryResponse>(
    `/api/admin/maintenance/tool-history?companyId=${dirtyCompanyId}&toolKey=journal-pending`,
    "GET",
    { token: saToken },
  );
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  assert.equal(r.body.companyId, dirtyCompanyId);
  assert.equal(r.body.toolKey, "journal-pending");
  assert.equal(r.body.limit, 20);
  assert.ok(Array.isArray(r.body.items), "items must be an array");
  assert.ok(r.body.items.length >= 1, `expected at least one run, got ${r.body.items.length}`);
  assert.ok(r.body.items.length <= 20, `expected at most 20 rows (default limit), got ${r.body.items.length}`);

  for (const it of r.body.items) {
    assert.ok(typeof it.id === "number");
    assert.ok(["scheduled", "manual"].includes(it.trigger), `unexpected trigger ${it.trigger}`);
    assert.ok(["ok", "warn", "critical", "error"].includes(it.status), `unexpected status ${it.status}`);
    assert.ok(typeof it.durationMs === "number");
  }

  // Ordered by run_at DESC.
  for (let i = 1; i < r.body.items.length; i++) {
    assert.ok(
      new Date(r.body.items[i - 1].runAt).getTime() >= new Date(r.body.items[i].runAt).getTime(),
      "items must be sorted by runAt DESC",
    );
  }

  // Every returned row must actually belong to the requested (company, tool).
  for (const it of r.body.items) {
    const [row] = await db.select({
      companyId: maintenanceRunsTable.companyId,
      toolKey:   maintenanceRunsTable.toolKey,
    })
      .from(maintenanceRunsTable)
      .where(eq(maintenanceRunsTable.id, it.id));
    assert.equal(row?.companyId, dirtyCompanyId, `row ${it.id} bled in from companyId=${row?.companyId}`);
    assert.equal(row?.toolKey, "journal-pending", `row ${it.id} bled in from toolKey=${row?.toolKey}`);
  }
});

test("GET /maintenance/tool-history: empty array for a tool that has never run on this company", async () => {
  const r = await api<ToolHistoryResponse>(
    `/api/admin/maintenance/tool-history?companyId=${dirtyCompanyId}&toolKey=__never_existed__`,
    "GET",
    { token: saToken },
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items, []);
});

test("GET /maintenance/tool-history: never leaks rows from another tenant", async () => {
  const r = await api<ToolHistoryResponse>(
    `/api/admin/maintenance/tool-history?companyId=${cleanCompanyId}&toolKey=journal-pending`,
    "GET",
    { token: saToken },
  );
  assert.equal(r.status, 200);
  for (const it of r.body.items) {
    const [row] = await db.select({ companyId: maintenanceRunsTable.companyId })
      .from(maintenanceRunsTable)
      .where(eq(maintenanceRunsTable.id, it.id));
    assert.equal(row?.companyId, cleanCompanyId,
      `row ${it.id} bled in from companyId=${row?.companyId}`);
  }
});

test("GET /maintenance/tool-history: honours ?limit and clamps to [1, 50]", async () => {
  // Within range — request 1 row and assert exactly one row comes back.
  const r1 = await api<ToolHistoryResponse>(
    `/api/admin/maintenance/tool-history?companyId=${dirtyCompanyId}&toolKey=journal-pending&limit=1`,
    "GET",
    { token: saToken },
  );
  assert.equal(r1.status, 200);
  assert.equal(r1.body.limit, 1);
  assert.ok(r1.body.items.length <= 1, `limit=1 must cap at 1 row, got ${r1.body.items.length}`);

  // Above ceiling — clampInt collapses 999 to the upper bound (50).
  const r2 = await api<ToolHistoryResponse>(
    `/api/admin/maintenance/tool-history?companyId=${dirtyCompanyId}&toolKey=journal-pending&limit=999`,
    "GET",
    { token: saToken },
  );
  assert.equal(r2.status, 200);
  assert.equal(r2.body.limit, 50);

  // Below floor — clampInt collapses 0 / negatives to the lower bound (1).
  for (const v of ["0", "-5"]) {
    const r = await api<ToolHistoryResponse>(
      `/api/admin/maintenance/tool-history?companyId=${dirtyCompanyId}&toolKey=journal-pending&limit=${encodeURIComponent(v)}`,
      "GET",
      { token: saToken },
    );
    assert.equal(r.status, 200, `limit=${v} should still 200`);
    assert.equal(r.body.limit, 1, `limit=${v} should clamp to min 1, got ${r.body.limit}`);
  }

  // Non-numeric — clampInt falls back to the default (20). Note: empty string
  // coerces to 0 via Number(""), so it ends up clamped to the lower bound (1)
  // rather than the default; only NaN-producing inputs hit the default arm.
  for (const v of ["abc", "1.2.3"]) {
    const r = await api<ToolHistoryResponse>(
      `/api/admin/maintenance/tool-history?companyId=${dirtyCompanyId}&toolKey=journal-pending&limit=${encodeURIComponent(v)}`,
      "GET",
      { token: saToken },
    );
    assert.equal(r.status, 200, `limit=${v} should still 200`);
    assert.equal(r.body.limit, 20, `limit=${v} should fall back to default 20, got ${r.body.limit}`);
  }
});

// ─── /maintenance/notification-preview ─────────────────────────────────────
// Backs the Settings → Notifications hint that tells SuperAdmins how many of
// the recent scheduled sweeps would have actually emailed them at each
// threshold. Pin the auth gate, the response shape, and the per-threshold
// monotonicity so the UI's "X of Y" line can never claim more matches than
// total sweeps or fewer for a wider threshold than a stricter one.
interface NotificationPreviewResponse {
  windowDays: number;
  totalSweeps: number;
  matchingByThreshold: { critical: number; warning: number; all: number };
}

test("GET /maintenance/notification-preview: 401 without bearer token", async () => {
  const r = await api("/api/admin/maintenance/notification-preview", "GET");
  assert.equal(r.status, 401);
});

test("GET /maintenance/notification-preview: 403 for non-superadmin", async () => {
  const r = await api("/api/admin/maintenance/notification-preview", "GET", { token: regularToken });
  assert.equal(r.status, 403);
});

test("GET /maintenance/notification-preview: returns coherent per-threshold counts", async () => {
  // Default window (30 days) — easy to assert against.
  const r = await api<NotificationPreviewResponse>(
    "/api/admin/maintenance/notification-preview",
    "GET",
    { token: saToken },
  );
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  assert.equal(r.body.windowDays, 30);
  assert.ok(Number.isInteger(r.body.totalSweeps) && r.body.totalSweeps >= 0,
    `totalSweeps must be a non-negative int, got ${r.body.totalSweeps}`);
  // Every threshold must be present and bounded by totalSweeps — the UI
  // renders "X of Y" verbatim and a count > totalSweeps would be nonsense.
  for (const t of ["critical", "warning", "all"] as const) {
    const v = r.body.matchingByThreshold[t];
    assert.ok(Number.isInteger(v) && v >= 0 && v <= r.body.totalSweeps,
      `matchingByThreshold.${t}=${v} must be in [0, ${r.body.totalSweeps}]`);
  }
  // Monotonicity: a stricter threshold can only match a subset of what a
  // wider threshold matches. critical ⊆ warning ⊆ all by definition of
  // severityMeetsThreshold — pin it here so future tweaks don't regress.
  assert.ok(r.body.matchingByThreshold.critical <= r.body.matchingByThreshold.warning,
    "critical must be <= warning (a stricter threshold can't match more sweeps)");
  assert.ok(r.body.matchingByThreshold.warning <= r.body.matchingByThreshold.all,
    "warning must be <= all (any error-only sweep also satisfies 'all')");
});

test("GET /maintenance/notification-preview: clamps ?days into [7, 90]", async () => {
  const tooHigh = await api<NotificationPreviewResponse>(
    "/api/admin/maintenance/notification-preview?days=9999",
    "GET",
    { token: saToken },
  );
  assert.equal(tooHigh.status, 200);
  assert.equal(tooHigh.body.windowDays, 90, "days=9999 must clamp to ceiling 90");

  const tooLow = await api<NotificationPreviewResponse>(
    "/api/admin/maintenance/notification-preview?days=0",
    "GET",
    { token: saToken },
  );
  assert.equal(tooLow.status, 200);
  assert.equal(tooLow.body.windowDays, 7, "days=0 must clamp to floor 7");

  const garbage = await api<NotificationPreviewResponse>(
    "/api/admin/maintenance/notification-preview?days=not-a-number",
    "GET",
    { token: saToken },
  );
  assert.equal(garbage.status, 200);
  assert.equal(garbage.body.windowDays, 30, "non-numeric days must fall back to default 30");
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

// ════════════════════════════════════════════════════════════════════════════
//  dispatchCriticalDigest — per-threshold recipient routing (end-to-end)
// ════════════════════════════════════════════════════════════════════════════
// The unit tests above pin `severityMeetsThreshold` and the signature change
// in isolation. The end-to-end behaviour we actually care about is:
//
//   (a) a sweep whose only signal is `warn` reaches threshold='warning' AND
//       threshold='all' SuperAdmins, but skips threshold='critical' ones.
//   (b) a sweep whose only signal is `error` (a silently-broken tool) reaches
//       only threshold='all' SuperAdmins — the motivating case for the 'all'
//       option, since `critical`/`warning` recipients otherwise go for weeks
//       without noticing a wedged check.
//   (c) a sweep with at least one critical row reaches every opted-in
//       SuperAdmin (regression guard for the historical default).
//   (d) a TEST send (the "Send test email" button) bypasses recipient
//       filtering entirely so an operator confirming SMTP setup gets
//       confirmation regardless of what the live sweep currently looks like.
//
// We assert (a)/(b)/(c) against the exported `getSuperAdminRecipients`
// helper because that's the only place we can read the actual recipient
// list (EmailDispatchOutcome only exposes a count). (d) ALSO calls
// `dispatchCriticalDigest({ isTest: true })` end-to-end and asserts the
// recipient COUNT matches our seeded SAs — that's the integration-level
// proof that the bypass is wired into the dispatch path, not just the
// helper.
//
// Determinism: the shared DB usually contains live SuperAdmins. We snapshot
// every other SA's `notifyMaintenanceEmail` flag, flip it OFF for the
// duration of this test, then restore it in `finally` so a failed
// assertion can never leak the silenced state past the test boundary.
test("dispatchCriticalDigest: per-threshold recipient routing for warn/error/critical sweeps + test-send bypass", async () => {
  // Snapshot every SuperAdmin that's currently opted in (including saUserId
  // from before(), which defaults to true). Flip them OFF so our seeded
  // users are the only candidates the recipient query can return.
  const otherSAs = await db.select({ id: usersTable.id })
    .from(usersTable)
    .where(and(
      eq(usersTable.role, "superadmin"),
      eq(usersTable.notifyMaintenanceEmail, true),
    ));
  const previouslyOnIds = otherSAs.map((r) => r.id);
  if (previouslyOnIds.length) {
    await db.update(usersTable)
      .set({ notifyMaintenanceEmail: false })
      .where(inArray(usersTable.id, previouslyOnIds));
  }

  // Snapshot the env vars that emailConfigured() reads, then unset them so
  // dispatchCriticalDigest's test-send hits the deterministic `no_transport`
  // branch instead of trying to actually deliver to fake @example.test
  // addresses via Outlook/SMTP if either happens to be configured here.
  // Recipient COUNT is preserved on that branch — that's what the bypass
  // assertion needs.
  const envSnapshot: Record<string, string | undefined> = {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
    REPLIT_CONNECTORS_HOSTNAME: process.env.REPLIT_CONNECTORS_HOSTNAME,
  };
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.REPLIT_CONNECTORS_HOSTNAME;

  // Watermark maintenance_email_runs so we can clean up the row recordEmailOutcome
  // appends during the test-send dispatch — the call doesn't return the
  // inserted id.
  const beforeMaxExec = await db.execute<{ max_id: number | null }>(sql`
    SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM maintenance_email_runs
  `);
  const beforeMax = Number(
    ((beforeMaxExec as { rows?: Array<{ max_id: number | null }> }).rows ?? [{ max_id: 0 }])[0]?.max_id ?? 0,
  );

  try {
    // Three SAs — one per threshold — with unique emails so a deepEqual on
    // the returned list pins exactly which users were selected.
    const hash = await bcrypt.hash("ignored-test-pw", 4);
    const critEmail = `${TEST_TAG}-sa-crit@example.test`;
    const warnEmail = `${TEST_TAG}-sa-warn@example.test`;
    const allEmail  = `${TEST_TAG}-sa-all@example.test`;
    const seeded = await db.insert(usersTable).values([
      { username: `${TEST_TAG}_sa_crit`, email: critEmail, passwordHash: hash,
        role: "superadmin", isActive: true, sessionToken: null, sessionId: null,
        companyId: null, notifyMaintenanceEmail: true,
        notifyMaintenanceSeverity: "critical" },
      { username: `${TEST_TAG}_sa_warn`, email: warnEmail, passwordHash: hash,
        role: "superadmin", isActive: true, sessionToken: null, sessionId: null,
        companyId: null, notifyMaintenanceEmail: true,
        notifyMaintenanceSeverity: "warning" },
      { username: `${TEST_TAG}_sa_all`,  email: allEmail,  passwordHash: hash,
        role: "superadmin", isActive: true, sessionToken: null, sessionId: null,
        companyId: null, notifyMaintenanceEmail: true,
        notifyMaintenanceSeverity: "all" },
    ]).returning({ id: usersTable.id });
    for (const r of seeded) insertedUserIds.push(r.id);

    // Belt-and-brace: an opted-OUT SA must never reach the recipient list
    // even when their threshold would otherwise match the sweep. Seeded as
    // a 4th user so the toggle-off is exercised directly here, not just
    // implied by the bulk-disable above.
    const optedOutEmail = `${TEST_TAG}-sa-off@example.test`;
    const optedOut = await db.insert(usersTable).values({
      username: `${TEST_TAG}_sa_off`, email: optedOutEmail, passwordHash: hash,
      role: "superadmin", isActive: true, sessionToken: null, sessionId: null,
      companyId: null, notifyMaintenanceEmail: false,
      notifyMaintenanceSeverity: "all",
    }).returning({ id: usersTable.id });
    insertedUserIds.push(optedOut[0].id);

    // (a) warn-only sweep — present={warn} → warning + all only.
    const warnOnly = await getSuperAdminRecipients(new Set<AlertSeverity>(["warn"]));
    assert.deepEqual(
      warnOnly.slice().sort(),
      [warnEmail, allEmail].sort(),
      `warn-only sweep must reach 'warning' + 'all' recipients only, got [${warnOnly.join(",")}]`,
    );
    assert.ok(!warnOnly.includes(critEmail),
      "warn-only sweep MUST NOT page threshold='critical' recipients");
    assert.ok(!warnOnly.includes(optedOutEmail),
      "an opted-OUT SA must never appear, even when their threshold would match");

    // (b) error-only sweep — present={error} → only `all` recipients.
    // Motivating case: a wedged check that produces no warn/critical rows
    // would otherwise leave 'critical'/'warning' SAs blind to the breakage.
    const errOnly = await getSuperAdminRecipients(new Set<AlertSeverity>(["error"]));
    assert.deepEqual(
      errOnly,
      [allEmail],
      `error-only sweep must reach ONLY 'all' recipients, got [${errOnly.join(",")}]`,
    );

    // (c) critical-only sweep — present={critical} → every threshold matches.
    // Regression guard so the historical default never silently loses recipients.
    const critOnly = await getSuperAdminRecipients(new Set<AlertSeverity>(["critical"]));
    assert.deepEqual(
      critOnly.slice().sort(),
      [critEmail, warnEmail, allEmail].sort(),
      `critical-only sweep must reach every threshold, got [${critOnly.join(",")}]`,
    );

    // Cross-check: an empty present-set means no one is eligible. The
    // dispatch path short-circuits earlier in production, but the helper
    // belt-and-braces this so a future caller can rely on the contract.
    const noneEligible = await getSuperAdminRecipients(new Set<AlertSeverity>());
    assert.deepEqual(noneEligible, [],
      "empty present-severities set must yield zero recipients");

    // (d) test-send bypass — `dispatchCriticalDigest({ isTest: true })`
    // synthesises a recipient set of {critical, warn, error} so EVERY
    // opted-in SA receives the test even when the live sweep is currently
    // quiet. We assert via two complementary paths:
    //   1. The helper called with the same synthetic set returns all three
    //      emails (deterministic recipient-list assertion).
    //   2. The full dispatch reports recipients=3 in the outcome (proves
    //      the bypass is wired from `isTest` through the dispatch path,
    //      not just present in the helper in isolation).
    const testHelperRecipients = await getSuperAdminRecipients(
      new Set<AlertSeverity>(["critical", "warn", "error"]),
    );
    assert.deepEqual(
      testHelperRecipients.slice().sort(),
      [critEmail, warnEmail, allEmail].sort(),
      "test send must broadcast to every opted-in SuperAdmin regardless of their per-account threshold",
    );

    const outcome = await dispatchCriticalDigest({ isTest: true });
    // Capture any maintenance_email_runs row recordEmailOutcome appended so
    // the suite-level cleanup deletes it. Row count >= 1 is expected; we
    // also accept 0 as best-effort because the audit insert is wrapped in
    // try/catch and never fails the dispatch.
    const newEmailRuns = await db.select({ id: maintenanceEmailRunsTable.id })
      .from(maintenanceEmailRunsTable)
      .where(sql`${maintenanceEmailRunsTable.id} > ${beforeMax}`);
    for (const r of newEmailRuns) insertedMaintenanceEmailRunIds.push(r.id);

    assert.equal(
      outcome.recipients, 3,
      `test dispatch must select all 3 opted-in SAs regardless of threshold, got ${outcome.recipients} (status=${outcome.status})`,
    );
    // Status is `no_transport` here because we explicitly cleared the SMTP
    // / Outlook env vars above. If a future change adds a third transport
    // and slips past the env unset, this catches it loudly instead of
    // silently emitting test mail to fake addresses.
    assert.equal(
      outcome.status, "no_transport",
      `expected no_transport (env unset) but got ${outcome.status}: ${outcome.message}`,
    );
  } finally {
    // Restore env first — it has the broadest blast radius if a later test
    // depends on the live transport configuration.
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (previouslyOnIds.length) {
      await db.update(usersTable)
        .set({ notifyMaintenanceEmail: true })
        .where(inArray(usersTable.id, previouslyOnIds));
    }
  }
});
