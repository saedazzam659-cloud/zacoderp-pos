import { logger } from "./logger.js";
import type { LocalAgentRuntimeState } from "./localAgentSuperadmin.js";
import { isIP } from "node:net";
import { isPublicControllerAddress } from "./controllerHandoff.js";

export type PublicBrandingAgent = {
  status: string;
  brandName: string | null;
  brandLogoUrl: string | null;
  brandColor: string | null;
  contactPhone: string | null;
};

/** Match only an agent's normalized primary or explicitly registered domains. */
export function agentOwnsHost(
  host: string,
  agent: { domain: string; extraDomains: unknown },
): boolean {
  const extras = Array.isArray(agent.extraDomains)
    ? agent.extraDomains.filter((value): value is string => typeof value === "string")
    : [];
  return agent.domain === host || extras.includes(host);
}

/** Explicit allow-list for the unauthenticated branding response. */
export function resolvedAgentBranding(agent: PublicBrandingAgent) {
  return {
    isAgentDomain: true,
    localSuperadminEnabled: false,
    localSuperadminScreens: [] as string[],
    suspended: agent.status !== "active",
    brandName: agent.brandName,
    brandLogoUrl: agent.brandLogoUrl,
    brandColor: agent.brandColor,
    contactPhone: agent.contactPhone,
  };
}

type BrandFields = Pick<PublicBrandingAgent, "brandName" | "brandLogoUrl" | "brandColor" | "contactPhone">;
const brandCache = new Map<string, { fields: BrandFields | null; expires: number }>();
const brandPending = new Map<string, Promise<BrandFields | null>>();
const BRAND_TTL_MS = 60_000;
let invalidSourceLoggedUntil = 0;
// Uploaded logos are stored as data:image/...;base64, plus up to 800,000 base64 characters.
// Leave a small JSON allowance while bounding the download before parsing it.
const MAX_BRANDING_BYTES = 810_000;

/** The installer-owned config, never a request header or query parameter, selects the controller. */
export function trustedBrandingSource(state: LocalAgentRuntimeState): { origin: string; domain: string } | null {
  if (!state.isLocalAgent || !state.config) return null;
  const config = state.config;
  const domain = config.domain?.trim().toLowerCase();
  if (!domain || domain.length > 253 || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain)) return null;
  const active = config.controllerOrigins?.find(c => c.platformId === config.activeControllerId)?.origin;
  const raw = active || config.centralOrigin;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
        !/^[a-z0-9.-]+$/i.test(url.hostname) ||
        (isIP(url.hostname) !== 0 && !isPublicControllerAddress(url.hostname))) return null;
    return { origin: url.origin, domain };
  } catch {
    return null;
  }
}

function brandField(value: unknown, max: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > max) throw new Error("invalid_branding_field");
  return value;
}

async function boundedBrandingResponse(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BRANDING_BYTES) throw new Error("response_too_large");
  if (!response.body) throw new Error("empty_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BRANDING_BYTES) throw new Error("response_too_large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return new TextDecoder().decode(Buffer.concat(chunks, bytes));
}

/** Remote response is treated only as public display data; authorization remains local. */
export async function localAgentPublicBranding(
  state: LocalAgentRuntimeState,
  fetchBrand: typeof fetch = fetch,
): Promise<ReturnType<typeof resolvedAgentBranding> | null> {
  if (!state.isLocalAgent) return null;
  const source = trustedBrandingSource(state);
  if (!source) {
    if (Date.now() >= invalidSourceLoggedUntil) {
      invalidSourceLoggedUntil = Date.now() + BRAND_TTL_MS;
      logger.warn("Local agent branding: missing or invalid trusted controller origin/domain");
    }
    return null;
  }
  const key = `${source.origin}|${source.domain}`;
  const cached = brandCache.get(key);
  const fields = cached && cached.expires > Date.now()
    ? cached.fields
    : await (async () => {
      const pending = brandPending.get(key);
      if (pending) return pending;
      const request = fetchLocalBranding(source, key, cached?.fields ?? null, fetchBrand);
      brandPending.set(key, request);
      try { return await request; }
      finally { brandPending.delete(key); }
    })();
  return fields ? { isAgentDomain: true, suspended: false, ...fields,
    localSuperadminEnabled: state.localSuperadminEnabled, localSuperadminScreens: state.localSuperadminScreens } : null;
}

async function fetchLocalBranding(
  source: { origin: string; domain: string }, key: string,
  staleFields: BrandFields | null, fetchBrand: typeof fetch,
): Promise<BrandFields | null> {
  try {
    const url = new URL("/api/branding", source.origin);
    url.searchParams.set("host", source.domain);
    const response = await fetchBrand(url.toString(), {
      signal: AbortSignal.timeout(3000), redirect: "manual",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    if (!(response.headers.get("content-type") ?? "").includes("application/json")) throw new Error("invalid_content_type");
    const text = await boundedBrandingResponse(response);
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || (body as any).isAgentDomain !== true) throw new Error("agent_not_found");
    const remote = body as Record<string, unknown>;
    const fields: BrandFields = {
      brandName: brandField(remote.brandName, 240),
      brandLogoUrl: brandField(remote.brandLogoUrl, 800_030),
      brandColor: brandField(remote.brandColor, 80),
      contactPhone: brandField(remote.contactPhone, 240),
    };
    brandCache.set(key, { fields, expires: Date.now() + BRAND_TTL_MS });
    return fields;
  } catch (error) {
    // Never log URLs or response bodies: configured origins can include sensitive deployment details.
    const reason = error instanceof Error && /^(http_[0-9]{3}|invalid_content_type|response_too_large|agent_not_found|invalid_branding_field)$/.test(error.message)
      ? error.message : "network_or_parse_error";
    logger.warn({ reason },
      "Local agent branding fetch failed; using last known display data");
    brandCache.set(key, { fields: staleFields, expires: Date.now() + BRAND_TTL_MS });
    return staleFields;
  }
}