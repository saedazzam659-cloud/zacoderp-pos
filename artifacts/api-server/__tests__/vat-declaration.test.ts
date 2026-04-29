// Integration tests for the tenant-facing VAT declaration report
// (artifacts/api-server/src/routes/reports.ts → /api/reports/vat-declaration).
//
// What this protects:
//   • The endpoint must aggregate output VAT (sales_invoices − sales_returns)
//     and input VAT (purchase_invoices − purchase_returns) from the four
//     canonical accounting tables, all gated to status='posted'. This is the
//     contract the Arabic VAT declaration page relies on. Any silent change
//     in column names, status enum values, or the math used to derive the
//     taxable base would invalidate the legal-grade report.
//
// How to run:
//   pnpm --filter @workspace/api-server test
//
// Notes:
//   - Boots the Express app in-process on a random port (no external server
//     required). Uses the real DB (DATABASE_URL).
//   - Seeds and cleans up its own data tagged with a per-run TEST_TAG.
//     Cleanup deletes strictly by tracked primary keys — never LIKE — so
//     no risk of touching real tenant data.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";

import bcrypt from "bcryptjs";
import { inArray } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  companiesTable,
  salesInvoicesTable,
  salesReturnsTable,
  purchaseInvoicesTable,
  purchaseReturnsTable,
  invoicesTable,
  accountsTable,
  journalEntriesTable,
  journalEntryLinesTable,
} from "@workspace/db";

import app from "../src/app.ts";

// ─── Test scoping ───────────────────────────────────────────────────────────
const TEST_TAG = `tt_vat_${randomBytes(4).toString("hex")}`;

let server: http.Server;
let baseUrl: string;

let adminUserId: number;
let adminToken: string;
let testCompanyId: number;

const insertedCompanyIds:    number[] = [];
const insertedUserIds:       number[] = [];
const insertedSalesInvIds:   number[] = [];
const insertedSalesRetIds:   number[] = [];
const insertedPurchInvIds:   number[] = [];
const insertedPurchRetIds:   number[] = [];
const insertedLegacyInvIds:  number[] = [];
const insertedJournalIds:    number[] = [];
const insertedAccountIds:    number[] = [];

// VAT account ids seeded for the test company so the report's
// `journalAdjustments` aggregator has accounts to look up. These mirror
// the default codes (21041 / 11071) shipped in the seed chart of accounts.
let vatOutputAccountId: number;
let vatInputAccountId:  number;

// Fixed "current" period the test seeds into. Using a date FAR in the past
// keeps the seeded rows out of any other test's "this month" window and
// guarantees the period we query has stable, hand-computed expected values.
const PERIOD_FROM = "2024-01-01";
const PERIOD_TO   = "2024-01-31";
const IN_PERIOD   = "2024-01-15";
const OUT_PERIOD  = "2024-02-15";

// ─── Response shape mirrors what the frontend consumes ─────────────────────
interface Bucket { base: number; vat: number; count: number }
interface VATResponse {
  period: { from: string; to: string };
  company: { nameAr: string } | null;
  outputTax: { standardRated: Bucket; zeroRated: Bucket; exempt: Bucket; total: Bucket };
  inputTax:  { standardRated: Bucket; zeroRated: Bucket; exempt: Bucket; total: Bucket };
  returns:   { sales: Bucket; purchases: Bucket };
  netVat: number;
  discountTotal: number;
  invoiceBreakdown: { totalCount: number };
}

interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

async function api<T = unknown>(path: string, opts: { token?: string; query?: Record<string, string> } = {}): Promise<ApiResponse<T>> {
  const url = new URL(baseUrl + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
  }
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  let body: unknown = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  return { status: res.status, body: body as T };
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

  // Seed a tenant company.
  const companyValues: typeof companiesTable.$inferInsert = {
    nameAr: `${TEST_TAG} شركة الإقرار`,
    nameEn: `${TEST_TAG} VAT Co`,
    vatNumber: "300000000000003",
    crNumber: "1010000002",
    city: "Riyadh",
    street: "Test St",
    buildingNumber: "1",
    postalCode: "12345",
    country: "SA",
    invoiceType: "both",
    status: "active",
  };
  const [co] = await db.insert(companiesTable).values(companyValues).returning({ id: companiesTable.id });
  testCompanyId = co.id;
  insertedCompanyIds.push(testCompanyId);

  // Seed a regular admin user scoped to this company. resolveCompanyId() will
  // force the report to this tenant's data because the user is not a
  // superadmin.
  adminToken = "tt_vat_admin_" + randomBytes(16).toString("hex");
  const pwHash = await bcrypt.hash("ignored-test-pw", 4);
  const [u] = await db.insert(usersTable).values({
    username: `${TEST_TAG}_admin`,
    email: null,
    passwordHash: pwHash,
    role: "admin",
    isActive: true,
    sessionToken: adminToken,
    sessionId: "test",
    companyId: testCompanyId,
  }).returning({ id: usersTable.id });
  adminUserId = u.id;
  insertedUserIds.push(adminUserId);

  // ── Seed posted sales invoices ────────────────────────────────────────────
  // 1) Standard-rated, in period: subtotal=1000, vat=150, discount=0
  const [si1] = await db.insert(salesInvoicesTable).values({
    companyId: testCompanyId, invoiceDate: IN_PERIOD, paymentType: "credit",
    currencyCode: "SAR", exchangeRate: "1",
    subtotal: "1000.00", vatAmount: "150.00", discountAmount: "0.00", totalAmount: "1150.00",
    status: "posted", docNumber: `${TEST_TAG}-SI-1`,
  }).returning({ id: salesInvoicesTable.id });
  insertedSalesInvIds.push(si1.id);

  // 2) Standard-rated, in period, with discount: subtotal=500 disc=100 vat=60
  const [si2] = await db.insert(salesInvoicesTable).values({
    companyId: testCompanyId, invoiceDate: IN_PERIOD, paymentType: "credit",
    currencyCode: "SAR", exchangeRate: "1",
    subtotal: "500.00", vatAmount: "60.00", discountAmount: "100.00", totalAmount: "460.00",
    status: "posted", docNumber: `${TEST_TAG}-SI-2`,
  }).returning({ id: salesInvoicesTable.id });
  insertedSalesInvIds.push(si2.id);

  // 3) Zero-rated, in period: vat=0 base>0
  const [si3] = await db.insert(salesInvoicesTable).values({
    companyId: testCompanyId, invoiceDate: IN_PERIOD, paymentType: "credit",
    currencyCode: "SAR", exchangeRate: "1",
    subtotal: "200.00", vatAmount: "0.00", discountAmount: "0.00", totalAmount: "200.00",
    status: "posted", docNumber: `${TEST_TAG}-SI-3`,
  }).returning({ id: salesInvoicesTable.id });
  insertedSalesInvIds.push(si3.id);

  // 4) DRAFT — must NOT be counted
  const [si4] = await db.insert(salesInvoicesTable).values({
    companyId: testCompanyId, invoiceDate: IN_PERIOD, paymentType: "credit",
    currencyCode: "SAR", exchangeRate: "1",
    subtotal: "9999.00", vatAmount: "999.00", discountAmount: "0.00", totalAmount: "10998.00",
    status: "draft", docNumber: `${TEST_TAG}-SI-DRAFT`,
  }).returning({ id: salesInvoicesTable.id });
  insertedSalesInvIds.push(si4.id);

  // 5) Posted but OUT of period — must NOT be counted
  const [si5] = await db.insert(salesInvoicesTable).values({
    companyId: testCompanyId, invoiceDate: OUT_PERIOD, paymentType: "credit",
    currencyCode: "SAR", exchangeRate: "1",
    subtotal: "8888.00", vatAmount: "888.00", discountAmount: "0.00", totalAmount: "9776.00",
    status: "posted", docNumber: `${TEST_TAG}-SI-FUTURE`,
  }).returning({ id: salesInvoicesTable.id });
  insertedSalesInvIds.push(si5.id);

  // ── Seed a posted sales return: reduces output VAT ───────────────────────
  // totalAmount on returns is VAT-INCLUSIVE (the form's lineTotal includes
  // VAT — see SalesReturns.tsx calcLineTotal — so the persisted total is
  // base + vat − discount). The handler recovers the base via
  // totalAmount − vatAmount → 115 − 15 = 100.
  const [sr1] = await db.insert(salesReturnsTable).values({
    companyId: testCompanyId, returnDate: IN_PERIOD, paymentType: "credit",
    currencyCode: "SAR", exchangeRate: "1",
    totalAmount: "115.00", vatAmount: "15.00", discountAmount: "0.00",
    status: "posted", docNumber: `${TEST_TAG}-SR-1`,
  }).returning({ id: salesReturnsTable.id });
  insertedSalesRetIds.push(sr1.id);

  // ── Seed posted purchase invoices ────────────────────────────────────────
  const [pi1] = await db.insert(purchaseInvoicesTable).values({
    companyId: testCompanyId, invoiceDate: IN_PERIOD, paymentType: "credit",
    currencyCode: "SAR", exchangeRate: "1",
    subtotal: "400.00", vatAmount: "60.00", discountAmount: "0.00", totalAmount: "460.00",
    status: "posted", docNumber: `${TEST_TAG}-PI-1`,
  }).returning({ id: purchaseInvoicesTable.id });
  insertedPurchInvIds.push(pi1.id);

  // Draft purchase — must NOT be counted
  const [pi2] = await db.insert(purchaseInvoicesTable).values({
    companyId: testCompanyId, invoiceDate: IN_PERIOD, paymentType: "credit",
    currencyCode: "SAR", exchangeRate: "1",
    subtotal: "5555.00", vatAmount: "555.00", discountAmount: "0.00", totalAmount: "6110.00",
    status: "draft", docNumber: `${TEST_TAG}-PI-DRAFT`,
  }).returning({ id: purchaseInvoicesTable.id });
  insertedPurchInvIds.push(pi2.id);

  // ── Seed a posted purchase return ────────────────────────────────────────
  // Same VAT-inclusive convention as sales returns: base = 50, vat = 7.50,
  // totalAmount stored = 57.50.
  const [pr1] = await db.insert(purchaseReturnsTable).values({
    companyId: testCompanyId, returnDate: IN_PERIOD, paymentType: "credit",
    currencyCode: "SAR", exchangeRate: "1",
    totalAmount: "57.50", vatAmount: "7.50", discountAmount: "0.00",
    status: "posted", docNumber: `${TEST_TAG}-PR-1`,
  }).returning({ id: purchaseReturnsTable.id });
  insertedPurchRetIds.push(pr1.id);

  // ── Seed legacy ZATCA invoices (status='issued' is the post equivalent) ──
  // These come from the parallel POST /api/invoices flow. The report MUST
  // include them additively so tenants who only use the legacy ZATCA
  // endpoint do not silently disappear from the declaration.
  // Issued in-period: subtotal=300, vat=45, discount=0, type='standard'
  const [li1] = await db.insert(invoicesTable).values({
    companyId: testCompanyId,
    invoiceNumber: `${TEST_TAG}-LI-1`,
    invoiceType: "standard",
    status: "issued",
    issueDate: IN_PERIOD,
    subtotal: "300.00",
    vatTotal: "45.00",
    discountTotal: "0.00",
    grandTotal: "345.00",
  }).returning({ id: invoicesTable.id });
  insertedLegacyInvIds.push(li1.id);

  // Draft legacy invoice — must NOT be counted (status filter on legacy
  // table uses 'issued', not 'draft').
  const [li2] = await db.insert(invoicesTable).values({
    companyId: testCompanyId,
    invoiceNumber: `${TEST_TAG}-LI-DRAFT`,
    invoiceType: "standard",
    status: "draft",
    issueDate: IN_PERIOD,
    subtotal: "7777.00",
    vatTotal: "777.00",
    discountTotal: "0.00",
    grandTotal: "8554.00",
  }).returning({ id: invoicesTable.id });
  insertedLegacyInvIds.push(li2.id);

  // ── Seed VAT accounts (chart of accounts) ────────────────────────────────
  // Use the default codes (21041 / 11071) so the report's
  // resolveVatAccountIds() falls back to them via the accounts table.
  const [vatOutAcct] = await db.insert(accountsTable).values({
    companyId: testCompanyId,
    code: "21041",
    nameAr: `${TEST_TAG} ضريبة المخرجات`,
    nameEn: `${TEST_TAG} VAT output`,
    accountType: "liability",
    level: 4,
    isPosting: true,
    isActive: true,
  }).returning({ id: accountsTable.id });
  vatOutputAccountId = vatOutAcct.id;
  insertedAccountIds.push(vatOutputAccountId);

  const [vatInAcct] = await db.insert(accountsTable).values({
    companyId: testCompanyId,
    code: "11071",
    nameAr: `${TEST_TAG} ضريبة المدخلات`,
    nameEn: `${TEST_TAG} VAT input`,
    accountType: "asset",
    level: 4,
    isPosting: true,
    isActive: true,
  }).returning({ id: accountsTable.id });
  vatInputAccountId = vatInAcct.id;
  insertedAccountIds.push(vatInputAccountId);

  // A non-VAT account so we can prove the aggregator only sums VAT lines.
  const [otherAcct] = await db.insert(accountsTable).values({
    companyId: testCompanyId,
    code: "11011",
    nameAr: `${TEST_TAG} الصندوق`,
    nameEn: `${TEST_TAG} Cash`,
    accountType: "asset",
    level: 4,
    isPosting: true,
    isActive: true,
  }).returning({ id: accountsTable.id });
  insertedAccountIds.push(otherAcct.id);

  // ── Seed manual journal entries (VAT adjustments) ─────────────────────────
  // JE-1: posted, in period, manual ('general'). Credits VAT output by 25
  // (additional output VAT due) — should ADD 25 to journalAdjustments.outputVat.
  const [je1] = await db.insert(journalEntriesTable).values({
    companyId: testCompanyId,
    docNumber: `${TEST_TAG}-JE-1`,
    entryDate: IN_PERIOD,
    description: "VAT correction (auditor adjustment)",
    entryType: "general",
    status: "posted",
  }).returning({ id: journalEntriesTable.id });
  insertedJournalIds.push(je1.id);
  await db.insert(journalEntryLinesTable).values([
    { entryId: je1.id, accountId: otherAcct.id, debit: "25.00", credit: "0.00", sortOrder: 0 },
    { entryId: je1.id, accountId: vatOutputAccountId, debit: "0.00", credit: "25.00", sortOrder: 1 },
  ]);

  // JE-2: posted, in period, manual. Debits VAT input by 10
  // (additional recoverable VAT) — should ADD 10 to journalAdjustments.inputVat.
  const [je2] = await db.insert(journalEntriesTable).values({
    companyId: testCompanyId,
    docNumber: `${TEST_TAG}-JE-2`,
    entryDate: IN_PERIOD,
    description: "Recoverable VAT correction",
    entryType: "general",
    status: "posted",
  }).returning({ id: journalEntriesTable.id });
  insertedJournalIds.push(je2.id);
  await db.insert(journalEntryLinesTable).values([
    { entryId: je2.id, accountId: vatInputAccountId, debit: "10.00", credit: "0.00", sortOrder: 0 },
    { entryId: je2.id, accountId: otherAcct.id, debit: "0.00", credit: "10.00", sortOrder: 1 },
  ]);

  // JE-3: posted but auto-generated from a sales invoice — MUST be filtered
  // out so VAT impact is not double counted with the invoice tables above.
  const [je3] = await db.insert(journalEntriesTable).values({
    companyId: testCompanyId,
    docNumber: `${TEST_TAG}-JE-AUTO`,
    entryDate: IN_PERIOD,
    description: "Auto JE from sales invoice",
    entryType: "sales_invoice",
    status: "posted",
  }).returning({ id: journalEntriesTable.id });
  insertedJournalIds.push(je3.id);
  await db.insert(journalEntryLinesTable).values([
    { entryId: je3.id, accountId: otherAcct.id, debit: "9999.00", credit: "0.00", sortOrder: 0 },
    { entryId: je3.id, accountId: vatOutputAccountId, debit: "0.00", credit: "9999.00", sortOrder: 1 },
  ]);

  // JE-4: DRAFT — must be excluded by status filter.
  const [je4] = await db.insert(journalEntriesTable).values({
    companyId: testCompanyId,
    docNumber: `${TEST_TAG}-JE-DRAFT`,
    entryDate: IN_PERIOD,
    description: "Draft adjustment (should not count)",
    entryType: "general",
    status: "draft",
  }).returning({ id: journalEntriesTable.id });
  insertedJournalIds.push(je4.id);
  await db.insert(journalEntryLinesTable).values([
    { entryId: je4.id, accountId: otherAcct.id, debit: "5000.00", credit: "0.00", sortOrder: 0 },
    { entryId: je4.id, accountId: vatOutputAccountId, debit: "0.00", credit: "5000.00", sortOrder: 1 },
  ]);

  // JE-5: posted but OUT of period — must be excluded by date filter.
  const [je5] = await db.insert(journalEntriesTable).values({
    companyId: testCompanyId,
    docNumber: `${TEST_TAG}-JE-FUTURE`,
    entryDate: OUT_PERIOD,
    description: "Future adjustment (should not count)",
    entryType: "general",
    status: "posted",
  }).returning({ id: journalEntriesTable.id });
  insertedJournalIds.push(je5.id);
  await db.insert(journalEntryLinesTable).values([
    { entryId: je5.id, accountId: otherAcct.id, debit: "8000.00", credit: "0.00", sortOrder: 0 },
    { entryId: je5.id, accountId: vatOutputAccountId, debit: "0.00", credit: "8000.00", sortOrder: 1 },
  ]);
});

after(async () => {
  // Strict ID-based deletes — never LIKE — so we cannot touch real data.
  // Journal lines cascade-delete via the FK to journal_entries; deleting
  // the entries is enough.
  if (insertedJournalIds.length)
    await db.delete(journalEntriesTable).where(inArray(journalEntriesTable.id, insertedJournalIds));
  if (insertedAccountIds.length)
    await db.delete(accountsTable).where(inArray(accountsTable.id, insertedAccountIds));
  if (insertedSalesInvIds.length)
    await db.delete(salesInvoicesTable).where(inArray(salesInvoicesTable.id, insertedSalesInvIds));
  if (insertedSalesRetIds.length)
    await db.delete(salesReturnsTable).where(inArray(salesReturnsTable.id, insertedSalesRetIds));
  if (insertedPurchInvIds.length)
    await db.delete(purchaseInvoicesTable).where(inArray(purchaseInvoicesTable.id, insertedPurchInvIds));
  if (insertedPurchRetIds.length)
    await db.delete(purchaseReturnsTable).where(inArray(purchaseReturnsTable.id, insertedPurchRetIds));
  if (insertedLegacyInvIds.length)
    await db.delete(invoicesTable).where(inArray(invoicesTable.id, insertedLegacyInvIds));
  if (insertedUserIds.length)
    await db.delete(usersTable).where(inArray(usersTable.id, insertedUserIds));
  if (insertedCompanyIds.length)
    await db.delete(companiesTable).where(inArray(companiesTable.id, insertedCompanyIds));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ─── Tests ──────────────────────────────────────────────────────────────────
test("rejects without auth token", async () => {
  const r = await api("/api/reports/vat-declaration", { query: { from: PERIOD_FROM, to: PERIOD_TO } });
  assert.equal(r.status, 401);
});

test("rejects with missing date params", async () => {
  const r = await api("/api/reports/vat-declaration", { token: adminToken });
  assert.equal(r.status, 400);
});

test("aggregates output VAT from posted sales invoices + legacy ZATCA invoices, excluding drafts and out-of-period rows", async () => {
  const r = await api<VATResponse>("/api/reports/vat-declaration", {
    token: adminToken,
    query: { from: PERIOD_FROM, to: PERIOD_TO },
  });
  assert.equal(r.status, 200);
  const b = r.body;

  // Standard-rated output (NEW behaviour: combines sales_invoices and the
  // legacy ZATCA invoicesTable, then nets sales returns):
  //   SI-1 (base=1000, vat=150)
  // + SI-2 (base=400,  vat=60)    [subtotal=500 − discount=100]
  // + LI-1 (base=300,  vat=45)    [legacy ZATCA, status='issued']
  // − SR-1 (base=100,  vat=15)
  // ─────────────────────────────
  //   standardRated.base = 1000 + 400 + 300 − 100 = 1600
  //   standardRated.vat  = 150  + 60  + 45  − 15  = 240
  assert.ok(Math.abs(b.outputTax.standardRated.base - 1600) < 0.01,
    `standardRated.base expected 1600, got ${b.outputTax.standardRated.base}`);
  assert.ok(Math.abs(b.outputTax.standardRated.vat - 240) < 0.01,
    `standardRated.vat expected 240, got ${b.outputTax.standardRated.vat}`);

  // Zero-rated output: SI-3 (base=200, vat=0)
  assert.ok(Math.abs(b.outputTax.zeroRated.base - 200) < 0.01,
    `zeroRated.base expected 200, got ${b.outputTax.zeroRated.base}`);
  assert.equal(b.outputTax.zeroRated.vat, 0);

  // Drafts and out-of-period docs (sales OR legacy) must NOT appear.
  // Total output VAT = 240 (zero-rated contributes 0).
  assert.ok(Math.abs(b.outputTax.total.vat - 240) < 0.01,
    `outputTax.total.vat expected 240, got ${b.outputTax.total.vat}`);
});

test("aggregates input VAT from posted purchase invoices and subtracts purchase returns", async () => {
  const r = await api<VATResponse>("/api/reports/vat-declaration", {
    token: adminToken,
    query: { from: PERIOD_FROM, to: PERIOD_TO },
  });
  assert.equal(r.status, 200);
  const b = r.body;

  // Input VAT: PI-1 (base=400, vat=60) − PR-1 (base=50, vat=7.5)
  //   inputTax.standardRated.base = 350
  //   inputTax.standardRated.vat  = 52.5
  // (Purchase return base recovered from VAT-inclusive totalAmount: 57.5 − 7.5 = 50)
  assert.ok(Math.abs(b.inputTax.standardRated.base - 350) < 0.01,
    `inputTax.standardRated.base expected 350, got ${b.inputTax.standardRated.base}`);
  assert.ok(Math.abs(b.inputTax.standardRated.vat - 52.5) < 0.01,
    `inputTax.standardRated.vat expected 52.5, got ${b.inputTax.standardRated.vat}`);

  // Net VAT (invoice side only) = output (240) − input (52.5) = 187.5
  // The full netVat is asserted separately in the journalAdjustments test
  // (which adds +25 output / +10 input from manual JEs → 202.5).
  const invoiceOnlyNet = b.outputTax.total.vat - b.inputTax.total.vat;
  assert.ok(Math.abs(invoiceOnlyNet - 187.5) < 0.01,
    `invoice-side netVat expected 187.5, got ${invoiceOnlyNet}`);
});

test("surfaces returns separately as positive deductions for the frontend disclosure", async () => {
  const r = await api<VATResponse>("/api/reports/vat-declaration", {
    token: adminToken,
    query: { from: PERIOD_FROM, to: PERIOD_TO },
  });
  assert.equal(r.status, 200);
  const b = r.body;

  // returns.sales.vat = 15 (the SR-1 vat amount)
  assert.ok(Math.abs(b.returns.sales.vat - 15) < 0.01,
    `returns.sales.vat expected 15, got ${b.returns.sales.vat}`);
  assert.equal(b.returns.sales.count, 1, "returns.sales.count expected 1");

  // returns.purchases.vat = 7.5 (the PR-1 vat amount)
  assert.ok(Math.abs(b.returns.purchases.vat - 7.5) < 0.01,
    `returns.purchases.vat expected 7.5, got ${b.returns.purchases.vat}`);
  assert.equal(b.returns.purchases.count, 1, "returns.purchases.count expected 1");
});

test("invoiceBreakdown.totalCount counts posted sales invoices + issued legacy invoices in window", async () => {
  const r = await api<VATResponse>("/api/reports/vat-declaration", {
    token: adminToken,
    query: { from: PERIOD_FROM, to: PERIOD_TO },
  });
  assert.equal(r.status, 200);
  // Posted in-period sales invoices: SI-1, SI-2, SI-3 = 3
  // + Issued in-period legacy invoices: LI-1 = 1
  // = 4. Drafts (SI-DRAFT, LI-DRAFT) and out-of-period (SI-FUTURE) excluded.
  assert.equal(r.body.invoiceBreakdown.totalCount, 4);
});

test("returns the seeded company info on the report header", async () => {
  const r = await api<VATResponse>("/api/reports/vat-declaration", {
    token: adminToken,
    query: { from: PERIOD_FROM, to: PERIOD_TO },
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.company, "company block must be present");
  assert.ok(r.body.company!.nameAr.includes(TEST_TAG), "company nameAr must match seeded tenant");
});

test("includes manual journal-entry VAT adjustments in the report", async () => {
  // Manual JEs (entryType='general') that touch the VAT output / VAT input
  // accounts must surface in `journalAdjustments` and feed into netVat.
  // Specifically:
  //   • JE-1 credits VAT-output by 25 → outputVat += 25
  //   • JE-2 debits  VAT-input  by 10 → inputVat  += 10
  //   • JE-AUTO (entryType='sales_invoice') is auto-generated → MUST be filtered out.
  //   • JE-DRAFT is draft → MUST be filtered out.
  //   • JE-FUTURE is out of period → MUST be filtered out.
  const r = await api<VATResponse & {
    journalAdjustments: {
      outputVat: number;
      inputVat: number;
      entryCount: number;
      entries: Array<{ id: number; docNumber: string | null; entryType: string; outputVat: number; inputVat: number }>;
    };
  }>("/api/reports/vat-declaration", {
    token: adminToken,
    query: { from: PERIOD_FROM, to: PERIOD_TO },
  });
  assert.equal(r.status, 200);
  const ja = r.body.journalAdjustments;
  assert.ok(ja, "journalAdjustments block must be present");

  assert.equal(ja.entryCount, 2, `expected 2 manual VAT JEs, got ${ja.entryCount}`);
  assert.ok(Math.abs(ja.outputVat - 25) < 0.01, `journalAdjustments.outputVat expected 25, got ${ja.outputVat}`);
  assert.ok(Math.abs(ja.inputVat - 10)  < 0.01, `journalAdjustments.inputVat expected 10, got ${ja.inputVat}`);

  // None of the surfaced entries may carry an auto-generated entryType.
  for (const e of ja.entries) {
    assert.notEqual(e.entryType, "sales_invoice",   "auto-generated entry leaked into adjustments");
    assert.notEqual(e.entryType, "purchase_invoice","auto-generated entry leaked into adjustments");
  }

  // netVat must now reflect the adjustments:
  //   invoice-side: output 240, input 52.5 → 187.5
  //   adjustments:  output  25, input 10   → +25 − 10 = +15
  //   netVat = 187.5 + 15 = 202.5
  assert.ok(Math.abs(r.body.netVat - 202.5) < 0.01,
    `netVat with adjustments expected 202.5, got ${r.body.netVat}`);
});

test("rejects malformed date params with a clear 400 (no silent timezone shift)", async () => {
  // Anything other than strict YYYY-MM-DD must be rejected. We do NOT want
  // the handler to silently re-parse "2024-01-01T00:00:00+03:00" into a
  // different calendar day depending on server timezone.
  const cases = [
    { from: "2024-1-1",                 to: "2024-01-31" },          // missing zero pad
    { from: "01/01/2024",               to: "31/01/2024" },          // wrong separator
    { from: "2024-01-01T00:00:00Z",     to: "2024-01-31" },          // full ISO timestamp
    { from: "2024-01-32",               to: "2024-01-31" },          // invalid day
    { from: "not-a-date",               to: "2024-01-31" },
  ];
  for (const q of cases) {
    const r = await api<{ error: string }>("/api/reports/vat-declaration", { token: adminToken, query: q });
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(q)}, got ${r.status}`);
    assert.ok((r.body as any)?.error, `expected error message for ${JSON.stringify(q)}`);
  }
});
