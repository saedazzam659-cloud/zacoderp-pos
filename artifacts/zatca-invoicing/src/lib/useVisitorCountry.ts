import { useEffect, useState, useCallback } from "react";

// ─── useVisitorCountry ───────────────────────────────────────────────
// Single source of truth for the unauthenticated visitor's country on
// the public Home / Login / Pricing pages. Reads the precedence chain:
//
//   1. `?country=XX` query string on the current URL
//   2. `visitor_country` cookie (set when the user picks from the
//      country selector OR when the API echoed the chosen override).
//   3. `DEFAULT_COUNTRY_CODE` from countries.ts (server-side detection
//      via CF-IPCountry runs on every API call but the SPA cannot read
//      that header itself; the cookie picks up the server's choice on
//      the next request after a /api/visitor-country call).
//
// The setter writes the cookie AND the URL hash so the choice survives
// hard refreshes without a server roundtrip. It also notifies any other
// hook instance via a lightweight `storage`-style custom event.
//
// Returns: [country, setCountry] — country is always a non-empty string.
import { DEFAULT_COUNTRY_CODE } from "./countries";

const COOKIE_NAME = "visitor_country";
const EVENT_NAME  = "visitor-country-change";
const VALID = /^([A-Z]{2}|GLOBAL)$/;

function readCookie(): string | null {
  if (typeof document === "undefined") return null;
  const raw = document.cookie.split("; ").find(r => r.startsWith(`${COOKIE_NAME}=`));
  if (!raw) return null;
  const v = decodeURIComponent(raw.split("=")[1] ?? "").toUpperCase();
  return VALID.test(v) ? v : null;
}

function readQueryParam(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(window.location.href);
    const v = (url.searchParams.get("country") || "").toUpperCase();
    return VALID.test(v) ? v : null;
  } catch {
    return null;
  }
}

function readInitial(): { code: string; explicit: boolean } {
  const q = readQueryParam();
  if (q) return { code: q, explicit: true };
  const c = readCookie();
  if (c) return { code: c, explicit: true };
  // No explicit signal yet — surface the default but let callers know
  // it's a fallback so they can defer to server-side CF-IPCountry.
  return { code: DEFAULT_COUNTRY_CODE, explicit: false };
}

// Returns [country, setCountry, explicit]. `explicit` is true iff the
// country came from a real visitor signal (?country query OR
// visitor_country cookie). Callers that want to honour CF-IPCountry on
// the very first request (e.g. Home's articles fetch) should skip the
// `?country=` param when `explicit` is false.
export function useVisitorCountry(): [string, (next: string) => void, boolean] {
  const initial = (typeof window !== "undefined") ? readInitial() : { code: DEFAULT_COUNTRY_CODE, explicit: false };
  const [country, setCountryState] = useState<string>(initial.code);
  const [explicit, setExplicit]    = useState<boolean>(initial.explicit);

  // Keep multiple hook instances on the same page in sync when one of
  // them flips the country (e.g. Login + Home both rendered in a layout).
  useEffect(() => {
    function onChange(e: Event) {
      const next = (e as CustomEvent<string>).detail;
      if (typeof next === "string" && VALID.test(next) && next !== country) {
        setCountryState(next);
        setExplicit(true);
      }
    }
    window.addEventListener(EVENT_NAME, onChange);
    return () => window.removeEventListener(EVENT_NAME, onChange);
  }, [country]);

  const setCountry = useCallback((nextRaw: string) => {
    const next = String(nextRaw || "").toUpperCase();
    if (!VALID.test(next)) return;
    // Persist for one year (matches the API cookie lifetime); SameSite
    // lax is fine since the cookie is non-sensitive UI preference.
    if (typeof document !== "undefined") {
      const oneYearSec = 365 * 24 * 60 * 60;
      document.cookie = `${COOKIE_NAME}=${encodeURIComponent(next)}; path=/; max-age=${oneYearSec}; samesite=lax`;
    }
    setCountryState(next);
    setExplicit(true);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent<string>(EVENT_NAME, { detail: next }));
    }
  }, []);

  return [country, setCountry, explicit];
}
