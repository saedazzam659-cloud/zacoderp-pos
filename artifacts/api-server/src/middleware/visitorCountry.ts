import type { Request, Response, NextFunction } from "express";

// ─── Visitor country detection ────────────────────────────────────────
// Resolves the ISO-3166-1 alpha-2 country code for the *unauthenticated*
// visitor on every request, in this strict precedence order:
//
//   1. ?country=XX query string  (explicit user override — wins over
//      everything; also written back into the visitor_country cookie so
//      the choice persists across navigation).
//   2. visitor_country cookie    (sticky last choice).
//   3. CF-IPCountry header       (set by Cloudflare's edge proxy when the
//      site is fronted by Cloudflare; trustworthy because the request
//      cannot bypass it).
//   4. Geo-IP lookup             (fallback for non-Cloudflare deployments
//      using the free ipwho.is service. Result is cached in-memory by IP
//      to avoid hitting the upstream on every request, and persisted to
//      the visitor_country cookie so subsequent requests short-circuit
//      through step 2).
//   5. "GLOBAL" sentinel         (catch-all fallback so downstream code
//      always sees a non-empty value).
//
// The resolved value is exposed on `req.visitorCountry`. We never mutate
// `req.authUser` here — that's session/auth state and unrelated to the
// visitor's geographic origin.
//
// We deliberately accept ANY two-letter alpha code into the cookie/query
// path: the consuming layer (countries.ts → getCountryByCode) will fall
// back gracefully on unknown codes, so we don't reject early. Only
// "GLOBAL" is allowed as a non-2-letter sentinel.

declare global {
  namespace Express {
    interface Request {
      visitorCountry?: string;
    }
  }
}

const VALID_OVERRIDE = /^([A-Z]{2}|GLOBAL)$/;
// Catalog of country codes the app actually has localized copy/policy
// for. Any other 2-letter code (e.g. "US", "FR") gets coerced to the
// GLOBAL sentinel so unsupported visitors see neutral fallback content
// instead of accidental Saudi-default copy. Keep this in lock-step
// with the SPA's countries.ts catalog.
const SUPPORTED_COUNTRIES = new Set<string>([
  "SA", "AE", "KW", "QA", "BH", "OM", "EG", "GLOBAL",
]);
const COOKIE_NAME    = "visitor_country";
// One year — country pickers are sticky and we don't want users to keep
// re-selecting on every visit. Browsers cap effective lifetime to ~13mo
// anyway when the secure-by-default rules kick in.
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

// ─── Geo-IP cache ─────────────────────────────────────────────────────
// In-memory LRU-ish cache for the IP→country resolution. The cookie
// already shields us from re-querying the upstream for repeat visitors,
// but a brand-new visitor still triggers one lookup; this cache absorbs
// concurrent requests from the same IP within a short window and
// survives short bursts (e.g. SSR + asset requests) without flooding
// the free Geo-IP service. Negative results (lookup failed or returned
// an unsupported country) are cached too so we don't keep retrying.
const GEO_CACHE_MAX        = 1000;
const GEO_CACHE_TTL_MS     = 24 * 60 * 60 * 1000; // 24h
const GEO_LOOKUP_TIMEOUT_MS = 1500;
type GeoCacheEntry = { code: string; expiresAt: number };
const geoCache = new Map<string, GeoCacheEntry>();

function geoCacheGet(ip: string): string | null {
  const hit = geoCache.get(ip);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    geoCache.delete(ip);
    return null;
  }
  return hit.code;
}
function geoCacheSet(ip: string, code: string) {
  // Naive size cap — drop the oldest insertion order entry. Map preserves
  // insertion order so the first key is the oldest.
  if (geoCache.size >= GEO_CACHE_MAX) {
    const firstKey = geoCache.keys().next().value;
    if (firstKey !== undefined) geoCache.delete(firstKey);
  }
  geoCache.set(ip, { code, expiresAt: Date.now() + GEO_CACHE_TTL_MS });
}

function isPrivateOrLoopback(ip: string): boolean {
  if (!ip) return true;
  // Strip IPv6-mapped IPv4 prefix
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (v4 === "127.0.0.1" || v4 === "::1" || v4 === "0.0.0.0") return true;
  // Common private IPv4 ranges
  if (/^10\./.test(v4)) return true;
  if (/^192\.168\./.test(v4)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v4)) return true;
  // IPv6 unique local + link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  if (/^fe80:/i.test(ip)) return true;
  return false;
}

function clientIp(req: Request): string {
  // Express's req.ip honours `app.set("trust proxy", 1)` which is set
  // in app.ts, so we get the real client IP from x-forwarded-for in
  // production. Fall back to the socket address as a last resort.
  return (req.ip || req.socket?.remoteAddress || "").toString();
}

async function lookupCountryByIp(ip: string): Promise<string | null> {
  if (isPrivateOrLoopback(ip)) return null;
  const cached = geoCacheGet(ip);
  // Normalize on read: the cache is shared with `resolveCountryForIp`,
  // which deliberately stores raw ISO codes (e.g. "US", "FR") for
  // reporting surfaces. The visitor middleware path, however, must
  // honor the SUPPORTED_COUNTRIES contract and coerce anything outside
  // it back to "GLOBAL". Without this normalization, a sessions-page
  // view would warm the cache with "US" and the next visitor request
  // would silently leak that unsupported code into req.visitorCountry.
  if (cached) {
    return SUPPORTED_COUNTRIES.has(cached) ? cached : "GLOBAL";
  }
  // api.country.is is free, HTTPS, no API key required, returns a
  // minimal `{ip, country}` payload so we don't waste bytes parsing
  // fields we don't need. We hard-cap the round-trip to a short
  // timeout so a slow upstream never blocks page loads. Any failure
  // (non-200, network error, parse error, timeout) degrades silently
  // to GLOBAL and is cached so we don't retry immediately.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEO_LOOKUP_TIMEOUT_MS);
  try {
    const r = await fetch(`https://api.country.is/${encodeURIComponent(ip)}`, {
      signal: ctrl.signal,
    });
    if (!r.ok) {
      geoCacheSet(ip, "GLOBAL");
      return null;
    }
    const j: any = await r.json();
    const raw = String(j?.country || "").trim().toUpperCase();
    const code = VALID_OVERRIDE.test(raw)
      ? (SUPPORTED_COUNTRIES.has(raw) ? raw : "GLOBAL")
      : "GLOBAL";
    geoCacheSet(ip, code);
    return code;
  } catch {
    // Timeout / network error / parse error — degrade to GLOBAL silently.
    geoCacheSet(ip, "GLOBAL");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Rich IP → location resolver (city/region/country) ────────────────
// Separate cache from the country-only one because the upstream and the
// payload shape differ. Used by SuperAdmin reporting surfaces (security
// sessions + login history) so they can show "Cairo, Egypt" instead of
// just "EG" — critical for spotting suspicious foreign logins at a glance.
// Uses ipwho.is (free, HTTPS, no key, ~5k req/day per IP cap). Falls back
// to null on any error/timeout; results are cached for 24h so a repeat
// IP is free. Private/loopback IPs return null immediately.
export type IpLocation = {
  country: string | null;   // ISO alpha-2
  countryName: string | null;
  region: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
};
const IP_LOC_CACHE_MAX = 1000;
// Split TTLs: positive results are stable for 24h, but negative results
// (timeout / upstream failure / private IP) get a much shorter TTL so a
// transient outage doesn't suppress location enrichment for the rest of
// the day. Without this split, a single flaky upstream response would
// poison the cache and reporting surfaces would show empty cells until
// the next process restart.
const IP_LOC_POS_TTL_MS = 24 * 60 * 60 * 1000;  // 24h for real hits
const IP_LOC_NEG_TTL_MS = 10 * 60 * 1000;       // 10min for misses
type IpLocCacheEntry = { value: IpLocation | null; expiresAt: number };
const ipLocCache = new Map<string, IpLocCacheEntry>();
function ipLocCacheGet(ip: string): IpLocation | null | undefined {
  const hit = ipLocCache.get(ip);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) { ipLocCache.delete(ip); return undefined; }
  return hit.value;
}
function ipLocCacheSet(ip: string, value: IpLocation | null) {
  if (ipLocCache.size >= IP_LOC_CACHE_MAX) {
    const firstKey = ipLocCache.keys().next().value;
    if (firstKey !== undefined) ipLocCache.delete(firstKey);
  }
  const ttl = value === null ? IP_LOC_NEG_TTL_MS : IP_LOC_POS_TTL_MS;
  ipLocCache.set(ip, { value, expiresAt: Date.now() + ttl });
}

// In-flight dedupe: when N concurrent callers ask for the same uncached
// IP (e.g. sessions + login-history loading together, or two admins on
// the page at once), only one upstream request is made and all callers
// await the same promise. Entries are removed on settle so a later miss
// re-fetches. Without this, concurrent cold-cache requests would
// duplicate outbound calls and burn the rate-limit on ipwho.is.
const ipLocInFlight = new Map<string, Promise<IpLocation | null>>();

// ─── Geo-IP provider chain ────────────────────────────────────────────
// We try multiple free providers in order. Different services have
// different reachability profiles from production hosts (some are
// blocked by certain egress firewalls, some have stricter rate limits
// per IP-of-caller). The chain returns on the first provider that
// gives us a usable result; if ALL fail we cache null with the short
// negative TTL so the next miss retries soon.
type GeoProvider = {
  name: string;
  url: (ip: string) => string;
  parse: (j: any) => IpLocation | null;
};
const GEO_PROVIDERS: GeoProvider[] = [
  {
    name: "ipwho.is",
    url: (ip) => `https://ipwho.is/${encodeURIComponent(ip)}`,
    parse: (j) => {
      if (!j || j.success === false) return null;
      const cc = typeof j.country_code === "string" ? j.country_code.toUpperCase() : "";
      return {
        country: /^[A-Z]{2}$/.test(cc) ? cc : null,
        countryName: typeof j.country === "string" ? j.country : null,
        region:      typeof j.region  === "string" ? j.region  : null,
        city:        typeof j.city    === "string" ? j.city    : null,
        lat: typeof j.latitude  === "number" ? j.latitude  : null,
        lng: typeof j.longitude === "number" ? j.longitude : null,
      };
    },
  },
  {
    // ip-api.com is free over HTTP (HTTPS requires a paid key). Outbound
    // HTTP is allowed from Replit deployments. ~45 req/min per caller IP.
    name: "ip-api.com",
    url: (ip) => `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,regionName,city,lat,lon`,
    parse: (j) => {
      if (!j || j.status !== "success") return null;
      const cc = typeof j.countryCode === "string" ? j.countryCode.toUpperCase() : "";
      return {
        country: /^[A-Z]{2}$/.test(cc) ? cc : null,
        countryName: typeof j.country === "string" ? j.country : null,
        region:      typeof j.regionName === "string" ? j.regionName : null,
        city:        typeof j.city === "string" ? j.city : null,
        lat: typeof j.lat === "number" ? j.lat : null,
        lng: typeof j.lon === "number" ? j.lon : null,
      };
    },
  },
  {
    name: "ipapi.co",
    url: (ip) => `https://ipapi.co/${encodeURIComponent(ip)}/json/`,
    parse: (j) => {
      if (!j || j.error) return null;
      const cc = typeof j.country_code === "string" ? j.country_code.toUpperCase() : "";
      return {
        country: /^[A-Z]{2}$/.test(cc) ? cc : null,
        countryName: typeof j.country_name === "string" ? j.country_name : null,
        region:      typeof j.region === "string" ? j.region : null,
        city:        typeof j.city === "string" ? j.city : null,
        lat: typeof j.latitude  === "number" ? j.latitude  : null,
        lng: typeof j.longitude === "number" ? j.longitude : null,
      };
    },
  },
];

async function tryProvider(p: GeoProvider, ip: string): Promise<IpLocation | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEO_LOOKUP_TIMEOUT_MS);
  try {
    const r = await fetch(p.url(ip), { signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return p.parse(j);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function ipLocFetch(v4: string): Promise<IpLocation | null> {
  for (const p of GEO_PROVIDERS) {
    const out = await tryProvider(p, v4);
    // Require at least a country code to consider it a real hit;
    // otherwise fall through to the next provider.
    if (out && (out.country || out.city)) {
      ipLocCacheSet(v4, out);
      if (out.country) geoCacheSet(v4, out.country);
      return out;
    }
  }
  ipLocCacheSet(v4, null);
  return null;
}

export async function resolveLocationForIp(ip: string): Promise<IpLocation | null> {
  if (!ip) return null;
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isPrivateOrLoopback(v4)) return null;
  const cached = ipLocCacheGet(v4);
  if (cached !== undefined) return cached;
  const pending = ipLocInFlight.get(v4);
  if (pending) return pending;
  const p = ipLocFetch(v4).finally(() => { ipLocInFlight.delete(v4); });
  ipLocInFlight.set(v4, p);
  return p;
}

// Public helper: resolve the raw ISO-3166-1 alpha-2 country code for an
// arbitrary IP address (e.g. from audit_log or session-tracking rows).
// Unlike the visitor middleware below, this function does NOT coerce
// unsupported codes to "GLOBAL" — callers like /admin/security/sessions
// want the actual reporting country (US/FR/IN/...) to display next to
// the IP, not the localized-content fallback. Returns null for private/
// loopback IPs and on any upstream failure (cached so we don't retry).
export async function resolveCountryForIp(ip: string): Promise<string | null> {
  if (!ip) return null;
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isPrivateOrLoopback(v4)) return null;
  const cached = geoCacheGet(v4);
  // The cache stores either a real 2-letter code or the "GLOBAL" sentinel
  // written by the visitor middleware path. Treat GLOBAL as "unknown"
  // here so reporting surfaces show "—" instead of an ISO-invalid badge.
  if (cached) return cached === "GLOBAL" ? null : cached;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEO_LOOKUP_TIMEOUT_MS);
  try {
    const r = await fetch(`https://api.country.is/${encodeURIComponent(v4)}`, { signal: ctrl.signal });
    if (!r.ok) { geoCacheSet(v4, "GLOBAL"); return null; }
    const j: any = await r.json();
    const raw = String(j?.country || "").trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(raw)) {
      geoCacheSet(v4, raw);
      return raw;
    }
    geoCacheSet(v4, "GLOBAL");
    return null;
  } catch {
    geoCacheSet(v4, "GLOBAL");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalize(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase();
  if (!v) return null;
  if (!VALID_OVERRIDE.test(v)) return null;
  // Coerce unsupported codes (e.g. CF-IPCountry returning "US" or "FR")
  // to the GLOBAL fallback so downstream filters and UI surfaces never
  // see a country we don't have localized copy for.
  return SUPPORTED_COUNTRIES.has(v) ? v : "GLOBAL";
}

function persistCookie(res: Response, value: string) {
  res.cookie(COOKIE_NAME, value, {
    maxAge:   COOKIE_MAX_AGE_MS,
    httpOnly: false,    // SPA may read it client-side for UI selectors
    sameSite: "lax",
    path:     "/",
  });
}

export async function visitorCountryMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    // 1) explicit ?country override
    const fromQuery = normalize((req.query as any)?.country);
    if (fromQuery) {
      req.visitorCountry = fromQuery;
      // Persist the override so subsequent requests don't need it
      persistCookie(res, fromQuery);
      next();
      return;
    }

    // 2) sticky cookie (parsed by cookie-parser middleware mounted earlier)
    const fromCookie = normalize((req as any).cookies?.[COOKIE_NAME]);
    if (fromCookie) {
      req.visitorCountry = fromCookie;
      next();
      return;
    }

    // 3) Cloudflare-supplied geolocation header
    const headerVal = req.headers["cf-ipcountry"];
    const fromHeader = normalize(Array.isArray(headerVal) ? headerVal[0] : headerVal);
    if (fromHeader) {
      req.visitorCountry = fromHeader;
      // Persist the geo-IP detection into the visitor_country cookie so
      // the SPA can read it client-side on subsequent renders without
      // having to round-trip through the API every time. Without this,
      // first-time visitors from outside SA would see Saudi-default copy
      // until they manually picked a country from the selector.
      persistCookie(res, fromHeader);
      next();
      return;
    }

    // 4) Geo-IP lookup (non-Cloudflare deployments). Async — guarded by
    // a short timeout and an in-memory cache so we never block more
    // than ~1.5s on upstream failure, and repeat visitors short-circuit
    // through the cookie set below on their next request.
    const ip = clientIp(req);
    const fromGeo = await lookupCountryByIp(ip);
    if (fromGeo && fromGeo !== "GLOBAL") {
      req.visitorCountry = fromGeo;
      persistCookie(res, fromGeo);
      next();
      return;
    }

    // 5) catch-all
    req.visitorCountry = "GLOBAL";
    next();
  } catch {
    // Any unexpected error must not break the request pipeline — visitor
    // country is a pure UI/personalization signal, never auth-critical.
    req.visitorCountry = "GLOBAL";
    next();
  }
}

// Tiny endpoint handler the SPA can poll on mount to learn the
// server-resolved country when the cookie is missing. Returns the
// already-populated `req.visitorCountry` (set by the middleware above)
// alongside whether the resolution came from a real signal vs the
// "GLOBAL" fallback so the SPA can decide whether to trust it.
export function visitorCountryHandler(req: Request, res: Response) {
  const country = req.visitorCountry || "GLOBAL";
  res.json({
    country,
    resolved: country !== "GLOBAL",
  });
}
