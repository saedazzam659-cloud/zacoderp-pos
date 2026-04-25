// Integration tests for the SuperAdmin cross-company reports endpoints
// (artifacts/api-server/src/routes/admin.ts → /api/admin/reports/*).
//
// What this protects:
//   • The 4 cross-company report endpoints aggregate data from sales_invoices,
//     customers, suppliers, items, pos_sessions, audit_log, auto_backups,
//     subscriptions and plan_configs. A schema change in any of those tables
//     could silently break a report (e.g. column rename, status enum change).
//     These tests pin the current API contract: every preset's window math,
//     auth/validation gates, CSV encoding, and the revenue → company-performance
//     pipeline.
//
// How to run:
//   pnpm --filter @workspace/api-server test
//
// Notes:
//   - Boots the Express app in-process on a random port (no external server
//     required). Uses the real DB (DATABASE_URL).
//   - Seeds and tears down its own data tagged with a per-run TEST_TAG. Other
//     tenants are not touched.

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
  subscriptionsTable,
  salesInvoicesTable,
} from "@workspace/db";

import app from "../src/app.ts";

// ─── Test scoping ───────────────────────────────────────────────────────────
// Per-run prefix used purely for human-readable identification of seeded rows
// (e.g. when inspecting the DB after a crash). It is NEVER used in any DELETE
// query — cleanup deletes strictly by the IDs we tracked at insert time so
// there is zero risk of nuking real tenant data.
const TEST_TAG = `tt_admin_reports_${randomBytes(4).toString("hex")}`;

let server: http.Server;
let baseUrl: string;

let saUserId: number;
let saToken: string;

let regularUserId: number;
let regularToken: string;

let testCompanyId: number;

// IDs of every row this run inserted, recorded right after each insert.
// Used by cleanup() to delete strictly by primary key — no LIKE, no
// wildcards, no risk of touching another tenant's data.
const insertedCompanyIds: number[] = [];
const insertedUserIds:    number[] = [];
const insertedInvoiceIds: number[] = [];

const todayISO = (): string => new Date().toISOString().slice(0, 10);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const utcDate = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

// Independent re-implementation of the parsePeriod expectations from
// admin.ts so the test isn't merely tautological. We compare the API's
// `period` block against this.
function expectedPeriod(preset: string, custom?: { from: string; to: string }) {
  const now = new Date();
  const Y = now.getUTCFullYear();
  const M = now.getUTCMonth();
  const Q = Math.floor(M / 3);
  let from: Date, to: Date;
  switch (preset) {
    case "this_month":   from = utcDate(Y, M,         1); to = utcDate(Y, M + 1,        0); break;
    case "last_month":   from = utcDate(Y, M - 1,     1); to = utcDate(Y, M,            0); break;
    case "this_quarter": from = utcDate(Y, Q * 3,     1); to = utcDate(Y, Q * 3 + 3,    0); break;
    case "last_quarter": from = utcDate(Y, (Q - 1)*3, 1); to = utcDate(Y, (Q - 1)*3 + 3,0); break;
    case "this_year":    from = utcDate(Y,     0,     1); to = utcDate(Y,    11,       31); break;
    case "last_year":    from = utcDate(Y - 1, 0,     1); to = utcDate(Y - 1, 11,      31); break;
    case "custom":
      from = new Date(custom!.from + "T00:00:00Z");
      to   = new Date(custom!.to   + "T00:00:00Z");
      break;
    default: throw new Error("unknown preset");
  }
  const fromMs = from.getTime();
  const toMs   = to.getTime();
  const days   = Math.round((toMs - fromMs) / 86_400_000) + 1;
  const prevToMs   = fromMs - 86_400_000;
  const prevFromMs = prevToMs - (days - 1) * 86_400_000;
  return {
    from:     isoDate(from),
    to:       isoDate(to),
    prevFrom: isoDate(new Date(prevFromMs)),
    prevTo:   isoDate(new Date(prevToMs)),
    days,
  };
}

// ─── Typed response shapes ──────────────────────────────────────────────────
// We mirror only the fields the tests actually consume so a real schema
// regression (renamed key, missing field) surfaces as a type-narrowing
// failure or assertion mismatch, not an `any` slip-through.
interface ErrorResponse { error: string }

interface ReportPeriod {
  from: string; to: string; prevFrom: string; prevTo: string; days: number;
}
interface CompanyPerfRow {
  companyId: number; companyName: string;
  revenue: number; invoiceCount: number; avgInvoice: number;
  prevRevenue: number; growthPct: number | null;
}
interface CompanyPerfResponse { period: ReportPeriod; rows: CompanyPerfRow[] }

interface RevenueByPlanRow {
  plan: string; billingCycle: string;
  subscriptionCount: number; totalBilled: number;
}
interface RevenueByPlanResponse {
  period: ReportPeriod; rows: RevenueByPlanRow[]; total: number;
}

interface SummaryResponse {
  period: { from: string; to: string };
  revenueMonth: number; billedActive: number;
  activeCompanies: number; overLimitSubs: number;
}

interface FetchOpts {
  token?: string;
  query?: Record<string, string | number | undefined>;
}

interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
  text: string;       // BOM-preserving decode
  bytes: Uint8Array;  // raw response bytes
}

async function api<T = unknown>(path: string, opts: FetchOpts = {}): Promise<ApiResponse<T>> {
  const url = new URL(baseUrl + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(url, { headers });
  // Use arrayBuffer + a BOM-preserving TextDecoder so the CSV BOM check below
  // can actually see the leading 0xEF 0xBB 0xBF bytes. WHATWG `Response.text()`
  // strips the BOM by default which would falsely fail those assertions.
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { body = text; }
  }
  return { status: res.status, body: body as T, headers: res.headers, text, bytes: buf };
}

// ─── Narrow helpers (no `any` casts in test bodies) ─────────────────────────
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function expectError(body: unknown): asserts body is ErrorResponse {
  assert.ok(isObject(body) && typeof body.error === "string",
    "response body must contain an `error` string");
}
function expectPeriod(body: unknown): asserts body is { period: ReportPeriod } {
  assert.ok(isObject(body) && isObject(body.period), "response must contain a `period` block");
  const p = body.period as Record<string, unknown>;
  for (const k of ["from", "to", "prevFrom", "prevTo"] as const) {
    assert.equal(typeof p[k], "string", `period.${k} must be string`);
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────
before(async () => {
  // 1. Start the Express app on a random port so multiple test runs can
  //    coexist with the dev server.
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server did not bind");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // 2. No defensive prefix-based cleanup — TEST_TAG is unique per run, and
  //    LIKE wildcards (`_`, `%`) would otherwise risk matching real rows.
  //    If a previous run crashed, its tagged rows remain orphaned but
  //    inert; they will not be matched by THIS run's IDs.

  // 3. Seed a SuperAdmin with a deterministic sessionToken (bypasses login).
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

  // 4. Seed a tenant company + active subscription so revenue rows aren't
  //    filtered out by the "active subscription" guard in admin.ts.
  // Strict typed insert (no `as any`): if a required column is renamed or
  // becomes non-nullable, the tests fail at compile/runtime — which is the
  // whole point of pinning the contract.
  const companyValues: typeof companiesTable.$inferInsert = {
    nameAr: `${TEST_TAG} شركة الاختبار`,
    nameEn: `${TEST_TAG} Test Co`,
    vatNumber: "300000000000003",
    crNumber: "1010000001",
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

  const today = todayISO();
  // End date 90 days in the future keeps the subscription "active" by every
  // report's definition (is_active=true AND end_date >= today).
  const ninetyDaysOut = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
  await db.insert(subscriptionsTable).values({
    companyId: testCompanyId,
    plan: "professional",
    maxUsers: 10,
    maxBranches: 3,
    maxWarehouses: 3,
    maxInvoices: 10_000,
    billingCycle: "monthly",
    startDate: today,
    endDate: ninetyDaysOut,
    isActive: true,
    price: "499.00",
  });

  // 5. Seed a regular (admin-role, not superadmin) user belonging to the
  //    tenant. Used for the 403 test.
  regularToken = "tt_user_" + randomBytes(16).toString("hex");
  const userHash = await bcrypt.hash("ignored-test-pw", 4);
  const regularValues: typeof usersTable.$inferInsert = {
    username: `${TEST_TAG}_user`,
    email: null,
    passwordHash: userHash,
    role: "admin",
    isActive: true,
    sessionToken: regularToken,
    sessionId: "test",
    companyId: testCompanyId,
  };
  const [u] = await db.insert(usersTable).values(regularValues).returning({ id: usersTable.id });
  regularUserId = u.id;
  insertedUserIds.push(regularUserId);
});

after(async () => {
  try { await cleanup(); } finally {
    if (server) await new Promise<void>(r => server.close(() => r()));
    // Drain the pg pool so the event loop can exit naturally — no
    // process.exit() needed (which would mask any pending teardown errors
    // and risks losing test runner output if the suite grows).
    try { await pool.end(); } catch { /* already ended is fine */ }
  }
});

async function cleanup(): Promise<void> {
  // Delete strictly by primary keys we recorded at insert time. No LIKE,
  // no wildcards, no prefix-matching — so there is zero possibility of
  // touching rows that belong to a real tenant.
  // FK order: invoices → users → subscriptions(by company) → companies.
  if (insertedInvoiceIds.length) {
    await db.delete(salesInvoicesTable).where(inArray(salesInvoicesTable.id, insertedInvoiceIds));
  }
  if (insertedUserIds.length) {
    await db.delete(usersTable).where(inArray(usersTable.id, insertedUserIds));
  }
  if (insertedCompanyIds.length) {
    // subscriptions tracked by companyId (we only created one per company).
    await db.delete(subscriptionsTable).where(inArray(subscriptionsTable.companyId, insertedCompanyIds));
    await db.delete(companiesTable).where(inArray(companiesTable.id, insertedCompanyIds));
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Auth gate
// ════════════════════════════════════════════════════════════════════════════
test("rejects request without bearer token (401)", async () => {
  const r = await api("/api/admin/reports/company-performance");
  assert.equal(r.status, 401);
  expectError(r.body);
});

test("rejects non-superadmin user (403)", async () => {
  const r = await api("/api/admin/reports/company-performance", { token: regularToken });
  assert.equal(r.status, 403);
  expectError(r.body);
});

test("accepts superadmin token (200)", async () => {
  const r = await api<CompanyPerfResponse>("/api/admin/reports/company-performance",
    { token: saToken });
  assert.equal(r.status, 200);
  expectPeriod(r.body);
});

// ════════════════════════════════════════════════════════════════════════════
//  Period preset windows — pin from/to/prevFrom/prevTo for each preset
// ════════════════════════════════════════════════════════════════════════════
const PRESETS = [
  "this_month", "last_month",
  "this_quarter", "last_quarter",
  "this_year", "last_year",
] as const;

for (const preset of PRESETS) {
  test(`period preset → ${preset}`, async () => {
    const r = await api<CompanyPerfResponse>("/api/admin/reports/company-performance", {
      token: saToken,
      query: { period: preset },
    });
    assert.equal(r.status, 200, `expected 200 got ${r.status}: ${r.text.slice(0, 200)}`);
    expectPeriod(r.body);
    const expected = expectedPeriod(preset);
    const actual = r.body.period;
    assert.equal(actual.from,     expected.from,     `${preset}.from`);
    assert.equal(actual.to,       expected.to,       `${preset}.to`);
    assert.equal(actual.prevFrom, expected.prevFrom, `${preset}.prevFrom`);
    assert.equal(actual.prevTo,   expected.prevTo,   `${preset}.prevTo`);
    // Symmetry guarantees:
    //   prevTo is the day immediately before `from`.
    //   prev window has the same length as the current window.
    const prevToDate = new Date(actual.prevTo + "T00:00:00Z");
    const fromDate   = new Date(actual.from   + "T00:00:00Z");
    assert.equal(fromDate.getTime() - prevToDate.getTime(), 86_400_000,
      `${preset}: prevTo must be exactly one day before from`);
    const currLen = (new Date(actual.to + "T00:00:00Z").getTime() - fromDate.getTime()) / 86_400_000 + 1;
    const prevLen = (prevToDate.getTime() - new Date(actual.prevFrom + "T00:00:00Z").getTime()) / 86_400_000 + 1;
    assert.equal(currLen, prevLen, `${preset}: previous window length must match current`);
  });
}

test("period preset → custom (from/to in query)", async () => {
  const from = "2025-03-01";
  const to   = "2025-03-31";
  const r = await api<CompanyPerfResponse>("/api/admin/reports/company-performance", {
    token: saToken,
    query: { period: "custom", from, to },
  });
  assert.equal(r.status, 200);
  expectPeriod(r.body);
  const actual = r.body.period;
  const expected = expectedPeriod("custom", { from, to });
  assert.deepEqual(
    { from: actual.from, to: actual.to, prevFrom: actual.prevFrom, prevTo: actual.prevTo },
    { from: expected.from, to: expected.to, prevFrom: expected.prevFrom, prevTo: expected.prevTo },
  );
  // 31 days in March → previous window must be exactly 31 days too.
  assert.equal(actual.prevTo,   "2025-02-28");
  assert.equal(actual.prevFrom, "2025-01-29");
});

// ════════════════════════════════════════════════════════════════════════════
//  Validation: malformed dates → 400
// ════════════════════════════════════════════════════════════════════════════
test("rejects custom period with invalid dates (400)", async () => {
  const cases: Array<Record<string, string>> = [
    { period: "custom", from: "not-a-date", to: "2025-03-31" },
    { period: "custom", from: "2025-03-01", to: "not-a-date" },
    { period: "custom", from: "2025-13-40", to: "2025-03-31" }, // out-of-range month/day
    { period: "custom", from: "2025-03-31", to: "2025-03-01" }, // to < from
  ];
  for (const q of cases) {
    const r = await api("/api/admin/reports/company-performance", { token: saToken, query: q });
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(q)} got ${r.status}`);
    expectError(r.body);
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  CSV export — UTF-8 BOM + Arabic headers
// ════════════════════════════════════════════════════════════════════════════
const CSV_REPORTS: Array<{ path: string; header: string }> = [
  { path: "/api/admin/reports/company-performance", header: "الشركة" },
  { path: "/api/admin/reports/operational-summary", header: "الشركة" },
  { path: "/api/admin/reports/plan-usage",          header: "الشركة" },
  { path: "/api/admin/reports/revenue-by-plan",     header: "الباقة" },
];

for (const r of CSV_REPORTS) {
  test(`CSV export starts with UTF-8 BOM and has Arabic header — ${r.path}`, async () => {
    const res = await api(r.path, {
      token: saToken,
      query: { format: "csv", period: "this_month" },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/csv/i,
      "Content-Type must be text/csv");
    // \uFEFF is the UTF-8 BOM. Check both the raw bytes (EF BB BF) and the
    // decoded character so we catch either form of regression.
    assert.equal(res.bytes[0], 0xEF, "byte[0] must be 0xEF");
    assert.equal(res.bytes[1], 0xBB, "byte[1] must be 0xBB");
    assert.equal(res.bytes[2], 0xBF, "byte[2] must be 0xBF");
    assert.equal(res.text.charCodeAt(0), 0xFEFF, "first character must be BOM");
    // First line (after BOM) holds the headers.
    const firstLine = res.text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
    assert.ok(firstLine.includes(r.header),
      `first line must contain Arabic header "${r.header}", got: ${firstLine}`);
    // Sanity: contains at least one Arabic letter (range U+0600..U+06FF).
    assert.match(firstLine, /[\u0600-\u06FF]/, "header line must contain Arabic characters");
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  Revenue accuracy — seed a posted invoice and verify it surfaces
// ════════════════════════════════════════════════════════════════════════════
test("company-performance reflects a freshly-posted invoice", async () => {
  const today = todayISO();
  const amount = "1234.56";
  const invoiceValues: typeof salesInvoicesTable.$inferInsert = {
    companyId: testCompanyId,
    invoiceDate: today,           // text column — ISO date string
    paymentType: "cash",
    currencyCode: "SAR",
    exchangeRate: "1",
    subtotal: amount,
    vatAmount: "0",
    discountAmount: "0",
    totalAmount: amount,
    status: "posted",
    docNumber: `${TEST_TAG}-INV-1`,
  };
  const [inv] = await db.insert(salesInvoicesTable).values(invoiceValues)
    .returning({ id: salesInvoicesTable.id });
  insertedInvoiceIds.push(inv.id);

  const r = await api<CompanyPerfResponse>("/api/admin/reports/company-performance", {
    token: saToken,
    query: { period: "this_month" },
  });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.rows), "company-performance must return rows array");
  const row = r.body.rows.find(x => x.companyId === testCompanyId);
  assert.ok(row, "test company must appear in company-performance rows");
  assert.equal(row.invoiceCount, 1, "should count exactly the seeded invoice");
  // Numeric tolerance — values come back as JS numbers.
  assert.ok(Math.abs(row.revenue - Number(amount)) < 0.001,
    `revenue should equal seeded amount, got ${row.revenue}`);
  assert.ok(Math.abs(row.avgInvoice - Number(amount)) < 0.001,
    `avgInvoice should equal seeded amount, got ${row.avgInvoice}`);
});

test("revenue-by-plan attributes seeded invoice to the company's plan", async () => {
  // The previous test already inserted the invoice; this verifies the
  // separate aggregation path used by /reports/revenue-by-plan.
  const r = await api<RevenueByPlanResponse>("/api/admin/reports/revenue-by-plan", {
    token: saToken,
    query: { period: "this_month", search: TEST_TAG },
  });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.rows), "revenue-by-plan must return rows array");
  const row = r.body.rows.find(x => x.plan === "professional");
  assert.ok(row, "professional plan row must be present after filtering");
  assert.ok(row.totalBilled >= 1234.56,
    `professional plan totalBilled should include seeded invoice, got ${row.totalBilled}`);
});

// ════════════════════════════════════════════════════════════════════════════
//  /reports/summary smoke — used by hub cards.
// ════════════════════════════════════════════════════════════════════════════
test("/reports/summary returns the documented KPI shape", async () => {
  const r = await api<SummaryResponse>("/api/admin/reports/summary", { token: saToken });
  assert.equal(r.status, 200);
  const body = r.body;
  assert.ok(isObject(body), "summary body must be an object");
  for (const k of ["revenueMonth", "billedActive", "activeCompanies", "overLimitSubs"] as const) {
    assert.equal(typeof body[k], "number", `${k} must be a number`);
  }
  assert.ok(isObject(body.period) && typeof body.period.from === "string" &&
            typeof body.period.to === "string",
            "summary must include period.from/to as strings");
});
