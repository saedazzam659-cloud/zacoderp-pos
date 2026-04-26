// Integration tests for the two SuperAdmin "old email-runs" retention
// endpoints (artifacts/api-server/src/routes/admin.ts):
//
//   GET  /api/admin/maintenance/old-report-email-runs        (preview JSON / CSV)
//   POST /api/admin/maintenance/old-report-email-runs/fix    (delete by retention)
//   GET  /api/admin/maintenance/old-maintenance-email-runs   (preview JSON / CSV)
//   POST /api/admin/maintenance/old-maintenance-email-runs/fix (delete by retention)
//
// Plus the underlying `checkOldReportEmailRuns` helper in
// artifacts/api-server/src/lib/maintenanceChecks.ts (the
// `checkOldMaintenanceEmailRuns` sibling already has direct coverage in
// maintenance.test.ts; we only re-cover it through the endpoint suite here).
//
// What this protects:
//   • Both tables (`report_email_schedule_runs` and `maintenance_email_runs`)
//     are *global* — there's no company_id column to constrain DELETEs to
//     this tenant. A wrong cutoff or an accidental cross-table delete would
//     silently nuke real audit history. The tests pin:
//       - GET counts only rows older than the configured `days` window and
//         leaves recent rows alone.
//       - GET returns the documented oldest/newest pair for the filtered set.
//       - POST/fix removes rows older than the cutoff and leaves recent rows
//         intact (proving the route doesn't accidentally truncate the table).
//       - POST/fix writes a `fix` audit-log entry attributed to the calling
//         SuperAdmin and tagged with the requested companyId — without it the
//         maintenance-history panel loses the change-of-record.
//       - CSV branch returns text/csv with the documented Arabic header row
//         AND writes an `export_csv` audit row so the audit trail captures
//         who pulled the file.
//       - Auth gates: 401 without a bearer token, 403 for any non-superadmin,
//         400 when companyId is missing (mirrors maintGuard's contract).
//
// How to run:
//   pnpm --filter @workspace/api-server test
//
// Notes:
//   - Boots the Express app in-process on a random port (no external server
//     required). Uses the real DB (DATABASE_URL).
//   - Seeds rows are tracked by primary key; cleanup deletes strictly by
//     recorded IDs so a crashed run never touches another tenant's data.
//   - Because both tables are global, the POST tests use a `days` cutoff
//     that's far enough below the recent watermark to ensure the only rows
//     in the cutoff window we expect to delete are the ones we just seeded.
//     Other concurrent/seeded rows in shared dev DBs would only be deleted
//     if they were already past the chosen retention — exactly what the
//     production endpoint does, so it's a safe operation against any DB.

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
  auditLogTable,
  maintenanceEmailRunsTable,
  reportEmailScheduleRunsTable,
} from "@workspace/db";

import app from "../src/app.ts";
import { checkOldReportEmailRuns } from "../src/lib/maintenanceChecks.ts";

// ─── Test scoping ───────────────────────────────────────────────────────────
// Per-run prefix used purely for human-readable identification of seeded rows
// (e.g. when inspecting the DB after a crash). It is NEVER used in any DELETE
// query — cleanup deletes strictly by IDs we tracked at insert time so there
// is zero risk of nuking real tenant data.
const TEST_TAG = `tt_email_runs_${randomBytes(4).toString("hex")}`;

let server: http.Server;
let baseUrl: string;

let saUserId: number;
let saToken: string;

let regularUserId: number;
let regularToken: string;

let testCompanyId: number;

// IDs of every row this run inserted, recorded right after each insert.
// Used by cleanup() to delete strictly by primary key — no LIKE / wildcards.
const insertedCompanyIds:        number[] = [];
const insertedUserIds:           number[] = [];
const insertedAuditLogIds:       number[] = [];
const insertedMaintEmailRunIds:  number[] = [];
const insertedReportRunIds:      number[] = [];

// ─── Fetch helper ───────────────────────────────────────────────────────────
interface FetchOpts {
  token?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}
interface ApiResponse<T = unknown> {
  status:  number;
  body:    T;
  headers: Headers;
  text:    string;       // BOM-preserving decode so CSV BOM checks see EF BB BF
  bytes:   Uint8Array;   // raw response bytes
}

async function api<T = unknown>(
  path: string,
  method: "GET" | "POST",
  opts: FetchOpts = {},
): Promise<ApiResponse<T>> {
  const url = new URL(baseUrl + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
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

  // Seed a SuperAdmin with a deterministic sessionToken (bypasses login).
  saToken = "tt_sa_" + randomBytes(16).toString("hex");
  const saHash = await bcrypt.hash("ignored-test-pw", 4);
  const [sa] = await db.insert(usersTable).values({
    username:     `${TEST_TAG}_sa`,
    email:        null,
    passwordHash: saHash,
    role:         "superadmin",
    isActive:     true,
    sessionToken: saToken,
    sessionId:    "test",
    companyId:    null,
  }).returning({ id: usersTable.id });
  saUserId = sa.id;
  insertedUserIds.push(saUserId);

  // Tenant company — only purpose is to satisfy maintGuard's `companyId`
  // requirement and give the audit-log entries a real FK target. The two
  // tables under test are global, so no per-tenant data is needed here.
  const companyValues: typeof companiesTable.$inferInsert = {
    nameAr:         `${TEST_TAG} شركة`,
    nameEn:         `${TEST_TAG} Co`,
    vatNumber:      "300000000000003",
    crNumber:       `CR_${TEST_TAG}`,
    city:           "Riyadh",
    street:         "Test St",
    buildingNumber: "1",
    postalCode:     "12345",
    country:        "SA",
    invoiceType:    "both",
    status:         "active",
  };
  const [co] = await db.insert(companiesTable).values(companyValues).returning({ id: companiesTable.id });
  testCompanyId = co.id;
  insertedCompanyIds.push(testCompanyId);

  // Regular (admin-role, not superadmin) user belonging to the tenant. Used
  // for the 403 tests.
  regularToken = "tt_user_" + randomBytes(16).toString("hex");
  const userHash = await bcrypt.hash("ignored-test-pw", 4);
  const regularValues: typeof usersTable.$inferInsert = {
    username:     `${TEST_TAG}_user`,
    email:        null,
    passwordHash: userHash,
    role:         "admin",
    isActive:     true,
    sessionToken: regularToken,
    sessionId:    "test",
    companyId:    testCompanyId,
  };
  const [u] = await db.insert(usersTable).values(regularValues).returning({ id: usersTable.id });
  regularUserId = u.id;
  insertedUserIds.push(regularUserId);
});

after(async () => {
  try { await cleanup(); } finally {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    try { await pool.end(); } catch { /* already ended is fine */ }
  }
});

async function cleanup(): Promise<void> {
  // Strict-by-PK cleanup. inArray with an empty list is a no-op in drizzle's
  // pg adapter when guarded; we guard explicitly so the conditional reads
  // cleanly.
  if (insertedAuditLogIds.length) {
    await db.delete(auditLogTable).where(inArray(auditLogTable.id, insertedAuditLogIds));
  }
  if (insertedMaintEmailRunIds.length) {
    await db.delete(maintenanceEmailRunsTable)
      .where(inArray(maintenanceEmailRunsTable.id, insertedMaintEmailRunIds));
  }
  if (insertedReportRunIds.length) {
    await db.delete(reportEmailScheduleRunsTable)
      .where(inArray(reportEmailScheduleRunsTable.id, insertedReportRunIds));
  }
  if (insertedUserIds.length) {
    await db.delete(usersTable).where(inArray(usersTable.id, insertedUserIds));
  }
  if (insertedCompanyIds.length) {
    await db.delete(companiesTable).where(inArray(companiesTable.id, insertedCompanyIds));
  }
}

// ─── Per-endpoint config ────────────────────────────────────────────────────
// Both endpoints share the same shape (preview / fix / CSV / audit), so we
// drive the suite parametrically. Each cfg knows how to insert a row into
// "its" table, which CSV header row to expect, and the `entityType` written
// to audit_log so per-test assertions stay scoped.
interface EndpointConfig {
  name:            string;
  routePath:       string;     // e.g. "/api/admin/maintenance/old-report-email-runs"
  entityType:      string;     // audit_log.entity_type for fix/export rows
  expectedHeaders: readonly string[];
  trackedIds:      number[];   // pushed-to so cleanup can reach the row
  insertOld(ranAt: Date, tag?: string): Promise<number>;
  survivors(ids: number[]): Promise<number[]>;
}

const REPORT_CFG: EndpointConfig = {
  name:            "old-report-email-runs",
  routePath:       "/api/admin/maintenance/old-report-email-runs",
  entityType:      "old_report_email_runs",
  expectedHeaders: ["المعرّف", "تاريخ التشغيل", "المصدر", "الحالة", "التقارير", "المستلمون", "الرسالة"],
  trackedIds:      insertedReportRunIds,
  async insertOld(ranAt, tag) {
    const [r] = await db.insert(reportEmailScheduleRunsTable).values({
      ranAt,
      trigger:    "scheduled",
      status:     "ok",
      reports:    ["operational-summary"],
      recipients: 1,
      message:    tag ?? TEST_TAG,
    }).returning({ id: reportEmailScheduleRunsTable.id });
    insertedReportRunIds.push(r.id);
    return r.id;
  },
  async survivors(ids) {
    if (!ids.length) return [];
    const rows = await db.select({ id: reportEmailScheduleRunsTable.id })
      .from(reportEmailScheduleRunsTable)
      .where(inArray(reportEmailScheduleRunsTable.id, ids));
    return rows.map((r) => r.id);
  },
};

const MAINT_CFG: EndpointConfig = {
  name:            "old-maintenance-email-runs",
  routePath:       "/api/admin/maintenance/old-maintenance-email-runs",
  entityType:      "old_maintenance_email_runs",
  expectedHeaders: ["المعرّف", "تاريخ التشغيل", "المصدر", "الحالة", "المستلمون", "عدد الحرجة", "السبب", "البصمة", "الخطأ"],
  trackedIds:      insertedMaintEmailRunIds,
  async insertOld(ranAt, tag) {
    const [r] = await db.insert(maintenanceEmailRunsTable).values({
      ranAt,
      trigger:           "scheduled",
      status:            "ok",
      recipients:        1,
      criticalCount:     0,
      reason:            "digest_sent",
      criticalSignature: tag ?? TEST_TAG,
      error:             null,
    }).returning({ id: maintenanceEmailRunsTable.id });
    insertedMaintEmailRunIds.push(r.id);
    return r.id;
  },
  async survivors(ids) {
    if (!ids.length) return [];
    const rows = await db.select({ id: maintenanceEmailRunsTable.id })
      .from(maintenanceEmailRunsTable)
      .where(inArray(maintenanceEmailRunsTable.id, ids));
    return rows.map((r) => r.id);
  },
};

const ENDPOINTS: readonly EndpointConfig[] = [REPORT_CFG, MAINT_CFG];

// ─── Shared response shapes (typed so a column drift surfaces at compile) ──
interface PreviewItem {
  id:    number;
  ranAt: string;
}
interface PreviewResponse {
  count:  number;
  days:   number;
  oldest: string | null;
  newest: string | null;
  items:  PreviewItem[];
}
interface FixResponse {
  ok:      boolean;
  deleted: number;
  days:    number;
}

// ════════════════════════════════════════════════════════════════════════════
//  Auth + validation gates — applied identically to both endpoints
// ════════════════════════════════════════════════════════════════════════════
for (const cfg of ENDPOINTS) {
  test(`GET ${cfg.routePath}: 401 without bearer token`, async () => {
    const r = await api(cfg.routePath, "GET", { query: { companyId: testCompanyId } });
    assert.equal(r.status, 401);
  });

  test(`GET ${cfg.routePath}: 403 for non-superadmin`, async () => {
    const r = await api(cfg.routePath, "GET",
      { token: regularToken, query: { companyId: testCompanyId } });
    assert.equal(r.status, 403);
  });

  test(`GET ${cfg.routePath}: 400 when companyId is missing`, async () => {
    // maintGuard rejects when the query/body is missing or non-positive. Two
    // cases here — no companyId at all and a non-numeric one — both should
    // hit the same branch.
    const missing = await api(cfg.routePath, "GET", { token: saToken });
    assert.equal(missing.status, 400);
    const bogus = await api(cfg.routePath, "GET",
      { token: saToken, query: { companyId: "not-a-number" } });
    assert.equal(bogus.status, 400);
  });

  test(`POST ${cfg.routePath}/fix: 401 without bearer token`, async () => {
    const r = await api(`${cfg.routePath}/fix`, "POST",
      { body: { companyId: testCompanyId } });
    assert.equal(r.status, 401);
  });

  test(`POST ${cfg.routePath}/fix: 403 for non-superadmin`, async () => {
    const r = await api(`${cfg.routePath}/fix`, "POST",
      { token: regularToken, body: { companyId: testCompanyId } });
    assert.equal(r.status, 403);
  });

  test(`POST ${cfg.routePath}/fix: 400 when companyId is missing`, async () => {
    const r = await api(`${cfg.routePath}/fix`, "POST",
      { token: saToken, body: {} });
    assert.equal(r.status, 400);
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  GET preview — counts rows older than `days`, ignores recent rows
// ════════════════════════════════════════════════════════════════════════════
for (const cfg of ENDPOINTS) {
  test(`GET ${cfg.routePath}: counts old rows, ignores recent rows, returns oldest/newest`, async () => {
    // Use a 60-day cutoff so:
    //   - "old" row at -200d is INCLUDED
    //   - "recent" row at -10d is EXCLUDED
    // We watermark the count with the same window before seeding to absorb
    // any rows other tests / the live system may have written into a shared
    // DB. The assertions are then expressed as deltas relative to baseline.
    const days = 60;
    const cutoff = new Date(Date.now() - days * 86_400_000);

    const baseline = await api<PreviewResponse>(cfg.routePath, "GET",
      { token: saToken, query: { companyId: testCompanyId, days } });
    assert.equal(baseline.status, 200);
    const baselineCount = baseline.body.count;

    const oldDate    = new Date(Date.now() - 200 * 86_400_000);
    const recentDate = new Date(Date.now() - 10  * 86_400_000);
    const oldId    = await cfg.insertOld(oldDate,    `${TEST_TAG}_get_old`);
    const recentId = await cfg.insertOld(recentDate, `${TEST_TAG}_get_recent`);

    const r = await api<PreviewResponse>(cfg.routePath, "GET",
      { token: saToken, query: { companyId: testCompanyId, days } });
    assert.equal(r.status, 200);
    assert.equal(r.body.days, days, "echoed days must equal the requested cutoff");
    // Only the OLD seeded row crosses the cutoff; recent must not be counted.
    assert.equal(r.body.count, baselineCount + 1,
      `count should rise by exactly 1 (the OLD seeded row), baseline=${baselineCount}, after=${r.body.count}`);
    const ids = r.body.items.map((it) => it.id);
    assert.ok(ids.includes(oldId), "items must include the OLD seeded row");
    assert.ok(!ids.includes(recentId),
      "items must NOT include the RECENT seeded row (it's inside the retention window)");

    // oldest/newest pin: oldest must be ≤ our seeded oldDate, newest must be
    // older than the cutoff (otherwise the SQL would have leaked a row from
    // inside the retention window).
    assert.ok(r.body.oldest !== null, "oldest must be populated when count>0");
    assert.ok(r.body.newest !== null, "newest must be populated when count>0");
    const oldestMs = new Date(r.body.oldest!).getTime();
    const newestMs = new Date(r.body.newest!).getTime();
    assert.ok(oldestMs <= oldDate.getTime() + 1000,
      `oldest must be ≤ seeded oldDate (got ${r.body.oldest}, expected ≤ ${oldDate.toISOString()})`);
    assert.ok(newestMs < cutoff.getTime(),
      `newest must lie strictly before the cutoff (got ${r.body.newest}, cutoff ${cutoff.toISOString()})`);
    assert.ok(oldestMs <= newestMs, "oldest must be ≤ newest");
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  POST /fix — deletes only old rows + writes a SuperAdmin audit entry
// ════════════════════════════════════════════════════════════════════════════
for (const cfg of ENDPOINTS) {
  test(`POST ${cfg.routePath}/fix: deletes only rows older than the cutoff and writes a SuperAdmin audit row`, async () => {
    // Seed one old + one recent row scoped to this test. We then POST with a
    // 60-day cutoff and verify by primary key that ONLY the old row is gone.
    // The audit-log row is captured via a watermark so we never inspect rows
    // unrelated to this test.
    const days = 60;
    const oldDate    = new Date(Date.now() - 250 * 86_400_000);
    const recentDate = new Date(Date.now() - 5   * 86_400_000);
    const oldId    = await cfg.insertOld(oldDate,    `${TEST_TAG}_fix_old`);
    const recentId = await cfg.insertOld(recentDate, `${TEST_TAG}_fix_recent`);

    const before = await db.execute<{ max_id: number | null }>(sql`
      SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM audit_log
    `);
    const beforeMax = Number(
      ((before as { rows?: Array<{ max_id: number | null }> }).rows ?? [{ max_id: 0 }])[0]?.max_id ?? 0,
    );

    const r = await api<FixResponse>(`${cfg.routePath}/fix`, "POST",
      { token: saToken, body: { companyId: testCompanyId, days } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.days, days);
    assert.ok(r.body.deleted >= 1,
      `deleted count should include at least our seeded OLD row, got ${r.body.deleted}`);

    // Strict by-PK verification: OLD is gone, RECENT survives.
    const survivors = await cfg.survivors([oldId, recentId]);
    assert.ok(!survivors.includes(oldId),
      `OLD row id=${oldId} (ranAt=${oldDate.toISOString()}) must be deleted`);
    assert.ok(survivors.includes(recentId),
      `RECENT row id=${recentId} (ranAt=${recentDate.toISOString()}) must survive — POST/fix would otherwise have truncated the table`);

    // Drop the OLD id from cleanup tracking; the row no longer exists, and
    // leaving it in the list would just no-op but the explicit splice keeps
    // the "tracked = expected to exist" invariant honest.
    const idx = cfg.trackedIds.indexOf(oldId);
    if (idx >= 0) cfg.trackedIds.splice(idx, 1);

    // Audit-log assertion: exactly one new `fix` row scoped to this entity
    // type, attributed to the calling SuperAdmin and tagged with the
    // companyId from the request body. Metadata must echo `days` and a
    // numeric `deleted` count so the maintenance-history audit panel can
    // render the change-of-record.
    const auditRows = await db.select({
      id:         auditLogTable.id,
      action:     auditLogTable.action,
      module:     auditLogTable.module,
      entityType: auditLogTable.entityType,
      userId:     auditLogTable.userId,
      companyId:  auditLogTable.companyId,
      metadata:   auditLogTable.metadata,
    })
      .from(auditLogTable)
      .where(and(
        sql`${auditLogTable.id} > ${beforeMax}`,
        eq(auditLogTable.action, "fix"),
        eq(auditLogTable.module, "maintenance"),
        eq(auditLogTable.entityType, cfg.entityType),
      ));
    assert.equal(auditRows.length, 1,
      `expected exactly one new fix audit row for entity_type=${cfg.entityType}, got ${auditRows.length}`);
    const audit = auditRows[0];
    assert.equal(audit.userId, saUserId,
      "audit row must be attributed to the calling SuperAdmin");
    assert.equal(audit.companyId, testCompanyId,
      "audit row must be tagged with the requested companyId");
    assert.ok(isObject(audit.metadata), "audit metadata must be a JSON object");
    const meta = audit.metadata as Record<string, unknown>;
    assert.equal(meta.days, days, "metadata.days must echo the requested cutoff");
    assert.ok(typeof meta.deleted === "number" && (meta.deleted as number) >= 1,
      `metadata.deleted must be a positive number, got ${JSON.stringify(meta.deleted)}`);
    insertedAuditLogIds.push(audit.id);
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  CSV branch — text/csv + Arabic header row + export_csv audit entry
// ════════════════════════════════════════════════════════════════════════════
for (const cfg of ENDPOINTS) {
  test(`GET ${cfg.routePath}?format=csv: returns text/csv with the documented Arabic header row + writes an export_csv audit row`, async () => {
    // Seed at least one OLD row so the export has at least one data line.
    const oldDate = new Date(Date.now() - 300 * 86_400_000);
    await cfg.insertOld(oldDate, `${TEST_TAG}_csv_seed`);

    const before = await db.execute<{ max_id: number | null }>(sql`
      SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM audit_log
    `);
    const beforeMax = Number(
      ((before as { rows?: Array<{ max_id: number | null }> }).rows ?? [{ max_id: 0 }])[0]?.max_id ?? 0,
    );

    const r = await api(cfg.routePath, "GET", {
      token: saToken,
      query: { companyId: testCompanyId, days: 90, format: "csv" },
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.text.slice(0, 200)}`);
    assert.match(r.headers.get("content-type") ?? "", /text\/csv/i,
      "Content-Type must be text/csv");

    // UTF-8 BOM — Excel needs it to render Arabic correctly.
    assert.equal(r.bytes[0], 0xEF, "byte[0] must be 0xEF (UTF-8 BOM)");
    assert.equal(r.bytes[1], 0xBB, "byte[1] must be 0xBB (UTF-8 BOM)");
    assert.equal(r.bytes[2], 0xBF, "byte[2] must be 0xBF (UTF-8 BOM)");
    assert.equal(r.text.charCodeAt(0), 0xFEFF, "first character must be the BOM");

    const headerLine = r.text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
    for (const h of cfg.expectedHeaders) {
      assert.ok(headerLine.includes(h),
        `CSV header row must include "${h}", got: ${headerLine}`);
    }
    // Sanity: contains at least one Arabic letter (range U+0600..U+06FF).
    assert.match(headerLine, /[\u0600-\u06FF]/,
      "header line must contain Arabic characters");

    // At least the seeded OLD row must show up as a data line.
    const dataLines = r.text.replace(/^\uFEFF/, "").split(/\r?\n/).slice(1).filter((l) => l.length > 0);
    assert.ok(dataLines.length >= 1,
      `CSV must contain at least one data line for the seeded OLD row, got ${dataLines.length}`);

    // Audit-log assertion: exactly one new export_csv row scoped to this
    // entity type, attributed to the SuperAdmin, with metadata.format='csv'.
    const auditRows = await db.select({
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
        eq(auditLogTable.entityType, cfg.entityType),
      ));
    assert.equal(auditRows.length, 1,
      `CSV branch must write exactly one export_csv audit row for ${cfg.entityType}`);
    const audit = auditRows[0];
    assert.equal(audit.userId, saUserId,
      "audit row must be attributed to the calling SuperAdmin");
    assert.ok(isObject(audit.metadata), "audit metadata must be a JSON object");
    const meta = audit.metadata as Record<string, unknown>;
    assert.equal(meta.format, "csv");
    assert.equal(meta.days, 90, "metadata.days must echo the requested cutoff");
    assert.ok(typeof meta.count === "number",
      "metadata.count must record how many rows were exported");
    insertedAuditLogIds.push(audit.id);
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  checkOldReportEmailRuns helper — direct unit test (mirrors the existing
//  checkOldMaintenanceEmailRuns coverage in maintenance.test.ts so the
//  report-side helper has parity)
// ════════════════════════════════════════════════════════════════════════════
test("checkOldReportEmailRuns: counts report_email_schedule_runs older than the threshold and ignores recent rows", async () => {
  // Seed one row well past the 90-day cutoff and one row inside it. The
  // helper takes a companyId arg purely to match the per-tool check
  // signature; the table is global, so the arg is ignored by the SQL.
  const oldRanAt = new Date(Date.now() - 120 * 86_400_000);
  const oldId = await REPORT_CFG.insertOld(oldRanAt, `${TEST_TAG}_helper_old`);

  const r1 = await checkOldReportEmailRuns(testCompanyId, 90);
  assert.ok(r1.count >= 1, `expected count >= 1, got ${r1.count}`);
  assert.ok((r1.items ?? []).some((it: { id: number }) => it.id === oldId),
    "items must include the OLD seeded report_email_schedule_runs row");
  assert.ok(isObject(r1.extras) && r1.extras.days === 90,
    "extras.days must echo the requested threshold");

  // Recent rows (well within retention) must NOT be counted — proves the
  // SQL cutoff is anchored on `ran_at`, not just "all rows".
  const recentRanAt = new Date();
  const recentId = await REPORT_CFG.insertOld(recentRanAt, `${TEST_TAG}_helper_recent`);

  const r2 = await checkOldReportEmailRuns(testCompanyId, 90);
  assert.ok(!(r2.items ?? []).some((it: { id: number }) => it.id === recentId),
    "items must NOT include the in-window (recent) report_email_schedule_runs row");
});
