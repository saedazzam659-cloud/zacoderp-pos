// Company profile + number-format settings (دليل الإعدادات).
//
// Mirrors the web app's GeneralSettings: a company logo (base64 data URL),
// company identity (name / VAT / CR) used on the professional journal-entry
// print letterhead, and a per-install decimal-places preference applied to
// every money formatter.
//
// Storage follows the SAME pattern as taxSettings.ts / currency.ts:
// localStorage is the synchronous source of truth for the UI thread; in Tauri
// builds we fire-and-forget mirror each key to SQLite (app_settings) via
// standalone_set_setting so the choice survives a localStorage wipe. Writes
// dispatch a shared event so hooks + the cached decimals refresh in lockstep.

import { useEffect, useState } from "react";

const EVT = "pos-desktop-company-changed";

const LS_LOGO = "pos_desktop_company_logo";   // base64 data URL or https URL
const LS_NAME = "pos_desktop_company_name";
const LS_VAT = "pos_desktop_company_vat";
const LS_CR = "pos_desktop_company_cr";
const LS_PHONE = "pos_desktop_company_phone";
const LS_DECIMALS = "pos_desktop_decimal_places";

export const DECIMALS_MIN = 0;
export const DECIMALS_MAX = 6;
export const DECIMALS_DEFAULT = 2;

// Soft cap on the stored logo size (~1MB of base64) to avoid bloating
// localStorage / SQLite. Enforced by the upload UI, not here.
export const LOGO_MAX_BASE64_CHARS = 1_400_000;

export type CompanyProfile = {
  logo: string;   // "" when unset
  name: string;
  vat: string;
  cr: string;
  phone: string;
  decimals: number;
};

// ─── Raw readers ─────────────────────────────────────────────────────
function ls(key: string): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(key) ?? "";
}

function readDecimals(): number {
  if (typeof window === "undefined") return DECIMALS_DEFAULT;
  const raw = localStorage.getItem(LS_DECIMALS);
  if (raw == null || raw.trim() === "") return DECIMALS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DECIMALS_DEFAULT;
  return Math.min(DECIMALS_MAX, Math.max(DECIMALS_MIN, Math.floor(n)));
}

// ─── Cached decimals (fast, sync, safe outside React) ────────────────
// fmt() in _adminUi.tsx calls getDecimals() on every format, so we keep a
// module-level cache refreshed on the change event + cross-window storage.
let _decimals = readDecimals();
if (typeof window !== "undefined") {
  const refresh = () => { _decimals = readDecimals(); };
  window.addEventListener(EVT, refresh);
  window.addEventListener("storage", refresh);
}

/** Configured decimal places (0–6, default 2). Synchronous + cached. */
export function getDecimals(): number {
  return _decimals;
}

/** Only allow data:image/* or https:// logo sources (anti-XSS, mirrors web safeLogoSrc). */
export function safeLogoSrc(s: string | null | undefined): string {
  if (!s) return "";
  const t = s.trim();
  if (t.startsWith("data:image/") || t.startsWith("https://")) return t;
  return "";
}

// ─── Profile getters ─────────────────────────────────────────────────
export function getCompanyProfile(): CompanyProfile {
  return {
    logo: safeLogoSrc(ls(LS_LOGO)),
    name: ls(LS_NAME),
    vat: ls(LS_VAT),
    cr: ls(LS_CR),
    phone: ls(LS_PHONE),
    decimals: readDecimals(),
  };
}

// ─── Setters (persist + notify + mirror) ─────────────────────────────
function writeKey(key: string, value: string): void {
  if (typeof window === "undefined") return;
  if (value === "") localStorage.removeItem(key);
  else localStorage.setItem(key, value);
  void mirrorToTauri(key, value);
}

/** Persist the whole profile in one shot, then notify once. */
export function setCompanyProfile(p: CompanyProfile): void {
  if (typeof window === "undefined") return;
  writeKey(LS_LOGO, safeLogoSrc(p.logo));
  writeKey(LS_NAME, (p.name ?? "").trim());
  writeKey(LS_VAT, (p.vat ?? "").trim());
  writeKey(LS_CR, (p.cr ?? "").trim());
  writeKey(LS_PHONE, (p.phone ?? "").trim());
  const dp = Math.min(DECIMALS_MAX, Math.max(DECIMALS_MIN, Math.floor(Number(p.decimals) || 0)));
  writeKey(LS_DECIMALS, String(dp));
  _decimals = dp;
  window.dispatchEvent(new Event(EVT));
}

// ─── React hooks ─────────────────────────────────────────────────────
/** Live company profile — re-renders when any field changes. */
export function useCompanyProfile(): CompanyProfile {
  const [p, setP] = useState<CompanyProfile>(() => getCompanyProfile());
  useEffect(() => {
    const refresh = () => setP(getCompanyProfile());
    window.addEventListener(EVT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(EVT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return p;
}

/** Live decimal places — re-renders when changed. */
export function useDecimals(): number {
  const [dp, setDp] = useState<number>(() => getDecimals());
  useEffect(() => {
    const refresh = () => setDp(getDecimals());
    window.addEventListener(EVT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(EVT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return dp;
}

// ─── Tauri SQLite mirror (fire-and-forget) ───────────────────────────
async function mirrorToTauri(key: string, value: string): Promise<void> {
  if (typeof window === "undefined") return;
  const hasTauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
  if (!hasTauri) return;
  try {
    const mod = await import(/* @vite-ignore */ "@tauri-apps/api/core");
    await mod.invoke("standalone_set_setting", { key, value });
  } catch {
    // Non-fatal — localStorage remains the source of truth.
  }
}
