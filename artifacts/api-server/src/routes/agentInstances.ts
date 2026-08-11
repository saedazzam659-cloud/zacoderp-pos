// SuperAdmin — «سيرفرات الوكلاء» (Agent Instances).
// Registry + protections for reseller/agent deployments running on their own
// domain + server with their own external PostgreSQL, while the CENTRAL API
// (this server) keeps all business logic.
//
// Endpoints (all SA-gated except the two public ones at the bottom):
//   CRUD                          — list/create/update/delete instances
//   POST /:id/test-db             — connect to the agent's external PostgreSQL
//   POST /:id/init-db             — create schema + plant a signed fingerprint
//   POST /:id/test-ssh            — TCP reachability of the agent server
//   POST /:id/license             — (re)issue a signed license key
//   POST /:id/suspend|activate    — kill-switch / re-enable
//   GET  /security-events         — tamper & security alerts (all agents)
//   POST /security-events/:id/resolve
//
// Public (no auth, mounted separately in routes/index.ts):
//   GET  /api/branding            — login-page branding for the current host
//   POST /api/agent/heartbeat     — instance license/identity validation
//
// Secrets (DB URL, SSH key/password) are AES-256-GCM encrypted at rest via
// lib/encryption.ts, write-only through the API, and NEVER returned.
// Explicit superadmin role check on the router — mirrors routes/domains.ts.

import { Router, type Request } from "express";
// Control-plane module: ALL registry reads/writes here must hit the CENTRAL
// DB even when the request is running inside an agent-DB ALS context (an
// agent's cloned DB has an empty registry — following the proxy would
// silently disable suspend/register-block enforcement).
import { centralDb as db } from "@workspace/db";
import { agentInstancesTable, agentSecurityEventsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { z } from "zod/v4";
import { PgPool, type PgPoolType } from "@workspace/db";
import net from "node:net";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { extractAuth } from "../middleware/auth.js";
import { normalizeHost } from "../middleware/domainResolver.js";
import { encryptSecret, decryptSecret } from "../lib/encryption.js";
import { lookup as dnsLookup } from "node:dns/promises";

/**
 * SSRF guard for agent-server probes: the SA may point tests at any PUBLIC
 * agent host, but never at loopback / link-local / metadata / unspecified
 * addresses (protects the central server's own services and cloud metadata).
 * Private RFC1918 ranges stay allowed — agents may sit behind VPN peering.
 */
async function assertProbeTargetAllowed(host: string): Promise<void> {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) throw new Error("عنوان غير صالح");
  const blockedName = ["localhost", "metadata.google.internal"];
  if (blockedName.includes(h)) throw new Error("هذا العنوان غير مسموح");
  const isBlockedIp = (ip: string) =>
    /^127\./.test(ip) || ip === "0.0.0.0" || /^169\.254\./.test(ip) ||
    ip === "::1" || ip === "::" || /^fe80:/i.test(ip) || /^::ffff:127\./i.test(ip);
  if (isBlockedIp(h)) throw new Error("هذا العنوان غير مسموح");
  // Resolve names and re-check every address (DNS-rebinding safety at probe time).
  if (!/^[0-9a-f:.]+$/i.test(h) || h.includes("-")) {
    try {
      const addrs = await dnsLookup(h, { all: true });
      if (addrs.some(a => isBlockedIp(a.address))) throw new Error("هذا العنوان غير مسموح");
    } catch (e: any) {
      if (String(e?.message ?? "").includes("غير مسموح")) throw e;
      // NXDOMAIN etc. → let the actual connection attempt surface the error
    }
  }
}

// ── Shared helpers ─────────────────────────────────────────────────────────

function hmacSign(payload: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required");
  return createHmac("sha256", `zacod-agent-v1:${secret}`).update(payload).digest("hex");
}

/** Expected DB fingerprint for an instance (deterministic — re-derivable). */
function expectedFingerprint(installationId: string, domain: string): string {
  return hmacSign(`fp:${installationId}:${domain}`);
}

/** License key: ZC-<random>-<sig8>. Verifiable server-side without storage lookup. */
function mintLicenseKey(installationId: string, domain: string): string {
  const rnd = randomBytes(9).toString("base64url").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  const sig = hmacSign(`lic:${installationId}:${domain}:${rnd}`).slice(0, 10).toUpperCase();
  return `ZC-${rnd}-${sig}`;
}

function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  const raw = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return raw || req.socket?.remoteAddress || "";
}

async function logAgentEvent(agentId: number | null, eventType: string, detail: Record<string, unknown>, req?: Request): Promise<void> {
  try {
    await db.insert(agentSecurityEventsTable).values({
      agentId, eventType, detail,
      host: req ? normalizeHost(String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "")) : null,
      ip: req ? clientIp(req) : null,
    });
  } catch { /* never break the caller over audit logging */ }
}

// ── Agent-host lookup (used by /register blocking + public branding) ───────
// 60s TTL cache: host → agent row (or null).
type AgentHostHit = {
  id: number; status: string; dbStatus: string; dbUrlEnc: string | null;
  brandName: string | null; brandLogoUrl: string | null; brandColor: string | null;
} | null;
const hostCache = new Map<string, { hit: AgentHostHit; expires: number }>();

export function clearAgentHostCache(): void { hostCache.clear(); }

export async function lookupAgentByHost(host: string | null): Promise<AgentHostHit> {
  if (!host) return null;
  const now = Date.now();
  const c = hostCache.get(host);
  if (c && c.expires > now) return c.hit;
  let hit: AgentHostHit = null;
  try {
    const rows = await db.select({
      id: agentInstancesTable.id, status: agentInstancesTable.status,
      domain: agentInstancesTable.domain, extraDomains: agentInstancesTable.extraDomains,
      dbStatus: agentInstancesTable.dbStatus, dbUrlEnc: agentInstancesTable.dbUrlEnc,
      brandName: agentInstancesTable.brandName, brandLogoUrl: agentInstancesTable.brandLogoUrl,
      brandColor: agentInstancesTable.brandColor,
    }).from(agentInstancesTable);
    for (const r of rows) {
      const extras = Array.isArray(r.extraDomains) ? (r.extraDomains as string[]) : [];
      if (r.domain === host || extras.includes(host)) {
        hit = {
          id: r.id, status: r.status, dbStatus: r.dbStatus, dbUrlEnc: r.dbUrlEnc,
          brandName: r.brandName, brandLogoUrl: r.brandLogoUrl, brandColor: r.brandColor,
        };
        break;
      }
    }
  } catch { hit = null; }
  hostCache.set(host, { hit, expires: now + 60_000 });
  return hit;
}

// ── Agent datasource routing middleware ────────────────────────────────────
// Mounted early in routes/index.ts. When a request arrives from a registered
// agent domain:
//   • suspended agent → 403 for everything except public branding/heartbeat
//     (instant kill-switch, server-side);
//   • active + initialized external DB → the WHOLE request runs inside
//     runWithExternalDb, so every `db`/`pool` usage anywhere in the handler
//     chain hits the agent's PostgreSQL instead of the central one;
//   • active but DB not initialized yet → central DB (setup phase).
const AGENT_PUBLIC_PATHS = ["/branding", "/agent/heartbeat"];
export async function agentDataSourceRouter(req: Request, res: any, next: (err?: unknown) => void): Promise<void> {
  try {
    const fwd = req.headers["x-forwarded-host"];
    const host = normalizeHost((Array.isArray(fwd) ? fwd[0] : fwd) || req.headers.host);
    const hit = await lookupAgentByHost(host);
    if (!hit) { next(); return; }
    if (AGENT_PUBLIC_PATHS.some(p => req.path === p || req.path.startsWith(p + "/"))) { next(); return; }
    if (hit.status !== "active") {
      res.status(403).json({ error: "هذه النسخة موقوفة — تواصل مع مزوّد النظام", agentSuspended: true });
      return;
    }
    if (hit.dbStatus === "initialized" && hit.dbUrlEnc) {
      const { getAgentDbContext } = await import("../lib/agentDb.js");
      const ctx = getAgentDbContext(hit.id, hit.dbUrlEnc);
      const { runWithExternalDb } = await import("@workspace/db");
      runWithExternalDb(ctx, () => next());
      return;
    }
    next();
  } catch (e) { next(e); }
}

/** Returns the first domain in `candidates` already owned (MAIN OR extra) by a DIFFERENT instance. */
async function findDomainConflict(candidates: string[], excludeId: number | null): Promise<string | null> {
  const rows = await db.select({
    id: agentInstancesTable.id, domain: agentInstancesTable.domain, extraDomains: agentInstancesTable.extraDomains,
  }).from(agentInstancesTable);
  for (const r of rows) {
    if (excludeId != null && r.id === excludeId) continue;
    const owned = new Set([r.domain, ...(Array.isArray(r.extraDomains) ? (r.extraDomains as string[]) : [])]);
    for (const c of candidates) if (owned.has(c)) return c;
  }
  return null;
}

// ── SA router ──────────────────────────────────────────────────────────────

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if ((req as any).authUser?.role !== "superadmin") {
    res.status(403).json({ error: "هذه الصفحة للمشرف العام فقط" }); return;
  }
  next();
});

/** Public projection — secrets replaced with set/masked flags. */
function publicRow(r: typeof agentInstancesTable.$inferSelect) {
  const { dbUrlEnc, sshSecretEnc, ...rest } = r;
  // Secrets are STRICTLY write-only: only boolean presence flags leave the
  // server — never the ciphertext and never any plaintext fragment.
  return {
    ...rest,
    dbUrlSet: !!dbUrlEnc,
    sshSecretSet: !!sshSecretEnc,
  };
}

// GET /api/admin/agent-instances
router.get("/", async (_req, res) => {
  const rows = await db.select().from(agentInstancesTable).orderBy(desc(agentInstancesTable.id)).limit(500);
  res.json(rows.map(publicRow));
});

const upsertSchema = z.object({
  name: z.string().min(2).max(200),
  contactPhone: z.string().max(50).nullish(),
  contactEmail: z.string().max(200).nullish(),
  domain: z.string().min(3).max(255),
  extraDomains: z.array(z.string().min(3).max(255)).max(20).nullish(),
  mode: z.enum(["frontend_only", "full_shell"]).optional(),
  maxCompanies: z.number().int().positive().nullish(),
  licenseExpiresAt: z.string().nullish(),           // ISO date
  // Secrets — write-only. Empty string / undefined = keep existing.
  dbUrl: z.string().max(2000).nullish(),
  sshHost: z.string().max(255).nullish(),
  sshPort: z.number().int().min(1).max(65535).nullish(),
  sshUser: z.string().max(100).nullish(),
  sshSecret: z.string().max(10000).nullish(),
  brandName: z.string().max(200).nullish(),
  brandLogoUrl: z.string().max(1000).nullish(),
  brandColor: z.string().max(20).nullish(),
  notes: z.string().max(2000).nullish(),
});

// POST /api/admin/agent-instances
router.post("/", async (req, res) => {
  const p = upsertSchema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "بيانات غير صالحة", detail: p.error.issues }); return; }
  const d = p.data;
  const domain = normalizeHost(d.domain);
  if (!domain) { res.status(400).json({ error: "الدومين غير صالح" }); return; }
  const extras = (d.extraDomains ?? []).map(x => normalizeHost(x)).filter((x): x is string => !!x && x !== domain);
  const conflict = await findDomainConflict([domain, ...extras], null);
  if (conflict) { res.status(409).json({ error: `الدومين ${conflict} مسجّل لوكيل آخر` }); return; }

  const installationId = randomUUID();
  const [row] = await db.insert(agentInstancesTable).values({
    name: d.name, contactPhone: d.contactPhone ?? null, contactEmail: d.contactEmail ?? null,
    domain, extraDomains: extras, mode: d.mode ?? "frontend_only",
    installationId,
    licenseKey: mintLicenseKey(installationId, domain),
    licenseExpiresAt: d.licenseExpiresAt ? new Date(d.licenseExpiresAt) : null,
    maxCompanies: d.maxCompanies ?? null,
    dbUrlEnc: d.dbUrl ? encryptSecret(d.dbUrl) : null,
    sshHost: d.sshHost ?? null, sshPort: d.sshPort ?? null, sshUser: d.sshUser ?? null,
    sshSecretEnc: d.sshSecret ? encryptSecret(d.sshSecret) : null,
    brandName: d.brandName ?? null, brandLogoUrl: d.brandLogoUrl ?? null, brandColor: d.brandColor ?? null,
    notes: d.notes ?? null,
    createdByUserId: (req as any).authUser?.id ?? null,
  }).returning();
  clearAgentHostCache();
  res.status(201).json(publicRow(row));
});

// PUT /api/admin/agent-instances/:id
router.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const p = upsertSchema.partial().safeParse(req.body);
  if (!id || !p.success) { res.status(400).json({ error: "بيانات غير صالحة" }); return; }
  const d = p.data;
  const [existing] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (d.name !== undefined) patch.name = d.name;
  for (const k of ["contactPhone", "contactEmail", "brandName", "brandLogoUrl", "brandColor", "notes", "sshHost", "sshUser"] as const) {
    if (d[k] !== undefined) patch[k] = d[k] ?? null;
  }
  if (d.sshPort !== undefined) patch.sshPort = d.sshPort ?? null;
  if (d.mode !== undefined) patch.mode = d.mode;
  if (d.maxCompanies !== undefined) patch.maxCompanies = d.maxCompanies ?? null;
  if (d.licenseExpiresAt !== undefined) patch.licenseExpiresAt = d.licenseExpiresAt ? new Date(d.licenseExpiresAt) : null;
  if (d.domain !== undefined) {
    const domain = normalizeHost(d.domain);
    if (!domain) { res.status(400).json({ error: "الدومين غير صالح" }); return; }
    patch.domain = domain;
  }
  if (d.extraDomains !== undefined) {
    const main = (patch.domain as string) ?? existing.domain;
    patch.extraDomains = (d.extraDomains ?? []).map(x => normalizeHost(x)).filter((x): x is string => !!x && x !== main);
  }
  // Domain ownership must be unique across ALL instances (main + extras),
  // otherwise branding/register-blocking attribution is nondeterministic.
  if (patch.domain !== undefined || patch.extraDomains !== undefined) {
    const all = [
      (patch.domain as string) ?? existing.domain,
      ...(((patch.extraDomains as string[] | undefined) ?? (Array.isArray(existing.extraDomains) ? existing.extraDomains as string[] : []))),
    ];
    const conflict = await findDomainConflict(all, id);
    if (conflict) { res.status(409).json({ error: `الدومين ${conflict} مسجّل لوكيل آخر` }); return; }
  }
  // Secrets: only overwrite when a NON-EMPTY value is sent (empty = keep).
  if (d.dbUrl) { patch.dbUrlEnc = encryptSecret(d.dbUrl); patch.dbStatus = "not_configured"; patch.dbLastError = null; }
  if (d.sshSecret) { patch.sshSecretEnc = encryptSecret(d.sshSecret); patch.sshStatus = "not_configured"; }

  const [row] = await db.update(agentInstancesTable).set(patch).where(eq(agentInstancesTable.id, id)).returning();
  clearAgentHostCache();
  if (patch.dbUrlEnc !== undefined) {
    const { evictAgentDb } = await import("../lib/agentDb.js");
    evictAgentDb(id);
  }
  res.json(publicRow(row));
});

// DELETE /api/admin/agent-instances/:id
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "بيانات غير صالحة" }); return; }
  await db.delete(agentInstancesTable).where(eq(agentInstancesTable.id, id));
  clearAgentHostCache();
  const { evictAgentDb } = await import("../lib/agentDb.js");
  evictAgentDb(id);
  res.json({ ok: true });
});

// ── External DB: test / init ───────────────────────────────────────────────

async function withAgentPool<T>(dbUrlEnc: string, fn: (pool: PgPoolType) => Promise<T>): Promise<T> {
  const url = decryptSecret(dbUrlEnc);
  if (!url) throw new Error("لا يوجد رابط اتصال محفوظ");
  try { await assertProbeTargetAllowed(new URL(url).hostname); }
  catch (e: any) {
    if (String(e?.message ?? "").includes("غير مسموح")) throw e;
    throw new Error("رابط الاتصال غير صالح");
  }
  const pool = new PgPool({ connectionString: url, max: 2, connectionTimeoutMillis: 8000, ssl: url.includes("sslmode=disable") ? undefined : { rejectUnauthorized: false } });
  try { return await fn(pool); } finally { await pool.end().catch(() => {}); }
}

// POST /:id/test-db — connectivity + fingerprint verification.
router.post("/:id/test-db", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  if (!inst.dbUrlEnc) { res.status(400).json({ error: "لم يتم إدخال رابط قاعدة البيانات بعد" }); return; }
  try {
    const result = await withAgentPool(inst.dbUrlEnc, async (pool) => {
      const v = await pool.query("SELECT version()");
      let fingerprintOk: boolean | null = null;
      try {
        const fp = await pool.query("SELECT installation_id, fingerprint FROM zacod_installation WHERE id = 1");
        if (fp.rows.length) {
          fingerprintOk =
            fp.rows[0].installation_id === inst.installationId &&
            fp.rows[0].fingerprint === expectedFingerprint(inst.installationId, inst.domain);
        }
      } catch { fingerprintOk = null; /* not initialized yet */ }
      return { version: String(v.rows[0]?.version ?? "").slice(0, 80), fingerprintOk };
    });
    if (result.fingerprintOk === false) {
      await logAgentEvent(id, "db_fingerprint_mismatch", { note: "بصمة قاعدة البيانات لا تطابق هذا التركيب — احتمال نسخ/تلاعب" }, req);
    }
    await db.update(agentInstancesTable).set({
      dbStatus: result.fingerprintOk === false ? "error" : (inst.dbStatus === "initialized" ? "initialized" : "ok"),
      dbLastCheckAt: new Date(), dbLastError: result.fingerprintOk === false ? "بصمة غير مطابقة" : null, updatedAt: new Date(),
    }).where(eq(agentInstancesTable.id, id));
    res.json({ ok: true, ...result });
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 500);
    await db.update(agentInstancesTable).set({ dbStatus: "error", dbLastCheckAt: new Date(), dbLastError: msg, updatedAt: new Date() })
      .where(eq(agentInstancesTable.id, id));
    res.status(502).json({ error: "فشل الاتصال بقاعدة البيانات", detail: msg });
  }
});

// POST /:id/init-db — run full schema creation on the agent DB + plant fingerprint.
router.post("/:id/init-db", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  if (!inst.dbUrlEnc) { res.status(400).json({ error: "لم يتم إدخال رابط قاعدة البيانات بعد" }); return; }
  try {
    const fingerprint = expectedFingerprint(inst.installationId, inst.domain);
    await withAgentPool(inst.dbUrlEnc, async (pool) => {
      // 1) Fresh DB → copy the FULL central schema (structure only, zero
      //    data) via pg_dump --schema-only. ensureSchema alone can't do this:
      //    it only ALTERs existing tables / creates extraSteps tables.
      const fresh = await pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='companies'`,
      ).then(r => r.rows.length === 0);
      if (fresh) {
        const { execFile } = await import("node:child_process");
        const dumpSql = await new Promise<string>((resolve, reject) => {
          execFile("pg_dump", [
            "--schema-only", "--no-owner", "--no-privileges", "--no-comments",
            process.env.DATABASE_URL!,
          ], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(new Error(`pg_dump غير متاح أو فشل: ${String(stderr || err.message).slice(0, 200)}`));
            else resolve(stdout);
          });
        });
        // Strip psql meta-commands (\restrict etc. in newer pg_dump) — the
        // dump is applied through the pg driver, not psql. Apply inside ONE
        // transaction so a mid-dump failure leaves the agent DB untouched.
        const cleaned = dumpSql.split("\n").filter(l => !l.startsWith("\\")).join("\n");
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(cleaned);
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      }
      // 2) Reconcile drift (enums/columns/extraSteps) with a NON-memoized
      //    heal pass routed at the agent DB via the ALS datasource proxy.
      const { runWithExternalDb } = await import("@workspace/db");
      const { drizzle } = await import("drizzle-orm/node-postgres");
      const schemaMod = await import("@workspace/db/schema");
      const agentDrizzle = drizzle(pool as any, { schema: schemaMod as any });
      const { runSchemaHealOnActiveDb } = await import("../lib/ensureSchema.js");
      await runWithExternalDb({ db: agentDrizzle as any, pool: pool as any }, () => runSchemaHealOnActiveDb());
      // Refuse to overwrite a foreign installation's fingerprint.
      try {
        const fp = await pool.query("SELECT installation_id FROM zacod_installation WHERE id = 1");
        if (fp.rows.length && fp.rows[0].installation_id !== inst.installationId) {
          throw new Error("قاعدة البيانات هذه مهيأة لتركيب آخر — رفض التهيئة");
        }
      } catch (e: any) {
        if (String(e?.message ?? "").includes("تركيب آخر")) throw e; // real conflict
        // table missing → fresh DB, continue
      }
      await pool.query(`CREATE TABLE IF NOT EXISTS zacod_installation (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        installation_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        initialized_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`);
      await pool.query(
        `INSERT INTO zacod_installation (id, installation_id, fingerprint) VALUES (1, $1, $2)
         ON CONFLICT (id) DO UPDATE SET installation_id = $1, fingerprint = $2`,
        [inst.installationId, fingerprint],
      );
    });
    await db.update(agentInstancesTable).set({
      dbStatus: "initialized", dbFingerprint: fingerprint, dbLastCheckAt: new Date(), dbLastError: null, updatedAt: new Date(),
    }).where(eq(agentInstancesTable.id, id));
    res.json({ ok: true, fingerprintPlanted: true });
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 500);
    // Fail CLOSED: a failed (re-)init must never leave dbStatus=initialized,
    // or routed traffic keeps flowing into a half-built database.
    await db.update(agentInstancesTable).set({
      dbStatus: "error", dbLastCheckAt: new Date(), dbLastError: msg, updatedAt: new Date(),
    }).where(eq(agentInstancesTable.id, id)).catch(() => {});
    clearAgentHostCache();
    const { evictAgentDb } = await import("../lib/agentDb.js");
    evictAgentDb(id);
    res.status(502).json({ error: "فشلت التهيئة", detail: msg });
  }
});

// POST /:id/test-ssh — TCP reachability only (full SSH deploy is a later phase).
router.post("/:id/test-ssh", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  if (!inst.sshHost) { res.status(400).json({ error: "لم يتم إدخال بيانات السيرفر بعد" }); return; }
  const port = inst.sshPort ?? 22;
  try { await assertProbeTargetAllowed(inst.sshHost); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? "عنوان غير مسموح") }); return; }
  const reachable = await new Promise<boolean>((resolve) => {
    const sock = net.connect({ host: inst.sshHost!, port, timeout: 6000 });
    sock.on("connect", () => { sock.destroy(); resolve(true); });
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
    sock.on("error", () => resolve(false));
  });
  await db.update(agentInstancesTable).set({
    sshStatus: reachable ? "ok" : "error", sshLastCheckAt: new Date(), updatedAt: new Date(),
  }).where(eq(agentInstancesTable.id, id));
  if (reachable) res.json({ ok: true, host: inst.sshHost, port });
  else res.status(502).json({ error: `تعذّر الوصول إلى ${inst.sshHost}:${port}` });
});

// ── License / kill-switch ──────────────────────────────────────────────────

// POST /:id/license — re-issue key (optionally new expiry).
router.post("/:id/license", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  const expiresAt = typeof req.body?.expiresAt === "string" && req.body.expiresAt ? new Date(req.body.expiresAt) : inst.licenseExpiresAt;
  const licenseKey = mintLicenseKey(inst.installationId, inst.domain);
  await db.update(agentInstancesTable).set({ licenseKey, licenseExpiresAt: expiresAt, updatedAt: new Date() })
    .where(eq(agentInstancesTable.id, id));
  res.json({ ok: true, licenseKey, licenseExpiresAt: expiresAt });
});

router.post("/:id/suspend", async (req, res) => {
  const id = Number(req.params.id);
  await db.update(agentInstancesTable).set({ status: "suspended", updatedAt: new Date() }).where(eq(agentInstancesTable.id, id));
  await logAgentEvent(id, "suspended_by_admin", { by: (req as any).authUser?.username ?? null }, req);
  clearAgentHostCache();
  const { evictAgentDb } = await import("../lib/agentDb.js");
  evictAgentDb(id);
  res.json({ ok: true });
});
router.post("/:id/activate", async (req, res) => {
  const id = Number(req.params.id);
  await db.update(agentInstancesTable).set({ status: "active", updatedAt: new Date() }).where(eq(agentInstancesTable.id, id));
  clearAgentHostCache();
  res.json({ ok: true });
});

// ── Security events ────────────────────────────────────────────────────────

router.get("/security-events", async (_req, res) => {
  const rows = await db.select({
    id: agentSecurityEventsTable.id,
    agentId: agentSecurityEventsTable.agentId,
    agentName: agentInstancesTable.name,
    eventType: agentSecurityEventsTable.eventType,
    detail: agentSecurityEventsTable.detail,
    host: agentSecurityEventsTable.host,
    ip: agentSecurityEventsTable.ip,
    resolved: agentSecurityEventsTable.resolved,
    createdAt: agentSecurityEventsTable.createdAt,
  }).from(agentSecurityEventsTable)
    .leftJoin(agentInstancesTable, eq(agentInstancesTable.id, agentSecurityEventsTable.agentId))
    .orderBy(desc(agentSecurityEventsTable.id)).limit(500);
  res.json(rows);
});

router.post("/security-events/:id/resolve", async (req, res) => {
  const id = Number(req.params.id);
  await db.update(agentSecurityEventsTable).set({ resolved: true }).where(eq(agentSecurityEventsTable.id, id));
  res.json({ ok: true });
});

export default router;

// ── Public router (no auth) — branding + heartbeat ─────────────────────────

export const agentPublicRouter = Router();

// GET /api/branding?host=... — light login-page branding for agent domains.
agentPublicRouter.get("/branding", async (req, res) => {
  const host = normalizeHost(typeof req.query.host === "string" ? req.query.host : String(req.headers["x-forwarded-host"] ?? req.headers.host ?? ""));
  const hit = await lookupAgentByHost(host);
  if (!hit) { res.json({ isAgentDomain: false }); return; }
  res.json({
    isAgentDomain: true,
    suspended: hit.status !== "active",
    brandName: hit.brandName, brandLogoUrl: hit.brandLogoUrl, brandColor: hit.brandColor,
  });
});

// POST /api/agent/heartbeat — instance validation. Body:
// { installationId, licenseKey, domain, fingerprint?, version? }
agentPublicRouter.post("/agent/heartbeat", async (req, res) => {
  const { installationId, licenseKey, domain: rawDomain, fingerprint, version } = req.body ?? {};
  const domain = normalizeHost(typeof rawDomain === "string" ? rawDomain : "");
  if (typeof installationId !== "string" || !installationId) { res.status(400).json({ ok: false, error: "bad_request" }); return; }

  const [inst] = await db.select().from(agentInstancesTable)
    .where(eq(agentInstancesTable.installationId, installationId)).limit(1);
  if (!inst) {
    await logAgentEvent(null, "unknown_installation", { installationId: String(installationId).slice(0, 64), domain }, req);
    res.status(403).json({ ok: false, error: "unknown_installation" }); return;
  }

  const problems: string[] = [];
  const extras = Array.isArray(inst.extraDomains) ? (inst.extraDomains as string[]) : [];
  // Domain is REQUIRED — a heartbeat that omits it proves nothing.
  if (!domain) problems.push("unknown_domain");
  else if (domain !== inst.domain && !extras.includes(domain)) problems.push("unknown_domain");
  if (inst.licenseKey && licenseKey !== inst.licenseKey) problems.push("license_mismatch");
  if (inst.licenseExpiresAt && new Date(inst.licenseExpiresAt) < new Date()) problems.push("license_expired");
  if (inst.status !== "active") problems.push("suspended");
  // Once a fingerprint has been planted, every heartbeat MUST present it.
  if (inst.dbFingerprint && fingerprint !== inst.dbFingerprint) problems.push("db_fingerprint_mismatch");

  await db.update(agentInstancesTable).set({
    lastHeartbeatAt: new Date(), lastSeenIp: clientIp(req),
    ...(typeof version === "string" && version ? { deployedVersion: version.slice(0, 40) } : {}),
    updatedAt: new Date(),
  }).where(eq(agentInstancesTable.id, inst.id));

  if (problems.length) {
    await logAgentEvent(inst.id, problems[0], { problems, domain }, req);
    res.status(403).json({ ok: false, error: problems[0], problems }); return;
  }
  res.json({ ok: true, status: "active", licenseExpiresAt: inst.licenseExpiresAt });
});
