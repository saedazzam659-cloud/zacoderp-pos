// External-database storage routing («قواعد البيانات الخارجية»).
//
// SuperAdmin registers external Postgres databases and routes storage-heavy
// MODULES to them platform-wide (all companies). Core system tables always
// stay on the central database. Connection strings are stored AES-256-GCM
// encrypted (key derived from SESSION_SECRET) and never leave the server.
//
// Usage from a module route:
//   const rdb = await getRoutedDb("document_archive");   // drizzle instance
//   await rdb.select().from(documentArchivesTable)...
// Falls back to the CENTRAL db when no routing is configured, and fails
// CLOSED (throws) when a routing exists but the external DB is unreachable —
// silently falling back would split the data across two databases.

import crypto from "node:crypto";
import { db, centralDb, createExternalDb, externalDatabasesTable, storageRoutingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ── Module registry ── keys routable from the SA screen. `wired:true` means
// the module's routes actually consult getRoutedDb; others are listed in the
// UI as "قريبًا" and cannot be routed yet (the API rejects them).
export const ROUTABLE_MODULES: { key: string; nameAr: string; wired: boolean; tables: string[] }[] = [
  { key: "document_archive", nameAr: "الأرشيف (أرشفة المستندات)", wired: true, tables: ["document_archives"] },
  { key: "attachments", nameAr: "المرفقات العامة", wired: false, tables: [] },
  { key: "audit_logs", nameAr: "سجلات التدقيق", wired: false, tables: [] },
];

// ── Central-side DDL (ensureSchema only adds COLUMNS, not tables) ────────
let ensured: Promise<void> | null = null;
export function ensureExternalDbTables(): Promise<void> {
  if (!ensured) ensured = (async () => {
    await centralDb.execute(`CREATE TABLE IF NOT EXISTS external_databases (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      conn_encrypted TEXT NOT NULL,
      conn_display TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      last_check_at TIMESTAMP,
      last_check_result JSONB,
      notes TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    )` as any);
    await centralDb.execute(`CREATE UNIQUE INDEX IF NOT EXISTS external_databases_name_uniq ON external_databases (name)` as any);
    await centralDb.execute(`CREATE TABLE IF NOT EXISTS storage_routings (
      id SERIAL PRIMARY KEY,
      module_key TEXT NOT NULL,
      external_db_id INTEGER REFERENCES external_databases(id) ON DELETE SET NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    )` as any);
    await centralDb.execute(`CREATE UNIQUE INDEX IF NOT EXISTS storage_routings_module_uniq ON storage_routings (module_key)` as any);
  })().catch(e => { ensured = null; throw e; });
  return ensured;
}

// ── Encryption ───────────────────────────────────────────────────────────
function encKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET missing — cannot encrypt external DB credentials");
  return crypto.createHash("sha256").update(secret + "::extdb").digest();
}

export function encryptConn(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `extdb1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}

export function decryptConn(enc: string): string {
  const [tag0, ivB64, tagB64, dataB64] = enc.split(":");
  if (tag0 !== "extdb1" || !ivB64 || !tagB64 || !dataB64) throw new Error("bad ciphertext");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

/** Redacted display form: host:port/dbname, no credentials. */
export function redactConn(plain: string): string {
  try {
    const u = new URL(plain);
    return `${u.hostname}${u.port ? ":" + u.port : ""}${u.pathname}`;
  } catch { return "(غير قابل للعرض)"; }
}

// ── Routed pool cache ────────────────────────────────────────────────────
// moduleKey → { dbId, ctx } — rebuilt whenever the routing or the target row
// changes (invalidateRoutingCache is called by the admin routes).
const cache = new Map<string, { dbId: number; ctx: ReturnType<typeof createExternalDb> }>();

export function invalidateRoutingCache(): void {
  for (const { ctx } of cache.values()) { try { void ctx.pool.end(); } catch { /* noop */ } }
  cache.clear();
}

/** Resolve the drizzle instance a module must use. Central db when unrouted. */
export async function getRoutedDb(moduleKey: string): Promise<typeof centralDb> {
  await ensureExternalDbTables();
  const [routing] = await centralDb.select().from(storageRoutingsTable)
    .where(eq(storageRoutingsTable.moduleKey, moduleKey)).limit(1);
  if (!routing || routing.externalDbId == null) {
    // No routing → central. NOTE: return the plain proxied `db` so agent-DB
    // ALS contexts keep working exactly as before for unrouted modules.
    if (cache.has(moduleKey)) invalidateRoutingCache();
    return db;
  }
  const hit = cache.get(moduleKey);
  if (hit && hit.dbId === routing.externalDbId) return hit.ctx.db as unknown as typeof centralDb;
  const [row] = await centralDb.select().from(externalDatabasesTable)
    .where(eq(externalDatabasesTable.id, routing.externalDbId)).limit(1);
  if (!row) throw new Error(`external db #${routing.externalDbId} not found for module ${moduleKey}`);
  const ctx = createExternalDb(decryptConn(row.connEncrypted));
  cache.set(moduleKey, { dbId: row.id, ctx });
  return ctx.db as unknown as typeof centralDb;
}

/** Test a connection string (or an existing row) — SELECT 1 with a timeout. */
export async function testConnection(connString: string): Promise<{ ok: boolean; error?: string; latencyMs?: number }> {
  const ctx = createExternalDb(connString);
  const t0 = Date.now();
  try {
    await Promise.race([
      ctx.pool.query("SELECT 1"),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout (8s)")), 8000)),
    ]);
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    try { void ctx.pool.end(); } catch { /* noop */ }
  }
}

// DDL for tables a wired module needs on the external side. Kept in lockstep
// with lib/db/src/schema/documentArchives.ts (additive columns only).
export const MODULE_DDL: Record<string, string[]> = {
  document_archive: [
    `CREATE TABLE IF NOT EXISTS document_archives (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      screen_key TEXT NOT NULL,
      doc_key TEXT NOT NULL,
      filename TEXT NOT NULL,
      object_path TEXT NOT NULL,
      content_type TEXT,
      bytes INTEGER,
      pages INTEGER,
      uploaded_by INTEGER,
      uploaded_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS document_archives_company_screen_doc_idx
       ON document_archives (company_id, screen_key, doc_key)`,
  ],
};
