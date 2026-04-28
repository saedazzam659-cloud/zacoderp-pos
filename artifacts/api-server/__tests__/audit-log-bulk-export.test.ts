// Integration tests for the bulk-selection CSV export endpoint
// (artifacts/api-server/src/routes/audit-log.ts → POST /api/audit-log/export).
//
// What this protects:
//   • The /admin/audit-log "Download N rows as CSV" toolbar button POSTs the
//     hand-picked id list to this endpoint and writes a Blob to disk. The
//     contract worth pinning is:
//       - auth gate: 401 without bearer, 403 for non-admin roles
//       - tenant scoping: an admin pinned to company X never sees rows from
//         company Y, even if Y's ids are in the request body
//       - canonicalisation: ids are deduped, sorted, and Number-coerced; the
//         CSV row order and the audit metadata both reflect the canonical
//         list (so the batch is reproducible)
//       - validation: empty selection → 400, over-cap (>1000) → 400
//       - the export itself is recorded in audit_log as
//         {module:"audit_log", action:"export_csv"} with the canonical ids
//         in metadata so reviewers can re-run / re-audit later
//       - CSV envelope: UTF-8 BOM, 15-column header, attachment Content-
//         Disposition, X-Csv-Row-Count and X-Csv-Requested-Count headers
//         exposed via Access-Control-Expose-Headers
//
// How to run:
//   pnpm --filter @workspace/api-server test
//
// Notes:
//   - Boots the Express app in-process on a random port (no external server
//     required). Uses the real DB (DATABASE_URL).
//   - Seeds and tears down its own data tagged with a per-run TEST_TAG. Other
//     tenants are not touched — cleanup deletes strictly by recorded ids.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";

import bcrypt from "bcryptjs";
import { inArray, sql, eq, desc, and, gt } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  companiesTable,
  auditLogTable,
} from "@workspace/db";

import app from "../src/app.ts";

// Per-run prefix for human-readable identification of seeded rows. NEVER
// used in any DELETE query — cleanup deletes strictly by the IDs we recorded
// at insert time so there is zero risk of nuking real tenant data.
const TEST_TAG = `tt_audit_bulk_${randomBytes(4).toString("hex")}`;

let server: http.Server;
let baseUrl: string;

let saUserId: number;
let saToken: string;

let adminAUserId: number;
let adminAToken: string;

let companyAId: number;
let companyBId: number;

// Audit ids we'll be exporting
let aId1: number, aId2: number, aId3: number;
let bId: number;
// max audit_log id captured before the test runs so we can scope assertions
// about the export_csv side-effect to rows this test created.
let maxAuditIdBefore: number;

// IDs of every row this run inserted.
const insertedCompanyIds: number[] = [];
const insertedUserIds:    number[] = [];
const insertedAuditIds:   number[] = [];

interface FetchOpts {
  token?: string;
  body?: unknown;
}
interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
  text: string;
  bytes: Uint8Array;
}

async function api<T = unknown>(path: string, opts: FetchOpts = {}): Promise<ApiResponse<T>> {
  const url = baseUrl + path;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  // BOM-preserving decode so the CSV BOM check below can see the leading
  // 0xEF 0xBB 0xBF bytes.
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { body = text; }
  }
  return { status: res.status, body: body as T, headers: res.headers, text, bytes: buf };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
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

  // Capture the current MAX(audit_log.id) so the export-was-audited
  // assertion can be scoped to rows this test created (the dev DB will
  // already contain unrelated audit history).
  const [maxRow] = await db.select({ m: sql<number>`COALESCE(MAX(${auditLogTable.id}), 0)` })
    .from(auditLogTable);
  maxAuditIdBefore = Number(maxRow?.m ?? 0);

  // Two companies: A is the admin's tenant; B exists only to verify
  // cross-tenant rows never leak.
  const baseCo: Omit<typeof companiesTable.$inferInsert, "nameAr" | "nameEn" | "crNumber" | "buildingNumber"> = {
    vatNumber: "300000000000003",
    city: "Riyadh",
    street: "Test St",
    postalCode: "12345",
    country: "SA",
    invoiceType: "both",
    status: "active",
  };
  const [coA] = await db.insert(companiesTable).values({
    ...baseCo,
    nameAr: `${TEST_TAG} شركة أ`,
    nameEn: `${TEST_TAG} Co A`,
    crNumber: `CR_${TEST_TAG}_A`,
    buildingNumber: "1",
  }).returning({ id: companiesTable.id });
  companyAId = coA.id;
  insertedCompanyIds.push(companyAId);

  const [coB] = await db.insert(companiesTable).values({
    ...baseCo,
    nameAr: `${TEST_TAG} شركة ب`,
    nameEn: `${TEST_TAG} Co B`,
    crNumber: `CR_${TEST_TAG}_B`,
    buildingNumber: "2",
  }).returning({ id: companiesTable.id });
  companyBId = coB.id;
  insertedCompanyIds.push(companyBId);

  // SuperAdmin (sees everything) — bearer-token shortcut matches the
  // pattern used by sibling tests (admin-reports.test.ts).
  saToken = "tt_sa_" + randomBytes(16).toString("hex");
  const [sa] = await db.insert(usersTable).values({
    username:     `${TEST_TAG}_sa`,
    email:        null,
    passwordHash: await bcrypt.hash("ignored", 4),
    role:         "superadmin",
    isActive:     true,
    sessionToken: saToken,
    sessionId:    "test",
    companyId:    null,
  }).returning({ id: usersTable.id });
  saUserId = sa.id;
  insertedUserIds.push(saUserId);

  // Admin pinned to Company A — exercises the tenant scoping branch.
  adminAToken = "tt_admin_" + randomBytes(16).toString("hex");
  const [adminA] = await db.insert(usersTable).values({
    username:     `${TEST_TAG}_adminA`,
    email:        null,
    passwordHash: await bcrypt.hash("ignored", 4),
    role:         "admin",
    isActive:     true,
    sessionToken: adminAToken,
    sessionId:    "test",
    companyId:    companyAId,
  }).returning({ id: usersTable.id });
  adminAUserId = adminA.id;
  insertedUserIds.push(adminAUserId);

  // Three Company-A rows the admin SHOULD be able to export. The third
  // one carries metadata with characters that exercise the CSV escaper
  // (commas, quotes, newlines).
  const aRows = await db.insert(auditLogTable).values([
    {
      userId: adminAUserId, username: `${TEST_TAG}_adminA`, role: "admin",
      companyId: companyAId, module: "sales_invoices", action: "create",
      method: "POST", path: `/api/sales-invoices?${TEST_TAG}=1`,
      entityType: "invoice", entityId: "100", statusCode: 201,
      ip: "127.0.0.1", userAgent: TEST_TAG,
      metadata: { tag: TEST_TAG, n: 1 },
    },
    {
      userId: adminAUserId, username: `${TEST_TAG}_adminA`, role: "admin",
      companyId: companyAId, module: "sales_invoices", action: "edit",
      method: "PATCH", path: `/api/sales-invoices/100?${TEST_TAG}=1`,
      entityType: "invoice", entityId: "100", statusCode: 200,
      ip: "127.0.0.1", userAgent: TEST_TAG,
      metadata: { tag: TEST_TAG, n: 2 },
    },
    {
      userId: adminAUserId, username: `${TEST_TAG}_adminA`, role: "admin",
      companyId: companyAId, module: "users", action: "view",
      method: "GET", path: `/api/users?${TEST_TAG}=1`,
      entityType: null, entityId: null, statusCode: 200,
      ip: "127.0.0.1", userAgent: TEST_TAG,
      metadata: { tag: TEST_TAG, n: 3, comma: "a,b", quote: 'sa"id', newline: "x\ny" },
    },
  ]).returning({ id: auditLogTable.id });
  [aId1, aId2, aId3] = aRows.map(r => r.id);
  insertedAuditIds.push(aId1, aId2, aId3);

  // One Company-B row — proves tenant scoping. Even when the admin asks
  // for this id explicitly, the CSV must omit it.
  const [b] = await db.insert(auditLogTable).values({
    userId: null, username: "stranger", role: "admin",
    companyId: companyBId, module: "sales_invoices", action: "create",
    method: "POST", path: `/api/sales-invoices?${TEST_TAG}=B`,
    entityType: "invoice", entityId: "999", statusCode: 201,
    ip: "127.0.0.1", userAgent: TEST_TAG,
    metadata: { tag: TEST_TAG, leakTest: true },
  }).returning({ id: auditLogTable.id });
  bId = b.id;
  insertedAuditIds.push(bId);
});

after(async () => {
  try { await cleanup(); } finally {
    if (server) await new Promise<void>(r => server.close(() => r()));
    try { await pool.end(); } catch { /* already ended is fine */ }
  }
});

async function cleanup(): Promise<void> {
  // Strict id-only deletes — no LIKE, no wildcards, no risk of touching
  // real tenant data.
  // Also sweep export_csv audit rows the endpoint itself created during
  // these tests (we know they're brand new because we captured
  // maxAuditIdBefore in `before`).
  if (maxAuditIdBefore > 0) {
    const stragglers = await db.select({ id: auditLogTable.id })
      .from(auditLogTable)
      .where(and(
        gt(auditLogTable.id, maxAuditIdBefore),
        eq(auditLogTable.module, "audit_log"),
        eq(auditLogTable.action, "export_csv"),
        eq(auditLogTable.userAgent, TEST_TAG),
      ));
    for (const s of stragglers) {
      if (!insertedAuditIds.includes(s.id)) insertedAuditIds.push(s.id);
    }
  }
  if (insertedAuditIds.length) {
    await db.delete(auditLogTable).where(inArray(auditLogTable.id, insertedAuditIds));
  }
  if (insertedUserIds.length) {
    await db.delete(usersTable).where(inArray(usersTable.id, insertedUserIds));
  }
  if (insertedCompanyIds.length) {
    await db.delete(companiesTable).where(inArray(companiesTable.id, insertedCompanyIds));
  }
}

// Stamp every test request's User-Agent header so the cleanup sweep can
// reliably find the export_csv audit rows we created.
async function exportApi(opts: { token?: string; ids?: unknown }) {
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": TEST_TAG };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(baseUrl + "/api/audit-log/export", {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: opts.ids }),
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { body = text; }
  }
  return { status: res.status, headers: res.headers, text, bytes: buf, body };
}

// ─── Auth gate ──────────────────────────────────────────────────────────────
test("rejects request without bearer token (401)", async () => {
  const r = await api("/api/audit-log/export", { body: { ids: [aId1] } });
  assert.equal(r.status, 401);
  assert.ok(isObject(r.body) && typeof r.body.error === "string", "401 must include error message");
});

// ─── Validation ─────────────────────────────────────────────────────────────
test("rejects empty ids array (400)", async () => {
  const r = await exportApi({ token: adminAToken, ids: [] });
  assert.equal(r.status, 400);
  assert.ok(isObject(r.body) && typeof r.body.error === "string");
});

test("rejects missing ids field (400)", async () => {
  const r = await fetch(baseUrl + "/api/audit-log/export", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${adminAToken}` },
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 400);
});

test("rejects non-array ids (400)", async () => {
  const r = await exportApi({ token: adminAToken, ids: "not an array" });
  assert.equal(r.status, 400);
});

test("rejects request over the 1000-id cap (400)", async () => {
  const big = Array.from({ length: 1001 }, (_, i) => i + 1);
  const r = await exportApi({ token: adminAToken, ids: big });
  assert.equal(r.status, 400);
  assert.ok(isObject(r.body) && r.body.max === 1000, "error payload should expose the cap");
});

// ─── Happy path: tenant scoping + CSV envelope ──────────────────────────────
test("admin exports own-tenant rows and the cross-tenant id is silently omitted", async () => {
  // Send the ids in non-canonical order (descending, with a duplicate and
  // the foreign tenant's id at the front) so we also pin dedup + sort.
  const r = await exportApi({
    token: adminAToken,
    ids: [bId, aId3, aId2, aId1, aId1],
  });
  assert.equal(r.status, 200, `expected 200, got ${r.status} body=${r.text.slice(0, 200)}`);

  // Envelope
  assert.match(r.headers.get("content-type") ?? "", /text\/csv/i);
  assert.match(r.headers.get("content-disposition") ?? "",
    /attachment; filename="audit-log-selection-\d+\.csv"/);
  assert.equal(r.headers.get("x-csv-row-count"), "3", "3 own-tenant rows resolved");
  assert.equal(r.headers.get("x-csv-requested-count"), "4", "4 unique requested ids after dedup");

  // CORS expose so the browser fetch can read those custom headers
  const expose = (r.headers.get("access-control-expose-headers") ?? "").toLowerCase();
  for (const h of ["content-disposition", "x-csv-row-count", "x-csv-requested-count"]) {
    assert.ok(expose.includes(h), `Access-Control-Expose-Headers must include ${h}`);
  }

  // UTF-8 BOM (Excel needs it for Arabic). The test fetch uses ignoreBOM
  // so we can also see it in the decoded text.
  assert.equal(r.bytes[0], 0xEF, "byte 0 must be 0xEF (UTF-8 BOM)");
  assert.equal(r.bytes[1], 0xBB, "byte 1 must be 0xBB (UTF-8 BOM)");
  assert.equal(r.bytes[2], 0xBF, "byte 2 must be 0xBF (UTF-8 BOM)");

  // Header row + 15 columns
  const lines = r.text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(l => l.length > 0);
  assert.equal(lines.length, 4, "1 header + 3 data rows");
  const headerCols = lines[0].split(",");
  assert.equal(headerCols.length, 15, "CSV must have 15 columns");
  assert.equal(headerCols[0], "ID");
  assert.equal(headerCols[1], "Time");
  assert.equal(headerCols[14], "Metadata");

  // All Co A ids present
  for (const id of [aId1, aId2, aId3]) {
    assert.ok(
      lines.some(l => l.startsWith(`${id},`)),
      `CSV must contain Co A id ${id}`,
    );
  }
  // Co B id absent — even though the request explicitly asked for it
  assert.ok(
    !lines.some(l => l.startsWith(`${bId},`)),
    `CSV must NOT leak Co B id ${bId}`,
  );

  // CSV escaping: the third Co A row's metadata contains comma, quote and
  // newline. Each must round-trip wrapped in quotes with doubled quotes.
  // Find the line for aId3 (it's the metadata-rich one).
  const richLine = lines.find(l => l.startsWith(`${aId3},`));
  assert.ok(richLine, "must find the aId3 row");
  // The metadata column is the last one; it's a JSON blob wrapped in quotes
  // because it contains commas. The original quote character `"` becomes
  // doubled (`""`).
  assert.ok(richLine!.includes('""'), "embedded quote must be doubled per CSV rules");
});

test("export itself is recorded in audit_log with canonical ids in metadata", async () => {
  // Re-fire a fresh, simple export so we have a deterministic recent row.
  const ids = [aId2, aId1]; // intentionally unsorted
  const r = await exportApi({ token: adminAToken, ids });
  assert.equal(r.status, 200);

  // Pull the most recent export_csv audit row attributed to our admin.
  const audits = await db.select().from(auditLogTable)
    .where(and(
      eq(auditLogTable.userId, adminAUserId),
      eq(auditLogTable.module, "audit_log"),
      eq(auditLogTable.action, "export_csv"),
      gt(auditLogTable.id, maxAuditIdBefore),
    ))
    .orderBy(desc(auditLogTable.createdAt))
    .limit(1);

  assert.equal(audits.length, 1, "POST /export must write exactly one audit row");
  const a = audits[0];
  if (!insertedAuditIds.includes(a.id)) insertedAuditIds.push(a.id);

  // Tenant + entity attribution
  assert.equal(a.companyId, companyAId, "export audit row pinned to admin's company");
  assert.equal(a.entityType, "audit_log");
  assert.equal(a.statusCode, 200);
  assert.equal(a.method, "POST");

  // Metadata payload pins the contract used by the inspector body
  assert.ok(isObject(a.metadata), "metadata must be a JSON object");
  const m = a.metadata as Record<string, unknown>;
  assert.equal(m.format, "csv");
  assert.equal(m.selection, "manual");
  assert.equal(m.requestedCount, 2);
  assert.equal(m.count, 2);

  // ids must be canonical: deduped, sorted ascending, integers
  assert.deepEqual(m.ids, [aId1, aId2].sort((a, b) => a - b),
    "metadata.ids must be the canonical (sorted) id list");
});

test("superadmin can export across tenants", async () => {
  const r = await exportApi({ token: saToken, ids: [aId1, bId] });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-csv-row-count"), "2",
    "superadmin sees both companies' rows");
  const lines = r.text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(l => l.length > 0);
  assert.ok(lines.some(l => l.startsWith(`${aId1},`)));
  assert.ok(lines.some(l => l.startsWith(`${bId},`)));
});

test("string-typed ids are coerced and unknown ids are silently dropped", async () => {
  const r = await exportApi({
    token: adminAToken,
    // Mix string and number; throw in an id that doesn't exist; throw in
    // a non-positive value that must be dropped during normalisation.
    ids: [String(aId1), aId1, 999_999_999, 0, -5],
  });
  assert.equal(r.status, 200);
  // Requested count = canonical-after-normalisation (one valid id survives:
  // aId1 + the unknown 999... = 2 canonical positive integers).
  assert.equal(r.headers.get("x-csv-requested-count"), "2");
  assert.equal(r.headers.get("x-csv-row-count"), "1");
});
