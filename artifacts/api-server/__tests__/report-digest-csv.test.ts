// Unit + integration tests for the CSV builders in
// artifacts/api-server/src/lib/reportDigest.ts.
//
// What this protects:
//   The companion file report-scheduler.test.ts pins the *delivery* path
//   (status="ok"/"failed"/"no_data", history-row inserts, schedule-row
//   updates) but stubs the CSV builder out via the test seam. That means a
//   regression in the CSVs themselves — a renamed Arabic header, a swapped
//   column, a wrong join in produceOperationalSummaryCsv(), or a botched
//   share-percentage calculation in produceRevenueByPlanCsv() — would still
//   look like a successful send while the SuperAdmin's Excel attachment is
//   silently corrupted. These tests close that gap by exercising both
//   builders end-to-end against the dev DB and asserting the actual CSV
//   text (headers, row content, aggregation math).
//
//   The third assertion target is digestPeriod(): the pure date-window
//   helper that decides which sales_invoices are included in the
//   revenue-by-plan CSV. A regression there (e.g. "trailing 7 days" turning
//   into "trailing 30 days", or "month-to-date" using local time and
//   drifting on a midnight rollover) would silently produce an
//   off-by-23-rows digest with no failing test.
//
// How to run:
//   pnpm --filter @workspace/api-server test
//
// Notes:
//   - Uses the real DB (DATABASE_URL). Every seeded row is tracked by
//     primary key and removed in the after() hook via inArray on the
//     recorded IDs — never via tag/like — so a crashed run can never touch
//     another tenant's data.
//   - The operational-summary CSV is built across ALL companies in the
//     dev DB; we identify our company's row by its unique nameAr (built
//     from a per-run TEST_TAG). Other tenants' rows are ignored by the
//     assertions.
//   - The revenue-by-plan CSV groups by (plan, billing_cycle); we pick a
//     plan key that does not collide with any real plan so our tenant is
//     the only one in its group. The share-percentage assertion is
//     self-consistent (it parses every row in the same CSV and recomputes
//     the expected share), so other tenants' data does not invalidate it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import bcrypt from "bcryptjs";
import { inArray } from "drizzle-orm";
import {
  db,
  pool,
  companiesTable,
  customersTable,
  suppliersTable,
  itemsTable,
  salesInvoicesTable,
  subscriptionsTable,
  auditLogTable,
  autoBackupsTable,
  posSessionsTable,
  usersTable,
} from "@workspace/db";

import {
  produceOperationalSummaryCsv,
  produceRevenueByPlanCsv,
  digestPeriod,
} from "../src/lib/reportDigest.ts";

// ─── Test scoping ───────────────────────────────────────────────────────────
// Per-run prefix used purely for human-readable identification of seeded rows
// (e.g. when inspecting the DB after a crash). It is NEVER used in any DELETE
// query — cleanup deletes strictly by the IDs we tracked at insert time so
// there is zero risk of nuking real tenant data.
const TEST_TAG = `tt_digest_csv_${randomBytes(4).toString("hex")}`;

// PK lists used by cleanup() — strict-by-PK, never wildcards.
const insertedCompanyIds:     number[] = [];
const insertedCustomerIds:    number[] = [];
const insertedSupplierIds:    number[] = [];
const insertedItemIds:        number[] = [];
const insertedInvoiceIds:     number[] = [];
const insertedSubscriptionIds:number[] = [];
const insertedAuditLogIds:    number[] = [];
const insertedAutoBackupIds:  number[] = [];
const insertedPosSessionIds:  number[] = [];
const insertedUserIds:        number[] = [];

// IDs of the rows we'll lookup by in assertions.
let opsCompanyId: number;
let opsCompanyNameAr: string;

let revenueCompanyId: number;
const REVENUE_PLAN_KEY = `${TEST_TAG}_plan`;     // unique → our row is alone
const REVENUE_BILLING_CYCLE_RAW = "annual";        // SQL rewrites → "yearly"
const REVENUE_BILLING_CYCLE_OUT = "yearly";

// Two known invoice totals so the aggregation has > 1 row contributing.
const REVENUE_INVOICE_AMOUNTS = ["1000.00", "2500.50"] as const;
// Window: a tightly-bounded historical week so other tenants' invoices in
// the dev DB don't drift in. invoice_date is text(YYYY-MM-DD) so a string
// comparison works.
const REVENUE_FROM = "2026-04-20";
const REVENUE_TO   = "2026-04-26";
const REVENUE_INVOICE_DATE = "2026-04-22"; // squarely inside the window

// ─── Lifecycle ──────────────────────────────────────────────────────────────
before(async () => {
  // Two distinct companies: one for the operational-summary scenario, one
  // for the revenue-by-plan scenario. Keeping them separate prevents
  // cross-contamination (e.g. our seeded audit_log rows leaking into a
  // revenue-only assertion via last_activity_at).
  opsCompanyNameAr = `${TEST_TAG} شركة الملخص`;
  const opsCompanyValues: typeof companiesTable.$inferInsert = {
    nameAr:         opsCompanyNameAr,
    nameEn:         `${TEST_TAG} Ops Co`,
    vatNumber:      "300000000000010",
    crNumber:       `CR_${TEST_TAG}_OPS`,
    city:           "Riyadh",
    street:         "Test St",
    buildingNumber: "1",
    postalCode:     "12345",
    country:        "SA",
    invoiceType:    "both",
    status:         "active",
  };
  const [opsCo] = await db.insert(companiesTable).values(opsCompanyValues)
    .returning({ id: companiesTable.id });
  opsCompanyId = opsCo.id;
  insertedCompanyIds.push(opsCompanyId);

  const revCompanyValues: typeof companiesTable.$inferInsert = {
    nameAr:         `${TEST_TAG} شركة الإيرادات`,
    nameEn:         `${TEST_TAG} Rev Co`,
    vatNumber:      "300000000000020",
    crNumber:       `CR_${TEST_TAG}_REV`,
    city:           "Riyadh",
    street:         "Test St",
    buildingNumber: "2",
    postalCode:     "12345",
    country:        "SA",
    invoiceType:    "both",
    status:         "active",
  };
  const [revCo] = await db.insert(companiesTable).values(revCompanyValues)
    .returning({ id: companiesTable.id });
  revenueCompanyId = revCo.id;
  insertedCompanyIds.push(revenueCompanyId);

  // ── Operational summary seed ─────────────────────────────────────────────
  // Counts: 3 customers, 2 suppliers, 4 items, 1 open POS session,
  //          3 audit events (1 of them denied), 1 auto_backup, 1 posted
  //          sales invoice (so last_activity_at is non-null).
  for (let i = 0; i < 3; i++) {
    const [c] = await db.insert(customersTable).values({
      companyId: opsCompanyId,
      nameAr:    `${TEST_TAG} عميل ${i}`,
    }).returning({ id: customersTable.id });
    insertedCustomerIds.push(c.id);
  }
  for (let i = 0; i < 2; i++) {
    const [s] = await db.insert(suppliersTable).values({
      companyId: opsCompanyId,
      nameAr:    `${TEST_TAG} مورد ${i}`,
    }).returning({ id: suppliersTable.id });
    insertedSupplierIds.push(s.id);
  }
  for (let i = 0; i < 4; i++) {
    const [it] = await db.insert(itemsTable).values({
      companyId: opsCompanyId,
      code:      `${TEST_TAG}_ITEM_${i}`,
      nameAr:    `${TEST_TAG} صنف ${i}`,
    }).returning({ id: itemsTable.id });
    insertedItemIds.push(it.id);
  }

  // POS session needs a user FK — create one tied to the ops company.
  const userPwHash = await bcrypt.hash("ignored-test-pw", 4);
  const [posUser] = await db.insert(usersTable).values({
    username:     `${TEST_TAG}_pos_user`,
    email:        null,
    passwordHash: userPwHash,
    role:         "cashier",
    isActive:     true,
    companyId:    opsCompanyId,
  }).returning({ id: usersTable.id });
  insertedUserIds.push(posUser.id);

  const [posSession] = await db.insert(posSessionsTable).values({
    companyId:   opsCompanyId,
    userId:      posUser.id,
    openingCash: "0",
    status:      "open",
  }).returning({ id: posSessionsTable.id });
  insertedPosSessionIds.push(posSession.id);

  // Audit events — three rows in the last 7 days, one of which is "denied".
  for (let i = 0; i < 2; i++) {
    const [a] = await db.insert(auditLogTable).values({
      companyId: opsCompanyId,
      module:    "sales_invoices",
      action:    "view",
      method:    "GET",
    }).returning({ id: auditLogTable.id });
    insertedAuditLogIds.push(a.id);
  }
  const [denied] = await db.insert(auditLogTable).values({
    companyId: opsCompanyId,
    module:    "sales_invoices",
    action:    "denied",
    method:    "POST",
  }).returning({ id: auditLogTable.id });
  insertedAuditLogIds.push(denied.id);

  // Auto backup — DISTINCT ON (company_id) latest only, so one row is enough.
  const [bk] = await db.insert(autoBackupsTable).values({
    companyId: opsCompanyId,
    reason:    "manual",
    sizeBytes: 0,
    counts:    {},
    data:      {},
  }).returning({ id: autoBackupsTable.id });
  insertedAutoBackupIds.push(bk.id);

  // Posted sales invoice today — feeds last_activity_at via the la CTE.
  const today = new Date().toISOString().slice(0, 10);
  const [opsInv] = await db.insert(salesInvoicesTable).values({
    companyId:    opsCompanyId,
    invoiceDate:  today,
    paymentType:  "cash",
    currencyCode: "SAR",
    exchangeRate: "1",
    subtotal:     "100.00",
    vatAmount:    "15.00",
    discountAmount: "0",
    totalAmount:  "115.00",
    status:       "posted",
    docNumber:    `${TEST_TAG}-OPS-INV`,
  }).returning({ id: salesInvoicesTable.id });
  insertedInvoiceIds.push(opsInv.id);

  // ── Revenue-by-plan seed ─────────────────────────────────────────────────
  // 1 active subscription on a unique plan key with billing_cycle='annual'
  // (the SQL rewrites this to 'yearly' in the output — we pin that too).
  const [sub] = await db.insert(subscriptionsTable).values({
    companyId:    revenueCompanyId,
    plan:         REVENUE_PLAN_KEY,
    billingCycle: REVENUE_BILLING_CYCLE_RAW,
    startDate:    "2026-01-01",
    endDate:      "2099-12-31",   // far future → always passes end_date >= today
    isActive:     true,
    price:        "0",
  }).returning({ id: subscriptionsTable.id });
  insertedSubscriptionIds.push(sub.id);

  // Two posted invoices inside [REVENUE_FROM, REVENUE_TO]. SUM == 3500.50.
  for (const amount of REVENUE_INVOICE_AMOUNTS) {
    const [inv] = await db.insert(salesInvoicesTable).values({
      companyId:    revenueCompanyId,
      invoiceDate:  REVENUE_INVOICE_DATE,
      paymentType:  "cash",
      currencyCode: "SAR",
      exchangeRate: "1",
      subtotal:     amount,
      vatAmount:    "0",
      discountAmount: "0",
      totalAmount:  amount,
      status:       "posted",
      docNumber:    `${TEST_TAG}-REV-${amount}`,
    }).returning({ id: salesInvoicesTable.id });
    insertedInvoiceIds.push(inv.id);
  }
});

after(async () => {
  try { await cleanup(); } finally {
    try { await pool.end(); } catch { /* already ended is fine */ }
  }
});

async function cleanup(): Promise<void> {
  // Delete child rows first to satisfy FK constraints.
  if (insertedInvoiceIds.length) {
    await db.delete(salesInvoicesTable).where(inArray(salesInvoicesTable.id, insertedInvoiceIds));
  }
  if (insertedSubscriptionIds.length) {
    await db.delete(subscriptionsTable).where(inArray(subscriptionsTable.id, insertedSubscriptionIds));
  }
  if (insertedAuditLogIds.length) {
    await db.delete(auditLogTable).where(inArray(auditLogTable.id, insertedAuditLogIds));
  }
  if (insertedAutoBackupIds.length) {
    await db.delete(autoBackupsTable).where(inArray(autoBackupsTable.id, insertedAutoBackupIds));
  }
  if (insertedPosSessionIds.length) {
    await db.delete(posSessionsTable).where(inArray(posSessionsTable.id, insertedPosSessionIds));
  }
  if (insertedItemIds.length) {
    await db.delete(itemsTable).where(inArray(itemsTable.id, insertedItemIds));
  }
  if (insertedSupplierIds.length) {
    await db.delete(suppliersTable).where(inArray(suppliersTable.id, insertedSupplierIds));
  }
  if (insertedCustomerIds.length) {
    await db.delete(customersTable).where(inArray(customersTable.id, insertedCustomerIds));
  }
  if (insertedUserIds.length) {
    await db.delete(usersTable).where(inArray(usersTable.id, insertedUserIds));
  }
  if (insertedCompanyIds.length) {
    await db.delete(companiesTable).where(inArray(companiesTable.id, insertedCompanyIds));
  }
}

// ─── CSV parsing helper ─────────────────────────────────────────────────────
// The builder produces "\uFEFF" + lines.join("\r\n") + "\r\n". Our seeded
// values are comma/quote/newline-free, but the operational-summary CSV
// includes EVERY company in the dev DB so other tenants' rows might
// contain quoted fields. This is a minimal RFC-4180 parser (handles
// quoted fields with embedded commas, embedded \r\n, and escaped "")
// so a tenant name with a comma can never make these tests flaky.
function parseCsv(csv: string): string[][] {
  const trimmed = csv.startsWith("\uFEFF") ? csv.slice(1) : csv;
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inQuotes) {
      if (ch === '"') {
        if (trimmed[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\r" && trimmed[i + 1] === "\n") {
        row.push(field); out.push(row);
        row = []; field = ""; i++;
      } else if (ch === "\n") {
        row.push(field); out.push(row);
        row = []; field = "";
      } else {
        field += ch;
      }
    }
  }
  // Trailing field (only if the CSV did not end with a line break).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out;
}

// Compute the expected weekly window — kept here (instead of imported) so a
// drift in digestPeriod() shows up as a failing assertion rather than a
// silently-passing-but-wrong test.
function expectedWeekly(): { from: string; to: string } {
  return {
    from: new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10),
    to:   new Date().toISOString().slice(0, 10),
  };
}
function expectedMonthly(): { from: string; to: string } {
  const now = new Date();
  return {
    from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      .toISOString().slice(0, 10),
    to:   now.toISOString().slice(0, 10),
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  digestPeriod — pure date-window helper
// ════════════════════════════════════════════════════════════════════════════
test("digestPeriod('weekly') pins trailing-7-days math (today minus 6 days .. today, UTC)", () => {
  // Snapshot the expected window before AND after the call so a midnight
  // rollover during the test doesn't create a false failure: as long as the
  // result matches one of the two snapshots, the math is correct.
  const beforeExp = expectedWeekly();
  const out = digestPeriod("weekly");
  const afterExp = expectedWeekly();
  const matches =
    (out.from === beforeExp.from && out.to === beforeExp.to) ||
    (out.from === afterExp.from  && out.to === afterExp.to);
  assert.ok(
    matches,
    `digestPeriod('weekly') drifted: got ${JSON.stringify(out)}, ` +
    `expected ${JSON.stringify(beforeExp)} or ${JSON.stringify(afterExp)}`,
  );

  // Independent guard: the difference between to and from must be exactly
  // 6 calendar days. Catches "trailing 7 days" silently turning into
  // "trailing 14 days" even if both snapshots happen to agree.
  const fromMs = Date.parse(out.from + "T00:00:00Z");
  const toMs   = Date.parse(out.to   + "T00:00:00Z");
  const diffDays = Math.round((toMs - fromMs) / 86_400_000);
  assert.equal(diffDays, 6,
    `weekly window must span exactly 6 days (today + 6 prior), got ${diffDays}`);
});

test("digestPeriod('monthly') pins calendar month-to-date math (UTC, no timezone drift)", () => {
  const beforeExp = expectedMonthly();
  const out = digestPeriod("monthly");
  const afterExp = expectedMonthly();
  const matches =
    (out.from === beforeExp.from && out.to === beforeExp.to) ||
    (out.from === afterExp.from  && out.to === afterExp.to);
  assert.ok(
    matches,
    `digestPeriod('monthly') drifted: got ${JSON.stringify(out)}, ` +
    `expected ${JSON.stringify(beforeExp)} or ${JSON.stringify(afterExp)}`,
  );

  // Independent guard: from must be the FIRST day of a UTC calendar month
  // (day-of-month component == "01"). Catches a regression that uses local
  // time and crosses a UTC day boundary.
  assert.match(out.from, /^\d{4}-\d{2}-01$/,
    `monthly 'from' must be the first day of the calendar month (UTC), got ${out.from}`);
});

// ════════════════════════════════════════════════════════════════════════════
//  produceOperationalSummaryCsv — headers + the seeded row
// ════════════════════════════════════════════════════════════════════════════
test("produceOperationalSummaryCsv: emits the documented Arabic headers in order", async () => {
  const { csv, filename } = await produceOperationalSummaryCsv();
  assert.equal(filename, "operational-summary.csv",
    "filename must be the stable artifact name (UI + email both rely on it)");
  const rows = parseCsv(csv);
  assert.ok(rows.length >= 1, "CSV must include at least the header row");
  const expectedHeaders = [
    "الشركة", "الحالة", "العملاء", "الموردون", "الأصناف",
    "جلسات نقاط البيع المفتوحة", "آخر نشاط",
    "أحداث التدقيق (7 أيام)", "محاولات مرفوضة (7 أيام)",
    "آخر نسخة احتياطية", "نوع النسخة", "راكدة (>30 يوم)",
  ];
  assert.deepEqual(rows[0], expectedHeaders,
    "operational-summary headers (order + Arabic spelling) must match");
});

test("produceOperationalSummaryCsv: seeded company appears with correct counts and freshness", async () => {
  const { csv } = await produceOperationalSummaryCsv();
  const rows = parseCsv(csv);

  // The CSV is sorted by Arabic company name and contains EVERY company in
  // the dev DB. We find OUR seeded row by its unique nameAr.
  const ours = rows.slice(1).find((r) => r[0] === opsCompanyNameAr);
  assert.ok(ours, `seeded company '${opsCompanyNameAr}' must appear in CSV`);

  // Column-by-column assertions tied to the seed plan above.
  assert.equal(ours![0], opsCompanyNameAr,         "col 0: company nameAr");
  assert.equal(ours![1], "active",                 "col 1: company status");
  assert.equal(ours![2], "3",                      "col 2: customers count");
  assert.equal(ours![3], "2",                      "col 3: suppliers count");
  assert.equal(ours![4], "4",                      "col 4: items count");
  assert.equal(ours![5], "1",                      "col 5: open POS sessions");
  assert.notEqual(ours![6], "—",
    "col 6: last_activity_at must be populated (we seeded a posted invoice + audit rows)");
  assert.equal(ours![7], "3",                      "col 7: audit_events_7d (2 view + 1 denied)");
  assert.equal(ours![8], "1",                      "col 8: denied_7d (only the denied row)");
  assert.notEqual(ours![9], "—",
    "col 9: last backup created_at must be populated (we seeded one auto_backup row)");
  assert.equal(ours![10], "manual",                "col 10: latest backup reason");
  assert.equal(ours![11], "لا",
    "col 11: inactive flag must be 'لا' (last activity is < 30 days old)");
});

// ════════════════════════════════════════════════════════════════════════════
//  produceRevenueByPlanCsv — headers + per-plan/billing-cycle aggregation +
//                            share-percentage math
// ════════════════════════════════════════════════════════════════════════════
test("produceRevenueByPlanCsv: emits the documented Arabic headers in order", async () => {
  const { csv, filename } = await produceRevenueByPlanCsv({
    from: REVENUE_FROM, to: REVENUE_TO,
  });
  assert.equal(filename, `revenue-by-plan-${REVENUE_FROM}_${REVENUE_TO}.csv`,
    "filename must encode the period so multiple attachments don't clash");
  const rows = parseCsv(csv);
  assert.ok(rows.length >= 1, "CSV must include at least the header row");
  assert.deepEqual(
    rows[0],
    ["الباقة", "الدورة", "عدد الشركات", "إجمالي الإيرادات", "الحصة %"],
    "revenue-by-plan headers (order + Arabic spelling) must match",
  );
});

test("produceRevenueByPlanCsv: aggregates seeded subscription + invoices into one row with correct share %", async () => {
  const { csv } = await produceRevenueByPlanCsv({
    from: REVENUE_FROM, to: REVENUE_TO,
  });
  const rows = parseCsv(csv);
  const data = rows.slice(1);

  // Find our (plan, billing_cycle) row. The plan key is unique to this run
  // so no other tenant can land in the same group.
  const ours = data.find((r) => r[0] === REVENUE_PLAN_KEY);
  assert.ok(ours, `seeded plan '${REVENUE_PLAN_KEY}' must appear in revenue CSV`);

  // billing_cycle: stored as 'annual', SQL rewrites it to 'yearly' for output.
  assert.equal(ours![1], REVENUE_BILLING_CYCLE_OUT,
    "col 1: billing_cycle 'annual' must be rewritten to 'yearly' for the digest");
  assert.equal(ours![2], "1",
    "col 2: subscription_count must be 1 (one company on this unique plan)");

  // total_billed = sum of seeded invoice totals (1000.00 + 2500.50 = 3500.50).
  const expectedTotal = REVENUE_INVOICE_AMOUNTS
    .reduce((s, a) => s + Number(a), 0);
  assert.equal(ours![3], expectedTotal.toFixed(2),
    `col 3: total_billed must equal sum of seeded invoices (${expectedTotal.toFixed(2)})`);

  // share % is (our total / sum of every row's total) * 100. Recompute the
  // grand total by parsing the same CSV so the assertion is self-consistent
  // regardless of what other tenants exist in the dev DB.
  const grandTotal = data.reduce((s, r) => s + Number(r[3]), 0);
  const expectedShare = grandTotal > 0
    ? ((expectedTotal / grandTotal) * 100).toFixed(2)
    : "0.00";
  assert.equal(ours![4], expectedShare,
    `col 4: share % must equal (rowTotal / grandTotal) * 100 = ${expectedShare}`);

  // Sanity guard on share-% format itself: always two decimal places, no
  // stray "%" sign (the Arabic header already includes one).
  assert.match(ours![4], /^\d+\.\d{2}$/,
    `share % must be formatted with exactly two decimal places, got ${ours![4]}`);
});
