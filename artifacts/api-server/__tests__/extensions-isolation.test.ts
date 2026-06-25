// Integration tests for the Extension Platform isolation guarantees
// (artifacts/api-server/src/extensions/{index,coreDataApi,dataStore}.ts).
//
// These lock in the security CORE of the whole partner platform — the three
// guarantees that an extension can NEVER reach data it shouldn't:
//
//   1. TENANT SCOPING (forced company_id): the gated Core Data API and the
//      ext_records data store both hard-scope every query to the caller's own
//      company server-side. An extension running for company A can never see
//      company B's customers, nor B's own ext_records rows — even though both
//      tenants run the SAME extension with the SAME signed manifest. The
//      extension supplies no company id and has no way to override it.
//
//   2. PERMISSION MODEL (403 without the manifest permission): the Partner
//      Toolkit manifest declares only `*:read` permissions. A core WRITE
//      (POST /core/customers, which would need `customers:write`) is refused
//      with 403 EXT_PERMISSION_DENIED before any DB work happens.
//
//   3. MANIFEST-MUST-DECLARE-COLLECTION: the data store accepts reads/writes
//      ONLY for a collection listed in the signed manifest's `tables`. An
//      undeclared collection is rejected with 404 EXT_COLLECTION_NOT_DECLARED.
//
// Also pins the two default-OFF gates that stand in front of all of the above:
//   - unauthenticated request → 401
//   - module gate / per-company enable flag → 403 when off.
//
// How to run:
//   pnpm --filter @workspace/api-server test
//   (auto-included in the `admin-reports-tests` validation workflow / CI.)
//
// Notes:
//   - Boots the Express app in-process on a random port. Uses the real DB
//     (DATABASE_URL). Seeds + tears down its own data tagged with a per-run
//     TEST_TAG; cleanup deletes strictly by recorded ids so no real tenant
//     data is touched.

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
  customersTable,
  companyExtensionsTable,
  extRecordsTable,
} from "@workspace/db";

import app from "../src/app.ts";

const EXT_ID = "partner-toolkit";

// Human-readable prefix for seeded rows. NEVER used in a DELETE — cleanup
// deletes strictly by the ids recorded at insert time.
const TEST_TAG = `tt_ext_iso_${randomBytes(4).toString("hex")}`;

let server: http.Server;
let baseUrl: string;

let companyAId: number;
let companyBId: number;
let adminAToken: string;
let adminBToken: string;

// A customer per company, used to prove cross-tenant read isolation.
let custAId: number;
let custBId: number;

const insertedCompanyIds: number[] = [];
const insertedUserIds: number[] = [];
const insertedCustomerIds: number[] = [];
// ext_records this run created (directly or via the API) so cleanup is exact.
const insertedExtRecordIds: number[] = [];

interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  text: string;
}

async function api<T = unknown>(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(baseUrl + path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: res.status, body: body as T, text };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function makeCompany(label: string): Promise<number> {
  const [co] = await db.insert(companiesTable).values({
    nameAr: `${TEST_TAG} ${label}`,
    nameEn: `${TEST_TAG} ${label}`,
    crNumber: `CR_${TEST_TAG}_${label}`,
    buildingNumber: "1",
    vatNumber: "300000000000003",
    city: "Riyadh",
    street: "Test St",
    postalCode: "12345",
    country: "SA",
    invoiceType: "both",
    status: "active",
    // Grant the default-OFF extensions_platform module gate so the admin can
    // reach the runtime surfaces. (extractAuth loads this onto authUser.)
    menuPermissions: JSON.stringify({ extensions_platform: true }),
  }).returning({ id: companiesTable.id });
  insertedCompanyIds.push(co.id);
  return co.id;
}

async function makeAdmin(companyId: number, label: string): Promise<string> {
  const token = `tt_admin_${label}_${randomBytes(16).toString("hex")}`;
  const [u] = await db.insert(usersTable).values({
    username: `${TEST_TAG}_admin_${label}`,
    email: null,
    passwordHash: await bcrypt.hash("ignored", 4),
    role: "admin",
    isActive: true,
    sessionToken: token,
    sessionId: "test",
    companyId,
  }).returning({ id: usersTable.id });
  insertedUserIds.push(u.id);
  return token;
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

  // Two independent tenants, each running the SAME extension.
  companyAId = await makeCompany("CoA");
  companyBId = await makeCompany("CoB");
  adminAToken = await makeAdmin(companyAId, "A");
  adminBToken = await makeAdmin(companyBId, "B");

  // One customer per tenant — the cross-tenant read isolation proof.
  const [cA] = await db.insert(customersTable).values({
    companyId: companyAId,
    nameAr: `${TEST_TAG} عميل أ`,
    nameEn: `${TEST_TAG} Customer A`,
  }).returning({ id: customersTable.id });
  custAId = cA.id;
  insertedCustomerIds.push(custAId);

  const [cB] = await db.insert(customersTable).values({
    companyId: companyBId,
    nameAr: `${TEST_TAG} عميل ب`,
    nameEn: `${TEST_TAG} Customer B`,
  }).returning({ id: customersTable.id });
  custBId = cB.id;
  insertedCustomerIds.push(custBId);

  // Enable the partner-toolkit extension for BOTH companies. (The platform
  // self-seeds platform_extensions on the first runtime request.)
  await db.insert(companyExtensionsTable).values([
    { companyId: companyAId, extensionId: EXT_ID, enabled: true },
    { companyId: companyBId, extensionId: EXT_ID, enabled: true },
  ]);
});

after(async () => {
  try {
    if (insertedExtRecordIds.length) {
      await db.delete(extRecordsTable).where(inArray(extRecordsTable.id, insertedExtRecordIds));
    }
    if (insertedCompanyIds.length) {
      // company_extensions has no FK cascade; sweep our enable rows by company.
      await db.delete(companyExtensionsTable).where(inArray(companyExtensionsTable.companyId, insertedCompanyIds));
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
  } finally {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    try { await pool.end(); } catch { /* already ended is fine */ }
  }
});

// Record the ext_records id that backs a created data record so cleanup can
// delete it by primary key. recordId is the API-facing UUID; we resolve the
// serial id from it.
async function trackExtRecord(recordUuid: string): Promise<void> {
  const rows = await db.select({ id: extRecordsTable.id })
    .from(extRecordsTable)
    .where(inArray(extRecordsTable.recordId, [recordUuid]));
  for (const r of rows) if (!insertedExtRecordIds.includes(r.id)) insertedExtRecordIds.push(r.id);
}

// ─── Gate: unauthenticated ──────────────────────────────────────────────────
test("rejects an unauthenticated core read (401)", async () => {
  const r = await api(`/api/ext/${EXT_ID}/core/customers`);
  assert.equal(r.status, 401);
  assert.ok(isObject(r.body) && typeof r.body.error === "string");
});

// ─── Gate: module gate / per-company enable ─────────────────────────────────
test("rejects a tenant without the extensions module gate (403)", async () => {
  // A company WITHOUT the extensions_platform gate cannot reach the runtime,
  // even with a valid admin bearer.
  const cid = await makeCompany("CoGateOff");
  // Strip the gate this helper grants by default.
  await db.update(companiesTable)
    .set({ menuPermissions: JSON.stringify({}) })
    .where(inArray(companiesTable.id, [cid]));
  const token = await makeAdmin(cid, "GateOff");
  await db.insert(companyExtensionsTable).values({ companyId: cid, extensionId: EXT_ID, enabled: true });

  const r = await api(`/api/ext/${EXT_ID}/core/customers`, { token });
  assert.equal(r.status, 403);
});

test("rejects an extension that is not enabled for the company (403)", async () => {
  // Gate is ON but the extension itself is disabled for this tenant.
  const cid = await makeCompany("CoExtOff");
  const token = await makeAdmin(cid, "ExtOff");
  // Deliberately do NOT enable partner-toolkit for this company.
  const r = await api(`/api/ext/${EXT_ID}/core/customers`, { token });
  assert.equal(r.status, 403);
});

// ─── 1. Tenant scoping: forced company_id on CORE reads ─────────────────────
test("an extension only reads its OWN tenant's core customers", async () => {
  const ra = await api<Array<{ id: number }>>(`/api/ext/${EXT_ID}/core/customers?limit=500`, { token: adminAToken });
  assert.equal(ra.status, 200, ra.text.slice(0, 200));
  assert.ok(Array.isArray(ra.body));
  const aIds = ra.body.map((c) => c.id);
  assert.ok(aIds.includes(custAId), "company A must see its own customer");
  assert.ok(!aIds.includes(custBId), "company A must NOT see company B's customer");

  const rb = await api<Array<{ id: number }>>(`/api/ext/${EXT_ID}/core/customers?limit=500`, { token: adminBToken });
  assert.equal(rb.status, 200, rb.text.slice(0, 200));
  const bIds = rb.body.map((c) => c.id);
  assert.ok(bIds.includes(custBId), "company B must see its own customer");
  assert.ok(!bIds.includes(custAId), "company B must NOT see company A's customer");
});

// ─── 1b. Tenant scoping: forced company_id on ext_records ───────────────────
test("an extension only reads its OWN tenant's ext_records", async () => {
  // Each tenant creates a private note in the SAME extension/collection.
  const ca = await api<{ id: string; data: unknown }>(`/api/ext/${EXT_ID}/data/notes`, {
    method: "POST", token: adminAToken, body: { data: { text: `${TEST_TAG}-A-secret` } },
  });
  assert.equal(ca.status, 200, ca.text.slice(0, 200));
  await trackExtRecord(ca.body.id);

  const cb = await api<{ id: string }>(`/api/ext/${EXT_ID}/data/notes`, {
    method: "POST", token: adminBToken, body: { data: { text: `${TEST_TAG}-B-secret` } },
  });
  assert.equal(cb.status, 200, cb.text.slice(0, 200));
  await trackExtRecord(cb.body.id);

  // Company A lists notes: sees ONLY its own.
  const la = await api<Array<{ id: string; data: { text?: string } }>>(`/api/ext/${EXT_ID}/data/notes?limit=500`, { token: adminAToken });
  assert.equal(la.status, 200);
  const aTexts = la.body.map((r) => r.data?.text);
  assert.ok(aTexts.includes(`${TEST_TAG}-A-secret`), "A sees its own note");
  assert.ok(!aTexts.includes(`${TEST_TAG}-B-secret`), "A must NOT see B's note");
  assert.ok(!la.body.some((r) => r.id === cb.body.id), "A must NOT see B's record id");

  // Company B cannot fetch company A's record by its id (404, not the row).
  const cross = await api(`/api/ext/${EXT_ID}/data/notes/${encodeURIComponent(ca.body.id)}`, { token: adminBToken });
  assert.equal(cross.status, 404, "B fetching A's record id must 404, never return A's data");
});

// ─── 1c. Tenant scoping: forced company_id on ext_records WRITES ─────────────
test("an extension cannot UPDATE or DELETE another tenant's ext_records by id", async () => {
  // Company A creates a private note. Its record id is the only thing an
  // attacker needs to guess — everything else (extension, collection) is shared.
  const created = await api<{ id: string; data: { text?: string } }>(`/api/ext/${EXT_ID}/data/notes`, {
    method: "POST", token: adminAToken, body: { data: { text: `${TEST_TAG}-A-write-target` } },
  });
  assert.equal(created.status, 200, created.text.slice(0, 200));
  await trackExtRecord(created.body.id);
  const recordId = created.body.id;

  // Company B tries to OVERWRITE company A's record by its id → 404, never 200.
  const putAttempt = await api<{ code?: string }>(
    `/api/ext/${EXT_ID}/data/notes/${encodeURIComponent(recordId)}`,
    { method: "PUT", token: adminBToken, body: { data: { text: `${TEST_TAG}-B-tampered` } } },
  );
  assert.equal(putAttempt.status, 404, "B updating A's record id must 404");
  assert.ok(
    isObject(putAttempt.body) && putAttempt.body.code === "EXT_RECORD_NOT_FOUND",
    `expected EXT_RECORD_NOT_FOUND, got ${putAttempt.text.slice(0, 200)}`,
  );

  // Company B tries to DELETE company A's record by its id → 404, never 200.
  const deleteAttempt = await api<{ code?: string }>(
    `/api/ext/${EXT_ID}/data/notes/${encodeURIComponent(recordId)}`,
    { method: "DELETE", token: adminBToken },
  );
  assert.equal(deleteAttempt.status, 404, "B deleting A's record id must 404");
  assert.ok(
    isObject(deleteAttempt.body) && deleteAttempt.body.code === "EXT_RECORD_NOT_FOUND",
    `expected EXT_RECORD_NOT_FOUND, got ${deleteAttempt.text.slice(0, 200)}`,
  );

  // After both attempts, company A can still read its record, UNCHANGED.
  const reread = await api<{ id: string; data: { text?: string } }>(
    `/api/ext/${EXT_ID}/data/notes/${encodeURIComponent(recordId)}`,
    { token: adminAToken },
  );
  assert.equal(reread.status, 200, "A's record must survive B's tamper attempts");
  assert.equal(reread.body.id, recordId);
  assert.equal(
    reread.body.data?.text,
    `${TEST_TAG}-A-write-target`,
    "A's record data must be untouched by B's PUT",
  );
});

// ─── 2. Permission model: a read-only extension is refused a core WRITE ───────
test("a read-only extension is refused a core write (403 EXT_PERMISSION_DENIED)", async () => {
  // partner-toolkit declares customers:read but NOT customers:write.
  const r = await api<{ code?: string }>(`/api/ext/${EXT_ID}/core/customers`, {
    method: "POST", token: adminAToken, body: { nameAr: `${TEST_TAG} should not insert` },
  });
  assert.equal(r.status, 403);
  assert.ok(isObject(r.body) && r.body.code === "EXT_PERMISSION_DENIED", `expected EXT_PERMISSION_DENIED, got ${r.text.slice(0, 200)}`);

  // Belt-and-braces: confirm nothing was written for this tenant.
  const list = await api<Array<{ nameAr?: string }>>(`/api/ext/${EXT_ID}/core/customers?limit=500`, { token: adminAToken });
  assert.ok(!list.body.some((c) => c.nameAr === `${TEST_TAG} should not insert`), "the denied write must not have persisted");
});

// ─── 3. Manifest-must-declare-collection ────────────────────────────────────
test("an undeclared collection is rejected (404 EXT_COLLECTION_NOT_DECLARED)", async () => {
  // partner-toolkit declares only the `notes` collection.
  const read = await api<{ code?: string }>(`/api/ext/${EXT_ID}/data/secrets`, { token: adminAToken });
  assert.equal(read.status, 404);
  assert.ok(isObject(read.body) && read.body.code === "EXT_COLLECTION_NOT_DECLARED", `expected EXT_COLLECTION_NOT_DECLARED, got ${read.text.slice(0, 200)}`);

  const write = await api<{ code?: string }>(`/api/ext/${EXT_ID}/data/secrets`, {
    method: "POST", token: adminAToken, body: { data: { x: 1 } },
  });
  assert.equal(write.status, 404);
  assert.ok(isObject(write.body) && write.body.code === "EXT_COLLECTION_NOT_DECLARED");
});

// ─── Permission model: a granted core read still works ──────────────────────
test("a granted core read (items:read) succeeds", async () => {
  const r = await api(`/api/ext/${EXT_ID}/core/items?limit=1`, { token: adminAToken });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.ok(Array.isArray(r.body));
});

// ─── Permission model: a resource the manifest never requested is denied ────
test("a core read of an unrequested resource is denied (403)", async () => {
  // partner-toolkit never requests suppliers:read.
  const r = await api<{ code?: string }>(`/api/ext/${EXT_ID}/core/suppliers`, { token: adminAToken });
  assert.equal(r.status, 403);
  assert.ok(isObject(r.body) && r.body.code === "EXT_PERMISSION_DENIED");
});
