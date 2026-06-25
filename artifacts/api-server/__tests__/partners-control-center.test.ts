// Integration tests for the Developer & Partner Control Center
// (artifacts/api-server/src/routes/partners-admin.ts → /api/admin/partners/*).
//
// What this protects:
//   • The onboarding lifecycle state machine. A partner is created in 'draft'
//     and must walk the forward flow
//       draft → documents → identity_check → fees → security_review → approved
//     The issued Partner ID is minted ONLY on the transition into 'approved'
//     (DV-###### for developers, PT-###### for partners) and is then stable
//     (re-approving after a suspend never re-issues a new code).
//   • Invalid transitions are rejected (unknown status string → 400; advancing
//     past 'approved' → 400).
//   • The SuperAdmin role gate: 401 without a bearer, 403 for any non-SA role.
//   • The consolidated commissions report (/reports/commissions) rolls up BOTH
//     developers/partners AND agents (resellers) into one list with correct
//     per-entity and grand totals — the additive guarantee that the new partner
//     subsystem reports alongside the untouched reseller subsystem.
//
// How to run:
//   pnpm --filter @workspace/api-server test
//
// Notes:
//   - Boots the Express app in-process on a random port. Uses the real DB
//     (DATABASE_URL). Seeds and tears down strictly by recorded primary keys —
//     no LIKE/wildcard deletes — so other tenants are never touched.
//   - NOTE ON TASK DRIFT: the task referenced files/routes that do not exist
//     verbatim (developers-admin.ts, platform-commissions.ts,
//     /api/admin/platform-commissions/summary, DEV-/PTR- prefixes, year/month
//     filters). The real implementation lives in partners-admin.ts; the
//     consolidated report is /api/admin/partners/reports/commissions and takes
//     no period filter. These tests pin the ACTUAL behaviour.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";

import bcrypt from "bcryptjs";
import { eq, inArray, and, gt, sql } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  companiesTable,
  auditLogTable,
  platformPartnersTable,
  partnerCommissionsTable,
  partnerCompaniesTable,
  resellersTable,
  resellerCommissionsTable,
  resellerCompaniesTable,
} from "@workspace/db";

import app from "../src/app.ts";

const TAG = `tt_pcc_${randomBytes(4).toString("hex")}`;

let server: http.Server;
let baseUrl: string;

let saToken: string;
let saUserId: number;
let adminToken: string;
let adminUserId: number;

let companyId: number;

// Recorded ids for strict cleanup.
const partnerIds: number[] = [];
const resellerIds: number[] = [];
const companyIds: number[] = [];
const userIds: number[] = [];
let maxAuditIdBefore = 0;

interface Json { [k: string]: unknown }

async function api<T = Json>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": TAG };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  return { status: res.status, body: body as T };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server did not bind");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  const [maxRow] = await db
    .select({ m: sql<number>`COALESCE(MAX(${auditLogTable.id}), 0)` })
    .from(auditLogTable);
  maxAuditIdBefore = Number(maxRow?.m ?? 0);

  // SuperAdmin — can drive the whole control center.
  saToken = "tt_sa_" + randomBytes(16).toString("hex");
  const [sa] = await db.insert(usersTable).values({
    username: `${TAG}_sa`,
    passwordHash: await bcrypt.hash("x", 4),
    role: "superadmin",
    isActive: true,
    sessionToken: saToken,
    sessionId: "test",
    companyId: null,
  }).returning({ id: usersTable.id });
  saUserId = sa.id;
  userIds.push(saUserId);

  // A plain company admin — exercises the SA-only 403 gate.
  adminToken = "tt_admin_" + randomBytes(16).toString("hex");
  const [adm] = await db.insert(usersTable).values({
    username: `${TAG}_admin`,
    passwordHash: await bcrypt.hash("x", 4),
    role: "admin",
    isActive: true,
    sessionToken: adminToken,
    sessionId: "test",
    companyId: null,
  }).returning({ id: usersTable.id });
  adminUserId = adm.id;
  userIds.push(adminUserId);

  // One company for linking + commission attribution.
  const [co] = await db.insert(companiesTable).values({
    nameAr: `${TAG} شركة`,
    nameEn: `${TAG} Co`,
    crNumber: `CR_${TAG}`,
    buildingNumber: "1",
    vatNumber: "300000000000003",
    city: "Riyadh",
    street: "Test St",
    postalCode: "12345",
    country: "SA",
    invoiceType: "both",
    status: "active",
  }).returning({ id: companiesTable.id });
  companyId = co.id;
  companyIds.push(companyId);
});

after(async () => {
  try {
    // Sweep audit rows this run created (no FK, but keep the table tidy).
    if (maxAuditIdBefore > 0) {
      await db.delete(auditLogTable).where(and(
        gt(auditLogTable.id, maxAuditIdBefore),
        eq(auditLogTable.userAgent, TAG),
      ));
    }
    if (partnerIds.length) {
      await db.delete(partnerCommissionsTable).where(inArray(partnerCommissionsTable.partnerId, partnerIds));
      await db.delete(partnerCompaniesTable).where(inArray(partnerCompaniesTable.partnerId, partnerIds));
      await db.delete(platformPartnersTable).where(inArray(platformPartnersTable.id, partnerIds));
    }
    if (resellerIds.length) {
      await db.delete(resellerCommissionsTable).where(inArray(resellerCommissionsTable.resellerId, resellerIds));
      await db.delete(resellerCompaniesTable).where(inArray(resellerCompaniesTable.resellerId, resellerIds));
      await db.delete(resellersTable).where(inArray(resellersTable.id, resellerIds));
    }
    if (companyIds.length) await db.delete(companiesTable).where(inArray(companiesTable.id, companyIds));
    if (userIds.length) await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  } finally {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await pool.end().catch(() => {});
  }
});

// ─── Auth / role gate ───────────────────────────────────────────────────────
test("rejects unauthenticated request (401)", async () => {
  const r = await api("GET", "/api/admin/partners");
  assert.equal(r.status, 401);
  assert.ok(isObj(r.body) && typeof r.body.error === "string");
});

test("rejects non-superadmin role (403)", async () => {
  const r = await api("GET", "/api/admin/partners", { token: adminToken });
  assert.equal(r.status, 403);
  assert.ok(isObj(r.body) && typeof r.body.error === "string");
});

test("superadmin can list partners (200)", async () => {
  const r = await api("GET", "/api/admin/partners", { token: saToken });
  assert.equal(r.status, 200);
  assert.ok(isObj(r.body) && Array.isArray(r.body.partners));
});

// ─── Lifecycle: register → step-by-step approve, ID issued only on approve ──
test("create partner starts in 'draft' with NO Partner ID", async () => {
  const r = await api("POST", "/api/admin/partners", {
    token: saToken,
    body: { kind: "developer", nameAr: `${TAG} مطوّر`, commissionRate: 10 },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const partner = (r.body as { partner: Record<string, unknown> }).partner;
  assert.ok(isObj(partner));
  const id = Number(partner.id);
  assert.ok(id > 0);
  partnerIds.push(id);
  assert.equal(partner.status, "draft");
  assert.equal(partner.partnerCode, null, "Partner ID must NOT be issued before approval");
  assert.equal(partner.partnerIdIssuedAt, null);
  assert.equal(partner.approvedAt, null);
});

test("developer walks the full flow; Partner ID (DV-######) issues ONLY on approve", async () => {
  const created = await api("POST", "/api/admin/partners", {
    token: saToken,
    body: { kind: "developer", nameAr: `${TAG} مطوّر تدفّق`, commissionRate: 12.5 },
  });
  assert.equal(created.status, 201);
  const id = Number((created.body as { partner: { id: number } }).partner.id);
  partnerIds.push(id);

  // The exact forward path the state machine must follow.
  const expected = ["documents", "identity_check", "fees", "security_review", "approved"];
  for (let i = 0; i < expected.length; i++) {
    const r = await api("POST", `/api/admin/partners/${id}/advance`, { token: saToken });
    assert.equal(r.status, 200, `advance #${i} failed: ${JSON.stringify(r.body)}`);
    const p = (r.body as { partner: Record<string, unknown> }).partner;
    assert.equal(p.status, expected[i], `step ${i} should reach '${expected[i]}'`);
    if (expected[i] !== "approved") {
      assert.equal(p.partnerCode, null, `no Partner ID before approval (was at '${expected[i]}')`);
    } else {
      assert.equal(typeof p.partnerCode, "string");
      assert.match(String(p.partnerCode), /^DV-\d{6}$/, "developer code must be DV-######");
      assert.ok(p.partnerIdIssuedAt, "partnerIdIssuedAt set on approve");
      assert.ok(p.approvedAt, "approvedAt set on approve");
      assert.equal(p.isActive, true);
    }
  }
});

test("partner kind gets a PT-###### code on direct approve", async () => {
  const created = await api("POST", "/api/admin/partners", {
    token: saToken,
    body: { kind: "partner", nameAr: `${TAG} شريك`, commissionRate: 8 },
  });
  assert.equal(created.status, 201);
  const id = Number((created.body as { partner: { id: number } }).partner.id);
  partnerIds.push(id);

  const r = await api("POST", `/api/admin/partners/${id}/advance`, {
    token: saToken,
    body: { to: "approved" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = (r.body as { partner: Record<string, unknown> }).partner;
  assert.equal(p.status, "approved");
  assert.match(String(p.partnerCode), /^PT-\d{6}$/, "partner code must be PT-######");
});

test("Partner ID is stable across suspend → re-approve (never re-issued)", async () => {
  const created = await api("POST", "/api/admin/partners", {
    token: saToken,
    body: { kind: "developer", nameAr: `${TAG} ثبات المعرّف`, commissionRate: 5 },
  });
  const id = Number((created.body as { partner: { id: number } }).partner.id);
  partnerIds.push(id);

  const approved = await api("POST", `/api/admin/partners/${id}/advance`, { token: saToken, body: { to: "approved" } });
  const code1 = String((approved.body as { partner: { partnerCode: string } }).partner.partnerCode);
  assert.match(code1, /^DV-\d{6}$/);

  const suspended = await api("POST", `/api/admin/partners/${id}/advance`, { token: saToken, body: { to: "suspended" } });
  assert.equal((suspended.body as { partner: { status: string } }).partner.status, "suspended");
  assert.equal((suspended.body as { partner: { isActive: boolean } }).partner.isActive, false);

  const reapproved = await api("POST", `/api/admin/partners/${id}/advance`, { token: saToken, body: { to: "approved" } });
  const code2 = String((reapproved.body as { partner: { partnerCode: string } }).partner.partnerCode);
  assert.equal(code2, code1, "re-approving must not mint a new Partner ID");
});

// ─── Invalid transitions ────────────────────────────────────────────────────
test("rejects an unknown target status (400)", async () => {
  const created = await api("POST", "/api/admin/partners", {
    token: saToken,
    body: { kind: "developer", nameAr: `${TAG} حالة غير صالحة` },
  });
  const id = Number((created.body as { partner: { id: number } }).partner.id);
  partnerIds.push(id);

  const r = await api("POST", `/api/admin/partners/${id}/advance`, { token: saToken, body: { to: "not_a_status" } });
  assert.equal(r.status, 400);
  assert.ok(isObj(r.body) && typeof r.body.error === "string");
});

test("rejects advancing past 'approved' with no explicit target (400)", async () => {
  const created = await api("POST", "/api/admin/partners", {
    token: saToken,
    body: { kind: "developer", nameAr: `${TAG} بعد الموافقة` },
  });
  const id = Number((created.body as { partner: { id: number } }).partner.id);
  partnerIds.push(id);

  await api("POST", `/api/admin/partners/${id}/advance`, { token: saToken, body: { to: "approved" } });
  const r = await api("POST", `/api/admin/partners/${id}/advance`, { token: saToken });
  assert.equal(r.status, 400, "no next stage after approved");
});

test("rejects a malformed id (400) and a missing partner (404)", async () => {
  const bad = await api("POST", "/api/admin/partners/abc/advance", { token: saToken });
  assert.equal(bad.status, 400);
  const missing = await api("POST", "/api/admin/partners/999999999/advance", { token: saToken });
  assert.equal(missing.status, 404);
});

// ─── Consolidated commissions report: agents + partners roll up together ────
test("/reports/commissions rolls up developers/partners AND agents with correct totals", async () => {
  // A developer with two commission rows in different months (proves the
  // per-entity roll-up sums across periods).
  const [dev] = await db.insert(platformPartnersTable).values({
    kind: "developer",
    nameAr: `${TAG} مطوّر تقرير`,
    partnerCode: `DV-${TAG.slice(-6)}`,
    commissionRate: "10.000",
    status: "approved",
  }).returning({ id: platformPartnersTable.id });
  partnerIds.push(dev.id);
  await db.insert(partnerCompaniesTable).values({ partnerId: dev.id, companyId, role: "served" });
  await db.insert(partnerCommissionsTable).values([
    { partnerId: dev.id, companyId, eventType: "app_sale", baseAmount: "1000.00", commissionRate: "10.000", commissionAmount: "100.00", periodMonth: 1, periodYear: 2026 },
    { partnerId: dev.id, companyId, eventType: "app_renewal", baseAmount: "500.00", commissionRate: "10.000", commissionAmount: "50.00", periodMonth: 2, periodYear: 2026 },
  ]);

  // An agent (reseller) with two commission rows — must appear in the SAME
  // consolidated report as entityType 'agent'.
  const [agent] = await db.insert(resellersTable).values({
    code: `AG_${TAG}`,
    nameAr: `${TAG} وكيل`,
    username: `${TAG}_agent`,
    passwordHash: await bcrypt.hash("x", 4),
    commissionRate: "5.000",
    status: "active",
  }).returning({ id: resellersTable.id });
  resellerIds.push(agent.id);
  await db.insert(resellerCompaniesTable).values({ resellerId: agent.id, companyId });
  await db.insert(resellerCommissionsTable).values([
    { resellerId: agent.id, companyId, eventType: "new_subscription", baseAmount: "2000.00", commissionRate: "5.000", commissionAmount: "100.00", periodMonth: 1, periodYear: 2026 },
    { resellerId: agent.id, companyId, eventType: "renewal", baseAmount: "1000.00", commissionRate: "5.000", commissionAmount: "50.00", periodMonth: 2, periodYear: 2026 },
  ]);

  const r = await api<{ rows: Array<Record<string, unknown>>; totals: Record<string, unknown> }>(
    "GET", "/api/admin/partners/reports/commissions", { token: saToken });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = r.body.rows;
  assert.ok(Array.isArray(rows));

  const devRow = rows.find((x) => x.entityType === "developer" && x.id === dev.id);
  assert.ok(devRow, "developer must appear in the consolidated report");
  assert.equal(Number(devRow!.companies), 1);
  assert.equal(Number(devRow!.baseAmount), 1500, "developer base sums across months");
  assert.equal(Number(devRow!.commissionTotal), 150, "developer commission sums across months");

  const agentRow = rows.find((x) => x.entityType === "agent" && x.id === agent.id);
  assert.ok(agentRow, "agent (reseller) must appear in the SAME report");
  assert.equal(Number(agentRow!.companies), 1);
  assert.equal(Number(agentRow!.baseAmount), 3000);
  assert.equal(Number(agentRow!.commissionTotal), 150);

  // Grand totals are self-consistent: equal to the sum over every returned row.
  const totals = r.body.totals;
  const sumBase = rows.reduce((a, x) => a + (Number(x.baseAmount) || 0), 0);
  const sumComm = rows.reduce((a, x) => a + (Number(x.commissionTotal) || 0), 0);
  const sumCompanies = rows.reduce((a, x) => a + (Number(x.companies) || 0), 0);
  assert.equal(Number(totals.entities), rows.length);
  assert.equal(Number(totals.companies), sumCompanies);
  assert.equal(Number(totals.baseAmount), Number(sumBase.toFixed(2)));
  assert.equal(Number(totals.commissionTotal), Number(sumComm.toFixed(2)));

  // The report must include OUR contributions in the grand totals.
  assert.ok(Number(totals.commissionTotal) >= 300, "grand commission total includes dev+agent (150+150)");
});

// ─── Per-entity ledger preserves monthly period data (year/month roll-up) ───
test("/:id/commissions returns rows carrying periodMonth/periodYear", async () => {
  // Reuse a fresh developer with one dated accrual.
  const [dev] = await db.insert(platformPartnersTable).values({
    kind: "developer",
    nameAr: `${TAG} سجل عمولات`,
    commissionRate: "10.000",
    status: "approved",
    partnerCode: `DV-L${TAG.slice(-5)}`,
  }).returning({ id: platformPartnersTable.id });
  partnerIds.push(dev.id);
  await db.insert(partnerCommissionsTable).values({
    partnerId: dev.id, companyId, eventType: "app_sale",
    baseAmount: "300.00", commissionRate: "10.000", commissionAmount: "30.00",
    periodMonth: 7, periodYear: 2026,
  });

  const r = await api<{ commissions: Array<Record<string, unknown>> }>(
    "GET", `/api/admin/partners/${dev.id}/commissions`, { token: saToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.commissions.length, 1);
  const c = r.body.commissions[0];
  assert.equal(Number(c.periodMonth), 7);
  assert.equal(Number(c.periodYear), 2026);
  assert.equal(Number(c.commissionAmount), 30);
});
