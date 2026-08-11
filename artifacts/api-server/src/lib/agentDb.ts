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

type CacheEntry = { key: string; ctx: ExternalDbContext };
const cache = new Map<number, CacheEntry>();

export function getAgentDbContext(agentId: number, dbUrlEnc: string): ExternalDbContext {
  const hit = cache.get(agentId);
  if (hit && hit.key === dbUrlEnc) return hit.ctx;
  if (hit) hit.ctx.pool.end().catch(() => {});
  const url = decryptSecret(dbUrlEnc);
  if (!url) throw new Error("agent db url missing");
  const ctx = createExternalDb(url);
  cache.set(agentId, { key: dbUrlEnc, ctx });
  return ctx;
}

/** Drop (and close) a cached pool — call after URL change or agent delete. */
export function evictAgentDb(agentId: number): void {
  const hit = cache.get(agentId);
  if (hit) { hit.ctx.pool.end().catch(() => {}); cache.delete(agentId); }
}
