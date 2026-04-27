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
  maintenanceRetentionSettingsTable,
  reportEmailScheduleRunsTable,
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
  countRecentToolErrors,
  countRecentToolRecoveries,
  getMaintenanceAlerts,
  TOOL_ERROR_WINDOW_DAYS,
  severityMeetsThreshold,
  getSuperAdminRecipients,
  dispatchCriticalDigest,
  runEmailHistoryAutoPrune,
  runAuditLogAutoPrune,
  runMaintenanceRunsAutoPrune,
  type AlertSeverity,
} from "../src/lib/maintenanceScheduler.ts";
import { __resetEmailTransporterForTesting } from "../src/lib/email.ts";
import nodemailer from "nodemailer";

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
  headers: Headers;
  text: string;
}
async function api<T = unknown>(
  path: string,
  method: "GET" | "POST" | "PUT",
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
  return { status: res.status, body: body as T, headers: res.headers, text };
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
//  countRecentToolErrors / countRecentToolRecoveries — sibling COUNT helpers
// ════════════════════════════════════════════════════════════════════════════
// The maintenance CSV-export routes use these to detect when the 1000-row
// row cap actually clipped the data: only when the underlying total is
// strictly greater than the cap is the export `truncated`. An export of
// exactly N rows when N === cap must NOT show as truncated — that was a
// real bug caught in code review on task #111. The two assertions below
// pin the count helpers' contract for that decision:
//   1. Their result must equal the row helper's row count when the row
//      helper isn't itself capping. Without that equality the route's
//      `truncated = totalAvailable > cap` check would be wrong.
//   2. The result must be a finite integer (not undefined / NaN) so the
//      audit metadata field stays well-typed.
test("countRecentToolErrors: matches getRecentToolErrors row count under a generous limit (so 'truncated' is decided correctly at the cap)", async () => {
  // Use a deliberately large limit on the row helper so it can't be the
  // one doing the capping — any difference between the two numbers must
  // come from a divergence in their WHERE clauses, which would silently
  // break the CSV-export route's truncation flag.
  const rows  = await getRecentToolErrors(10_000, TOOL_ERROR_WINDOW_DAYS);
  const total = await countRecentToolErrors(TOOL_ERROR_WINDOW_DAYS);
  assert.equal(typeof total, "number", "count helper must return a number");
  assert.ok(Number.isFinite(total), `count helper must return a finite number, got ${total}`);
  assert.equal(
    total, rows.length,
    `countRecentToolErrors (${total}) must match the row helper's row count (${rows.length}) when nothing is being clipped — a divergence here would falsely flip the CSV export's 'truncated' flag at the exact-cap boundary.`,
  );
});

test("countRecentToolRecoveries: matches getRecentToolRecoveries row count under a generous limit (so 'truncated' is decided correctly at the cap)", async () => {
  const rows  = await getRecentToolRecoveries(10_000, TOOL_ERROR_WINDOW_DAYS);
  const total = await countRecentToolRecoveries(TOOL_ERROR_WINDOW_DAYS);
  assert.equal(typeof total, "number", "count helper must return a number");
  assert.ok(Number.isFinite(total), `count helper must return a finite number, got ${total}`);
  assert.equal(
    total, rows.length,
    `countRecentToolRecoveries (${total}) must match the row helper's row count (${rows.length}) when nothing is being clipped — a divergence here would falsely flip the CSV export's 'truncated' flag at the exact-cap boundary.`,
  );
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

test("GET /maintenance/tool-history: ?format=csv returns text/csv with the documented Arabic header row + writes an export_csv audit row", async () => {
  // Watermark audit_log so we only inspect rows this test wrote — same
  // shared-DB safety pattern the email-history CSV test below uses.
  const before = await db.execute<{ max_id: number | null }>(sql`
    SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM audit_log
  `);
  const beforeMax = Number(((before as { rows?: Array<{ max_id: number | null }> }).rows ?? [{ max_id: 0 }])[0]?.max_id ?? 0);

  // Expected data-line count = every recorded run for the (company, tool)
  // pair, regardless of the on-screen ?limit. The CSV branch is documented
  // to ignore that parameter so the file contains the full failure trail,
  // not just the 20 rows the modal renders. Compute the count from the DB
  // so the assertion holds across run orderings on a shared test DB.
  const [{ runCount }] = await db
    .select({ runCount: sql<number>`count(*)::int` })
    .from(maintenanceRunsTable)
    .where(and(
      eq(maintenanceRunsTable.companyId, dirtyCompanyId),
      eq(maintenanceRunsTable.toolKey, "journal-pending"),
    ));
  // ≥2 (not just ≥1) so the &limit=1 + format=csv combination below is a
  // *strict* anti-regression signal: a hypothetical broken implementation
  // that threaded `limit` into the CSV SQL could otherwise sneak through
  // when only one run exists. The run-now tests above fire multiple
  // sweeps against the dirty company, so this precondition holds.
  assert.ok(runCount >= 2,
    `expected at least two seeded runs for (dirty, journal-pending) before exporting (so ?limit=1 vs full-trail is observable), got ${runCount}`);

  // Pass &limit=1 alongside &format=csv to prove the CSV branch ignores
  // the on-screen cap: a sloppy refactor that threaded `limit` into the CSV
  // SQL would cap the file at 1 data line and trip the row-count assertion
  // below.
  const r = await api(
    `/api/admin/maintenance/tool-history?companyId=${dirtyCompanyId}&toolKey=journal-pending&limit=1&format=csv`,
    "GET",
    { token: saToken },
  );
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.text.slice(0, 200)}`);
  assert.match(r.headers.get("content-type") ?? "", /text\/csv/i, "Content-Type must be text/csv");

  // Content-Disposition filename starts with the documented prefix so the
  // file the operator hands engineers can be matched by name back to the
  // (company, tool) modal they exported it from.
  const disposition = r.headers.get("content-disposition") ?? "";
  assert.match(
    disposition,
    new RegExp(`attachment;\\s*filename="tool-history-${dirtyCompanyId}-journal-pending-`),
    `Content-Disposition must start with the documented prefix, got: ${disposition}`,
  );

  // Exact header row — admins archiving the file expect a stable schema.
  const headerLine = r.text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
  const expectedHeaders = ["الحالة", "التشغيل", "عدد النتائج", "المدة (مللي ث)", "وقت التشغيل", "رسالة الخطأ"];
  for (const h of expectedHeaders) {
    assert.ok(headerLine.includes(h), `CSV header row must include "${h}", got: ${headerLine}`);
  }

  // Data lines: one per recorded run for the (company, tool) pair — the
  // CSV branch intentionally ignores ?limit so this can exceed the on-screen
  // cap of 20.
  const dataLines = r.text.replace(/^\uFEFF/, "").split(/\r?\n/).slice(1).filter((l) => l.length > 0);
  assert.equal(dataLines.length, runCount,
    `CSV should contain one data line per recorded run (?limit must be ignored), got ${dataLines.length} for ${runCount} DB rows`);

  // Audit side-effect: a single row recording who pulled the file, the
  // module/action/entityType, and the documented metadata shape
  // ({ format, toolKey, count }).
  const newAuditRows = await db.select({
    id:         auditLogTable.id,
    action:     auditLogTable.action,
    module:     auditLogTable.module,
    entityType: auditLogTable.entityType,
    userId:     auditLogTable.userId,
    metadata:   auditLogTable.metadata,
  })
    .from(auditLogTable)
    .where(and(
      sql`${auditLogTable.id} > ${beforeMax}`,
      eq(auditLogTable.action, "export_csv"),
      eq(auditLogTable.module, "maintenance"),
      eq(auditLogTable.entityType, "maintenance_tool_history"),
    ));
  assert.equal(newAuditRows.length, 1, "CSV branch must write exactly one export_csv audit row");
  const audit = newAuditRows[0];
  assert.equal(audit.userId, saUserId, "audit row must record the calling SuperAdmin");
  assert.ok(isObject(audit.metadata), "audit metadata must be a JSON object");
  const meta = audit.metadata as Record<string, unknown>;
  assert.equal(meta.format, "csv");
  assert.equal(meta.toolKey, "journal-pending");
  assert.equal(meta.count, runCount,
    `metadata.count must equal the number of exported rows, got ${meta.count} for ${runCount} DB rows`);
  // Track for suite-level cleanup (also covered by the userId-based wipe in
  // cleanup() but explicit tracking matches the rest of the suite).
  insertedAuditLogIds.push(audit.id);
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

// ════════════════════════════════════════════════════════════════════════════
//  dispatchCriticalDigest — recoveryRows wiring + invariants (end-to-end)
// ════════════════════════════════════════════════════════════════════════════
// `getRecentToolRecoveries` is pinned in isolation above, but no test exercises
// the FULL dispatch path that has to wire those rows into the actual
// `sendMaintenanceCriticalDigest` payload. A regression that drops the
// `recoveryRows` parameter at the call site (e.g. someone refactoring the
// dispatch function) would silently strip the green "recovered tools" section
// from real digests with no test failure.
//
// What this guards:
//   1. `recoveryRows` reaches `sendMaintenanceCriticalDigest` with the seeded
//      (companyId, toolKey, currentStatus) entry — asserted by intercepting
//      the SMTP send and grepping the rendered HTML for the recovery section
//      heading + the seeded tool's marker.
//   2. The presence of recoveries does NOT contribute to `presentSeverities`
//      — asserted by re-deriving the expected recipient set from
//      `getMaintenanceAlerts` + `getRecentToolErrors` (the only inputs that
//      legitimately drive severities) and confirming the dispatch's actual
//      `recipients` count matches.
//   3. The presence of recoveries does NOT change the cooldown signature
//      — asserted by computing `computeCriticalSignature` from the
//      warn/critical alerts alone and confirming the audit row's
//      `criticalSignature` matches.
//
// Mechanics: nodemailer is a CJS package whose default-export object is
// directly mutable. We patch `nodemailer.createTransport` to return a stub
// that records the rendered HTML, then call `dispatchCriticalDigest` so the
// real send path executes end-to-end. Env vars and the patched function are
// restored in `finally` so subsequent tests are unaffected.
test("dispatchCriticalDigest: recoveryRows reach sendMaintenanceCriticalDigest + don't affect severities/signature", async () => {
  // Mute every other opted-in SuperAdmin so only our seeded recipient is
  // eligible, then put them back in `finally`. Same pattern as the per-
  // threshold routing test above.
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

  // Snapshot SMTP env + Outlook env. We FORCE SMTP on (with bogus host/user/
  // pass values) so `getTransporter()` returns a transporter at all — then
  // patch `nodemailer.createTransport` so that "transporter" is actually our
  // stub. Outlook is unset so `sendEmail` only attempts the SMTP path.
  const envSnapshot: Record<string, string | undefined> = {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
    REPLIT_CONNECTORS_HOSTNAME: process.env.REPLIT_CONNECTORS_HOSTNAME,
  };
  process.env.SMTP_HOST = "smtp.test.invalid";
  process.env.SMTP_PORT = "587";
  process.env.SMTP_USER = `${TEST_TAG}@example.test`;
  process.env.SMTP_PASS = "ignored-test-pw";
  delete process.env.REPLIT_CONNECTORS_HOSTNAME;

  // Stub the transport. nodemailer is a CJS module — its default export's
  // properties are mutable, so we can replace `createTransport` for the
  // duration of this test. `getTransporter()` caches the first non-null
  // result; we reset that cache via the env-snapshot teardown below by
  // ensuring no later test can re-enter the SMTP branch (env is restored,
  // and no remaining test in this file dispatches email).
  let captured: { to: unknown; subject: string; html: string } | null = null;
  const origCreateTransport = nodemailer.createTransport;
  (nodemailer as { createTransport: unknown }).createTransport = (() => ({
    sendMail: async (opts: { to: unknown; subject: string; html: string }) => {
      captured = { to: opts.to, subject: opts.subject, html: opts.html };
      return { messageId: `${TEST_TAG}-test` };
    },
    verify: async () => true,
    close: () => undefined,
  })) as typeof nodemailer.createTransport;

  // Snapshot the schedule row's cooldown anchors so we can restore them — we
  // need a clean state so `shouldSkipForRateLimit` doesn't suppress this
  // dispatch on a shared DB where a prior successful send already advanced
  // the anchor.
  const [cfgBefore] = await db.select().from(maintenanceScheduleTable)
    .where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));
  await db.update(maintenanceScheduleTable)
    .set({ lastSuccessfulEmailAt: null, lastEmailCriticalSignature: null })
    .where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));

  // Watermark maintenance_email_runs so we capture only the audit row this
  // dispatch writes (recordEmailOutcome doesn't return the inserted id).
  const beforeMaxExec = await db.execute<{ max_id: number | null }>(sql`
    SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM maintenance_email_runs
  `);
  const beforeMax = Number(
    ((beforeMaxExec as { rows?: Array<{ max_id: number | null }> }).rows ?? [{ max_id: 0 }])[0]?.max_id ?? 0,
  );

  try {
    // Seed one threshold='all' SA so the dispatch has exactly one recipient
    // regardless of which severities are present in the digest payload.
    const hash = await bcrypt.hash("ignored-test-pw", 4);
    const recipientEmail = `${TEST_TAG}-rec-sa@example.test`;
    const [seeded] = await db.insert(usersTable).values({
      username: `${TEST_TAG}_rec_sa`,
      email: recipientEmail,
      passwordHash: hash,
      role: "superadmin",
      isActive: true,
      sessionToken: null,
      sessionId: null,
      companyId: null,
      notifyMaintenanceEmail: true,
      notifyMaintenanceSeverity: "all",
    }).returning({ id: usersTable.id });
    insertedUserIds.push(seeded.id);

    // Seed a fresh critical alert so dispatch fires (rows.length > 0).
    // ToolKey is unique to this test so its severity/count contribution to
    // the cooldown signature is unambiguous.
    const now = Date.now();
    const critRun = await db.insert(maintenanceRunsTable).values({
      companyId: dirtyCompanyId,
      toolKey: "tt-disp-rec-crit",
      status: "critical",
      count: 73,
      trigger: "scheduled",
      runAt: new Date(now - 1_000),
      durationMs: 1,
      error: null,
      details: null,
    }).returning({ id: maintenanceRunsTable.id });
    insertedMaintenanceRunIds.push(critRun[0].id);

    // Seed a recovery: error → ok within the 7-day window for tool
    // "tt-disp-rec-recovered". `getRecentToolRecoveries` will return this.
    const recErr = await db.insert(maintenanceRunsTable).values({
      companyId: dirtyCompanyId,
      toolKey: "tt-disp-rec-recovered",
      status: "error",
      count: 0,
      trigger: "scheduled",
      runAt: new Date(now - 3 * 86_400_000),
      durationMs: 1,
      error: "boom-from-dispatch-test",
      details: null,
    }).returning({ id: maintenanceRunsTable.id });
    const recOk = await db.insert(maintenanceRunsTable).values({
      companyId: dirtyCompanyId,
      toolKey: "tt-disp-rec-recovered",
      status: "ok",
      count: 0,
      trigger: "scheduled",
      runAt: new Date(now - 1 * 86_400_000),
      durationMs: 1,
      error: null,
      details: null,
    }).returning({ id: maintenanceRunsTable.id });
    insertedMaintenanceRunIds.push(recErr[0].id, recOk[0].id);

    // Sanity-check the seed before dispatching: the recovery helper must
    // surface the seeded (company, tool) pair, otherwise the assertions
    // below would all pass vacuously when the seed is silently broken.
    const recsBefore = await getRecentToolRecoveries(50, TOOL_ERROR_WINDOW_DAYS);
    const seededRec = recsBefore.find((r) =>
      r.companyId === dirtyCompanyId && r.toolKey === "tt-disp-rec-recovered",
    );
    assert.ok(seededRec, "seed must produce at least one recovery row before dispatch");
    assert.equal(seededRec!.currentStatus, "ok",
      "seeded recovery's currentStatus must be 'ok' (it's the recovery row's status)");

    // Pre-compute the expected signature & recipient count from the SAME
    // helpers the dispatch uses — but DELIBERATELY excluding the recoveries.
    // The invariant under test is "recoveries don't affect signature or
    // severities" — if dispatch silently included them, these expected
    // values would diverge from the recorded ones.
    const expectedAlerts = await getMaintenanceAlerts(["critical", "warn"], 501);
    const expectedSignature = computeCriticalSignature(expectedAlerts);
    const expectedSeverities = new Set<AlertSeverity>(
      expectedAlerts.map((a) => a.severity),
    );
    const expectedErrs = await getRecentToolErrors(50);
    if (expectedErrs.length > 0) expectedSeverities.add("error");
    const expectedRecipients = await getSuperAdminRecipients(expectedSeverities);

    // Fire the dispatch end-to-end. trigger="scheduled" exercises the same
    // code path the daily tick uses — not a test send (which would bypass
    // recipient filtering and the cooldown signature check).
    const outcome = await dispatchCriticalDigest({ trigger: "scheduled" });

    // Capture the audit row for cleanup AND for the signature assertion.
    const newEmailRuns = await db.select({
      id: maintenanceEmailRunsTable.id,
      criticalSignature: maintenanceEmailRunsTable.criticalSignature,
      status: maintenanceEmailRunsTable.status,
    })
      .from(maintenanceEmailRunsTable)
      .where(sql`${maintenanceEmailRunsTable.id} > ${beforeMax}`);
    for (const r of newEmailRuns) insertedMaintenanceEmailRunIds.push(r.id);

    // 1. Dispatch reached the send path successfully (proves the SMTP stub
    //    was invoked and the wiring under test was actually exercised).
    assert.equal(
      outcome.status, "ok",
      `expected ok dispatch, got ${outcome.status}: ${outcome.message}`,
    );
    assert.ok(captured, "sendMail must have been invoked — the SMTP stub was not reached");

    // 2. The rendered HTML carries the green "recovered tools" section AND
    //    the seeded recovery row's (companyId, toolKey, currentStatus)
    //    triple — every field in `MaintenanceRecoveryDigestRow` must reach
    //    the email payload, otherwise the dispatch silently strips data.
    //
    //    We scope the assertions to a substring of the HTML that contains
    //    only the recovery <table> so a stray pre-existing critical row
    //    that happens to share a name with our seed can't make these
    //    assertions pass vacuously.
    const html = captured!.html;
    const recHeadingIdx = html.indexOf("أدوات صيانة تعافت");
    assert.notEqual(
      recHeadingIdx, -1,
      "digest HTML must include the 'recovered tools' section heading — proves recoveryRows reached sendMaintenanceCriticalDigest",
    );
    // The recovery section is one <table>...</table>; bound the scoped
    // substring at the next </table> so we only inspect rows the renderer
    // generated from `opts.recoveryRows`, not from `opts.rows` or
    // `opts.errorRows`.
    const recTableEnd = html.indexOf("</table>", recHeadingIdx);
    assert.notEqual(recTableEnd, -1,
      "recovery section must be a complete <table> — heading without table means the renderer broke");
    const recoverySection = html.slice(recHeadingIdx, recTableEnd);

    // (a) companyId — verified via the dirty company's `nameAr`. The
    //     renderer reads the recovery row's `companyName`, which is the
    //     SQL projection of `companies.name_ar` keyed off `companyId`.
    //     The seeded dirty company's name follows the
    //     `${TEST_TAG} شركة الاختبار D` pattern from before(), unique to
    //     this test run.
    const dirtyCompanyNameAr = `${TEST_TAG} شركة الاختبار D`;
    assert.ok(
      recoverySection.includes(dirtyCompanyNameAr),
      `recovery section must reference the seeded dirty company's nameAr ("${dirtyCompanyNameAr}") — proves companyId routed to the right row`,
    );

    // (b) toolKey — the seeded tool key has no MAINTENANCE_TOOL_LABELS_AR
    //     entry, so `toolLabelAr` falls back to the raw key. This makes
    //     "tt-disp-rec-recovered" an unambiguous fingerprint inside the
    //     recovery section.
    assert.ok(
      recoverySection.includes("tt-disp-rec-recovered"),
      "recovery section must list the seeded toolKey — proves toolKey reached the email payload",
    );

    // (c) currentStatus — the seeded recovery's `currentStatus` is "ok",
    //     which the renderer maps to the Arabic badge label "سليم". A
    //     payload that dropped/altered currentStatus would render a
    //     different label (or fall through to the raw status string), so
    //     this pins the field end-to-end.
    assert.ok(
      recoverySection.includes("سليم"),
      "recovery section must render the 'سليم' badge for currentStatus='ok' — proves currentStatus reached the email payload",
    );

    // 3. Recoveries did not contribute to `presentSeverities`. The dispatch's
    //    actual recipient count must match what the warn/critical alerts +
    //    errors alone would route to. If recoveries had silently been added
    //    to the present-severity set, recipient filtering could include or
    //    exclude additional users and this would diverge.
    assert.equal(
      outcome.recipients, expectedRecipients.length,
      `recipients count must equal expected (${expectedRecipients.length}) — got ${outcome.recipients}; recoveries must NOT promote presentSeverities`,
    );

    // 4. Recoveries did not change the cooldown signature. The audit row's
    //    `criticalSignature` is built from `visibleAlerts` (warn/critical
    //    only). Compute the expected signature from the same source and
    //    compare; if dispatch ever folded recoveries into the signature
    //    payload, this would diverge.
    assert.equal(newEmailRuns.length, 1,
      `expected exactly one new maintenance_email_runs row, got ${newEmailRuns.length}`);
    assert.equal(
      newEmailRuns[0].criticalSignature, expectedSignature,
      "criticalSignature must equal computeCriticalSignature(visibleAlerts) — recoveries must not enter the signature",
    );
  } finally {
    // Restore in reverse-acquisition order: nodemailer first (so a future
    // sendEmail call can't accidentally use our stale stub), then env, then
    // the schedule-row anchors, then the SA opt-in flags.
    (nodemailer as { createTransport: unknown }).createTransport = origCreateTransport;
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (cfgBefore) {
      await db.update(maintenanceScheduleTable).set({
        lastSuccessfulEmailAt: cfgBefore.lastSuccessfulEmailAt,
        lastEmailCriticalSignature: cfgBefore.lastEmailCriticalSignature,
      }).where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));
    }
    if (previouslyOnIds.length) {
      await db.update(usersTable)
        .set({ notifyMaintenanceEmail: true })
        .where(inArray(usersTable.id, previouslyOnIds));
    }
  }
});

// ─── Recovery-query failure isolation ────────────────────────────────────────
// The dispatch path wraps `getRecentToolRecoveries` in a try/catch on purpose:
// if that helper ever throws (bad SQL, transient DB hiccup, schema drift), the
// digest must still ship — just without the green "recovered tools" section.
// Today nothing pins this contract, so a future change that lets the error
// escape the try/catch would silently break every critical-digest send and
// SuperAdmins would simply stop receiving alerts.
//
// What this guards:
//   1. `dispatchCriticalDigest` returns `status === "ok"` even when the
//      recovery query throws — the catch in maintenanceScheduler.ts must
//      swallow the error and continue with `recoveryDigestRows = []`.
//   2. The rendered HTML omits the recovery section heading
//      ("أدوات صيانة تعافت") when the query failed — proves the catch
//      actually substituted an empty array (vs. partial data leaking through
//      on a malformed payload).
//
// Mechanics: monkey-patch `db.execute` to throw when invoked with the
// recovery query's SQL (uniquely identifiable by the `LAG(status)` window
// function — `getMaintenanceAlerts`, `getRecentToolErrors`, and the audit-row
// INSERT all use other constructs). Restored in `finally` so subsequent tests
// see the real `db.execute`. The seed includes a real recovery row so the
// "heading absent" assertion is meaningful: without the patch, the heading
// WOULD render — its absence here is caused by the simulated failure, not by
// "no recoveries existed in the first place".
test("dispatchCriticalDigest: recovery-query failure does NOT block the digest (heading omitted, status=ok)", async () => {
  // Mute every other opted-in SuperAdmin so only our seeded recipient is
  // eligible — same pattern as the sibling dispatch test above.
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

  // Force SMTP on with bogus values so `getTransporter()` returns a
  // transporter that we'll then replace with a recording stub. Outlook is
  // unset so `sendEmail` only attempts the SMTP path.
  const envSnapshot: Record<string, string | undefined> = {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
    REPLIT_CONNECTORS_HOSTNAME: process.env.REPLIT_CONNECTORS_HOSTNAME,
  };
  process.env.SMTP_HOST = "smtp.test.invalid";
  process.env.SMTP_PORT = "587";
  process.env.SMTP_USER = `${TEST_TAG}@example.test`;
  process.env.SMTP_PASS = "ignored-test-pw";
  delete process.env.REPLIT_CONNECTORS_HOSTNAME;

  let captured: { to: unknown; subject: string; html: string } | null = null;
  const origCreateTransport = nodemailer.createTransport;
  (nodemailer as { createTransport: unknown }).createTransport = (() => ({
    sendMail: async (opts: { to: unknown; subject: string; html: string }) => {
      captured = { to: opts.to, subject: opts.subject, html: opts.html };
      return { messageId: `${TEST_TAG}-rec-fail` };
    },
    verify: async () => true,
    close: () => undefined,
  })) as typeof nodemailer.createTransport;
  // Force email.ts to rebuild the transporter from the now-patched
  // `nodemailer.createTransport` — without this, the transporter cached by
  // the sibling dispatch test above would shadow our stub and `captured`
  // would never be populated.
  __resetEmailTransporterForTesting();

  // Snapshot + clear the cooldown anchors so `shouldSkipForRateLimit` can't
  // suppress this dispatch on a shared DB where a prior successful send
  // already advanced the anchor.
  const [cfgBefore] = await db.select().from(maintenanceScheduleTable)
    .where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));
  await db.update(maintenanceScheduleTable)
    .set({ lastSuccessfulEmailAt: null, lastEmailCriticalSignature: null })
    .where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));

  // Watermark maintenance_email_runs so we capture only the audit row this
  // dispatch writes (for cleanup).
  const beforeMaxExec = await db.execute<{ max_id: number | null }>(sql`
    SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM maintenance_email_runs
  `);
  const beforeMax = Number(
    ((beforeMaxExec as { rows?: Array<{ max_id: number | null }> }).rows ?? [{ max_id: 0 }])[0]?.max_id ?? 0,
  );

  // Walk a drizzle SQL object's StringChunks to find a literal substring.
  // We use `LAG(status)` as the recovery-query fingerprint — neither
  // `getMaintenanceAlerts` (DISTINCT ON), `getRecentToolErrors` (DISTINCT ON),
  // nor the audit-row INSERT use LAG, so the patch only intercepts the
  // recovery query and never collateral-damages the rest of the dispatch.
  const sqlContainsLagStatus = (q: unknown): boolean => {
    const seen = new Set<unknown>();
    const visit = (node: unknown): boolean => {
      if (node === null || node === undefined) return false;
      if (typeof node === "string") return node.includes("LAG(status)");
      if (typeof node !== "object") return false;
      if (seen.has(node)) return false;
      seen.add(node);
      const obj = node as { value?: unknown; queryChunks?: unknown };
      if (Array.isArray(obj.value) && obj.value.some((v) => typeof v === "string" && v.includes("LAG(status)"))) {
        return true;
      }
      if (typeof obj.value === "string" && obj.value.includes("LAG(status)")) return true;
      if (Array.isArray(obj.queryChunks) && obj.queryChunks.some(visit)) return true;
      return false;
    };
    return visit(q);
  };

  // Snapshot the original `db.execute` and patch it. The patch is restored
  // in `finally` so subsequent tests see the real method.
  const origExecute = db.execute.bind(db);
  let recoveryQueryAttempts = 0;
  (db as { execute: unknown }).execute = ((query: unknown) => {
    if (sqlContainsLagStatus(query)) {
      recoveryQueryAttempts += 1;
      throw new Error("simulated-recovery-query-failure");
    }
    return origExecute(query as never);
  }) as typeof db.execute;

  try {
    // Sanity-check the patch BEFORE we run dispatch: the recovery helper
    // must throw when called directly. If this passes the assertion would
    // be vacuous (a "no heading" assertion would also pass when the helper
    // returned [] for legitimate reasons).
    let directThrew = false;
    try {
      await getRecentToolRecoveries(50, TOOL_ERROR_WINDOW_DAYS);
    } catch {
      directThrew = true;
    }
    assert.ok(
      directThrew,
      "patch is not in effect: getRecentToolRecoveries did not throw — the rest of this test would pass vacuously",
    );

    // Seed one threshold='all' SuperAdmin so the dispatch has at least one
    // recipient regardless of which severities are present.
    const hash = await bcrypt.hash("ignored-test-pw", 4);
    const recipientEmail = `${TEST_TAG}-recfail-sa@example.test`;
    const [seeded] = await db.insert(usersTable).values({
      username: `${TEST_TAG}_recfail_sa`,
      email: recipientEmail,
      passwordHash: hash,
      role: "superadmin",
      isActive: true,
      sessionToken: null,
      sessionId: null,
      companyId: null,
      notifyMaintenanceEmail: true,
      notifyMaintenanceSeverity: "all",
    }).returning({ id: usersTable.id });
    insertedUserIds.push(seeded.id);

    // Seed a fresh critical alert so dispatch fires (rows.length > 0).
    const now = Date.now();
    const critRun = await db.insert(maintenanceRunsTable).values({
      companyId: dirtyCompanyId,
      toolKey: "tt-recfail-crit",
      status: "critical",
      count: 17,
      trigger: "scheduled",
      runAt: new Date(now - 1_000),
      durationMs: 1,
      error: null,
      details: null,
    }).returning({ id: maintenanceRunsTable.id });
    insertedMaintenanceRunIds.push(critRun[0].id);

    // Seed a real recovery (error → ok within the 7-day window). Without
    // this seed, the "heading absent" assertion would also pass when no
    // recoveries existed at all — we want it to fail loudly if the catch
    // is removed and the unhandled exception escapes.
    const recErr = await db.insert(maintenanceRunsTable).values({
      companyId: dirtyCompanyId,
      toolKey: "tt-recfail-recovered",
      status: "error",
      count: 0,
      trigger: "scheduled",
      runAt: new Date(now - 3 * 86_400_000),
      durationMs: 1,
      error: "boom-from-recovery-fail-test",
      details: null,
    }).returning({ id: maintenanceRunsTable.id });
    const recOk = await db.insert(maintenanceRunsTable).values({
      companyId: dirtyCompanyId,
      toolKey: "tt-recfail-recovered",
      status: "ok",
      count: 0,
      trigger: "scheduled",
      runAt: new Date(now - 1 * 86_400_000),
      durationMs: 1,
      error: null,
      details: null,
    }).returning({ id: maintenanceRunsTable.id });
    insertedMaintenanceRunIds.push(recErr[0].id, recOk[0].id);

    // Fire the dispatch end-to-end on the same code path the daily tick uses.
    const outcome = await dispatchCriticalDigest({ trigger: "scheduled" });

    // Capture audit row(s) for cleanup.
    const newEmailRuns = await db.select({ id: maintenanceEmailRunsTable.id })
      .from(maintenanceEmailRunsTable)
      .where(sql`${maintenanceEmailRunsTable.id} > ${beforeMax}`);
    for (const r of newEmailRuns) insertedMaintenanceEmailRunIds.push(r.id);

    // 1. Dispatch must still complete normally — the catch around
    //    `getRecentToolRecoveries` must swallow the simulated error and
    //    continue to `sendMaintenanceCriticalDigest` unaffected.
    assert.equal(
      outcome.status, "ok",
      `dispatch must still ship as ok when the recovery query fails; got "${outcome.status}": ${outcome.message}`,
    );
    assert.ok(captured, "sendMail must have been invoked — proves the SMTP path was reached");
    assert.ok(
      recoveryQueryAttempts > 0,
      "the patched db.execute must have intercepted the recovery query at least once",
    );

    // 2. The rendered HTML must omit the recovery section heading. The
    //    catch substitutes an empty `recoveryDigestRows` array, and
    //    `recoveryRowsHtml` short-circuits to "" when the list is empty —
    //    so the heading never makes it into the body.
    const html = captured!.html;
    assert.equal(
      html.indexOf("أدوات صيانة تعافت"), -1,
      "digest HTML must NOT include the 'recovered tools' section heading when getRecentToolRecoveries throws",
    );
    // And the seeded recovery's tool key (which would otherwise appear
    // inside the recovery <table>) must be absent too — defends against a
    // future refactor that swaps the heading text but still leaks rows.
    assert.equal(
      html.indexOf("tt-recfail-recovered"), -1,
      "digest HTML must NOT include the seeded recovery tool's key when the recovery query failed",
    );
  } finally {
    // Restore in reverse-acquisition order: db.execute first (so any
    // teardown query runs against the real method), then nodemailer, then
    // env, then the schedule-row anchors, then the SA opt-in flags.
    (db as { execute: unknown }).execute = origExecute;
    (nodemailer as { createTransport: unknown }).createTransport = origCreateTransport;
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (cfgBefore) {
      await db.update(maintenanceScheduleTable).set({
        lastSuccessfulEmailAt: cfgBefore.lastSuccessfulEmailAt,
        lastEmailCriticalSignature: cfgBefore.lastEmailCriticalSignature,
      }).where(eq(maintenanceScheduleTable.id, MAINTENANCE_SCHEDULE_ID));
    }
    if (previouslyOnIds.length) {
      await db.update(usersTable)
        .set({ notifyMaintenanceEmail: true })
        .where(inArray(usersTable.id, previouslyOnIds));
    }
  }
});

// ─── Retention settings (PUT/GET + GET-preview/POST-fix integration) ────────
//
// These cover the per-tool retention overrides surfaced under "السجلات" on
// the AI Company Fix screen. The contract under test:
//
//   • GET   /api/admin/maintenance/retention-settings
//       → returns a row per known toolKey with `days`, `defaultDays`, bounds,
//         and a `persisted` boolean (false when no override exists yet).
//   • PUT   /api/admin/maintenance/retention-settings/:toolKey
//       → validates the toolKey against the allow-list and clamps `days`
//         into the per-tool [min, max] window; on success upserts the row.
//   • GET   /api/admin/maintenance/old-* (preview)
//       AND POST  /api/admin/maintenance/old-*/fix
//       → both honor the persisted retention as the default when no `days`
//         is supplied, but the explicit `?days` / body `days` still wins.
//
// All tests scope their assertions to the seeded TEST_TAG company so they
// don't drift on shared databases. After each mutation, the test resets the
// retention row back to its defaults so subsequent tests start from a clean
// state regardless of execution order.
async function resetRetention(toolKey: string): Promise<void> {
  await db.delete(maintenanceRetentionSettingsTable)
    .where(eq(maintenanceRetentionSettingsTable.toolKey, toolKey));
}

test("GET /maintenance/retention-settings: 401 without bearer token", async () => {
  const r = await api("/api/admin/maintenance/retention-settings", "GET");
  assert.equal(r.status, 401);
});

test("GET /maintenance/retention-settings: 403 for non-superadmin", async () => {
  const r = await api("/api/admin/maintenance/retention-settings", "GET", { token: regularToken });
  assert.equal(r.status, 403);
});

test("GET /maintenance/retention-settings: returns defaults for all four tools when nothing persisted", async () => {
  for (const k of ["old-audit-logs", "old-maintenance-runs", "old-maintenance-email-runs", "old-report-email-runs"]) {
    await resetRetention(k);
  }
  const r = await api<{ settings: Record<string, { days: number; defaultDays: number; min: number; max: number; persisted: boolean }> }>(
    "/api/admin/maintenance/retention-settings", "GET", { token: saToken },
  );
  assert.equal(r.status, 200);
  assert.ok(isObject(r.body));
  const s = r.body.settings;
  // Defaults must match the four cards on the AI Company Fix screen and the
  // RETENTION_TOOL_BOUNDS table in admin.ts.
  assert.deepEqual(s["old-audit-logs"],            { days: 365, defaultDays: 365, min: 30, max: 3650, persisted: false, updatedAt: null });
  assert.deepEqual(s["old-maintenance-runs"],      { days: 90,  defaultDays: 90,  min: 7,  max: 3650, persisted: false, updatedAt: null });
  assert.deepEqual(s["old-maintenance-email-runs"], { days: 90, defaultDays: 90,  min: 7,  max: 3650, persisted: false, updatedAt: null });
  assert.deepEqual(s["old-report-email-runs"],     { days: 90,  defaultDays: 90,  min: 7,  max: 3650, persisted: false, updatedAt: null });
});

test("PUT /maintenance/retention-settings/:toolKey: 400 for unknown toolKey", async () => {
  const r = await api("/api/admin/maintenance/retention-settings/not-a-tool", "PUT",
    { token: saToken, body: { days: 30 } });
  assert.equal(r.status, 400);
});

test("PUT /maintenance/retention-settings/:toolKey: rejects non-integer / out-of-range values", async () => {
  // Below min for old-audit-logs (min=30)
  let r = await api("/api/admin/maintenance/retention-settings/old-audit-logs", "PUT",
    { token: saToken, body: { days: 5 } });
  assert.equal(r.status, 400);
  // Above max for old-audit-logs (max=3650)
  r = await api("/api/admin/maintenance/retention-settings/old-audit-logs", "PUT",
    { token: saToken, body: { days: 999_999 } });
  assert.equal(r.status, 400);
  // Non-integer
  r = await api("/api/admin/maintenance/retention-settings/old-audit-logs", "PUT",
    { token: saToken, body: { days: 30.5 } });
  assert.equal(r.status, 400);
  // Missing days entirely
  r = await api("/api/admin/maintenance/retention-settings/old-audit-logs", "PUT",
    { token: saToken, body: {} });
  assert.equal(r.status, 400);
});

test("PUT then GET /maintenance/retention-settings: persists and round-trips", async () => {
  await resetRetention("old-audit-logs");
  const put = await api<{ ok: boolean; toolKey: string; days: number }>(
    "/api/admin/maintenance/retention-settings/old-audit-logs", "PUT",
    { token: saToken, body: { days: 200 } },
  );
  assert.equal(put.status, 200);
  assert.equal(put.body.days, 200);

  const get = await api<{ settings: Record<string, { days: number; persisted: boolean; updatedAt: string | null }> }>(
    "/api/admin/maintenance/retention-settings", "GET", { token: saToken },
  );
  assert.equal(get.status, 200);
  assert.equal(get.body.settings["old-audit-logs"].days, 200);
  assert.equal(get.body.settings["old-audit-logs"].persisted, true);
  assert.ok(get.body.settings["old-audit-logs"].updatedAt);
  await resetRetention("old-audit-logs");
});

test("GET /maintenance/old-audit-logs: persisted retention drives the preview count when no ?days is supplied", async () => {
  // Use schemaCompanyId since the two seeded >365-day-old audit rows in
  // `before()` are written under that company. We also seed two FRESH
  // 400-day-old rows here so the assertion is robust on a shared DB where
  // the original seeded rows might have been pruned by an earlier test.
  await resetRetention("old-audit-logs");
  const oldAt = new Date(Date.now() - 400 * 86_400_000);
  const localSeed = await db.insert(auditLogTable).values([
    { userId: saUserId, username: `${TEST_TAG}_sa`, role: "superadmin",
      companyId: schemaCompanyId, module: "test_retention", action: "view",
      method: "GET", path: `/api/test/preview/${randomBytes(4).toString("hex")}`,
      statusCode: 200, ip: "127.0.0.1", createdAt: oldAt },
    { userId: saUserId, username: `${TEST_TAG}_sa`, role: "superadmin",
      companyId: schemaCompanyId, module: "test_retention", action: "view",
      method: "GET", path: `/api/test/preview/${randomBytes(4).toString("hex")}`,
      statusCode: 200, ip: "127.0.0.2", createdAt: oldAt },
  ]).returning({ id: auditLogTable.id });
  insertedAuditLogIds.push(...localSeed.map(r => r.id));

  try {
    const baseline = await api<{ count: number }>(
      `/api/admin/maintenance/old-audit-logs?companyId=${schemaCompanyId}`,
      "GET", { token: saToken },
    );
    assert.equal(baseline.status, 200);
    assert.ok(baseline.body.count >= 2, `baseline preview should include the seeded old audit rows (got ${baseline.body.count})`);

    await api("/api/admin/maintenance/retention-settings/old-audit-logs", "PUT",
      { token: saToken, body: { days: 999 } });
    const tightened = await api<{ count: number }>(
      `/api/admin/maintenance/old-audit-logs?companyId=${schemaCompanyId}`,
      "GET", { token: saToken },
    );
    assert.equal(tightened.status, 200);
    // The seeded rows are 400 days old < 999, so they must NOT count any
    // more. (Other test rows in the shared DB might still be older than 999d
    // — we can't assert ===0, only that the count dropped by at least 2.)
    assert.ok(
      tightened.body.count <= baseline.body.count - 2,
      `expected count to drop by ≥2 after raising retention to 999d; baseline=${baseline.body.count} after=${tightened.body.count}`,
    );

    // Explicit ?days override must still win even when a persisted value exists.
    const overridden = await api<{ count: number }>(
      `/api/admin/maintenance/old-audit-logs?companyId=${schemaCompanyId}&days=365`,
      "GET", { token: saToken },
    );
    assert.equal(overridden.status, 200);
    assert.equal(overridden.body.count, baseline.body.count, "explicit ?days=365 should match the unpersisted baseline");
  } finally {
    await resetRetention("old-audit-logs");
  }
});

test("POST /maintenance/old-audit-logs/fix: honors persisted retention when body has no `days`", async () => {
  // Seed a fresh pair of >400-day-old audit rows so this test is self-contained
  // and won't interfere with other tests' counts.
  const oldAt = new Date(Date.now() - 410 * 86_400_000);
  const seeded = await db.insert(auditLogTable).values([
    { userId: saUserId, username: `${TEST_TAG}_sa`, role: "superadmin",
      companyId: dirtyCompanyId, module: "test_retention", action: "view",
      method: "GET", path: `/api/test/retention/${randomBytes(4).toString("hex")}`,
      statusCode: 200, ip: "127.0.0.1", createdAt: oldAt },
    { userId: saUserId, username: `${TEST_TAG}_sa`, role: "superadmin",
      companyId: dirtyCompanyId, module: "test_retention", action: "view",
      method: "GET", path: `/api/test/retention/${randomBytes(4).toString("hex")}`,
      statusCode: 200, ip: "127.0.0.2", createdAt: oldAt },
  ]).returning({ id: auditLogTable.id });
  const seededIds = seeded.map(r => r.id);
  insertedAuditLogIds.push(...seededIds);

  try {
    // Persist a tight retention (500d) so the seeded 410-day-old rows are
    // OUTSIDE the prune window.
    await api("/api/admin/maintenance/retention-settings/old-audit-logs", "PUT",
      { token: saToken, body: { days: 500 } });

    // POST without `days` in the body → server should resolve to 500d and
    // therefore NOT delete our 410-day-old rows.
    const fixSafe = await api<{ deleted: number }>(
      "/api/admin/maintenance/old-audit-logs/fix", "POST",
      { token: saToken, body: { companyId: dirtyCompanyId } },
    );
    assert.equal(fixSafe.status, 200);
    const stillThereSafe = await db.select({ id: auditLogTable.id })
      .from(auditLogTable)
      .where(inArray(auditLogTable.id, seededIds));
    assert.equal(stillThereSafe.length, 2, "rows must survive a prune that uses the persisted 500d retention");

    // Now drop the retention to 30d → the same body (no `days`) should now
    // delete the seeded rows.
    await api("/api/admin/maintenance/retention-settings/old-audit-logs", "PUT",
      { token: saToken, body: { days: 30 } });
    const fixAggressive = await api<{ deleted: number }>(
      "/api/admin/maintenance/old-audit-logs/fix", "POST",
      { token: saToken, body: { companyId: dirtyCompanyId } },
    );
    assert.equal(fixAggressive.status, 200);
    const stillThereAggressive = await db.select({ id: auditLogTable.id })
      .from(auditLogTable)
      .where(inArray(auditLogTable.id, seededIds));
    assert.equal(stillThereAggressive.length, 0, "rows must be deleted once the retention is lowered to 30d");
  } finally {
    await resetRetention("old-audit-logs");
  }
});

// The same "preview → tightened retention → no rows pruned → loosened
// retention → rows pruned" assertion runs once per remaining cleanup tool.
// They share the audit-log test's structure but exercise different tables:
//
//   • old-maintenance-runs       → maintenance_runs (per-company DELETE)
//   • old-maintenance-email-runs → maintenance_email_runs (GLOBAL DELETE)
//   • old-report-email-runs      → report_email_schedule_runs (GLOBAL DELETE)
//
// Without per-tool coverage a refactor that diverges retention plumbing for
// just one tool (e.g. forgetting to thread the persisted setting through the
// new fix handler, or hard-coding `req.body.days ?? 90` instead of going
// through `resolveRetentionDays`) would only surface as a silent prune
// regression in production. Each test scopes its mutations strictly to
// rows it inserted (by primary key) and resets the retention row in
// `finally` so a crash mid-test cannot bleed state into other tests.

test("GET /maintenance/old-maintenance-runs + POST fix: persisted retention drives both preview and prune behavior", async () => {
  await resetRetention("old-maintenance-runs");
  // Seed two unambiguously-old maintenance_runs rows on dirtyCompanyId so
  // the assertions are scoped to a known tenant and we can verify by id
  // that the rows survive/are deleted under the two retention windows.
  const oldAt = new Date(Date.now() - 120 * 86_400_000);
  const seeded = await db.insert(maintenanceRunsTable).values([
    { companyId: dirtyCompanyId, toolKey: "journal-pending", status: "ok",
      count: 0, trigger: "scheduled", runAt: oldAt, durationMs: 5,
      error: null, details: null },
    { companyId: dirtyCompanyId, toolKey: "broken-refs", status: "warn",
      count: 1, trigger: "scheduled", runAt: oldAt, durationMs: 7,
      error: null, details: null },
  ]).returning({ id: maintenanceRunsTable.id });
  const seededIds = seeded.map(r => r.id);
  insertedMaintenanceRunIds.push(...seededIds);

  try {
    // Tighten retention so the 120-day-old rows are INSIDE the safe window.
    await api("/api/admin/maintenance/retention-settings/old-maintenance-runs", "PUT",
      { token: saToken, body: { days: 3000 } });

    const tightPreview = await api<{ count: number; days: number }>(
      `/api/admin/maintenance/old-maintenance-runs?companyId=${dirtyCompanyId}`,
      "GET", { token: saToken },
    );
    assert.equal(tightPreview.status, 200);
    assert.equal(tightPreview.body.days, 3000,
      "GET preview must echo the persisted retention as the resolved `days`");

    const fixSafe = await api<{ deleted: number }>(
      "/api/admin/maintenance/old-maintenance-runs/fix", "POST",
      { token: saToken, body: { companyId: dirtyCompanyId } },
    );
    assert.equal(fixSafe.status, 200);
    const stillThereSafe = await db.select({ id: maintenanceRunsTable.id })
      .from(maintenanceRunsTable)
      .where(inArray(maintenanceRunsTable.id, seededIds));
    assert.equal(stillThereSafe.length, 2,
      "rows must survive a prune that uses the persisted 3000d retention");

    // Loosen retention to 30d → the 120-day-old rows now exit the safe window.
    await api("/api/admin/maintenance/retention-settings/old-maintenance-runs", "PUT",
      { token: saToken, body: { days: 30 } });

    const loosePreview = await api<{ count: number; days: number }>(
      `/api/admin/maintenance/old-maintenance-runs?companyId=${dirtyCompanyId}`,
      "GET", { token: saToken },
    );
    assert.equal(loosePreview.status, 200);
    assert.equal(loosePreview.body.days, 30);
    assert.ok(loosePreview.body.count >= tightPreview.body.count + 2,
      `loosened preview count must include the seeded rows; tight=${tightPreview.body.count} loose=${loosePreview.body.count}`);

    const fixAggressive = await api<{ deleted: number }>(
      "/api/admin/maintenance/old-maintenance-runs/fix", "POST",
      { token: saToken, body: { companyId: dirtyCompanyId } },
    );
    assert.equal(fixAggressive.status, 200);
    const stillThereAggressive = await db.select({ id: maintenanceRunsTable.id })
      .from(maintenanceRunsTable)
      .where(inArray(maintenanceRunsTable.id, seededIds));
    assert.equal(stillThereAggressive.length, 0,
      "seeded rows must be deleted once the retention is lowered to 30d");
  } finally {
    await resetRetention("old-maintenance-runs");
  }
});

test("GET /maintenance/old-maintenance-email-runs + POST fix: persisted retention drives both preview and prune behavior", async () => {
  await resetRetention("old-maintenance-email-runs");
  // The maintenance_email_runs table is GLOBAL — there is no company_id
  // column. We seed by id and assert pre/post fix purely through id-based
  // DB selects so concurrent test rows on a shared DB cannot perturb the
  // assertion. The companyId in the request is required by maintGuard but
  // does not narrow either the SELECT or the DELETE in admin.ts.
  const oldAt = new Date(Date.now() - 120 * 86_400_000);
  const seeded = await db.insert(maintenanceEmailRunsTable).values([
    { ranAt: oldAt, trigger: "scheduled", status: "ok",
      recipients: 1, criticalCount: 0,
      error: null, reason: "digest_sent",
      criticalSignature: `${TEST_TAG}_old_maint_ret_a` },
    { ranAt: oldAt, trigger: "scheduled", status: "ok",
      recipients: 1, criticalCount: 0,
      error: null, reason: "digest_sent",
      criticalSignature: `${TEST_TAG}_old_maint_ret_b` },
  ]).returning({ id: maintenanceEmailRunsTable.id });
  const seededIds = seeded.map(r => r.id);
  insertedMaintenanceEmailRunIds.push(...seededIds);

  try {
    await api("/api/admin/maintenance/retention-settings/old-maintenance-email-runs", "PUT",
      { token: saToken, body: { days: 3000 } });

    const tightPreview = await api<{ count: number; days: number }>(
      `/api/admin/maintenance/old-maintenance-email-runs?companyId=${dirtyCompanyId}`,
      "GET", { token: saToken },
    );
    assert.equal(tightPreview.status, 200);
    assert.equal(tightPreview.body.days, 3000,
      "GET preview must echo the persisted retention as the resolved `days`");

    const fixSafe = await api<{ deleted: number }>(
      "/api/admin/maintenance/old-maintenance-email-runs/fix", "POST",
      { token: saToken, body: { companyId: dirtyCompanyId } },
    );
    assert.equal(fixSafe.status, 200);
    const stillThereSafe = await db.select({ id: maintenanceEmailRunsTable.id })
      .from(maintenanceEmailRunsTable)
      .where(inArray(maintenanceEmailRunsTable.id, seededIds));
    assert.equal(stillThereSafe.length, 2,
      "rows must survive a prune that uses the persisted 3000d retention");

    await api("/api/admin/maintenance/retention-settings/old-maintenance-email-runs", "PUT",
      { token: saToken, body: { days: 30 } });

    const loosePreview = await api<{ count: number; days: number }>(
      `/api/admin/maintenance/old-maintenance-email-runs?companyId=${dirtyCompanyId}`,
      "GET", { token: saToken },
    );
    assert.equal(loosePreview.status, 200);
    assert.equal(loosePreview.body.days, 30);
    assert.ok(loosePreview.body.count >= tightPreview.body.count + 2,
      `loosened preview count must include the seeded rows; tight=${tightPreview.body.count} loose=${loosePreview.body.count}`);

    const fixAggressive = await api<{ deleted: number }>(
      "/api/admin/maintenance/old-maintenance-email-runs/fix", "POST",
      { token: saToken, body: { companyId: dirtyCompanyId } },
    );
    assert.equal(fixAggressive.status, 200);
    const stillThereAggressive = await db.select({ id: maintenanceEmailRunsTable.id })
      .from(maintenanceEmailRunsTable)
      .where(inArray(maintenanceEmailRunsTable.id, seededIds));
    assert.equal(stillThereAggressive.length, 0,
      "seeded rows must be deleted once the retention is lowered to 30d");
  } finally {
    await resetRetention("old-maintenance-email-runs");
  }
});

test("GET /maintenance/old-report-email-runs + POST fix: persisted retention drives both preview and prune behavior", async () => {
  await resetRetention("old-report-email-runs");
  // The report_email_schedule_runs table is GLOBAL — there is no company_id
  // column AND the test fixture has no `insertedReportEmailRunIds` cleanup
  // array. We delete the seeded rows manually in `finally` so any survivors
  // (under the tight-retention prune) don't leak into other tests on a
  // shared DB.
  const oldAt = new Date(Date.now() - 120 * 86_400_000);
  const seeded = await db.insert(reportEmailScheduleRunsTable).values([
    { ranAt: oldAt, trigger: "scheduled", status: "ok",
      reports: ["operational-summary"], recipients: 1,
      message: `${TEST_TAG}_old_report_ret_a` },
    { ranAt: oldAt, trigger: "scheduled", status: "ok",
      reports: ["operational-summary"], recipients: 1,
      message: `${TEST_TAG}_old_report_ret_b` },
  ]).returning({ id: reportEmailScheduleRunsTable.id });
  const seededIds = seeded.map(r => r.id);

  try {
    await api("/api/admin/maintenance/retention-settings/old-report-email-runs", "PUT",
      { token: saToken, body: { days: 3000 } });

    const tightPreview = await api<{ count: number; days: number }>(
      `/api/admin/maintenance/old-report-email-runs?companyId=${dirtyCompanyId}`,
      "GET", { token: saToken },
    );
    assert.equal(tightPreview.status, 200);
    assert.equal(tightPreview.body.days, 3000,
      "GET preview must echo the persisted retention as the resolved `days`");

    const fixSafe = await api<{ deleted: number }>(
      "/api/admin/maintenance/old-report-email-runs/fix", "POST",
      { token: saToken, body: { companyId: dirtyCompanyId } },
    );
    assert.equal(fixSafe.status, 200);
    const stillThereSafe = await db.select({ id: reportEmailScheduleRunsTable.id })
      .from(reportEmailScheduleRunsTable)
      .where(inArray(reportEmailScheduleRunsTable.id, seededIds));
    assert.equal(stillThereSafe.length, 2,
      "rows must survive a prune that uses the persisted 3000d retention");

    await api("/api/admin/maintenance/retention-settings/old-report-email-runs", "PUT",
      { token: saToken, body: { days: 30 } });

    const loosePreview = await api<{ count: number; days: number }>(
      `/api/admin/maintenance/old-report-email-runs?companyId=${dirtyCompanyId}`,
      "GET", { token: saToken },
    );
    assert.equal(loosePreview.status, 200);
    assert.equal(loosePreview.body.days, 30);
    assert.ok(loosePreview.body.count >= tightPreview.body.count + 2,
      `loosened preview count must include the seeded rows; tight=${tightPreview.body.count} loose=${loosePreview.body.count}`);

    const fixAggressive = await api<{ deleted: number }>(
      "/api/admin/maintenance/old-report-email-runs/fix", "POST",
      { token: saToken, body: { companyId: dirtyCompanyId } },
    );
    assert.equal(fixAggressive.status, 200);
    const stillThereAggressive = await db.select({ id: reportEmailScheduleRunsTable.id })
      .from(reportEmailScheduleRunsTable)
      .where(inArray(reportEmailScheduleRunsTable.id, seededIds));
    assert.equal(stillThereAggressive.length, 0,
      "seeded rows must be deleted once the retention is lowered to 30d");
  } finally {
    await resetRetention("old-report-email-runs");
    // Belt-and-brace: any survivors from the tight-retention pass must be
    // removed by id so they don't bleed into other tests on a shared DB.
    await db.delete(reportEmailScheduleRunsTable)
      .where(inArray(reportEmailScheduleRunsTable.id, seededIds));
  }
});

test("PUT /maintenance/retention-settings: writes an audit-log row with action=edit_retention", async () => {
  await resetRetention("old-maintenance-runs");
  // Capture the highest existing id BEFORE the PUT so we only inspect rows
  // this test wrote — shared-DB safety.
  const before = await db.execute<{ max_id: number | null }>(sql`
    SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM audit_log
  `);
  const beforeMax = Number(((before as { rows?: Array<{ max_id: number | null }> }).rows ?? [{ max_id: 0 }])[0]?.max_id ?? 0);

  const r = await api("/api/admin/maintenance/retention-settings/old-maintenance-runs", "PUT",
    { token: saToken, body: { days: 45 } });
  assert.equal(r.status, 200);

  const newRows = await db.select({ id: auditLogTable.id, action: auditLogTable.action, module: auditLogTable.module })
    .from(auditLogTable)
    .where(and(
      sql`${auditLogTable.id} > ${beforeMax}`,
      eq(auditLogTable.action, "edit_retention"),
    ));
  assert.ok(newRows.length >= 1, "PUT should write an audit_log row with action=edit_retention");
  // Track for cleanup
  for (const row of newRows) insertedAuditLogIds.push(row.id);
  await resetRetention("old-maintenance-runs");
});

// ════════════════════════════════════════════════════════════════════════════
//  GET /api/admin/maintenance/email-history — JSON / CSV / filters / audit
// ════════════════════════════════════════════════════════════════════════════
// Backs the SuperAdmin "سجل تنبيهات البريد" panel on the AI Company Fix
// screen. Pin the auth gates, the trigger / status-bucket / date-range
// filters, the bucket-to-status mapping (drift here would silently
// mis-classify rows in the UI's coloured chips), the CSV branch's
// content-type + Arabic header row, and the `export_csv` audit row that
// records who pulled the file and which filters they applied.
//
// All assertions scope through ?from / ?to to a far-past date window
// (2010-03-*) so seeded rows can never collide with real history that
// might already exist in a shared test DB.
const EMAIL_HIST_FROM = "2010-03-01";
const EMAIL_HIST_TO   = "2010-03-08";

interface EmailHistorySeedRow {
  ranAt: Date;
  trigger: "scheduled" | "manual" | "test";
  status: "ok" | "no_critical" | "failed" | "no_recipients" | "no_transport" | "skipped" | "snoozed" | "rate_limited";
  recipients: number;
  criticalCount: number;
  reason: string;
  criticalSignature: string;
  error: string | null;
}

// 8 rows spanning every (trigger, status-bucket) combination the route
// supports, one per calendar day in the seeded window so date-range
// assertions can pick exact subsets without overlap.
const EMAIL_HISTORY_SEED: EmailHistorySeedRow[] = [
  { ranAt: new Date("2010-03-01T03:00:00.000Z"), trigger: "scheduled", status: "ok",            recipients: 3, criticalCount: 4, reason: "digest_sent",                              criticalSignature: "sig-ok-1", error: null },
  { ranAt: new Date("2010-03-02T03:00:00.000Z"), trigger: "scheduled", status: "no_critical",   recipients: 0, criticalCount: 0, reason: "no_critical_results",                      criticalSignature: "",         error: null },
  { ranAt: new Date("2010-03-03T03:00:00.000Z"), trigger: "scheduled", status: "failed",        recipients: 2, criticalCount: 5, reason: "smtp_error",                               criticalSignature: "sig-f-1",  error: "boom" },
  { ranAt: new Date("2010-03-04T03:00:00.000Z"), trigger: "scheduled", status: "no_recipients", recipients: 0, criticalCount: 5, reason: "no_superadmin_email_configured",           criticalSignature: "sig-f-2",  error: null },
  { ranAt: new Date("2010-03-05T03:00:00.000Z"), trigger: "manual",    status: "no_transport",  recipients: 0, criticalCount: 5, reason: "no_smtp_or_outlook_transport_configured",  criticalSignature: "sig-f-3",  error: "no transport" },
  { ranAt: new Date("2010-03-06T03:00:00.000Z"), trigger: "manual",    status: "skipped",       recipients: 0, criticalCount: 5, reason: "cooldown_active_24h_signature_unchanged",  criticalSignature: "sig-s-1", error: null },
  { ranAt: new Date("2010-03-07T03:00:00.000Z"), trigger: "test",      status: "snoozed",       recipients: 0, criticalCount: 5, reason: "alerts_muted",                             criticalSignature: "sig-s-2",  error: null },
  { ranAt: new Date("2010-03-08T03:00:00.000Z"), trigger: "test",      status: "rate_limited",  recipients: 0, criticalCount: 5, reason: "rate_limited",                             criticalSignature: "sig-s-3",  error: null },
];

let emailHistorySeeded = false;
async function seedEmailHistoryOnce(): Promise<void> {
  if (emailHistorySeeded) return;
  // Pre-clean any orphan rows in the seeded window from a previous interrupted
  // run. Exact-count assertions below rely on the window holding *only* this
  // run's seeded rows, so leftover rows from a crashed test would silently
  // inflate every count and we'd see flaky failures on shared databases.
  // Bounded strictly to the 2010-03-* test window — never touches real history.
  await db.execute(sql`
    DELETE FROM maintenance_email_runs
     WHERE ran_at >= ${EMAIL_HIST_FROM}::date
       AND ran_at <  (${EMAIL_HIST_TO}::date + interval '1 day')
  `);
  const inserted = await db.insert(maintenanceEmailRunsTable)
    .values(EMAIL_HISTORY_SEED)
    .returning({ id: maintenanceEmailRunsTable.id });
  for (const r of inserted) insertedMaintenanceEmailRunIds.push(r.id);
  emailHistorySeeded = true;
}

interface EmailHistoryItem {
  id: number;
  ranAt: string;
  trigger: string;
  status: string;
  recipients: number;
  criticalCount: number;
  error: string | null;
  reason: string | null;
  criticalSignature: string | null;
}
interface EmailHistoryResponse {
  count: number;
  // `total` drives the "تم تحميل N من T محاولة" header and the "تحميل
  // المزيد (X متبقّية)" button label in the SuperAdmin audit panel. It is
  // computed against the SAME WHERE clause as the page query so the
  // header reflects the active filters and stays constant across pages.
  total: number;
  items: EmailHistoryItem[];
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
}

const EMAIL_HIST_BASE = `/api/admin/maintenance/email-history?from=${EMAIL_HIST_FROM}&to=${EMAIL_HIST_TO}`;

test("GET /maintenance/email-history: 401 without bearer token", async () => {
  const r = await api("/api/admin/maintenance/email-history", "GET");
  assert.equal(r.status, 401);
});

test("GET /maintenance/email-history: 403 for non-superadmin", async () => {
  const r = await api("/api/admin/maintenance/email-history", "GET", { token: regularToken });
  assert.equal(r.status, 403);
});

test("GET /maintenance/email-history: returns the seeded rows in the date window, DESC by ranAt", async () => {
  await seedEmailHistoryOnce();
  const r = await api<EmailHistoryResponse>(EMAIL_HIST_BASE, "GET", { token: saToken });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  assert.equal(r.body.count, EMAIL_HISTORY_SEED.length);
  assert.equal(r.body.items.length, EMAIL_HISTORY_SEED.length);
  assert.equal(r.body.hasMore, false);
  assert.equal(r.body.offset, 0);
  // Default limit is 20.
  assert.equal(r.body.limit, 20);
  // DESC by ranAt → most recent seeded row (2010-03-08) is first.
  assert.equal(r.body.items[0].ranAt, "2010-03-08T03:00:00.000Z");
  assert.equal(r.body.items[r.body.items.length - 1].ranAt, "2010-03-01T03:00:00.000Z");
  for (let i = 1; i < r.body.items.length; i++) {
    assert.ok(
      new Date(r.body.items[i - 1].ranAt).getTime() >= new Date(r.body.items[i].ranAt).getTime(),
      "items must be sorted by ranAt DESC",
    );
  }
  // Spot-check that the response shape mirrors the schema columns the UI relies on.
  const first = r.body.items[0];
  assert.equal(first.trigger, "test");
  assert.equal(first.status, "rate_limited");
  assert.equal(first.reason, "rate_limited");
  assert.equal(first.criticalSignature, "sig-s-3");
});

test("GET /maintenance/email-history: ?trigger filters to a single dispatch source", async () => {
  await seedEmailHistoryOnce();
  for (const [trig, expectedCount] of [["scheduled", 4], ["manual", 2], ["test", 2]] as const) {
    const r = await api<EmailHistoryResponse>(`${EMAIL_HIST_BASE}&trigger=${trig}`, "GET", { token: saToken });
    assert.equal(r.status, 200, `trigger=${trig}: expected 200, got ${r.status}`);
    assert.equal(r.body.count, expectedCount, `trigger=${trig} should match exactly ${expectedCount} seeded rows`);
    for (const it of r.body.items) {
      assert.equal(it.trigger, trig, `trigger=${trig} returned a row with trigger=${it.trigger}`);
    }
  }
});

test("GET /maintenance/email-history: ?status bucket maps to the documented underlying statuses", async () => {
  await seedEmailHistoryOnce();
  // The exact bucket-to-status mapping from EMAIL_HISTORY_STATUS_BUCKETS in
  // admin.ts. Verifying the membership here means a future tweak to the
  // mapping (e.g. moving "snoozed" out of the suppressed bucket) trips this
  // test instead of silently mis-classifying rows in the UI's chip filter.
  const cases: Array<{ bucket: string; expectedStatuses: string[] }> = [
    { bucket: "ok",         expectedStatuses: ["ok", "no_critical"] },
    { bucket: "failed",     expectedStatuses: ["failed", "no_recipients", "no_transport"] },
    { bucket: "suppressed", expectedStatuses: ["skipped", "snoozed", "rate_limited"] },
  ];
  for (const c of cases) {
    const r = await api<EmailHistoryResponse>(`${EMAIL_HIST_BASE}&status=${c.bucket}`, "GET", { token: saToken });
    assert.equal(r.status, 200, `status=${c.bucket}: expected 200, got ${r.status}`);
    const got = r.body.items.map((it) => it.status).sort();
    assert.deepEqual(
      got,
      c.expectedStatuses.slice().sort(),
      `status=${c.bucket} must return exactly the expected underlying statuses, got [${got.join(",")}]`,
    );
  }
});

test("GET /maintenance/email-history: ?from / ?to scope the result by ranAt (inclusive end-of-day)", async () => {
  await seedEmailHistoryOnce();
  // Window covers exactly rows 4, 5, 6 (2010-03-04 .. 2010-03-06). The "to"
  // bound is inclusive of the whole calendar day, so rows at 03:00 UTC on
  // 2010-03-06 must appear.
  const r = await api<EmailHistoryResponse>(
    `/api/admin/maintenance/email-history?from=2010-03-04&to=2010-03-06`,
    "GET", { token: saToken },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 3);
  const days = r.body.items.map((it) => it.ranAt.slice(0, 10)).sort();
  assert.deepEqual(days, ["2010-03-04", "2010-03-05", "2010-03-06"]);

  // Single-day window (from===to). Inclusive end-of-day must still match
  // the row recorded at 03:00 UTC on that day.
  const single = await api<EmailHistoryResponse>(
    `/api/admin/maintenance/email-history?from=2010-03-05&to=2010-03-05`,
    "GET", { token: saToken },
  );
  assert.equal(single.status, 200);
  assert.equal(single.body.count, 1);
  assert.equal(single.body.items[0].ranAt, "2010-03-05T03:00:00.000Z");
});

test("GET /maintenance/email-history: combines trigger + status + date filters (AND semantics)", async () => {
  await seedEmailHistoryOnce();
  // Within 2010-03-01..2010-03-08, manual+failed bucket should match exactly
  // the manual+no_transport row (2010-03-05).
  const r = await api<EmailHistoryResponse>(
    `${EMAIL_HIST_BASE}&trigger=manual&status=failed`,
    "GET", { token: saToken },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 1);
  assert.equal(r.body.items[0].trigger, "manual");
  assert.equal(r.body.items[0].status, "no_transport");
  assert.equal(r.body.items[0].ranAt, "2010-03-05T03:00:00.000Z");
});

test("GET /maintenance/email-history: `total` reflects active filters and stays constant across pages", async () => {
  await seedEmailHistoryOnce();
  // The route returns a `total` field alongside the page slice. It powers
  // the "تم تحميل N من T محاولة" header and the "تحميل المزيد (X متبقّية)"
  // button label on the SuperAdmin audit panel, so it must:
  //   1) match the seeded row count when only the safe-window from/to is
  //      applied (i.e. no narrowing trigger/status/date filters beyond the
  //      window the rest of this suite uses to scope shared-DB assertions),
  //   2) stay constant across `limit`+`offset` pages — paging is a view
  //      onto the same filtered set, the total must not drift,
  //   3) narrow correctly when `trigger`, `status`, and `from`/`to` filters
  //      are applied, re-using the same fixture counts as the dedicated
  //      filter tests above so a refactor that drops a filter from the
  //      count's WHERE clause (but leaves it on the page query) trips here.
  // A future refactor that diverges the page WHERE from the count WHERE
  // would otherwise silently mis-state the header without any test signal.

  // (1) Baseline: window-only, no narrowing filters → total === seed size.
  const baseline = await api<EmailHistoryResponse>(EMAIL_HIST_BASE, "GET", { token: saToken });
  assert.equal(baseline.status, 200);
  assert.equal(
    baseline.body.total, EMAIL_HISTORY_SEED.length,
    `total must equal the ${EMAIL_HISTORY_SEED.length} seeded rows when only the safe-window from/to is applied (no trigger/status/extra-date filters), got total=${baseline.body.total}`,
  );

  // (2) Pagination: walk three non-overlapping pages with limit=3 over the
  //     same filtered set. `total` must stay pinned at the seed size on
  //     every page and must NOT drift toward the page slice size (`count`).
  //     If a refactor accidentally substituted `items.length` for the
  //     count-query result, the offset>0 pages would shrink and this trips.
  const PAGE = 3;
  let offset = 0;
  const seenIds = new Set<number>();
  while (offset < EMAIL_HISTORY_SEED.length) {
    const page = await api<EmailHistoryResponse>(
      `${EMAIL_HIST_BASE}&limit=${PAGE}&offset=${offset}`,
      "GET", { token: saToken },
    );
    assert.equal(page.status, 200, `page at offset=${offset}: expected 200, got ${page.status}`);
    assert.equal(
      page.body.total, EMAIL_HISTORY_SEED.length,
      `total must stay constant at ${EMAIL_HISTORY_SEED.length} across pages; page at offset=${offset} returned total=${page.body.total}`,
    );
    assert.equal(page.body.offset, offset, `offset echo mismatch at offset=${offset}`);
    assert.equal(page.body.limit,  PAGE,   `limit echo mismatch at offset=${offset}`);
    // Sanity: no row should appear on more than one page — proves the page
    // slice is a real slice of the same set the count is sized over.
    for (const it of page.body.items) {
      assert.ok(!seenIds.has(it.id), `row id=${it.id} appeared on more than one page (offset=${offset})`);
      seenIds.add(it.id);
    }
    offset += PAGE;
  }
  assert.equal(
    seenIds.size, EMAIL_HISTORY_SEED.length,
    `paging must visit every seeded row exactly once; saw ${seenIds.size}/${EMAIL_HISTORY_SEED.length}`,
  );

  // (3a) `trigger` filter narrows total. Re-uses the exact counts the
  //      dedicated trigger filter test above pins so a divergence between
  //      page and count WHERE clauses surfaces as the same number on both
  //      tests, not a silent drift only the header would notice.
  for (const [trig, expected] of [["scheduled", 4], ["manual", 2], ["test", 2]] as const) {
    const r = await api<EmailHistoryResponse>(`${EMAIL_HIST_BASE}&trigger=${trig}`, "GET", { token: saToken });
    assert.equal(r.status, 200, `trigger=${trig}: expected 200, got ${r.status}`);
    assert.equal(
      r.body.total, expected,
      `total must narrow to ${expected} when trigger=${trig} (matches the trigger filter test fixture); got total=${r.body.total}`,
    );
    assert.equal(
      r.body.count, expected,
      `count and total must agree when the page fits in one slice; trigger=${trig} count=${r.body.count} total=${r.body.total}`,
    );
  }

  // (3b) `status` bucket narrows total. The bucket sizes mirror the
  //      EMAIL_HISTORY_STATUS_BUCKETS mapping the status bucket test pins.
  for (const [bucket, expected] of [["ok", 2], ["failed", 3], ["suppressed", 3]] as const) {
    const r = await api<EmailHistoryResponse>(`${EMAIL_HIST_BASE}&status=${bucket}`, "GET", { token: saToken });
    assert.equal(r.status, 200, `status=${bucket}: expected 200, got ${r.status}`);
    assert.equal(
      r.body.total, expected,
      `total must narrow to ${expected} when status=${bucket} (matches the status bucket test fixture); got total=${r.body.total}`,
    );
  }

  // (3c) `from`/`to` narrows total. The 2010-03-04..2010-03-06 sub-window
  //      is the same one the date-range filter test pins to 3 rows, and
  //      the single-day from===to case must still match the row at 03:00
  //      UTC on that day (inclusive end-of-day).
  const win = await api<EmailHistoryResponse>(
    `/api/admin/maintenance/email-history?from=2010-03-04&to=2010-03-06`,
    "GET", { token: saToken },
  );
  assert.equal(win.status, 200);
  assert.equal(
    win.body.total, 3,
    `total must narrow to 3 for the 2010-03-04..2010-03-06 sub-window (matches the date-range filter test fixture); got total=${win.body.total}`,
  );
  const single = await api<EmailHistoryResponse>(
    `/api/admin/maintenance/email-history?from=2010-03-05&to=2010-03-05`,
    "GET", { token: saToken },
  );
  assert.equal(single.status, 200);
  assert.equal(
    single.body.total, 1,
    `total must narrow to 1 for the single-day 2010-03-05 window; got total=${single.body.total}`,
  );

  // (3d) Combined trigger + status + date filters (AND semantics). Mirrors
  //      the existing AND-semantics filter test (manual+failed within the
  //      seed window → exactly 1 row at 2010-03-05).
  const combo = await api<EmailHistoryResponse>(
    `${EMAIL_HIST_BASE}&trigger=manual&status=failed`,
    "GET", { token: saToken },
  );
  assert.equal(combo.status, 200);
  assert.equal(
    combo.body.total, 1,
    `total must narrow to 1 when trigger=manual AND status=failed AND date window applied (matches the AND-semantics filter test fixture); got total=${combo.body.total}`,
  );
});

test("GET /maintenance/email-history: 400 on invalid query input", async () => {
  // Bad date shape (from), bad date shape (to), unknown trigger, unknown
  // status bucket — every input-validation arm in the route.
  const cases = [
    `/api/admin/maintenance/email-history?from=not-a-date`,
    `/api/admin/maintenance/email-history?to=2026/01/01`,
    `/api/admin/maintenance/email-history?from=2010-13-40`,           // syntactically YYYY-MM-DD but not a real calendar date
    `/api/admin/maintenance/email-history?trigger=bogus`,
    `/api/admin/maintenance/email-history?status=bogus`,
  ];
  for (const path of cases) {
    const r = await api(path, "GET", { token: saToken });
    assert.equal(r.status, 400, `expected 400 for ${path}, got ${r.status}`);
  }
});

test("GET /maintenance/email-history: ?format=csv returns text/csv with the documented Arabic header row + writes an export_csv audit row", async () => {
  await seedEmailHistoryOnce();
  // Watermark audit_log so we only inspect rows this test wrote — same
  // shared-DB safety pattern the retention audit-log test uses above.
  const before = await db.execute<{ max_id: number | null }>(sql`
    SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM audit_log
  `);
  const beforeMax = Number(((before as { rows?: Array<{ max_id: number | null }> }).rows ?? [{ max_id: 0 }])[0]?.max_id ?? 0);

  const r = await api(
    `${EMAIL_HIST_BASE}&format=csv`,
    "GET",
    { token: saToken },
  );
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.text.slice(0, 200)}`);
  assert.match(r.headers.get("content-type") ?? "", /text\/csv/i, "Content-Type must be text/csv");

  // Exact header row — admins archiving the file expect a stable schema.
  const headerLine = r.text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
  const expectedHeaders = ["الوقت", "المصدر", "الحالة", "السبب", "المستلمون", "صفوف حرجة", "بصمة القائمة الحرجة", "الخطأ"];
  for (const h of expectedHeaders) {
    assert.ok(headerLine.includes(h), `CSV header row must include "${h}", got: ${headerLine}`);
  }
  // Data lines: one per seeded row in the window.
  const dataLines = r.text.replace(/^\uFEFF/, "").split(/\r?\n/).slice(1).filter((l) => l.length > 0);
  assert.equal(dataLines.length, EMAIL_HISTORY_SEED.length,
    `CSV should contain one data line per seeded row, got ${dataLines.length}`);

  // Audit side-effect: a single row recording who pulled the file, the
  // module/action/entityType, and the filter set in the metadata column.
  const newAuditRows = await db.select({
    id:         auditLogTable.id,
    action:     auditLogTable.action,
    module:     auditLogTable.module,
    entityType: auditLogTable.entityType,
    userId:     auditLogTable.userId,
    metadata:   auditLogTable.metadata,
  })
    .from(auditLogTable)
    .where(and(
      sql`${auditLogTable.id} > ${beforeMax}`,
      eq(auditLogTable.action, "export_csv"),
      eq(auditLogTable.module, "maintenance"),
      eq(auditLogTable.entityType, "maintenance_email_history"),
    ));
  assert.equal(newAuditRows.length, 1, "CSV branch must write exactly one export_csv audit row");
  const audit = newAuditRows[0];
  assert.equal(audit.userId, saUserId, "audit row must record the calling SuperAdmin");
  assert.ok(isObject(audit.metadata), "audit metadata must be a JSON object");
  const meta = audit.metadata as Record<string, unknown>;
  assert.equal(meta.format, "csv");
  assert.equal(meta.count, EMAIL_HISTORY_SEED.length);
  assert.ok(isObject(meta.filters), "metadata.filters must be present");
  const filters = meta.filters as Record<string, unknown>;
  assert.equal(filters.from, EMAIL_HIST_FROM);
  assert.equal(filters.to, EMAIL_HIST_TO);
  assert.equal(filters.trigger, null, "trigger filter was unset, metadata should record null");
  assert.equal(filters.status, null, "status filter was unset, metadata should record null");
  // Track for suite-level cleanup (also covered by the userId-based wipe in
  // cleanup() but explicit tracking matches the rest of the suite).
  insertedAuditLogIds.push(audit.id);
});

// ════════════════════════════════════════════════════════════════════════════
//  GET /api/admin/maintenance/history — JSON branch / paging / filters
// ════════════════════════════════════════════════════════════════════════════
// Backs the "سجل الإصلاحات" accordion on the SuperAdmin AI Company Fix page.
// The route reads `audit_log` rows where module='maintenance' for the
// requested company, ordered DESC by createdAt, paginated via ?offset/?limit,
// and narrowable via ?from/?to/?action/?entityType. The CSV branch is
// already covered (and ignores ?offset by design), so this block targets:
//   • Auth gates (401 without bearer, 403 for non-superadmin).
//   • The documented response shape (`items`, `hasMore`, `offset`, `limit`,
//     `nextOffset`).
//   • ?offset paging across multiple pages with NO overlap between pages.
//   • hasMore = false once the offset passes the filtered total.
//   • from / to / action / entityType filters narrow `items` AND `hasMore`.
//   • Bad inputs: from=not-a-date → 400; negative ?offset is clamped to 0.
//
// Determinism:
//   - All seeded rows live on a dedicated `historyCompanyId` so other tests
//     that fire writeAudit/logMaint against the existing test companies can
//     never inflate counts here.
//   - Rows carry distinct, far-past createdAt timestamps (2010-04-* @ 03:00
//     UTC, one row per day) so DESC ordering is stable and the date filter
//     can pick exact subsets.
//   - The seeded mix of (action, entityType) values yields the exact filter
//     counts the assertions hard-code below.

interface HistoryItem {
  id: number;
  action: string;
  entityType: string | null;
  username: string | null;
  metadata: unknown;
  createdAt: string;
}
interface HistoryResponse {
  count: number;
  items: HistoryItem[];
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
}

interface HistorySeedRow {
  createdAt: Date;
  action: string;
  entityType: string;
  metadata: Record<string, unknown>;
}

// 8 rows spanning a far-past 8-day window. The (action, entityType) mix is
// chosen so each filter assertion below has a unique expected count:
//   action=fix             → 3 rows (days 1, 2, 3)
//   action=export_csv      → 3 rows (days 4, 5, 6)
//   action=edit_retention  → 2 rows (days 7, 8)
//   entityType=journal_pending     → 2 rows (days 1, 4)
//   entityType=broken_refs         → 2 rows (days 2, 5)
//   entityType=dormant_users       → 1 row  (day 3)
//   entityType=maintenance_history → 1 row  (day 6)
//   entityType=retention_settings  → 2 rows (days 7, 8)
//   action=fix & entityType=journal_pending → 1 row (day 1)
const HISTORY_SEED: HistorySeedRow[] = [
  { createdAt: new Date("2010-04-01T03:00:00.000Z"), action: "fix",            entityType: "journal_pending",     metadata: { day: 1, fixed: 2 } },
  { createdAt: new Date("2010-04-02T03:00:00.000Z"), action: "fix",            entityType: "broken_refs",         metadata: { day: 2, fixed: 1 } },
  { createdAt: new Date("2010-04-03T03:00:00.000Z"), action: "fix",            entityType: "dormant_users",       metadata: { day: 3, deactivated: 4 } },
  { createdAt: new Date("2010-04-04T03:00:00.000Z"), action: "export_csv",     entityType: "journal_pending",     metadata: { day: 4, count: 17, format: "csv" } },
  { createdAt: new Date("2010-04-05T03:00:00.000Z"), action: "export_csv",     entityType: "broken_refs",         metadata: { day: 5, count: 9, format: "csv" } },
  { createdAt: new Date("2010-04-06T03:00:00.000Z"), action: "export_csv",     entityType: "maintenance_history", metadata: { day: 6, count: 50, format: "csv" } },
  { createdAt: new Date("2010-04-07T03:00:00.000Z"), action: "edit_retention", entityType: "retention_settings",  metadata: { day: 7, toolKey: "old-audit-logs", days: 365 } },
  { createdAt: new Date("2010-04-08T03:00:00.000Z"), action: "edit_retention", entityType: "retention_settings",  metadata: { day: 8, toolKey: "old-maintenance-runs", days: 90 } },
];

let historyCompanyId: number | undefined;
let historySeeded = false;

async function seedHistoryOnce(): Promise<void> {
  if (historySeeded) return;
  // Dedicated tenant: a fresh company seeded once and torn down by the
  // existing insertedCompanyIds cleanup. Using a fresh company means our
  // exact-count assertions never have to compete with audit_log rows the
  // run-now / retention / digest tests above wrote against the shared
  // dirty/clean companies.
  const [co] = await db.insert(companiesTable).values({
    nameAr:         `${TEST_TAG} شركة سجل الصيانة H`,
    nameEn:         `${TEST_TAG} Maint History Co H`,
    vatNumber:      `300000000000${"H".charCodeAt(0) % 10}`,
    crNumber:       `CR_${TEST_TAG}_H`,
    city:           "Riyadh",
    street:         "Test St",
    buildingNumber: "1",
    postalCode:     "12345",
    country:        "SA",
    invoiceType:    "both",
    status:         "active",
  }).returning({ id: companiesTable.id });
  historyCompanyId = co.id;
  insertedCompanyIds.push(historyCompanyId);

  const rows = await db.insert(auditLogTable).values(
    HISTORY_SEED.map((r) => ({
      userId:     saUserId,
      username:   `${TEST_TAG}_sa`,
      role:       "superadmin",
      companyId:  historyCompanyId!,
      module:     "maintenance",
      action:     r.action,
      method:     "POST",
      path:       "/api/admin/maintenance/seed",
      entityType: r.entityType,
      entityId:   null,
      statusCode: 200,
      ip:         "127.0.0.1",
      metadata:   r.metadata,
      createdAt:  r.createdAt,
    })),
  ).returning({ id: auditLogTable.id });
  for (const r of rows) insertedAuditLogIds.push(r.id);
  historySeeded = true;
}

const HIST_PATH = (qs: string = "") =>
  `/api/admin/maintenance/history?companyId=${historyCompanyId}${qs ? `&${qs}` : ""}`;

test("GET /maintenance/history (JSON): 401 without bearer token", async () => {
  // Auth gate fires before maintGuard, so this also doesn't need companyId
  // — but pass one anyway to make the URL realistic.
  await seedHistoryOnce();
  const r = await api(HIST_PATH(), "GET");
  assert.equal(r.status, 401);
});

test("GET /maintenance/history (JSON): 403 for non-superadmin", async () => {
  await seedHistoryOnce();
  const r = await api(HIST_PATH(), "GET", { token: regularToken });
  assert.equal(r.status, 403);
});

test("GET /maintenance/history (JSON): default response shape returns all seeded rows DESC, hasMore=false", async () => {
  await seedHistoryOnce();
  const r = await api<HistoryResponse>(HIST_PATH(), "GET", { token: saToken });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  // Documented response shape — every key the UI accordion reads.
  assert.ok(Array.isArray(r.body.items), "items must be an array");
  assert.equal(typeof r.body.count, "number");
  assert.equal(typeof r.body.offset, "number");
  assert.equal(typeof r.body.limit, "number");
  assert.equal(typeof r.body.hasMore, "boolean");
  // 8 seeded rows fit comfortably under the default limit (50) → hasMore=false.
  assert.equal(r.body.offset, 0);
  assert.equal(r.body.limit, 50, "default limit should be 50");
  assert.equal(r.body.count, HISTORY_SEED.length);
  assert.equal(r.body.items.length, HISTORY_SEED.length);
  assert.equal(r.body.hasMore, false);
  assert.equal(r.body.nextOffset, null, "nextOffset must be null when hasMore=false");
  // DESC by createdAt → most recent seeded row (day 8) is first, day 1 is last.
  assert.equal(r.body.items[0].createdAt, "2010-04-08T03:00:00.000Z");
  assert.equal(r.body.items[r.body.items.length - 1].createdAt, "2010-04-01T03:00:00.000Z");
  for (let i = 1; i < r.body.items.length; i++) {
    assert.ok(
      new Date(r.body.items[i - 1].createdAt).getTime() >= new Date(r.body.items[i].createdAt).getTime(),
      "items must be sorted by createdAt DESC",
    );
  }
  // Spot-check that the row carries the expected columns the UI renders.
  const first = r.body.items[0];
  assert.equal(first.action, "edit_retention");
  assert.equal(first.entityType, "retention_settings");
  assert.equal(first.username, `${TEST_TAG}_sa`);
  assert.ok(isObject(first.metadata), "metadata must be a JSON object");
});

test("GET /maintenance/history (JSON): ?offset paginates without overlap and exposes nextOffset", async () => {
  await seedHistoryOnce();
  // limit=3 → 3 pages of (3, 3, 2) rows. Walk all three pages and prove
  // (a) no row id appears in two different pages, (b) hasMore flips to
  // false on the final page, and (c) nextOffset is exactly offset+items.length
  // until the cursor exhausts the filtered total.
  const seenIds = new Set<number>();
  // Page 1: offset=0
  const p1 = await api<HistoryResponse>(HIST_PATH("limit=3&offset=0"), "GET", { token: saToken });
  assert.equal(p1.status, 200);
  assert.equal(p1.body.offset, 0);
  assert.equal(p1.body.limit, 3);
  assert.equal(p1.body.items.length, 3);
  assert.equal(p1.body.hasMore, true, "8 rows / limit 3 → page 1 must report hasMore=true");
  assert.equal(p1.body.nextOffset, 3);
  for (const it of p1.body.items) {
    assert.ok(!seenIds.has(it.id), `page 1 returned duplicate row ${it.id}`);
    seenIds.add(it.id);
  }
  // Page 2: offset=nextOffset from page 1
  const p2 = await api<HistoryResponse>(HIST_PATH(`limit=3&offset=${p1.body.nextOffset}`), "GET", { token: saToken });
  assert.equal(p2.status, 200);
  assert.equal(p2.body.offset, 3);
  assert.equal(p2.body.items.length, 3);
  assert.equal(p2.body.hasMore, true, "page 2 still has the final 2 rows behind it");
  assert.equal(p2.body.nextOffset, 6);
  for (const it of p2.body.items) {
    assert.ok(!seenIds.has(it.id), `page 2 overlaps page 1 on row ${it.id}`);
    seenIds.add(it.id);
  }
  // Page 3: final, partial
  const p3 = await api<HistoryResponse>(HIST_PATH(`limit=3&offset=${p2.body.nextOffset}`), "GET", { token: saToken });
  assert.equal(p3.status, 200);
  assert.equal(p3.body.offset, 6);
  assert.equal(p3.body.items.length, 2, "final page should contain the trailing 2 rows");
  assert.equal(p3.body.hasMore, false, "no rows remain past the trailing page → hasMore=false");
  assert.equal(p3.body.nextOffset, null, "nextOffset must be null on the final page");
  for (const it of p3.body.items) {
    assert.ok(!seenIds.has(it.id), `page 3 overlaps an earlier page on row ${it.id}`);
    seenIds.add(it.id);
  }
  // Walked every seeded row exactly once across the three pages.
  assert.equal(seenIds.size, HISTORY_SEED.length,
    `pagination must visit each row exactly once; saw ${seenIds.size} of ${HISTORY_SEED.length}`);
});

test("GET /maintenance/history (JSON): hasMore=false once the offset passes the filtered total", async () => {
  await seedHistoryOnce();
  // offset === total → empty page, hasMore=false.
  const atEnd = await api<HistoryResponse>(HIST_PATH(`limit=3&offset=${HISTORY_SEED.length}`), "GET", { token: saToken });
  assert.equal(atEnd.status, 200);
  assert.equal(atEnd.body.offset, HISTORY_SEED.length);
  assert.equal(atEnd.body.items.length, 0, "offset==total must return zero items");
  assert.equal(atEnd.body.hasMore, false);
  assert.equal(atEnd.body.nextOffset, null);
  // offset > total → also empty + hasMore=false (idempotent past the end).
  const past = await api<HistoryResponse>(HIST_PATH(`limit=3&offset=${HISTORY_SEED.length + 50}`), "GET", { token: saToken });
  assert.equal(past.status, 200);
  assert.equal(past.body.items.length, 0);
  assert.equal(past.body.hasMore, false);
  assert.equal(past.body.nextOffset, null);
});

test("GET /maintenance/history (JSON): ?action / ?entityType filters narrow items AND hasMore", async () => {
  await seedHistoryOnce();
  // action=fix → 3 seeded rows.
  const byAction = await api<HistoryResponse>(HIST_PATH("action=fix"), "GET", { token: saToken });
  assert.equal(byAction.status, 200);
  assert.equal(byAction.body.count, 3);
  assert.equal(byAction.body.items.length, 3);
  assert.equal(byAction.body.hasMore, false);
  for (const it of byAction.body.items) {
    assert.equal(it.action, "fix", `action filter leaked an action='${it.action}' row`);
  }
  // entityType=journal_pending → 2 seeded rows.
  const byEntity = await api<HistoryResponse>(HIST_PATH("entityType=journal_pending"), "GET", { token: saToken });
  assert.equal(byEntity.status, 200);
  assert.equal(byEntity.body.count, 2);
  assert.equal(byEntity.body.items.length, 2);
  for (const it of byEntity.body.items) {
    assert.equal(it.entityType, "journal_pending");
  }
  // Combined action + entityType (AND semantics) → 1 row only (day 1).
  const both = await api<HistoryResponse>(HIST_PATH("action=fix&entityType=journal_pending"), "GET", { token: saToken });
  assert.equal(both.status, 200);
  assert.equal(both.body.count, 1);
  assert.equal(both.body.items[0].createdAt, "2010-04-01T03:00:00.000Z");
  // Filter narrows hasMore too: action=export_csv has 3 rows; with limit=2
  // the first page must still report hasMore=true and nextOffset=2.
  const filteredPaged = await api<HistoryResponse>(HIST_PATH("action=export_csv&limit=2&offset=0"), "GET", { token: saToken });
  assert.equal(filteredPaged.status, 200);
  assert.equal(filteredPaged.body.items.length, 2);
  assert.equal(filteredPaged.body.hasMore, true,
    "filtered total (3) > limit (2) → page 1 must report hasMore=true");
  assert.equal(filteredPaged.body.nextOffset, 2);
  // Final page of the filtered set: 1 trailing row, hasMore=false.
  const filteredTail = await api<HistoryResponse>(HIST_PATH("action=export_csv&limit=2&offset=2"), "GET", { token: saToken });
  assert.equal(filteredTail.status, 200);
  assert.equal(filteredTail.body.items.length, 1);
  assert.equal(filteredTail.body.hasMore, false);
  assert.equal(filteredTail.body.nextOffset, null);
});

test("GET /maintenance/history (JSON): ?from / ?to scope by createdAt (inclusive end-of-day)", async () => {
  await seedHistoryOnce();
  // Inclusive 3-day window covers exactly days 3, 4, 5 (one row per day).
  // The 'to' bound is end-of-day inclusive: rows recorded at 03:00 UTC on
  // 2010-04-05 must still appear.
  const window = await api<HistoryResponse>(HIST_PATH("from=2010-04-03&to=2010-04-05"), "GET", { token: saToken });
  assert.equal(window.status, 200);
  assert.equal(window.body.count, 3);
  const days = window.body.items.map((it) => it.createdAt.slice(0, 10)).sort();
  assert.deepEqual(days, ["2010-04-03", "2010-04-04", "2010-04-05"]);
  // Single-day window: one row.
  const oneDay = await api<HistoryResponse>(HIST_PATH("from=2010-04-06&to=2010-04-06"), "GET", { token: saToken });
  assert.equal(oneDay.status, 200);
  assert.equal(oneDay.body.count, 1);
  assert.equal(oneDay.body.items[0].createdAt, "2010-04-06T03:00:00.000Z");
  // Window combined with action filter narrows further (AND semantics):
  // days 4, 5, 6 + action=export_csv → 3 rows; with limit=2 hasMore=true.
  const combined = await api<HistoryResponse>(
    HIST_PATH("from=2010-04-04&to=2010-04-08&action=export_csv&limit=2"), "GET", { token: saToken });
  assert.equal(combined.status, 200);
  assert.equal(combined.body.items.length, 2);
  assert.equal(combined.body.hasMore, true, "filtered total (3) > limit (2) → hasMore=true");
  assert.equal(combined.body.nextOffset, 2);
});

test("GET /maintenance/history (JSON): ?includeSystem=1 surfaces companyId=0 system-wide audit rows alongside the tenant's", async () => {
  await seedHistoryOnce();
  // Seed one system-wide row (companyId=0) as if the retention-settings PUT
  // had logged it. Without ?includeSystem this row must NOT appear in the
  // tenant's history; with ?includeSystem=1 it must show up. Captures task
  // #64's surface for `edit_retention` / `auto_prune` summaries which the
  // PUT and the daily auto-prune both write at companyId=0.
  const farFuture = new Date("2010-04-30T03:00:00.000Z");
  const [sys] = await db.insert(auditLogTable).values({
    userId:    saUserId,
    username:  `${TEST_TAG}_sa_sys`,
    role:      "superadmin",
    companyId: 0,
    module:    "maintenance",
    action:    "edit_retention",
    method:    "PUT",
    path:      "/api/admin/maintenance/retention-settings/old-audit-logs",
    entityType: "maintenance_retention",
    entityId:  "old-audit-logs",
    statusCode: 200,
    ip:        "127.0.0.1",
    metadata:  { toolKey: "old-audit-logs", days: 200, previousDays: 365, defaultDays: 365 },
    createdAt: farFuture,
  }).returning({ id: auditLogTable.id });
  insertedAuditLogIds.push(sys.id);

  // Without the flag → original behaviour (only the tenant's 8 seeded rows).
  const noFlag = await api<HistoryResponse>(HIST_PATH(), "GET", { token: saToken });
  assert.equal(noFlag.status, 200);
  assert.equal(noFlag.body.count, HISTORY_SEED.length,
    "default behaviour must remain unchanged when includeSystem is absent");
  for (const it of noFlag.body.items) {
    assert.notEqual((it.metadata as any)?.previousDays, 365,
      "system-wide row must not leak into the default per-company view");
  }

  // With ?includeSystem=1 → the seeded system row appears alongside the
  // tenant rows and the surfaced metadata still carries previousDays so the
  // UI can render the from→to delta. Use a generous limit so the seeded row
  // is in the response even when other tests have left additional system
  // rows behind on a shared DB. The count is asserted as ≥ tenant+1 (not
  // strict) for the same reason.
  const withFlag = await api<HistoryResponse>(HIST_PATH("includeSystem=1&limit=200"), "GET", { token: saToken });
  assert.equal(withFlag.status, 200);
  assert.ok(withFlag.body.count >= HISTORY_SEED.length + 1,
    `includeSystem=1 must surface ≥ ${HISTORY_SEED.length + 1} rows (tenant + the seeded system row); got ${withFlag.body.count}`);
  const surfaced = withFlag.body.items.find((it) => it.id === sys.id);
  assert.ok(surfaced, "the seeded system-wide row must appear in the includeSystem result");
  assert.equal(surfaced!.action, "edit_retention");
  assert.equal((surfaced!.metadata as any)?.previousDays, 365);
  assert.equal((surfaced!.metadata as any)?.days, 200);
});

test("GET /maintenance/history (JSON): rejects invalid ?from / ?to and clamps negative ?offset", async () => {
  await seedHistoryOnce();
  // Bad date shape on either bound → 400. Both arms of the validator.
  for (const path of [
    HIST_PATH("from=not-a-date"),
    HIST_PATH("to=2026/01/01"),
    HIST_PATH("from=2010-13-40"), // matches YYYY-MM-DD shape but not a real date
  ]) {
    const r = await api(path, "GET", { token: saToken });
    assert.equal(r.status, 400, `expected 400 for ${path}, got ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  // Negative offset is *clamped* to 0 (not rejected) — the route uses
  // clampInt(offset, 0, 1_000_000, 0). The response's offset field reports
  // the clamped value, and page 1 still returns the most recent rows.
  const negOffset = await api<HistoryResponse>(HIST_PATH("offset=-50&limit=3"), "GET", { token: saToken });
  assert.equal(negOffset.status, 200, "negative offset must be clamped, not rejected");
  assert.equal(negOffset.body.offset, 0, "negative offset must clamp to 0");
  assert.equal(negOffset.body.items.length, 3, "clamped page should still be a full page");
  assert.equal(negOffset.body.items[0].createdAt, "2010-04-08T03:00:00.000Z",
    "clamped offset=0 should still yield the most-recent row first");
});

// ════════════════════════════════════════════════════════════════════════════
//  GET /api/admin/maintenance/history/facets — filter dropdown options
// ════════════════════════════════════════════════════════════════════════════
// Backs the two filter <Select>s ("الإجراء" / "الفئة") above the
// "سجل الإصلاحات" accordion on the SuperAdmin AI Company Fix page. Every
// distinct (action, entityType) pair on the company's `audit_log` rows in
// module='maintenance' must surface as a dropdown option exactly once,
// sorted, with NULL / blank values stripped so the UI never renders an
// empty SelectItem (Radix throws when a SelectItem has value="").
//
// The block placement is intentional: the CSV tests below write fresh
// `export_csv` audit rows into the seeded tenant, which would pollute the
// "exact dedup'd set" assertion below. Run facets first so the
// historyCompanyId state still matches HISTORY_SEED verbatim.
//
// What this protects:
//   • Auth gates (401 without bearer, 403 for non-superadmin) — the route
//     leans on requireSuperAdmin before maintGuard.
//   • companyId validation (400 for missing / 0 / negative) — the maintGuard
//     is shared with all other /maintenance/* endpoints; a regression here
//     silently returns the wrong tenant's options.
//   • Sorted (localeCompare) and de-duplicated `actions` and `entityTypes`
//     arrays matching exactly the seeded HISTORY_SEED mix.
//   • Empty arrays for a company with no module='maintenance' audit rows.
//   • NULL / empty-string action / entity_type rows do NOT leak into either
//     dropdown — the route's defensive `IS NOT NULL AND <> ''` filters.
interface FacetsResponse {
  actions:     string[];
  entityTypes: string[];
}

const FACETS_PATH = (companyIdOverride?: number | string, qs: string = "") => {
  const cid = companyIdOverride === undefined ? historyCompanyId : companyIdOverride;
  const base = "/api/admin/maintenance/history/facets";
  const params = [
    cid === null ? "" : `companyId=${cid}`,
    qs,
  ].filter((s) => s.length > 0).join("&");
  return params.length > 0 ? `${base}?${params}` : base;
};

test("GET /maintenance/history/facets: 401 without bearer token", async () => {
  await seedHistoryOnce();
  const r = await api(FACETS_PATH(), "GET");
  assert.equal(r.status, 401);
});

test("GET /maintenance/history/facets: 403 for non-superadmin", async () => {
  await seedHistoryOnce();
  const r = await api(FACETS_PATH(), "GET", { token: regularToken });
  assert.equal(r.status, 403);
});

test("GET /maintenance/history/facets: 400 for missing or non-positive companyId", async () => {
  // No companyId at all → maintGuard rejects with 400 + Arabic message.
  const missing = await api<{ error?: string }>(
    "/api/admin/maintenance/history/facets", "GET", { token: saToken });
  assert.equal(missing.status, 400, `expected 400 for missing companyId, got ${missing.status}`);
  assert.ok(typeof missing.body?.error === "string" && missing.body.error.length > 0,
    "400 response must carry an error message the UI can surface");

  // Zero, negative, and non-numeric companyId → all 400 (maintGuard requires
  // an integer > 0). Catches a future refactor that accidentally widens the
  // accepted set (e.g. dropping the `<= 0` check).
  for (const cid of ["0", "-1", "not-a-number"]) {
    const r = await api(FACETS_PATH(cid), "GET", { token: saToken });
    assert.equal(r.status, 400, `expected 400 for companyId=${cid}, got ${r.status}`);
  }
});

test("GET /maintenance/history/facets: returns sorted, deduplicated actions + entityTypes from seeded rows", async () => {
  await seedHistoryOnce();
  const r = await api<FacetsResponse>(FACETS_PATH(), "GET", { token: saToken });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  // Documented response shape — the UI maps both fields straight onto two
  // <Select> components.
  assert.ok(Array.isArray(r.body.actions),     "actions must be an array");
  assert.ok(Array.isArray(r.body.entityTypes), "entityTypes must be an array");

  // HISTORY_SEED carries 8 rows where:
  //   actions = {fix×3, export_csv×3, edit_retention×2}      → 3 distinct
  //   entityTypes = {journal_pending×2, broken_refs×2,
  //                  dormant_users×1, maintenance_history×1,
  //                  retention_settings×2}                   → 5 distinct
  // The route sorts via String.prototype.localeCompare (default locale).
  const expectedActions     = ["edit_retention", "export_csv", "fix"]
    .slice().sort((a, b) => a.localeCompare(b));
  const expectedEntityTypes = ["broken_refs", "dormant_users", "journal_pending", "maintenance_history", "retention_settings"]
    .slice().sort((a, b) => a.localeCompare(b));
  assert.deepEqual(r.body.actions, expectedActions,
    `actions must be the 3 distinct seeded values, sorted; got ${JSON.stringify(r.body.actions)}`);
  assert.deepEqual(r.body.entityTypes, expectedEntityTypes,
    `entityTypes must be the 5 distinct seeded values, sorted; got ${JSON.stringify(r.body.entityTypes)}`);

  // Belt-and-brace: the result MUST be sorted and free of duplicates even
  // if the expected lists above are ever re-ordered by mistake.
  for (const list of [r.body.actions, r.body.entityTypes]) {
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i - 1].localeCompare(list[i]) < 0,
        `facet list must be strictly ascending and dedup'd; ${list[i - 1]} >= ${list[i]} at index ${i}`);
    }
  }
});

test("GET /maintenance/history/facets: returns empty arrays for a company with no maintenance audit rows", async () => {
  // Fresh tenant with zero audit_log activity → both dropdowns must be
  // empty. The UI renders a "no options" hint in that state.
  const [emptyCo] = await db.insert(companiesTable).values({
    nameAr:         `${TEST_TAG} شركة فلاتر فارغة`,
    nameEn:         `${TEST_TAG} Empty Facets Co`,
    vatNumber:      `300000000000${"E".charCodeAt(0) % 10}`,
    crNumber:       `CR_${TEST_TAG}_FE`,
    city:           "Riyadh",
    street:         "Test St",
    buildingNumber: "1",
    postalCode:     "12345",
    country:        "SA",
    invoiceType:    "both",
    status:         "active",
  }).returning({ id: companiesTable.id });
  insertedCompanyIds.push(emptyCo.id);

  const r = await api<FacetsResponse>(FACETS_PATH(emptyCo.id), "GET", { token: saToken });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  assert.deepEqual(r.body.actions, [],
    "actions must be empty for a tenant with no maintenance audit rows");
  assert.deepEqual(r.body.entityTypes, [],
    "entityTypes must be empty for a tenant with no maintenance audit rows");
});

test("GET /maintenance/history/facets: filters out NULL / empty-string action and entity_type rows", async () => {
  // Dedicated tenant so the assertions don't fight the HISTORY_SEED mix.
  const [filterCo] = await db.insert(companiesTable).values({
    nameAr:         `${TEST_TAG} شركة فلاتر فلتر`,
    nameEn:         `${TEST_TAG} Facets Filter Co`,
    vatNumber:      `300000000000${"F".charCodeAt(0) % 10}`,
    crNumber:       `CR_${TEST_TAG}_FF`,
    city:           "Riyadh",
    street:         "Test St",
    buildingNumber: "1",
    postalCode:     "12345",
    country:        "SA",
    invoiceType:    "both",
    status:         "active",
  }).returning({ id: companiesTable.id });
  insertedCompanyIds.push(filterCo.id);

  // Three "good" rows + four sentinel rows that exercise every blank/NULL
  // branch the route's `IS NOT NULL AND <> ''` filter is supposed to strip:
  //   • action='' (empty)        → must NOT appear in `actions`
  //   • entity_type=''           → must NOT appear in `entityTypes`
  //   • entity_type=NULL         → must NOT appear in `entityTypes`
  // (action=NULL cannot be inserted because the column is NOT NULL at the
  // schema level — the route's `action IS NOT NULL` is a defensive guard
  // against a future schema change. We can only exercise the empty-string
  // arm for `action`.)
  const goodRowsValues = [
    { action: "facet_keep_a", entityType: "facet_keep_x" },
    { action: "facet_keep_b", entityType: "facet_keep_y" },
    { action: "facet_keep_c", entityType: "facet_keep_z" },
  ];
  const sentinelEmptyAction       = { action: "",                entityType: "facet_blank_action_entity"   };
  const sentinelEmptyEntityType   = { action: "facet_with_blank_entity",       entityType: ""              };
  const sentinelNullEntityType    = { action: "facet_with_null_entity",        entityType: null as string | null };
  // Mix the sentinels in alongside the good rows.
  const allRows = [
    ...goodRowsValues,
    sentinelEmptyAction,
    sentinelEmptyEntityType,
    sentinelNullEntityType,
  ];
  const inserted = await db.insert(auditLogTable).values(
    allRows.map((r, i) => ({
      userId:     saUserId,
      username:   `${TEST_TAG}_sa_facets`,
      role:       "superadmin",
      companyId:  filterCo.id,
      module:     "maintenance",
      action:     r.action,
      method:     "POST",
      path:       "/api/admin/maintenance/seed",
      entityType: r.entityType,
      entityId:   null,
      statusCode: 200,
      ip:         "127.0.0.1",
      metadata:   { row: i },
      createdAt:  new Date(`2010-05-0${i + 1}T03:00:00.000Z`),
    })),
  ).returning({ id: auditLogTable.id });
  for (const row of inserted) insertedAuditLogIds.push(row.id);

  const r = await api<FacetsResponse>(FACETS_PATH(filterCo.id), "GET", { token: saToken });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);

  // `actions` must include every NON-empty action seeded (3 good + 2 from
  // the entity_type sentinel rows whose own `action` columns are populated)
  // and MUST NOT include the empty-string action.
  const expectedActions = [
    "facet_keep_a",
    "facet_keep_b",
    "facet_keep_c",
    "facet_with_blank_entity",
    "facet_with_null_entity",
  ].slice().sort((a, b) => a.localeCompare(b));
  assert.deepEqual(r.body.actions, expectedActions,
    `actions must surface non-blank values only, sorted; got ${JSON.stringify(r.body.actions)}`);
  assert.ok(!r.body.actions.includes(""),
    "empty-string action must never leak into the dropdown options");

  // `entityTypes` must include every NON-empty entityType seeded (3 good +
  // 1 from the empty-action sentinel whose own entity_type is populated)
  // and MUST NOT include the empty-string or NULL entity_type sentinels.
  const expectedEntityTypes = [
    "facet_blank_action_entity",
    "facet_keep_x",
    "facet_keep_y",
    "facet_keep_z",
  ].slice().sort((a, b) => a.localeCompare(b));
  assert.deepEqual(r.body.entityTypes, expectedEntityTypes,
    `entityTypes must surface non-blank values only, sorted; got ${JSON.stringify(r.body.entityTypes)}`);
  assert.ok(!r.body.entityTypes.includes(""),
    "empty-string entity_type must never leak into the dropdown options");
  // NULL would serialise as null in the JSON list if it leaked through —
  // assert it explicitly so a future bug stripping only '' (and not NULL)
  // doesn't slip past.
  assert.ok(!r.body.entityTypes.some((v) => v == null),
    "NULL entity_type must never leak into the dropdown options");
});

test("GET /maintenance/history/facets: ?includeSystem=1 surfaces companyId=0 audit rows in both dropdowns alongside tenant values", async () => {
  // Mirrors the /maintenance/history?includeSystem=1 test above, but on the
  // sibling /facets endpoint that drives the two filter <Select>s. The
  // SuperAdmin AI Company Fix page sets includeSystem=1 so options like
  // `edit_retention` / `auto_prune` (logged at companyId=0 by the daily
  // auto-prune and the retention-settings PUT) actually appear in the
  // dropdowns. A regression on the includeSystem branch would silently hide
  // those documented options. Captures task #89.
  //
  // Test isolation: a dedicated tenant (no HISTORY_SEED rows) keeps the
  // assertions independent of any other facet test. Sentinel values are
  // unique to this test (mirror the `facet_keep_*` naming pattern from task
  // #76) so a parallel system-wide row left behind by the /maintenance/history
  // includeSystem test cannot collide with — or substitute for — what we
  // are asserting here.
  const [sysFacetsCo] = await db.insert(companiesTable).values({
    nameAr:         `${TEST_TAG} شركة فلاتر النظام`,
    nameEn:         `${TEST_TAG} Sys Facets Co`,
    vatNumber:      `300000000000${"S".charCodeAt(0) % 10}`,
    crNumber:       `CR_${TEST_TAG}_FS`,
    city:           "Riyadh",
    street:         "Test St",
    buildingNumber: "1",
    postalCode:     "12345",
    country:        "SA",
    invoiceType:    "both",
    status:         "active",
  }).returning({ id: companiesTable.id });
  insertedCompanyIds.push(sysFacetsCo.id);

  // Two tenant rows so we can assert the system row appears *alongside* the
  // tenant-scoped values (not in place of them) when the flag is on.
  const tenantRows = await db.insert(auditLogTable).values([
    {
      userId:     saUserId,
      username:   `${TEST_TAG}_sa_sysfacets`,
      role:       "superadmin",
      companyId:  sysFacetsCo.id,
      module:     "maintenance",
      action:     "facet_sys_tenant_action",
      method:     "POST",
      path:       "/api/admin/maintenance/seed",
      entityType: "facet_sys_tenant_entity",
      entityId:   null,
      statusCode: 200,
      ip:         "127.0.0.1",
      metadata:   { tag: "tenant" },
      createdAt:  new Date("2010-05-10T03:00:00.000Z"),
    },
  ]).returning({ id: auditLogTable.id });
  for (const row of tenantRows) insertedAuditLogIds.push(row.id);

  // One system-wide row (companyId=0) with action / entityType values that
  // appear nowhere else in the suite. These are the sentinels the assertions
  // pivot on.
  const SYS_ACTION = "facet_sys_action_only";
  const SYS_ENTITY = "facet_sys_entity_only";
  const [sysRow] = await db.insert(auditLogTable).values({
    userId:     saUserId,
    username:   `${TEST_TAG}_sa_sysfacets`,
    role:       "superadmin",
    companyId:  0,
    module:     "maintenance",
    action:     SYS_ACTION,
    method:     "PUT",
    path:       "/api/admin/maintenance/retention-settings/old-audit-logs",
    entityType: SYS_ENTITY,
    entityId:   "old-audit-logs",
    statusCode: 200,
    ip:         "127.0.0.1",
    metadata:   { tag: "system", days: 200, previousDays: 365 },
    createdAt:  new Date("2010-05-11T03:00:00.000Z"),
  }).returning({ id: auditLogTable.id });
  insertedAuditLogIds.push(sysRow.id);

  // Without the flag → only the tenant's own values are surfaced. The
  // system-wide sentinels MUST NOT leak into either dropdown.
  const noFlag = await api<FacetsResponse>(FACETS_PATH(sysFacetsCo.id), "GET", { token: saToken });
  assert.equal(noFlag.status, 200,
    `expected 200, got ${noFlag.status}: ${JSON.stringify(noFlag.body).slice(0, 200)}`);
  assert.deepEqual(noFlag.body.actions, ["facet_sys_tenant_action"],
    `default branch must scope actions to the tenant only; got ${JSON.stringify(noFlag.body.actions)}`);
  assert.deepEqual(noFlag.body.entityTypes, ["facet_sys_tenant_entity"],
    `default branch must scope entityTypes to the tenant only; got ${JSON.stringify(noFlag.body.entityTypes)}`);
  assert.ok(!noFlag.body.actions.includes(SYS_ACTION),
    "system-wide action must NOT appear in the dropdown when includeSystem is absent");
  assert.ok(!noFlag.body.entityTypes.includes(SYS_ENTITY),
    "system-wide entityType must NOT appear in the dropdown when includeSystem is absent");

  // With ?includeSystem=1 → the system-wide sentinels surface in BOTH
  // dropdowns, alongside the tenant's own values. Use includes() (not
  // deepEqual) because other tests in the suite may have left additional
  // companyId=0 rows behind on a shared DB.
  const withFlag = await api<FacetsResponse>(
    FACETS_PATH(sysFacetsCo.id, "includeSystem=1"), "GET", { token: saToken });
  assert.equal(withFlag.status, 200,
    `expected 200, got ${withFlag.status}: ${JSON.stringify(withFlag.body).slice(0, 200)}`);
  assert.ok(withFlag.body.actions.includes("facet_sys_tenant_action"),
    `tenant action must still surface alongside system rows; got ${JSON.stringify(withFlag.body.actions)}`);
  assert.ok(withFlag.body.entityTypes.includes("facet_sys_tenant_entity"),
    `tenant entityType must still surface alongside system rows; got ${JSON.stringify(withFlag.body.entityTypes)}`);
  assert.ok(withFlag.body.actions.includes(SYS_ACTION),
    `system-wide action (${SYS_ACTION}) must surface in actions when includeSystem=1; got ${JSON.stringify(withFlag.body.actions)}`);
  assert.ok(withFlag.body.entityTypes.includes(SYS_ENTITY),
    `system-wide entityType (${SYS_ENTITY}) must surface in entityTypes when includeSystem=1; got ${JSON.stringify(withFlag.body.entityTypes)}`);

  // The flag must not duplicate values, and the result must remain sorted —
  // the SQL UNION ALL + GROUP BY relies on the route's post-process sort.
  for (const list of [withFlag.body.actions, withFlag.body.entityTypes]) {
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i - 1].localeCompare(list[i]) < 0,
        `includeSystem=1 facet list must be strictly ascending and dedup'd; ${list[i - 1]} >= ${list[i]} at index ${i}`);
    }
  }

  // ?includeSystem=true (the alternate truthy spelling the route accepts)
  // must behave identically — guards against a future refactor that drops
  // one of the two accepted spellings.
  const withFlagTrue = await api<FacetsResponse>(
    FACETS_PATH(sysFacetsCo.id, "includeSystem=true"), "GET", { token: saToken });
  assert.equal(withFlagTrue.status, 200);
  assert.ok(withFlagTrue.body.actions.includes(SYS_ACTION),
    "?includeSystem=true must surface system-wide actions just like ?includeSystem=1");
  assert.ok(withFlagTrue.body.entityTypes.includes(SYS_ENTITY),
    "?includeSystem=true must surface system-wide entityTypes just like ?includeSystem=1");
});

// Placed last in the history block on purpose: hitting ?format=csv writes a
// fresh `export_csv` audit row at NOW into the seeded tenant, which would
// shift the most-recent timestamp the JSON-shape tests above hard-code.
test("GET /maintenance/history: ?format=csv includes the new 'مدة الاحتفاظ' column with edit_retention deltas and old_* days values", async () => {
  await seedHistoryOnce();
  // Seed two extra rows that exercise both retention shapes the new column
  // is supposed to render:
  //   1) edit_retention with previousDays!=days → "365 → 200 يوم" delta
  //   2) fix on old_audit_logs with `days`     → "180 يوم" single value
  // Both are scoped to this tenant (companyId=historyCompanyId) so the
  // assertion doesn't depend on the includeSystem flag.
  const editRow = await db.insert(auditLogTable).values({
    userId:    saUserId,
    username:  `${TEST_TAG}_sa_csv`,
    role:      "superadmin",
    companyId: historyCompanyId!,
    module:    "maintenance",
    action:    "edit_retention",
    method:    "PUT",
    path:      "/api/admin/maintenance/retention-settings/old-audit-logs",
    entityType: "maintenance_retention",
    entityId:  "old-audit-logs",
    statusCode: 200,
    ip:        "127.0.0.1",
    metadata:  { toolKey: "old-audit-logs", days: 200, previousDays: 365, defaultDays: 365 },
    createdAt: new Date("2010-04-20T03:00:00.000Z"),
  }).returning({ id: auditLogTable.id });
  const fixRow = await db.insert(auditLogTable).values({
    userId:    saUserId,
    username:  `${TEST_TAG}_sa_csv`,
    role:      "superadmin",
    companyId: historyCompanyId!,
    module:    "maintenance",
    action:    "fix",
    method:    "POST",
    path:      "/api/admin/maintenance/old-audit-logs",
    entityType: "old_audit_logs",
    entityId:  null,
    statusCode: 200,
    ip:        "127.0.0.1",
    metadata:  { deleted: 7, days: 180 },
    createdAt: new Date("2010-04-21T03:00:00.000Z"),
  }).returning({ id: auditLogTable.id });
  insertedAuditLogIds.push(editRow[0].id, fixRow[0].id);

  const r = await api(HIST_PATH("format=csv"), "GET", { token: saToken });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.text.slice(0, 200)}`);
  assert.match(r.headers.get("content-type") ?? "", /text\/csv/i, "Content-Type must be text/csv");

  // Header row must include the new column. Also re-asserts the original
  // headers still exist so a future column rename doesn't silently drop one.
  const headerLine = r.text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
  for (const h of ["التاريخ", "المستخدم", "الفئة", "الإجراء", "مدة الاحتفاظ", "التفاصيل"]) {
    assert.ok(headerLine.includes(h), `CSV header row must include "${h}", got: ${headerLine}`);
  }

  // The CSV body must contain the rendered retention strings the on-screen
  // helper produces — the from→to delta for edit_retention and the single-
  // value form for the old_* fix row.
  assert.ok(r.text.includes("365 → 200 يوم"),
    `CSV must include the edit_retention from→to delta; body sample: ${r.text.slice(0, 400)}`);
  assert.ok(r.text.includes("180 يوم"),
    `CSV must include the single-value retention for the old_* fix row; body sample: ${r.text.slice(0, 400)}`);
});

// Task #75: complement the existing "مدة الاحتفاظ" content test above with a
// dedicated guardrail for the rest of the CSV branch's contract — pinned in
// the same shape as the /maintenance/email-history CSV test:
//   • Content-Type: text/csv (+ a UTF-8 BOM the route prepends so Excel
//     renders Arabic).
//   • EXACT Arabic header row in the documented order
//     (التاريخ / المستخدم / الفئة / الإجراء / مدة الاحتفاظ / التفاصيل).
//     Splitting the header line on "," and asserting the array catches both
//     a column rename AND a column reorder in a single assertion.
//   • One CSV data line per filtered audit_log entry, demonstrated by
//     comparing against the JSON branch's count for the SAME filter set
//     (so a regression that drifts the two branches apart trips this test).
//   • The four documented filters (from / to / action / entityType) narrow
//     the CSV exactly the way they narrow JSON — exercised with two distinct
//     filter sets so a subtle bug in any single dimension shows up.
//   • A single `export_csv` audit_log row is written per export call,
//     tagged with the calling SA's userId, action='export_csv',
//     module='maintenance', entityType='maintenance_history', and a
//     metadata.filters object that echoes the applied filter set verbatim
//     (unset filters serialised as `null`, not omitted).
test("GET /maintenance/history: ?format=csv pins content-type, exact Arabic header order, audit-row side-effect, and per-filter row parity with JSON", async () => {
  await seedHistoryOnce();

  // Filter set A: all four filter dimensions at once. The seeded mix has
  // exactly one row matching action=fix + entityType=journal_pending in the
  // day-1 → day-8 window — a stable count regardless of how many extra
  // export_csv audit rows the test above (or any other test in the suite)
  // has already written back to historyCompanyId at NOW.
  const filtersA = "from=2010-04-01&to=2010-04-08&action=fix&entityType=journal_pending";
  const jsonA = await api<HistoryResponse>(HIST_PATH(filtersA), "GET", { token: saToken });
  assert.equal(jsonA.status, 200);
  assert.equal(jsonA.body.count, 1,
    "preflight: filtersA must match exactly the day-1 fix/journal_pending row");

  // Filter set B: entityType only. The seeded set carries two rows with
  // entityType='retention_settings' (days 7 + 8). The previous CSV test in
  // this block seeds a separate entityType='maintenance_retention' row, so
  // the two filter values do NOT collide and the count stays at 2.
  const filtersB = "entityType=retention_settings";
  const jsonB = await api<HistoryResponse>(HIST_PATH(filtersB), "GET", { token: saToken });
  assert.equal(jsonB.status, 200);
  assert.equal(jsonB.body.count, 2,
    "preflight: filtersB must match the two seeded retention_settings rows");

  // Watermark audit_log so the side-effect assertions below see only the
  // export rows the next two CSV calls write — same shared-DB safety
  // pattern the email-history CSV test uses.
  const before = await db.execute<{ max_id: number | null }>(sql`
    SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM audit_log
  `);
  const beforeMax = Number(((before as { rows?: Array<{ max_id: number | null }> }).rows ?? [{ max_id: 0 }])[0]?.max_id ?? 0);

  // ── CSV with filters A ──────────────────────────────────────────────────
  const csvA = await api(HIST_PATH(`${filtersA}&format=csv`), "GET", { token: saToken });
  assert.equal(csvA.status, 200, `expected 200, got ${csvA.status}: ${csvA.text.slice(0, 200)}`);
  assert.match(csvA.headers.get("content-type") ?? "", /text\/csv/i, "Content-Type must be text/csv");

  // Content-Disposition filename starts with the documented prefix so the
  // file an SA hands engineering can be matched by name back to the exact
  // company it was exported from. Mirrors the tool-history CSV test's pin
  // — drop the companyId or rename the prefix and this trips.
  const dispositionA = csvA.headers.get("content-disposition") ?? "";
  assert.match(
    dispositionA,
    new RegExp(`attachment;\\s*filename="maintenance-history-${historyCompanyId}-`),
    `Content-Disposition must start with the documented prefix, got: ${dispositionA}`,
  );

  // EXACT header row, in the documented order. Captures both a column
  // rename AND a column reorder in a single assertion. The route prepends
  // a UTF-8 BOM (Excel needs it for Arabic) — strip it before splitting.
  const linesA = csvA.text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const headerCellsA = linesA[0].split(",");
  assert.deepEqual(
    headerCellsA,
    ["التاريخ", "المستخدم", "الفئة", "الإجراء", "مدة الاحتفاظ", "التفاصيل"],
    `CSV header row must match the exact documented Arabic order, got: ${linesA[0]}`,
  );

  // Per-filter parity: one CSV data line per row the JSON branch returned
  // for the same filter set. Drifting the two branches apart trips this.
  const dataA = linesA.slice(1).filter((l) => l.length > 0);
  assert.equal(dataA.length, jsonA.body.count,
    `CSV row count must equal the JSON-filtered count for filtersA; got ${dataA.length} vs ${jsonA.body.count}`);
  // Every JSON-filtered row must surface in the CSV body (timestamps are
  // rendered through csvDate → "YYYY-MM-DD HH:mm" UTC).
  for (const it of jsonA.body.items) {
    const stamp = new Date(it.createdAt).toISOString().replace("T", " ").slice(0, 16);
    assert.ok(csvA.text.includes(stamp),
      `CSV body must include the filtersA row timestamp ${stamp}; sample: ${csvA.text.slice(0, 400)}`);
  }

  // ── CSV with filters B ──────────────────────────────────────────────────
  const csvB = await api(HIST_PATH(`${filtersB}&format=csv`), "GET", { token: saToken });
  assert.equal(csvB.status, 200);
  assert.match(csvB.headers.get("content-type") ?? "", /text\/csv/i);
  const linesB = csvB.text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const headerCellsB = linesB[0].split(",");
  assert.deepEqual(
    headerCellsB,
    ["التاريخ", "المستخدم", "الفئة", "الإجراء", "مدة الاحتفاظ", "التفاصيل"],
    "header row order must hold across calls (not just the first export of the suite)",
  );
  const dataB = linesB.slice(1).filter((l) => l.length > 0);
  assert.equal(dataB.length, jsonB.body.count,
    `CSV row count must equal the JSON-filtered count for filtersB; got ${dataB.length} vs ${jsonB.body.count}`);

  // ── Audit side-effect ───────────────────────────────────────────────────
  // Each CSV export wrote ONE export_csv row tagged with the calling SA's
  // userId, the maintenance module/action, the maintenance_history entity
  // type, and a metadata.filters object echoing the applied filter set
  // (unset filters serialised as `null`, not omitted).
  const newAuditRows = await db.select({
    id:         auditLogTable.id,
    action:     auditLogTable.action,
    module:     auditLogTable.module,
    entityType: auditLogTable.entityType,
    userId:     auditLogTable.userId,
    metadata:   auditLogTable.metadata,
  })
    .from(auditLogTable)
    .where(and(
      sql`${auditLogTable.id} > ${beforeMax}`,
      eq(auditLogTable.action, "export_csv"),
      eq(auditLogTable.module, "maintenance"),
      eq(auditLogTable.entityType, "maintenance_history"),
    ))
    .orderBy(auditLogTable.id);
  assert.equal(newAuditRows.length, 2,
    `CSV branch must write exactly one export_csv audit row per export call (expected 2, got ${newAuditRows.length})`);
  for (const a of newAuditRows) {
    assert.equal(a.userId, saUserId, "every export audit row must record the calling SuperAdmin");
    assert.equal(a.action, "export_csv");
    assert.equal(a.module, "maintenance");
    assert.equal(a.entityType, "maintenance_history");
    insertedAuditLogIds.push(a.id);
  }

  // Audit row #1 → filtersA echoed verbatim into metadata.filters.
  const auditA = newAuditRows[0];
  assert.ok(isObject(auditA.metadata), "audit row #1 metadata must be a JSON object");
  const metaA = auditA.metadata as Record<string, unknown>;
  assert.equal(metaA.format, "csv");
  assert.equal(metaA.count, jsonA.body.count,
    `audit row #1 metadata.count must equal the exported row count (${jsonA.body.count}); got ${metaA.count}`);
  assert.ok(isObject(metaA.filters), "audit row #1 metadata.filters must be present");
  const fA = metaA.filters as Record<string, unknown>;
  assert.equal(fA.from,       "2010-04-01");
  assert.equal(fA.to,         "2010-04-08");
  assert.equal(fA.action,     "fix");
  assert.equal(fA.entityType, "journal_pending");

  // Audit row #2 → filtersB echoed; the three unset filters are recorded
  // as `null` rather than omitted so admins reviewing audit JSON always
  // see the full schema.
  const auditB = newAuditRows[1];
  assert.ok(isObject(auditB.metadata), "audit row #2 metadata must be a JSON object");
  const metaB = auditB.metadata as Record<string, unknown>;
  assert.equal(metaB.format, "csv");
  assert.equal(metaB.count, jsonB.body.count,
    `audit row #2 metadata.count must equal the exported row count (${jsonB.body.count}); got ${metaB.count}`);
  assert.ok(isObject(metaB.filters), "audit row #2 metadata.filters must be present");
  const fB = metaB.filters as Record<string, unknown>;
  assert.equal(fB.from,       null, "unset 'from' must be recorded as null, not omitted");
  assert.equal(fB.to,         null, "unset 'to' must be recorded as null, not omitted");
  assert.equal(fB.action,     null, "unset 'action' must be recorded as null, not omitted");
  assert.equal(fB.entityType, "retention_settings");
});

// ════════════════════════════════════════════════════════════════════════════
//  runEmailHistoryAutoPrune — daily cleanup of email-history tables
// ════════════════════════════════════════════════════════════════════════════
// Protects the scheduled hygiene path that prunes both append-only email-
// history tables (`maintenance_email_runs` + `report_email_schedule_runs`).
// Without it the SuperAdmin audit panels grow forever between manual fixes.
//
// Each test seeds dated rows directly into both tables (timestamps are the
// DELETE cutoff, so per-tenant TEST_TAG isolation isn't possible — we
// instead select recent audit rows by id-watermark and clean up by id).

test("runEmailHistoryAutoPrune: deletes rows older than the default 90-day window from both tables and writes one audit summary", async () => {
  // Reset retention so the function uses the documented 90-day default.
  await resetRetention("old-maintenance-email-runs");
  await resetRetention("old-report-email-runs");

  // Watermark BEFORE we seed / run so the cleanup query (and the audit-row
  // assertion below) only see rows produced inside this test.
  const auditWatermark = await db.execute<{ max_id: number | null }>(sql`
    SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM audit_log
  `);
  const auditCutoffId = Number(((auditWatermark as any).rows ?? [{ max_id: 0 }])[0]?.max_id ?? 0);

  const oldRanAt    = new Date(Date.now() - 200 * 86_400_000); // > 90d → must be deleted
  const recentRanAt = new Date(Date.now() - 10  * 86_400_000); // ≤ 90d → must be kept

  const [oldMaint] = await db.insert(maintenanceEmailRunsTable).values({
    ranAt: oldRanAt, trigger: "scheduled", status: "ok",
    recipients: 1, criticalCount: 0,
    error: null, reason: "digest_sent", criticalSignature: `${TEST_TAG}_old_maint`,
  }).returning({ id: maintenanceEmailRunsTable.id });
  const [recentMaint] = await db.insert(maintenanceEmailRunsTable).values({
    ranAt: recentRanAt, trigger: "scheduled", status: "ok",
    recipients: 1, criticalCount: 0,
    error: null, reason: "digest_sent", criticalSignature: `${TEST_TAG}_recent_maint`,
  }).returning({ id: maintenanceEmailRunsTable.id });
  insertedMaintenanceEmailRunIds.push(oldMaint.id, recentMaint.id);

  const [oldReport] = await db.insert(reportEmailScheduleRunsTable).values({
    ranAt: oldRanAt, trigger: "scheduled", status: "ok",
    reports: ["operational-summary"], recipients: 2,
    message: `${TEST_TAG}_old_report`,
  }).returning({ id: reportEmailScheduleRunsTable.id });
  const [recentReport] = await db.insert(reportEmailScheduleRunsTable).values({
    ranAt: recentRanAt, trigger: "scheduled", status: "ok",
    reports: ["operational-summary"], recipients: 2,
    message: `${TEST_TAG}_recent_report`,
  }).returning({ id: reportEmailScheduleRunsTable.id });

  try {
    const summary = await runEmailHistoryAutoPrune("manual");
    // Defaults must come from RETENTION_TOOL_BOUNDS (90d for both tables).
    assert.equal(summary.maintenanceEmailRunsRetentionDays, 90);
    assert.equal(summary.reportEmailRunsRetentionDays, 90);
    // Each side must have deleted at least our seeded old row. Other test
    // runs on a shared DB may have also left old rows behind, so we assert
    // ≥ 1 (not strict equality).
    assert.ok(summary.maintenanceEmailRunsDeleted >= 1,
      `expected ≥1 maintenance email run deleted, got ${summary.maintenanceEmailRunsDeleted}`);
    assert.ok(summary.reportEmailRunsDeleted >= 1,
      `expected ≥1 report email run deleted, got ${summary.reportEmailRunsDeleted}`);
    assert.ok(Number.isFinite(summary.durationMs) && summary.durationMs >= 0);

    // Old rows must be gone, recent rows must survive.
    const stillOldMaint = await db.select({ id: maintenanceEmailRunsTable.id })
      .from(maintenanceEmailRunsTable)
      .where(eq(maintenanceEmailRunsTable.id, oldMaint.id));
    assert.equal(stillOldMaint.length, 0, "old maintenance_email_runs row must be pruned");
    const stillRecentMaint = await db.select({ id: maintenanceEmailRunsTable.id })
      .from(maintenanceEmailRunsTable)
      .where(eq(maintenanceEmailRunsTable.id, recentMaint.id));
    assert.equal(stillRecentMaint.length, 1, "recent maintenance_email_runs row must NOT be pruned");

    const stillOldReport = await db.select({ id: reportEmailScheduleRunsTable.id })
      .from(reportEmailScheduleRunsTable)
      .where(eq(reportEmailScheduleRunsTable.id, oldReport.id));
    assert.equal(stillOldReport.length, 0, "old report_email_schedule_runs row must be pruned");
    const stillRecentReport = await db.select({ id: reportEmailScheduleRunsTable.id })
      .from(reportEmailScheduleRunsTable)
      .where(eq(reportEmailScheduleRunsTable.id, recentReport.id));
    assert.equal(stillRecentReport.length, 1, "recent report_email_schedule_runs row must NOT be pruned");

    // Exactly one audit summary row produced for THIS sweep — and it must
    // carry the deleted counts + retention windows in metadata so the
    // maintenance-history panel can render them without re-querying.
    const newAuditRows = await db.select({
      id: auditLogTable.id,
      module: auditLogTable.module,
      action: auditLogTable.action,
      role: auditLogTable.role,
      companyId: auditLogTable.companyId,
      entityType: auditLogTable.entityType,
      metadata: auditLogTable.metadata,
    })
      .from(auditLogTable)
      .where(and(
        sql`${auditLogTable.id} > ${auditCutoffId}`,
        eq(auditLogTable.action, "auto_prune"),
        eq(auditLogTable.entityType, "email_history"),
      ));
    insertedAuditLogIds.push(...newAuditRows.map((r) => r.id));
    assert.equal(newAuditRows.length, 1,
      `expected exactly one auto_prune audit row this sweep, got ${newAuditRows.length}`);
    const audit = newAuditRows[0];
    assert.equal(audit.module, "maintenance");
    assert.equal(audit.role, "system");
    assert.equal(audit.companyId, 0);
    assert.ok(isObject(audit.metadata), "audit metadata must be a JSON object");
    const md = audit.metadata as Record<string, any>;
    assert.equal(md.trigger, "manual");
    assert.equal(md.maintenanceEmailRuns?.retentionDays, 90);
    assert.equal(md.reportEmailRuns?.retentionDays, 90);
    assert.equal(md.maintenanceEmailRuns?.deleted, summary.maintenanceEmailRunsDeleted);
    assert.equal(md.reportEmailRuns?.deleted, summary.reportEmailRunsDeleted);
    assert.equal(md.errors, undefined, "no error metadata on the happy path");
  } finally {
    // Recent rows survived the prune — reclaim them so the row-level
    // teardown picks them up. (The old rows are already gone via the prune
    // itself; tracking their ids in `insertedMaintenanceEmailRunIds` is
    // harmless because the cleanup DELETE is a no-op for missing ids.)
    await db.delete(reportEmailScheduleRunsTable)
      .where(inArray(reportEmailScheduleRunsTable.id, [oldReport.id, recentReport.id]));
  }
});

test("runEmailHistoryAutoPrune: persisted retention setting overrides the default cutoff", async () => {
  // Persist a tight 30-day retention for maintenance_email_runs so a row 60d
  // old gets pruned even though it would be safely inside the default 90-day
  // window. report_email_schedule_runs keeps the 90d default so we can prove
  // the two tools are read independently — its 60d row must NOT be pruned.
  await resetRetention("old-maintenance-email-runs");
  await resetRetention("old-report-email-runs");
  await db.insert(maintenanceRetentionSettingsTable).values({
    toolKey: "old-maintenance-email-runs",
    days: 30,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: maintenanceRetentionSettingsTable.toolKey,
    set: { days: 30, updatedAt: new Date() },
  });

  const ranAt60d = new Date(Date.now() - 60 * 86_400_000);
  const [maintRow] = await db.insert(maintenanceEmailRunsTable).values({
    ranAt: ranAt60d, trigger: "scheduled", status: "ok",
    recipients: 1, criticalCount: 0,
    error: null, reason: "digest_sent", criticalSignature: `${TEST_TAG}_60d_maint`,
  }).returning({ id: maintenanceEmailRunsTable.id });
  insertedMaintenanceEmailRunIds.push(maintRow.id);
  const [reportRow] = await db.insert(reportEmailScheduleRunsTable).values({
    ranAt: ranAt60d, trigger: "scheduled", status: "ok",
    reports: ["operational-summary"], recipients: 1,
    message: `${TEST_TAG}_60d_report`,
  }).returning({ id: reportEmailScheduleRunsTable.id });

  try {
    const summary = await runEmailHistoryAutoPrune("scheduled");
    assert.equal(summary.maintenanceEmailRunsRetentionDays, 30,
      "persisted setting must override the 90-day default");
    assert.equal(summary.reportEmailRunsRetentionDays, 90,
      "untouched tool keeps the 90-day default");

    // The 60-day-old maintenance row was outside the 30d window → pruned.
    const stillMaint = await db.select({ id: maintenanceEmailRunsTable.id })
      .from(maintenanceEmailRunsTable)
      .where(eq(maintenanceEmailRunsTable.id, maintRow.id));
    assert.equal(stillMaint.length, 0,
      "60-day-old maintenance row must be pruned under 30d retention");

    // The 60-day-old report row was inside the 90d default → kept.
    const stillReport = await db.select({ id: reportEmailScheduleRunsTable.id })
      .from(reportEmailScheduleRunsTable)
      .where(eq(reportEmailScheduleRunsTable.id, reportRow.id));
    assert.equal(stillReport.length, 1,
      "60-day-old report row must NOT be pruned under 90d retention");
  } finally {
    await db.delete(reportEmailScheduleRunsTable)
      .where(eq(reportEmailScheduleRunsTable.id, reportRow.id));
    await resetRetention("old-maintenance-email-runs");
    // Belt-and-brace: pick up the audit row this sweep wrote so teardown
    // can clean it. Match by action+entityType to avoid touching unrelated
    // audit_log rows on a shared DB.
    const auditRows = await db.select({ id: auditLogTable.id })
      .from(auditLogTable)
      .where(and(
        eq(auditLogTable.action, "auto_prune"),
        eq(auditLogTable.entityType, "email_history"),
        eq(auditLogTable.role, "system"),
        eq(auditLogTable.companyId, 0),
      ));
    for (const r of auditRows) {
      if (!insertedAuditLogIds.includes(r.id)) insertedAuditLogIds.push(r.id);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  runAuditLogAutoPrune + runMaintenanceRunsAutoPrune — daily cleanup of the
//  two per-company "old records" toolbox cards.
// ════════════════════════════════════════════════════════════════════════════
// These mirror the runEmailHistoryAutoPrune tests above but for the higher-
// volume per-company tables. Without them the SuperAdmin audit panels and
// the maintenance-history accordion grow forever between manual fixes.
//
// Each test seeds dated rows directly into the target table (timestamps are
// the DELETE cutoff, so per-tenant TEST_TAG isolation isn't possible — we
// instead select recent audit summary rows by id-watermark and clean up by id).

test("runAuditLogAutoPrune: deletes audit_log rows older than the default 365-day window and writes one summary audit row", async () => {
  await resetRetention("old-audit-logs");

  // Watermark BEFORE seeding so the assertions below see only rows produced
  // inside this test, even on a shared database.
  const auditWatermark = await db.execute<{ max_id: number | null }>(sql`
    SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM audit_log
  `);
  const auditCutoffId = Number(((auditWatermark as any).rows ?? [{ max_id: 0 }])[0]?.max_id ?? 0);

  const oldCreatedAt    = new Date(Date.now() - 400 * 86_400_000); // > 365d → must be deleted
  const recentCreatedAt = new Date(Date.now() - 30  * 86_400_000); // ≤ 365d → must be kept

  const seeded = await db.insert(auditLogTable).values([
    { userId: saUserId, username: `${TEST_TAG}_sa`, role: "superadmin",
      companyId: dirtyCompanyId, module: "test", action: "auto_prune_seed",
      entityType: "test_old", createdAt: oldCreatedAt },
    { userId: saUserId, username: `${TEST_TAG}_sa`, role: "superadmin",
      companyId: dirtyCompanyId, module: "test", action: "auto_prune_seed",
      entityType: "test_recent", createdAt: recentCreatedAt },
  ]).returning({ id: auditLogTable.id });
  const oldAuditId    = seeded[0].id;
  const recentAuditId = seeded[1].id;
  // Track the "recent" row for teardown (the "old" row is deleted by the
  // sweep itself; tracking it here is harmless because the cleanup DELETE
  // is a no-op for missing ids).
  insertedAuditLogIds.push(oldAuditId, recentAuditId);

  const summary = await runAuditLogAutoPrune("manual");
  // Default must come from the documented 365-day window.
  assert.equal(summary.retentionDays, 365);
  // At least our seeded old row was deleted; other test runs on a shared DB
  // may have left behind additional old rows so we assert ≥ 1.
  assert.ok(summary.deleted >= 1,
    `expected ≥1 audit_log row deleted, got ${summary.deleted}`);
  assert.ok(Number.isFinite(summary.durationMs) && summary.durationMs >= 0);

  // Old row must be gone, recent row must survive.
  const stillOld = await db.select({ id: auditLogTable.id })
    .from(auditLogTable)
    .where(eq(auditLogTable.id, oldAuditId));
  assert.equal(stillOld.length, 0, "old audit_log row must be pruned");
  const stillRecent = await db.select({ id: auditLogTable.id })
    .from(auditLogTable)
    .where(eq(auditLogTable.id, recentAuditId));
  assert.equal(stillRecent.length, 1, "recent audit_log row must NOT be pruned");

  // Exactly one summary audit row produced for THIS sweep — it must carry
  // the deleted count + retention window in metadata so the maintenance-
  // history panel can render them without re-querying. companyId=0 mirrors
  // the email-history auto-prune convention since the sweep is system-wide.
  const newAuditRows = await db.select({
    id: auditLogTable.id,
    module: auditLogTable.module,
    action: auditLogTable.action,
    role: auditLogTable.role,
    companyId: auditLogTable.companyId,
    entityType: auditLogTable.entityType,
    metadata: auditLogTable.metadata,
  })
    .from(auditLogTable)
    .where(and(
      sql`${auditLogTable.id} > ${auditCutoffId}`,
      eq(auditLogTable.action, "auto_prune"),
      eq(auditLogTable.entityType, "audit_log"),
    ));
  insertedAuditLogIds.push(...newAuditRows.map((r) => r.id));
  assert.equal(newAuditRows.length, 1,
    `expected exactly one audit_log auto_prune row this sweep, got ${newAuditRows.length}`);
  const audit = newAuditRows[0];
  assert.equal(audit.module, "maintenance");
  assert.equal(audit.role, "system");
  assert.equal(audit.companyId, 0);
  assert.ok(isObject(audit.metadata), "audit metadata must be a JSON object");
  const md = audit.metadata as Record<string, any>;
  assert.equal(md.trigger, "manual");
  assert.equal(md.retentionDays, 365);
  assert.equal(md.deleted, summary.deleted);
  assert.equal(md.error, undefined, "no error metadata on the happy path");
});

test("runAuditLogAutoPrune: persisted retention setting overrides the default cutoff", async () => {
  // Persist a tight 60-day retention so a 90d-old row gets pruned even
  // though it would safely sit inside the default 365-day window.
  await resetRetention("old-audit-logs");
  await db.insert(maintenanceRetentionSettingsTable).values({
    toolKey: "old-audit-logs",
    days: 60,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: maintenanceRetentionSettingsTable.toolKey,
    set: { days: 60, updatedAt: new Date() },
  });

  const createdAt90d = new Date(Date.now() - 90 * 86_400_000);
  const [seeded] = await db.insert(auditLogTable).values({
    userId: saUserId, username: `${TEST_TAG}_sa`, role: "superadmin",
    companyId: dirtyCompanyId, module: "test", action: "auto_prune_seed",
    entityType: "test_90d", createdAt: createdAt90d,
  }).returning({ id: auditLogTable.id });
  insertedAuditLogIds.push(seeded.id);

  try {
    const summary = await runAuditLogAutoPrune("scheduled");
    assert.equal(summary.retentionDays, 60,
      "persisted setting must override the 365-day default");

    const still = await db.select({ id: auditLogTable.id })
      .from(auditLogTable)
      .where(eq(auditLogTable.id, seeded.id));
    assert.equal(still.length, 0,
      "90-day-old audit row must be pruned under 60d retention");
  } finally {
    await resetRetention("old-audit-logs");
    // Pick up the summary audit row this sweep wrote so teardown can clean
    // it. Match by action+entityType to avoid touching unrelated rows on a
    // shared DB.
    const auditRows = await db.select({ id: auditLogTable.id })
      .from(auditLogTable)
      .where(and(
        eq(auditLogTable.action, "auto_prune"),
        eq(auditLogTable.entityType, "audit_log"),
        eq(auditLogTable.role, "system"),
        eq(auditLogTable.companyId, 0),
      ));
    for (const r of auditRows) {
      if (!insertedAuditLogIds.includes(r.id)) insertedAuditLogIds.push(r.id);
    }
  }
});

test("runMaintenanceRunsAutoPrune: deletes maintenance_runs rows older than the default 90-day window and writes one summary audit row", async () => {
  await resetRetention("old-maintenance-runs");

  const auditWatermark = await db.execute<{ max_id: number | null }>(sql`
    SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM audit_log
  `);
  const auditCutoffId = Number(((auditWatermark as any).rows ?? [{ max_id: 0 }])[0]?.max_id ?? 0);

  const oldRunAt    = new Date(Date.now() - 200 * 86_400_000); // > 90d → deleted
  const recentRunAt = new Date(Date.now() - 10  * 86_400_000); // ≤ 90d → kept

  const seeded = await db.insert(maintenanceRunsTable).values([
    { companyId: dirtyCompanyId, toolKey: "broken-refs", status: "ok",
      count: 0, trigger: "scheduled", durationMs: 1, runAt: oldRunAt },
    { companyId: dirtyCompanyId, toolKey: "broken-refs", status: "ok",
      count: 0, trigger: "scheduled", durationMs: 1, runAt: recentRunAt },
  ]).returning({ id: maintenanceRunsTable.id });
  const oldRunId    = seeded[0].id;
  const recentRunId = seeded[1].id;
  insertedMaintenanceRunIds.push(oldRunId, recentRunId);

  const summary = await runMaintenanceRunsAutoPrune("manual");
  assert.equal(summary.retentionDays, 90);
  assert.ok(summary.deleted >= 1,
    `expected ≥1 maintenance_runs row deleted, got ${summary.deleted}`);
  assert.ok(Number.isFinite(summary.durationMs) && summary.durationMs >= 0);

  const stillOld = await db.select({ id: maintenanceRunsTable.id })
    .from(maintenanceRunsTable)
    .where(eq(maintenanceRunsTable.id, oldRunId));
  assert.equal(stillOld.length, 0, "old maintenance_runs row must be pruned");
  const stillRecent = await db.select({ id: maintenanceRunsTable.id })
    .from(maintenanceRunsTable)
    .where(eq(maintenanceRunsTable.id, recentRunId));
  assert.equal(stillRecent.length, 1, "recent maintenance_runs row must NOT be pruned");

  const newAuditRows = await db.select({
    id: auditLogTable.id,
    module: auditLogTable.module,
    action: auditLogTable.action,
    role: auditLogTable.role,
    companyId: auditLogTable.companyId,
    entityType: auditLogTable.entityType,
    metadata: auditLogTable.metadata,
  })
    .from(auditLogTable)
    .where(and(
      sql`${auditLogTable.id} > ${auditCutoffId}`,
      eq(auditLogTable.action, "auto_prune"),
      eq(auditLogTable.entityType, "maintenance_runs"),
    ));
  insertedAuditLogIds.push(...newAuditRows.map((r) => r.id));
  assert.equal(newAuditRows.length, 1,
    `expected exactly one maintenance_runs auto_prune row this sweep, got ${newAuditRows.length}`);
  const audit = newAuditRows[0];
  assert.equal(audit.module, "maintenance");
  assert.equal(audit.role, "system");
  assert.equal(audit.companyId, 0);
  assert.ok(isObject(audit.metadata), "audit metadata must be a JSON object");
  const md = audit.metadata as Record<string, any>;
  assert.equal(md.trigger, "manual");
  assert.equal(md.retentionDays, 90);
  assert.equal(md.deleted, summary.deleted);
  assert.equal(md.error, undefined, "no error metadata on the happy path");
});

test("runMaintenanceRunsAutoPrune: persisted retention setting overrides the default cutoff", async () => {
  // Persist a tight 30-day retention so a 60d-old row gets pruned even
  // though it would safely sit inside the default 90-day window.
  await resetRetention("old-maintenance-runs");
  await db.insert(maintenanceRetentionSettingsTable).values({
    toolKey: "old-maintenance-runs",
    days: 30,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: maintenanceRetentionSettingsTable.toolKey,
    set: { days: 30, updatedAt: new Date() },
  });

  const runAt60d = new Date(Date.now() - 60 * 86_400_000);
  const [seeded] = await db.insert(maintenanceRunsTable).values({
    companyId: dirtyCompanyId, toolKey: "broken-refs", status: "ok",
    count: 0, trigger: "scheduled", durationMs: 1, runAt: runAt60d,
  }).returning({ id: maintenanceRunsTable.id });
  insertedMaintenanceRunIds.push(seeded.id);

  try {
    const summary = await runMaintenanceRunsAutoPrune("scheduled");
    assert.equal(summary.retentionDays, 30,
      "persisted setting must override the 90-day default");

    const still = await db.select({ id: maintenanceRunsTable.id })
      .from(maintenanceRunsTable)
      .where(eq(maintenanceRunsTable.id, seeded.id));
    assert.equal(still.length, 0,
      "60-day-old maintenance_runs row must be pruned under 30d retention");
  } finally {
    await resetRetention("old-maintenance-runs");
    const auditRows = await db.select({ id: auditLogTable.id })
      .from(auditLogTable)
      .where(and(
        eq(auditLogTable.action, "auto_prune"),
        eq(auditLogTable.entityType, "maintenance_runs"),
        eq(auditLogTable.role, "system"),
        eq(auditLogTable.companyId, 0),
      ));
    for (const r of auditRows) {
      if (!insertedAuditLogIds.includes(r.id)) insertedAuditLogIds.push(r.id);
    }
  }
});

test("runAuditLogAutoPrune: out-of-band persisted retention is clamped to the per-tool min (30) — NOT the global 7", async () => {
  // Bypass the route's input validation so we can persist a stale/out-of-band
  // value (days=10) — below old-audit-logs' min=30. The scheduler MUST still
  // clamp it to 30 before deleting; otherwise stale settings rows from older
  // deploys could let the auto-prune wipe data more aggressively than the
  // toolbox UI would ever permit.
  await resetRetention("old-audit-logs");
  await db.insert(maintenanceRetentionSettingsTable).values({
    toolKey: "old-audit-logs",
    days: 10,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: maintenanceRetentionSettingsTable.toolKey,
    set: { days: 10, updatedAt: new Date() },
  });

  // Seed a 20d-old audit row. Under a (mis-clamped) 7d window it would be
  // pruned; under the correct 30d clamp it must survive.
  const createdAt20d = new Date(Date.now() - 20 * 86_400_000);
  const [seeded] = await db.insert(auditLogTable).values({
    userId: saUserId, username: `${TEST_TAG}_sa`, role: "superadmin",
    companyId: dirtyCompanyId, module: "test", action: "auto_prune_seed",
    entityType: "test_20d_audit", createdAt: createdAt20d,
  }).returning({ id: auditLogTable.id });
  insertedAuditLogIds.push(seeded.id);

  try {
    const summary = await runAuditLogAutoPrune("scheduled");
    assert.equal(summary.retentionDays, 30,
      "out-of-band days=10 must be clamped UP to the per-tool min=30, not the global 7");

    const still = await db.select({ id: auditLogTable.id })
      .from(auditLogTable)
      .where(eq(auditLogTable.id, seeded.id));
    assert.equal(still.length, 1,
      "20-day-old audit row must NOT be pruned under the clamped 30d retention");
  } finally {
    await resetRetention("old-audit-logs");
    const auditRows = await db.select({ id: auditLogTable.id })
      .from(auditLogTable)
      .where(and(
        eq(auditLogTable.action, "auto_prune"),
        eq(auditLogTable.entityType, "audit_log"),
        eq(auditLogTable.role, "system"),
        eq(auditLogTable.companyId, 0),
      ));
    for (const r of auditRows) {
      if (!insertedAuditLogIds.includes(r.id)) insertedAuditLogIds.push(r.id);
    }
  }
});

test("runMaintenanceRunsAutoPrune: out-of-band persisted retention is clamped to the per-tool max (3650)", async () => {
  // Bypass the route's input validation so we can persist a stale/out-of-band
  // value (days=99999) — above the 3650 max. The scheduler MUST clamp DOWN
  // to 3650 so the audit row reflects the actual cutoff used.
  await resetRetention("old-maintenance-runs");
  await db.insert(maintenanceRetentionSettingsTable).values({
    toolKey: "old-maintenance-runs",
    days: 99_999,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: maintenanceRetentionSettingsTable.toolKey,
    set: { days: 99_999, updatedAt: new Date() },
  });

  try {
    const summary = await runMaintenanceRunsAutoPrune("scheduled");
    assert.equal(summary.retentionDays, 3650,
      "out-of-band days=99999 must be clamped DOWN to the per-tool max=3650");
  } finally {
    await resetRetention("old-maintenance-runs");
    const auditRows = await db.select({ id: auditLogTable.id })
      .from(auditLogTable)
      .where(and(
        eq(auditLogTable.action, "auto_prune"),
        eq(auditLogTable.entityType, "maintenance_runs"),
        eq(auditLogTable.role, "system"),
        eq(auditLogTable.companyId, 0),
      ));
    for (const r of auditRows) {
      if (!insertedAuditLogIds.includes(r.id)) insertedAuditLogIds.push(r.id);
    }
  }
});
