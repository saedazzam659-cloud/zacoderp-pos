// ─────────────────────────────────────────────────────────────────────────
// Multi-Domain Management — host-based company resolution (FALLBACK only).
//
// When a request arrives on a known + ACTIVE mapped company domain, this
// middleware sets `req.domainCompanyId` to that company. resolveCompanyId
// (auth.ts) consumes it as the LOWEST-priority fallback for superadmins only
// — explicit ?companyId= and x-acting-company-id always win, and tenant users
// are always scoped to their own companyId regardless. The main domain (and
// any unmapped host) resolves to nothing → current multi-company behavior is
// completely preserved.
//
// Best-effort: never throws, never blocks the request. A small in-memory TTL
// cache keeps this off the hot path (one short query per host per minute).
// ─────────────────────────────────────────────────────────────────────────
import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { companyDomainsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const TTL_MS = 60_000;
// host → { companyId|null, expires }. null = known miss (cached too).
const cache = new Map<string, { companyId: number | null; expires: number }>();

/** Normalise a Host header to a bare lowercase hostname (no scheme/port). */
export function normalizeHost(raw: string | undefined): string | null {
  if (!raw) return null;
  let h = raw.trim().toLowerCase();
  if (!h) return null;
  // Strip an accidental scheme.
  h = h.replace(/^https?:\/\//, "");
  // Strip path / query if any leaked in.
  h = h.split("/")[0];
  // Strip port (handle bare IPv6 in brackets too).
  if (h.startsWith("[")) {
    h = h.slice(1).split("]")[0];
  } else {
    h = h.split(":")[0];
  }
  return h || null;
}

async function lookupCompanyForHost(host: string): Promise<number | null> {
  const now = Date.now();
  const hit = cache.get(host);
  if (hit && hit.expires > now) return hit.companyId;
  let companyId: number | null = null;
  try {
    const [row] = await db
      .select({ companyId: companyDomainsTable.companyId })
      .from(companyDomainsTable)
      .where(and(eq(companyDomainsTable.domain, host), eq(companyDomainsTable.status, "active")))
      .limit(1);
    companyId = row?.companyId ?? null;
  } catch {
    // Table may not exist yet on first boot, or transient DB error — treat as
    // a miss so the main multi-company behavior is preserved. Don't cache
    // errors long; use the same TTL so it self-heals once the table exists.
    companyId = null;
  }
  cache.set(host, { companyId, expires: now + TTL_MS });
  return companyId;
}

/** Invalidate the resolver cache (call after any domain create/update/delete). */
export function clearDomainCache(): void {
  cache.clear();
}

export async function resolveDomainCompany(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const fwd = req.headers["x-forwarded-host"];
    const rawHost = (Array.isArray(fwd) ? fwd[0] : fwd) || req.headers.host;
    const host = normalizeHost(rawHost);
    if (host) {
      const companyId = await lookupCompanyForHost(host);
      if (companyId != null) req.domainCompanyId = companyId;
    }
  } catch {
    // Never break the request over domain resolution.
  }
  next();
}
