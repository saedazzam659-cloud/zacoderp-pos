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
});

after(async () => {
  // Strict ID-based deletes — never LIKE — so we cannot touch real data.
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

  // Net VAT = output (240) − input (52.5) = 187.5
  assert.ok(Math.abs(b.netVat - 187.5) < 0.01,
    `netVat expected 187.5, got ${b.netVat}`);
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
