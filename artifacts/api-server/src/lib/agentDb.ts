/**
 * Cached external datasources for agent instances (سيرفرات الوكلاء).
 *
 * Each agent runs on his own domain with his OWN PostgreSQL; the central API
 * routes every request arriving from an agent domain to that database via
 * `runWithExternalDb` (AsyncLocalStorage proxy in @workspace/db).
 *
 * Pools are cached per agent id and keyed by the encrypted URL blob, so a
 * changed connection string (or re-encryption) transparently rebuilds the
 * pool and closes the stale one.
 */
import { createExternalDb, type ExternalDbContext } from "@workspace/db";
import { decryptSecret } from "./encryption.js";
import { logger } from "./logger.js";

type CacheEntry = { key: string; ctx: ExternalDbContext };
const cache = new Map<number, CacheEntry>();

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const externalPoolMax = positiveInt(process.env.PG_EXTERNAL_POOL_MAX, 10);

// One monitor covers every lazily-created agent pool. It emits only while
// callers are queued, labels the pool by the non-secret registry id, and never
// logs the decrypted URL or credentials.
if (process.env.PG_EXTERNAL_POOL_LOG !== "0" && process.env.PG_EXTERNAL_POOL_LOG !== "false") {
  const monitor = setInterval(() => {
    for (const [agentId, entry] of cache) {
      const { pool } = entry.ctx;
      if (pool.waitingCount > 0) {
        logger.warn({
          agentId,
          waiting: pool.waitingCount,
          total: pool.totalCount,
          idle: pool.idleCount,
          max: externalPoolMax,
        }, "Agent database pool saturated");
      }
    }
  }, positiveInt(process.env.PG_EXTERNAL_POOL_LOG_INTERVAL_MS, 15_000));
  monitor.unref();
}

export function getAgentDbContext(agentId: number, dbUrlEnc: string): ExternalDbContext {
  const hit = cache.get(agentId);
  if (hit && hit.key === dbUrlEnc) return hit.ctx;
  if (hit) hit.ctx.pool.end().catch(() => {});
  const url = decryptSecret(dbUrlEnc);
  if (!url) throw new Error("agent db url missing");
  const ctx = createExternalDb(url, { max: externalPoolMax });
  cache.set(agentId, { key: dbUrlEnc, ctx });
  logger.info({ agentId, max: externalPoolMax }, "Agent database pool created");
  return ctx;
}

export function getAgentDbPoolStats(agentId: number): {
  waiting: number;
  total: number;
  idle: number;
  max: number;
} | null {
  const hit = cache.get(agentId);
  if (!hit) return null;
  return {
    waiting: hit.ctx.pool.waitingCount,
    total: hit.ctx.pool.totalCount,
    idle: hit.ctx.pool.idleCount,
    max: externalPoolMax,
  };
}

/** Drop (and close) a cached pool — call after URL change or agent delete. */
export function evictAgentDb(agentId: number): void {
  const hit = cache.get(agentId);
  if (hit) { hit.ctx.pool.end().catch(() => {}); cache.delete(agentId); }
}
