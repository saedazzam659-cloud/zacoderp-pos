// Tax settings — VAT rate + price-includes-tax toggle.
//
// Two pieces of state live here:
//   - rate (number, percent). Default is derived from the country chosen
//     during first-run (or activation). E.g. SA → 15, EG → 14, AE → 5.
//   - mode ("inclusive" | "exclusive").
//       * inclusive (default): catalog `salePrice` already contains VAT;
//         subtotal = grandTotal / (1+rate); vat = grandTotal - subtotal.
//         (This is the existing POS Desktop behaviour and matches the
//         cloud convention where items.sale_price is gross.)
//       * exclusive: catalog `salePrice` is net; subtotal = sum(price*qty);
//         vat = subtotal * rate; grandTotal = subtotal + vat.
//
// Storage: localStorage is the source of truth for the UI thread (sync).
// In Tauri builds we also mirror to SQLite via standalone_set_setting so
// settings survive a localStorage wipe. The mirror is fire-and-forget —
// the UI never blocks on it.
//
// Other components subscribe to changes via the `pos-desktop-tax-changed`
// custom event (dispatched on every save) and via the cross-tab `storage`
// event. The `useTaxSettings` hook re-reads on both.

import { useEffect, useState, useCallback } from "react";

const LS_RATE = "pos_desktop_vat_rate";       // string number ("15", "14", "0")
const LS_MODE = "pos_desktop_tax_mode";       // "inclusive" | "exclusive"
const LS_COUNTRY = "pos_desktop_country";     // ISO-2, e.g. "SA"
const EVT = "pos-desktop-tax-changed";

export type TaxMode = "inclusive" | "exclusive";

/** Default VAT rate (percent) per ISO-2 country code. */
export const COUNTRY_DEFAULT_VAT: Record<string, number> = {
  SA: 15, EG: 14, AE: 5, KW: 0, QA: 0, BH: 10, OM: 5,
  JO: 16, LB: 11, IQ: 0, YE: 0, PS: 16, SY: 11,
  DZ: 19, TN: 19, MA: 20, LY: 0, SD: 17, MR: 16,
  // Fallback for any unmapped country.
  INTL: 15,
};

export function defaultRateForCountry(country: string | null | undefined): number {
  const code = (country || "SA").toUpperCase();
  return COUNTRY_DEFAULT_VAT[code] ?? COUNTRY_DEFAULT_VAT.INTL;
}

function readRate(): number {
  if (typeof window === "undefined") return 15;
  const stored = localStorage.getItem(LS_RATE);
  if (stored !== null && stored.trim() !== "") {
    const n = Number(stored);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  }
  return defaultRateForCountry(localStorage.getItem(LS_COUNTRY));
}

function readMode(): TaxMode {
  if (typeof window === "undefined") return "inclusive";
  return localStorage.getItem(LS_MODE) === "exclusive" ? "exclusive" : "inclusive";
}

function notify() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(EVT));
}

/** Persist the VAT rate (percent, 0-100). Mirrors to SQLite if Tauri. */
export function setTaxRate(percent: number): void {
  const clamped = Math.max(0, Math.min(100, percent));
  localStorage.setItem(LS_RATE, String(clamped));
  notify();
  void mirrorToTauri(LS_RATE, String(clamped));
}

/** Persist the tax mode. Mirrors to SQLite if Tauri. */
export function setTaxMode(mode: TaxMode): void {
  localStorage.setItem(LS_MODE, mode);
  notify();
  void mirrorToTauri(LS_MODE, mode);
}

/** Synchronous read — safe to use outside React (e.g. invoice payload). */
export function getTaxRate(): number { return readRate(); }
export function getTaxMode(): TaxMode { return readMode(); }

/**
 * Compute totals from a cart whose `salePrice * qty` is the "raw" amount.
 *
 *   inclusive: raw is gross   → subtotal = raw / (1+r); vat = raw - subtotal.
 *   exclusive: raw is net     → subtotal = raw;        vat = raw * r.
 *
 * Always returns positive numbers; the caller is free to round.
 */
export function computeTotals(
  rawLineTotal: number,
  ratePercent: number,
  mode: TaxMode,
): { subtotal: number; vat: number; grandTotal: number } {
  const r = ratePercent / 100;
  if (mode === "exclusive") {
    const subtotal = rawLineTotal;
    const vat = subtotal * r;
    return { subtotal, vat, grandTotal: subtotal + vat };
  }
  const subtotal = r > 0 ? rawLineTotal / (1 + r) : rawLineTotal;
  const vat = rawLineTotal - subtotal;
  return { subtotal, vat, grandTotal: rawLineTotal };
}

/** React hook — live values, updates on any tax setting change. */
export function useTaxSettings(): {
  rate: number;
  mode: TaxMode;
  country: string;
  setRate: (n: number) => void;
  setMode: (m: TaxMode) => void;
  resetToCountryDefault: () => void;
} {
  const [rate, _setRate] = useState<number>(() => readRate());
  const [mode, _setMode] = useState<TaxMode>(() => readMode());
  const [country, setCountry] = useState<string>(
    () => (typeof window !== "undefined" && localStorage.getItem(LS_COUNTRY)) || "SA",
  );

  useEffect(() => {
    const refresh = () => {
      _setRate(readRate());
      _setMode(readMode());
      setCountry(localStorage.getItem(LS_COUNTRY) || "SA");
    };
    window.addEventListener(EVT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(EVT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const setRate = useCallback((n: number) => setTaxRate(n), []);
  const setMode = useCallback((m: TaxMode) => setTaxMode(m), []);
  const resetToCountryDefault = useCallback(() => {
    localStorage.removeItem(LS_RATE);
    notify();
    void mirrorToTauri(LS_RATE, "");
  }, []);

  return { rate, mode, country, setRate, setMode, resetToCountryDefault };
}

// ─── Tauri SQLite mirror (fire-and-forget) ─────────────────────────
async function mirrorToTauri(key: string, value: string): Promise<void> {
  if (typeof window === "undefined") return;
  const hasTauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
  if (!hasTauri) return;
  try {
    const mod = await import(/* @vite-ignore */ "@tauri-apps/api/core");
    await mod.invoke("standalone_set_setting", { key, value });
  } catch {
    // Non-fatal — localStorage is still the source of truth.
  }
}
