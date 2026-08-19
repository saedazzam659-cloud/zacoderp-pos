// Focused tests for the multi-source Active Sessions surface
// (artifacts/api-server/src/routes/admin.ts → /api/admin/security/sessions*).
//
// What this protects:
//   • GET /security/sessions returns CENTRAL rows stamped with source-qualified
//     row ids ("central:<userId>") and a `warnings[]` array — never a session
//     token / password hash / DB credential.
//   • POST /security/sessions/:ref/end routes by the source-qualified ref:
//       - "central:<id>" and a bare "<id>" both hit the central DB;
//       - a malformed ref → 400;
//       - "agent:<id>:<uid>" for a non-existent agent → 500 (re-validation
//         against the registry fails cleanly, no crash).
//   • POST /security/sessions/bulk-end groups by source and terminates central
//     rows, returning source-qualified endedIds.
//   • SuperAdmin role gate (401 / 403).
//
// How to run:
//   pnpm --filter @workspace/api-server test
//
// Notes:
//   - Boots the Express app in-process against the real DB (DATABASE_URL).
//   - Seeds + tears down strictly by recorded primary keys. Agent-DB code
//     paths are exercised only via the "unreachable agent" negative case so
//     the test needs no external PostgreSQL.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";

import bcrypt from "bcryptjs";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db, pool, usersTable, auditLogTable } from "@workspace/db";

import app from "../src/app.ts";

const TAG = `tt_secsess_${randomBytes(4).toString("hex")}`;

let server: http.Server;
let baseUrl: string;

let saToken: string;
let saUserId: number;
let adminToken: string;
let adminUserId: number;

// A victim user WITH an active session in the central DB — the SA will
// force-logout this one so the SA's own session stays intact for later tests.
let victimToken: string;
let victimUserId: number;

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

  saToken = "tt_sa_" + randomBytes(16).toString("hex");
  const [sa] = await db.insert(usersTable).values({
    username: `${TAG}_sa`, passwordHash: await bcrypt.hash("x", 4),
    role: "superadmin", isActive: true, sessionToken: saToken, sessionId: "test-sa", companyId: null,
  }).returning({ id: usersTable.id });
  saUserId = sa.id; userIds.push(saUserId);

  adminToken = "tt_admin_" + randomBytes(16).toString("hex");
  const [adm] = await db.insert(usersTable).values({
    username: `${TAG}_admin`, passwordHash: await bcrypt.hash("x", 4),
    role: "admin", isActive: true, sessionToken: adminToken, sessionId: "test-adm", companyId: null,
  }).returning({ id: usersTable.id });
  adminUserId = adm.id; userIds.push(adminUserId);

  victimToken = "tt_victim_" + randomBytes(16).toString("hex");
  const [victim] = await db.insert(usersTable).values({
    username: `${TAG}_victim`, passwordHash: await bcrypt.hash("x", 4),
    role: "admin", isActive: true, sessionToken: victimToken, sessionId: "test-victim", companyId: null,
  }).returning({ id: usersTable.id });
  victimUserId = victim.id; userIds.push(victimUserId);
});

after(async () => {
  try {
    if (maxAuditIdBefore > 0) {
      await db.delete(auditLogTable).where(and(
        gt(auditLogTable.id, maxAuditIdBefore),
        eq(auditLogTable.userAgent, TAG),
      ));
    }
    if (userIds.length) await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  } finally {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await pool.end().catch(() => {});
  }
});

// ─── Auth / role gate ───────────────────────────────────────────────────────
test("sessions: rejects unauthenticated request (401)", async () => {
  const r = await api("GET", "/api/admin/security/sessions");
  assert.equal(r.status, 401);
});

test("sessions: rejects non-superadmin role (403)", async () => {
  const r = await api("GET", "/api/admin/security/sessions", { token: adminToken });
  assert.equal(r.status, 403);
});

// ─── Central listing + source-qualified ids ─────────────────────────────────
test("sessions: central listing stamps source-qualified row ids and warnings[]", async () => {
  const r = await api<{ rows: any[]; total: number; warnings: unknown[] }>(
    "GET", `/api/admin/security/sessions?source=central&search=${encodeURIComponent(TAG)}&limit=50&offset=0`, { token: saToken });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.rows));
  assert.ok(Array.isArray(r.body.warnings));
  assert.equal(r.body.total, 3, "global search should count all three matching test sessions");

  const mine = r.body.rows.find((row) => row.userId === saUserId);
  assert.ok(mine, "SA's own active session must be listed");
  assert.equal(mine.source, "central");
  assert.equal(mine.rowId, `central:${saUserId}`);
  assert.equal(mine.agentInstanceId, null);
  // SECURITY: never leak the token / hash / db credentials.
  assert.equal("sessionToken" in mine, false);
  assert.equal("passwordHash" in mine, false);
  assert.equal("dbUrl" in mine, false);
  assert.equal("dbUrlEnc" in mine, false);
  // The opaque sessionId is allowed.
  assert.ok("sessionId" in mine);
});

// ─── Single termination routing ──────────────────────────────────────────────
test("sessions: malformed source ref → 400", async () => {
  const r = await api("POST", `/api/admin/security/sessions/${encodeURIComponent("not-a-ref")}/end`, { token: saToken });
  assert.equal(r.status, 400);
});

test("sessions: agent ref for non-existent agent fails cleanly (500), central untouched", async () => {
  const r = await api("POST", "/api/admin/security/sessions/agent:999999:1/end", { token: saToken });
  assert.equal(r.status, 500);
  // SA's own session must remain valid.
  const [me] = await db.select({ t: usersTable.sessionToken }).from(usersTable).where(eq(usersTable.id, saUserId));
  assert.equal(me.t, saToken);
});

test("sessions: central-qualified single end terminates only that user", async () => {
  const r = await api<{ ok: boolean; userId: number }>(
    "POST", `/api/admin/security/sessions/central:${victimUserId}/end`, { token: saToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.userId, victimUserId);

  const [v] = await db.select({ t: usersTable.sessionToken }).from(usersTable).where(eq(usersTable.id, victimUserId));
  assert.equal(v.t, null, "victim session must be cleared");
  const [me] = await db.select({ t: usersTable.sessionToken }).from(usersTable).where(eq(usersTable.id, saUserId));
  assert.equal(me.t, saToken, "SA session must be untouched");
});

test("sessions: single end on already-ended session → 400", async () => {
  const r = await api("POST", `/api/admin/security/sessions/central:${victimUserId}/end`, { token: saToken });
  assert.equal(r.status, 400);
});

// ─── Bulk termination grouping ───────────────────────────────────────────────
test("sessions: bulk-end groups by source and returns source-qualified endedIds", async () => {
  // Re-issue a session for the admin so we have a live central target.
  await db.update(usersTable).set({ sessionToken: adminToken, sessionId: "test-adm" }).where(eq(usersTable.id, adminUserId));

  const r = await api<{ ok: boolean; ended: number; endedIds: string[]; warnings: unknown[] }>(
    "POST", "/api/admin/security/sessions/bulk-end",
    { token: saToken, body: { userIds: [`central:${adminUserId}`, "agent:999999:1"] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ended, 1);
  assert.deepEqual(r.body.endedIds, [`central:${adminUserId}`]);
  // The unreachable agent surfaces as a warning, not a hard failure.
  assert.ok(Array.isArray(r.body.warnings) && r.body.warnings.length === 1);

  const [a] = await db.select({ t: usersTable.sessionToken }).from(usersTable).where(eq(usersTable.id, adminUserId));
  assert.equal(a.t, null);
});

test("sessions: bulk-end rejects empty ref list (400)", async () => {
  const r = await api("POST", "/api/admin/security/sessions/bulk-end", { token: saToken, body: { userIds: [] } });
  assert.equal(r.status, 400);
});
