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
//   4. "GLOBAL" sentinel         (catch-all fallback so downstream code
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

export function visitorCountryMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // 1) explicit ?country override
  const fromQuery = normalize((req.query as any)?.country);
  if (fromQuery) {
    req.visitorCountry = fromQuery;
    // Persist the override so subsequent requests don't need it
    res.cookie(COOKIE_NAME, fromQuery, {
      maxAge:   COOKIE_MAX_AGE_MS,
      httpOnly: false,    // SPA may read it client-side for UI selectors
      sameSite: "lax",
      path:     "/",
    });
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
    res.cookie(COOKIE_NAME, fromHeader, {
      maxAge:   COOKIE_MAX_AGE_MS,
      httpOnly: false,
      sameSite: "lax",
      path:     "/",
    });
    next();
    return;
  }

  // 4) catch-all
  req.visitorCountry = "GLOBAL";
  next();
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
