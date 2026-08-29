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

import express, { Router, type Request } from "express";
import fs from "node:fs";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { pbkdf2Sync, createCipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
// Control-plane module: ALL registry reads/writes here must hit the CENTRAL
// DB even when the request is running inside an agent-DB ALS context (an
// agent's cloned DB has an empty registry — following the proxy would
// silently disable suspend/register-block enforcement).
import { centralDb as db } from "@workspace/db";
import {
  agentInstancesTable, agentSecurityEventsTable, agentServersTable, agentInvoiceSamplesTable,
  agentPlatformLinkInvitesTable, agentControllerLinksTable,
  companiesTable, zatcaRegistrationTransfersTable,
} from "@workspace/db";
import { eq, desc, and, or, ne, lt, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { PgPool, type PgPoolType } from "@workspace/db";
import net from "node:net";
import { request as httpsRequest } from "node:https";
import { extractAuth } from "../middleware/auth.js";
import { normalizeHost } from "../middleware/domainResolver.js";
import { encryptSecret, decryptSecret } from "../lib/encryption.js";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  isManualAgentReleaseRequest,
  resolveAgentReleaseCredentials,
  stripAgentReleaseCredentialsFromUrl,
  buildCustomAgentReleaseUrl,
} from "../lib/agentReleasePolicy.js";
import {
  EXTERNAL_PACKAGE_KINDS,
  type ExternalPackageEntry,
  type ExternalPackageKind,
  type ExternalPackageMap,
  buildAgentDatabaseDump,
  buildFrontendArchive,
  createDirectUploadTarget,
  encryptLocalFileToPrivateObject,
  inspectPlainPackagePath,
  packageFileExists,
  packageObjectKey,
  packageSignature,
  privateFileForObjectPath,
  promoteStagedUploadToEncryptedPackage,
  removeAllAgentPackageObjects,
  removePackageObject,
  streamPrivatePackage,
  sweepStalePackageUploads,
  verifyEncryptedPackageObject,
  verifyPackageEntry,
} from "../lib/agentExternalPackages.js";
import {
  effectiveLocalSuperadminEnabled,
  LOCAL_SUPERADMIN_SCREEN_IDS,
  normalizeLocalSuperadminScreens,
  readLocalAgentRuntimeState,
  validateAgentLocalSuperadmin,
  validateLocalSuperadminScreenSelection,
} from "../lib/localAgentSuperadmin.js";
import {
  CfDnsError,
  applyCloudflareARecord,
  isCloudflareDnsConfigured,
  planCloudflareARecord,
  updateCloudflareProxy,
  validatePublicIpv4,
  type AppliedRecord,
  type CloudflareARecordPlan,
} from "../lib/cloudflareDns.js";
import {
  type InvoiceAccelerationMode,
  computeSampleStats,
  captureInvoiceAccelerationRequestGeneration,
  _logCentralEvent,
} from "../lib/agentInvoiceAcceleration.js";
import { logger } from "../lib/logger.js";
import {
  assertZatcaSubmissionAllowed, chooseZatcaChain, credentialFingerprint, decryptTransferEnvelope,
  encryptTransferEnvelope, normalizeVat, resolveZatcaChain, transferBinding,
  withZatcaChainLock, mayCompleteExpiredTransfer, hasActivatedTransferBinding,
  completionChainAllowed, type ZatcaTransferEnvelope,
} from "../lib/zatcaRegistrationTransfer.js";
import { sanitizeSchemaDumpForExternalAgent } from "../lib/agentExternalSchema.js";
import {
  assertMonotonicEpoch,
  assertStoredInviteUsable,
  buildControllerLinkFile,
  constantTimeHexEqual,
  createPlatformLinkInvite,
  deriveControllerToken,
  highestControllerState,
  licenseKeyVerifier,
  normalizeHttpsOrigin,
  platformId,
  sha256Verifier,
  validateInvite,
  verifyControllerLinkFile,
} from "../lib/agentControllerLinks.js";

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
  id: number; domain: string; status: string; dbStatus: string; dbUrlEnc: string | null;
  brandName: string | null; brandLogoUrl: string | null; brandColor: string | null;
  proxyToken: string | null; // decrypted per-agent proxy secret (null = not issued)
  accelerationMode: InvoiceAccelerationMode; // snapshotted per request
  // Trial start boundary — the invoiceAccelerationUpdatedAt value when mode=trial.
  // Used by the recorder to guard auto-transitions against races.
  trialStartAt: Date | null;
  controlGeneration: number;
} | null;
const hostCache = new Map<string, { hit: AgentHostHit; expires: number }>();

export function clearAgentHostCache(): void { hostCache.clear(); }

function liveCachedAgentHit(host: string | null): AgentHostHit {
  if (!host) return null;
  const cached = hostCache.get(host);
  return cached && cached.expires > Date.now() ? cached.hit : null;
}

/**
 * Synchronous entry peek used only to place the active-request generation
 * fence before the router's first await. Claimed proxy headers are trusted only
 * after the same constant-time token check as resolveAgentRequestHost().
 */
function peekCachedAgentHitAtRequestEntry(req: Request): AgentHostHit {
  const claimed = req.headers["x-zacod-agent-host"];
  const token = req.headers["x-zacod-agent-token"];
  if (typeof claimed === "string" && typeof token === "string" && token.length >= 32) {
    const claimedHit = liveCachedAgentHit(normalizeHost(claimed));
    const expected = claimedHit?.proxyToken;
    if (expected) {
      try {
        const a = Buffer.from(token); const b = Buffer.from(expected);
        if (a.length === b.length && timingSafeEqual(a, b)) return claimedHit;
      } catch { /* use standard host below */ }
    }
  }
  const fwd = req.headers["x-forwarded-host"];
  const standardHost = normalizeHost((Array.isArray(fwd) ? fwd[0] : fwd) || req.headers.host);
  return liveCachedAgentHit(standardHost);
}

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
      invoiceAccelerationMode: agentInstancesTable.invoiceAccelerationMode,
      invoiceAccelerationUpdatedAt: agentInstancesTable.invoiceAccelerationUpdatedAt,
      invoiceAccelerationGeneration: agentInstancesTable.invoiceAccelerationGeneration,
    }).from(agentInstancesTable);
    for (const r of rows) {
      const extras = Array.isArray(r.extraDomains) ? (r.extraDomains as string[]) : [];
      if (r.domain === host || extras.includes(host)) {
        const mode = (r.invoiceAccelerationMode ?? "off") as InvoiceAccelerationMode;
        hit = {
          id: r.id, domain: r.domain, status: r.status, dbStatus: r.dbStatus, dbUrlEnc: r.dbUrlEnc,
          brandName: r.brandName, brandLogoUrl: r.brandLogoUrl, brandColor: r.brandColor,
          proxyToken: r.proxySecretEnc ? decryptSecret(r.proxySecretEnc) : null,
          accelerationMode: mode,
          trialStartAt: mode === "trial" ? (r.invoiceAccelerationUpdatedAt ?? null) : null,
          controlGeneration: r.invoiceAccelerationGeneration ?? 0,
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
          if (a.length === b.length && timingSafeEqual(a, b)) {
            (req as any).verifiedAgentProxyIdentity = { agentId: hit!.id, host: h };
            return h;
          }
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

// ── Per-agent, per-boot schema readiness ─────────────────────────────────
// Keyed by agent id + ctx identity so a rotated DB URL (new pool/context)
// re-heals. Requests MUST NOT run against the external DB while this pass is
// pending: new central code can reference a column that the shell agent DB
// does not have yet. Concurrent requests share one flight; failed flights are
// removed so the next request can retry.
type AgentSchemaHealResult =
  | { ok: true }
  | { ok: false; error: string };
const agentHealDone = new Map<number, { ctx: unknown; promise: Promise<AgentSchemaHealResult> }>();
type AgentDbContext = { db: unknown; pool: unknown };
type ExternalDbRunner = (c: any, fn: () => any) => any;
type AgentSchemaHealRunner = () => Promise<void> | void;

export function startAgentSchemaHeal(
  agentId: number,
  ctx: AgentDbContext,
  runWithExternalDb: ExternalDbRunner,
  healRunner?: AgentSchemaHealRunner,
): Promise<AgentSchemaHealResult> {
  const prev = agentHealDone.get(agentId);
  if (prev && prev.ctx === ctx) return prev.promise;
  const promise = (async () => {
    try {
      const runSchemaHealOnActiveDb = healRunner
        ?? (await import("../lib/ensureSchema.js")).runAgentRequestSchemaHealOnActiveDb;
      await runWithExternalDb(ctx, () => runSchemaHealOnActiveDb());
      return { ok: true } as const;
    } catch (e) {
      const error = String((e as any)?.message ?? e).slice(0, 500);
      void logAgentEvent(agentId, "schema_heal_failed", { error });
      return { ok: false, error } as const;
    }
  })();
  agentHealDone.set(agentId, { ctx, promise });
  void promise.then((result) => {
    if (result.ok) return;
    // Retry on the next request, but never let an older failed flight remove
    // a newer context's entry after the agent DB URL rotates.
    if (agentHealDone.get(agentId)?.promise === promise) {
      agentHealDone.delete(agentId);
    }
  });
  return promise;
}

const AGENT_SCHEMA_REQUEST_WAIT_MS = (() => {
  const n = Number(process.env.AGENT_SCHEMA_REQUEST_WAIT_MS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 12_000;
})();

export async function serveAgentRequestAfterSchemaReady(
  agentId: number,
  ctx: AgentDbContext,
  runWithExternalDb: ExternalDbRunner,
  res: {
    setHeader(name: string, value: string): void;
    status(code: number): { json(body: unknown): void };
  },
  next: (err?: unknown) => void,
  healRunner?: AgentSchemaHealRunner,
  waitMs = AGENT_SCHEMA_REQUEST_WAIT_MS,
): Promise<void> {
  const heal = startAgentSchemaHeal(agentId, ctx, runWithExternalDb, healRunner);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    heal,
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), waitMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (result === "timeout") {
    res.setHeader("Retry-After", "3");
    res.status(503).json({
      error: "جاري تجهيز قاعدة بيانات الشركة للإصدار الجديد — أعد المحاولة خلال لحظات",
      code: "AGENT_SCHEMA_PREPARING",
      agentSchemaPreparing: true,
      retryAfterSeconds: 3,
    });
    return;
  }
  if (!result.ok) {
    res.setHeader("Retry-After", "5");
    res.status(503).json({
      error: "تعذّر تجهيز قاعدة بيانات الشركة بأمان — لم يُنفّذ الطلب",
      code: "AGENT_SCHEMA_FAILED",
      agentSchemaFailed: true,
      retryAfterSeconds: 5,
    });
    return;
  }
  runWithExternalDb(ctx, () => next());
}

export async function agentDataSourceRouter(req: Request, res: any, next: (err?: unknown) => void): Promise<void> {
  try {
    const entryHit = peekCachedAgentHitAtRequestEntry(req);
    // For the normal cached-host path this is deliberately the FIRST await in
    // the middleware. A manual Off UPDATE and this FOR SHARE read therefore
    // have one authoritative row-lock order before host/auth/schema awaits.
    const entryGeneration =
      entryHit && (entryHit.accelerationMode === "trial" || entryHit.accelerationMode === "on")
        ? await captureInvoiceAccelerationRequestGeneration(entryHit.id)
        : null;
    const host = await resolveAgentRequestHost(req);
    const hit = await lookupAgentByHost(host);
    if (!hit) { next(); return; }
    const accelerationRequestGeneration = hit.accelerationMode === "trial" || hit.accelerationMode === "on"
      ? entryHit?.id === hit.id && entryGeneration !== null
        ? entryGeneration
        // Cache miss: lookupAgentByHost's first central SELECT is the request
        // boundary and returns mode+generation from one MVCC row snapshot.
        : hit.controlGeneration
      : null;
    // Stamp the request so downstream guards (e.g. superadmin-panel block)
    // can tell it arrived via a registered agent domain. Acceleration mode and
    // trial start boundary are snapshotted here so all handlers in the chain
    // see consistent values regardless of concurrent mode transitions.
    (req as any).agentDomainHit = {
      id: hit.id,
      domain: hit.domain,
      accelerationMode: hit.accelerationMode,
      trialStartAt: hit.trialStartAt,
      accelerationRequestGeneration,
    };
    if (AGENT_PUBLIC_PATHS.some(p => req.path === p || req.path.startsWith(p + "/"))) { next(); return; }
    if (hit.status !== "active") {
      res.status(403).json({ error: "هذه النسخة موقوفة — تواصل مع مزوّد النظام", agentSuspended: true });
      return;
    }
    if (hit.dbStatus === "initialized" && hit.dbUrlEnc) {
      const { getAgentDbContext } = await import("../lib/agentDb.js");
      const ctx = getAgentDbContext(hit.id, hit.dbUrlEnc);
      const { runWithExternalDb } = await import("@workspace/db");
      // ── Schema readiness gate (once per agent per server boot) ──────
      // Central deploys add columns/enums the agent DB doesn't have yet;
      // previously the agent DB was only reconciled during the privileged
      // init/تهيئة flow, so every central schema addition broke agent-domain
      // requests (e.g. login 500) until a manual re-init. Never let a request
      // race the additive reconciliation: wait briefly, then return a
      // retryable 503 without executing the downstream query or mutation.
      // This touches ONLY schema — it never reads or writes zacod_installation,
      // the fingerprint, or any encrypted material, so identity/fingerprint
      // guarantees are untouched.
      await serveAgentRequestAfterSchemaReady(hit.id, ctx, runWithExternalDb, res, next);
      return;
    }
    // Fail-closed: ANY accelerated mode (trial OR on) without a working
    // external DB must NEVER fall through to the central DB. This protects
    // the invariant that accelerated requests always hit the agent's own DB.
    if (hit.accelerationMode === "on" || hit.accelerationMode === "trial") {
      logger.warn({
        agentId: hit.id,
        accelerationMode: hit.accelerationMode,
        dbStatus: hit.dbStatus,
        hasDbUrl: !!hit.dbUrlEnc,
      }, "agentDataSourceRouter: accelerated mode but agent DB not initialized — failing closed");
      res.status(503).json({
        error: "تسريع الفاتورة مفعّل لكن قاعدة بيانات الوكيل غير مهيّأة — يرجى تعطيل التسريع أو إعادة تهيئة قاعدة البيانات",
        code: "ACCELERATION_DB_NOT_INITIALIZED",
      });
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
  const {
    dbUrlEnc, sshSecretEnc, proxySecretEnc, saPasswordEnc, sshHostKeyFp: _fp,
    externalPackageMeta, autoDomainZoneId: _autoZoneId,
    autoDomainRecordId: _autoRecordId, autoDomainLeaseAt: _autoLeaseAt,
    deployLeaseId: _deployLeaseId, deployOperationPhase: _deployOperationPhase,
    deployProviderMutationUntil: _deployProviderMutationUntil,
    invoiceAccelerationBaseline: _invoiceAccelerationBaseline,
    invoiceAccelerationGeneration: _invoiceAccelerationGeneration,
    ...rest
  } = r as any;
  // Secrets are STRICTLY write-only: only boolean presence flags leave the
  // server — never the ciphertext and never any plaintext fragment.
  return {
    ...rest,
    operationKind: typeof r.deployOperationPhase === "string" && r.deployOperationPhase.startsWith("schema_")
      ? "schema"
      : r.deployStatus === "deploying" ? "provision" : null,
    localSuperadminEnabled: effectiveLocalSuperadminEnabled(r.mode, r.localSuperadminEnabled),
    localSuperadminScreens: effectiveLocalSuperadminEnabled(r.mode, r.localSuperadminEnabled)
      ? normalizeLocalSuperadminScreens(r.localSuperadminScreens)
      : [],
    dbUrlSet: !!dbUrlEnc,
    sshSecretSet: !!sshSecretEnc,
    proxyTokenSet: !!proxySecretEnc,
    saPasswordSet: !!saPasswordEnc,
    cloudflareConnected: !!(process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN),
    externalPackage: publicPackageMap(readPackageMap(externalPackageMeta)),
    // Safe acceleration metadata — never exposes secrets.
    invoiceAccelerationMode:      r.invoiceAccelerationMode ?? "off",
    invoiceTrialRemaining:        r.invoiceTrialRemaining ?? null,
    invoiceAccelerationLastError: r.invoiceAccelerationLastError ?? null,
    invoiceAccelerationReason:    r.invoiceAccelerationReason ?? null,
    invoiceAccelerationUpdatedAt: r.invoiceAccelerationUpdatedAt ?? null,
  };
}

function readPackageMap(value: unknown): ExternalPackageMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as ExternalPackageMap;
}

function publicPackageMap(meta: ExternalPackageMap): Record<ExternalPackageKind, Omit<ExternalPackageEntry, "objectPath" | "signature"> | null> {
  const out = {} as Record<ExternalPackageKind, Omit<ExternalPackageEntry, "objectPath" | "signature"> | null>;
  for (const kind of EXTERNAL_PACKAGE_KINDS) {
    const entry = meta[kind];
    if (!entry) { out[kind] = null; continue; }
    const { objectPath: _objectPath, signature: _signature, ...safe } = entry;
    out[kind] = safe;
  }
  return out;
}

// ── ZATCA registration hand-off (central SuperAdmin only) ──────────────────
// The browser receives status/presence booleans only.  Credentials remain in
// the encrypted central envelope and are written directly to the target DB.
const zatcaTransferInput = z.object({
  sourceCompanyId: z.number().int().positive(),
  targetCompanyId: z.number().int().positive(),
});
const transferCredentialFields = [
  "zatcaPrivateKey", "zatcaCsr", "zatcaCsid", "zatcaPcsid",
  "zatcaCsidToken", "zatcaCsidSecret", "zatcaPcsidToken", "zatcaPcsidSecret",
] as const;
function companyTransferCredentials(c: any): Record<string, string> {
  return Object.fromEntries(transferCredentialFields.flatMap(k => typeof c?.[k] === "string" && c[k] ? [[k, c[k]]] : []));
}
function hasCompleteTransferCredentials(c: any): boolean {
  const x = companyTransferCredentials(c);
  return !!x.zatcaPrivateKey && !!(x.zatcaPcsidToken || x.zatcaCsidToken) && !!(x.zatcaPcsidSecret || x.zatcaCsidSecret);
}
async function targetChain(ctx: any, companyId: number): Promise<{ maxIcv: number; previousInvoiceHash: string }> {
  const seed = await ctx.db.select({ icv: companiesTable.zatcaChainSeedIcv, pih: companiesTable.zatcaChainSeedPih })
    .from(companiesTable).where(eq(companiesTable.id, companyId));
  const q = await ctx.db.execute(sql`SELECT zatca_icv AS icv, invoice_hash AS hash FROM (
    SELECT zatca_icv, invoice_hash, id, 1 AS source_rank FROM sales_invoices WHERE company_id=${companyId} AND zatca_status IN ('cleared','reported')
    UNION ALL SELECT zatca_icv, invoice_hash, id, 0 AS source_rank FROM sales_returns WHERE company_id=${companyId} AND zatca_status IN ('cleared','reported')
  ) c WHERE zatca_icv IS NOT NULL ORDER BY zatca_icv DESC, id DESC, source_rank DESC LIMIT 1`);
  const row = ((q as any).rows ?? q as any)[0];
  return chooseZatcaChain(seed[0] ?? {}, row);
}
async function inspectTransferAgent(agentId: number) {
  const [agent] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, agentId));
  if (!agent || agent.dbStatus !== "initialized" || !agent.dbUrlEnc || !agent.dbFingerprint) throw Object.assign(new Error("قاعدة بيانات الوكيل غير مهيأة"), { httpStatus: 409 });
  const { getAgentDbContext } = await import("../lib/agentDb.js");
  const ctx = getAgentDbContext(agent.id, agent.dbUrlEnc);
  const { runWithExternalDb } = await import("@workspace/db");
  const healed = await startAgentSchemaHeal(agent.id, ctx, runWithExternalDb);
  if (!healed.ok) {
    throw Object.assign(new Error("تعذّر تجهيز مخطط قاعدة بيانات الوكيل للنقل بأمان"), { httpStatus: 503 });
  }
  const identity = await ctx.pool.query("SELECT installation_id, fingerprint FROM zacod_installation WHERE id = 1");
  const found = identity.rows[0];
  if (!found || found.installation_id !== agent.installationId || found.fingerprint !== agent.dbFingerprint) throw Object.assign(new Error("تعذّر التحقق من هوية قاعدة بيانات الوكيل"), { httpStatus: 409 });
  return { agent, ctx };
}
async function inspectTransferTarget(agentId: number, targetCompanyId: number) {
  const { agent, ctx } = await inspectTransferAgent(agentId);
  const [company] = await (ctx.db as any).select().from(companiesTable).where(eq(companiesTable.id, targetCompanyId));
  if (!company) throw Object.assign(new Error("شركة الهدف غير موجودة"), { httpStatus: 404 });
  return { agent, ctx, company };
}
async function transferPreflight(agentId: number, sourceCompanyId: number, targetCompanyId: number) {
  const [source] = await db.select().from(companiesTable).where(eq(companiesTable.id, sourceCompanyId));
  if (!source) throw Object.assign(new Error("شركة المصدر غير موجودة"), { httpStatus: 404 });
  await assertZatcaSubmissionAllowed(sourceCompanyId);
  if (!hasCompleteTransferCredentials(source)) throw Object.assign(new Error("بيانات ZATCA للمصدر غير مكتملة"), { httpStatus: 422 });
  const target = await inspectTransferTarget(agentId, targetCompanyId);
  if ((target.company.zatcaTransferState ?? "active") !== "active") throw Object.assign(new Error("شركة الهدف مجمّدة أو مرتبطة بنقل آخر"), { httpStatus: 409 });
  if (normalizeVat(source.vatNumber) !== normalizeVat(target.company.vatNumber) ||
      (source.zatcaEnvironment ?? "") !== (target.company.zatcaEnvironment ?? "")) throw Object.assign(new Error("رقم ضريبة القيمة المضافة أو البيئة لا يطابقان"), { httpStatus: 422 });
  const sourceChain = await resolveZatcaChain(sourceCompanyId);
  const targetState = await targetChain(target.ctx, targetCompanyId);
  // Sales sends are synchronous in this deployment. `pending` is the normal
  // never-submitted state and deliberately must not block a transfer; the
  // advisory lock is the in-flight submission fence.  No durable ZATCA queue
  // is present in the application schema (the optional integration queue is
  // unrelated), so there is no additional queued-send state to inspect.
  const targetCredentials = companyTransferCredentials(target.company);
  const sameCredentials = !Object.keys(targetCredentials).length || credentialFingerprint(targetCredentials) === credentialFingerprint(companyTransferCredentials(source));
  if (!sameCredentials) throw Object.assign(new Error("شركة الهدف لديها تسجيل ZATCA مختلف"), { httpStatus: 409 });
  if (targetState.maxIcv !== 0 && (targetState.maxIcv !== sourceChain.maxIcv || targetState.previousInvoiceHash !== sourceChain.previousInvoiceHash)) throw Object.assign(new Error("سلسلة ZATCA للهدف لا تطابق المصدر"), { httpStatus: 409 });
  return { source, target, sourceChain, sameCredentials };
}

function packageMapSigned(agentId: number, meta: ExternalPackageMap, requireAll: boolean): boolean {
  const required = requireAll ? EXTERNAL_PACKAGE_KINDS : (["backend"] as const);
  return required.every(kind => {
    const entry = meta[kind];
    return !!entry && verifyPackageEntry(agentId, kind, entry);
  });
}

async function packageMapAvailable(agentId: number, meta: ExternalPackageMap, requireAll: boolean): Promise<boolean> {
  if (!packageMapSigned(agentId, meta, requireAll)) return false;
  const required = requireAll ? EXTERNAL_PACKAGE_KINDS : (["backend"] as const);
  return (await Promise.all(required.map(kind => packageFileExists(meta[kind]!)))).every(Boolean);
}

async function replacePackageEntry(agentId: number, kind: ExternalPackageKind, entry: ExternalPackageEntry | null): Promise<ExternalPackageEntry | null> {
  return db.transaction(async tx => {
    const [row] = await tx.select({ externalPackageMeta: agentInstancesTable.externalPackageMeta })
      .from(agentInstancesTable)
      .where(eq(agentInstancesTable.id, agentId))
      .for("update")
      .limit(1);
    if (!row) throw Object.assign(new Error("غير موجود"), { httpStatus: 404 });
    const meta = readPackageMap(row.externalPackageMeta);
    const previous = meta[kind] ?? null;
    if (entry) meta[kind] = entry;
    else delete meta[kind];
    await tx.update(agentInstancesTable).set({ externalPackageMeta: meta, updatedAt: new Date() })
      .where(eq(agentInstancesTable.id, agentId));
    return previous;
  });
}

async function replacePackageMap(agentId: number, next: ExternalPackageMap): Promise<ExternalPackageMap> {
  return db.transaction(async tx => {
    const [row] = await tx.select({ externalPackageMeta: agentInstancesTable.externalPackageMeta })
      .from(agentInstancesTable)
      .where(eq(agentInstancesTable.id, agentId))
      .for("update")
      .limit(1);
    if (!row) throw Object.assign(new Error("غير موجود"), { httpStatus: 404 });
    const previous = readPackageMap(row.externalPackageMeta);
    await tx.update(agentInstancesTable).set({ externalPackageMeta: next, updatedAt: new Date() })
      .where(eq(agentInstancesTable.id, agentId));
    return previous;
  });
}

// GET /api/admin/agent-instances
router.get("/", async (_req, res) => {
  const rows = await db.select().from(agentInstancesTable).orderBy(desc(agentInstancesTable.id)).limit(500);
  res.json(rows.map(publicRow));
});

router.get("/:agentId/zatca-transfer/companies", async (req, res) => {
  try {
    const agentId = Number(req.params.agentId);
    const { ctx } = await inspectTransferAgent(agentId);
    const targets = await (ctx.db as any).select().from(companiesTable).orderBy(companiesTable.id);
    const source = await db.select().from(companiesTable).orderBy(companiesTable.id);
    res.json({
      sourceCompanies: source.map(x => ({ id: x.id, nameAr: x.nameAr, vatNumber: x.vatNumber, environment: x.zatcaEnvironment, transferState: x.zatcaTransferState, credentialsSet: hasCompleteTransferCredentials(x) })),
      targetCompanies: targets.map((x: any) => ({ id: x.id, nameAr: x.nameAr, vatNumber: x.vatNumber, environment: x.zatcaEnvironment, transferState: x.zatcaTransferState, credentialsSet: Object.keys(companyTransferCredentials(x)).length > 0 })),
    });
  } catch (e: any) { res.status(e?.httpStatus ?? 400).json({ error: e?.message ?? "تعذر قراءة حالة النقل" }); }
});
router.get("/:agentId/zatca-transfer/:transferId", async (req, res) => {
  try {
    const transferId = z.string().uuid().parse(req.params.transferId);
    const [row] = await db.select({
      id: zatcaRegistrationTransfersTable.id, sourceCompanyId: zatcaRegistrationTransfersTable.sourceCompanyId,
      targetCompanyId: zatcaRegistrationTransfersTable.targetCompanyId, state: zatcaRegistrationTransfersTable.state,
      expiresAt: zatcaRegistrationTransfersTable.expiresAt, consumedAt: zatcaRegistrationTransfersTable.consumedAt,
      completedAt: zatcaRegistrationTransfersTable.completedAt, cancelledAt: zatcaRegistrationTransfersTable.cancelledAt,
    }).from(zatcaRegistrationTransfersTable).where(and(eq(zatcaRegistrationTransfersTable.id, transferId), eq(zatcaRegistrationTransfersTable.targetAgentId, Number(req.params.agentId))));
    if (!row) { res.status(404).json({ error: "طلب النقل غير موجود" }); return; }
    res.json({ ...row, payloadPresent: row.state === "prepared" && !row.consumedAt && !row.cancelledAt });
  } catch (e: any) { res.status(400).json({ error: e?.message ?? "معرّف نقل غير صالح" }); }
});
router.post("/:agentId/zatca-transfer/preflight", async (req, res) => {
  try {
    const input = zatcaTransferInput.parse(req.body);
    const r = await transferPreflight(Number(req.params.agentId), input.sourceCompanyId, input.targetCompanyId);
    await logAgentEvent(r.target.agent.id, "zatca_transfer_preflight", { sourceCompanyId: input.sourceCompanyId, targetCompanyId: input.targetCompanyId }, req);
    res.json({ ok: true, sourceCredentialsSet: true, targetCredentialsSameOrEmpty: r.sameCredentials, chainReady: true });
  } catch (e: any) { res.status(e?.httpStatus ?? 422).json({ ok: false, error: e?.message ?? "فشل الفحص المسبق" }); }
});
router.post("/:agentId/zatca-transfer/prepare", async (req, res) => {
  try {
    const input = zatcaTransferInput.parse(req.body); const actor = (req as any).authUser?.id ?? null;
    const result = await withZatcaChainLock(input.sourceCompanyId, async () => {
      const r = await transferPreflight(Number(req.params.agentId), input.sourceCompanyId, input.targetCompanyId);
      const id = randomUUID(); const expiresAt = new Date(Date.now() + 10 * 60_000);
      const targetRef = { agentId: r.target.agent.id, installationId: r.target.agent.installationId, dbFingerprint: r.target.agent.dbFingerprint!, companyId: input.targetCompanyId };
      const envelope: ZatcaTransferEnvelope = {
        version: 1, sourceCompanyId: input.sourceCompanyId, vatNumber: normalizeVat(r.source.vatNumber),
        environment: r.source.zatcaEnvironment ?? "", target: targetRef, credentials: companyTransferCredentials(r.source),
        chain: { icv: r.sourceChain.maxIcv, pih: r.sourceChain.previousInvoiceHash }, nonce: randomUUID(),
        issuedAt: new Date().toISOString(), expiresAt: expiresAt.toISOString(),
      };
      const payloadEnc = JSON.stringify(encryptTransferEnvelope(envelope));
      const binding = transferBinding(targetRef);
      // Deterministic cross-database lock order: central source, then external
      // target. Both remain held until source row + transfer record commit.
      await withZatcaChainLock(input.targetCompanyId, async () => {
        const fresh = await inspectTransferTarget(r.target.agent.id, input.targetCompanyId);
        const freshCredentials = companyTransferCredentials(fresh.company);
        const freshChain = await targetChain(fresh.ctx, input.targetCompanyId);
        if ((fresh.company.zatcaTransferState ?? "active") !== "active" ||
            normalizeVat(fresh.company.vatNumber) !== envelope.vatNumber ||
            (fresh.company.zatcaEnvironment ?? "") !== envelope.environment ||
            (Object.keys(freshCredentials).length && credentialFingerprint(freshCredentials) !== credentialFingerprint(envelope.credentials)) ||
            (freshChain.maxIcv !== 0 && (freshChain.maxIcv !== envelope.chain.icv || freshChain.previousInvoiceHash !== envelope.chain.pih))) {
          throw Object.assign(new Error("تغيّرت هوية أو بيانات أو سلسلة شركة الهدف"), { httpStatus: 409 });
        }
        await (fresh.ctx.db as any).transaction(async (targetTx: any) => {
          const frozen = await targetTx.update(companiesTable).set({
            zatcaTransferState: "frozen", zatcaTransferId: id,
            zatcaTransferTargetBinding: binding, zatcaTransferLockedAt: new Date(),
          }).where(and(eq(companiesTable.id, input.targetCompanyId), eq(companiesTable.zatcaTransferState, "active"))).returning({ id: companiesTable.id });
          if (frozen.length !== 1) throw Object.assign(new Error("تعذر تجميد شركة الهدف بأمان"), { httpStatus: 409 });
        });
        try {
          await db.transaction(async tx => {
            await tx.update(companiesTable).set({ zatcaTransferState: "frozen", zatcaTransferId: id, zatcaTransferTargetBinding: binding, zatcaTransferLockedAt: new Date() }).where(eq(companiesTable.id, input.sourceCompanyId));
            await tx.insert(zatcaRegistrationTransfersTable).values({ id, sourceCompanyId: input.sourceCompanyId, targetAgentId: r.target.agent.id, targetCompanyId: input.targetCompanyId, targetInstallationId: targetRef.installationId, targetDbFingerprint: targetRef.dbFingerprint, state: "prepared", payloadEnc, payloadHash: credentialFingerprint(envelope.credentials), targetBinding: binding, chainSnapshot: { source: envelope.chain, target: freshChain }, expiresAt, createdByUserId: actor, auditMeta: { preparedBy: actor } });
          });
        } catch (centralError) {
          try {
            const cleared = await (fresh.ctx.db as any).update(companiesTable).set({
              zatcaTransferState: "active", zatcaTransferId: null,
              zatcaTransferTargetBinding: null, zatcaTransferLockedAt: null,
            }).where(and(eq(companiesTable.id, input.targetCompanyId), eq(companiesTable.zatcaTransferId, id), eq(companiesTable.zatcaTransferTargetBinding, binding), eq(companiesTable.zatcaTransferState, "frozen"))).returning({ id: companiesTable.id });
            if (cleared.length !== 1) throw new Error("target compensation binding changed");
          } catch {
            throw Object.assign(new Error("تعذر تأكيد التراجع عن تجميد الهدف؛ بقي الهدف مغلقًا للحماية"), { httpStatus: 503, cause: centralError });
          }
          throw centralError;
        }
      }, r.target.ctx.pool);
      return { id, expiresAt };
    });
    await logAgentEvent(Number(req.params.agentId), "zatca_transfer_prepared", { sourceCompanyId: input.sourceCompanyId, targetCompanyId: input.targetCompanyId, transferId: result.id }, req);
    res.status(201).json({ ok: true, transferId: result.id, expiresAt: result.expiresAt });
  } catch (e: any) { res.status(e?.httpStatus ?? 422).json({ ok: false, error: e?.message ?? "تعذر تجهيز النقل" }); }
});
const transferIdInput = z.object({ transferId: z.string().uuid() });
router.post("/:agentId/zatca-transfer/complete", async (req, res) => {
  try {
    const { transferId } = transferIdInput.parse(req.body); const actor = (req as any).authUser?.id ?? null;
    // Row lock gives one-time consumption semantics.  The target commit happens
    // before central completion; a crash/failure therefore leaves the source
    // frozen (and cancellable) rather than reopening a registration that moved.
    await db.transaction(async tx => {
      const [transfer] = await tx.select().from(zatcaRegistrationTransfersTable).where(eq(zatcaRegistrationTransfersTable.id, transferId)).for("update");
      if (!transfer || transfer.targetAgentId !== Number(req.params.agentId)) throw Object.assign(new Error("طلب النقل غير موجود"), { httpStatus: 404 });
      if (transfer.state !== "prepared" || transfer.consumedAt || transfer.cancelledAt) throw Object.assign(new Error("طلب النقل استُخدم بالفعل"), { httpStatus: 409 });
      const target = await inspectTransferTarget(transfer.targetAgentId, transfer.targetCompanyId);
      const targetRef = { agentId: transfer.targetAgentId, installationId: transfer.targetInstallationId, dbFingerprint: transfer.targetDbFingerprint, companyId: transfer.targetCompanyId };
      const targetAlreadyActive = hasActivatedTransferBinding(target.company, transfer.id, transfer.targetBinding);
      if (!mayCompleteExpiredTransfer(transfer.expiresAt, targetAlreadyActive)) throw Object.assign(new Error("طلب النقل منتهٍ"), { httpStatus: 409 });
      const envelope = decryptTransferEnvelope(JSON.parse(transfer.payloadEnc || "{}"), targetRef, new Date(), targetAlreadyActive);
      const [source] = await tx.select().from(companiesTable).where(eq(companiesTable.id, transfer.sourceCompanyId));
      if (!source || source.zatcaTransferState !== "frozen" || source.zatcaTransferId !== transfer.id ||
          source.zatcaTransferTargetBinding !== transfer.targetBinding) throw Object.assign(new Error("حالة المصدر لا تسمح بإكمال النقل"), { httpStatus: 409 });
      const existing = companyTransferCredentials(target.company);
      if (Object.keys(existing).length && credentialFingerprint(existing) !== credentialFingerprint(envelope.credentials)) throw Object.assign(new Error("شركة الهدف لديها تسجيل مختلف"), { httpStatus: 409 });
      const existingChain = await targetChain(target.ctx, transfer.targetCompanyId);
      if (!targetAlreadyActive && existingChain.maxIcv &&
          (existingChain.maxIcv !== envelope.chain.icv || existingChain.previousInvoiceHash !== envelope.chain.pih)) {
        throw Object.assign(new Error("سلسلة شركة الهدف تغيّرت"), { httpStatus: 409 });
      }
      await withZatcaChainLock(transfer.targetCompanyId, async () => {
        // Re-read under the target's submission lock, then atomically install
        // credentials plus chain seed on that external database.
        const [boundTarget] = await (target.ctx.db as any).select().from(companiesTable).where(eq(companiesTable.id, transfer.targetCompanyId));
        if (!boundTarget || boundTarget.zatcaTransferId !== transfer.id ||
            boundTarget.zatcaTransferTargetBinding !== transfer.targetBinding ||
            !["frozen", "active", "completed"].includes(boundTarget.zatcaTransferState)) {
          throw Object.assign(new Error("ارتباط شركة الهدف بطلب النقل تغيّر"), { httpStatus: 409 });
        }
        const recoveringCommittedActivation = hasActivatedTransferBinding(boundTarget, transfer.id, transfer.targetBinding);
        const lockedCredentials = companyTransferCredentials(boundTarget);
        if ((recoveringCommittedActivation || Object.keys(lockedCredentials).length > 0) &&
            credentialFingerprint(lockedCredentials) !== credentialFingerprint(envelope.credentials)) {
          throw Object.assign(new Error("بيانات تسجيل شركة الهدف تغيّرت"), { httpStatus: 409 });
        }
        const current = await targetChain(target.ctx, transfer.targetCompanyId);
        if (!recoveringCommittedActivation) {
          const emptyTargetChain = current.maxIcv === 0;
          if (!emptyTargetChain && !completionChainAllowed(boundTarget, transfer.id, transfer.targetBinding, current, envelope.chain)) {
            throw Object.assign(new Error("سلسلة شركة الهدف تغيّرت"), { httpStatus: 409 });
          }
          await (target.ctx.db as any).transaction(async (targetTx: any) => {
            const activated = await targetTx.update(companiesTable).set({
              ...envelope.credentials, zatcaChainSeedIcv: envelope.chain.icv, zatcaChainSeedPih: envelope.chain.pih,
              zatcaTransferState: "active", zatcaTransferId: transfer.id, zatcaTransferTargetBinding: transfer.targetBinding,
              zatcaTransferCompletedAt: new Date(),
            }).where(and(eq(companiesTable.id, transfer.targetCompanyId), eq(companiesTable.zatcaTransferId, transfer.id), eq(companiesTable.zatcaTransferTargetBinding, transfer.targetBinding))).returning({ id: companiesTable.id });
            if (activated.length !== 1) throw Object.assign(new Error("فشل تفعيل ارتباط الهدف بشكل مؤكد"), { httpStatus: 409 });
          });
        }
      }, target.ctx.pool);
      await tx.update(zatcaRegistrationTransfersTable).set({ state: "completed", consumedAt: new Date(), completedAt: new Date(), completedByUserId: actor, payloadEnc: null, updatedAt: new Date() }).where(eq(zatcaRegistrationTransfersTable.id, transfer.id));
      await tx.update(companiesTable).set({ zatcaTransferState: "moved", zatcaTransferCompletedAt: new Date() }).where(eq(companiesTable.id, transfer.sourceCompanyId));
    });
    await logAgentEvent(Number(req.params.agentId), "zatca_transfer_completed", { transferId }, req);
    res.json({ ok: true, completed: true });
  } catch (e: any) { res.status(e?.httpStatus ?? 422).json({ ok: false, error: e?.message ?? "تعذر إكمال النقل" }); }
});
router.post("/:agentId/zatca-transfer/cancel", async (req, res) => {
  try {
    const { transferId } = transferIdInput.parse(req.body); const actor = (req as any).authUser?.id ?? null;
    await db.transaction(async tx => {
      const [transfer] = await tx.select().from(zatcaRegistrationTransfersTable).where(eq(zatcaRegistrationTransfersTable.id, transferId)).for("update");
      if (!transfer || transfer.targetAgentId !== Number(req.params.agentId)) throw Object.assign(new Error("طلب النقل غير موجود"), { httpStatus: 404 });
      if (transfer.state !== "prepared" || transfer.consumedAt || transfer.completedAt) throw Object.assign(new Error("لا يمكن إلغاء نقل مكتمل أو مستهلك"), { httpStatus: 409 });
      const [source] = await tx.select().from(companiesTable).where(eq(companiesTable.id, transfer.sourceCompanyId)).for("update");
      if (!source || source.zatcaTransferState !== "frozen" || source.zatcaTransferId !== transfer.id ||
          source.zatcaTransferTargetBinding !== transfer.targetBinding) {
        throw Object.assign(new Error("تغيّر ارتباط المصدر؛ أبقي الطرفان مغلقين للحماية"), { httpStatus: 409 });
      }
      // A target commit can succeed immediately before the central completion
      // write (process crash/network loss). Never cancel in that recovery
      // window: retrying complete is idempotent and is the only safe finalizer.
      const target = await inspectTransferTarget(transfer.targetAgentId, transfer.targetCompanyId);
      if (target.company.zatcaTransferId === transfer.id &&
          (target.company.zatcaTransferState === "active" || target.company.zatcaTransferState === "completed")) {
        throw Object.assign(new Error("تم تفعيل التسجيل في الهدف؛ أعد محاولة الإكمال بدل الإلغاء"), { httpStatus: 409 });
      }
      const snapshots = transfer.chainSnapshot as any;
      const targetSnapshot = snapshots?.target ?? snapshots;
      const targetRef = { agentId: transfer.targetAgentId, installationId: transfer.targetInstallationId, dbFingerprint: transfer.targetDbFingerprint, companyId: transfer.targetCompanyId };
      const envelope = decryptTransferEnvelope(JSON.parse(transfer.payloadEnc || "{}"), targetRef, new Date(), true);
      await withZatcaChainLock(transfer.targetCompanyId, async () => {
        const fresh = await inspectTransferTarget(transfer.targetAgentId, transfer.targetCompanyId);
        const chain = await targetChain(fresh.ctx, transfer.targetCompanyId);
        const currentCredentials = companyTransferCredentials(fresh.company);
        if (fresh.company.zatcaTransferState !== "frozen" ||
            fresh.company.zatcaTransferId !== transfer.id ||
            fresh.company.zatcaTransferTargetBinding !== transfer.targetBinding ||
            (Object.keys(currentCredentials).length > 0 &&
              credentialFingerprint(currentCredentials) !== credentialFingerprint(envelope.credentials)) ||
            chain.maxIcv !== Number(targetSnapshot.maxIcv ?? targetSnapshot.icv) ||
            chain.previousInvoiceHash !== (targetSnapshot.previousInvoiceHash ?? targetSnapshot.pih)) {
          throw Object.assign(new Error("تغيّر ارتباط أو سلسلة الهدف؛ أبقي الطرفان مغلقين للحماية"), { httpStatus: 409 });
        }
        const cleared = await (fresh.ctx.db as any).update(companiesTable).set({
          zatcaTransferState: "active", zatcaTransferId: null,
          zatcaTransferTargetBinding: null, zatcaTransferLockedAt: null,
        }).where(and(eq(companiesTable.id, transfer.targetCompanyId), eq(companiesTable.zatcaTransferId, transfer.id), eq(companiesTable.zatcaTransferTargetBinding, transfer.targetBinding), eq(companiesTable.zatcaTransferState, "frozen"))).returning({ id: companiesTable.id });
        if (cleared.length !== 1) throw Object.assign(new Error("تعذر إلغاء تجميد الهدف بشكل مؤكد"), { httpStatus: 503 });
      }, target.ctx.pool);
      await tx.update(zatcaRegistrationTransfersTable).set({ state: "cancelled", cancelledAt: new Date(), cancelledByUserId: actor, payloadEnc: null, updatedAt: new Date() }).where(eq(zatcaRegistrationTransfersTable.id, transfer.id));
      await tx.update(companiesTable).set({ zatcaTransferState: "active", zatcaTransferId: null, zatcaTransferTargetBinding: null, zatcaTransferLockedAt: null }).where(and(eq(companiesTable.id, transfer.sourceCompanyId), eq(companiesTable.zatcaTransferId, transfer.id)));
    });
    await logAgentEvent(Number(req.params.agentId), "zatca_transfer_cancelled", { transferId }, req);
    res.json({ ok: true, cancelled: true });
  } catch (e: any) { res.status(e?.httpStatus ?? 422).json({ ok: false, error: e?.message ?? "تعذر إلغاء النقل" }); }
});

const upsertSchema = z.object({
  name: z.string().min(2).max(200),
  contactPhone: z.string().max(50).nullish(),
  contactEmail: z.string().max(200).nullish(),
  domain: z.string().min(3).max(255),
  extraDomains: z.array(z.string().min(3).max(255)).max(20).nullish(),
  autoDomainSetup: z.boolean().optional(),
  autoDomainProxyEnabled: z.boolean().optional(),
  mode: z.enum(["frontend_only", "full_shell", "full"]).optional(),
  packageSource: z.enum(["central", "external"]).optional(),
  localSuperadminEnabled: z.boolean().optional(),
  localSuperadminScreens: z.array(z.enum(LOCAL_SUPERADMIN_SCREEN_IDS))
    .max(LOCAL_SUPERADMIN_SCREEN_IDS.length)
    .nullish(),
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
  // بيانات دخول السوبر أدمن للنسخة الكاملة — تُزرع في قاعدة الوكيل عند التسطيب.
  saUsername: z.string().max(64).nullish(),
  saEmail: z.string().max(200).nullish(),
  // write-only: فارغ/غير مُرسل = الإبقاء على الحالية.
  saPassword: z.string().max(200).nullish(),
});

const sshCredentialsSchema = z.object({
  sshHost: z.string().trim().min(1).max(255),
  sshPort: z.number().int().min(1).max(65535),
  sshUser: z.string().trim().min(1).max(100),
  // Write-only. Omit it to keep the currently saved password/key.
  sshSecret: z.string().min(1).max(10000).optional(),
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
  const mode = d.mode ?? "frontend_only";
  const localSuperadminEnabled = effectiveLocalSuperadminEnabled(mode, d.localSuperadminEnabled);
  const localSuperadminScreens = localSuperadminEnabled ? normalizeLocalSuperadminScreens(d.localSuperadminScreens) : [];
  const saErr = validateAgentLocalSuperadmin({
    mode,
    enabled: localSuperadminEnabled,
    username: localSuperadminEnabled ? d.saUsername : null,
    email: localSuperadminEnabled ? d.saEmail : null,
    password: localSuperadminEnabled ? d.saPassword : null,
  });
  if (saErr) { res.status(400).json({ error: saErr }); return; }
  const screenErr = validateLocalSuperadminScreenSelection(localSuperadminEnabled, localSuperadminScreens);
  if (screenErr) { res.status(400).json({ error: screenErr }); return; }
  if (d.packageSource === "external") {
    res.status(400).json({ error: "ارفع ملفات النسخة الخارجية الثلاثة وتحقق منها قبل حفظ نوع النسخة" });
    return;
  }

  const installationId = randomUUID();
  const [row] = await db.insert(agentInstancesTable).values({
    name: d.name, contactPhone: d.contactPhone ?? null, contactEmail: d.contactEmail ?? null,
    domain, extraDomains: extras, mode, packageSource: "central", localSuperadminEnabled, localSuperadminScreens,
    autoDomainSetup: d.autoDomainSetup ?? false,
    autoDomainProxyEnabled: d.autoDomainProxyEnabled ?? false,
    autoDomainStatus: d.autoDomainSetup ? "pending" : "disabled",
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
    saUsername: localSuperadminEnabled ? ((d.saUsername ?? "").trim().toLowerCase() || null) : null,
    saEmail: localSuperadminEnabled ? ((d.saEmail ?? "").trim().toLowerCase() || null) : null,
    saPasswordEnc: localSuperadminEnabled && d.saPassword ? encryptSecret(d.saPassword) : null,
    createdByUserId: (req as any).authUser?.id ?? null,
  }).returning();
  clearAgentHostCache();
  res.status(201).json(publicRow(row));
});

// PUT /api/admin/agent-instances/:id/ssh-credentials
// Save the connection independently from edition/package/Super Admin settings.
// A broken or incomplete unrelated section must never prevent repairing SSH.
router.put("/:id/ssh-credentials", async (req, res) => {
  const id = Number(req.params.id);
  const p = sshCredentialsSchema.safeParse(req.body);
  if (!id || !p.success) {
    const first = p.success ? null : p.error.issues[0];
    res.status(400).json({
      error: first
        ? `بيانات SSH غير صالحة — الحقل: ${first.path?.join(".") || "?"} (${first.message || ""})`
        : "بيانات غير صالحة",
    });
    return;
  }
  const [existing] = await db.select().from(agentInstancesTable)
    .where(eq(agentInstancesTable.id, id)).limit(1);
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.deployStatus === "deploying") {
    res.status(409).json({ error: "لا يمكن تعديل بيانات السيرفر أثناء عملية نشر أو تسطيب جارية" });
    return;
  }
  if (!p.data.sshSecret && !existing.sshSecretEnc) {
    res.status(400).json({ error: "أدخل كلمة المرور أو المفتاح أولًا" });
    return;
  }
  try {
    await assertProbeTargetAllowed(p.data.sshHost);
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? "عنوان غير مسموح") });
    return;
  }

  const targetChanged = p.data.sshHost !== existing.sshHost
    || p.data.sshPort !== (existing.sshPort ?? 22);
  const [row] = await db.update(agentInstancesTable).set({
    sshHost: p.data.sshHost,
    sshPort: p.data.sshPort,
    sshUser: p.data.sshUser,
    ...(p.data.sshSecret ? { sshSecretEnc: encryptSecret(p.data.sshSecret) } : {}),
    ...(targetChanged ? { sshHostKeyFp: null } : {}),
    sshStatus: "not_configured",
    sshLastCheckAt: null,
    updatedAt: new Date(),
  }).where(and(
    eq(agentInstancesTable.id, id),
    ne(agentInstancesTable.deployStatus, "deploying"),
  )).returning();
  if (!row) {
    res.status(409).json({ error: "بدأت عملية أخرى على الوكيل — لم تُحفظ بيانات SSH" });
    return;
  }
  res.json(publicRow(row));
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
  if (existing.deployStatus === "deploying") {
    res.status(409).json({ error: "لا يمكن تعديل بيانات الوكيل أثناء نشر/تسطيب/حذف أو إعداد دومين جارٍ" });
    return;
  }

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
  if (d.autoDomainSetup !== undefined) patch.autoDomainSetup = d.autoDomainSetup;
  if (d.autoDomainProxyEnabled !== undefined) patch.autoDomainProxyEnabled = d.autoDomainProxyEnabled;
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
  const effectiveAutoDomainSetup = d.autoDomainSetup ?? existing.autoDomainSetup;
  const nextDomain = (patch.domain as string | undefined) ?? existing.domain;
  const nextSshHost = d.sshHost !== undefined ? (d.sshHost ?? null) : existing.sshHost;
  const autoTargetChanged = nextDomain !== existing.domain || nextSshHost !== existing.sshHost;
  const autoProxyChanged = d.autoDomainProxyEnabled !== undefined
    && d.autoDomainProxyEnabled !== existing.autoDomainProxyEnabled;
  if (!effectiveAutoDomainSetup) {
    // Disabling automation is deliberately non-destructive: keep provider
    // references so no DNS record is removed or changed behind the admin.
    patch.autoDomainStatus = "disabled";
    patch.autoDomainLastError = null;
  } else if (!existing.autoDomainSetup || autoTargetChanged || autoProxyChanged) {
    patch.autoDomainStatus = "pending";
    patch.autoDomainLastError = null;
    if (autoTargetChanged) {
      // Never reuse a record/zone id after the domain or origin changes.
      patch.autoDomainZoneName = null;
      patch.autoDomainZoneId = null;
      patch.autoDomainRecordId = null;
      patch.autoDomainOriginIp = null;
    }
  }
  const effectiveMode = d.mode ?? existing.mode;
  // Invariant: if agent mode becomes "full", force acceleration off immediately
  // (full agents run locally, so central-routing acceleration is meaningless).
  if (effectiveMode === "full" && (existing.invoiceAccelerationMode ?? "off") !== "off") {
    patch.invoiceAccelerationMode      = "off";
    patch.invoiceTrialRemaining        = null;
    patch.invoiceAccelerationLastError = null;
    patch.invoiceAccelerationReason    = "forced_off_mode_full";
    patch.invoiceAccelerationUpdatedAt = new Date();
    patch.invoiceAccelerationGeneration = sql`${agentInstancesTable.invoiceAccelerationGeneration} + 1`;
  }
  const effectivePackageSource = d.packageSource ?? existing.packageSource;
  const localSuperadminEnabled = effectiveLocalSuperadminEnabled(
    effectiveMode,
    d.localSuperadminEnabled ?? existing.localSuperadminEnabled,
  );
  const localSuperadminScreens = localSuperadminEnabled
    ? normalizeLocalSuperadminScreens(d.localSuperadminScreens ?? existing.localSuperadminScreens)
    : [];
  const effectiveSaUsername = d.saUsername !== undefined
    ? (d.saUsername ?? "").trim().toLowerCase()
    : (existing.saUsername ?? "").trim().toLowerCase();
  const effectiveSaEmail = d.saEmail !== undefined
    ? (d.saEmail ?? "").trim().toLowerCase()
    : (existing.saEmail ?? "").trim().toLowerCase();
  const saErr = validateAgentLocalSuperadmin({
    mode: effectiveMode,
    enabled: localSuperadminEnabled,
    username: localSuperadminEnabled ? effectiveSaUsername : null,
    email: localSuperadminEnabled ? effectiveSaEmail : null,
    password: localSuperadminEnabled ? d.saPassword : null,
    passwordAlreadySet: !!existing.saPasswordEnc,
  });
  if (saErr) { res.status(400).json({ error: saErr }); return; }
  const screenErr = validateLocalSuperadminScreenSelection(localSuperadminEnabled, localSuperadminScreens);
  if (screenErr) { res.status(400).json({ error: screenErr }); return; }
  if (effectivePackageSource === "external") {
    if (effectiveMode !== "full") {
      res.status(400).json({ error: "«نسخة كاملة خارجية» متاحة لوضع النسخة الكاملة فقط" });
      return;
    }
    const packageMeta = readPackageMap(existing.externalPackageMeta);
    if (!await packageMapAvailable(id, packageMeta, true)) {
      res.status(400).json({ error: "أكمل رفع Backend وFrontend وقاعدة البيانات المشفّرة قبل حفظ النسخة الخارجية" });
      return;
    }
  }
  if (d.packageSource !== undefined) patch.packageSource = d.packageSource;
  if (effectiveMode !== "full" && effectivePackageSource !== "central") patch.packageSource = "central";
  if (d.localSuperadminEnabled !== undefined || d.mode !== undefined) patch.localSuperadminEnabled = localSuperadminEnabled;
  if (d.localSuperadminScreens !== undefined || d.localSuperadminEnabled !== undefined || d.mode !== undefined) {
    patch.localSuperadminScreens = localSuperadminScreens;
  }
  if (localSuperadminEnabled) {
    if (d.saUsername !== undefined) patch.saUsername = effectiveSaUsername || null;
    if (d.saEmail !== undefined) patch.saEmail = effectiveSaEmail || null;
  } else {
    patch.saUsername = null;
    patch.saEmail = null;
    patch.saPasswordEnc = null;
  }
  // Secrets: only overwrite when a NON-EMPTY value is sent (empty = keep).
  if (d.dbUrl) { patch.dbUrlEnc = encryptSecret(d.dbUrl); patch.dbStatus = "not_configured"; patch.dbLastError = null; }
  if (d.sshSecret) { patch.sshSecretEnc = encryptSecret(d.sshSecret); patch.sshStatus = "not_configured"; }
  if (localSuperadminEnabled && d.saPassword) patch.saPasswordEnc = encryptSecret(d.saPassword);

  const candidate = { ...existing, ...patch } as typeof agentInstancesTable.$inferSelect;
  const existingEntitlement = effectiveLocalSuperadminEnabled(existing.mode, existing.localSuperadminEnabled);
  const entitlementChanged = existingEntitlement !== localSuperadminEnabled || existing.mode !== effectiveMode;
  const credentialsChanged = d.saUsername !== undefined || d.saEmail !== undefined || !!d.saPassword;
  const screensChanged = d.localSuperadminScreens !== undefined
    && JSON.stringify(normalizeLocalSuperadminScreens(existing.localSuperadminScreens))
      !== JSON.stringify(localSuperadminScreens);
  const requiresRemoteSync = existing.deployStatus === "ok" && (entitlementChanged || credentialsChanged || screensChanged);
  if (requiresRemoteSync) {
    const connectionChanged = d.domain !== undefined
      || d.sshHost !== undefined
      || d.sshPort !== undefined
      || d.sshUser !== undefined
      || !!d.sshSecret
      || !!d.dbUrl;
    if (connectionChanged) {
      res.status(409).json({ error: "احفظ بيانات الدومين/SSH/قاعدة البيانات أولًا، ثم عدّل سياسة Super Admin في عملية منفصلة" });
      return;
    }
    const operationId = randomBytes(16).toString("hex");
    const [claimed] = await db.update(agentInstancesTable).set({
      deployStatus: "deploying",
      deployLeaseId: operationId,
      deployOperationPhase: "preflight",
      deployProviderMutationUntil: null,
      updatedAt: new Date(),
    }).where(and(
      eq(agentInstancesTable.id, id),
      eq(agentInstancesTable.deployStatus, "ok"),
    )).returning({ id: agentInstancesTable.id });
    if (!claimed) {
      res.status(409).json({ error: "بدأت عملية أخرى على الوكيل — لم تُحفظ التغييرات" });
      return;
    }
    const stopHeartbeat = startAgentOperationHeartbeat(id, operationId);
    try {
      await initializeRemoteOperationFence(existing, operationId);
      if (entitlementChanged || credentialsChanged) {
        await syncInstalledAgentSuperadminPolicy(candidate, operationId);
      } else {
        await syncInstalledAgentConfigEntitlement(candidate, operationId);
      }
      const [row] = await db.update(agentInstancesTable).set({
        ...patch,
        deployStatus: "ok",
        deployLeaseId: null,
        deployOperationPhase: null,
        deployProviderMutationUntil: null,
        updatedAt: new Date(),
      }).where(and(
        eq(agentInstancesTable.id, id),
        eq(agentInstancesTable.deployStatus, "deploying"),
        eq(agentInstancesTable.deployLeaseId, operationId),
      )).returning();
      if (!row) throw new Error("فُقد قفل مزامنة إعداد Super Admin");
      stopHeartbeat();
      clearAgentHostCache();
      res.json(publicRow(row));
      return;
    } catch (e: any) {
      await db.update(agentInstancesTable).set({
        deployStatus: "ok",
        deployLeaseId: null,
        deployOperationPhase: null,
        deployProviderMutationUntil: null,
        updatedAt: new Date(),
      }).where(and(
        eq(agentInstancesTable.id, id),
        eq(agentInstancesTable.deployLeaseId, operationId),
      )).catch(() => {});
      stopHeartbeat();
      res.status(502).json({
        error: "تعذّر تطبيق إعداد لوحة Super Admin على السيرفر المثبّت — لم تُحفظ التغييرات المركزية",
        detail: String(e?.message ?? e).slice(0, 400),
      });
      return;
    }
  }

  const [row] = await db.update(agentInstancesTable).set(patch).where(and(
    eq(agentInstancesTable.id, id),
    ne(agentInstancesTable.deployStatus, "deploying"),
  )).returning();
  if (!row) {
    res.status(409).json({ error: "بدأت عملية على الوكيل أثناء التعديل — لم تُحفظ التغييرات" });
    return;
  }
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
  const [existing] = await db.select({
    externalPackageMeta: agentInstancesTable.externalPackageMeta,
    deployStatus: agentInstancesTable.deployStatus,
  })
    .from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.deployStatus === "deploying") {
    res.status(409).json({ error: "لا يمكن حذف الوكيل أثناء وجود عملية جارية" });
    return;
  }
  const [deleted] = await db.delete(agentInstancesTable).where(and(
    eq(agentInstancesTable.id, id),
    ne(agentInstancesTable.deployStatus, "deploying"),
  )).returning({ id: agentInstancesTable.id });
  if (!deleted) {
    res.status(409).json({ error: "بدأت عملية على الوكيل أثناء الحذف — لم يُحذف الوكيل" });
    return;
  }
  const meta = readPackageMap(existing.externalPackageMeta);
  await Promise.all([
    ...EXTERNAL_PACKAGE_KINDS.map(kind => removePackageObject(meta[kind]?.objectPath)),
    removeAllAgentPackageObjects(id),
  ]);
  clearAgentHostCache();
  const { evictAgentDb } = await import("../lib/agentDb.js");
  evictAgentDb(id);
  res.json({ ok: true });
});

// ── External DB: test / init ───────────────────────────────────────────────

async function withAgentPool<T>(dbUrlEnc: string, fn: (pool: PgPoolType) => Promise<T>): Promise<T> {
  const url = decryptSecret(dbUrlEnc);
  if (!url) throw new Error("لا يوجد رابط اتصال محفوظ");
  let hostname: string;
  try { hostname = new URL(url).hostname; }
  catch {
    throw new Error("رابط الاتصال غير صالح — يجب أن يكون بصيغة postgres://user:pass@host:5432/dbname (عدّل الرابط من قلم التعديل أو احذفه ليُنشأ تلقائيًا عند التسطيب)");
  }
  try { await assertProbeTargetAllowed(hostname); }
  catch (e: any) {
    if (String(e?.message ?? "").includes("غير مسموح")) throw e;
    throw new Error(`تعذّر التحقق من مضيف قاعدة البيانات (${hostname}) — تأكد من صحة العنوان`);
  }
  const pool = new PgPool({ connectionString: url, max: 2, connectionTimeoutMillis: 8000, ssl: url.includes("sslmode=disable") ? undefined : { rejectUnauthorized: false } });
  try { return await fn(pool); } finally { await pool.end().catch(() => {}); }
}

const REQUIRED_AGENT_SUPPLIER_METADATA_COLUMNS = {
  journal_entry_lines: [
    "supplier_name",
    "supplier_tax_number",
    "supplier_vat_number",
    "supplier_invoice_number",
    "supplier_invoice_date",
  ],
  payment_voucher_lines: [
    "supplier_name",
    "supplier_tax_number",
    "supplier_vat_number",
    "supplier_invoice_number",
    "supplier_invoice_date",
  ],
} as const;

const REQUIRED_AGENT_JOURNAL_LINE_COLUMNS = [
  "id",
  "entry_id",
  "account_id",
  "cost_center",
  "debit",
  "credit",
  "description",
  "supplier_name",
  "supplier_vat_number",
  "supplier_invoice_number",
  "supplier_invoice_date",
  "sort_order",
] as const;

async function assertAgentJournalLineSchema(pool: PgPoolType): Promise<void> {
  const result = await pool.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'journal_entry_lines'`,
  );
  const present = new Set(result.rows.map(row => row.column_name));
  const missing = REQUIRED_AGENT_JOURNAL_LINE_COLUMNS.filter(column => !present.has(column));
  if (missing.length) {
    throw new Error(`ترقية جدول قيود اليومية غير مكتملة؛ الأعمدة الناقصة: ${missing.join(", ")}`);
  }
}

async function assertAgentSupplierMetadataSchema(pool: PgPoolType): Promise<void> {
  const result = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])`,
    [Object.keys(REQUIRED_AGENT_SUPPLIER_METADATA_COLUMNS)],
  );
  const present = new Set(result.rows.map(row => `${row.table_name}.${row.column_name}`));
  const missing = Object.entries(REQUIRED_AGENT_SUPPLIER_METADATA_COLUMNS).flatMap(([tableName, columns]) =>
    columns
      .filter(columnName => !present.has(`${tableName}.${columnName}`))
      .map(columnName => `${tableName}.${columnName}`),
  );
  if (missing.length) {
    throw new Error(`ترقية قاعدة بيانات الوكيل غير مكتملة؛ الأعمدة الناقصة: ${missing.join(", ")}`);
  }
}

/** يطبّق استحقاق السوبر أدمن على قاعدة الوكيل ويُلغي كل الجلسات القديمة.
 *  عند التعطيل: يُعطّل كل حسابات SA المحلية ويمسح أسرارها المؤقتة.
 *  عند التفعيل: يعيد زرع الحساب المحدد فقط ويُبقي بقية حسابات SA معطّلة. */
async function syncAgentSuperadminAccount(inst: typeof agentInstancesTable.$inferSelect): Promise<string> {
  if (!inst.dbUrlEnc) throw new Error("لا يوجد رابط قاعدة بيانات لتطبيق سياسة السوبر أدمن");
  const enabled = effectiveLocalSuperadminEnabled(inst.mode, inst.localSuperadminEnabled);
  const username = (inst.saUsername ?? "").trim().toLowerCase();
  const passwordPlain = inst.saPasswordEnc ? (decryptSecret(inst.saPasswordEnc) ?? "") : "";
  if (enabled && (!username || !passwordPlain)) throw new Error("بيانات حساب السوبر أدمن المحلي غير مكتملة");
  const email = (inst.saEmail ?? "").trim().toLowerCase() || null;
  return withAgentPool(inst.dbUrlEnc!, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const superRows = await client.query(
        `SELECT id FROM users WHERE role = 'superadmin' AND company_id IS NULL FOR UPDATE`,
      );
      const ids = superRows.rows.map((row: any) => Number(row.id)).filter(Number.isFinite);
      if (ids.length) {
        await client.query(
          `UPDATE users SET is_active = false, session_token = NULL
           WHERE id = ANY($1::int[])`,
          [ids],
        );
        await client.query(
          `UPDATE sa_sessions SET revoked_at = NOW(), revoked_reason = 'local_superadmin_disabled'
           WHERE user_id = ANY($1::int[]) AND revoked_at IS NULL`,
          [ids],
        );
        await client.query(`DELETE FROM sa_otp_codes WHERE user_id = ANY($1::int[])`, [ids]);
        await client.query(`DELETE FROM sa_trusted_devices WHERE user_id = ANY($1::int[])`, [ids]);
        await client.query(`DELETE FROM sa_device_approvals WHERE user_id = ANY($1::int[])`, [ids]);
        await client.query(`DELETE FROM sa_recovery_links WHERE user_id = ANY($1::int[])`, [ids]);
        await client.query(`DELETE FROM sa_recovery_codes WHERE user_id = ANY($1::int[])`, [ids]);
      }
      if (!enabled) {
        await client.query("COMMIT");
        return "تم تعطيل لوحة Super Admin المحلية وإلغاء حساباتها وجلساتها";
      }

      const bcrypt = (await import("bcryptjs")).default;
      const passwordHash = await bcrypt.hash(passwordPlain, 12);
      const existing = await client.query(
        `SELECT id FROM users WHERE lower(username) = $1 AND company_id IS NULL LIMIT 1`,
        [username],
      );
      if (existing.rows.length) {
        await client.query(
          `UPDATE users SET username = $2, password_hash = $3, email = $4,
             role = 'superadmin', is_active = true, view_all_branches = true
           WHERE id = $1`,
          [existing.rows[0].id, username, passwordHash, email],
        );
      } else {
        await client.query(
          `INSERT INTO users (username, email, password_hash, role, name_ar, is_active, view_all_branches)
           VALUES ($1, $2, $3, 'superadmin', $4, true, true)`,
          [username, email, passwordHash, inst.name || "SuperAdmin"],
        );
      }
      await client.query("COMMIT");
      return `${existing.rows.length ? "تم تحديث" : "تم إنشاء"} حساب السوبر أدمن (${username}) في قاعدة الوكيل — إيميل OTP: ${email}`;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}

async function syncInstalledAgentConfigEntitlement(
  inst: typeof agentInstancesTable.$inferSelect,
  operationId: string,
): Promise<void> {
  if (!inst.sshHost || !inst.sshUser || !inst.sshSecretEnc) {
    throw new Error("بيانات SSH غير مكتملة لمزامنة إعداد لوحة Super Admin");
  }
  const flag = effectiveLocalSuperadminEnabled(inst.mode, inst.localSuperadminEnabled) ? "1" : "0";
  const screensB64 = Buffer.from(JSON.stringify(
    flag === "1" ? normalizeLocalSuperadminScreens(inst.localSuperadminScreens) : [],
  ), "utf8").toString("base64");
  const result = await sshRunOperationScript(inst, operationId, `set -e
test -f /opt/zacod/config.json
ZACOD_LOCAL_SA=${flag} ZACOD_LOCAL_SA_SCREENS_B64=${screensB64} python3 -c "import base64,json,os; p='/opt/zacod/config.json'; c=json.load(open(p)); c['localSuperadminEnabled']=os.environ['ZACOD_LOCAL_SA']=='1'; c['localSuperadminScreens']=json.loads(base64.b64decode(os.environ['ZACOD_LOCAL_SA_SCREENS_B64'])); json.dump(c,open(p,'w'),indent=2,ensure_ascii=False)"
echo ZACOD_LOCAL_SA_SYNCED`, { timeoutMs: 60_000 });
  if (result.code !== 0 || !result.out.includes("ZACOD_LOCAL_SA_SYNCED")) {
    throw new Error("تعذّر تحديث config.json على سيرفر الوكيل");
  }
}

async function syncInstalledAgentSuperadminPolicy(
  inst: typeof agentInstancesTable.$inferSelect,
  operationId: string,
): Promise<void> {
  const enabled = effectiveLocalSuperadminEnabled(inst.mode, inst.localSuperadminEnabled);
  if (enabled) {
    // Seed first while the old disabled gate still blocks all access, then open it.
    await syncAgentSuperadminAccount(inst);
    await syncInstalledAgentConfigEntitlement(inst, operationId);
    return;
  }
  // Close the trusted runtime gate first, then revoke every account/session.
  await syncInstalledAgentConfigEntitlement(inst, operationId);
  await syncAgentSuperadminAccount(inst);
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
             "--exclude-table=public.agent_invoice_samples",
             "--exclude-table=public.agent_invoice_samples_id_seq",
            process.env.DATABASE_URL!,
          ], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(new Error(`pg_dump غير متاح أو فشل: ${String(stderr || err.message).slice(0, 200)}`));
            else resolve(stdout);
          });
        });
        // Strip psql meta-commands (\restrict etc. in newer pg_dump) — the
        // dump is applied through the pg driver, not psql. Apply inside ONE
        // transaction so a mid-dump failure leaves the agent DB untouched.
        const cleaned = sanitizeSchemaDumpForExternalAgent(dumpSql);
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

// POST /:id/repair-email — seed the full agent's local SMTP configuration
// from the central deployment, restart the service, and send a real test
// message to the configured local Super Admin. This deliberately avoids a
// full reinstall/database restore when only OTP delivery needs repair.
router.post("/:id/repair-email", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  if (inst.mode !== "full") { res.status(400).json({ error: "إصلاح البريد متاح للنسخة الكاملة فقط" }); return; }
  if (!inst.saEmail) { res.status(400).json({ error: "أدخل بريد Super Admin للوكيل أولًا" }); return; }
  if (!inst.sshHost || !inst.sshUser || !inst.sshSecretEnc) {
    res.status(400).json({ error: "احفظ بيانات SSH أولًا" });
    return;
  }
  try { await assertProbeTargetAllowed(inst.sshHost); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? "عنوان غير مسموح") }); return; }

  const smtpInput = z.object({
    host: z.string().trim().min(1).max(255).optional(),
    port: z.coerce.number().int().min(1).max(65535).optional(),
    user: z.string().trim().min(1).max(320).optional(),
    password: z.string().min(1).max(1000).optional(),
    from: z.string().trim().max(500).optional(),
  }).safeParse(req.body ?? {});
  if (!smtpInput.success) {
    res.status(400).json({ error: "بيانات SMTP غير صالحة" });
    return;
  }
  const supplied = smtpInput.data;
  const smtp = {
    SMTP_HOST: supplied.host ?? process.env.SMTP_HOST ?? "",
    SMTP_PORT: String(supplied.port ?? process.env.SMTP_PORT ?? "587"),
    SMTP_USER: supplied.user ?? process.env.SMTP_USER ?? "",
    SMTP_PASS: supplied.password ?? process.env.SMTP_PASS ?? "",
    SMTP_FROM: supplied.from || supplied.user || process.env.SMTP_FROM || process.env.SMTP_USER || "",
    SMTP_TEST_TO: inst.saEmail,
  };
  if (Object.values(smtp).some(v => /[\r\n]/.test(v))) {
    res.status(400).json({ error: "قيم SMTP لا تقبل أسطرًا جديدة" });
    return;
  }
  if (smtpInput.data.host && !/^[a-z0-9.-]+$/i.test(smtpInput.data.host)) {
    res.status(400).json({ error: "اسم خادم SMTP غير صالح" });
    return;
  }
  if (!smtp.SMTP_HOST || !smtp.SMTP_USER || !smtp.SMTP_PASS) {
    res.status(409).json({ error: "أدخل خادم SMTP وبريد الإرسال وكلمة مرور التطبيق" });
    return;
  }

  const exports = Object.entries(smtp)
    .map(([key, value]) => `export ZACOD_${key}_B64=${shQ(Buffer.from(value, "utf8").toString("base64"))}`)
    .join("\n");
  const script = `set -e
umask 077
test -f /opt/zacod/app.env
${exports}
python3 <<'PY'
import base64, os, pathlib
p = pathlib.Path("/opt/zacod/app.env")
keys = ("SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM")
vals = {k: base64.b64decode(os.environ["ZACOD_" + k + "_B64"]).decode("utf-8") for k in keys}
old = p.read_text(encoding="utf-8").splitlines()
kept = [line for line in old if not any(line.startswith(k + "=") for k in keys)]
def quote(v):
    return '"' + v.replace("\\\\", "\\\\\\\\").replace('"', '\\\\"').replace("\\r", "").replace("\\n", "") + '"'
tmp = p.with_suffix(".env.new")
tmp.write_text("\\n".join(kept + [k + "=" + quote(vals[k]) for k in keys]) + "\\n", encoding="utf-8")
tmp.chmod(0o600)
tmp.replace(p)
PY
systemctl restart zacod-app
sleep 3
python3 <<'PY'
import base64, os, smtplib, ssl
from email.message import EmailMessage
def val(k):
    return base64.b64decode(os.environ["ZACOD_" + k + "_B64"]).decode("utf-8")
host, user, password = val("SMTP_HOST"), val("SMTP_USER"), val("SMTP_PASS")
port = int(val("SMTP_PORT") or "587")
sender, recipient = val("SMTP_FROM") or user, val("SMTP_TEST_TO")
msg = EmailMessage()
msg["From"], msg["To"] = sender, recipient
msg["Subject"] = "اختبار بريد نسخة الوكيل — Zacod ERP"
msg.set_content("تم ربط خدمة البريد بنجاح. يمكنك الآن طلب رمز OTP جديد من صفحة الدخول.")
ctx = ssl.create_default_context()
if port == 465:
    client = smtplib.SMTP_SSL(host, port, timeout=20, context=ctx)
else:
    client = smtplib.SMTP(host, port, timeout=20)
    client.ehlo()
    if client.has_extn("starttls"):
        client.starttls(context=ctx)
        client.ehlo()
try:
    client.login(user, password)
    client.send_message(msg)
finally:
    try: client.quit()
    except Exception: pass
print("SMTP_TEST_OK")
PY`;

  try {
    const result = await sshRunScript(inst, script, { timeoutMs: 60_000 });
    await pinHostKey(inst, result.hostKeyFp);
    if (result.code !== 0 || !result.out.includes("SMTP_TEST_OK")) {
      const detail = result.out
        .replace(/[A-Za-z0-9+/]{28,}={0,2}/g, "[REDACTED]")
        .replace(/(password|pass|credential|auth)[^:\n]*:[^\n]*/gi, "$1: [REDACTED]")
        .slice(-700);
      res.status(502).json({ error: "فشل اختبار SMTP على سيرفر الوكيل", detail: detail || "راجع إعداد مزود البريد" });
      return;
    }
    await logAgentEvent(id, "agent_email_repaired", { to: inst.saEmail, by: (req as any).authUser?.username ?? null }, req);
    res.json({
      ok: true,
      note: `تم إصلاح البريد وإرسال رسالة اختبار إلى ${inst.saEmail}. بعد وصولها اطلب OTP جديدًا.`,
    });
  } catch (e: any) {
    const detail = String(e?.message ?? e)
      .replace(/[A-Za-z0-9+/]{28,}={0,2}/g, "[REDACTED]")
      .slice(0, 700);
    res.status(502).json({ error: "تعذّر إصلاح البريد على سيرفر الوكيل", detail });
  }
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

// POST /:id/unban — فك الحظر بضغطة زر: يدخل SSH على سيرفر الوكيل وينفّذ
// fail2ban-client unban --all ثم يضيف عنوان المنصة الحالي إلى قائمة
// التجاهل الدائمة (jail.d) حتى لا يتكرر الحظر مستقبلًا.
// ملاحظة مهمة: لو الحظر واقع على عنوان المنصة نفسها فلن يصل SSH أصلًا —
// نكتشف ذلك (مهلة صامتة) ونرد برسالة توجيهية بدل فشل غامض.
router.post("/:id/unban", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  if (!inst.sshHost || !inst.sshUser || !inst.sshSecretEnc) { res.status(400).json({ error: "أكمل بيانات السيرفر (المضيف والمستخدم وكلمة المرور/المفتاح) أولًا" }); return; }
  try { await assertProbeTargetAllowed(inst.sshHost); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? "عنوان غير مسموح") }); return; }
  const operationId = randomBytes(16).toString("hex");
  const [claimed] = await db.update(agentInstancesTable).set({
    deployStatus: "deploying",
    deployLeaseId: operationId,
    deployOperationPhase: "preflight",
    deployProviderMutationUntil: null,
    updatedAt: new Date(),
  }).where(and(
    eq(agentInstancesTable.id, id),
    ne(agentInstancesTable.deployStatus, "deploying"),
  )).returning({ id: agentInstancesTable.id });
  if (!claimed) {
    res.status(409).json({ error: "يوجد نشر/تسطيب أو إعداد آخر جارٍ على السيرفر" });
    return;
  }
  const stopHeartbeat = startAgentOperationHeartbeat(id, operationId);

  const unbanScript = `set -e
if ! command -v fail2ban-client >/dev/null 2>&1; then echo "NO_FAIL2BAN"; exit 0; fi
BANNED_BEFORE=$(fail2ban-client banned 2>/dev/null || true)
fail2ban-client unban --all >/dev/null 2>&1 || true
# تحصين دائم: أضف عنوان الاتصال الحالي (عنوان المنصة) إلى قائمة التجاهل
MY_IP=$(echo "$SSH_CONNECTION" | awk '{print $1}')
if [ -n "$MY_IP" ]; then
  mkdir -p /etc/fail2ban/jail.d
  F=/etc/fail2ban/jail.d/zacod-whitelist.conf
  if [ ! -f "$F" ]; then printf '[DEFAULT]\\nignoreip = 127.0.0.1/8 %s\\n' "$MY_IP" > "$F";
  elif ! grep -q "$MY_IP" "$F"; then sed -i "s|^ignoreip = .*|& $MY_IP|" "$F"; fi
  fail2ban-client reload >/dev/null 2>&1 || systemctl reload fail2ban >/dev/null 2>&1 || true
fi
echo "UNBAN_OK ip=$MY_IP"
echo "BANNED_BEFORE:$BANNED_BEFORE"`;

  try {
    await initializeRemoteOperationFence(inst, operationId);
    const r = await sshRunOperationScript(inst, operationId, unbanScript, { timeoutMs: 45_000 });
    await pinHostKey(inst, r.hostKeyFp);
    if (/NO_FAIL2BAN/.test(r.out)) {
      await logAgentEvent(id, "unban_run", { result: "no_fail2ban", by: (req as any).authUser?.username ?? null }, req);
      res.json({ ok: true, note: "fail2ban غير مثبّت على هذا السيرفر أصلًا — لا يوجد حظر لفكّه من هذه الجهة. لو المشكلة مستمرة فهي جدار ناري آخر أو إعدادات المزود." });
      return;
    }
    const bannedBefore = (r.out.match(/BANNED_BEFORE:(.*)/)?.[1] ?? "").trim();
    const hadBans = bannedBefore && bannedBefore !== "[]" && !/^\[\s*(\{\s*\}\s*,?\s*)*\]$/.test(bannedBefore.replace(/'[^']*':\s*\[\]/g, "{}"));
    await db.update(agentInstancesTable).set({ sshStatus: "ok", sshLastCheckAt: new Date(), updatedAt: new Date() }).where(and(
      eq(agentInstancesTable.id, id),
      eq(agentInstancesTable.deployLeaseId, operationId),
    ));
    await logAgentEvent(id, "unban_run", { result: "ok", bannedBefore: bannedBefore.slice(0, 500), by: (req as any).authUser?.username ?? null }, req);
    res.json({
      ok: true,
      note: hadBans
        ? "تم فك كل الحظر بنجاح، وأضيف عنوان المنصة إلى قائمة التجاهل حتى لا يتكرر الحظر."
        : "لم تكن هناك عناوين محظورة أصلًا — تم التأكيد وإضافة عنوان المنصة إلى قائمة التجاهل احتياطًا.",
      bannedBefore: bannedBefore.slice(0, 1000) || null,
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    await logAgentEvent(id, "unban_run", { result: "error", error: msg.slice(0, 300) }, req);
    if (/انتهت مهلة|ETIMEDOUT|Timed out/i.test(msg)) {
      res.status(502).json({
        error: "تعذّر الوصول للسيرفر عبر SSH (مهلة صامتة) — الأرجح أن عنوان المنصة نفسها هو المحظور، وفي هذه الحالة لا يمكن فك الحظر من هنا. الحلول: انتظر انتهاء مدة الحظر (عادة 10–60 دقيقة) ثم اضغط الزر مرة أخرى، أو نفّذ من كونسول المزود: fail2ban-client unban --all",
      });
      return;
    }
    res.status(502).json({ error: `فشل فك الحظر: ${msg.slice(0, 300)}` });
  } finally {
    await db.update(agentInstancesTable).set({
      deployStatus: inst.deployStatus,
      deployLeaseId: null,
      deployOperationPhase: null,
      deployProviderMutationUntil: null,
      updatedAt: new Date(),
    }).where(and(
      eq(agentInstancesTable.id, id),
      eq(agentInstancesTable.deployLeaseId, operationId),
    )).catch(() => {});
    stopHeartbeat();
  }
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

// ── Invoice acceleration ────────────────────────────────────────────────────

/** Eligibility check: only frontend_only or full_shell agents with status=active
 *  and an initialized external DB URL are eligible for invoice acceleration. */
function isAccelerationEligible(inst: typeof agentInstancesTable.$inferSelect): {
  eligible: boolean; reason: string;
} {
  if (inst.mode === "full") {
    return { eligible: false, reason: "full mode agents run locally — acceleration is only for central-routed agents" };
  }
  if (inst.status !== "active") {
    return { eligible: false, reason: "agent must be active" };
  }
  if (inst.dbStatus !== "initialized" || !inst.dbUrlEnc) {
    return { eligible: false, reason: "agent external database must be initialized" };
  }
  return { eligible: true, reason: "eligible" };
}

// POST /:id/invoice-acceleration/diagnostics — SA-only, read-only.
// Runs a DNS+HTTPS public probe and 3 SELECT 1 samples via the cached pool,
// then aggregates baseline vs accelerated sample stats from the central store.
// Never persists the probe results. No schema heal, no tx, no writes.
router.post("/:id/invoice-acceleration/diagnostics", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }

  const eligibility = isAccelerationEligible(inst);
  const currentState = {
    mode:      inst.invoiceAccelerationMode ?? "off",
    remaining: inst.invoiceTrialRemaining ?? null,
    lastError: inst.invoiceAccelerationLastError ?? null,
    reason:    inst.invoiceAccelerationReason ?? null,
    updatedAt: inst.invoiceAccelerationUpdatedAt ?? null,
  };

  // If mode is "full", reject clearly — acceleration is meaningless.
  if (inst.mode === "full") {
    res.status(422).json({
      ok: false,
      error: "تشخيص تسريع الفاتورة غير متاح لوضع النسخة الكاملة",
      eligibility,
      currentState,
    });
    return;
  }

  // ── DNS + HTTPS public probe ────────────────────────────────────────────
  let dnsProbe: { ips: string[]; ok: boolean; error: string | null } = { ips: [], ok: false, error: null };
  let httpsProbe: { ok: boolean; statusCode: number | null; latencyMs: number | null; error: string | null } =
    { ok: false, statusCode: null, latencyMs: null, error: null };

  try {
    await assertProbeTargetAllowed(inst.domain);
    try {
      const addrs = await dnsLookup(inst.domain, { all: true });
      dnsProbe.ips = addrs.map(a => a.address);
      dnsProbe.ok  = addrs.length > 0;
    } catch (e: any) {
      dnsProbe.error = String(e?.message ?? e).slice(0, 200);
    }
    if (dnsProbe.ok && dnsProbe.ips.length) {
      const pinnedIp = dnsProbe.ips[0];
      const t0 = Date.now();
      try {
        await new Promise<void>((resolve, reject) => {
          const probe = httpsRequest({
            host: inst.domain, servername: inst.domain, port: 443, path: "/", method: "HEAD",
            timeout: 6000,
            lookup: ((_h: string, opts: any, cb: any) => {
              const fam = net.isIP(pinnedIp);
              if (typeof opts === "function") { opts(null, pinnedIp, fam); return; }
              if (opts?.all) cb(null, [{ address: pinnedIp, family: fam }]);
              else cb(null, pinnedIp, fam);
            }) as any,
          }, (resp) => {
            httpsProbe.latencyMs  = Date.now() - t0;
            httpsProbe.statusCode = resp.statusCode ?? null;
            httpsProbe.ok         = true;
            resp.resume();
            resolve();
          });
          probe.on("timeout", () => probe.destroy(new Error("probe-timeout")));
          probe.on("error", reject);
          probe.end();
        });
      } catch (e: any) {
        httpsProbe.latencyMs = Date.now() - t0;
        httpsProbe.error = String(e?.message ?? "").includes("probe-timeout")
          ? "timeout (6s)" : String(e?.message ?? e).slice(0, 200);
      }
    }
  } catch (e: any) {
    dnsProbe.error = String(e?.message ?? e).slice(0, 200);
  }

  // ── DB SELECT 1 samples via cached pool ────────────────────────────────
  const dbSamples: { ok: boolean; ms: number; error: string | null }[] = [];
  let poolStats: { waiting: number; total: number; idle: number; max: number } | null = null;

  if (eligibility.eligible && inst.dbUrlEnc) {
    const { getAgentDbContext, getAgentDbPoolStats } = await import("../lib/agentDb.js");
    try {
      const ctx = getAgentDbContext(id, inst.dbUrlEnc);
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        try {
          const client = await ctx.pool.connect();
          try { await client.query("SELECT 1"); }
          finally { client.release(); }
          dbSamples.push({ ok: true, ms: Date.now() - t0, error: null });
        } catch (e: any) {
          dbSamples.push({ ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 200) });
        }
      }
      poolStats = getAgentDbPoolStats(id);
    } catch (e: any) {
      dbSamples.push({ ok: false, ms: 0, error: String(e?.message ?? e).slice(0, 200) });
    }
  }

  // ── Aggregate baseline / accelerated sample stats ──────────────────────
  const recentSamples = await db
    .select()
    .from(agentInvoiceSamplesTable)
    .where(eq(agentInvoiceSamplesTable.agentId, id))
    .orderBy(desc(agentInvoiceSamplesTable.id))
    .limit(100);

  // Compare only the operations that use the accelerated read algorithm.
  // Posting is measured separately but must not distort create/update p95.
  const comparableInvoiceSave = (s: typeof recentSamples[number]) =>
    (s.operation === "create" || s.operation === "update")
    && s.status >= 200
    && s.status < 400;
  const baselineSamples = recentSamples.filter(s => !s.accelerated && comparableInvoiceSave(s));
  const acceleratedSamples = recentSamples.filter(s => s.accelerated && comparableInvoiceSave(s));

  const baselineStats    = computeSampleStats(baselineSamples.map(s => s.totalMs));
  const acceleratedStats = computeSampleStats(acceleratedSamples.map(s => s.totalMs));
  const improvementPct   = (baselineStats.count >= 3 && acceleratedStats.count >= 3 && baselineStats.p95 > 0)
    ? Math.round((1 - acceleratedStats.p95 / baselineStats.p95) * 100)
    : null;

  res.json({
    ok: true,
    eligibility,
    currentState,
    dnsProbe,
    httpsProbe,
    dbProbe: { samples: dbSamples, poolStats },
    sampleStats: {
      baseline:    { ...baselineStats },
      accelerated: { ...acceleratedStats },
      improvementPct,
      totalRecentSamples: recentSamples.length,
    },
    checkedAt: new Date().toISOString(),
  });
});

// POST /:id/invoice-acceleration/trial
// Starts an acceleration trial (5 slots). Requires:
//   • agent is frontend_only or full_shell, active, initialized DB URL
//   • at least 3 successful non-accelerated recent invoice samples (for baseline)
//   • body: { confirm: true }
// Atomically sets mode=trial, remaining=5. Clears cache. Logs central event.
router.post("/:id/invoice-acceleration/trial", async (req, res) => {
  const id = Number(req.params.id);
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: "يجب إرسال { confirm: true } لتأكيد بدء التجربة" });
    return;
  }

  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }

  const eligibility = isAccelerationEligible(inst);
  if (!eligibility.eligible) {
    res.status(422).json({ error: `الوكيل غير مؤهل للتسريع: ${eligibility.reason}`, eligibility });
    return;
  }
  if ((inst.invoiceAccelerationMode ?? "off") !== "off") {
    res.status(409).json({ error: "أوقف وضع التسريع الحالي قبل بدء تجربة جديدة" });
    return;
  }

  // Require at least 3 successful non-accelerated recent samples as baseline.
  // "Successful" means HTTP 2xx/3xx only — business 4xx errors are excluded.
  const baselineSamples = await db
    .select({
      id: agentInvoiceSamplesTable.id,
      totalMs: agentInvoiceSamplesTable.totalMs,
    })
    .from(agentInvoiceSamplesTable)
    .where(
      and(
        eq(agentInvoiceSamplesTable.agentId, id),
        eq(agentInvoiceSamplesTable.accelerated, false),
        sql`operation IN ('create', 'update')`,
        sql`status >= 200 AND status < 400`,
      ),
    )
    .orderBy(desc(agentInvoiceSamplesTable.id))
    .limit(20);

  if (baselineSamples.length < 3) {
    res.status(422).json({
      error: "التجربة تحتاج على الأقل 3 عيّنات فاتورة غير مسرّعة ناجحة كخط أساس — سجّل بعض العمليات أولًا",
      baselineSamplesFound: baselineSamples.length,
    });
    return;
  }

  const now = new Date();
  const baselineStats = computeSampleStats(baselineSamples.map(s => s.totalMs));
  const [updated] = await db.update(agentInstancesTable).set({
    invoiceAccelerationMode:      "trial",
    invoiceTrialRemaining:        5,
    invoiceAccelerationLastError: null,
    invoiceAccelerationReason:    "trial_started",
    invoiceAccelerationUpdatedAt: now,
    invoiceAccelerationGeneration: sql`${agentInstancesTable.invoiceAccelerationGeneration} + 1`,
    invoiceAccelerationBaseline: {
      ...baselineStats,
      measuredAt: now.toISOString(),
    },
    updatedAt:                    now,
  }).where(and(
    eq(agentInstancesTable.id, id),
    eq(agentInstancesTable.invoiceAccelerationMode, "off"),
  )).returning();
  if (!updated) {
    res.status(409).json({ error: "تغيّرت حالة التسريع أثناء بدء التجربة — حدّث الصفحة وحاول مجددًا" });
    return;
  }

  clearAgentHostCache();
  await _logCentralEvent(id, "invoice_acceleration_trial_started", {
    by:                (req as any).authUser?.username ?? null,
    baselineSamples:   baselineSamples.length,
    baselineAvg:       baselineStats.avg,
    baselineP95:       baselineStats.p95,
  });

  res.json({ ok: true, agent: publicRow(updated) });
});

// POST /:id/invoice-acceleration/off
// Switches acceleration off for new requests. Clears trial remaining.
// Preserves all business data and sample history. Clears cache. Logs event.
router.post("/:id/invoice-acceleration/off", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }

  const now = new Date();
  await db.update(agentInstancesTable).set({
    invoiceAccelerationMode:      "off",
    invoiceTrialRemaining:        null,
    invoiceAccelerationLastError: null,
    invoiceAccelerationReason:    "manually_disabled",
    invoiceAccelerationUpdatedAt: now,
    invoiceAccelerationGeneration: sql`${agentInstancesTable.invoiceAccelerationGeneration} + 1`,
    updatedAt:                    now,
  }).where(eq(agentInstancesTable.id, id));

  clearAgentHostCache();
  await _logCentralEvent(id, "invoice_acceleration_manual_disabled", {
    by:          (req as any).authUser?.username ?? null,
    previousMode: inst.invoiceAccelerationMode ?? "off",
  });

  const [updated] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  res.json({ ok: true, agent: updated ? publicRow(updated) : null });
});

// ── License / kill-switch ──────────────────────────────────────────────────

// POST /:id/license — re-issue key (optionally new expiry).
router.post("/:id/license", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  if (inst.deployStatus === "deploying") { res.status(409).json({ error: "انتظر انتهاء العملية الجارية قبل تغيير الترخيص" }); return; }
  const expiresAt = typeof req.body?.expiresAt === "string" && req.body.expiresAt ? new Date(req.body.expiresAt) : inst.licenseExpiresAt;
  const licenseKey = mintLicenseKey(inst.installationId, inst.domain);
  const [updated] = await db.update(agentInstancesTable).set({ licenseKey, licenseExpiresAt: expiresAt, updatedAt: new Date() })
    .where(and(eq(agentInstancesTable.id, id), ne(agentInstancesTable.deployStatus, "deploying")))
    .returning({ id: agentInstancesTable.id });
  if (!updated) { res.status(409).json({ error: "بدأت عملية على الوكيل أثناء إصدار الترخيص — لم يتغير المفتاح" }); return; }
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
  const operationId = randomBytes(16).toString("hex");
  // Atomic lease: claim the shared deployStatus='deploying' slot so a
  // concurrent deploy/provision can't run while we are deleting (and vice
  // versa — provision/deploy claim the same slot conditionally).
  const [inst] = await db.update(agentInstancesTable)
    .set({
      deployStatus: "deploying",
      deployLeaseId: operationId,
      deployOperationPhase: "preflight",
      deployProviderMutationUntil: null,
      updatedAt: new Date(),
    })
    .where(and(eq(agentInstancesTable.id, id), ne(agentInstancesTable.deployStatus, "deploying")))
    .returning();
  if (!inst) {
    const [row] = await db.select({ id: agentInstancesTable.id }).from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
    res.status(row ? 409 : 404).json({ error: row ? "توجد عملية تسطيب/نشر جارية — انتظر انتهاءها أولًا" : "غير موجود" });
    return;
  }
  const stopHeartbeat = startAgentOperationHeartbeat(id, operationId);
  // Persist a terminal wipe state on EVERY exit path (never leave the lease
  // held or stale deployed/initialized flags on a wiped/unreachable server).
  const finish = async (extra: Record<string, unknown>) => {
    await db.update(agentInstancesTable).set({
      deployedVersion: null,
      dbStatus: "not_configured",
      deployLeaseId: null,
      deployOperationPhase: null,
      deployProviderMutationUntil: null,
      updatedAt: new Date(),
      ...extra,
    }).where(and(
      eq(agentInstancesTable.id, id),
      eq(agentInstancesTable.deployStatus, "deploying"),
      eq(agentInstancesTable.deployLeaseId, operationId),
    )).catch(() => {});
  };

  // 1) Kill-switch أولًا وبلا شروط: تعطيل + إلغاء مفتاح الترخيص.
  await db.update(agentInstancesTable)
    .set({ status: "suspended", licenseKey: null, updatedAt: new Date() })
    .where(and(eq(agentInstancesTable.id, id), eq(agentInstancesTable.deployLeaseId, operationId)));
  await logAgentEvent(id, "suspended_by_admin", { by: (req as any).authUser?.username ?? null, note: "wipe" }, req);
  clearAgentHostCache();
  { const { evictAgentDb } = await import("../lib/agentDb.js"); evictAgentDb(id); }

  // 2) المسح عن بُعد (أفضل جهد) — يحتاج بيانات SSH محفوظة.
  if (!inst.sshHost || !inst.sshSecretEnc) {
    const msg = "لا توجد بيانات SSH محفوظة — تم تعطيل الترخيص وإلغاء المفتاح فقط؛ نبض النسخة القادم سيوقفها تلقائيًا.";
    await finish({ deployStatus: "never", deployLog: `— الحذف الكامل —\n${msg}` });
    stopHeartbeat();
    res.json({ ok: true, wiped: false, log: msg });
    return;
  }
  try {
    assertShellSafeHostLike(inst.sshHost, "مضيف SSH");
    await assertProbeTargetAllowed(inst.sshHost); // SSRF guard — نفس فحص النشر
  } catch (e: any) {
    const msg = `تعذّر المسح عبر SSH: ${e?.message ?? e} — تم تعطيل الترخيص وإلغاء المفتاح.`;
    await finish({ deployStatus: "error", deployLog: `— الحذف الكامل —\n${msg}` });
    stopHeartbeat();
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
    await initializeRemoteOperationFence(inst, operationId);
    const r = await sshRunOperationScript(inst, operationId, wipeScript, { timeoutMs: 240_000 });
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
  } finally {
    stopHeartbeat();
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

function localPlatformIdentity(): { platformId: string; origin: string } {
  const origin = normalizeHttpsOrigin(resolveCentralOrigin());
  const configured = process.env.ZACOD_PLATFORM_ID;
  return {
    platformId: configured ? platformId(configured) : `platform:${sha256Verifier(origin).slice(0, 24)}`,
    origin,
  };
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

async function buildSetupKit(
  inst: typeof agentInstancesTable.$inferSelect,
  opts?: { hbMarker?: string; safeWebServerMode?: boolean },
) {
  assertSafeDomain(inst.domain);
  // علامة النبض: تميّز أي سيرفر (رئيسي/احتياطي) أرسل النبضة عند تعدد السيرفرات.
  const hbMarker = opts?.hbMarker ?? (inst.primaryHbMarker ?? "");
  if (!/^[a-z0-9-]{0,40}$/.test(hbMarker)) throw new Error("علامة نبض غير صالحة");
  const origin = resolveCentralOrigin();
  // Validate before interpolating into the root script.
  const originUrl = new URL(origin);
  if (originUrl.protocol !== "https:" && originUrl.protocol !== "http:") throw new Error("أصل المنصة غير صالح");
  const proxyToken = await ensureProxySecret(inst);
  if (!/^[a-f0-9]{64}$/.test(proxyToken)) throw new Error("رمز الوكيل غير صالح — أعد توليده");
  const controller = localPlatformIdentity();
  const outboundLinks = await db.select().from(agentControllerLinksTable).where(and(
    eq(agentControllerLinksTable.localAgentId, inst.id),
    eq(agentControllerLinksTable.direction, "outbound"),
  ));
  const newestLeadership = outboundLinks.reduce<typeof outboundLinks[number] | null>(
    (best, row) => !best || row.controllerEpoch > best.controllerEpoch ? row : best, null,
  );
  const controllerOrigins = [
    { platformId: controller.platformId, origin: controller.origin, auth: "license" },
    ...outboundLinks.map(row => ({ platformId: row.targetPlatformId, origin: row.targetOrigin,
      auth: "controllerToken", controllerToken: row.controllerTokenEnc ? decryptSecret(row.controllerTokenEnc) : "" })),
  ].filter((item, index, all) => all.findIndex(x => x.platformId === item.platformId) === index);
  const config = {
    domain: inst.domain,
    mode: inst.mode,
    localSuperadminEnabled: effectiveLocalSuperadminEnabled(inst.mode, inst.localSuperadminEnabled),
    localSuperadminScreens: effectiveLocalSuperadminEnabled(inst.mode, inst.localSuperadminEnabled)
      ? normalizeLocalSuperadminScreens(inst.localSuperadminScreens)
      : [],
    installationId: inst.installationId,
    licenseKey: inst.licenseKey ?? "",
    fingerprint: inst.dbFingerprint ?? "",
    centralOrigin: origin,
    controllerOrigins,
    activeControllerId: newestLeadership?.activeControllerId ?? controller.platformId,
    controllerEpoch: newestLeadership?.controllerEpoch ?? 0,
    heartbeatUrl: `${origin}/api/agent/heartbeat`,
    serverMarker: hbMarker,
  };
  const heartbeatScript = `#!/usr/bin/env bash
# zacod agent heartbeat — validates license/identity with the central platform.
# On a definitive 403 (suspended / revoked license) the local proxy is stopped.
CFG=/opt/zacod/config.json
# Every controller receives monitoring heartbeats. Only the active controller's
# definitive 403 can suspend this shell. A newer signed/controller state from
# either controller is adopted atomically without a service restart.
CODE=$(CFG="$CFG" node - <<'NODE'
const fs=require("node:fs");
(async()=>{const p=process.env.CFG,c=JSON.parse(fs.readFileSync(p,"utf8"));
const cs=Array.isArray(c.controllerOrigins)&&c.controllerOrigins.length?c.controllerOrigins:[{platformId:c.activeControllerId||"legacy",origin:c.centralOrigin}];
const base={installationId:c.installationId,domain:c.domain,fingerprint:c.fingerprint||"",serverMarker:c.serverMarker||"",controllerEpoch:Number(c.controllerEpoch)||0,activeControllerId:c.activeControllerId||"",version:(()=>{try{return fs.readFileSync("/opt/zacod/app/VERSION","utf8").trim()}catch{return ""}})()};
let best=Number(c.controllerEpoch)||0,bestId=c.activeControllerId,codes={};
for(const x of cs){try{const body={...base,...(x.auth==="controllerToken"?{controllerToken:x.controllerToken}:{licenseKey:c.licenseKey})};const r=await fetch(new URL("/api/agent/heartbeat",x.origin),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});codes[x.platformId]=r.status;const j=await r.json().catch(()=>null);if(r.ok&&Number.isSafeInteger(j?.controllerEpoch)&&cs.some(y=>y.platformId===j.activeControllerId)&&(j.controllerEpoch>best||(j.controllerEpoch===best&&String(j.activeControllerId)>String(bestId)))){best=j.controllerEpoch;bestId=j.activeControllerId}}catch{}}
if(best>Number(c.controllerEpoch||0)||(best===Number(c.controllerEpoch||0)&&bestId!==c.activeControllerId)){c.controllerEpoch=best;c.activeControllerId=bestId;const t=p+".tmp-"+process.pid;fs.writeFileSync(t,JSON.stringify(c,null,2),{mode:0o600});fs.renameSync(t,p)}console.log(codes[bestId]||0)})().catch(()=>console.log(0));
NODE
)
if [ "$CODE" = "403" ]; then
  touch /opt/zacod/SUSPENDED
  systemctl stop caddy 2>/dev/null || true
elif [ "$CODE" = "200" ] && [ -f /opt/zacod/SUSPENDED ]; then
  rm -f /opt/zacod/SUSPENDED
  systemctl start caddy 2>/dev/null || true
fi
${inst.mode === "full" ? "" : `# تحديث صفحة الواجهة المعدّلة بالعلامة التجارية — تُقدَّم محليًا عبر Caddy
# لمسارات الدخول (/ /login /register). فشل الجلب لا يؤثر: يبقى الملف السابق،
# وإن لم يوجد ملف يسقط Caddy تلقائيًا إلى الوكيل المركزي.
mkdir -p /opt/zacod/www
ORIGIN=$(grep -o '"centralOrigin": *"[^"]*"' $CFG | cut -d'"' -f4)
DOMAIN=$(grep -o '"domain": *"[^"]*"' $CFG | cut -d'"' -f4)
BCODE=$(curl -s -o /opt/zacod/www/index.html.tmp -w '%{http_code}' "$ORIGIN/api/branding/index?host=$DOMAIN" || echo 000)
if [ "$BCODE" = "200" ] && grep -q "<title>" /opt/zacod/www/index.html.tmp 2>/dev/null; then
  mv /opt/zacod/www/index.html.tmp /opt/zacod/www/index.html
else
  rm -f /opt/zacod/www/index.html.tmp
fi
`}`;
  // «full» edition runs the whole app locally. Caddy serves the uploaded
  // frontend itself and proxies only backend paths to the local Node service.
  // Proxying every path makes Express answer the browser shell with
  // "Cannot GET /", because the API bundle deliberately has no SPA fallback.
  const caddyfile = inst.mode === "full"
    ? `${inst.domain} {
  encode zstd gzip

  @backend {
    path /api /api/* /storage/* /objects/* /healthz /robots.txt /sitemap.xml
  }
  handle @backend {
    reverse_proxy 127.0.0.1:8080
  }

  handle /assets/* {
    root * /opt/zacod/app/public
    header Cache-Control "public, max-age=31536000, immutable"
    file_server
  }

  handle {
    root * /opt/zacod/app/public
    try_files {path} /index.html
    header Cache-Control "no-cache, no-store, must-revalidate"
    file_server
  }
}
`
    : `${inst.domain} {
  # صفحات الدخول تُقدَّم محليًا بنسخة معدّلة بالعلامة التجارية (يحدّثها كرون
  # النبض كل ٥ دقائق). إن لم يوجد الملف بعد، يسقط الطلب تلقائيًا إلى الوكيل.
  @branded {
    method GET
    path / /index.html /login /register
    file {
      root /opt/zacod/www
      try_files /index.html
    }
  }
  handle @branded {
    root * /opt/zacod/www
    rewrite * /index.html
    header Cache-Control no-cache
    file_server
  }
  handle {
    reverse_proxy ${origin} {
      header_up Host {upstream_hostport}
      header_up X-Zacod-Agent-Host ${inst.domain}
      header_up X-Zacod-Agent-Token ${proxyToken}
    }
  }
}
`;
  const safeSetupGuard = opts?.safeWebServerMode
    ? `# الوضع الآلي الآمن لا يوقف خدمات قائمة ولا يترك ملفات جزئية.
for svc in nginx apache2 httpd lighttpd; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    echo "ERROR: الخدمة $svc تستخدم بوابة الويب — أوقفها أو انقل إعدادها يدويًا ثم أعد المحاولة." >&2
    exit 1
  fi
done`
    + `
if systemctl is-active --quiet caddy 2>/dev/null; then
  if [ ! -f /opt/zacod/config.json ] || ! grep -Fq '"domain": "${inst.domain}"' /opt/zacod/config.json; then
    echo "ERROR: توجد خدمة Caddy غير مُدارة بواسطة هذا الوكيل — لن يتم استبدال إعدادها تلقائيًا." >&2
    exit 1
  fi
fi
ZACOD_SAFE_BAK=$(mktemp -d)
[ -f /opt/zacod/config.json ] && cp /opt/zacod/config.json "$ZACOD_SAFE_BAK/config.json" || touch "$ZACOD_SAFE_BAK/no-config"
[ -f /opt/zacod/heartbeat.sh ] && cp /opt/zacod/heartbeat.sh "$ZACOD_SAFE_BAK/heartbeat.sh" || touch "$ZACOD_SAFE_BAK/no-heartbeat"
[ -f /etc/caddy/Caddyfile ] && cp /etc/caddy/Caddyfile "$ZACOD_SAFE_BAK/Caddyfile" || touch "$ZACOD_SAFE_BAK/no-caddyfile"
crontab -l > "$ZACOD_SAFE_BAK/crontab" 2>/dev/null || touch "$ZACOD_SAFE_BAK/no-crontab"
zacod_safe_rollback() {
  rc=$?
  trap - EXIT
  if [ "$rc" -ne 0 ]; then
    mkdir -p /opt/zacod /etc/caddy
    if [ -f "$ZACOD_SAFE_BAK/no-config" ]; then rm -f /opt/zacod/config.json; else cp "$ZACOD_SAFE_BAK/config.json" /opt/zacod/config.json; fi
    if [ -f "$ZACOD_SAFE_BAK/no-heartbeat" ]; then rm -f /opt/zacod/heartbeat.sh; else cp "$ZACOD_SAFE_BAK/heartbeat.sh" /opt/zacod/heartbeat.sh; fi
    if [ -f "$ZACOD_SAFE_BAK/no-caddyfile" ]; then rm -f /etc/caddy/Caddyfile; else cp "$ZACOD_SAFE_BAK/Caddyfile" /etc/caddy/Caddyfile; fi
    if [ -f "$ZACOD_SAFE_BAK/no-crontab" ]; then crontab -r 2>/dev/null || true; else crontab "$ZACOD_SAFE_BAK/crontab" 2>/dev/null || true; fi
    systemctl restart caddy 2>/dev/null || true
  fi
  rm -rf "$ZACOD_SAFE_BAK"
  exit "$rc"
}
trap zacod_safe_rollback EXIT`
    : "";
  const webServerConflictPolicy = opts?.safeWebServerMode
    ? `# تم فحص التعارضات قبل أي كتابة؛ لا نوقف أي خدمة في الوضع الآلي.`
    : `# المسار اليدوي القديم يحافظ على سلوكه المتوافق كما كان قبل إضافة
# إدارة الدومين التلقائية.
for svc in nginx apache2 httpd lighttpd; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    echo "إيقاف الخدمة المتعارضة: $svc"
    systemctl stop "$svc" || true
    systemctl disable "$svc" 2>/dev/null || true
  fi
done`;
  const safeSetupCommit = opts?.safeWebServerMode
    ? `trap - EXIT
rm -rf "$ZACOD_SAFE_BAK"`
    : "";
  const installScript = `#!/usr/bin/env bash
# zacod agent bootstrap — idempotent. Run as root on the agent server.
set -e
${safeSetupGuard}
mkdir -p /opt/zacod
cat > /opt/zacod/config.json <<'ZACOD_CFG'
${JSON.stringify(config, null, 2)}
ZACOD_CFG
cat > /opt/zacod/heartbeat.sh <<'ZACOD_HB'
${heartbeatScript}
ZACOD_HB
chmod 700 /opt/zacod/heartbeat.sh; chmod 600 /opt/zacod/config.json
( crontab -l 2>/dev/null | grep -v zacod-heartbeat ; echo "*/5 * * * * /opt/zacod/heartbeat.sh # zacod-heartbeat" ) | crontab -
# حصانة دائمة ضد حظر fail2ban: أضف عنوان المنصة المتصلة حاليًا إلى القائمة
# البيضاء وفك أي حظر قائم — فلا تتعطل التحديثات المستقبلية بعد اليوم.
if command -v fail2ban-client >/dev/null 2>&1; then
  PLATFORM_IP=$(echo "$SSH_CONNECTION" | awk '{print $1}')
  if [ -n "$PLATFORM_IP" ]; then
    mkdir -p /etc/fail2ban/jail.d
    printf '[DEFAULT]\nignoreip = 127.0.0.1/8 ::1 %s\n' "$PLATFORM_IP" > /etc/fail2ban/jail.d/zacod-whitelist.conf
    fail2ban-client reload >/dev/null 2>&1 || systemctl restart fail2ban 2>/dev/null || true
    fail2ban-client unban --all >/dev/null 2>&1 || true
    echo "تمت إضافة عنوان المنصة ($PLATFORM_IP) إلى القائمة البيضاء لـ fail2ban."
  fi
fi
# Caddy is REQUIRED — any failure below aborts the script (set -e) so the
# central API records the deploy as failed instead of a silent half-install.
if ! command -v caddy >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    # caddy ليس في مستودعات أوبنتو/دبيان الافتراضية — أضف المستودع الرسمي أولاً.
    if ! apt-get install -y caddy 2>/dev/null; then
      apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
      curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
      apt-get update -y
      apt-get install -y caddy
    fi
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
${webServerConflictPolicy}
systemctl enable caddy
systemctl restart caddy
sleep 2
if ! systemctl is-active --quiet caddy; then
  echo "✖ خدمة Caddy لم تعمل — تفاصيل الخطأ:" >&2
  journalctl -u caddy -n 40 --no-pager 2>/dev/null | tail -n 40 >&2 || true
  (command -v ss >/dev/null 2>&1 && ss -ltnp | grep -E ':80 |:443 ' || true) >&2
  exit 1
fi
/opt/zacod/heartbeat.sh || true
${safeSetupCommit}
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

/** Best-effort only: synchronises controller metadata, never DB credentials or
 * service state. The caller intentionally does not restart the shell. */
async function syncShellControllerConfig(inst: typeof agentInstancesTable.$inferSelect): Promise<void> {
  const local = localPlatformIdentity();
  const links = await db.select().from(agentControllerLinksTable).where(and(
    eq(agentControllerLinksTable.localAgentId, inst.id), eq(agentControllerLinksTable.direction, "outbound"),
  ));
  const lead = links.reduce<typeof links[number] | null>((best, row) =>
    !best || row.controllerEpoch > best.controllerEpoch ? row : best, null);
  const controllers = [{ platformId: local.platformId, origin: local.origin, auth: "license" },
    ...links.map(x => ({ platformId: x.targetPlatformId, origin: x.targetOrigin, auth: "controllerToken",
      controllerToken: x.controllerTokenEnc ? decryptSecret(x.controllerTokenEnc) : "" }))]
    .filter((x, i, a) => a.findIndex(y => y.platformId === x.platformId) === i);
  const state = Buffer.from(JSON.stringify({
    controllerOrigins: controllers,
    activeControllerId: lead?.activeControllerId ?? local.platformId,
    controllerEpoch: lead?.controllerEpoch ?? 0,
  })).toString("base64");
  const result = await sshRunScript(inst, `set -e
STATE_B64='${state}' node - <<'NODE'
const fs=require("node:fs"); const p="/opt/zacod/config.json";
const add=JSON.parse(Buffer.from(process.env.STATE_B64,"base64").toString("utf8"));
const old=JSON.parse(fs.readFileSync(p,"utf8")); Object.assign(old,add);
const tmp=p+".tmp-"+process.pid; fs.writeFileSync(tmp,JSON.stringify(old,null,2),{mode:0o600}); fs.renameSync(tmp,p);
NODE
echo ZACOD_CONTROLLER_SYNCED`);
  if (result.code !== 0 || !result.out.includes("ZACOD_CONTROLLER_SYNCED")) {
    throw new Error("shell_controller_sync_failed");
  }
}

const REMOTE_CONTROL_LOCK = "/var/lock/zacod-control.lock";
const REMOTE_CONTROL_LEASE = "/var/tmp/zacod-control-lease";
const AGENT_OPERATION_HEARTBEAT_MS = 30_000;
const AGENT_OPERATION_STALE_MS = 3 * 60_000;

function assertOperationId(operationId: string): void {
  if (!/^[a-f0-9]{32}$/.test(operationId)) throw new Error("معرّف عملية التحكم غير صالح");
}

async function initializeRemoteOperationFence(
  inst: typeof agentInstancesTable.$inferSelect,
  operationId: string,
): Promise<void> {
  assertOperationId(operationId);
  await assertAgentOperationOwned(inst.id, operationId);
  const result = await sshRunScript(inst, `set -e
command -v flock >/dev/null 2>&1 || { echo "ZACOD_CONTROL_NO_FLOCK"; exit 73; }
exec 9>${REMOTE_CONTROL_LOCK}
flock -w 30 9 || { echo "ZACOD_CONTROL_BUSY"; exit 74; }
printf '%s' '${operationId}' > ${REMOTE_CONTROL_LEASE}
chmod 600 ${REMOTE_CONTROL_LEASE}
echo "ZACOD_CONTROL_READY"`, { timeoutMs: 45_000 });
  if (result.code !== 0 || !result.out.includes("ZACOD_CONTROL_READY")) {
    throw new Error(`تعذّر حجز قفل التحكم على السيرفر: ${result.out.slice(-400)}`);
  }
  await assertAgentOperationOwned(inst.id, operationId);
  await pinHostKey(inst, result.hostKeyFp);
}

async function sshRunOperationScript(
  inst: typeof agentInstancesTable.$inferSelect,
  operationId: string,
  script: string,
  opts?: { timeoutMs?: number },
): Promise<{ code: number; out: string; hostKeyFp: string }> {
  assertOperationId(operationId);
  return sshRunScript(inst, `set -e
command -v flock >/dev/null 2>&1 || { echo "ZACOD_CONTROL_NO_FLOCK"; exit 73; }
exec 9>${REMOTE_CONTROL_LOCK}
flock -w 30 9 || { echo "ZACOD_CONTROL_BUSY"; exit 74; }
CURRENT_CONTROL_LEASE="$(cat ${REMOTE_CONTROL_LEASE} 2>/dev/null || true)"
[ "$CURRENT_CONTROL_LEASE" = '${operationId}' ] || { echo "ZACOD_CONTROL_FENCE_LOST"; exit 75; }
${script}`, opts);
}

async function revokeRemoteOperationFence(
  inst: typeof agentInstancesTable.$inferSelect,
  recoveryId: string,
): Promise<{ ok: boolean; log: string }> {
  assertOperationId(recoveryId);
  const result = await sshRunScript(inst, `set -e
command -v flock >/dev/null 2>&1 || { echo "ZACOD_CONTROL_NO_FLOCK"; exit 73; }
exec 9>${REMOTE_CONTROL_LOCK}
flock -w 55 9 || { echo "ZACOD_CONTROL_BUSY"; exit 74; }
printf '%s' 'recovered-${recoveryId}' > ${REMOTE_CONTROL_LEASE}
chmod 600 ${REMOTE_CONTROL_LEASE}
echo "ZACOD_CONTROL_REVOKED"`, { timeoutMs: 70_000 });
  return {
    ok: result.code === 0 && result.out.includes("ZACOD_CONTROL_REVOKED"),
    log: result.out.slice(-700),
  };
}

function startAgentOperationHeartbeat(id: number, operationId: string): () => void {
  let stopped = false;
  const beat = () => {
    if (stopped) return;
    void db.update(agentInstancesTable).set({ updatedAt: new Date() }).where(and(
      eq(agentInstancesTable.id, id),
      eq(agentInstancesTable.deployStatus, "deploying"),
      eq(agentInstancesTable.deployLeaseId, operationId),
    )).catch(() => {});
  };
  const timer = setInterval(beat, AGENT_OPERATION_HEARTBEAT_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function assertAgentOperationOwned(id: number, operationId: string): Promise<void> {
  const [owned] = await db.select({ id: agentInstancesTable.id }).from(agentInstancesTable).where(and(
    eq(agentInstancesTable.id, id),
    eq(agentInstancesTable.deployStatus, "deploying"),
    eq(agentInstancesTable.deployLeaseId, operationId),
  )).limit(1);
  if (!owned) throw new Error("فُقد قفل العملية؛ أُوقفت المهمة القديمة");
}

async function runFencedProviderMutation<T>(
  id: number,
  operationId: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const providerUntil = new Date(Date.now() + 60_000);
  const claimed = await db.update(agentInstancesTable).set({
    deployOperationPhase: "provider_mutation",
    deployProviderMutationUntil: providerUntil,
    updatedAt: new Date(),
  }).where(and(
    eq(agentInstancesTable.id, id),
    eq(agentInstancesTable.deployStatus, "deploying"),
    eq(agentInstancesTable.deployLeaseId, operationId),
  )).returning({ id: agentInstancesTable.id });
  if (!claimed.length) throw new Error("فُقد قفل العملية قبل تحديث مزود DNS");
  try {
    const result = await mutation();
    await assertAgentOperationOwned(id, operationId);
    return result;
  } finally {
    await db.update(agentInstancesTable).set({
      deployOperationPhase: "running",
      deployProviderMutationUntil: null,
      updatedAt: new Date(),
    }).where(and(
      eq(agentInstancesTable.id, id),
      eq(agentInstancesTable.deployStatus, "deploying"),
      eq(agentInstancesTable.deployLeaseId, operationId),
    )).catch(() => {});
  }
}

// Deliberate recovery for a worker lost to an API process restart/crash.
// It never "steals" a live lease by age alone: first fence the old worker in
// the database, then take the remote flock and replace the remote generation.
// Only after both fences are established is the shared lease released.
router.post("/:id/operation/recover", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  if (inst.deployStatus !== "deploying" || !inst.deployLeaseId) {
    res.status(409).json({ error: "لا توجد عملية معلّقة قابلة للاستعادة" });
    return;
  }
  const staleBefore = new Date(Date.now() - AGENT_OPERATION_STALE_MS);
  if (inst.updatedAt.getTime() >= staleBefore.getTime()) {
    res.status(409).json({ error: "العملية ما زالت ترسل نبضات؛ انتظر قبل محاولة الاستعادة" });
    return;
  }
  if (
    inst.deployOperationPhase === "provider_mutation"
    && (!inst.deployProviderMutationUntil || inst.deployProviderMutationUntil.getTime() > Date.now())
  ) {
    res.status(409).json({ error: "يوجد طلب DNS لم تنتهِ مهلة أمانه بعد؛ أعد المحاولة لاحقًا" });
    return;
  }
  if (!inst.sshHost || !inst.sshUser || !inst.sshSecretEnc) {
    res.status(409).json({ error: "لا يمكن إثبات توقف العملية البعيدة دون بيانات SSH محفوظة" });
    return;
  }
  const isSchemaUpgrade = typeof inst.deployOperationPhase === "string"
    && inst.deployOperationPhase.startsWith("schema_");

  const oldOperationId = inst.deployLeaseId;
  const recoveryId = randomBytes(16).toString("hex");
  const [claimed] = await db.update(agentInstancesTable).set({
    deployLeaseId: recoveryId,
    deployOperationPhase: "recovering",
    deployProviderMutationUntil: null,
    updatedAt: new Date(),
  }).where(and(
    eq(agentInstancesTable.id, id),
    eq(agentInstancesTable.deployStatus, "deploying"),
    eq(agentInstancesTable.deployLeaseId, oldOperationId),
    lt(agentInstancesTable.updatedAt, staleBefore),
  )).returning({ id: agentInstancesTable.id });
  if (!claimed) {
    res.status(409).json({ error: "تجددت العملية أو بدأت استعادة أخرى؛ حدّث الصفحة" });
    return;
  }

  let remote: { ok: boolean; log: string };
  let schemaServiceResumed = !isSchemaUpgrade;
  try {
    if (isSchemaUpgrade) {
      await withAgentSchemaUpgradeLock(inst, async () => {
        remote = await revokeRemoteOperationFence(inst, recoveryId);
        if (!remote.ok) return;
        const resumed = await resumeAgentServiceAfterSchemaUpgrade(inst, recoveryId);
        schemaServiceResumed = resumed.ok;
        if (!resumed.ok) remote = { ok: false, log: `تعذّر استئناف خدمة الوكيل: ${resumed.log}` };
      });
    } else {
      remote = await revokeRemoteOperationFence(inst, recoveryId);
    }
  } catch (e: any) {
    remote = { ok: false, log: String(e?.message ?? e).slice(0, 500) };
  }
  if (!remote.ok) {
    const log = `${inst.deployLog ?? ""}\n[recovery] لم يثبت توقف العملية البعيدة: ${remote.log}`.slice(-8000);
    await db.update(agentInstancesTable).set({
      deployLog: log,
      updatedAt: new Date(),
    }).where(and(
      eq(agentInstancesTable.id, id),
      eq(agentInstancesTable.deployLeaseId, recoveryId),
    )).catch(() => {});
    res.status(409).json({
      error: "لم يثبت توقف السكربت البعيد؛ بقي القفل مغلقًا بأمان. أعد المحاولة لاحقًا.",
      detail: remote.log,
    });
    return;
  }
  if (isSchemaUpgrade && !schemaServiceResumed) {
    res.status(409).json({ error: "تعذّر استئناف خدمة الوكيل؛ بقي القفل مغلقًا." });
    return;
  }

  const recoveryMessage = "أُوقفت المهمة المفقودة بأمان بعد انقطاع نبضها؛ يمكنك إعادة المحاولة.";
  const [released] = await db.update(agentInstancesTable).set({
    deployStatus: "error",
    deployLeaseId: null,
    deployOperationPhase: null,
    deployProviderMutationUntil: null,
    ...(isSchemaUpgrade ? {
      dbStatus: "error",
      dbLastCheckAt: new Date(),
      dbLastError: "توقفت ترقية مخطط قاعدة البيانات قبل التحقق النهائي؛ أعد تشغيل أداة الترقية",
    } : {}),
    autoDomainLeaseAt: null,
    deployLog: `${inst.deployLog ?? ""}\n[recovery] ${recoveryMessage}`.slice(-8000),
    ...(inst.autoDomainSetup ? {
      autoDomainStatus: "error",
      autoDomainLastCheckAt: new Date(),
      autoDomainLastError: recoveryMessage,
    } : {}),
    updatedAt: new Date(),
  }).where(and(
    eq(agentInstancesTable.id, id),
    eq(agentInstancesTable.deployStatus, "deploying"),
    eq(agentInstancesTable.deployLeaseId, recoveryId),
  )).returning({ id: agentInstancesTable.id });
  if (!released) {
    res.status(409).json({ error: "فُقد قفل الاستعادة قبل إنهائها؛ حدّث الصفحة" });
    return;
  }
  await logAgentEvent(id, "agent_operation_recovered", {
    by: (req as any).authUser?.username ?? null,
    priorOperation: oldOperationId.slice(0, 8),
  }, req);
  res.json({ ok: true, recovered: true, message: recoveryMessage });
});

/** Persist the TOFU host-key pin after a successful script run. */
async function pinHostKey(inst: typeof agentInstancesTable.$inferSelect, fp: string): Promise<void> {
  if (!inst.sshHostKeyFp && fp) {
    await db.update(agentInstancesTable).set({ sshHostKeyFp: fp }).where(eq(agentInstancesTable.id, inst.id)).catch(() => {});
    (inst as any).sshHostKeyFp = fp; // later steps in the same pipeline verify strictly
  }
}

// ── Optional automatic main-domain setup (Cloudflare + firewall + Caddy) ───

type AutoDomainPortProbe = {
  port: 80 | 443;
  state: "open" | "refused" | "timeout";
  ms: number;
};

type AutoDomainServerPreview = {
  host: string;
  originIp: string;
  sshAuthenticated: boolean;
  firewall: "ufw" | "firewalld" | "none";
  activeServices: string[];
  caddyManaged: boolean;
  conflicts: string[];
  ports: AutoDomainPortProbe[];
};

type AutoDomainConfirmationPayload = {
  v: 1;
  agentId: number;
  domain: string;
  originIp: string;
  zoneId: string;
  zoneName: string;
  action: CloudflareARecordPlan["action"];
  existingRecordId: string | null;
  existingContent: string | null;
  desiredProxied: boolean;
  exp: number;
};

function mintAutoDomainConfirmation(payload: Omit<AutoDomainConfirmationPayload, "v" | "exp">): string {
  const body = Buffer.from(JSON.stringify({
    v: 1,
    ...payload,
    exp: Date.now() + 15 * 60_000,
  } satisfies AutoDomainConfirmationPayload)).toString("base64url");
  return `${body}.${hmacSign(`auto-domain:${body}`)}`;
}

function verifyAutoDomainConfirmation(raw: unknown): AutoDomainConfirmationPayload {
  if (typeof raw !== "string" || raw.length < 40 || raw.length > 3000) {
    throw Object.assign(new Error("أعد معاينة خطة الدومين ثم أكدها"), { httpStatus: 400 });
  }
  const [body, signature, extra] = raw.split(".");
  if (!body || !signature || extra) {
    throw Object.assign(new Error("تأكيد خطة الدومين غير صالح"), { httpStatus: 400 });
  }
  const expected = hmacSign(`auto-domain:${body}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw Object.assign(new Error("تأكيد خطة الدومين غير صالح"), { httpStatus: 400 });
  }
  let payload: AutoDomainConfirmationPayload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
  catch { throw Object.assign(new Error("تأكيد خطة الدومين غير صالح"), { httpStatus: 400 }); }
  if (payload.v !== 1 || payload.exp < Date.now()) {
    throw Object.assign(new Error("انتهت صلاحية المعاينة — أعد الفحص قبل التنفيذ"), { httpStatus: 409 });
  }
  return payload;
}

function assertAutoDomainPlanConfirmed(
  inst: typeof agentInstancesTable.$inferSelect,
  payload: AutoDomainConfirmationPayload,
  plan: CloudflareARecordPlan,
): void {
  const same = payload.agentId === inst.id
    && payload.domain === inst.domain
    && payload.originIp === plan.originIp
    && payload.zoneId === plan.zoneId
    && payload.zoneName === plan.zoneName
    && payload.action === plan.action
    && payload.existingRecordId === plan.existingRecordId
    && payload.existingContent === plan.existingContent
    && payload.desiredProxied === plan.desiredProxied;
  if (!same) {
    throw Object.assign(new Error("تغيرت حالة الدومين أو السيرفر بعد المعاينة — أعد الفحص والتأكيد"), { httpStatus: 409 });
  }
}

async function resolveAutoDomainOriginIp(host: string | null): Promise<string> {
  if (!host) throw new Error("أدخل Host / IP لسيرفر الوكيل أولًا");
  await assertProbeTargetAllowed(host);
  const candidates = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await dnsLookup(host, { all: true });
  for (const row of candidates) {
    if (row.family !== 4) continue;
    try { validatePublicIpv4(row.address); return row.address; }
    catch { /* try the next public IPv4 */ }
  }
  throw new Error("مضيف SSH لا يملك عنوان IPv4 عامًا صالحًا لسجل Cloudflare A");
}

function probeAutoDomainPort(host: string, port: 80 | 443, timeoutMs = 6000): Promise<AutoDomainPortProbe> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port, timeout: timeoutMs });
    let done = false;
    const finish = (state: AutoDomainPortProbe["state"]) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ port, state, ms: Date.now() - started });
    };
    socket.on("connect", () => finish("open"));
    socket.on("timeout", () => finish("timeout"));
    socket.on("error", (e: any) => finish(e?.code === "ECONNREFUSED" ? "refused" : "timeout"));
  });
}

async function inspectAutoDomainServer(
  inst: typeof agentInstancesTable.$inferSelect,
  originIp: string,
): Promise<AutoDomainServerPreview> {
  if (!inst.sshHost || !inst.sshUser || !inst.sshSecretEnc) {
    throw new Error("أكمل بيانات SSH وكلمة المرور/المفتاح قبل الإعداد التلقائي");
  }
  assertSafeDomain(inst.domain);
  const script = `set -e
ACTIVE=""
for svc in caddy nginx apache2 httpd lighttpd; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then ACTIVE="\${ACTIVE}\${ACTIVE:+,}$svc"; fi
done
CADDY_MANAGED=0
if echo ",$ACTIVE," | grep -q ',caddy,' && [ -f /opt/zacod/config.json ] && grep -Fq '"domain": "${inst.domain}"' /opt/zacod/config.json; then CADDY_MANAGED=1; fi
FIREWALL=none
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then FIREWALL=ufw
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state 2>/dev/null | grep -q running; then FIREWALL=firewalld; fi
echo "ZACOD_PREFLIGHT_OK"
echo "ACTIVE=$ACTIVE"
echo "CADDY_MANAGED=$CADDY_MANAGED"
echo "FIREWALL=$FIREWALL"`;
  const [ssh, port80, port443] = await Promise.all([
    sshRunScript(inst, script, { timeoutMs: 35_000 }),
    probeAutoDomainPort(originIp, 80),
    probeAutoDomainPort(originIp, 443),
  ]);
  if (ssh.code !== 0 || !ssh.out.includes("ZACOD_PREFLIGHT_OK")) {
    throw new Error(`تعذّر فحص خدمات السيرفر: ${ssh.out.slice(-500)}`);
  }
  await pinHostKey(inst, ssh.hostKeyFp);
  const activeServices = (ssh.out.match(/^ACTIVE=(.*)$/m)?.[1] ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const caddyManaged = (ssh.out.match(/^CADDY_MANAGED=(.*)$/m)?.[1] ?? "") === "1";
  const firewallRaw = ssh.out.match(/^FIREWALL=(.*)$/m)?.[1];
  const firewall: AutoDomainServerPreview["firewall"] =
    firewallRaw === "ufw" ? "ufw" : firewallRaw === "firewalld" ? "firewalld" : "none";
  const conflicts: string[] = [];
  for (const service of activeServices) {
    if (service !== "caddy") conflicts.push(`الخدمة ${service} تعمل على بوابة الويب ولن يتم إيقافها تلقائيًا`);
  }
  if (activeServices.includes("caddy") && !caddyManaged) {
    conflicts.push("خدمة Caddy الحالية غير مُدارة بواسطة هذا الوكيل ولن يتم استبدال إعدادها");
  }
  return {
    host: inst.sshHost,
    originIp,
    sshAuthenticated: true,
    firewall,
    activeServices,
    caddyManaged,
    conflicts,
    ports: [port80, port443],
  };
}

async function buildAutoDomainPreview(inst: typeof agentInstancesTable.$inferSelect) {
  if (!inst.autoDomainSetup) throw Object.assign(new Error("فعّل خيار الإعداد التلقائي للدومين واحفظ الوكيل أولًا"), { httpStatus: 400 });
  if (!isCloudflareDnsConfigured()) {
    throw Object.assign(new Error("Cloudflare غير متصل بالمنصة — اربط الحساب أو أضف CLOUDFLARE_API_TOKEN في Secrets ثم أعد الفحص"), {
      httpStatus: 409,
      code: "CLOUDFLARE_NOT_CONFIGURED",
    });
  }
  const originIp = await resolveAutoDomainOriginIp(inst.sshHost);
  const [plan, server] = await Promise.all([
    planCloudflareARecord({
      domain: inst.domain,
      originIp,
      desiredProxied: inst.autoDomainProxyEnabled,
    }),
    inspectAutoDomainServer(inst, originIp),
  ]);
  const warnings: string[] = [];
  if (server.ports.some(p => p.state !== "open")) warnings.push("سيتم فتح 80 و443 في UFW/firewalld المحلي عند الحاجة ثم إعادة فحصهما من الخارج");
  if (server.firewall === "none" && server.ports.some(p => p.state === "timeout")) {
    warnings.push("قد يكون الحجب من جدار مزود الاستضافة أو Security Group؛ لا يمكن فتحه عبر SSH");
  }
  if (inst.autoDomainProxyEnabled) warnings.push("سيبقى Cloudflare Proxy متوقفًا حتى نجاح SSL على السيرفر، ثم يُفعّل تلقائيًا");
  const canUsePlan = plan.action !== "conflict" && server.conflicts.length === 0;
  const confirmationToken = canUsePlan
    ? mintAutoDomainConfirmation({
        agentId: inst.id,
        domain: inst.domain,
        originIp,
        zoneId: plan.zoneId,
        zoneName: plan.zoneName,
        action: plan.action,
        existingRecordId: plan.existingRecordId,
        existingContent: plan.existingContent,
        desiredProxied: plan.desiredProxied,
      })
    : null;
  return {
    ok: true,
    confirmationToken,
    canApplyNow: canUsePlan && inst.deployStatus === "ok",
    canUseWithProvision: canUsePlan,
    checkedAt: new Date().toISOString(),
    cloudflare: {
      connected: true,
      zoneName: plan.zoneName,
      action: plan.action,
      existingType: plan.existingType,
      existingContent: plan.existingContent,
      existingProxied: plan.existingProxied,
      desiredContent: plan.originIp,
      desiredProxied: plan.desiredProxied,
      conflict: plan.action === "conflict" ? plan.explanation : null,
    },
    server,
    warnings,
  };
}

async function replanConfirmedAutoDomain(
  inst: typeof agentInstancesTable.$inferSelect,
  rawToken: unknown,
): Promise<CloudflareARecordPlan> {
  const payload = verifyAutoDomainConfirmation(rawToken);
  const originIp = await resolveAutoDomainOriginIp(inst.sshHost);
  const plan = await planCloudflareARecord({
    domain: inst.domain,
    originIp,
    desiredProxied: inst.autoDomainProxyEnabled,
  });
  assertAutoDomainPlanConfirmed(inst, payload, plan);
  if (plan.action === "conflict") throw Object.assign(new Error("يوجد تعارض في سجل DNS — أعد المعاينة"), { httpStatus: 409 });
  return plan;
}

async function updateAutoDomainLease(
  id: number,
  operationId: string,
  patch: Partial<typeof agentInstancesTable.$inferInsert>,
): Promise<void> {
  const rows = await db.update(agentInstancesTable).set({ ...patch, updatedAt: new Date() })
    .where(and(
      eq(agentInstancesTable.id, id),
      eq(agentInstancesTable.deployStatus, "deploying"),
      eq(agentInstancesTable.deployLeaseId, operationId),
    ))
    .returning({ id: agentInstancesTable.id });
  if (!rows.length) throw new Error("تم إلغاء مهمة الدومين أو استبدالها بمهمة أحدث");
}

async function openAutoDomainWebPorts(
  inst: typeof agentInstancesTable.$inferSelect,
  operationId: string,
): Promise<string> {
  const script = `set -e
FW=none
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw allow 80/tcp comment 'Zacod HTTP/ACME' >/dev/null
  ufw allow 443/tcp comment 'Zacod HTTPS' >/dev/null
  FW=ufw
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state 2>/dev/null | grep -q running; then
  firewall-cmd --permanent --add-service=http >/dev/null
  firewall-cmd --permanent --add-service=https >/dev/null
  firewall-cmd --reload >/dev/null
  FW=firewalld
fi
echo "ZACOD_PORTS_READY firewall=$FW"`;
  const result = await sshRunOperationScript(inst, operationId, script, { timeoutMs: 60_000 });
  if (result.code !== 0 || !result.out.includes("ZACOD_PORTS_READY")) {
    throw new Error(`فشل إعداد منافذ الويب محليًا: ${result.out.slice(-500)}`);
  }
  await pinHostKey(inst, result.hostKeyFp);
  return result.out.trim().slice(-500);
}

function autoDomainWaitConfig(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : fallback;
}

async function waitForAutoDomainDns(domain: string, originIp: string): Promise<void> {
  const timeoutMs = autoDomainWaitConfig("AUTO_DOMAIN_DNS_WAIT_MS", 180_000);
  const intervalMs = autoDomainWaitConfig("AUTO_DOMAIN_RETRY_MS", 5_000);
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const ips = (await dnsLookup(domain, { all: true })).map(x => x.address);
      last = ips.join(", ");
      if (ips.includes(originIp)) return;
    } catch { last = "DNS غير متاح"; }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`لم ينتشر سجل DNS إلى ${originIp} خلال المهلة (الحالي: ${last || "لا يوجد"})`);
}

function probeAutoDomainHttps(domain: string, originIp: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      host: domain,
      servername: domain,
      port: 443,
      path: "/",
      method: "GET",
      timeout: 10_000,
      lookup: ((_host: string, opts: any, cb: any) => {
        if (typeof opts === "function") { opts(null, originIp, 4); return; }
        if (opts?.all) cb(null, [{ address: originIp, family: 4 }]);
        else cb(null, originIp, 4);
      }) as any,
    }, response => {
      const status = response.statusCode ?? 0;
      response.resume();
      resolve(status);
    });
    request.on("timeout", () => request.destroy(new Error("HTTPS timeout")));
    request.on("error", reject);
    request.end();
  });
}

async function waitForAutoDomainHttps(domain: string, originIp: string): Promise<number> {
  const timeoutMs = autoDomainWaitConfig("AUTO_DOMAIN_HTTPS_WAIT_MS", 180_000);
  const intervalMs = autoDomainWaitConfig("AUTO_DOMAIN_RETRY_MS", 5_000);
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try { return await probeAutoDomainHttps(domain, originIp); }
    catch (e: any) { lastError = String(e?.message ?? e).slice(0, 180); }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`تعذّر التحقق من HTTPS والشهادة عبر 443 (${lastError || "انتهت المهلة"})`);
}

async function prepareAutoDomainInfrastructure(
  inst: typeof agentInstancesTable.$inferSelect,
  plan: CloudflareARecordPlan,
  operationId: string,
  log: string[],
): Promise<AppliedRecord> {
  await updateAutoDomainLease(inst.id, operationId, {
    autoDomainStatus: "configuring",
    autoDomainLastError: null,
    autoDomainOriginIp: plan.originIp,
    autoDomainZoneName: plan.zoneName,
    autoDomainZoneId: plan.zoneId,
  });
  const server = await inspectAutoDomainServer(inst, plan.originIp);
  if (server.conflicts.length) throw new Error(server.conflicts.join(" — "));
  log.push(`Cloudflare: ${plan.action} ${inst.domain} → ${plan.originIp} (proxy مؤقتًا متوقف)`);
  const applied = await runFencedProviderMutation(
    inst.id,
    operationId,
    () => applyCloudflareARecord(plan, { forceProxied: false }),
  );
  await updateAutoDomainLease(inst.id, operationId, {
    autoDomainRecordId: applied.id,
    autoDomainStatus: "configuring",
  });
  log.push(`DNS محفوظ بأمان داخل النطاق ${plan.zoneName}.`);
  log.push(await openAutoDomainWebPorts(inst, operationId));
  return applied;
}

async function verifyPreparedAutoDomain(
  inst: typeof agentInstancesTable.$inferSelect,
  plan: CloudflareARecordPlan,
  applied: AppliedRecord,
  operationId: string,
  log: string[],
): Promise<void> {
  await updateAutoDomainLease(inst.id, operationId, { autoDomainStatus: "waiting_dns" });
  await waitForAutoDomainDns(inst.domain, plan.originIp);
  log.push(`DNS يشير إلى ${plan.originIp}.`);
  await updateAutoDomainLease(inst.id, operationId, { autoDomainStatus: "verifying" });
  const httpStatus = await waitForAutoDomainHttps(inst.domain, plan.originIp);
  log.push(`HTTPS صالح ويستجيب بالحالة ${httpStatus}.`);
  if (plan.desiredProxied) {
    await runFencedProviderMutation(inst.id, operationId, () => updateCloudflareProxy({
        zoneId: plan.zoneId,
        recordId: applied.id,
        domain: inst.domain,
        originIp: plan.originIp,
        proxied: true,
      }));
    log.push("تم تفعيل Cloudflare Proxy بعد نجاح SSL.");
  }
  await updateAutoDomainLease(inst.id, operationId, {
    autoDomainStatus: "ready",
    autoDomainLastSuccessAt: new Date(),
    autoDomainLastCheckAt: new Date(),
    autoDomainLastError: null,
    autoDomainLog: log.join("\n").slice(-8000),
  });
}

async function failPreparedAutoDomain(id: number, operationId: string, error: unknown, log: string[]): Promise<void> {
  const message = String((error as any)?.message ?? error).slice(0, 500);
  log.push(`✖ ${message}`);
  await updateAutoDomainLease(id, operationId, {
    autoDomainStatus: "error",
    autoDomainLastCheckAt: new Date(),
    autoDomainLastError: message,
    autoDomainLog: log.join("\n").slice(-8000),
  }).catch(() => {});
}

async function runStandaloneAutoDomain(
  inst: typeof agentInstancesTable.$inferSelect,
  plan: CloudflareARecordPlan,
  operationId: string,
  previousDeployStatus: string,
  stopHeartbeat: () => void,
): Promise<void> {
  const log = ["■ بدء إعداد الدومين التلقائي"];
  try {
    const applied = await prepareAutoDomainInfrastructure(inst, plan, operationId, log);
    const { installScript } = await buildSetupKit(inst, { safeWebServerMode: true });
    const installed = await sshRunOperationScript(inst, operationId, installScript, { timeoutMs: 300_000 });
    log.push(installed.out.slice(-2500));
    if (installed.code !== 0 || !installed.out.includes("ZACOD_BOOTSTRAP_DONE")) {
      throw new Error("فشل إعداد Caddy — راجع سجل الدومين");
    }
    await pinHostKey(inst, installed.hostKeyFp);
    await verifyPreparedAutoDomain(inst, plan, applied, operationId, log);
    await db.update(agentInstancesTable).set({
      deployStatus: previousDeployStatus,
      deployLeaseId: null,
      deployOperationPhase: null,
      deployProviderMutationUntil: null,
      autoDomainLeaseAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(agentInstancesTable.id, inst.id),
      eq(agentInstancesTable.deployLeaseId, operationId),
      eq(agentInstancesTable.deployStatus, "deploying"),
    ));
    await logAgentEvent(inst.id, "auto_domain_ready", {
      domain: inst.domain,
      zone: plan.zoneName,
      originIp: plan.originIp,
      proxied: plan.desiredProxied,
    });
  } catch (error) {
    await failPreparedAutoDomain(inst.id, operationId, error, log);
    await db.update(agentInstancesTable).set({
      deployStatus: previousDeployStatus,
      deployLeaseId: null,
      deployOperationPhase: null,
      deployProviderMutationUntil: null,
      autoDomainLeaseAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(agentInstancesTable.id, inst.id),
      eq(agentInstancesTable.deployLeaseId, operationId),
      eq(agentInstancesTable.deployStatus, "deploying"),
    )).catch(() => {});
    await logAgentEvent(inst.id, "auto_domain_failed", {
      domain: inst.domain,
      error: String((error as any)?.message ?? error).slice(0, 300),
    });
  } finally {
    stopHeartbeat();
  }
}

// Read-only preview. It may persist safe diagnostics, but never mutates
// Cloudflare, firewall rules, Caddy, or any unrelated DNS record.
router.post("/:id/auto-domain/preview", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  if (inst.deployStatus === "deploying") {
    res.status(409).json({ error: "انتظر انتهاء العملية الجارية قبل معاينة الدومين" });
    return;
  }
  try {
    const checking = await db.update(agentInstancesTable).set({
      autoDomainStatus: "checking",
      autoDomainLastError: null,
      updatedAt: new Date(),
    }).where(and(
      eq(agentInstancesTable.id, id),
      ne(agentInstancesTable.deployStatus, "deploying"),
    )).returning({ id: agentInstancesTable.id });
    if (!checking.length) {
      res.status(409).json({ error: "بدأت عملية أخرى قبل معاينة الدومين" });
      return;
    }
    const preview = await buildAutoDomainPreview(inst);
    const saved = await db.update(agentInstancesTable).set({
      autoDomainStatus: preview.confirmationToken ? "pending" : "error",
      autoDomainLastCheckAt: new Date(),
      autoDomainLastError: preview.confirmationToken
        ? null
        : (preview.cloudflare.conflict || preview.server.conflicts.join(" — ") || "لا يمكن تنفيذ الخطة"),
      autoDomainZoneName: preview.cloudflare.zoneName,
      autoDomainOriginIp: preview.server.originIp,
      updatedAt: new Date(),
    }).where(and(
      eq(agentInstancesTable.id, id),
      ne(agentInstancesTable.deployStatus, "deploying"),
    )).returning({ id: agentInstancesTable.id });
    if (!saved.length) {
      res.status(409).json({ error: "بدأت عملية أخرى أثناء المعاينة؛ أعد الفحص بعد انتهائها" });
      return;
    }
    await logAgentEvent(id, "auto_domain_previewed", {
      by: (req as any).authUser?.username ?? null,
      zone: preview.cloudflare.zoneName,
      action: preview.cloudflare.action,
      originIp: preview.server.originIp,
      canApply: !!preview.confirmationToken,
    }, req);
    res.json(preview);
  } catch (e: any) {
    const message = e instanceof CfDnsError && e.code === "CF_TOKEN_MISSING"
      ? "Cloudflare غير متصل بالمنصة — أضف الاتصال الآمن ثم أعد الفحص"
      : String(e?.message ?? e).slice(0, 500);
    await db.update(agentInstancesTable).set({
      autoDomainStatus: "error",
      autoDomainLastCheckAt: new Date(),
      autoDomainLastError: message,
      updatedAt: new Date(),
    }).where(and(
      eq(agentInstancesTable.id, id),
      ne(agentInstancesTable.deployStatus, "deploying"),
    )).catch(() => {});
    res.status(Number(e?.httpStatus) || (e instanceof CfDnsError ? 409 : 502)).json({
      error: message,
      code: e?.code ?? null,
    });
  }
});

// Explicit action for an already-installed agent. New agents pass the same
// signed preview token to /provision so both jobs share one deploy lease.
router.post("/:id/auto-domain/apply", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  if (!inst.autoDomainSetup) { res.status(400).json({ error: "الإعداد التلقائي غير مفعّل لهذا الوكيل" }); return; }
  if (inst.deployStatus !== "ok") {
    res.status(409).json({ error: "الوكيل غير مُسطّب بعد — استخدم «تسطيب كامل» وأكد خطة الدومين داخل نافذة التسطيب" });
    return;
  }
  // Reject malformed/expired confirmation before taking the shared lease.
  try { verifyAutoDomainConfirmation(req.body?.confirmationToken); }
  catch (e: any) {
    res.status(Number(e?.httpStatus) || 409).json({ error: String(e?.message ?? e).slice(0, 500), code: e?.code ?? null });
    return;
  }
  const leaseAt = new Date();
  const operationId = randomBytes(16).toString("hex");
  const claimed = await db.update(agentInstancesTable).set({
    deployStatus: "deploying",
    deployLeaseId: operationId,
    deployOperationPhase: "preflight",
    deployProviderMutationUntil: null,
    autoDomainStatus: "configuring",
    autoDomainLeaseAt: leaseAt,
    autoDomainLastError: null,
    updatedAt: leaseAt,
  }).where(and(
    eq(agentInstancesTable.id, id),
    eq(agentInstancesTable.deployStatus, "ok"),
  )).returning({ id: agentInstancesTable.id });
  if (!claimed.length) { res.status(409).json({ error: "يوجد نشر/تسطيب أو إعداد دومين جارٍ بالفعل" }); return; }
  const stopHeartbeat = startAgentOperationHeartbeat(id, operationId);
  let plan: CloudflareARecordPlan;
  let fresh: typeof agentInstancesTable.$inferSelect;
  try {
    const [claimedRow] = await db.select().from(agentInstancesTable).where(and(
      eq(agentInstancesTable.id, id),
      eq(agentInstancesTable.deployLeaseId, operationId),
    )).limit(1);
    if (!claimedRow) throw new Error("فُقد قفل عملية إعداد الدومين");
    fresh = claimedRow;
    // Final DNS/server re-plan happens only after the target is fenced.
    plan = await replanConfirmedAutoDomain(fresh, req.body?.confirmationToken);
    const server = await inspectAutoDomainServer(fresh, plan.originIp);
    if (server.conflicts.length) throw Object.assign(new Error(server.conflicts.join(" — ")), { httpStatus: 409 });
    await initializeRemoteOperationFence(fresh, operationId);
  } catch (e: any) {
    await db.update(agentInstancesTable).set({
      deployStatus: "ok",
      deployLeaseId: null,
      deployOperationPhase: null,
      deployProviderMutationUntil: null,
      autoDomainLeaseAt: null,
      autoDomainStatus: "error",
      autoDomainLastCheckAt: new Date(),
      autoDomainLastError: String(e?.message ?? e).slice(0, 500),
      updatedAt: new Date(),
    }).where(and(
      eq(agentInstancesTable.id, id),
      eq(agentInstancesTable.deployLeaseId, operationId),
    )).catch(() => {});
    stopHeartbeat();
    res.status(Number(e?.httpStatus) || 409).json({ error: String(e?.message ?? e).slice(0, 500), code: e?.code ?? null });
    return;
  }
  await logAgentEvent(id, "auto_domain_started", {
    by: (req as any).authUser?.username ?? null,
    zone: plan.zoneName,
    action: plan.action,
    originIp: plan.originIp,
  }, req).catch(() => {});
  res.json({ ok: true, started: true });
  void runStandaloneAutoDomain(fresh, plan, operationId, inst.deployStatus, stopHeartbeat);
});

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
  // Atomic claim with a unique fencing token. Running jobs are never stolen
  // merely because their wall-clock age crossed an arbitrary threshold.
  const operationId = randomBytes(16).toString("hex");
  const claimed = await db.update(agentInstancesTable)
    .set({
      deployStatus: "deploying",
      deployLeaseId: operationId,
      deployOperationPhase: "preflight",
      deployProviderMutationUntil: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(agentInstancesTable.id, id),
      ne(agentInstancesTable.deployStatus, "deploying"),
    )).returning({ id: agentInstancesTable.id });
  if (!claimed.length) { res.status(409).json({ error: "يوجد نشر جارٍ بالفعل" }); return; }
  const stopHeartbeat = startAgentOperationHeartbeat(id, operationId);

  let installScript: string;
  try { ({ installScript } = await buildSetupKit(inst)); }
  catch (e: any) {
    await db.update(agentInstancesTable).set({
      deployStatus: inst.deployStatus,
      deployLeaseId: null,
      deployOperationPhase: null,
      deployProviderMutationUntil: null,
      updatedAt: new Date(),
    }).where(and(
      eq(agentInstancesTable.id, id),
      eq(agentInstancesTable.deployLeaseId, operationId),
    )).catch(() => {});
    stopHeartbeat();
    res.status(400).json({ error: String(e?.message ?? e).slice(0, 200) });
    return;
  }

  const log: string[] = [];
  const finish = async (ok: boolean, tail: string) => {
    log.push(tail);
    await db.update(agentInstancesTable).set({
      deployStatus: ok ? "ok" : "error",
      deployLeaseId: null,
      deployOperationPhase: null,
      deployProviderMutationUntil: null,
      deployLog: log.join("\n").slice(-8000),
      lastDeployAt: new Date(),
      sshStatus: ok ? "ok" : inst.sshStatus,
      updatedAt: new Date(),
    }).where(and(
      eq(agentInstancesTable.id, id),
      eq(agentInstancesTable.deployStatus, "deploying"),
      eq(agentInstancesTable.deployLeaseId, operationId),
    )).catch(() => {});
  };

  try {
    await initializeRemoteOperationFence(inst, operationId);
    const result = await sshRunOperationScript(inst, operationId, installScript);
    log.push(`[ssh] connected to ${inst.sshHost}:${inst.sshPort ?? 22} as ${inst.sshUser} (hostkey ${result.hostKeyFp.slice(0, 16)}…)`);
    const ok = result.code === 0 && result.out.includes("ZACOD_BOOTSTRAP_DONE");
    if (ok) await pinHostKey(inst, result.hostKeyFp);
    await finish(ok, result.out.slice(-6000));
    if (ok) res.json({ ok: true, log: log.join("\n").slice(-8000) });
    else res.status(502).json({ error: "فشل النشر — راجع السجل", log: log.join("\n").slice(-8000) });
  } catch (e: any) {
    await finish(false, `[error] ${String(e?.message ?? e).slice(0, 400)}`);
    res.status(502).json({ error: "فشل النشر", detail: String(e?.message ?? e).slice(0, 400) });
  } finally {
    stopHeartbeat();
  }
});

const AGENT_SCHEMA_UPGRADE_LOCK_NAME = "zacod_agent_schema_upgrade_v1";

function agentDatabaseIdentity(inst: typeof agentInstancesTable.$inferSelect): string {
  if (!inst.dbUrlEnc) throw new Error("لم يتم إدخال رابط قاعدة البيانات بعد");
  const raw = decryptSecret(inst.dbUrlEnc);
  if (!raw) throw new Error("تعذّر فك رابط قاعدة البيانات");
  const parsed = new URL(raw);
  let host = parsed.hostname.toLowerCase();
  if (host === "localhost" || (inst.sshHost && host === inst.sshHost.toLowerCase())) host = "127.0.0.1";
  const identity = JSON.stringify([
    host,
    String(parsed.port || "5432"),
    decodeURIComponent(parsed.pathname.replace(/^\/+/, "")),
    decodeURIComponent(parsed.username),
  ]);
  return createHash("sha256").update(identity).digest("hex");
}

async function withAgentSchemaUpgradeLock<T>(
  inst: typeof agentInstancesTable.$inferSelect,
  operation: () => Promise<T>,
): Promise<T> {
  if (!inst.dbUrlEnc) throw new Error("لا يمكن فحص قفل ترقية القاعدة دون رابط الاتصال");
  return withAgentPool(inst.dbUrlEnc, async (pool) => {
    const client = await pool.connect();
    let locked = false;
    try {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
        [AGENT_SCHEMA_UPGRADE_LOCK_NAME],
      );
      locked = result.rows[0]?.locked === true;
      if (!locked) throw new Error("تسوية قاعدة البيانات القديمة ما زالت تعمل؛ انتظر قليلًا ثم أعد الاستعادة");
      return await operation();
    } finally {
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [AGENT_SCHEMA_UPGRADE_LOCK_NAME]).catch(() => {});
      client.release();
    }
  });
}

async function reconcileAgentDatabaseSchema(
  inst: typeof agentInstancesTable.$inferSelect,
): Promise<string> {
  if (!inst.dbUrlEnc) throw new Error("لم يتم إدخال رابط قاعدة البيانات بعد");
  return withAgentPool(inst.dbUrlEnc, async (pool) => {
    const lockClient = await pool.connect();
    let locked = false;
    try {
      const lockResult = await lockClient.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
        [AGENT_SCHEMA_UPGRADE_LOCK_NAME],
      );
      locked = lockResult.rows[0]?.locked === true;
      if (!locked) throw new Error("توجد عملية تسوية مخطط أخرى ما زالت فعالة على قاعدة الوكيل");

      const { runWithExternalDb } = await import("@workspace/db");
      const { drizzle } = await import("drizzle-orm/node-postgres");
      const schemaMod = await import("@workspace/db/schema");
      const agentDrizzle = drizzle(pool as any, { schema: schemaMod as any });
      const {
        runSchemaHealOnActiveDb,
        runAgentRequestSchemaHealOnActiveDb,
      } = await import("../lib/ensureSchema.js");
      await runWithExternalDb(
        { db: agentDrizzle as any, pool: pool as any },
        async () => {
          await runSchemaHealOnActiveDb();
          // The full legacy reconciliation is intentionally best-effort for
          // some historical DDL. Follow it with the strict request-readiness
          // pass so an omitted posting-critical column can never be reported
          // as a successful manual upgrade.
          await runAgentRequestSchemaHealOnActiveDb();
        },
      );

      await assertAgentJournalLineSchema(pool);
      await assertAgentSupplierMetadataSchema(pool);
      await pool.query("SELECT 1 FROM journal_entry_lines LIMIT 1");
      await pool.query("SELECT 1 FROM payment_voucher_lines LIMIT 1");
      const identity = await pool.query<{ installation_id: string; fingerprint: string }>(
        "SELECT installation_id, fingerprint FROM zacod_installation WHERE id = 1",
      );
      const found = identity.rows[0];
      if (!found || found.installation_id !== inst.installationId) {
        throw new Error("هوية قاعدة الوكيل لا تطابق التركيب المسجل");
      }
      if (inst.dbFingerprint && found.fingerprint !== inst.dbFingerprint) {
        throw new Error("بصمة قاعدة الوكيل لا تطابق البصمة المسجلة");
      }
      return found.fingerprint;
    } finally {
      if (locked) {
        await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [AGENT_SCHEMA_UPGRADE_LOCK_NAME]).catch(() => {});
      }
      lockClient.release();
    }
  });
}

async function resumeAgentServiceAfterSchemaUpgrade(
  inst: typeof agentInstancesTable.$inferSelect,
  operationId: string,
): Promise<{ ok: boolean; log: string }> {
  const result = await sshRunOperationScript(inst, operationId, `set -e
MARKER=/var/tmp/zacod-schema-maintenance-${operationId}
WAS_ACTIVE="$(cat "$MARKER" 2>/dev/null || echo 1)"
if [ "$WAS_ACTIVE" = "1" ]; then
  systemctl start zacod-app
  systemctl is-active --quiet zacod-app
fi
rm -f "$MARKER"
echo ZACOD_SCHEMA_SERVICE_RESUMED`, { timeoutMs: 90_000 });
  return {
    ok: result.code === 0 && result.out.includes("ZACOD_SCHEMA_SERVICE_RESUMED"),
    log: result.out.slice(-700),
  };
}

async function runAgentDatabaseSchemaUpgrade(
  inst: typeof agentInstancesTable.$inferSelect,
  operationId: string,
  stopHeartbeat: () => void,
): Promise<void> {
  const log: string[] = [];
  let serviceHeld = false;
  const progress = async (phase: string, message: string) => {
    log.push(message);
    const updated = await db.update(agentInstancesTable).set({
      deployOperationPhase: phase,
      deployLog: log.join("\n").slice(-8000),
      updatedAt: new Date(),
    }).where(and(
      eq(agentInstancesTable.id, inst.id),
      eq(agentInstancesTable.deployStatus, "deploying"),
      eq(agentInstancesTable.deployLeaseId, operationId),
    )).returning({ id: agentInstancesTable.id });
    if (!updated.length) throw new Error("فُقد قفل ترقية قاعدة البيانات");
  };
  const finish = async (ok: boolean, message: string, fingerprint?: string) => {
    log.push(message);
    await db.update(agentInstancesTable).set({
      deployStatus: ok ? "ok" : "error",
      deployLeaseId: null,
      deployOperationPhase: null,
      deployProviderMutationUntil: null,
      deployLog: log.join("\n").slice(-8000),
      lastDeployAt: new Date(),
      dbStatus: ok ? "initialized" : "error",
      ...(ok && fingerprint ? { dbFingerprint: fingerprint } : {}),
      dbLastCheckAt: new Date(),
      dbLastError: ok ? null : message.slice(0, 500),
      updatedAt: new Date(),
    }).where(and(
      eq(agentInstancesTable.id, inst.id),
      eq(agentInstancesTable.deployStatus, "deploying"),
      eq(agentInstancesTable.deployLeaseId, operationId),
    )).catch(() => {});
    clearAgentHostCache();
    const { evictAgentDb } = await import("../lib/agentDb.js");
    evictAgentDb(inst.id);
  };

  try {
    await progress("schema_backup", "■ 1/3 إيقاف الكتابة وإنشاء نسخة أمان لقاعدة الوكيل الحالية");
    const backup = await sshRunOperationScript(inst, operationId, `set -e
set +x
umask 077
command -v pg_dump >/dev/null 2>&1 || { echo "ZACOD_SCHEMA_NO_PG_DUMP"; exit 76; }
command -v python3 >/dev/null 2>&1 || { echo "ZACOD_SCHEMA_NO_PYTHON"; exit 77; }
[ -f /opt/zacod/app.env ] || { echo "ZACOD_SCHEMA_NO_APP_ENV"; exit 78; }
BACKUP_DIR=/opt/zacod/backups/schema-upgrades
MAINTENANCE_MARKER=/var/tmp/zacod-schema-maintenance-${operationId}
WAS_ACTIVE=0
systemctl is-active --quiet zacod-app && WAS_ACTIVE=1 || true
printf '%s' "$WAS_ACTIVE" > "$MAINTENANCE_MARKER"
chmod 600 "$MAINTENANCE_MARKER"
systemctl stop zacod-app
PASSFILE="$(mktemp /root/.zacod-schema-pgpass.XXXXXX)"
CONNFILE="$(mktemp /root/.zacod-schema-pgconn.XXXXXX)"
BACKUP_READY=0
cleanup_schema_backup() {
  rm -f "$PASSFILE" "$CONNFILE"
  if [ "$BACKUP_READY" != "1" ]; then
    [ "$WAS_ACTIVE" = "1" ] && systemctl start zacod-app || true
    rm -f "$MAINTENANCE_MARKER"
  fi
}
trap cleanup_schema_backup EXIT
python3 - "$PASSFILE" "$CONNFILE" <<'PY'
import os, shlex, sys
import hashlib, json
from urllib.parse import unquote, urlsplit
env_path = "/opt/zacod/app.env"
raw = ""
with open(env_path, "r", encoding="utf-8") as handle:
    for line in handle:
        if line.startswith("DATABASE_URL="):
            raw = line.split("=", 1)[1].strip()
            break
if not raw:
    raise SystemExit("DATABASE_URL missing from app.env")
url = urlsplit(raw)
host = url.hostname or ""
if host.lower() == "localhost":
    host = "127.0.0.1"
port = str(url.port or 5432)
database = unquote(url.path.lstrip("/"))
user = unquote(url.username or "")
password = unquote(url.password or "")
if not all((host, port, database, user, password)):
    raise SystemExit("DATABASE_URL is incomplete")
def pgpass(value):
    return value.replace("\\\\", "\\\\\\\\").replace(":", "\\\\:")
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    handle.write(":".join(pgpass(v) for v in (host, port, database, user, password)) + "\\n")
os.chmod(sys.argv[1], 0o600)
query = dict(part.split("=", 1) for part in url.query.split("&") if "=" in part)
with open(sys.argv[2], "w", encoding="utf-8") as handle:
    for key, value in {
        "PGHOST": host,
        "PGPORT": port,
        "PGUSER": user,
        "PGDATABASE": database,
        "PGSSLMODE": query.get("sslmode", "prefer"),
    }.items():
        handle.write(f"{key}={shlex.quote(value)}\\n")
    identity = json.dumps([host.lower(), port, database, user], separators=(",", ":"))
    handle.write(f"DB_IDENTITY_SHA256={hashlib.sha256(identity.encode()).hexdigest()}\\n")
os.chmod(sys.argv[2], 0o600)
PY
. "$CONNFILE"
rm -f "$CONNFILE"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/pre-schema-upgrade-$(date -u +%Y%m%dT%H%M%SZ).dump"
PGPASSFILE="$PASSFILE" PGHOST="$PGHOST" PGPORT="$PGPORT" \
PGUSER="$PGUSER" PGDATABASE="$PGDATABASE" PGSSLMODE="$PGSSLMODE" PGCONNECT_TIMEOUT=15 \
pg_dump --format=custom --no-owner --no-privileges --file="$BACKUP_FILE"
test -s "$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"
BACKUP_READY=1
printf 'ZACOD_SCHEMA_DB_IDENTITY=%s\n' "$DB_IDENTITY_SHA256"
printf 'ZACOD_SCHEMA_BACKUP=%s\n' "$BACKUP_FILE"`, { timeoutMs: 600_000 });
    if (backup.code !== 0 || !backup.out.includes("ZACOD_SCHEMA_BACKUP=")) {
      throw new Error(`فشل إنشاء نسخة الأمان؛ لم تبدأ الترقية: ${backup.out.slice(-500)}`);
    }
    serviceHeld = true;
    const remoteIdentity = backup.out.match(/ZACOD_SCHEMA_DB_IDENTITY=([a-f0-9]{64})/)?.[1];
    if (!remoteIdentity || remoteIdentity !== agentDatabaseIdentity(inst)) {
      throw new Error("قاعدة النسخة الاحتياطية لا تطابق قاعدة الوكيل المسجلة؛ أُوقفت الترقية دون تعديل المخطط");
    }
    await pinHostKey(inst, backup.hostKeyFp);
    const backupPath = backup.out.match(/ZACOD_SCHEMA_BACKUP=(\/[^\s]+)/)?.[1] ?? "تم حفظها على سيرفر الوكيل";
    log.push(`نسخة الأمان: ${backupPath}`);

    await progress("schema_reconcile", "■ 2/3 تطبيق ترقية المخطط الإضافية الآمنة");
    await assertAgentOperationOwned(inst.id, operationId);
    const fingerprint = await reconcileAgentDatabaseSchema(inst);
    await assertAgentOperationOwned(inst.id, operationId);

    await progress("schema_verify", "■ 3/3 فحص الأعمدة الحرجة وإصدار التطبيق ثم استئناف الخدمة");
    const versionResult = await sshRunOperationScript(inst, operationId, `set -e
VERSION="$(cat /opt/zacod/app/VERSION 2>/dev/null || true)"
printf 'ZACOD_SCHEMA_VERSION=%s\n' "$VERSION"`, { timeoutMs: 60_000 });
    if (versionResult.code !== 0) throw new Error("تعذّر التحقق من إصدار التطبيق بعد الترقية");
    const installedVersion = versionResult.out.match(/ZACOD_SCHEMA_VERSION=([A-Za-z0-9._-]+)/)?.[1]
      ?? inst.deployedVersion
      ?? "غير معروف";
    const resumed = await resumeAgentServiceAfterSchemaUpgrade(inst, operationId);
    if (!resumed.ok) throw new Error(`اكتملت تسوية المخطط لكن تعذّر استئناف خدمة الوكيل: ${resumed.log}`);
    serviceHeld = false;

    await finish(true, `اكتملت الترقية بنجاح — الإصدار ${installedVersion} — المخطط جاهز وأعمدة بيانات المورد موجودة والخدمة تعمل.`, fingerprint);
    await logAgentEvent(inst.id, "agent_database_schema_upgraded", {
      version: installedVersion,
      backupPath,
    }).catch(() => {});
  } catch (error: any) {
    let message = String(error?.message ?? error).slice(0, 500);
    if (serviceHeld) {
      try {
        const resumed = await resumeAgentServiceAfterSchemaUpgrade(inst, operationId);
        if (!resumed.ok) message = `${message} — وتعذّر استئناف الخدمة: ${resumed.log}`.slice(0, 500);
        else log.push("تم استئناف خدمة الوكيل بعد فشل الترقية.");
      } catch (resumeError: any) {
        message = `${message} — وتعذّر استئناف الخدمة: ${String(resumeError?.message ?? resumeError)}`.slice(0, 500);
      }
    }
    await finish(false, `فشلت ترقية قاعدة البيانات: ${message}`);
    await logAgentEvent(inst.id, "agent_database_schema_upgrade_failed", { error: message }).catch(() => {});
  } finally {
    stopHeartbeat();
  }
}

// POST /:id/schema-upgrade — repair an existing full-agent database in place.
// This never restores the central database or replaces business data.
router.post("/:id/schema-upgrade", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  if (inst.mode !== "full") {
    res.status(400).json({ error: "أداة ترقية القاعدة مخصصة لنسخ الوكيل الكاملة فقط" });
    return;
  }
  if (!inst.dbUrlEnc) { res.status(400).json({ error: "لم يتم إدخال رابط قاعدة البيانات بعد" }); return; }
  if (!inst.sshHost || !inst.sshUser || !inst.sshSecretEnc) {
    res.status(400).json({ error: "أكمل بيانات SSH أولًا لإنشاء نسخة الأمان على سيرفر الوكيل" });
    return;
  }
  try { await assertProbeTargetAllowed(inst.sshHost); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? "عنوان غير مسموح") }); return; }

  const operationId = randomBytes(16).toString("hex");
  const claimed = await db.update(agentInstancesTable).set({
    deployStatus: "deploying",
    deployLeaseId: operationId,
    deployOperationPhase: "schema_preflight",
    deployProviderMutationUntil: null,
    deployLog: "بدء ترقية قاعدة بيانات الوكيل دون استبدال البيانات…",
    dbStatus: "initializing",
    dbLastError: "ترقية مخطط قاعدة البيانات جارية",
    updatedAt: new Date(),
  }).where(and(
    eq(agentInstancesTable.id, id),
    ne(agentInstancesTable.deployStatus, "deploying"),
  )).returning({ id: agentInstancesTable.id });
  if (!claimed.length) {
    res.status(409).json({ error: "يوجد نشر أو ترقية أخرى جارية بالفعل" });
    return;
  }
  const stopHeartbeat = startAgentOperationHeartbeat(id, operationId);
  try {
    await initializeRemoteOperationFence(inst, operationId);
  } catch (e: any) {
    stopHeartbeat();
    const message = String(e?.message ?? e).slice(0, 500);
    await db.update(agentInstancesTable).set({
      deployStatus: "error",
      deployLeaseId: null,
      deployOperationPhase: null,
      deployLog: `تعذّر بدء ترقية قاعدة البيانات: ${message}`,
      dbStatus: inst.dbStatus,
      dbLastError: inst.dbLastError,
      updatedAt: new Date(),
    }).where(and(
      eq(agentInstancesTable.id, id),
      eq(agentInstancesTable.deployLeaseId, operationId),
    )).catch(() => {});
    res.status(409).json({ error: message });
    return;
  }

  await logAgentEvent(id, "agent_database_schema_upgrade_started", {
    by: (req as any).authUser?.username ?? null,
  }, req).catch(() => {});
  res.status(202).json({ ok: true, started: true, operationId });
  void runAgentDatabaseSchemaUpgrade(inst, operationId, stopHeartbeat);
});

// ── تعدد السيرفرات (سيرفرات احتياطية لكل وكيل) ─────────────────────────────
//
// السيرفر «الرئيسي» يبقى على أعمدة agent_instances (كل خطوط النشر/الإنقاذ
// تعتمد عليها). جدول agent_servers يحمل السيرفرات الاحتياطية: نضيفها،
// نختبر SSH، نسطّب عليها بوابة الدخول (Caddy + نبض بعلامة مميزة)، وعند
// تعطل الرئيسي زر «ترقية» يبادل الحقول بين الصفّين ذرّيًا — ثم يوجَّه
// الدومين (DNS) إلى عنوان السيرفر الجديد.

function serverPublicRow(s: typeof agentServersTable.$inferSelect) {
  const { sshSecretEnc, sshHostKeyFp: _fp, hbMarker: _m, ...rest } = s as any;
  return { ...rest, sshSecretSet: !!sshSecretEnc };
}

/** يبني هدف SSH بشكل صف الوكيل لكن ببيانات السيرفر الاحتياطي (لإعادة استخدام sshRunScript). */
function overlayServerTarget(
  inst: typeof agentInstancesTable.$inferSelect,
  srv: typeof agentServersTable.$inferSelect,
): typeof agentInstancesTable.$inferSelect {
  return {
    ...inst,
    sshHost: srv.sshHost, sshPort: srv.sshPort, sshUser: srv.sshUser,
    sshSecretEnc: srv.sshSecretEnc, sshHostKeyFp: srv.sshHostKeyFp,
  } as typeof agentInstancesTable.$inferSelect;
}

async function loadServer(agentId: number, sid: number) {
  const [srv] = await db.select().from(agentServersTable)
    .where(and(eq(agentServersTable.id, sid), eq(agentServersTable.agentId, agentId))).limit(1);
  return srv ?? null;
}

const serverUpsertSchema = z.object({
  label: z.string().min(2).max(120),
  sshHost: z.string().max(255).nullish(),
  sshPort: z.number().int().min(1).max(65535).nullish(),
  sshUser: z.string().max(100).nullish(),
  // write-only: فارغ/غير مُرسل = الإبقاء على الحالية.
  sshSecret: z.string().max(10000).nullish(),
  notes: z.string().max(2000).nullish(),
});

// GET /:id/servers — قائمة السيرفرات الاحتياطية للوكيل.
router.get("/:id/servers", async (req, res) => {
  const id = Number(req.params.id);
  const rows = await db.select().from(agentServersTable)
    .where(eq(agentServersTable.agentId, id)).orderBy(desc(agentServersTable.id));
  res.json(rows.map(serverPublicRow));
});

// POST /:id/servers — إضافة سيرفر احتياطي.
router.post("/:id/servers", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  const p = serverUpsertSchema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "بيانات غير صالحة" }); return; }
  const d = p.data;
  const [row] = await db.insert(agentServersTable).values({
    agentId: id, label: d.label,
    sshHost: d.sshHost ?? null, sshPort: d.sshPort ?? null, sshUser: d.sshUser ?? null,
    sshSecretEnc: d.sshSecret ? encryptSecret(d.sshSecret) : null,
    hbMarker: `srv-${randomBytes(4).toString("hex")}`,
    notes: d.notes ?? null,
  }).returning();
  res.status(201).json(serverPublicRow(row));
});

// PUT /:id/servers/:sid — تعديل سيرفر احتياطي (السر write-only).
router.put("/:id/servers/:sid", async (req, res) => {
  const id = Number(req.params.id), sid = Number(req.params.sid);
  const srv = await loadServer(id, sid);
  if (!srv) { res.status(404).json({ error: "غير موجود" }); return; }
  const p = serverUpsertSchema.partial().safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "بيانات غير صالحة" }); return; }
  const d = p.data;
  const hostChanged = d.sshHost !== undefined && (d.sshHost ?? null) !== srv.sshHost;
  const [row] = await db.update(agentServersTable).set({
    ...(d.label !== undefined ? { label: d.label } : {}),
    ...(d.sshHost !== undefined ? { sshHost: d.sshHost ?? null } : {}),
    ...(d.sshPort !== undefined ? { sshPort: d.sshPort ?? null } : {}),
    ...(d.sshUser !== undefined ? { sshUser: d.sshUser ?? null } : {}),
    ...(d.sshSecret ? { sshSecretEnc: encryptSecret(d.sshSecret) } : {}),
    ...(d.notes !== undefined ? { notes: d.notes ?? null } : {}),
    // تغيير المضيف = سيرفر آخر فعليًا — صفّر تثبيت مفتاح المضيف والحالة.
    ...(hostChanged ? { sshHostKeyFp: null, sshStatus: "not_configured", deployStatus: "never" } : {}),
    updatedAt: new Date(),
  }).where(and(eq(agentServersTable.id, sid), eq(agentServersTable.agentId, id))).returning();
  res.json(serverPublicRow(row));
});

// DELETE /:id/servers/:sid
router.delete("/:id/servers/:sid", async (req, res) => {
  const id = Number(req.params.id), sid = Number(req.params.sid);
  const srv = await loadServer(id, sid);
  if (!srv) { res.status(404).json({ error: "غير موجود" }); return; }
  if (srv.deployStatus === "deploying") { res.status(409).json({ error: "يوجد تسطيب جارٍ على هذا السيرفر" }); return; }
  await db.delete(agentServersTable).where(and(eq(agentServersTable.id, sid), eq(agentServersTable.agentId, id)));
  res.json({ ok: true });
});

// POST /:id/servers/:sid/test-ssh — نفس منطق فحص السيرفر الرئيسي.
router.post("/:id/servers/:sid/test-ssh", async (req, res) => {
  const id = Number(req.params.id), sid = Number(req.params.sid);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  const srv = inst ? await loadServer(id, sid) : null;
  if (!inst || !srv) { res.status(404).json({ error: "غير موجود" }); return; }
  if (!srv.sshHost) { res.status(400).json({ error: "لم يتم إدخال بيانات السيرفر بعد" }); return; }
  const port = srv.sshPort ?? 22;
  try { await assertProbeTargetAllowed(srv.sshHost); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? "عنوان غير مسموح") }); return; }
  const mark = (patch: Record<string, unknown>) =>
    db.update(agentServersTable).set({ ...patch, sshLastCheckAt: new Date(), updatedAt: new Date() })
      .where(eq(agentServersTable.id, sid));
  const reachable = await new Promise<boolean>((resolve) => {
    const sock = net.connect({ host: srv.sshHost!, port, timeout: 6000 });
    sock.on("connect", () => { sock.destroy(); resolve(true); });
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
    sock.on("error", () => resolve(false));
  });
  if (!reachable) {
    await mark({ sshStatus: "error" });
    res.status(502).json({ error: `تعذّر الوصول إلى ${srv.sshHost}:${port} — تأكد من العنوان والمنفذ` });
    return;
  }
  if (srv.sshUser && srv.sshSecretEnc) {
    try {
      const r = await sshRunScript(overlayServerTarget(inst, srv), "echo AUTH_OK", { timeoutMs: 25_000 });
      await mark({ sshStatus: "ok", ...(!srv.sshHostKeyFp && r.hostKeyFp ? { sshHostKeyFp: r.hostKeyFp } : {}) });
      res.json({ ok: true, host: srv.sshHost, port, auth: true, user: srv.sshUser });
    } catch (e: any) {
      const raw = String(e?.message ?? e);
      const friendly = /authentication methods failed/i.test(raw)
        ? `المنفذ مفتوح لكن السيرفر رفض تسجيل الدخول للمستخدم «${srv.sshUser}» — تأكد من اسم المستخدم وكلمة المرور/المفتاح`
        : `المنفذ مفتوح لكن فشل الدخول: ${raw.slice(0, 300)}`;
      await mark({ sshStatus: "error" });
      res.status(502).json({ error: friendly });
    }
    return;
  }
  await mark({ sshStatus: "ok" });
  res.json({ ok: true, host: srv.sshHost, port, auth: false, note: "تم فحص الوصول فقط — أدخل المستخدم وكلمة المرور لاختبار الدخول الفعلي" });
});

// POST /:id/servers/:sid/deploy — تسطيب بوابة الدخول على السيرفر الاحتياطي
// (Caddy + نبض بعلامة السيرفر). النسخة الكاملة غير مدعومة احتياطيًا بعد
// (تحتاج نسخ التطبيق وقاعدة البيانات — مرحلة لاحقة).
router.post("/:id/servers/:sid/deploy", async (req, res) => {
  const id = Number(req.params.id), sid = Number(req.params.sid);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  const srv = inst ? await loadServer(id, sid) : null;
  if (!inst || !srv) { res.status(404).json({ error: "غير موجود" }); return; }
  if (inst.mode === "full") {
    res.status(400).json({ error: "النسخة الكاملة تعمل محليًا على سيرفر واحد — التسطيب الاحتياطي متاح حاليًا لوضع البوابة فقط (يتطلب لاحقًا نسخ التطبيق وقاعدة البيانات)" });
    return;
  }
  if (!srv.sshHost || !srv.sshUser || !srv.sshSecretEnc) { res.status(400).json({ error: "أكمل بيانات السيرفر (المضيف والمستخدم وكلمة المرور/المفتاح) أولًا" }); return; }
  if (!inst.licenseKey) { res.status(400).json({ error: "أصدر ترخيصًا أولًا" }); return; }
  try { await assertProbeTargetAllowed(srv.sshHost); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? "عنوان غير مسموح") }); return; }

  let installScript: string;
  try { ({ installScript } = await buildSetupKit(inst, { hbMarker: srv.hbMarker })); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e).slice(0, 200) }); return; }

  // حجز ذرّي على صف السيرفر (تسطيب معلّق أقدم من 10 دقائق يُعاد حجزه).
  // طابع الحجز (claimAt) يعمل كسياج: تحديث النهاية لا ينفَّذ إلا إن كان
  // الحجز لا يزال حجزنا — فلا يدهس تسطيبٌ بطيء نتيجةَ حاجزٍ لاحق.
  const staleBefore = new Date(Date.now() - 10 * 60_000);
  const claimAt = new Date();
  const claimed = await db.update(agentServersTable)
    .set({ deployStatus: "deploying", updatedAt: claimAt })
    .where(and(
      eq(agentServersTable.id, sid), eq(agentServersTable.agentId, id),
      or(ne(agentServersTable.deployStatus, "deploying"), lt(agentServersTable.updatedAt, staleBefore)),
    )).returning({ id: agentServersTable.id });
  if (!claimed.length) { res.status(409).json({ error: "يوجد تسطيب جارٍ بالفعل على هذا السيرفر" }); return; }
  const leaseWhere = and(
    eq(agentServersTable.id, sid),
    eq(agentServersTable.deployStatus, "deploying"),
    eq(agentServersTable.updatedAt, claimAt),
  );

  const log: string[] = [];
  const finish = async (ok: boolean, tail: string) => {
    log.push(tail);
    await db.update(agentServersTable).set({
      deployStatus: ok ? "ok" : "error",
      deployLog: log.join("\n").slice(-8000),
      lastDeployAt: new Date(),
      sshStatus: ok ? "ok" : srv.sshStatus,
      updatedAt: new Date(),
    }).where(leaseWhere).catch(() => {});
  };
  try {
    const target = overlayServerTarget(inst, srv);
    const result = await sshRunScript(target, installScript);
    log.push(`[ssh] connected to ${srv.sshHost}:${srv.sshPort ?? 22} as ${srv.sshUser} (hostkey ${result.hostKeyFp.slice(0, 16)}…)`);
    const ok = result.code === 0 && result.out.includes("ZACOD_BOOTSTRAP_DONE");
    if (ok && !srv.sshHostKeyFp && result.hostKeyFp) {
      await db.update(agentServersTable).set({ sshHostKeyFp: result.hostKeyFp }).where(leaseWhere).catch(() => {});
    }
    await finish(ok, result.out.slice(-6000));
    await logAgentEvent(id, ok ? "standby_deployed" : "standby_deploy_failed", { serverId: sid, label: srv.label }, req);
    if (ok) res.json({ ok: true, log: log.join("\n").slice(-8000) });
    else res.status(502).json({ error: "فشل التسطيب — راجع السجل", log: log.join("\n").slice(-8000) });
  } catch (e: any) {
    await finish(false, `[error] ${String(e?.message ?? e).slice(0, 400)}`);
    res.status(502).json({ error: "فشل التسطيب", detail: String(e?.message ?? e).slice(0, 400) });
  }
});

// POST /:id/servers/:sid/promote — ترقية الاحتياطي إلى رئيسي: تبادل حقول
// SSH/النشر/النبض بين صف الوكيل وصف السيرفر ذرّيًا (الرئيسي السابق يصبح
// احتياطيًا قابلًا للإصلاح). بعدها يجب توجيه DNS للدومين إلى عنوان السيرفر
// الجديد — لا نتحكم في DNS الوكيل من هنا.
router.post("/:id/servers/:sid/promote", async (req, res) => {
  const id = Number(req.params.id), sid = Number(req.params.sid);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  const srv = inst ? await loadServer(id, sid) : null;
  if (!inst || !srv) { res.status(404).json({ error: "غير موجود" }); return; }
  if (inst.mode === "full") {
    res.status(400).json({ error: "النسخة الكاملة تعمل محليًا بقاعدة بياناتها — ترقية سيرفر احتياطي غير مدعومة لها حاليًا (تتطلب نسخ التطبيق وقاعدة البيانات)" });
    return;
  }
  if (srv.deployStatus !== "ok") { res.status(400).json({ error: "سطّب بوابة الدخول على هذا السيرفر أولًا (يجب أن يكون التسطيب ناجحًا قبل الترقية)" }); return; }
  try {
  await db.transaction(async (tx) => {
    // إعادة قراءة الصفين داخل المعاملة مع قفل — يمنع سباق الترقية مع
    // تسطيب جارٍ بدأ بعد الفحص الأولي.
    const [instFresh] = await tx.select().from(agentInstancesTable)
      .where(eq(agentInstancesTable.id, id)).for("update").limit(1);
    const [srvFresh] = await tx.select().from(agentServersTable)
      .where(and(eq(agentServersTable.id, sid), eq(agentServersTable.agentId, id))).for("update").limit(1);
    if (!instFresh || !srvFresh) throw Object.assign(new Error("غير موجود"), { httpStatus: 404 });
    if (srvFresh.deployStatus !== "ok" || instFresh.deployStatus === "deploying") {
      throw Object.assign(new Error("يوجد تسطيب جارٍ أو تغيّرت حالة السيرفر — أعد المحاولة بعد انتهائه"), { httpStatus: 409 });
    }
    const inst = instFresh, srv = srvFresh;
    await tx.update(agentInstancesTable).set({
      sshHost: srv.sshHost, sshPort: srv.sshPort, sshUser: srv.sshUser,
      sshSecretEnc: srv.sshSecretEnc, sshStatus: srv.sshStatus, sshLastCheckAt: srv.sshLastCheckAt,
      sshHostKeyFp: srv.sshHostKeyFp,
      deployStatus: srv.deployStatus, deployLog: srv.deployLog, lastDeployAt: srv.lastDeployAt,
      lastHeartbeatAt: srv.lastHeartbeatAt, lastSeenIp: srv.lastSeenIp, deployedVersion: srv.deployedVersion,
      primaryHbMarker: srv.hbMarker,
      updatedAt: new Date(),
    }).where(eq(agentInstancesTable.id, id));
    await tx.update(agentServersTable).set({
      sshHost: inst.sshHost, sshPort: inst.sshPort, sshUser: inst.sshUser,
      sshSecretEnc: inst.sshSecretEnc, sshStatus: inst.sshStatus, sshLastCheckAt: inst.sshLastCheckAt,
      sshHostKeyFp: inst.sshHostKeyFp,
      deployStatus: inst.deployStatus, deployLog: inst.deployLog, lastDeployAt: inst.lastDeployAt,
      lastHeartbeatAt: inst.lastHeartbeatAt, lastSeenIp: inst.lastSeenIp, deployedVersion: inst.deployedVersion,
      hbMarker: inst.primaryHbMarker ?? "",
      label: `${srv.label} (الرئيسي السابق)`.slice(0, 120),
      updatedAt: new Date(),
    }).where(eq(agentServersTable.id, sid));
  });
  } catch (e: any) {
    res.status(Number(e?.httpStatus) || 500).json({ error: String(e?.message ?? "فشلت الترقية").slice(0, 300) });
    return;
  }
  await logAgentEvent(id, "server_promoted", { serverId: sid, label: srv.label, newPrimaryHost: srv.sshHost }, req);
  res.json({
    ok: true,
    newPrimaryHost: srv.sshHost,
    note: `تمت الترقية — وجِّه الآن سجل DNS للدومين ${inst.domain} إلى عنوان السيرفر الجديد (${srv.sshHost ?? "?"}). نصيحة: اجعل TTL منخفضًا (60-300 ثانية) لتسريع التحويل مستقبلًا.`,
  });
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

// ── حزم مشفّرة + حزم مرفوعة (تسطيب برفع ملفات) ────────────────────────────
//
// التشفير: صيغة openssl القياسية ("Salted__" + salt + AES-256-CBC/PBKDF2-SHA256
// بـ 10000 دورة) حتى يفكّها سيرفر الوكيل بأمر openssl واحد دون أدوات إضافية.
// كلمة السر تُشتق لكل وكيل من SESSION_SECRET + معرّف التركيب + مفتاح الترخيص،
// وتُسلَّم للسيرفر عبر SSH فقط (لا تظهر في أي URL).

function bundlePassphrase(inst: { installationId: string; licenseKey: string | null }): string {
  // fail-closed: بدون SESSION_SECRET يصبح المفتاح قابلًا للاشتقاق من معطيات
  // الـ URL (معرّف التركيب + الترخيص) — نرفض التشفير بدلًا من تشفير وهمي.
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET غير مضبوط — لا يمكن إنشاء مفتاح تشفير الحزمة");
  return createHmac("sha256", secret)
    .update(`bundle:${inst.installationId}:${inst.licenseKey ?? ""}`).digest("hex");
}

/** يبثّ ملفًا (اختياريًا مشفّرًا بصيغة openssl enc) إلى الاستجابة. */
function streamFileMaybeEncrypted(res: any, filePath: string, downloadName: string, passphrase: string | null): void {
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
  const src = fs.createReadStream(filePath);
  if (!passphrase) { src.pipe(res); return; }
  const salt = randomBytes(8);
  const keyIv = pbkdf2Sync(passphrase, salt, 10_000, 48, "sha256");
  const cipher = createCipheriv("aes-256-cbc", keyIv.subarray(0, 32), keyIv.subarray(32, 48));
  res.write(Buffer.concat([Buffer.from("Salted__"), salt]));
  src.pipe(cipher).pipe(res);
  src.on("error", () => { try { res.destroy(); } catch { /* noop */ } });
}

// كل حزم التسطيب المخصّص تُحفظ مشفّرة في التخزين الخاص الدائم. الاسم القديم
// محفوظ محليًا داخل هذا الملف فقط لتقليل التغيير في مسار التسطيب القائم.
const CUSTOM_KINDS = EXTERNAL_PACKAGE_KINDS;
type CustomKind = ExternalPackageKind;

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

type ProvisionOpts = {
  /** full = السلوك الحالي | no_db = استخدام قاعدة البيانات المسجلة فقط (لا إنشاء)
   *  | upload = تثبيت الملفات المرفوعة بدل حزمة المنصة */
  variant: "full" | "no_db" | "upload";
  /** إرسال الحزمة مشفّرة (AES-256) ويفكّها السيرفر عند الاستلام */
  encryptBundle: boolean;
  /** External-package updates may install app files without restoring DB. */
  restoreUploadedDb?: boolean;
};

type ProvisionAutoDomainContext = {
  plan: CloudflareARecordPlan;
  operationId: string;
};

async function runProvision(
  instIn: typeof agentInstancesTable.$inferSelect,
  opts: ProvisionOpts = { variant: "full", encryptBundle: false },
  operationId: string,
  stopHeartbeat: () => void,
  autoDomain?: ProvisionAutoDomainContext,
): Promise<void> {
  let inst = instIn;
  const log: string[] = [];
  const autoDomainLog: string[] = [];
  let autoDomainApplied: AppliedRecord | null = null;
  let installedAppVersion: string | null = null;
  const save = async (status?: "ok" | "error") => {
    const rows = await db.update(agentInstancesTable).set({
      deployLog: log.join("\n").slice(-8000),
      ...(status ? {
        deployStatus: status,
        deployLeaseId: null,
        deployOperationPhase: null,
        deployProviderMutationUntil: null,
        autoDomainLeaseAt: null,
        lastDeployAt: new Date(),
        sshStatus: status === "ok" ? "ok" : inst.sshStatus,
      } : {}),
      updatedAt: new Date(),
    }).where(and(
      eq(agentInstancesTable.id, inst.id),
      eq(agentInstancesTable.deployStatus, "deploying"),
      eq(agentInstancesTable.deployLeaseId, operationId),
    )).returning({ id: agentInstancesTable.id }).catch(() => []);
    return rows.length > 0;
  };
  const step = async (title: string) => {
    log.push(`\n■ ${title}`);
    if (!await save()) throw new Error("فُقد قفل التسطيب؛ أُوقفت المهمة القديمة");
  };
  const runSsh = async (script: string, marker: string, timeoutMs: number) => {
    const r = await sshRunOperationScript(inst, operationId, script, { timeoutMs });
    log.push(r.out.slice(-3000));
    if (r.code !== 0 || !r.out.includes(marker)) throw new Error("فشلت الخطوة — راجع السجل أعلاه");
    await pinHostKey(inst, r.hostKeyFp);
  };
  const reload = async () => {
    const [row] = await db.select().from(agentInstancesTable).where(and(
      eq(agentInstancesTable.id, inst.id),
      eq(agentInstancesTable.deployStatus, "deploying"),
      eq(agentInstancesTable.deployLeaseId, operationId),
    )).limit(1);
    if (!row) throw new Error("فُقد قفل التسطيب؛ أُوقفت المهمة القديمة");
    inst = row;
  };

  try {
    // Shell-safety gate: everything interpolated into root scripts.
    assertShellSafeHostLike(inst.sshHost ?? "", "مضيف SSH");
    assertShellSafeHostLike(inst.domain ?? "", "الدومين");
    if (autoDomain) {
      log.push("\n■ إعداد بنية الدومين التلقائية");
      autoDomainLog.push("■ بدء إعداد الدومين مع التسطيب الكامل");
      if (!await save()) throw new Error("فُقد قفل التسطيب؛ أُوقفت المهمة القديمة");
      autoDomainApplied = await prepareAutoDomainInfrastructure(
        inst,
        autoDomain.plan,
        autoDomain.operationId,
        autoDomainLog,
      );
      log.push(...autoDomainLog.slice(-4));
      if (!await save()) throw new Error("فُقد قفل التسطيب؛ أُوقفت المهمة القديمة");
    }
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
    // الرابط المحفوظ يُعتمد فقط إذا كان رابط PostgreSQL صالحًا فعلاً —
    // رابط تالف (إدخال يدوي خاطئ) كان يعطّل الخطوة 4 لاحقًا.
    const storedDbUrlOk = (() => {
      if (!inst.dbUrlEnc) return false;
      const raw = decryptSecret(inst.dbUrlEnc) ?? "";
      try {
        const u = new URL(raw);
        return (u.protocol === "postgres:" || u.protocol === "postgresql:") && !!u.hostname;
      } catch { return false; }
    })();
    if (storedDbUrlOk) {
      log.push("قاعدة بيانات مسجّلة مسبقًا — تخطّي الإنشاء.");
    } else if (opts.variant === "no_db") {
      // تسطيب بدون قاعدة بيانات: يعتمد حصريًا على الرابط المسجّل في بيانات
      // الوكيل — لا نثبّت PostgreSQL ولا ننشئ قاعدة على السيرفر.
      throw new Error("اخترت «تسطيب بدون قاعدة بيانات» ولا يوجد رابط قاعدة بيانات صالح في بيانات الوكيل — أدخل الرابط في تبويب «قاعدة البيانات» أولًا.");
    } else {
      if (inst.dbUrlEnc) log.push("الرابط المحفوظ غير صالح — سيتم إنشاء قاعدة بيانات جديدة على السيرفر وحفظ رابطها تلقائيًا.");
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
    const { installScript } = await buildSetupKit(inst, { safeWebServerMode: !!autoDomain });
    await runSsh(installScript, "ZACOD_BOOTSTRAP_DONE", 300_000);

    // 3.5) استعادة نسخة قاعدة البيانات المرفوعة — يجب أن تسبق زرع السكيما
    // والبصمة (الخطوة 4)، وإلا مسحت الاستعادةُ بصمةَ التركيب وجدول التنصيب
    // فيتعطل النبض. أي فشل هنا يُسقط التسطيب كاملًا (لا استعادة صامتة).
    if (opts.variant === "upload" && opts.restoreUploadedDb !== false && inst.mode === "full") {
      const metaR = readPackageMap(inst.externalPackageMeta);
      if (metaR.db && verifyPackageEntry(inst.id, "db", metaR.db)) {
        await step("استعادة نسخة قاعدة البيانات المرفوعة");
        await reload();
        const originR = resolveCentralOrigin();
        const storedDbUrlR = decryptSecret(inst.dbUrlEnc!) ?? "";
        assertShellSafeDbUrl(storedDbUrlR);
        let restoreDbUrl = storedDbUrlR;
        try {
          const u = new URL(storedDbUrlR);
          if (u.hostname === inst.sshHost) { u.hostname = "127.0.0.1"; u.searchParams.delete("sslmode"); restoreDbUrl = u.toString().replace(/\?$/, ""); }
        } catch { /* keep stored URL as-is */ }
        assertShellSafeDbUrl(restoreDbUrl);
        // الحزم المرفوعة/الخارجية تكون مشفّرة دائمًا في التخزين وعند النقل.
        const encR = true;
        const passR = bundlePassphrase(inst);
        const dUrl = buildCustomAgentReleaseUrl(originR, "db", true);
        const releaseAuthPathR = "/opt/zacod/.release-auth.curl";
        const isGz = metaR.db.format === "sql_gzip";
        const isSql = metaR.db.format === "sql" || metaR.db.format === "sql_gzip";
        const dlR = encR
          ? `curl --config ${releaseAuthPathR} -fsS ${shQ(dUrl)} -o /tmp/zacod-db.bak.enc
printf '%s  %s\\n' ${shQ(metaR.db.sha256)} /tmp/zacod-db.bak.enc | sha256sum -c -
openssl enc -d -aes-256-cbc -pbkdf2 -iter 10000 -md sha256 -pass "pass:$ZACOD_BUNDLE_KEY" -in /tmp/zacod-db.bak.enc -out /tmp/zacod-db.bak
rm -f /tmp/zacod-db.bak.enc`
          : `curl --config ${releaseAuthPathR} -fsS ${shQ(dUrl)} -o /tmp/zacod-db.bak`;
        await runSsh(`set -e
export DEBIAN_FRONTEND=noninteractive
export ZACOD_BUNDLE_KEY=${shQ(passR)}
umask 077
trap 'rm -f ${releaseAuthPathR}' EXIT
RELEASE_INSTALLATION_ID=${shQ(inst.installationId)}
RELEASE_LICENSE_KEY=${shQ(inst.licenseKey ?? "")}
printf 'header = "X-Zacod-Installation-Id: %s"\\nheader = "X-Zacod-License-Key: %s"\\n' "$RELEASE_INSTALLATION_ID" "$RELEASE_LICENSE_KEY" > ${releaseAuthPathR}
unset RELEASE_INSTALLATION_ID RELEASE_LICENSE_KEY
command -v psql >/dev/null 2>&1 || { apt-get update -y >/dev/null; apt-get install -y postgresql-client >/dev/null; }
${encR ? `command -v openssl >/dev/null 2>&1 || { apt-get update -y >/dev/null; apt-get install -y openssl >/dev/null; }` : `true`}
${dlR}
rm -f ${releaseAuthPathR}
trap - EXIT
${isSql
  ? (isGz
      ? `gunzip -c /tmp/zacod-db.bak | psql "${restoreDbUrl}" -v ON_ERROR_STOP=1 >/dev/null`
      : `psql "${restoreDbUrl}" -v ON_ERROR_STOP=1 -f /tmp/zacod-db.bak >/dev/null`)
  : `pg_restore --clean --if-exists --no-owner --exit-on-error -d "${restoreDbUrl}" /tmp/zacod-db.bak >/dev/null`}
rm -f /tmp/zacod-db.bak
echo ZACOD_DB_RESTORED`, "ZACOD_DB_RESTORED", 600_000);
        log.push(`تمت استعادة نسخة قاعدة البيانات (${metaR.db.filename}) — ستُعاد تهيئة السكيما والبصمة فوقها في الخطوة التالية.`);
      }
    }

    // 4) schema init + fingerprint
    await step("4/6 تهيئة قاعدة البيانات (السكيما + البصمة)");
    await reload();
    try {
      const plantedFp = await initAgentDatabaseCore(inst);
      log.push("تمت التهيئة وزرع البصمة.");
      // config.json was written in step 3 BEFORE the fingerprint existed, so the
      // heartbeat would send fingerprint:"" → 403 db_fingerprint_mismatch → the
      // kill-switch stops Caddy every 5 minutes (site flaps up/down). Sync the
      // planted fingerprint into the on-server config now. fp is hex-only (safe
      // to inline in a heredoc-free python one-liner via env var).
      await runSsh(
        `ZFP=${shQ(plantedFp)} python3 -c "import json,os; p='/opt/zacod/config.json'; c=json.load(open(p)); c['fingerprint']=os.environ['ZFP']; json.dump(c,open(p,'w'),indent=2,ensure_ascii=False)" && rm -f /opt/zacod/SUSPENDED && echo ZACOD_FP_SYNCED`,
        "ZACOD_FP_SYNCED",
        60_000,
      );
      log.push("تمت مزامنة البصمة إلى config.json على السيرفر.");
      if (autoDomain) {
        // The first pre-fingerprint heartbeat can deliberately stop Caddy.
        // Re-run it after syncing the trusted DB fingerprint, then restore the
        // service before the final TLS verification.
        await runSsh(
          `/opt/zacod/heartbeat.sh || true; systemctl start caddy; systemctl is-active --quiet caddy && echo ZACOD_CADDY_READY`,
          "ZACOD_CADDY_READY",
          60_000,
        );
      }
    } catch (e: any) {
      await markInitDbFailed(inst.id, String(e?.message ?? e).slice(0, 500));
      throw e;
    }

    // 4.5) تطبيق استحقاق لوحة السوبر أدمن المحلية. النسخة بدون لوحة تُعطّل
    // الحسابات والجلسات القديمة؛ النسخة المفعلة تزرع الحساب المحدد فقط.
    if (inst.mode === "full") {
      await reload();
      log.push(await syncAgentSuperadminAccount(inst));
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
      // Custom/external packages are always encrypted. The checkbox remains
      // relevant only to central-release installs for backwards compatibility.
      const enc = opts.variant === "upload" ? true : opts.encryptBundle;
      const encQ = enc ? "&enc=1" : "";
      const pass = enc ? bundlePassphrase(inst) : "";
      // أمر تنزيل موحّد: عند تفعيل «حزمة مشفّرة» تُنزَّل الحزمة مشفّرة
      // (AES-256-CBC/PBKDF2 بصيغة openssl القياسية) وتُفكّ على السيرفر.
      const releaseAuthPath = "/opt/zacod/.release-auth.curl";
      const dlCmd = (url: string, out: string, withReleaseAuth = false, expectedSha256 = "") => {
        const auth = withReleaseAuth ? `--config ${releaseAuthPath} ` : "";
        const verifySha = expectedSha256
          ? `printf '%s  %s\\n' ${shQ(expectedSha256)} ${shQ(`${out}.enc`)} | sha256sum -c -`
          : "true";
        return enc
        ? `curl ${auth}-fsS ${shQ(url)} -o ${out}.enc
${verifySha}
openssl enc -d -aes-256-cbc -pbkdf2 -iter 10000 -md sha256 -pass "pass:$ZACOD_BUNDLE_KEY" -in ${out}.enc -out ${out}
rm -f ${out}.enc`
        : `curl ${auth}-fsS ${shQ(url)} -o ${out}`;
      };
      const keyExport = enc ? `export ZACOD_BUNDLE_KEY=${shQ(pass)}` : `export ZACOD_BUNDLE_KEY=`;

      // مصدر التطبيق: حزمة المنصة (الافتراضي) أو الملفات المرفوعة يدويًا.
      let bundleUrl = `${origin}/api/agent/release/bundle?manual=1${encQ}`;
      let relVersion = "";
      let frontendCmd = "";
      if (opts.variant === "upload") {
        const meta = readPackageMap(inst.externalPackageMeta);
        if (!meta.backend || !verifyPackageEntry(inst.id, "backend", meta.backend)) {
          throw new Error("لم تُرفع حزمة Backend — ارفع الملفات من نافذة «تسطيب برفع ملفات» أولًا.");
        }
        relVersion = meta.backend.version || `external-${meta.backend.sha256.slice(0, 16)}`;
        installedAppVersion = relVersion;
        bundleUrl = buildCustomAgentReleaseUrl(origin, "backend", true);
        log.push(`مصدر التطبيق: ${inst.packageSource === "external" ? "نسخة كاملة خارجية" : "ملفات مرفوعة"} (${meta.backend.filename}, ${Math.round(meta.backend.sizeBytes / 1024 / 1024)}MB) — مشفّرة ومتحقق من بصمتها`);
        if (meta.frontend && verifyPackageEntry(inst.id, "frontend", meta.frontend)) {
          const fUrl = buildCustomAgentReleaseUrl(origin, "frontend", true);
          frontendCmd = `${dlCmd(fUrl, "/tmp/zacod-front.tgz", true, meta.frontend.sha256)}
mkdir -p /opt/zacod/app.new/public
tar -xzf /tmp/zacod-front.tgz -C /opt/zacod/app.new/public
rm -f /tmp/zacod-front.tgz
echo "Frontend مرفوع: تم فكّه"`;
          log.push(`+ حزمة Frontend مرفوعة (${meta.frontend.filename})`);
        }
        // ملاحظة: استعادة نسخة قاعدة البيانات المرفوعة تمت في الخطوة 3.5
        // (قبل زرع السكيما والبصمة) — لا شيء يُستعاد هنا.
      } else {
        // Warm the bundle cache before the agent curls it.
        const { getReleaseInfo } = await import("../lib/agentRelease.js");
        const rel = await getReleaseInfo();
        relVersion = rel.version;
        installedAppVersion = relVersion;
        bundleUrl = `${origin}/api/agent/release/bundle?manual=1&version=${encodeURIComponent(rel.version)}${encQ}`;
        log.push(`إصدار الحزمة: ${rel.version} (${Math.round(rel.sizeBytes / 1024 / 1024)}MB)${enc ? " — مشفّرة أثناء النقل" : ""}`);
      }
      // Full agents run independently from Replit, so they cannot use the
      // central Outlook connector. Preserve an agent's existing SMTP config
      // across reinstalls, or seed it once from this deployment's SMTP env.
      // Values are written only to the remote mode-0600 EnvironmentFile and
      // are never added to the installation log.
      const systemdEnvLine = (key: string, value: string): string => {
        const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "");
        return `${key}="${escaped}"`;
      };
      const smtpSeedLines = ([
        ["SMTP_HOST", process.env.SMTP_HOST],
        ["SMTP_PORT", process.env.SMTP_PORT],
        ["SMTP_USER", process.env.SMTP_USER],
        ["SMTP_PASS", process.env.SMTP_PASS],
        ["SMTP_FROM", process.env.SMTP_FROM],
      ] as const)
        .filter((entry): entry is readonly [string, string] => !!entry[1])
        .map(([key, value]) =>
          `if [ -f "$OLD_ENV" ] && grep -q '^${key}=' "$OLD_ENV"; then grep '^${key}=' "$OLD_ENV" | tail -n1 >> "$NEW_ENV"; else printf '%s\\n' ${shQ(systemdEnvLine(key, value))} >> "$NEW_ENV"; fi`,
        )
        .join("\n");
      await runSsh(`set -Ee
export DEBIAN_FRONTEND=noninteractive
${keyExport}
NEED_NODE=1
if command -v node >/dev/null 2>&1; then MAJ=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0); [ "$MAJ" -ge 20 ] && NEED_NODE=0; fi
if [ "$NEED_NODE" = "1" ]; then curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null; apt-get install -y nodejs >/dev/null; fi
echo "Node: $(node -v)"
${enc ? `command -v openssl >/dev/null 2>&1 || { apt-get update -y >/dev/null; apt-get install -y openssl >/dev/null; }` : `true`}
mkdir -p /opt/zacod
umask 077
trap 'rm -f ${releaseAuthPath}' EXIT
RELEASE_INSTALLATION_ID=${shQ(inst.installationId)}
RELEASE_LICENSE_KEY=${shQ(inst.licenseKey ?? "")}
printf 'header = "X-Zacod-Installation-Id: %s"\\nheader = "X-Zacod-License-Key: %s"\\n' "$RELEASE_INSTALLATION_ID" "$RELEASE_LICENSE_KEY" > ${releaseAuthPath}
unset RELEASE_INSTALLATION_ID RELEASE_LICENSE_KEY
${dlCmd(bundleUrl, "/tmp/zacod-app.tgz", true, opts.variant === "upload" ? readPackageMap(inst.externalPackageMeta).backend?.sha256 ?? "" : "")}
rm -rf /opt/zacod/app.new && mkdir -p /opt/zacod/app.new
tar -xzf /tmp/zacod-app.tgz -C /opt/zacod/app.new
rm -f /tmp/zacod-app.tgz
echo ${shQ(relVersion)} > /opt/zacod/app.new/VERSION
${frontendCmd || "true"}
rm -f ${releaseAuthPath}
trap - EXIT
OLD_ENV=/opt/zacod/app.env
NEW_ENV=/opt/zacod/app.env.new
if [ -f "$OLD_ENV" ] && grep -q '^SESSION_SECRET=' "$OLD_ENV"; then SS=$(grep '^SESSION_SECRET=' "$OLD_ENV" | cut -d= -f2-); else SS=$(head -c32 /dev/urandom | od -An -tx1 | tr -d ' \\n'); fi
{ echo "NODE_ENV=production"; echo "PORT=8080"; echo "DATABASE_URL=${localDbUrl}"; echo "SESSION_SECRET=$SS"; echo "PUBLIC_BASE_URL=https://${inst.domain}"; } > "$NEW_ENV"
${smtpSeedLines || "true"}
mv "$NEW_ENV" "$OLD_ENV"
chmod 600 /opt/zacod/app.env
true
APP_SWAPPED=0
rollback_app() {
  local rc=$?
  trap - ERR
  set +e
  if [ "$APP_SWAPPED" = "1" ]; then
    systemctl stop zacod-app
    rm -rf /opt/zacod/app.failed
    [ ! -d /opt/zacod/app ] || mv /opt/zacod/app /opt/zacod/app.failed
    [ ! -d /opt/zacod/app.old ] || mv /opt/zacod/app.old /opt/zacod/app
    systemctl start zacod-app
  fi
  echo "ERROR: فشل إصدار التطبيق الجديد وتمت محاولة استعادة الإصدار السابق"
  exit "$rc"
}
trap rollback_app ERR
rm -rf /opt/zacod/app.old; [ -d /opt/zacod/app ] && mv /opt/zacod/app /opt/zacod/app.old; mv /opt/zacod/app.new /opt/zacod/app
APP_SWAPPED=1
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
# لا يوجد cron للتحديث: تنزيل/تثبيت النسخ يبدأ فقط من زر مسؤول الوكيل.
rm -f /opt/zacod/update.sh
( crontab -l 2>/dev/null | grep -v zacod-update | grep -v '/opt/zacod/update.sh' ) | crontab - || true
systemctl daemon-reload
systemctl enable zacod-app >/dev/null 2>&1
systemctl restart zacod-app
TARGET_VERSION=${shQ(relVersion)}
CODE=000
for i in $(seq 1 24); do
  sleep 5
  CODE=$(curl -s -o /tmp/zacod-update-ready.json -w '%{http_code}' --max-time 4 "http://127.0.0.1:8080/api/healthz/agent-update?version=$TARGET_VERSION" || echo 000)
  [ "$CODE" = "200" ] && break
done
echo "Update readiness HTTP: $CODE"
[ "$CODE" = "200" ] || { cat /tmp/zacod-update-ready.json 2>/dev/null || true; journalctl -u zacod-app -n 60 --no-pager 2>/dev/null | tail -60; false; }
APP_SWAPPED=0
trap - ERR
rm -f /tmp/zacod-update-ready.json
echo "الإصدار المثبت: $TARGET_VERSION — ترقية السكيما جاهزة"
echo ZACOD_APP_DONE`, "ZACOD_APP_DONE", 600_000);
    } else {
      await step("5/6 تثبيت التطبيق");
      log.push("النسخة ليست «كاملة» — لا يلزم تثبيت تطبيق محلي (يُخدَم من المنصة المركزية).");
    }

    // 6) final health
    await step("6/6 الفحص النهائي");
    await reload();
    await withAgentPool(inst.dbUrlEnc!, async (pool) => {
      await pool.query("SELECT 1");
      await assertAgentSupplierMetadataSchema(pool);
    });
    if (installedAppVersion) {
      log.push(`تم التحقق من إصدار Backend المثبت (${installedAppVersion}) وترقية مخطط قاعدة البيانات ✔`);
    }
    if (autoDomain && autoDomainApplied) {
      await verifyPreparedAutoDomain(
        inst,
        autoDomain.plan,
        autoDomainApplied,
        autoDomain.operationId,
        autoDomainLog,
      );
      log.push("الدومين وSSL جاهزان تلقائيًا ✔");
      await logAgentEvent(inst.id, "auto_domain_ready", {
        domain: inst.domain,
        zone: autoDomain.plan.zoneName,
        originIp: autoDomain.plan.originIp,
        proxied: autoDomain.plan.desiredProxied,
        duringProvision: true,
      });
    }
    log.push("قاعدة البيانات تستجيب ومخططها متوافق. اكتمل التسطيب بنجاح ✔");
    if (!autoDomain) {
      log.push(`تذكير: وجّه دومين ${inst.domain} (سجل A) إلى IP السيرفر ليصدر Caddy شهادة SSL تلقائيًا.`);
    }
    await save("ok");
    await logAgentEvent(inst.id, "provisioned", { mode: inst.mode }, undefined as any);
  } catch (e: any) {
    log.push(`\n✖ فشل التسطيب: ${String(e?.message ?? e).slice(0, 400)}`);
    if (autoDomain) {
      await failPreparedAutoDomain(inst.id, autoDomain.operationId, e, autoDomainLog);
      await logAgentEvent(inst.id, "auto_domain_failed", {
        domain: inst.domain,
        error: String(e?.message ?? e).slice(0, 300),
        duringProvision: true,
      });
    }
    await save("error");
  } finally {
    stopHeartbeat();
  }
}

router.post("/:id/provision", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  if (!inst.sshHost || !inst.sshUser || !inst.sshSecretEnc) { res.status(400).json({ error: "أكمل بيانات السيرفر (المضيف والمستخدم وكلمة المرور/المفتاح) أولًا" }); return; }
  // خيارات التسطيب (إضافية — الافتراضي يطابق السلوك الحالي تمامًا)
  const requestedVariant: ProvisionOpts["variant"] =
    req.body?.variant === "no_db" ? "no_db" : req.body?.variant === "upload" ? "upload" : "full";
  // External full editions always reuse the existing upload-based installer.
  // Do not introduce a fourth runtime mode: that would bypass existing license
  // and local-manual-update policy checks.
  const variant: ProvisionOpts["variant"] = inst.packageSource === "external" ? "upload" : requestedVariant;
  const encryptBundle = variant === "upload" ? true : req.body?.encryptBundle === true;
  const restoreUploadedDb = !(inst.packageSource === "external" && req.body?.variant === "upload_no_db");
  if (variant === "no_db" && !inst.dbUrlEnc) {
    res.status(400).json({ error: "«تسطيب بدون قاعدة بيانات» يتطلب إدخال رابط قاعدة البيانات في بيانات الوكيل أولًا" }); return;
  }
  if (variant === "upload") {
    if (inst.mode !== "full") { res.status(400).json({ error: "التسطيب برفع ملفات متاح للنسخة الكاملة فقط — غيّر نوع النسخة إلى «كاملة» أولًا" }); return; }
    const meta = readPackageMap(inst.externalPackageMeta);
    const requireAll = inst.packageSource === "external";
    if (!await packageMapAvailable(id, meta, requireAll)) {
      res.status(400).json({
        error: requireAll
          ? "النسخة الخارجية غير مكتملة — ارفع Backend وFrontend وقاعدة البيانات المشفّرة أولًا"
          : "ارفع حزمة Backend المشفّرة أولًا من نافذة التسطيب",
      });
      return;
    }
  }
  try { await assertProbeTargetAllowed(inst.sshHost); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? "عنوان غير مسموح") }); return; }
  const useAutoDomain = inst.autoDomainSetup;
  if (useAutoDomain) {
    // Validate signature/expiry before claiming. The authoritative DNS/server
    // re-plan is intentionally delayed until after the target is fenced.
    try { verifyAutoDomainConfirmation(req.body?.autoDomainConfirmationToken); }
    catch (e: any) {
      res.status(Number(e?.httpStatus) || 409).json({
        error: String(e?.message ?? e).slice(0, 500),
        code: e?.code ?? null,
      });
      return;
    }
  }
  // Claim FIRST (atomic — only one provision/deploy runs), then mint the
  // license inside the lease so a concurrent request can't overwrite the key
  // the pipeline is using.
  const provisionStartedAt = new Date();
  const operationId = randomBytes(16).toString("hex");
  const claimed = await db.update(agentInstancesTable)
    .set({
      deployStatus: "deploying",
      deployLeaseId: operationId,
      deployOperationPhase: "preflight",
      deployProviderMutationUntil: null,
      deployLog: "بدء التسطيب الكامل…",
      ...(useAutoDomain ? {
        autoDomainStatus: "configuring",
        autoDomainLeaseAt: provisionStartedAt,
        autoDomainLastError: null,
      } : {}),
      updatedAt: provisionStartedAt,
    })
    .where(and(
      eq(agentInstancesTable.id, id),
      ne(agentInstancesTable.deployStatus, "deploying"),
    )).returning({ id: agentInstancesTable.id });
  if (!claimed.length) { res.status(409).json({ error: "يوجد نشر/تسطيب جارٍ بالفعل" }); return; }
  const stopHeartbeat = startAgentOperationHeartbeat(id, operationId);
  const releaseClaim = async (error: unknown) => {
    const message = String((error as any)?.message ?? error).slice(0, 500);
    await db.update(agentInstancesTable).set({
      deployStatus: inst.deployStatus,
      deployLeaseId: null,
      deployOperationPhase: null,
      deployProviderMutationUntil: null,
      autoDomainLeaseAt: null,
      ...(useAutoDomain ? {
        autoDomainStatus: "error",
        autoDomainLastCheckAt: new Date(),
        autoDomainLastError: message,
      } : {}),
      updatedAt: new Date(),
    }).where(and(
      eq(agentInstancesTable.id, id),
      eq(agentInstancesTable.deployLeaseId, operationId),
    )).catch(() => {});
    stopHeartbeat();
  };
  // Auto-mint a license if missing — zero-step policy (post-claim).
  if (!inst.licenseKey) {
    inst.licenseKey = mintLicenseKey(inst.installationId, inst.domain);
    const licensed = await db.update(agentInstancesTable)
      .set({ licenseKey: inst.licenseKey, updatedAt: new Date() })
      .where(and(
        eq(agentInstancesTable.id, id),
        eq(agentInstancesTable.deployLeaseId, operationId),
      )).returning({ id: agentInstancesTable.id });
    if (!licensed.length) {
      await releaseClaim("فُقد قفل التسطيب قبل إصدار الترخيص");
      res.status(409).json({ error: "فُقد قفل التسطيب قبل إصدار الترخيص" });
      return;
    }
  }
  // Re-read the claimed row so the pipeline works off fresh state.
  const [fresh] = await db.select().from(agentInstancesTable).where(and(
    eq(agentInstancesTable.id, id),
    eq(agentInstancesTable.deployLeaseId, operationId),
  )).limit(1);
  if (!fresh) {
    await releaseClaim("فُقد قفل التسطيب قبل بدء المهمة");
    res.status(409).json({ error: "فُقد قفل التسطيب قبل بدء المهمة" });
    return;
  }
  let autoDomainPlan: CloudflareARecordPlan | undefined;
  if (useAutoDomain) {
    try {
      autoDomainPlan = await replanConfirmedAutoDomain(fresh, req.body?.autoDomainConfirmationToken);
      const recheckedServer = await inspectAutoDomainServer(fresh, autoDomainPlan.originIp);
      if (recheckedServer.conflicts.length) {
        throw Object.assign(new Error(recheckedServer.conflicts.join(" — ")), { httpStatus: 409 });
      }
    } catch (e: any) {
      await releaseClaim(e);
      res.status(Number(e?.httpStatus) || 409).json({
        error: String(e?.message ?? e).slice(0, 500),
        code: e?.code ?? null,
      });
      return;
    }
  }
  try {
    await initializeRemoteOperationFence(fresh, operationId);
  } catch (e: any) {
    await releaseClaim(e);
    res.status(409).json({ error: String(e?.message ?? e).slice(0, 500) });
    return;
  }
  await logAgentEvent(id, "provision_started", {
    by: (req as any).authUser?.username ?? null,
    mode: inst.mode,
    packageSource: inst.packageSource,
    variant,
    encryptBundle,
    restoreUploadedDb,
    automaticDomain: !!autoDomainPlan,
  }, req).catch(() => {});
  res.json({ ok: true, started: true });
  void runProvision(
    fresh,
    { variant, encryptBundle, restoreUploadedDb },
    operationId,
    stopHeartbeat,
    autoDomainPlan ? { plan: autoDomainPlan, operationId } : undefined,
  );
});

// ── حزم التسطيب الخارجية (Backend / Frontend / Database Backup) ────────────
// تحفظ دائمًا في App Storage الخاصة وهي مشفّرة قبل التخزين. لا يخرج للمتصفح
// إلا اسم/حجم/بصمة الملف، ولا تظهر مفاتيح الفك أو مسارات التخزين الخاصة.

router.post("/:id/external-package/prepare", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  if (inst.mode !== "full") { res.status(400).json({ error: "تجهيز الحزمة الخارجية متاح للنسخة الكاملة فقط" }); return; }
  if (!inst.dbUrlEnc) {
    res.status(400).json({ error: "أدخل رابط قاعدة بيانات الوكيل واختبره قبل تجهيز النسخة الكاملة" });
    return;
  }
  if (inst.deployStatus === "deploying") {
    res.status(409).json({ error: "انتظر انتهاء التسطيب الجاري قبل تجهيز حزمة جديدة" });
    return;
  }
  let workDir = "";
  const created: ExternalPackageMap = {};
  const createdObjectPaths: string[] = [];
  try {
    const dbUrl = decryptSecret(inst.dbUrlEnc);
    if (!dbUrl) throw new Error("تعذّر قراءة رابط قاعدة بيانات الوكيل");
    let parsedDbUrl: URL;
    try {
      parsedDbUrl = new URL(dbUrl);
    } catch {
      throw new Error("رابط قاعدة بيانات الوكيل غير صالح. ارفع ملف Database الجاهز من تبويب «الحزمة الخارجية»، أو أدخل رابط PostgreSQL كاملًا يبدأ بـ postgresql://");
    }
    if (!["postgres:", "postgresql:"].includes(parsedDbUrl.protocol) || !parsedDbUrl.hostname) {
      throw new Error("رابط قاعدة بيانات الوكيل يجب أن يكون رابط PostgreSQL كاملًا يبدأ بـ postgresql://");
    }
    const dbHost = parsedDbUrl.hostname;
    await assertProbeTargetAllowed(dbHost);
    workDir = await fsp.mkdtemp(path.join("/tmp", ".zacod-external-build-"));
    const [{ getReleaseInfo, findDistDir }] = await Promise.all([import("../lib/agentRelease.js")]);
    // The user explicitly requested a new package. Rebuild from the current
    // dist instead of reusing getReleaseInfo's immutable download cache.
    const release = await getReleaseInfo({ forceRebuild: true });
    const distDir = await findDistDir();
    const frontendPath = await buildFrontendArchive(distDir, workDir);
    const databasePath = await buildAgentDatabaseDump(dbUrl, workDir);
    const passphrase = bundlePassphrase(inst);
    const inputs: Record<ExternalPackageKind, { path: string; filename: string }> = {
      backend: { path: release.tarPath, filename: `zacod-backend-${release.version}.tgz` },
      frontend: { path: frontendPath, filename: `zacod-frontend-${release.version}.tgz` },
      db: { path: databasePath, filename: `zacod-database-${release.version}.dump` },
    };
    for (const kind of EXTERNAL_PACKAGE_KINDS) {
      const inspected = await inspectPlainPackagePath(inputs[kind].path, kind);
      const objectKey = packageObjectKey(id, kind, "packages");
      const encrypted = await encryptLocalFileToPrivateObject(inputs[kind].path, objectKey, passphrase);
      createdObjectPaths.push(encrypted.objectPath);
      const verified = await verifyEncryptedPackageObject(
        privateFileForObjectPath(encrypted.objectPath),
        passphrase,
        { sha256: inspected.sha256, sizeBytes: inspected.sizeBytes },
      );
      const entry: ExternalPackageEntry = {
        objectPath: encrypted.objectPath,
        filename: inputs[kind].filename,
        sizeBytes: verified.sizeBytes,
        sha256: verified.sha256,
        signature: "",
        uploadedAt: new Date().toISOString(),
        version: release.version,
        format: inspected.format,
        encrypted: true,
        verified: true,
        origin: "generated",
      };
      entry.signature = packageSignature({ agentId: id, kind, sha256: entry.sha256, sizeBytes: entry.sizeBytes, format: entry.format });
      created[kind] = entry;
    }
    const previous = await replacePackageMap(id, created);
    createdObjectPaths.length = 0;
    await Promise.all(EXTERNAL_PACKAGE_KINDS.map(kind => removePackageObject(previous[kind]?.objectPath)));
    await logAgentEvent(id, "external_package_prepared", {
      by: (req as any).authUser?.username ?? null,
      version: release.version,
      files: EXTERNAL_PACKAGE_KINDS.map(kind => ({ kind, sizeBytes: created[kind]!.sizeBytes, sha256: created[kind]!.sha256 })),
      databaseSource: "agent_database",
      excludedIdentityData: true,
    }, req);
    res.json({ ok: true, version: release.version, externalPackage: publicPackageMap(created) });
  } catch (error: any) {
    await Promise.all(createdObjectPaths.map(objectPath => removePackageObject(objectPath)));
    res.status(502).json({ error: String(error?.message ?? error).slice(0, 500) });
  } finally {
    if (workDir) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

router.get("/:id/custom-package", async (req, res) => {
  const id = Number(req.params.id);
  const [inst] = await db.select({
    id: agentInstancesTable.id,
    externalPackageMeta: agentInstancesTable.externalPackageMeta,
  }).from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(publicPackageMap(readPackageMap(inst.externalPackageMeta)));
});

router.post("/:id/custom-package/:kind/upload-url", async (req, res) => {
  const id = Number(req.params.id);
  const kind = String(req.params.kind) as CustomKind;
  if (!CUSTOM_KINDS.includes(kind)) { res.status(400).json({ error: "نوع ملف غير معروف" }); return; }
  const [inst] = await db.select({ id: agentInstancesTable.id, deployStatus: agentInstancesTable.deployStatus })
    .from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  if (inst.deployStatus === "deploying") { res.status(409).json({ error: "لا يمكن استبدال الحزمة أثناء التسطيب" }); return; }
  try {
    await sweepStalePackageUploads().catch(() => {});
    const target = await createDirectUploadTarget(
      id,
      kind,
      Number(req.body?.sizeBytes),
      req.get("origin") ?? undefined,
    );
    res.json({ ...target, expiresInSeconds: 900 });
  } catch (error: any) {
    res.status(400).json({ error: String(error?.message ?? error).slice(0, 300) });
  }
});

router.post("/:id/custom-package/:kind/complete", async (req, res) => {
  const id = Number(req.params.id);
  const kind = String(req.params.kind) as CustomKind;
  if (!CUSTOM_KINDS.includes(kind)) { res.status(400).json({ error: "نوع ملف غير معروف" }); return; }
  const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  if (inst.deployStatus === "deploying") { res.status(409).json({ error: "لا يمكن استبدال الحزمة أثناء التسطيب" }); return; }
  const objectPath = String(req.body?.objectPath ?? "");
  const expectedPrefix = `/objects/agent-packages/${id}/staging/${kind}-`;
  if (!objectPath.startsWith(expectedPrefix) || !objectPath.endsWith(".upload")) {
    res.status(400).json({ error: "ملف الرفع لا يخص هذا الوكيل أو هذا النوع" });
    return;
  }
  const filename = String(req.body?.filename ?? `${kind}.bin`).slice(0, 200)
    .replace(/[^\w.\-()\u0600-\u06FF ]+/g, "_")
    .replace(/\.(enc|zacpkg)$/i, "");
  let promotedObjectPath: string | null = null;
  try {
    const source = privateFileForObjectPath(objectPath);
    const [exists] = await source.exists();
    if (!exists) throw new Error("لم يكتمل رفع الملف إلى التخزين");
    const requestedSize = Number(req.body?.sizeBytes);
    if (!Number.isSafeInteger(requestedSize) || requestedSize <= 0) {
      throw new Error("حجم الملف المعلن غير صالح");
    }
    const finalKey = packageObjectKey(id, kind, "packages");
    const promoted = await promoteStagedUploadToEncryptedPackage({
      sourceObjectPath: objectPath,
      finalObjectKey: finalKey,
      passphrase: bundlePassphrase(inst),
      kind,
      expectedRawSize: requestedSize,
    });
    promotedObjectPath = promoted.objectPath;
    const entry: ExternalPackageEntry = {
      objectPath: promoted.objectPath,
      filename,
      sizeBytes: promoted.sizeBytes,
      sha256: promoted.sha256,
      signature: "",
      uploadedAt: new Date().toISOString(),
      version: null,
      format: promoted.format,
      encrypted: true,
      verified: true,
      origin: "uploaded",
    };
    entry.signature = packageSignature({ agentId: id, kind, sha256: entry.sha256, sizeBytes: entry.sizeBytes, format: entry.format });
    const previous = await replacePackageEntry(id, kind, entry);
    promotedObjectPath = null;
    await removePackageObject(previous?.objectPath);
    await logAgentEvent(id, "custom_package_uploaded", {
      kind,
      filename,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      encrypted: true,
      verified: true,
      by: (req as any).authUser?.username ?? null,
    }, req);
    res.json({ ok: true, kind, ...publicPackageMap({ [kind]: entry })[kind] });
  } catch (error: any) {
    await removePackageObject(objectPath);
    await removePackageObject(promotedObjectPath);
    res.status(400).json({ error: String(error?.message ?? error).slice(0, 500) });
  }
});

// Legacy compatibility: old clients may still send the raw package to the API.
// It is immediately encrypted before durable storage; new UI uses direct upload.
router.put("/:id/custom-package/:kind",
  express.raw({ type: () => true, limit: "800mb" }),
  async (req, res) => {
    const id = Number(req.params.id);
    const kind = String(req.params.kind) as CustomKind;
    if (!CUSTOM_KINDS.includes(kind)) { res.status(400).json({ error: "نوع ملف غير معروف" }); return; }
    const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
    if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
    const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!body.length) { res.status(400).json({ error: "الملف فارغ" }); return; }
    const filename = String(req.query.filename ?? `${kind}.bin`).slice(0, 200).replace(/[^\w.\-()\u0600-\u06FF ]+/g, "_");
    if (inst.deployStatus === "deploying") { res.status(409).json({ error: "لا يمكن استبدال الحزمة أثناء التسطيب" }); return; }
    if ((kind === "backend" || kind === "frontend") && !(body[0] === 0x1f && body[1] === 0x8b)) {
      res.status(400).json({ error: "يجب أن تكون الحزمة بصيغة tar.gz (مضغوطة gzip)" }); return;
    }
    const workDir = await fsp.mkdtemp(path.join("/tmp", ".zacod-legacy-upload-"));
    const plainPath = path.join(workDir, "package.bin");
    let objectPath: string | null = null;
    try {
      await fsp.writeFile(plainPath, body, { mode: 0o600 });
      const inspected = await inspectPlainPackagePath(plainPath, kind);
      const objectKey = packageObjectKey(id, kind, "packages");
      const encrypted = await encryptLocalFileToPrivateObject(plainPath, objectKey, bundlePassphrase(inst));
      objectPath = encrypted.objectPath;
      const verified = await verifyEncryptedPackageObject(
        privateFileForObjectPath(objectPath),
        bundlePassphrase(inst),
        { sha256: inspected.sha256, sizeBytes: inspected.sizeBytes },
      );
      const entry: ExternalPackageEntry = {
        objectPath,
        filename,
        sizeBytes: verified.sizeBytes,
        sha256: verified.sha256,
        signature: "",
        uploadedAt: new Date().toISOString(),
        version: null,
        format: inspected.format,
        encrypted: true,
        verified: true,
        origin: "uploaded",
      };
      entry.signature = packageSignature({ agentId: id, kind, sha256: entry.sha256, sizeBytes: entry.sizeBytes, format: entry.format });
      const previous = await replacePackageEntry(id, kind, entry);
      await removePackageObject(previous?.objectPath);
      await logAgentEvent(id, "custom_package_uploaded", { kind, filename, sizeBytes: entry.sizeBytes, sha256: entry.sha256, encrypted: true, verified: true, legacyUpload: true }, req);
      res.json({ ok: true, kind, ...publicPackageMap({ [kind]: entry })[kind] });
    } catch (error: any) {
      await removePackageObject(objectPath);
      res.status(400).json({ error: String(error?.message ?? error).slice(0, 500) });
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  });

router.delete("/:id/custom-package/:kind", async (req, res) => {
  const id = Number(req.params.id);
  const kind = String(req.params.kind) as CustomKind;
  if (!CUSTOM_KINDS.includes(kind)) { res.status(400).json({ error: "نوع ملف غير معروف" }); return; }
  const [inst] = await db.select({
    id: agentInstancesTable.id,
    packageSource: agentInstancesTable.packageSource,
    deployStatus: agentInstancesTable.deployStatus,
  }).from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  if (inst.deployStatus === "deploying") { res.status(409).json({ error: "لا يمكن حذف الحزمة أثناء التسطيب" }); return; }
  if (inst.packageSource === "external") {
    res.status(409).json({ error: "حوّل نوع النسخة إلى إصدار مركزي قبل حذف أحد ملفات النسخة الخارجية" });
    return;
  }
  const previous = await replacePackageEntry(id, kind, null);
  await removePackageObject(previous?.objectPath);
  await logAgentEvent(id, "custom_package_deleted", { kind, by: (req as any).authUser?.username ?? null }, req);
  res.json({ ok: true });
});

router.get("/:id/custom-package/:kind/download", async (req, res) => {
  const id = Number(req.params.id);
  const kind = String(req.params.kind) as CustomKind;
  if (!CUSTOM_KINDS.includes(kind)) { res.status(400).json({ error: "نوع ملف غير معروف" }); return; }
  const [inst] = await db.select({
    id: agentInstancesTable.id,
    externalPackageMeta: agentInstancesTable.externalPackageMeta,
  }).from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
  if (!inst) { res.status(404).json({ error: "غير موجود" }); return; }
  const entry = readPackageMap(inst.externalPackageMeta)[kind];
  if (!entry || !verifyPackageEntry(id, kind, entry)) { res.status(404).json({ error: "الملف غير متاح" }); return; }
  try {
    res.setHeader("Content-Disposition", `attachment; filename="${kind}-${entry.sha256.slice(0, 12)}.zacpkg.enc"`);
    await logAgentEvent(id, "external_package_downloaded", { kind, sha256: entry.sha256, by: (req as any).authUser?.username ?? null }, req);
    await streamPrivatePackage(res, entry);
  } catch (error: any) {
    if (!res.headersSent) res.status(503).json({ error: String(error?.message ?? error).slice(0, 300) });
    else res.destroy();
  }
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

// Create a capability on the target platform. The plaintext capability is
// returned exactly once; only its verifier remains in PostgreSQL.
router.post("/platform-links/invites", async (req, res) => {
  try {
    const identity = localPlatformIdentity();
    const invite = createPlatformLinkInvite({
      targetPlatformId: identity.platformId,
      targetOrigin: identity.origin,
      lifetimeMs: Number(req.body?.lifetimeSeconds) * 1000 || undefined,
    });
    await db.insert(agentPlatformLinkInvitesTable).values({
      inviteId: invite.inviteId,
      targetPlatformId: invite.targetPlatformId,
      targetOrigin: invite.targetOrigin,
      secretVerifier: sha256Verifier(invite.inviteSecret),
      secretEnc: encryptSecret(invite.inviteSecret),
      expiresAt: new Date(invite.expiresAt),
      createdByUserId: (req as any).authUser?.id ?? null,
    });
    await logAgentEvent(null, "platform_link_invite_created", {
      inviteId: invite.inviteId, targetPlatformId: invite.targetPlatformId, expiresAt: invite.expiresAt,
    }, req);
    res.status(201).json(invite);
  } catch (error: any) {
    res.status(400).json({ error: String(error?.message ?? error).slice(0, 200) });
  }
});

// Run on the source platform. The resulting portable file contains neither
// the invite secret, raw license, DB URL nor any business data.
router.post("/:id/controller-links/export", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const invite = validateInvite(req.body?.invite);
    const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, id)).limit(1);
    if (!inst || !inst.licenseKey) { res.status(404).json({ error: "agent_or_license_not_found" }); return; }
    const source = localPlatformIdentity();
    const existing = await db.select().from(agentControllerLinksTable).where(and(
      eq(agentControllerLinksTable.localAgentId, inst.id), eq(agentControllerLinksTable.direction, "outbound"),
    ));
    const previous = existing.length ? highestControllerState(existing, [
      source.platformId, invite.targetPlatformId, ...existing.map(x => x.targetPlatformId),
    ]) : null;
    const epoch = previous?.controllerEpoch ?? 0;
    const activeControllerId = previous?.activeControllerId ?? source.platformId;
    const linkId = randomUUID();
    const controllerToken = deriveControllerToken(invite.inviteSecret, linkId, invite.targetPlatformId);
    const payload = {
      schemaVersion: 1 as const,
      linkId,
      inviteId: invite.inviteId,
      expiresAt: invite.expiresAt,
      agent: {
        name: inst.name,
        domain: inst.domain,
        extraDomains: Array.isArray(inst.extraDomains) ? inst.extraDomains as string[] : [],
        installationId: inst.installationId,
        dbFingerprint: inst.dbFingerprint,
        licenseExpiresAt: inst.licenseExpiresAt?.toISOString() ?? null,
        maxCompanies: inst.maxCompanies,
        version: inst.deployedVersion,
        status: inst.status,
        packageSource: inst.packageSource,
        licenseVerifier: licenseKeyVerifier(inst.licenseKey),
      },
      source,
      target: { platformId: invite.targetPlatformId, origin: invite.targetOrigin },
      controllerEpoch: epoch,
      activeControllerId,
    };
    const file = buildControllerLinkFile(payload, invite.inviteSecret);
    await db.insert(agentControllerLinksTable).values({
      linkId, direction: "outbound", localAgentId: inst.id,
      sourcePlatformId: source.platformId, sourceOrigin: source.origin,
      targetPlatformId: invite.targetPlatformId, targetOrigin: invite.targetOrigin,
      name: inst.name, domain: inst.domain, extraDomains: payload.agent.extraDomains,
      installationId: inst.installationId, dbFingerprint: inst.dbFingerprint,
      licenseVerifier: payload.agent.licenseVerifier, licenseExpiresAt: inst.licenseExpiresAt,
      controllerTokenVerifier: sha256Verifier(controllerToken), controllerTokenEnc: encryptSecret(controllerToken),
      maxCompanies: inst.maxCompanies, agentVersion: inst.deployedVersion,
      status: inst.status, packageSource: inst.packageSource, controllerEpoch: epoch,
      activeControllerId,
    });
    const shell = await syncShellControllerConfig(inst).then(() => ({ shellSynced: true })).catch((e: any) => ({
      shellSynced: false, shellSyncError: String(e?.message ?? e).slice(0, 160),
    }));
    await logAgentEvent(inst.id, "controller_link_exported", {
      linkId, inviteId: invite.inviteId, targetPlatformId: invite.targetPlatformId,
    }, req);
    res.status(201).json({ file, ...shell });
  } catch (error: any) {
    res.status(400).json({ error: String(error?.message ?? error).slice(0, 200) });
  }
});

async function inspectControllerImport(body: any, now = new Date()) {
  const identity = localPlatformIdentity();
  const inviteId = String(body?.file?.payload?.inviteId ?? "");
  const [stored] = await db.select().from(agentPlatformLinkInvitesTable)
    .where(eq(agentPlatformLinkInvitesTable.inviteId, inviteId)).limit(1);
  if (!stored) throw new Error("invite_not_found");
  const secret = stored.secretEnc ? decryptSecret(stored.secretEnc) : "";
  if (!secret) throw new Error("invite_secret_unavailable");
  assertStoredInviteUsable(stored, secret, now);
  const file = verifyControllerLinkFile(body.file, secret, {
    inviteId, platformId: identity.platformId, origin: identity.origin,
  }, now);
  const a = file.payload.agent;
  const candidates = [a.domain, ...a.extraDomains];
  const localConflict = await findDomainConflict(candidates, null);
  if (localConflict) throw new Error(`domain_conflict:${localConflict}`);
  const [localInstall] = await db.select({ id: agentInstancesTable.id }).from(agentInstancesTable)
    .where(eq(agentInstancesTable.installationId, a.installationId)).limit(1);
  if (localInstall) throw new Error("installation_conflict");
  const imported = await db.select().from(agentControllerLinksTable)
    .where(eq(agentControllerLinksTable.direction, "imported"));
  for (const row of imported) {
    if (row.linkId === file.payload.linkId) continue;
    const owned = [row.domain, ...(Array.isArray(row.extraDomains) ? row.extraDomains as string[] : [])];
    if (row.installationId === a.installationId) throw new Error("installation_conflict");
    const conflict = candidates.find(d => owned.includes(d));
    if (conflict) throw new Error(`domain_conflict:${conflict}`);
  }
  return { stored, secret, file };
}

router.post("/platform-links/preview", async (req, res) => {
  try {
    const { file } = await inspectControllerImport(req.body);
    res.json({ valid: true, link: file.payload });
  } catch (error: any) {
    res.status(400).json({ valid: false, error: String(error?.message ?? error).slice(0, 200) });
  }
});

router.post("/platform-links/import", async (req, res) => {
  try {
    const { file, secret } = await inspectControllerImport(req.body);
    const p = file.payload;
    await db.transaction(async tx => {
      const consumed = await tx.update(agentPlatformLinkInvitesTable)
        .set({ consumedAt: new Date() })
        .where(and(
          eq(agentPlatformLinkInvitesTable.inviteId, p.inviteId),
          sql`${agentPlatformLinkInvitesTable.consumedAt} IS NULL`,
          sql`${agentPlatformLinkInvitesTable.expiresAt} > NOW()`,
        )).returning({ inviteId: agentPlatformLinkInvitesTable.inviteId });
      if (!consumed.length) throw new Error("invite_already_consumed");
      await tx.insert(agentControllerLinksTable).values({
        linkId: p.linkId, direction: "imported", localAgentId: null,
        sourcePlatformId: p.source.platformId, sourceOrigin: p.source.origin,
        targetPlatformId: p.target.platformId, targetOrigin: p.target.origin,
        name: p.agent.name, domain: p.agent.domain, extraDomains: p.agent.extraDomains,
        installationId: p.agent.installationId, dbFingerprint: p.agent.dbFingerprint,
        licenseVerifier: p.agent.licenseVerifier,
        controllerTokenVerifier: sha256Verifier(deriveControllerToken(secret, p.linkId, p.target.platformId)),
        licenseExpiresAt: p.agent.licenseExpiresAt ? new Date(p.agent.licenseExpiresAt) : null,
        maxCompanies: p.agent.maxCompanies, agentVersion: p.agent.version,
        status: p.agent.status, packageSource: p.agent.packageSource,
        controllerEpoch: p.controllerEpoch, activeControllerId: p.activeControllerId,
      });
    });
    await logAgentEvent(null, "controller_link_imported", {
      linkId: p.linkId, inviteId: p.inviteId, sourcePlatformId: p.source.platformId,
    }, req);
    res.status(201).json({ imported: true, linkId: p.linkId });
  } catch (error: any) {
    res.status(400).json({ error: String(error?.message ?? error).slice(0, 200) });
  }
});

router.post("/:id/controller-leadership", async (req, res) => {
  const agentId = Number(req.params.id);
  try {
    const requestedEpoch = Number(req.body?.controllerEpoch);
    const activeControllerId = platformId(String(req.body?.activeControllerId ?? ""));
    const local = localPlatformIdentity();
    const rows = await db.select().from(agentControllerLinksTable)
      .where(and(eq(agentControllerLinksTable.localAgentId, agentId), eq(agentControllerLinksTable.direction, "outbound")));
    if (!rows.length) throw new Error("controller_link_not_found");
    const current = Math.max(...rows.map(r => r.controllerEpoch));
    assertMonotonicEpoch(current, requestedEpoch);
    if (activeControllerId !== local.platformId && !rows.some(r => r.targetPlatformId === activeControllerId)) {
      throw new Error("unknown_controller");
    }
    await db.update(agentControllerLinksTable).set({
      controllerEpoch: requestedEpoch, activeControllerId, updatedAt: new Date(),
    }).where(and(eq(agentControllerLinksTable.localAgentId, agentId), eq(agentControllerLinksTable.direction, "outbound")));
    const [inst] = await db.select().from(agentInstancesTable).where(eq(agentInstancesTable.id, agentId)).limit(1);
    const shell = inst ? await syncShellControllerConfig(inst).then(() => ({ shellSynced: true })).catch((e: any) => ({
      shellSynced: false, shellSyncError: String(e?.message ?? e).slice(0, 160),
    })) : { shellSynced: false, shellSyncError: "agent_not_found" };
    await logAgentEvent(agentId, "controller_leadership_changed", {
      activeControllerId, controllerEpoch: requestedEpoch,
    }, req);
    res.json({ activeControllerId, controllerEpoch: requestedEpoch, restartRequired: false, ...shell });
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? error).slice(0, 200) });
  }
});

router.post("/platform-links/:linkId/leadership", async (req, res) => {
  try {
    const [link] = await db.select().from(agentControllerLinksTable).where(and(
      eq(agentControllerLinksTable.linkId, req.params.linkId),
      eq(agentControllerLinksTable.direction, "imported"),
    )).limit(1);
    if (!link) { res.status(404).json({ error: "controller_link_not_found" }); return; }
    const requestedEpoch = Number(req.body?.controllerEpoch);
    const activeControllerId = platformId(String(req.body?.activeControllerId ?? ""));
    assertMonotonicEpoch(link.controllerEpoch, requestedEpoch);
    if (![link.sourcePlatformId, link.targetPlatformId].includes(activeControllerId)) throw new Error("unknown_controller");
    await db.update(agentControllerLinksTable).set({
      controllerEpoch: requestedEpoch, activeControllerId, updatedAt: new Date(),
    }).where(eq(agentControllerLinksTable.id, link.id));
    await logAgentEvent(null, "linked_controller_leadership_changed", {
      linkId: link.linkId, activeControllerId, controllerEpoch: requestedEpoch,
    }, req);
    res.json({ activeControllerId, controllerEpoch: requestedEpoch, restartRequired: false });
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? error).slice(0, 200) });
  }
});

router.get("/:id/controller-links", async (req, res) => {
  const agentId = Number(req.params.id);
  const rows = await db.select().from(agentControllerLinksTable).where(and(
    eq(agentControllerLinksTable.localAgentId, agentId), eq(agentControllerLinksTable.direction, "outbound"),
  ));
  res.json(rows.map(({ licenseVerifier: _v, controllerTokenVerifier: _tv, controllerTokenEnc: _te, ...safe }) => safe));
});

router.get("/platform-links/imported", async (_req, res) => {
  const rows = await db.select().from(agentControllerLinksTable)
    .where(eq(agentControllerLinksTable.direction, "imported"));
  res.json(rows.map(({ licenseVerifier: _v, controllerTokenVerifier: _tv, controllerTokenEnc: _te, ...safe }) => safe));
});

export default router;

// ── Public router (no auth) — branding + heartbeat ─────────────────────────

export const agentPublicRouter = Router();

// GET /api/branding?host=... — light login-page branding for agent domains.
agentPublicRouter.get("/branding", async (req, res) => {
  const host = typeof req.query.host === "string" ? normalizeHost(req.query.host) : await resolveAgentRequestHost(req);
  const hit = await lookupAgentByHost(host);
  if (!hit) {
    const local = await readLocalAgentRuntimeState();
    if (local.isLocalAgent) {
      res.json({
        isAgentDomain: true,
        localSuperadminEnabled: local.localSuperadminEnabled,
        localSuperadminScreens: local.localSuperadminScreens,
      });
      return;
    }
    res.json({ isAgentDomain: false, localSuperadminEnabled: true, localSuperadminScreens: [...LOCAL_SUPERADMIN_SCREEN_IDS] });
    return;
  }
  res.json({
    isAgentDomain: true,
    // Requests served by the central control plane never expose a local SA
    // panel, even if the registered full edition will expose one after install.
    localSuperadminEnabled: false,
    localSuperadminScreens: [],
    suspended: hit.status !== "active",
    brandName: hit.brandName, brandLogoUrl: hit.brandLogoUrl, brandColor: hit.brandColor,
  });
});

// GET /api/branding/manifest?host=... — PWA manifest rebranded per agent
// domain. The static /manifest.webmanifest ships the Zacode name, so the PWA
// install prompt («تثبيت زاكود») shows the wrong brand on agent domains; the
// index.html served on agent domains (and the client-side fallback) points
// the <link rel="manifest"> here instead. Falls back to Zacode branding when
// the host is not an agent domain, so it is always safe to reference.
// Covered by AGENT_PUBLIC_PATHS ("/branding" prefix) — works even for
// suspended agents (harmless, read-only, central-DB only).
agentPublicRouter.get("/branding/manifest", async (req, res) => {
  const host = typeof req.query.host === "string" ? normalizeHost(req.query.host) : await resolveAgentRequestHost(req);
  const hit = await lookupAgentByHost(host);
  const brand = hit?.brandName?.trim() || null;
  const name = brand ? `${brand} - ZATCA e-Invoicing` : "زاكود المحاسبي - ZATCA e-Invoicing";
  const shortName = brand ?? "زاكود";
  res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.json({
    name,
    short_name: shortName,
    description: brand
      ? `${brand} - نظام محاسبة سعودي معتمد من ZATCA - فاتورة إلكترونية، نقاط بيع، ومخزون`
      : "نظام محاسبة سعودي معتمد من ZATCA - فاتورة إلكترونية، نقاط بيع، ومخزون",
    lang: "ar", dir: "rtl", start_url: "/", scope: "/",
    display: "standalone", orientation: "portrait",
    background_color: "#ffffff", theme_color: "#047857",
    categories: ["business", "finance", "productivity"],
    icons: [
      { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "نقاط البيع", short_name: "POS", url: "/pos/", icons: [{ src: "/icon-192.png", sizes: "192x192" }] },
      { name: "الفواتير", short_name: "فواتير", url: "/invoices", icons: [{ src: "/icon-192.png", sizes: "192x192" }] },
    ],
  });
});

// GET /api/branding/index?host=... — the full SPA index.html rebranded for an
// agent host. Non-«full» agents can't rebrand server-side (their HTML comes
// from the central static layer, which answers before express), so their
// Caddy serves this file locally for the entry paths (/, /login, /register).
// The agent heartbeat cron refreshes the cached copy every 5 minutes.
// Covered by AGENT_PUBLIC_PATHS ("/branding" prefix).
agentPublicRouter.get("/branding/index", async (req, res) => {
  try {
    const host = typeof req.query.host === "string" ? normalizeHost(req.query.host) : await resolveAgentRequestHost(req);
    const hit = await lookupAgentByHost(host);
    const brand = hit?.brandName?.trim();
    if (!brand) { res.status(404).json({ error: "not_agent_domain" }); return; }
    const { readSpaIndexHtml, rebrandIndexHtml } = await import("../app.js");
    let html = (await readSpaIndexHtml())?.html ?? null;
    if (!html) {
      // Fallback: fetch our own public root — the static layer serves it.
      try {
        const r = await fetch(`${resolveCentralOrigin()}/`, { headers: { "User-Agent": "zacod-branding-fetch" } });
        if (r.ok) { const t = await r.text(); if (t.includes("<title>")) html = t; }
      } catch { /* fall through */ }
    }
    if (!html) { res.status(503).json({ error: "index_unavailable" }); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.send(rebrandIndexHtml(html, brand));
  } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e).slice(0, 200) }); }
});

// ── Release channel for «full» edition agents ──────────────────────────────
// Authenticated by installationId + licenseKey (same trust model as the
// heartbeat). Suspended/expired agents get 403 — the kill-switch also stops
// updates.
async function authReleaseRequest(
  req: any,
  res: any,
  options: { headersOnly?: boolean } = {},
): Promise<(typeof agentInstancesTable.$inferSelect & { importedLink?: false }) | (typeof agentControllerLinksTable.$inferSelect & { importedLink: true }) | null> {
  const { installationId, licenseKey } = resolveAgentReleaseCredentials({
    manual: options.headersOnly === true || isManualAgentReleaseRequest(req.query.manual),
    headers: req.headers ?? {},
    query: req.query ?? {},
  });
  const suppliedControllerToken = String(req.headers?.["x-zacod-controller-token"] ?? "");
  if (!installationId || (!licenseKey && !suppliedControllerToken)) { res.status(400).json({ error: "bad_request" }); return null; }
  const [localInst] = await db.select().from(agentInstancesTable)
    .where(eq(agentInstancesTable.installationId, installationId)).limit(1);
  let inst: any = localInst;
  if (!inst) {
    const [linked] = await db.select().from(agentControllerLinksTable).where(and(
      eq(agentControllerLinksTable.installationId, installationId),
      eq(agentControllerLinksTable.direction, "imported"),
    )).limit(1);
    const domain = normalizeHost(String(req.headers?.["x-zacod-domain"] ?? ""));
    const fingerprint = String(req.headers?.["x-zacod-db-fingerprint"] ?? "");
    const extras = Array.isArray(linked?.extraDomains) ? linked.extraDomains as string[] : [];
    const identity = localPlatformIdentity();
    const controllerToken = suppliedControllerToken;
    if (linked &&
        constantTimeHexEqual(sha256Verifier(controllerToken), linked.controllerTokenVerifier) &&
        !!domain && (domain === linked.domain || extras.includes(domain)) &&
        (!linked.dbFingerprint || fingerprint === linked.dbFingerprint) &&
        linked.activeControllerId === identity.platformId) {
      inst = { ...linked, importedLink: true };
    }
  }
  if (!inst || (!inst.importedLink && (!inst.licenseKey || inst.licenseKey !== licenseKey))) {
    await logAgentEvent(localInst?.id ?? null, "release_auth_failed", { installationId: installationId.slice(0, 64) }, req);
    res.status(403).json({ error: "forbidden" }); return null;
  }
  if (!inst.importedLink) {
    const outbound = await db.select().from(agentControllerLinksTable).where(and(
      eq(agentControllerLinksTable.localAgentId, inst.id), eq(agentControllerLinksTable.direction, "outbound"),
    ));
    const lead = outbound.reduce<typeof outbound[number] | null>((best, row) =>
      !best || row.controllerEpoch > best.controllerEpoch ? row : best, null);
    if (lead && lead.activeControllerId !== localPlatformIdentity().platformId) {
      res.status(403).json({ error: "inactive_controller" }); return null;
    }
  }
  if (!inst.importedLink && inst.mode !== "full") { res.status(403).json({ error: "not_full_edition" }); return null; }
  if (inst.status !== "active") { res.status(403).json({ error: "suspended" }); return null; }
  if (inst.licenseExpiresAt && new Date(inst.licenseExpiresAt) < new Date()) { res.status(403).json({ error: "license_expired" }); return null; }
  return inst;
}

agentPublicRouter.get("/agent/release/manifest", async (req, res) => {
  const manual = isManualAgentReleaseRequest(req.query.manual);
  // Old cron scripts include release credentials in the URL. They no longer
  // need authentication because this branch exposes no release metadata.
  // Scrub both URL fields before any finish-time application log serializer.
  req.url = stripAgentReleaseCredentialsFromUrl(req.url);
  req.originalUrl = stripAgentReleaseCredentialsFromUrl(req.originalUrl);
  res.setHeader("Cache-Control", "no-store");
  if (!manual) {
    res.json({ manualRequired: true });
    return;
  }
  const inst = await authReleaseRequest(req, res);
  if (!inst) return;
  try {
    const { getReleaseInfo } = await import("../lib/agentRelease.js");
    const rel = await getReleaseInfo();
    res.json({
      version: rel.version,
      sizeBytes: rel.sizeBytes,
      sha256: rel.sha256,
      publishedAt: rel.publishedAt,
    });
  } catch (e: any) { res.status(503).json({ error: String(e?.message ?? e).slice(0, 200) }); }
});

agentPublicRouter.get("/agent/release/bundle", async (req, res) => {
  req.url = stripAgentReleaseCredentialsFromUrl(req.url);
  req.originalUrl = stripAgentReleaseCredentialsFromUrl(req.originalUrl);
  const inst = await authReleaseRequest(req, res);
  if (!inst) return;
  if (!isManualAgentReleaseRequest(req.query.manual)) {
    res.status(409).json({ error: "manual_update_required" });
    return;
  }
  try {
    const { getReleaseInfo } = await import("../lib/agentRelease.js");
    const rel = await getReleaseInfo();
    const expectedVersion = typeof req.query.version === "string" ? req.query.version : "";
    if (expectedVersion && expectedVersion !== rel.version) {
      res.status(409).json({ error: "release_changed", version: rel.version });
      return;
    }
    const enc = req.query.enc === "1";
    await logAgentEvent(inst.importedLink ? null : inst.id, "release_downloaded", {
      version: rel.version, encrypted: enc, linked: !!inst.importedLink,
    }, req);
    if (enc) {
      // حزمة مشفّرة: AES-256-CBC/PBKDF2 بصيغة openssl — المفتاح مشتق لكل
      // وكيل ولا يمر في أي URL (يُسلَّم عبر SSH أثناء التسطيب فقط).
      if (inst.importedLink) {
        res.status(409).json({ error: "linked_encryption_not_supported" });
        return;
      }
      streamFileMaybeEncrypted(res, rel.tarPath, `zacod-app-${rel.version}.tgz.enc`, bundlePassphrase(inst));
      return;
    }
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="zacod-app-${rel.version}.tgz"`);
    res.sendFile(rel.tarPath);
  } catch (e: any) { res.status(503).json({ error: String(e?.message ?? e).slice(0, 200) }); }
});

// GET /api/agent/release/custom?kind=backend|frontend|db[&enc=1]
// قناة سحب الملفات المرفوعة للتسطيب المخصّص — مصادقة الرؤوس فقط.
agentPublicRouter.get("/agent/release/custom", async (req, res) => {
  req.url = stripAgentReleaseCredentialsFromUrl(req.url);
  req.originalUrl = stripAgentReleaseCredentialsFromUrl(req.originalUrl);
  const inst = await authReleaseRequest(req, res, { headersOnly: true });
  if (!inst) return;
  if (inst.importedLink) { res.status(404).json({ error: "not_uploaded" }); return; }
  const kind = String(req.query.kind ?? "") as CustomKind;
  if (!CUSTOM_KINDS.includes(kind)) { res.status(400).json({ error: "bad_kind" }); return; }
  const meta = readPackageMap(inst.externalPackageMeta);
  const entry = meta[kind];
  if (!entry || !verifyPackageEntry(inst.id, kind, entry)) { res.status(404).json({ error: "not_uploaded" }); return; }
  // Stored custom packages are always encrypted. `enc=1` remains accepted for
  // URL compatibility but never causes double encryption.
  await logAgentEvent(inst.id, "custom_package_downloaded", {
    kind,
    filename: entry.filename,
    sha256: entry.sha256,
    encrypted: true,
  }, req);
  try {
    res.setHeader("Content-Disposition", `attachment; filename="${kind}.enc"`);
    await streamPrivatePackage(res, entry);
  } catch (error: any) {
    if (!res.headersSent) res.status(503).json({ error: "package_unavailable" });
    else res.destroy();
  }
});

// POST /api/agent/heartbeat — instance validation. Body:
// { installationId, licenseKey, domain, fingerprint?, version? }
agentPublicRouter.post("/agent/heartbeat", async (req, res) => {
  const { installationId, licenseKey, domain: rawDomain, fingerprint, version, serverMarker } = req.body ?? {};
  const domain = normalizeHost(typeof rawDomain === "string" ? rawDomain : "");
  if (typeof installationId !== "string" || !installationId) { res.status(400).json({ ok: false, error: "bad_request" }); return; }

  const [inst] = await db.select().from(agentInstancesTable)
    .where(eq(agentInstancesTable.installationId, installationId)).limit(1);
  if (!inst) {
    const [linked] = await db.select().from(agentControllerLinksTable).where(and(
      eq(agentControllerLinksTable.installationId, installationId),
      eq(agentControllerLinksTable.direction, "imported"),
    )).limit(1);
    if (!linked) {
      await logAgentEvent(null, "unknown_installation", { installationId: String(installationId).slice(0, 64), domain }, req);
      res.status(403).json({ ok: false, error: "unknown_installation" }); return;
    }
    const problems: string[] = [];
    const extras = Array.isArray(linked.extraDomains) ? linked.extraDomains as string[] : [];
    if (!domain || (domain !== linked.domain && !extras.includes(domain))) problems.push("unknown_domain");
    const controllerToken = typeof req.body?.controllerToken === "string" ? req.body.controllerToken : "";
    if (!constantTimeHexEqual(sha256Verifier(controllerToken), linked.controllerTokenVerifier)) problems.push("controller_token_mismatch");
    if (linked.dbFingerprint && fingerprint !== linked.dbFingerprint) problems.push("db_fingerprint_mismatch");
    if (linked.licenseExpiresAt && linked.licenseExpiresAt < new Date()) problems.push("license_expired");
    if (linked.status !== "active") problems.push("suspended");
    if (problems.length) {
      await logAgentEvent(null, problems[0], { problems, domain, linkedLinkId: linked.linkId }, req);
      res.status(403).json({ ok: false, error: problems[0], problems }); return;
    }
    const reportedEpoch = Number(req.body?.controllerEpoch);
    const reportedActive = typeof req.body?.activeControllerId === "string" ? req.body.activeControllerId : "";
    const canConverge = Number.isSafeInteger(reportedEpoch) &&
      [linked.sourcePlatformId, linked.targetPlatformId].includes(reportedActive) &&
      (reportedEpoch > linked.controllerEpoch ||
        (reportedEpoch === linked.controllerEpoch && reportedActive.localeCompare(linked.activeControllerId) > 0));
    await db.update(agentControllerLinksTable).set({
      lastHeartbeatAt: new Date(), lastSeenIp: clientIp(req),
      ...(typeof version === "string" && version ? { deployedVersion: version.slice(0, 40) } : {}),
      ...(canConverge ? { controllerEpoch: reportedEpoch, activeControllerId: reportedActive } : {}),
      updatedAt: new Date(),
    }).where(eq(agentControllerLinksTable.id, linked.id));
    res.json({ ok: true, status: "active", licenseExpiresAt: linked.licenseExpiresAt, linked: true,
      activeControllerId: canConverge ? reportedActive : linked.activeControllerId,
      controllerEpoch: canConverge ? reportedEpoch : linked.controllerEpoch });
    return;
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

  // توجيه النبضة لصاحبها عند تعدد السيرفرات: العلامة المزروعة في config.json
  // تحدد أي سيرفر أرسلها. علامة السيرفر الرئيسي محفوظة على صف الوكيل
  // (فارغة تاريخيًا)؛ أي علامة أخرى تُنسب لصف السيرفر الاحتياطي المطابق.
  // التحقق أولًا — نبضة برخصة/دومين/بصمة غير صحيحة لا تُحدّث أي صف صحة
  // (وإلا بدا سيرفر مخترق «حيًّا» في اللوحة).
  if (problems.length) {
    await logAgentEvent(inst.id, problems[0], { problems, domain }, req);
    res.status(403).json({ ok: false, error: problems[0], problems }); return;
  }

  const marker = typeof serverMarker === "string" ? serverMarker.slice(0, 40) : "";
  const primaryMarker = inst.primaryHbMarker ?? "";
  const hbFields = {
    lastHeartbeatAt: new Date(), lastSeenIp: clientIp(req),
    ...(typeof version === "string" && version ? { deployedVersion: version.slice(0, 40) } : {}),
    updatedAt: new Date(),
  };
  if (marker === primaryMarker) {
    await db.update(agentInstancesTable).set(hbFields).where(eq(agentInstancesTable.id, inst.id));
  } else {
    const upd = await db.update(agentServersTable).set(hbFields)
      .where(and(eq(agentServersTable.agentId, inst.id), eq(agentServersTable.hbMarker, marker)))
      .returning({ id: agentServersTable.id });
    // علامة غير معروفة (سيرفر حُذف صفه مثلًا): لا نحدّث أي صف صحة —
    // نكتفي بالرد ok حتى لا نُسند نبضة مجهولة المصدر للسيرفر الرئيسي.
    if (!upd.length) {
      await logAgentEvent(inst.id, "unknown_server_marker", { marker: marker.slice(0, 40), domain }, req);
    }
  }
  const outbound = await db.select().from(agentControllerLinksTable).where(and(
    eq(agentControllerLinksTable.localAgentId, inst.id), eq(agentControllerLinksTable.direction, "outbound"),
  ));
  const lead = outbound.reduce<typeof outbound[number] | null>((best, row) =>
    !best || row.controllerEpoch > best.controllerEpoch ? row : best, null);
  const reportedEpoch = Number(req.body?.controllerEpoch);
  const reportedActive = typeof req.body?.activeControllerId === "string" ? req.body.activeControllerId : "";
  if (lead && Number.isSafeInteger(reportedEpoch) &&
      [localPlatformIdentity().platformId, ...outbound.map(x => x.targetPlatformId)].includes(reportedActive) &&
      (reportedEpoch > lead.controllerEpoch ||
        (reportedEpoch === lead.controllerEpoch && reportedActive.localeCompare(lead.activeControllerId) > 0))) {
    await db.update(agentControllerLinksTable).set({
      controllerEpoch: reportedEpoch, activeControllerId: reportedActive, updatedAt: new Date(),
    }).where(and(eq(agentControllerLinksTable.localAgentId, inst.id), eq(agentControllerLinksTable.direction, "outbound")));
    lead.controllerEpoch = reportedEpoch; lead.activeControllerId = reportedActive;
  }
  res.json({ ok: true, status: "active", licenseExpiresAt: inst.licenseExpiresAt,
    activeControllerId: lead?.activeControllerId ?? localPlatformIdentity().platformId,
    controllerEpoch: lead?.controllerEpoch ?? 0 });
});
