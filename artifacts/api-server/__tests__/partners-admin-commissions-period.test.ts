// Integration tests for the SuperAdmin consolidated commissions report's
// period filter (artifacts/api-server/src/routes/partners-admin.ts →
// GET /api/admin/partners/reports/commissions).
//
// What this protects:
//   • The report now accepts optional ?year= and ?month= query params and
//     filters the per-entity baseAmount/commissionTotal sums to that accrual
//     period (across BOTH partner_commissions and reseller_commissions).
//   • Omitting the params must keep the historical all-time behavior.
//   These tests pin that contract: a filtered period returns strictly the
//   accruals in that period, and the unfiltered totals equal the sum across
//   all periods.
//
// How to run:
//   pnpm --filter @workspace/api-server test
//
// Notes:
//   - Boots the Express app in-process on a random port. Uses the real DB.
//   - Seeds and tears down its own data; cleanup deletes strictly by the IDs
//     recorded at insert time so no real tenant data is touched.

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
  platformPartnersTable,
  partnerCommissionsTable,
  resellersTable,
  resellerCommissionsTable,
} from "@workspace/db";

import app from "../src/app.ts";

const TEST_TAG = `tt_partners_period_${randomBytes(4).toString("hex")}`;

let server: http.Server;
let baseUrl: string;

let saToken: string;

const insertedUserIds: number[] = [];
const insertedPartnerIds: number[] = [];
const insertedResellerIds: number[] = [];

// Two distinct accrual periods we seed into for both a developer and an agent.
const Y1 = 2026, M1 = 3;   // March 2026
const Y2 = 2026, M2 = 4;   // April 2026

let partnerId: number;
let resellerId: number;

interface ReportRow {
  entityType: string;
  id: number;
  baseAmount: string;
  commissionTotal: string;
}
interface ReportResponse {
  rows: ReportRow[];
  totals: { entities: number; companies: number; baseAmount: string; commissionTotal: string };
}

interface FetchOpts { token?: string; query?: Record<string, string | number | undefined> }
async function api<T = unknown>(path: string, opts: FetchOpts = {}): Promise<{ status: number; body: T }> {
  const url = new URL(baseUrl + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  let body: unknown = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  return { status: res.status, body: body as T };
}

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server did not bind");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // SuperAdmin with a deterministic sessionToken (bypasses login).
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
  insertedUserIds.push(sa.id);

  // Developer / partner with commissions in two periods.
  const [partner] = await db.insert(platformPartnersTable).values({
    kind: "developer",
    nameAr: `${TEST_TAG} مطوّر`,
    commissionRate: "10",
    status: "active",
  }).returning({ id: platformPartnersTable.id });
  partnerId = partner.id;
  insertedPartnerIds.push(partnerId);

  await db.insert(partnerCommissionsTable).values([
    { partnerId, eventType: "app_sale",  baseAmount: "1000", commissionRate: "10", commissionAmount: "100", periodMonth: M1, periodYear: Y1, status: "accrued" },
    { partnerId, eventType: "app_sale",  baseAmount: "2000", commissionRate: "10", commissionAmount: "200", periodMonth: M2, periodYear: Y2, status: "accrued" },
  ]);

  // Agent (reseller) with commissions in two periods.
  const [reseller] = await db.insert(resellersTable).values({
    code: `${TEST_TAG}_RS`,
    nameAr: `${TEST_TAG} وكيل`,
    username: `${TEST_TAG}_rs_user`,
    passwordHash: saHash,
    commissionRate: "5",
    status: "active",
  }).returning({ id: resellersTable.id });
  resellerId = reseller.id;
  insertedResellerIds.push(resellerId);

  await db.insert(resellerCommissionsTable).values([
    { resellerId, eventType: "new_subscription", baseAmount: "500",  commissionRate: "5", commissionAmount: "25", periodMonth: M1, periodYear: Y1, status: "accrued" },
    { resellerId, eventType: "renewal",          baseAmount: "800",  commissionRate: "5", commissionAmount: "40", periodMonth: M2, periodYear: Y2, status: "accrued" },
  ]);
});

after(async () => {
  try {
    if (insertedPartnerIds.length) {
      await db.delete(partnerCommissionsTable).where(inArray(partnerCommissionsTable.partnerId, insertedPartnerIds));
      await db.delete(platformPartnersTable).where(inArray(platformPartnersTable.id, insertedPartnerIds));
    }
    if (insertedResellerIds.length) {
      await db.delete(resellerCommissionsTable).where(inArray(resellerCommissionsTable.resellerId, insertedResellerIds));
      await db.delete(resellersTable).where(inArray(resellersTable.id, insertedResellerIds));
    }
    if (insertedUserIds.length) {
      await db.delete(usersTable).where(inArray(usersTable.id, insertedUserIds));
    }
  } finally {
    if (server) await new Promise<void>(r => server.close(() => r()));
    try { await pool.end(); } catch { /* already ended is fine */ }
  }
});

function findRow(body: ReportResponse, entityType: string, id: number): ReportRow {
  const row = body.rows.find((r) => r.entityType === entityType && r.id === id);
  assert.ok(row, `report must contain ${entityType} #${id}`);
  return row;
}

// ─── Auth gate ──────────────────────────────────────────────────────────────
test("rejects non-superadmin / anonymous (401)", async () => {
  const r = await api("/api/admin/partners/reports/commissions");
  assert.equal(r.status, 401);
});

// ─── Period filter ──────────────────────────────────────────────────────────
test("filtered period returns only that period's accruals (partner + agent)", async () => {
  const r = await api<ReportResponse>("/api/admin/partners/reports/commissions", {
    token: saToken,
    query: { year: Y1, month: M1 },
  });
  assert.equal(r.status, 200);

  const p = findRow(r.body, "developer", partnerId);
  assert.equal(Number(p.baseAmount), 1000);
  assert.equal(Number(p.commissionTotal), 100);

  const a = findRow(r.body, "agent", resellerId);
  assert.equal(Number(a.baseAmount), 500);
  assert.equal(Number(a.commissionTotal), 25);
});

test("a different period returns that period's distinct accruals", async () => {
  const r = await api<ReportResponse>("/api/admin/partners/reports/commissions", {
    token: saToken,
    query: { year: Y2, month: M2 },
  });
  assert.equal(r.status, 200);

  const p = findRow(r.body, "developer", partnerId);
  assert.equal(Number(p.commissionTotal), 200);

  const a = findRow(r.body, "agent", resellerId);
  assert.equal(Number(a.commissionTotal), 40);
});

test("unfiltered report sums across all periods (all-time behavior preserved)", async () => {
  const r = await api<ReportResponse>("/api/admin/partners/reports/commissions", { token: saToken });
  assert.equal(r.status, 200);

  const p = findRow(r.body, "developer", partnerId);
  assert.equal(Number(p.baseAmount), 3000);          // 1000 + 2000
  assert.equal(Number(p.commissionTotal), 300);      // 100 + 200

  const a = findRow(r.body, "agent", resellerId);
  assert.equal(Number(a.baseAmount), 1300);          // 500 + 800
  assert.equal(Number(a.commissionTotal), 65);       // 25 + 40
});

test("filtered totals differ from unfiltered totals for the seeded entities", async () => {
  const all = await api<ReportResponse>("/api/admin/partners/reports/commissions", { token: saToken });
  const oneMonth = await api<ReportResponse>("/api/admin/partners/reports/commissions", {
    token: saToken, query: { year: Y1, month: M1 },
  });

  const allP = findRow(all.body, "developer", partnerId).commissionTotal;
  const monthP = findRow(oneMonth.body, "developer", partnerId).commissionTotal;
  assert.notEqual(monthP, allP, "filtered partner commission must differ from all-time");

  const allA = findRow(all.body, "agent", resellerId).commissionTotal;
  const monthA = findRow(oneMonth.body, "agent", resellerId).commissionTotal;
  assert.notEqual(monthA, allA, "filtered agent commission must differ from all-time");
});

test("year-only filter rolls up every month within that year", async () => {
  const r = await api<ReportResponse>("/api/admin/partners/reports/commissions", {
    token: saToken,
    query: { year: Y1 },
  });
  assert.equal(r.status, 200);
  // Both seeded periods are in 2026, so a year-only filter == all-time here.
  const p = findRow(r.body, "developer", partnerId);
  assert.equal(Number(p.commissionTotal), 300);
});
