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
import { eq, desc, and, or, ne, lt } from "drizzle-orm";
import { z } from "zod/v4";
import { PgPool, type PgPoolType } from "@workspace/db";
import net from "node:net";
import { request as httpsRequest } from "node:https";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
  proxyToken: string | null; // decrypted per-agent proxy secret (null = not issued)
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
      brandColor: agentInstancesTable.brandColor, proxySecretEnc: agentInstancesTable.proxySecretEnc,
    }).from(agentInstancesTable);
    for (const r of rows) {
      const extras = Array.isArray(r.extraDomains) ? (r.extraDomains as string[]) : [];
      if (r.domain === host || extras.includes(host)) {
        hit = {
          id: r.id, status: r.status, dbStatus: r.dbStatus, dbUrlEnc: r.dbUrlEnc,
          brandName: r.brandName, brandLogoUrl: r.brandLogoUrl, brandColor: r.brandColor,
          proxyToken: r.proxySecretEnc ? decryptSecret(r.proxySecretEnc) : null,
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

/**
 * Effective host for agent resolution. Two sources, in trust order:
 *  1. X-Zacod-Agent-Host + X-Zacod-Agent-Token — set by the agent's reverse
 *     proxy (deployed Caddyfile). REQUIRED because edge proxies overwrite
 *     X-Forwarded-Host with the central domain. Trusted ONLY when the token
 *     matches the agent's stored high-entropy proxy secret (rotatable,
 *     encrypted at rest, issued per instance — never derived from a shared
 *     signing key).
 *  2. X-Forwarded-Host / Host — same trust boundary as domainResolver.
 */
export async function resolveAgentRequestHost(req: Request): Promise<string | null> {
  const claimed = req.headers["x-zacod-agent-host"];
  const token = req.headers["x-zacod-agent-token"];
  if (typeof claimed === "string" && typeof token === "string" && token.length >= 32) {
    const h = normalizeHost(claimed);
    if (h) {
      const hit = await lookupAgentByHost(h);
      const expected = hit?.proxyToken;
      if (expected) {
        try {
          const a = Buffer.from(token); const b = Buffer.from(expected);
          if (a.length === b.length && timingSafeEqual(a, b)) return h;
        } catch { /* fall through */ }
      }
      // Claimed-but-unverified → fall through to the standard headers and
      // record the attempt (forged proxy headers are a tamper signal).
      void logAgentEvent(hit?.id ?? null, "proxy_token_mismatch", { claimedHost: h }, req);
    }
  }
  const fwd = req.headers["x-forwarded-host"];
  return normalizeHost((Array.isArray(fwd) ? fwd[0] : fwd) || req.headers.host);
}

export async function agentDataSourceRouter(req: Request, res: any, next: (err?: unknown) => void): Promise<void> {
  try {
    const host = await resolveAgentRequestHost(req);
    const hit = await lookupAgentByHost(host);
    if (!hit) { next(); return; }
    // Stamp the request so downstream guards (e.g. superadmin-panel block)
    // can tell it arrived via a registered agent domain.
    (req as any).agentDomainHit = { id: hit.id, domain: hit.domain };
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

/**
 * لوحة السوبر أدمن ممنوعة نهائيًا من دومينات الوكلاء: أي طلب لمسارات
 * /api/admin/* قادم عبر دومين وكيل مسجّل يُرفض 404 (لا نكشف حتى وجود
 * المسار) ويُسجَّل كتنبيه أمان. تعمل فوق ختم agentDataSourceRouter.
 */
export function blockSuperadminOnAgentDomains(req: Request, res: any, next: (err?: unknown) => void): void {
  const hit = (req as any).agentDomainHit as { id: number; domain: string } | undefined;
  if (!hit) { next(); return; }
  void logAgentEvent(hit.id, "sa_panel_blocked", { path: req.path, method: req.method }, req);
  res.status(404).json({ error: "غير موجود" });
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
  const { dbUrlEnc, sshSecretEnc, proxySecretEnc, sshHostKeyFp: _fp, ...rest } = r as any;
  // Secrets are STRICTLY write-only: only boolean presence flags leave the
  // server — never the ciphertext and never any plaintext fragment.
  return {
    ...rest,
    dbUrlSet: !!dbUrlEnc,
    sshSecretSet: !!sshSecretEnc,
    proxyTokenSet: !!proxySecretEnc,
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
  mode: z.enum(["frontend_only", "full_shell", "full"]).optional(),
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
  // Uploaded logo: raw base64 + mime (the prod edge WAF blocks `data:` URIs
  // inside request bodies — the data URL is rebuilt server-side).
  brandLogoB64: z.string().regex(/^[A-Za-z0-9+/=]+$/).max(800_000).nullish(),
  brandLogoMime: z.enum(["image/png", "image/jpeg", "image/webp"]).nullish(),
  brandColor: z.string().max(20).nullish(),
  notes: z.string().max(2000).nullish(),
});

// POST /api/admin/agent-instances
router.post("/", async (req, res) => {
  const p = upsertSchema.safeParse(req.body);
  if (!p.success) {
    const first = p.error.issues[0];
    console.warn("[agent-instances] create validation failed:", JSON.stringify(p.error.issues).slice(0, 500));
    res.status(400).json({ error: `بيانات غير صالحة — الحقل: ${first?.path?.join(".") || "?"} (${first?.message || ""})`, detail: p.error.issues });
    return;
  }
  const d = p.data;
  const domain = normalizeHost(d.domain);
  if (!domain) { res.status(400).json({ error: "الدومين غير صالح" }); return; }
  const extras = (d.extraDomains ?? []).map(x => normalizeHost(x)).filter((x): x is string => !!x && x !== domain);
  try { assertSafeDomain(domain); extras.forEach(assertSafeDomain); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e).slice(0, 120) }); return; }
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
    brandName: d.brandName ?? null,
    brandLogoUrl: d.brandLogoB64 && d.brandLogoMime
      ? `data:${d.brandLogoMime};base64,${d.brandLogoB64}`
      : (d.brandLogoUrl ?? null),
    brandColor: d.brandColor ?? null,
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
  if (!id || !p.success) {
    const first = p.success ? null : p.error.issues[0];
    if (first) console.warn("[agent-instances] update validation failed:", JSON.stringify(p.success ? [] : p.error.issues).slice(0, 500));
    res.status(400).json({ error: first ? `بيانات غير صالحة — الحقل: ${first.path?.join(".") || "?"} (${first.message || ""})` : "بيانات غير صالحة" });
    return;
  }
  const d = p.data;
  const [existing] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (d.name !== undefined) patch.name = d.name;
  for (const k of ["contactPhone", "contactEmail", "brandName", "brandLogoUrl", "brandColor", "notes", "sshHost", "sshUser"] as const) {
    if (d[k] !== undefined) patch[k] = d[k] ?? null;
  }
  // Uploaded logo wins over a plain URL when both are present.
  if (d.brandLogoB64 && d.brandLogoMime) patch.brandLogoUrl = `data:${d.brandLogoMime};base64,${d.brandLogoB64}`;
  if (d.sshPort !== undefined) patch.sshPort = d.sshPort ?? null;
  if (d.mode !== undefined) patch.mode = d.mode;
  if (d.maxCompanies !== undefined) patch.maxCompanies = d.maxCompanies ?? null;
  if (d.licenseExpiresAt !== undefined) patch.licenseExpiresAt = d.licenseExpiresAt ? new Date(d.licenseExpiresAt) : null;
  if (d.domain !== undefined) {
    const domain = normalizeHost(d.domain);
    if (!domain) { res.status(400).json({ error: "الدومين غير صالح" }); return; }
    try { assertSafeDomain(domain); } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e).slice(0, 120) }); return; }
    patch.domain = domain;
  }
  if (d.extraDomains !== undefined) {
    const main = (patch.domain as string) ?? existing.domain;
    const extras = (d.extraDomains ?? []).map(x => normalizeHost(x)).filter((x): x is string => !!x && x !== main);
    try { extras.forEach(assertSafeDomain); } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e).slice(0, 120) }); return; }
    patch.extraDomains = extras;
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

/** Core of init-db: full schema copy + heal + fingerprint planting on the
 *  agent DB. Shared by the init-db route and the one-click provision pipeline.
 *  On success updates dbStatus=initialized; throws on failure (caller must
 *  fail closed). */
async function initAgentDatabaseCore(inst: typeof agentInstancesTable.$inferSelect): Promise<string> {
  if (!inst.dbUrlEnc) throw new Error("لم يتم إدخال رابط قاعدة البيانات بعد");
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
  }).where(eq(agentInstancesTable.id, inst.id));
  return fingerprint;
}

/** Fail-closed bookkeeping shared by init-db + provision. */
async function markInitDbFailed(id: number, msg: string): Promise<void> {
  // Fail CLOSED: a failed (re-)init must never leave dbStatus=initialized,
  // or routed traffic keeps flowing into a half-built database.
  await db.update(agentInstancesTable).set({
    dbStatus: "error", dbLastCheckAt: new Date(), dbLastError: msg, updatedAt: new Date(),
  }).where(eq(agentInstancesTable.id, id)).catch(() => {});
  clearAgentHostCache();
  const { evictAgentDb } = await import("../lib/agentDb.js");
  evictAgentDb(id);
}

// POST /:id/init-db — run full schema creation on the agent DB + plant fingerprint.
router.post("/:id/init-db", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  if (!inst.dbUrlEnc) { res.status(400).json({ error: "لم يتم إدخال رابط قاعدة البيانات بعد" }); return; }
  try {
    await initAgentDatabaseCore(inst);
    res.json({ ok: true, fingerprintPlanted: true });
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 500);
    await markInitDbFailed(id, msg);
    res.status(502).json({ error: "فشلت التهيئة", detail: msg });
  }
});

// POST /:id/test-ssh — real SSH login test when credentials are saved
// (TCP reachability alone used to pass while provisioning failed on auth).
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
  if (!reachable) {
    await db.update(agentInstancesTable).set({ sshStatus: "error", sshLastCheckAt: new Date(), updatedAt: new Date() }).where(eq(agentInstancesTable.id, id));
    res.status(502).json({ error: `تعذّر الوصول إلى ${inst.sshHost}:${port} — تأكد من العنوان والمنفذ` });
    return;
  }
  // المنفذ مفتوح — لو بيانات الدخول محفوظة، جرّب تسجيل الدخول الفعلي.
  if (inst.sshUser && inst.sshSecretEnc) {
    try {
      const r = await sshRunScript(inst, "echo AUTH_OK", { timeoutMs: 25_000 });
      if (!inst.sshHostKeyFp && r.hostKeyFp) {
        await db.update(agentInstancesTable).set({ sshHostKeyFp: r.hostKeyFp, updatedAt: new Date() }).where(eq(agentInstancesTable.id, id));
      }
      await db.update(agentInstancesTable).set({ sshStatus: "ok", sshLastCheckAt: new Date(), updatedAt: new Date() }).where(eq(agentInstancesTable.id, id));
      res.json({ ok: true, host: inst.sshHost, port, auth: true, user: inst.sshUser });
      return;
    } catch (e: any) {
      const raw = String(e?.message ?? e);
      const friendly = /authentication methods failed/i.test(raw)
        ? `المنفذ مفتوح لكن السيرفر رفض تسجيل الدخول للمستخدم «${inst.sshUser}» — تأكد من اسم المستخدم وكلمة المرور/المفتاح`
        : `المنفذ مفتوح لكن فشل الدخول: ${raw.slice(0, 300)}`;
      await db.update(agentInstancesTable).set({ sshStatus: "error", sshLastCheckAt: new Date(), updatedAt: new Date() }).where(eq(agentInstancesTable.id, id));
      res.status(502).json({ error: friendly });
      return;
    }
  }
  // لا توجد بيانات دخول محفوظة — فحص الوصول فقط.
  await db.update(agentInstancesTable).set({ sshStatus: "ok", sshLastCheckAt: new Date(), updatedAt: new Date() }).where(eq(agentInstancesTable.id, id));
  res.json({ ok: true, host: inst.sshHost, port, auth: false, note: "تم فحص الوصول فقط — أدخل المستخدم وكلمة المرور لاختبار الدخول الفعلي" });
});

// POST /:id/check-ban — هل سيرفر الوكيل حاظر عنوان المنصة (fail2ban ونحوه)؟
// يقارن منفذ SSH بمنافذ الويب (443/80) على نفس السيرفر: لو الويب يستجيب
// وSSH «مهلة» فهذا نمط الحظر الكلاسيكي (fail2ban يسقط الحزم بصمت).
// قراءة فقط — لا يغيّر أي حالة، ولا يحاول تسجيل دخول (حتى لا يجدّد الحظر).
router.post("/:id/check-ban", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  if (!inst.sshHost) { res.status(400).json({ error: "لم يتم إدخال بيانات السيرفر بعد" }); return; }
  try { await assertProbeTargetAllowed(inst.sshHost); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? "عنوان غير مسموح") }); return; }

  const sshPort = inst.sshPort ?? 22;
  const probe = (port: number, timeoutMs = 7000) =>
    new Promise<{ port: number; state: "open" | "refused" | "timeout"; ms: number }>((resolve) => {
      const t0 = Date.now();
      const sock = net.connect({ host: inst.sshHost!, port, timeout: timeoutMs });
      const done = (state: "open" | "refused" | "timeout") => { sock.destroy(); resolve({ port, state, ms: Date.now() - t0 }); };
      sock.on("connect", () => done("open"));
      sock.on("timeout", () => done("timeout"));
      sock.on("error", (err: any) => done(err?.code === "ECONNREFUSED" ? "refused" : "timeout"));
    });

  const [ssh, https443, http80] = await Promise.all([probe(sshPort), probe(443), probe(80)]);
  const webAlive = https443.state !== "timeout" || http80.state !== "timeout";

  let verdict: "no_ban" | "likely_ban" | "ssh_down" | "host_down";
  let title: string; let detail: string;
  if (ssh.state === "open") {
    verdict = "no_ban";
    title = "لا يوجد حظر — منفذ SSH مفتوح ويستجيب";
    detail = `منفذ ${sshPort} فتح خلال ${ssh.ms} مللي ثانية. لو «اختبار الوصول» يفشل رغم ذلك فالمشكلة في اسم المستخدم/كلمة المرور وليست حظرًا.`;
  } else if (ssh.state === "timeout" && webAlive) {
    verdict = "likely_ban";
    title = "الأرجح أن عنوان المنصة محظور على السيرفر (fail2ban)";
    detail = `السيرفر حي (الويب يستجيب على ${https443.state !== "timeout" ? "443" : "80"}) لكن منفذ SSH ${sshPort} لا يرد إطلاقًا — هذا النمط يعني إسقاط الحزم بصمت، وهو سلوك fail2ban بعد محاولات دخول فاشلة. مدة الحظر الافتراضية 10 دقائق وقد تصل لساعة أو أكثر حسب الإعداد.`;
  } else if (ssh.state === "refused" ) {
    verdict = "ssh_down";
    title = "المنفذ يرفض الاتصال — خدمة SSH متوقفة أو المنفذ تغيّر";
    detail = `السيرفر رد بـ«رفض» على المنفذ ${sshPort} (ليس حظرًا — الحظر عادةً صمت تام). تأكد أن sshd يعمل وأن المنفذ ${sshPort} هو الصحيح: ss -tlnp | grep sshd`;
  } else {
    verdict = "host_down";
    title = "السيرفر كله لا يستجيب (SSH والويب)";
    detail = "لا يمكن الجزم بالحظر — إما السيرفر مطفأ/معلّق، أو جدار ناري يمنع كل شيء، أو مشكلة شبكة عند المزود. جرّب من لوحة تحكم المزود (VNC/Console).";
  }

  res.json({
    verdict, title, detail,
    probes: [
      { label: `SSH (${sshPort})`, ...ssh },
      { label: "HTTPS (443)", ...https443 },
      { label: "HTTP (80)", ...http80 },
    ],
    checkedAt: new Date().toISOString(),
    unbanHint: verdict === "likely_ban"
      ? "من كونسول المزود: fail2ban-client unban --all  (أو انتظر انتهاء مدة الحظر ثم أعد المحاولة مرة واحدة فقط — كل محاولة فاشلة تجدد الحظر)"
      : null,
  });
});

// POST /:id/check-domains — read-only diagnostics for the agent's domains.
// For each domain (main + extras): DNS resolution, whether it points at the
// agent's own server (sshHost IPs), and an HTTPS liveness probe with latency.
// Purely additive — never mutates instance state.
router.post("/:id/check-domains", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }

  const domains = [inst.domain, ...((inst.extraDomains as string[] | null) ?? [])]
    .map(d => String(d ?? "").trim().toLowerCase()).filter(Boolean).slice(0, 21);
  if (domains.length === 0) { res.status(400).json({ error: "لا توجد نطاقات مسجّلة" }); return; }

  // Resolve the agent server's own IPs once (from sshHost) for comparison.
  let serverIps: string[] = [];
  if (inst.sshHost) {
    try {
      if (net.isIP(inst.sshHost)) serverIps = [inst.sshHost];
      else serverIps = (await dnsLookup(inst.sshHost, { all: true })).map(a => a.address);
    } catch { /* unresolved server host → onServer stays unknown */ }
  }

  const checkOne = async (domain: string) => {
    const out: {
      domain: string; ips: string[]; dnsOk: boolean;
      onServer: boolean | null; live: boolean; httpStatus: number | null;
      latencyMs: number | null; error: string | null;
    } = { domain, ips: [], dnsOk: false, onServer: null, live: false, httpStatus: null, latencyMs: null, error: null };
    // SSRF guard — same policy as every other probe on this router.
    try { await assertProbeTargetAllowed(domain); }
    catch (e: any) { out.error = String(e?.message ?? "عنوان غير مسموح"); return out; }
    try {
      out.ips = (await dnsLookup(domain, { all: true })).map(a => a.address);
      out.dnsOk = out.ips.length > 0;
    } catch { out.error = "تعذّر تحليل DNS للنطاق"; }
    if (out.dnsOk && serverIps.length > 0) out.onServer = out.ips.some(ip => serverIps.includes(ip));
    if (out.dnsOk) {
      // DNS-rebinding safety: re-check the resolved addresses, then PIN the
      // HTTPS connection to the first vetted IP via a custom lookup — fetch()
      // would re-resolve the name, so it must not be used here. servername
      // stays the domain so TLS SNI/verification behave normally.
      const isBlockedIp = (ip: string) =>
        /^127\./.test(ip) || ip === "0.0.0.0" || /^169\.254\./.test(ip) ||
        ip === "::1" || ip === "::" || /^fe80:/i.test(ip) || /^::ffff:127\./i.test(ip);
      if (out.ips.some(isBlockedIp)) { out.error = "هذا العنوان غير مسموح"; return out; }
      const pinnedIp = out.ips[0];
      const t0 = Date.now();
      try {
        await new Promise<void>((resolve, reject) => {
          const probe = httpsRequest({
            host: domain, servername: domain, port: 443, path: "/", method: "GET", timeout: 8000,
            lookup: ((_h: string, opts: any, cb: any) => {
              const fam = net.isIP(pinnedIp);
              if (typeof opts === "function") { opts(null, pinnedIp, fam); return; }
              if (opts?.all) cb(null, [{ address: pinnedIp, family: fam }]);
              else cb(null, pinnedIp, fam);
            }) as any,
          }, (resp) => {
            // Any HTTP response (even 4xx/5xx) proves the domain serves traffic.
            out.latencyMs = Date.now() - t0;
            out.httpStatus = resp.statusCode ?? null;
            out.live = true;
            resp.resume();
            resolve();
          });
          probe.on("timeout", () => probe.destroy(new Error("probe-timeout")));
          probe.on("error", reject);
          probe.end();
        });
      } catch (e: any) {
        out.latencyMs = Date.now() - t0;
        out.error = String(e?.message ?? "").includes("probe-timeout")
          ? "انتهت مهلة الاتصال (8 ثوان)" : "تعذّر الاتصال عبر HTTPS";
      }
    }
    return out;
  };

  const results = await Promise.all(domains.map(checkOne));
  res.json({ ok: true, serverHost: inst.sshHost ?? null, serverIps, results, checkedAt: new Date().toISOString() });
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
// POST /:id/wipe — الحذف الكامل لكل ما ثبّتناه على سيرفر الوكيل (حماية الملكية
// الفكرية). يوقف الترخيص فورًا (kill-switch) ثم يحاول عبر SSH إزالة: خدمة
// التطبيق zacod-app + ملفاتها، /opt/zacod، مهام cron (نبض + محدّث)، Caddy
// وإعداداته، وقاعدة بيانات/دور PostgreSQL اللذين أنشأهما التسطيب. حتى لو غيّر
// الوكيل بيانات SSH وفشل الاتصال: الترخيص يُلغى والنبض التالي يكتب SUSPENDED
// فتتوقف النسخة عن العمل.
router.post("/:id/wipe", async (req, res) => {
  const id = Number(req.params.id);
  // Atomic lease: claim the shared deployStatus='deploying' slot so a
  // concurrent deploy/provision can't run while we are deleting (and vice
  // versa — provision/deploy claim the same slot conditionally).
  const [inst] = await db.update(agentInstancesTable)
    .set({ deployStatus: "deploying", updatedAt: new Date() })
    .where(and(eq(agentInstancesTable.id, id), ne(agentInstancesTable.deployStatus, "deploying")))
    .returning();
  if (!inst) {
    const [row] = await db.select({ id: agentInstancesTable.id }).from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
    res.status(row ? 409 : 404).json({ error: row ? "توجد عملية تسطيب/نشر جارية — انتظر انتهاءها أولًا" : "غير موجود" });
    return;
  }
  // Persist a terminal wipe state on EVERY exit path (never leave the lease
  // held or stale deployed/initialized flags on a wiped/unreachable server).
  const finish = async (extra: Record<string, unknown>) => {
    await db.update(agentInstancesTable).set({
      deployedVersion: null, dbStatus: "not_configured", updatedAt: new Date(), ...extra,
    }).where(eq(agentInstancesTable.id, id)).catch(() => {});
  };

  // 1) Kill-switch أولًا وبلا شروط: تعطيل + إلغاء مفتاح الترخيص.
  await db.update(agentInstancesTable)
    .set({ status: "suspended", licenseKey: null, updatedAt: new Date() })
    .where(eq(agentInstancesTable.id, id));
  await logAgentEvent(id, "suspended_by_admin", { by: (req as any).authUser?.username ?? null, note: "wipe" }, req);
  clearAgentHostCache();
  { const { evictAgentDb } = await import("../lib/agentDb.js"); evictAgentDb(id); }

  // 2) المسح عن بُعد (أفضل جهد) — يحتاج بيانات SSH محفوظة.
  if (!inst.sshHost || !inst.sshSecretEnc) {
    const msg = "لا توجد بيانات SSH محفوظة — تم تعطيل الترخيص وإلغاء المفتاح فقط؛ نبض النسخة القادم سيوقفها تلقائيًا.";
    await finish({ deployStatus: "never", deployLog: `— الحذف الكامل —\n${msg}` });
    res.json({ ok: true, wiped: false, log: msg });
    return;
  }
  try {
    assertShellSafeHostLike(inst.sshHost, "مضيف SSH");
    await assertProbeTargetAllowed(inst.sshHost); // SSRF guard — نفس فحص النشر
  } catch (e: any) {
    const msg = `تعذّر المسح عبر SSH: ${e?.message ?? e} — تم تعطيل الترخيص وإلغاء المفتاح.`;
    await finish({ deployStatus: "error", deployLog: `— الحذف الكامل —\n${msg}` });
    res.json({ ok: true, wiped: false, log: msg });
    return;
  }

  // أسماء قاعدة/دور PostgreSQL كما يولّدها «التسطيب الكامل» — قيم ثابتة آمنة.
  const dbName = `zacod_agent_${id}`;
  const dbRole = `zacod_a${id}`;
  const wipeScript = `#!/usr/bin/env bash
echo "== إيقاف وإزالة تطبيق zacod-app =="
systemctl stop zacod-app 2>/dev/null || true
systemctl disable zacod-app 2>/dev/null || true
rm -f /etc/systemd/system/zacod-app.service
systemctl daemon-reload 2>/dev/null || true
echo "== إزالة المهام المجدولة (نبض + محدّث) =="
( crontab -l 2>/dev/null | grep -v 'zacod-heartbeat' | grep -v 'zacod-update' ) | crontab - 2>/dev/null || true
echo "== حذف ملفات /opt/zacod بالكامل =="
rm -rf /opt/zacod
echo "== إزالة Caddy وإعداداته =="
systemctl stop caddy 2>/dev/null || true
systemctl disable caddy 2>/dev/null || true
if command -v apt-get >/dev/null 2>&1; then apt-get purge -y caddy >/dev/null 2>&1 || true; fi
rm -rf /etc/caddy
echo "== حذف قاعدة البيانات والدور =="
if command -v psql >/dev/null 2>&1; then
  sudo -u postgres psql -c 'DROP DATABASE IF EXISTS ${dbName};' 2>/dev/null || true
  sudo -u postgres psql -c 'DROP ROLE IF EXISTS ${dbRole};' 2>/dev/null || true
fi
rm -f /tmp/zacod-app.tgz
echo "== التحقق من اكتمال الحذف =="
LEFT=""
[ -e /opt/zacod ] && LEFT="$LEFT /opt/zacod"
[ -e /etc/systemd/system/zacod-app.service ] && LEFT="$LEFT zacod-app.service"
crontab -l 2>/dev/null | grep -q 'zacod-' && LEFT="$LEFT cron"
if [ -n "$LEFT" ]; then echo "WARNING: بقايا لم تُحذف:$LEFT"; echo "ZACOD_WIPE_PARTIAL"; else echo "ZACOD_WIPE_DONE"; fi
`;
  try {
    const r = await sshRunScript(inst, wipeScript, { timeoutMs: 240_000 });
    // النجاح = وصل السكربت للنهاية *و* لم يجد أي بقايا (الفحص أعلاه).
    const done = r.code === 0 && r.out.includes("ZACOD_WIPE_DONE");
    await finish({
      deployStatus: done ? "never" : "error",
      deployLog: `— سجل الحذف الكامل —\n${r.out.slice(-7000)}`,
    });
    res.json({ ok: true, wiped: done, log: r.out.slice(-7000) || (done ? "تم الحذف الكامل." : "لم يكتمل المسح — راجع السجل.") });
  } catch (e: any) {
    const msg = `تعذّر الاتصال بالسيرفر (${String(e?.message ?? e)}).\nتم تعطيل الترخيص وإلغاء المفتاح — النسخة ستتوقف مع أول نبض قادم.`;
    await finish({ deployStatus: "error", deployLog: `— الحذف الكامل: فشل الاتصال —\n${msg}` });
    res.json({ ok: true, wiped: false, log: msg });
  }
});

router.post("/:id/activate", async (req, res) => {
  const id = Number(req.params.id);
  await db.update(agentInstancesTable).set({ status: "active", updatedAt: new Date() }).where(eq(agentInstancesTable.id, id));
  clearAgentHostCache();
  res.json({ ok: true });
});

// ── Phase 3: setup kit + SSH deploy engine ─────────────────────────────────

/** Central platform origin used by deployed agents (proxy target + heartbeat). */
function resolveCentralOrigin(): string {
  const domains = (process.env.REPLIT_DOMAINS ?? "").split(",").map(d => d.trim()).filter(Boolean);
  const prodDomain = process.env.NODE_ENV === "production" && domains.length
    ? `https://${domains.find(d => !/\.replit\.(app|dev)$/i.test(d)) ?? domains[0]}` : "";
  const c = process.env.PUBLIC_BASE_URL || prodDomain
    || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "");
  return c.replace(/\/+$/, "");
}

/** Strict DNS hostname validation — these values are interpolated into a
 *  root-executed shell script and a Caddyfile, so anything outside plain
 *  hostname syntax is rejected outright (heredoc/shell injection guard). */
function assertSafeDomain(domain: string): void {
  if (!/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/.test(domain) || domain.length > 253) {
    throw new Error(`دومين غير صالح: ${domain.slice(0, 60)}`);
  }
}

/** Ensure the instance has a high-entropy rotatable proxy secret; returns the
 *  plaintext token. Generated once, stored encrypted, rotatable on demand. */
async function ensureProxySecret(inst: typeof agentInstancesTable.$inferSelect): Promise<string> {
  if (inst.proxySecretEnc) {
    const t = decryptSecret(inst.proxySecretEnc);
    if (t) return t;
  }
  const token = randomBytes(32).toString("hex");
  await db.update(agentInstancesTable)
    .set({ proxySecretEnc: encryptSecret(token), updatedAt: new Date() })
    .where(eq(agentInstancesTable.id, inst.id));
  clearAgentHostCache();
  return token;
}

async function buildSetupKit(inst: typeof agentInstancesTable.$inferSelect) {
  assertSafeDomain(inst.domain);
  const origin = resolveCentralOrigin();
  // Validate before interpolating into the root script.
  const originUrl = new URL(origin);
  if (originUrl.protocol !== "https:" && originUrl.protocol !== "http:") throw new Error("أصل المنصة غير صالح");
  const proxyToken = await ensureProxySecret(inst);
  if (!/^[a-f0-9]{64}$/.test(proxyToken)) throw new Error("رمز الوكيل غير صالح — أعد توليده");
  const config = {
    domain: inst.domain,
    installationId: inst.installationId,
    licenseKey: inst.licenseKey ?? "",
    fingerprint: inst.dbFingerprint ?? "",
    centralOrigin: origin,
    heartbeatUrl: `${origin}/api/agent/heartbeat`,
  };
  const heartbeatScript = `#!/usr/bin/env bash
# zacod agent heartbeat — validates license/identity with the central platform.
# On a definitive 403 (suspended / revoked license) the local proxy is stopped.
CFG=/opt/zacod/config.json
URL=$(grep -o '"heartbeatUrl": *"[^"]*"' $CFG | cut -d'"' -f4)
BODY=$(printf '{"installationId":"%s","licenseKey":"%s","domain":"%s","fingerprint":"%s"}' \\
  "$(grep -o '"installationId": *"[^"]*"' $CFG | cut -d'"' -f4)" \\
  "$(grep -o '"licenseKey": *"[^"]*"' $CFG | cut -d'"' -f4)" \\
  "$(grep -o '"domain": *"[^"]*"' $CFG | cut -d'"' -f4)" \\
  "$(grep -o '"fingerprint": *"[^"]*"' $CFG | cut -d'"' -f4)")
CODE=$(curl -s -o /tmp/zacod_hb.json -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "$BODY" "$URL")
if [ "$CODE" = "403" ]; then
  touch /opt/zacod/SUSPENDED
  systemctl stop caddy 2>/dev/null || true
elif [ "$CODE" = "200" ] && [ -f /opt/zacod/SUSPENDED ]; then
  rm -f /opt/zacod/SUSPENDED
  systemctl start caddy 2>/dev/null || true
fi
`;
  // «full» edition runs the whole app locally — Caddy fronts the local app
  // (TLS + kill-switch via heartbeat) instead of proxying to the central API.
  const caddyfile = inst.mode === "full"
    ? `${inst.domain} {
  reverse_proxy 127.0.0.1:8080
}
`
    : `${inst.domain} {
  reverse_proxy ${origin} {
    header_up Host {upstream_hostport}
    header_up X-Zacod-Agent-Host ${inst.domain}
    header_up X-Zacod-Agent-Token ${proxyToken}
  }
}
`;
  const installScript = `#!/usr/bin/env bash
# zacod agent bootstrap — idempotent. Run as root on the agent server.
set -e
mkdir -p /opt/zacod
cat > /opt/zacod/config.json <<'ZACOD_CFG'
${JSON.stringify(config, null, 2)}
ZACOD_CFG
cat > /opt/zacod/heartbeat.sh <<'ZACOD_HB'
${heartbeatScript}
ZACOD_HB
chmod 700 /opt/zacod/heartbeat.sh; chmod 600 /opt/zacod/config.json
( crontab -l 2>/dev/null | grep -v zacod-heartbeat ; echo "*/5 * * * * /opt/zacod/heartbeat.sh # zacod-heartbeat" ) | crontab -
# Caddy is REQUIRED — any failure below aborts the script (set -e) so the
# central API records the deploy as failed instead of a silent half-install.
if ! command -v caddy >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    apt-get install -y caddy
  else
    echo "ERROR: apt-get not found — install caddy manually" >&2
    exit 1
  fi
fi
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<'ZACOD_CADDY'
${caddyfile}
ZACOD_CADDY
caddy validate --config /etc/caddy/Caddyfile
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy
sleep 2
systemctl is-active --quiet caddy
/opt/zacod/heartbeat.sh || true
echo "ZACOD_BOOTSTRAP_DONE"
`;
  return { config, heartbeatScript, caddyfile, installScript };
}

// GET /:id/setup-kit — config + scripts for manual installation.
router.get("/:id/setup-kit", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  if (!inst.licenseKey) { res.status(400).json({ error: "أصدر ترخيصًا أولًا" }); return; }
  try { res.json(await buildSetupKit(inst)); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e).slice(0, 200) }); }
});

// POST /:id/email-package — send the full setup package to the agent's
// email: install script + config + Caddyfile + heartbeat + license/install
// codes, plus (full_shell) an initial DB schema dump. Uses the system's
// configured email senders.
router.post("/:id/email-package", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  if (!inst.licenseKey) { res.status(400).json({ error: "أصدر ترخيصًا أولًا" }); return; }
  const email = String(req.body?.email ?? inst.contactEmail ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { res.status(400).json({ error: "أدخل بريدًا صالحًا" }); return; }
  // الحزمة تحتوي أسرار الوكيل (مفتاح الترخيص + رمز البروكسي) — الإرسال لغير
  // الإيميل المسجّل يتطلب تأكيدًا صريحًا، ويُحدَّث الإيميل المسجّل بعده.
  const stored = (inst.contactEmail ?? "").trim().toLowerCase();
  if (stored && email !== stored && req.body?.confirmOverride !== true) {
    res.status(409).json({ error: "الإيميل مختلف عن إيميل الوكيل المسجّل", needsConfirm: true, storedEmail: stored });
    return;
  }
  if (email !== stored) {
    await db.update(agentInstancesTable).set({ contactEmail: email, updatedAt: new Date() }).where(eq(agentInstancesTable.id, id));
    await logAgentEvent(id, "contact_email_changed", { from: stored || null, to: email, by: (req as any).authUser?.username ?? null }, req);
  }

  let kit: Awaited<ReturnType<typeof buildSetupKit>>;
  try { kit = await buildSetupKit(inst); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e).slice(0, 200) }); return; }

  const attachments: { filename: string; content: string | Buffer; contentType?: string }[] = [
    { filename: "install.sh", content: kit.installScript, contentType: "text/x-shellscript" },
    { filename: "config.json", content: JSON.stringify(kit.config, null, 2), contentType: "application/json" },
    { filename: "Caddyfile", content: kit.caddyfile, contentType: "text/plain" },
    { filename: "heartbeat.sh", content: kit.heartbeatScript, contentType: "text/x-shellscript" },
  ];

  // full_shell: attach the initial database schema (structure only, no data).
  if (inst.mode === "full_shell" && process.env.DATABASE_URL) {
    try {
      const { execFile } = await import("node:child_process");
      const dumpSql = await new Promise<string>((resolve, reject) => {
        execFile("pg_dump", [
          "--schema-only", "--no-owner", "--no-privileges", "--no-comments",
          process.env.DATABASE_URL!,
        ], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) reject(new Error(String(stderr || err.message).slice(0, 200)));
          else resolve(stdout);
        });
      });
      attachments.push({ filename: "db-init.sql", content: dumpSql, contentType: "application/sql" });
    } catch (e: any) {
      // Don't block the whole send — DB init can also run via زر «تهيئة قاعدة البيانات».
      attachments.push({ filename: "db-init-README.txt", content: `تعذّر توليد نسخة قاعدة البيانات تلقائيًا (${String(e?.message ?? e)}). استخدم زر «تهيئة قاعدة البيانات» من لوحة التحكم بدلًا من ذلك.` });
    }
  }

  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const html = `
    <div dir="rtl" style="font-family:Tahoma,Arial,sans-serif; line-height:1.9;">
      <h2 style="margin:0 0 8px;">حزمة تسطيب نسخة الوكيل — ${esc(inst.name)}</h2>
      <p>مرفق مع هذه الرسالة كل ملفات التسطيب الخاصة بدومين <b dir="ltr">${esc(inst.domain)}</b>.</p>
      <table style="border-collapse:collapse; font-size:13px;" border="1" cellpadding="6">
        <tr><td><b>نوع النسخة</b></td><td>${inst.mode === "full" ? "نسخة كاملة (تعمل بدون API المركزي)" : inst.mode === "full_shell" ? "نسخة قشرة كاملة (فرونت + باك قشرة)" : "واجهة فقط + API مركزي"}</td></tr>
        <tr><td><b>مفتاح الترخيص</b></td><td dir="ltr" style="font-family:monospace;">${esc(inst.licenseKey)}</td></tr>
        <tr><td><b>معرّف التنصيب</b></td><td dir="ltr" style="font-family:monospace;">${esc(inst.installationId)}</td></tr>
        ${inst.licenseExpiresAt ? `<tr><td><b>انتهاء الترخيص</b></td><td dir="ltr">${new Date(inst.licenseExpiresAt).toISOString().slice(0, 10)}</td></tr>` : ""}
      </table>
      <h3>خطوات التسطيب على السيرفر:</h3>
      <ol>
        <li>ارفع الملفات المرفقة إلى السيرفر (مثلًا في <span dir="ltr">/root/zacod-setup</span>).</li>
        <li>نفّذ: <span dir="ltr" style="font-family:monospace; background:#f1f5f9; padding:2px 6px; border-radius:4px;">bash install.sh</span> بصلاحية root.</li>
        <li>السكربت يثبّت الوكيل العكسي ويربط الدومين ويشغّل نبض الترخيص تلقائيًا (كل 5 دقائق).</li>
        ${inst.mode === "full_shell" ? "<li>لقاعدة البيانات: نفّذ <span dir='ltr' style='font-family:monospace;'>db-init.sql</span> على قاعدة PostgreSQL فارغة، أو استخدم زر «تهيئة قاعدة البيانات» من لوحة التحكم المركزية.</li>" : ""}
      </ol>
      <p style="color:#64748b; font-size:12px;">هذه الملفات تحتوي مفاتيح خاصة بهذا الوكيل فقط، وهي مربوطة بدومينه ولا تعمل على أي دومين آخر. عند إيقاف الوكيل من لوحة التحكم تتوقف نسخته تلقائيًا خلال دقائق.</p>
    </div>`;

  const { sendEmail } = await import("../lib/email.js");
  const r = await sendEmail({
    to: email,
    subject: `حزمة تسطيب نسخة الوكيل — ${inst.name} (${inst.domain})`,
    html,
    attachments,
  });
  if (!r.ok) { res.status(502).json({ error: `فشل إرسال البريد: ${r.reason ?? "غير معروف"}` }); return; }
  await logAgentEvent(id, "package_emailed", { to: email, by: (req as any).authUser?.username ?? null, files: attachments.map(a => a.filename) }, req);
  res.json({ ok: true, sentTo: email, files: attachments.map(a => a.filename) });
});

// POST /:id/rotate-proxy-token — invalidate the current proxy secret. The
// agent must be re-deployed (or the kit re-installed) afterwards.
router.post("/:id/rotate-proxy-token", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  await db.update(agentInstancesTable)
    .set({ proxySecretEnc: encryptSecret(randomBytes(32).toString("hex")), updatedAt: new Date() })
    .where(eq(agentInstancesTable.id, id));
  clearAgentHostCache();
  await logAgentEvent(id, "proxy_token_rotated", { by: (req as any).authUser?.username ?? null }, req);
  res.json({ ok: true, note: "أعد النشر أو أعد تثبيت حزمة التهيئة ليعمل الدومين" });
});

/** Run a root bash script on the agent server over SSH (shared by deploy +
 *  the one-click provision pipeline). Host-key pinning: TOFU on first contact
 *  (pinned on success by the caller via the returned fingerprint), strict
 *  verification afterwards. Output capped so the remote can't exhaust memory. */
async function sshRunScript(
  inst: typeof agentInstancesTable.$inferSelect,
  script: string,
  opts?: { timeoutMs?: number },
): Promise<{ code: number; out: string; hostKeyFp: string }> {
  if (!inst.sshHost || !inst.sshUser || !inst.sshSecretEnc) throw new Error("أكمل بيانات السيرفر (المضيف والمستخدم وكلمة المرور/المفتاح) أولًا");
  const secret = decryptSecret(inst.sshSecretEnc);
  if (!secret) throw new Error("تعذّر فك تشفير بيانات الدخول");
  const { Client } = await import("ssh2");
  const { createHash } = await import("node:crypto");
  const isKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(secret);
  const MAX_OUT = 64_000;
  const timeoutMs = opts?.timeoutMs ?? 180_000;
  let seenHostKeyFp = "";
  const isRoot = inst.sshUser === "root";
  const result = await new Promise<{ code: number; out: string }>((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => { conn.end(); reject(new Error(`انتهت مهلة الاتصال/التنفيذ (${Math.round(timeoutMs / 1000)} ثانية)`)); }, timeoutMs);
    // ينفّذ أمرًا واحدًا على القناة ويعيد المخرجات وكود الخروج.
    const runOnce = (cmd: string, stdin: string, prefixStdin?: string) =>
      new Promise<{ code: number; out: string }>((res2, rej2) => {
        conn.exec(cmd, (err, stream) => {
          if (err) { rej2(err); return; }
          let out = "";
          const add = (d: Buffer) => { if (out.length < MAX_OUT) out += d.toString().slice(0, MAX_OUT - out.length); };
          stream.on("data", add);
          stream.stderr.on("data", add);
          stream.on("close", (code: number) => res2({ code: code ?? 1, out }));
          if (prefixStdin) stream.write(prefixStdin);
          stream.end(stdin);
        });
      });
    conn.on("ready", () => {
      void (async () => {
        try {
          let r: { code: number; out: string };
          if (isRoot) {
            r = await runOnce("bash -s", script);
          } else {
            // المستخدم ليس root — نرفع الصلاحيات عبر sudo تلقائيًا.
            // أولًا: هل sudo متاح دون كلمة مرور؟
            const probe = await runOnce("sudo -n true 2>/dev/null; echo RC=$?", "");
            const passwordless = /RC=0/.test(probe.out);
            if (passwordless) {
              r = await runOnce("sudo bash -s", script);
            } else if (!isKey) {
              // sudo يطلب كلمة المرور — نمررها عبر stdin (نفس كلمة مرور SSH).
              r = await runOnce("sudo -S -p '' bash -s", script, secret + "\n");
              if (r.code !== 0 && /(incorrect password|sorry, try again|not in the sudoers)/i.test(r.out)) {
                throw new Error(`المستخدم «${inst.sshUser}» لا يملك صلاحيات sudo كافية أو كلمة مرور sudo مختلفة — استخدم root أو أضف المستخدم إلى sudoers`);
              }
            } else {
              throw new Error(`المستخدم «${inst.sshUser}» يدخل بمفتاح لكن sudo يطلب كلمة مرور — استخدم root أو فعّل NOPASSWD للمستخدم`);
            }
          }
          clearTimeout(timer); conn.end(); resolve(r);
        } catch (e) { clearTimeout(timer); conn.end(); reject(e); }
      })();
    });
    conn.on("error", (e) => { clearTimeout(timer); reject(e); });
    conn.connect({
      host: inst.sshHost!, port: inst.sshPort ?? 22, username: inst.sshUser!,
      ...(isKey ? { privateKey: secret } : { password: secret }),
      readyTimeout: 15_000,
      hostVerifier: (key: Buffer) => {
        seenHostKeyFp = `SHA256:${createHash("sha256").update(key).digest("base64")}`;
        if (!inst.sshHostKeyFp) return true; // first contact — pinned by caller on success
        if (inst.sshHostKeyFp === seenHostKeyFp) return true;
        void logAgentEvent(inst.id, "ssh_hostkey_mismatch", { expected: inst.sshHostKeyFp, got: seenHostKeyFp });
        return false;
      },
    });
  });
  return { ...result, hostKeyFp: seenHostKeyFp };
}

/** Persist the TOFU host-key pin after a successful script run. */
async function pinHostKey(inst: typeof agentInstancesTable.$inferSelect, fp: string): Promise<void> {
  if (!inst.sshHostKeyFp && fp) {
    await db.update(agentInstancesTable).set({ sshHostKeyFp: fp }).where(eq(agentInstancesTable.id, inst.id)).catch(() => {});
    (inst as any).sshHostKeyFp = fp; // later steps in the same pipeline verify strictly
  }
}

// POST /:id/deploy — run the bootstrap script on the agent server over SSH.
router.post("/:id/deploy", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  if (!inst.sshHost || !inst.sshUser || !inst.sshSecretEnc) { res.status(400).json({ error: "أكمل بيانات السيرفر (المضيف والمستخدم وكلمة المرور/المفتاح) أولًا" }); return; }
  if (!inst.licenseKey) { res.status(400).json({ error: "أصدر ترخيصًا أولًا" }); return; }
  if (inst.deployStatus === "deploying") { res.status(409).json({ error: "يوجد نشر جارٍ بالفعل" }); return; }
  try { await assertProbeTargetAllowed(inst.sshHost); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? "عنوان غير مسموح") }); return; }

  const secret = decryptSecret(inst.sshSecretEnc);
  if (!secret) { res.status(400).json({ error: "تعذّر فك تشفير بيانات الدخول" }); return; }
  let installScript: string;
  try { ({ installScript } = await buildSetupKit(inst)); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e).slice(0, 200) }); return; }

  // Atomic claim: only ONE request may flip status → deploying. A stale
  // "deploying" older than 10 minutes is treated as abandoned and reclaimable.
  const staleBefore = new Date(Date.now() - 10 * 60_000);
  const claimed = await db.update(agentInstancesTable)
    .set({ deployStatus: "deploying", updatedAt: new Date() })
    .where(and(
      eq(agentInstancesTable.id, id),
      or(ne(agentInstancesTable.deployStatus, "deploying"), lt(agentInstancesTable.updatedAt, staleBefore)),
    )).returning({ id: agentInstancesTable.id });
  if (!claimed.length) { res.status(409).json({ error: "يوجد نشر جارٍ بالفعل" }); return; }

  const log: string[] = [];
  const finish = async (ok: boolean, tail: string) => {
    log.push(tail);
    await db.update(agentInstancesTable).set({
      deployStatus: ok ? "ok" : "error",
      deployLog: log.join("\n").slice(-8000),
      lastDeployAt: new Date(),
      sshStatus: ok ? "ok" : inst.sshStatus,
      updatedAt: new Date(),
    }).where(eq(agentInstancesTable.id, id)).catch(() => {});
  };

  try {
    const result = await sshRunScript(inst, installScript);
    log.push(`[ssh] connected to ${inst.sshHost}:${inst.sshPort ?? 22} as ${inst.sshUser} (hostkey ${result.hostKeyFp.slice(0, 16)}…)`);
    const ok = result.code === 0 && result.out.includes("ZACOD_BOOTSTRAP_DONE");
    if (ok) await pinHostKey(inst, result.hostKeyFp);
    await finish(ok, result.out.slice(-6000));
    if (ok) res.json({ ok: true, log: log.join("\n").slice(-8000) });
    else res.status(502).json({ error: "فشل النشر — راجع السجل", log: log.join("\n").slice(-8000) });
  } catch (e: any) {
    await finish(false, `[error] ${String(e?.message ?? e).slice(0, 400)}`);
    res.status(502).json({ error: "فشل النشر", detail: String(e?.message ?? e).slice(0, 400) });
  }
});

// ── One-click full provisioning ────────────────────────────────────────────
//
// POST /:id/provision — runs the whole setup pipeline on the agent server
// over SSH, with zero involvement from the agent:
//   1) فحص السيرفر (نظام/معالج/ذاكرة/قرص)
//   2) تثبيت PostgreSQL + إنشاء قاعدة ومستخدم (إن لم تكن قاعدة مسجّلة)
//   3) تثبيت بوابة الدخول (Caddy + نبض الترخيص)
//   4) تهيئة قاعدة البيانات (نسخ السكيما + زرع البصمة)
//   5) نسخة كاملة فقط: تثبيت Node + التطبيق كخدمة + محدّث تلقائي
//   6) فحص نهائي
// Responds immediately ({started:true}); progress is streamed into deployLog
// (the UI polls the list while deployStatus === "deploying").

function shQ(s: string): string {
  // Single-quote for bash. Values we interpolate are validated/hex, but keep
  // a hard guard anyway.
  if (s.includes("'")) throw new Error("قيمة غير صالحة للتنفيذ الآمن");
  return `'${s}'`;
}

/** Values interpolated into root SSH scripts MUST be shell-metacharacter-free.
 *  Hostnames/domains: letters, digits, dot, dash. Rejects everything else
 *  (command substitution, backticks, $, quotes, spaces...). */
function assertShellSafeHostLike(v: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,253}$/.test(v)) throw new Error(`${label} يحتوي رموزًا غير مسموحة`);
}
/** DATABASE_URL written into the env file: strict allow-list of URL chars. */
function assertShellSafeDbUrl(v: string): void {
  if (!/^postgres(ql)?:\/\/[A-Za-z0-9_.:@/%?&=-]+$/.test(v)) throw new Error("رابط قاعدة البيانات غير صالح لبيئة التشغيل");
}

async function runProvision(instIn: typeof agentInstancesTable.$inferSelect): Promise<void> {
  let inst = instIn;
  const log: string[] = [];
  const save = async (status?: "ok" | "error") => {
    await db.update(agentInstancesTable).set({
      deployLog: log.join("\n").slice(-8000),
      ...(status ? { deployStatus: status, lastDeployAt: new Date(), sshStatus: status === "ok" ? "ok" : inst.sshStatus } : {}),
      updatedAt: new Date(),
    }).where(eq(agentInstancesTable.id, inst.id)).catch(() => {});
  };
  const step = async (title: string) => { log.push(`\n■ ${title}`); await save(); };
  const runSsh = async (script: string, marker: string, timeoutMs: number) => {
    const r = await sshRunScript(inst, script, { timeoutMs });
    log.push(r.out.slice(-3000));
    if (r.code !== 0 || !r.out.includes(marker)) throw new Error("فشلت الخطوة — راجع السجل أعلاه");
    await pinHostKey(inst, r.hostKeyFp);
  };
  const reload = async () => {
    const [row] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, inst.id)).limit(1);
    if (row) inst = row;
  };

  try {
    // Shell-safety gate: everything interpolated into root scripts.
    assertShellSafeHostLike(inst.sshHost ?? "", "مضيف SSH");
    assertShellSafeHostLike(inst.domain ?? "", "الدومين");
    // 1) server check
    await step("1/6 فحص السيرفر");
    await runSsh(`set -e
. /etc/os-release 2>/dev/null || true
echo "OS: \${PRETTY_NAME:-unknown}"
echo "CPU: $(nproc 2>/dev/null || echo ?) cores"
echo "RAM: $(free -m 2>/dev/null | awk '/Mem:/{print $2}' ) MB"
echo "Disk: $(df -h / | tail -1 | awk '{print $4}') free"
[ "$(id -u)" = "0" ] || { echo "ERROR: يجب الدخول بمستخدم root"; exit 1; }
command -v apt-get >/dev/null 2>&1 || { echo "ERROR: يدعم التسطيب التلقائي أوبونتو/ديبيان فقط (apt-get غير موجود)"; exit 1; }
echo ZACOD_CHECK_OK`, "ZACOD_CHECK_OK", 60_000);

    // 2) PostgreSQL + DB creation (only when no DB registered yet)
    await step("2/6 قاعدة البيانات PostgreSQL");
    if (inst.dbUrlEnc) {
      log.push("قاعدة بيانات مسجّلة مسبقًا — تخطّي الإنشاء.");
    } else {
      const dbUser = `zacod_a${inst.id}`;
      const dbName = `zacod_agent_${inst.id}`;
      const dbPass = randomBytes(24).toString("hex");
      await runSsh(`set -e
export DEBIAN_FRONTEND=noninteractive
if ! command -v psql >/dev/null 2>&1; then apt-get update -y >/dev/null; apt-get install -y postgresql >/dev/null; fi
systemctl enable postgresql >/dev/null 2>&1 || true
systemctl start postgresql
PGRUN() { if command -v runuser >/dev/null 2>&1; then runuser -u postgres -- "$@"; else sudo -u postgres "$@"; fi; }
PGHBA=$(PGRUN psql -tAc "SHOW hba_file" | tr -d ' ')
PGRUN psql -qc "ALTER SYSTEM SET listen_addresses = '*'"
PGRUN psql -qc "ALTER SYSTEM SET password_encryption = 'scram-sha-256'"
grep -q "# zacod ${dbUser}$" "$PGHBA" || echo "host ${dbName} ${dbUser} 0.0.0.0/0 scram-sha-256 # zacod ${dbUser}" >> "$PGHBA"
systemctl restart postgresql
PGRUN psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${dbUser}'" | grep -q 1 || PGRUN psql -qc "CREATE ROLE ${dbUser} LOGIN"
PGRUN psql -qc "ALTER ROLE ${dbUser} LOGIN PASSWORD '${dbPass}'"
PGRUN psql -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'" | grep -q 1 || PGRUN createdb -O ${dbUser} ${dbName}
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow 5432/tcp >/dev/null || true; fi
echo ZACOD_DB_READY`, "ZACOD_DB_READY", 300_000);
      // Save the URL centrally, then verify connectivity (retry without TLS
      // if the server has no SSL configured).
      const baseUrl = `postgres://${dbUser}:${dbPass}@${inst.sshHost}:5432/${dbName}`;
      let savedUrl = baseUrl;
      const trySave = async (url: string) => {
        await db.update(agentInstancesTable).set({ dbUrlEnc: encryptSecret(url), dbStatus: "not_configured", dbLastError: null, updatedAt: new Date() })
          .where(eq(agentInstancesTable.id, inst.id));
        clearAgentHostCache();
        const { evictAgentDb } = await import("../lib/agentDb.js");
        evictAgentDb(inst.id);
        await reload();
        await withAgentPool(inst.dbUrlEnc!, (pool) => pool.query("SELECT 1"));
      };
      try { await trySave(baseUrl); }
      catch (e: any) {
        if (/SSL|ssl/.test(String(e?.message ?? ""))) { savedUrl = `${baseUrl}?sslmode=disable`; await trySave(savedUrl); }
        else throw e;
      }
      log.push(`تم إنشاء قاعدة البيانات ${dbName} والمستخدم ${dbUser} وحفظ الرابط مشفّرًا. (${savedUrl.includes("sslmode=disable") ? "بدون تشفير نقل" : "اتصال مشفّر"})`);
    }

    // 3) gateway bootstrap (Caddy + heartbeat) — mode-aware Caddyfile
    await step("3/6 بوابة الدخول والنبض (Caddy)");
    await reload();
    const { installScript } = await buildSetupKit(inst);
    await runSsh(installScript, "ZACOD_BOOTSTRAP_DONE", 300_000);

    // 4) schema init + fingerprint
    await step("4/6 تهيئة قاعدة البيانات (السكيما + البصمة)");
    await reload();
    try {
      await initAgentDatabaseCore(inst);
      log.push("تمت التهيئة وزرع البصمة.");
    } catch (e: any) {
      await markInitDbFailed(inst.id, String(e?.message ?? e).slice(0, 500));
      throw e;
    }

    // 5) full edition: the app itself
    if (inst.mode === "full") {
      await step("5/6 تثبيت التطبيق (نسخة كاملة)");
      await reload();
      const origin = resolveCentralOrigin();
      // The app runs ON the DB server — connect via loopback (no network
      // round-trip, no TLS dependency), while central keeps the public URL.
      const storedDbUrl = decryptSecret(inst.dbUrlEnc!) ?? "";
      assertShellSafeDbUrl(storedDbUrl);
      let localDbUrl = storedDbUrl;
      try {
        const u = new URL(storedDbUrl);
        if (u.hostname === inst.sshHost) { u.hostname = "127.0.0.1"; u.searchParams.delete("sslmode"); localDbUrl = u.toString().replace(/\?$/, ""); }
      } catch { /* keep stored URL as-is */ }
      assertShellSafeDbUrl(localDbUrl);
      const q = `installationId=${encodeURIComponent(inst.installationId)}&licenseKey=${encodeURIComponent(inst.licenseKey ?? "")}`;
      const manifestUrl = `${origin}/api/agent/release/manifest?${q}`;
      const bundleUrl = `${origin}/api/agent/release/bundle?${q}`;
      // Warm the bundle cache before the agent curls it.
      const { getReleaseInfo } = await import("../lib/agentRelease.js");
      const rel = await getReleaseInfo();
      log.push(`إصدار الحزمة: ${rel.version} (${Math.round(rel.sizeBytes / 1024 / 1024)}MB)`);
      const updater = `#!/usr/bin/env bash
set -e
[ -f /opt/zacod/SUSPENDED ] && exit 0
MAN=$(curl -fsS ${shQ(manifestUrl)}) || exit 0
VER=$(echo "$MAN" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
CUR=$(cat /opt/zacod/app/VERSION 2>/dev/null || echo none)
{ [ -n "$VER" ] && [ "$VER" != "$CUR" ]; } || exit 0
curl -fsSL ${shQ(bundleUrl)} -o /tmp/zacod-app.tgz
rm -rf /opt/zacod/app.new && mkdir -p /opt/zacod/app.new
tar -xzf /tmp/zacod-app.tgz -C /opt/zacod/app.new
echo "$VER" > /opt/zacod/app.new/VERSION
rm -rf /opt/zacod/app.old; [ -d /opt/zacod/app ] && mv /opt/zacod/app /opt/zacod/app.old; mv /opt/zacod/app.new /opt/zacod/app
systemctl restart zacod-app
`;
      await runSsh(`set -e
export DEBIAN_FRONTEND=noninteractive
NEED_NODE=1
if command -v node >/dev/null 2>&1; then MAJ=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0); [ "$MAJ" -ge 20 ] && NEED_NODE=0; fi
if [ "$NEED_NODE" = "1" ]; then curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null; apt-get install -y nodejs >/dev/null; fi
echo "Node: $(node -v)"
mkdir -p /opt/zacod
curl -fsSL ${shQ(bundleUrl)} -o /tmp/zacod-app.tgz
rm -rf /opt/zacod/app.new && mkdir -p /opt/zacod/app.new
tar -xzf /tmp/zacod-app.tgz -C /opt/zacod/app.new
echo ${shQ(rel.version)} > /opt/zacod/app.new/VERSION
if [ -f /opt/zacod/app.env ] && grep -q '^SESSION_SECRET=' /opt/zacod/app.env; then SS=$(grep '^SESSION_SECRET=' /opt/zacod/app.env | cut -d= -f2-); else SS=$(head -c32 /dev/urandom | od -An -tx1 | tr -d ' \\n'); fi
{ echo "NODE_ENV=production"; echo "PORT=8080"; echo "DATABASE_URL=${localDbUrl}"; echo "SESSION_SECRET=$SS"; echo "PUBLIC_BASE_URL=https://${inst.domain}"; } > /opt/zacod/app.env
chmod 600 /opt/zacod/app.env
rm -rf /opt/zacod/app.old; [ -d /opt/zacod/app ] && mv /opt/zacod/app /opt/zacod/app.old; mv /opt/zacod/app.new /opt/zacod/app
NODE_BIN=$(command -v node)
cat > /etc/systemd/system/zacod-app.service <<EOF
[Unit]
Description=Zacod ERP (full edition)
After=network.target postgresql.service
[Service]
EnvironmentFile=/opt/zacod/app.env
ExecStart=$NODE_BIN --enable-source-maps /opt/zacod/app/index.mjs
WorkingDirectory=/opt/zacod/app
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
cat > /opt/zacod/update.sh <<'ZACOD_UPD'
${updater}
ZACOD_UPD
chmod 700 /opt/zacod/update.sh
( crontab -l 2>/dev/null | grep -v zacod-update ; echo "*/10 * * * * /opt/zacod/update.sh # zacod-update" ) | crontab -
systemctl daemon-reload
systemctl enable zacod-app >/dev/null 2>&1
systemctl restart zacod-app
for i in $(seq 1 12); do sleep 5; CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ || echo 000); [ "$CODE" != "000" ] && break; done
echo "HTTP local: $CODE"
[ "$CODE" != "000" ] || { echo "ERROR: التطبيق لم يستجب محليًا"; journalctl -u zacod-app -n 40 --no-pager 2>/dev/null | tail -40; exit 1; }
echo ZACOD_APP_DONE`, "ZACOD_APP_DONE", 300_000);
    } else {
      await step("5/6 تثبيت التطبيق");
      log.push("النسخة ليست «كاملة» — لا يلزم تثبيت تطبيق محلي (يُخدَم من المنصة المركزية).");
    }

    // 6) final health
    await step("6/6 الفحص النهائي");
    await reload();
    await withAgentPool(inst.dbUrlEnc!, (pool) => pool.query("SELECT 1"));
    log.push("قاعدة البيانات تستجيب. اكتمل التسطيب بنجاح ✔");
    log.push(`تذكير: وجّه دومين ${inst.domain} (سجل A) إلى IP السيرفر ليصدر Caddy شهادة SSL تلقائيًا.`);
    await save("ok");
    await logAgentEvent(inst.id, "provisioned", { mode: inst.mode }, undefined as any);
  } catch (e: any) {
    log.push(`\n✖ فشل التسطيب: ${String(e?.message ?? e).slice(0, 400)}`);
    await save("error");
  }
}

router.post("/:id/provision", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  if (!inst.sshHost || !inst.sshUser || !inst.sshSecretEnc) { res.status(400).json({ error: "أكمل بيانات السيرفر (المضيف والمستخدم وكلمة المرور/المفتاح) أولًا" }); return; }
  try { await assertProbeTargetAllowed(inst.sshHost); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? "عنوان غير مسموح") }); return; }
  // Claim FIRST (atomic — only one provision/deploy runs), then mint the
  // license inside the lease so a concurrent request can't overwrite the key
  // the pipeline is using.
  const staleBefore = new Date(Date.now() - 30 * 60_000);
  const claimed = await db.update(agentInstancesTable)
    .set({ deployStatus: "deploying", deployLog: "بدء التسطيب الكامل…", updatedAt: new Date() })
    .where(and(
      eq(agentInstancesTable.id, id),
      or(ne(agentInstancesTable.deployStatus, "deploying"), lt(agentInstancesTable.updatedAt, staleBefore)),
    )).returning({ id: agentInstancesTable.id });
  if (!claimed.length) { res.status(409).json({ error: "يوجد نشر/تسطيب جارٍ بالفعل" }); return; }
  // Auto-mint a license if missing — zero-step policy (post-claim).
  if (!inst.licenseKey) {
    inst.licenseKey = mintLicenseKey(inst.installationId, inst.domain);
    await db.update(agentInstancesTable).set({ licenseKey: inst.licenseKey, updatedAt: new Date() }).where(eq(agentInstancesTable.id, id));
  }
  // Re-read the claimed row so the pipeline works off fresh state.
  const [fresh] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  await logAgentEvent(id, "provision_started", { by: (req as any).authUser?.username ?? null, mode: inst.mode }, req);
  res.json({ ok: true, started: true });
  void runProvision(fresh ?? inst);
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
  const host = typeof req.query.host === "string" ? normalizeHost(req.query.host) : await resolveAgentRequestHost(req);
  const hit = await lookupAgentByHost(host);
  if (!hit) { res.json({ isAgentDomain: false }); return; }
  res.json({
    isAgentDomain: true,
    suspended: hit.status !== "active",
    brandName: hit.brandName, brandLogoUrl: hit.brandLogoUrl, brandColor: hit.brandColor,
  });
});

// ── Release channel for «full» edition agents ──────────────────────────────
// Authenticated by installationId + licenseKey (same trust model as the
// heartbeat). Suspended/expired agents get 403 — the kill-switch also stops
// updates.
async function authReleaseRequest(req: any, res: any): Promise<typeof agentInstancesTable.$inferSelect | null> {
  const installationId = typeof req.query.installationId === "string" ? req.query.installationId : "";
  const licenseKey = typeof req.query.licenseKey === "string" ? req.query.licenseKey : "";
  if (!installationId || !licenseKey) { res.status(400).json({ error: "bad_request" }); return null; }
  const [inst] = await db.select().from(agentInstancesTable)
    .where(eq(agentInstancesTable.installationId, installationId)).limit(1);
  if (!inst || !inst.licenseKey || inst.licenseKey !== licenseKey) {
    await logAgentEvent(inst?.id ?? null, "release_auth_failed", { installationId: installationId.slice(0, 64) }, req);
    res.status(403).json({ error: "forbidden" }); return null;
  }
  if (inst.mode !== "full") { res.status(403).json({ error: "not_full_edition" }); return null; }
  if (inst.status !== "active") { res.status(403).json({ error: "suspended" }); return null; }
  if (inst.licenseExpiresAt && new Date(inst.licenseExpiresAt) < new Date()) { res.status(403).json({ error: "license_expired" }); return null; }
  return inst;
}

agentPublicRouter.get("/agent/release/manifest", async (req, res) => {
  const inst = await authReleaseRequest(req, res);
  if (!inst) return;
  try {
    const { getReleaseInfo } = await import("../lib/agentRelease.js");
    const rel = await getReleaseInfo();
    res.json({ version: rel.version, sizeBytes: rel.sizeBytes });
  } catch (e: any) { res.status(503).json({ error: String(e?.message ?? e).slice(0, 200) }); }
});

agentPublicRouter.get("/agent/release/bundle", async (req, res) => {
  const inst = await authReleaseRequest(req, res);
  if (!inst) return;
  try {
    const { getReleaseInfo } = await import("../lib/agentRelease.js");
    const rel = await getReleaseInfo();
    await logAgentEvent(inst.id, "release_downloaded", { version: rel.version }, req);
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="zacod-app-${rel.version}.tgz"`);
    res.sendFile(rel.tarPath);
  } catch (e: any) { res.status(503).json({ error: String(e?.message ?? e).slice(0, 200) }); }
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
