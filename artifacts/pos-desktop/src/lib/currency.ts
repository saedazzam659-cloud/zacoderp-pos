// Country → POS currency (Task: country selection at first-run).
//
// The desktop already stores the operator's country as an ISO-2 code in
// `localStorage["pos_desktop_country"]` (written today by cloud Activation
// and read by taxSettings to derive the default VAT rate, and by the update
// channel). We reuse that SAME key as the single source of truth and add a
// currency layer on top of it: each country maps to a display currency code
// + Arabic symbol that the POS shows next to every price.
//
// IMPORTANT — display only. The accounting base-currency code stored inside
// SQLite (Task #209 currencies table) is NOT changed here; changing it would
// require Rust changes which can't compile in Replit. This module only swaps
// the *symbol* shown in the POS / admin screens so an Egyptian install shows
// "ج.م" instead of the hardcoded "ر.س".
//
// Storage mirrors the taxSettings pattern: localStorage is the synchronous
// source of truth for the UI thread; in Tauri builds we also fire-and-forget
// mirror to SQLite via standalone_set_setting so the choice survives a
// localStorage wipe. Writing the country dispatches the SAME
// "pos-desktop-tax-changed" event taxSettings listens on, so the VAT default
// recomputes in lockstep when the country changes.

import { useEffect, useState } from "react";

const LS_COUNTRY = "pos_desktop_country"; // ISO-2, shared with taxSettings.ts
const EVT = "pos-desktop-tax-changed";    // shared event — country drives both VAT + currency

export type CountryInfo = {
  iso: string;            // ISO-3166-1 alpha-2
  nameAr: string;
  flag: string;           // emoji
  currencyCode: string;   // ISO-4217
  currencySymbol: string; // Arabic display symbol
  decimals: number;       // minor-unit digits (informational; POS still formats to 2)
};

// The 22 Arab League states. Symbols use the common Arabic abbreviations.
export const ARAB_COUNTRIES: CountryInfo[] = [
  { iso: "SA", nameAr: "السعودية", flag: "🇸🇦", currencyCode: "SAR", currencySymbol: "ر.س", decimals: 2 },
  { iso: "EG", nameAr: "مصر", flag: "🇪🇬", currencyCode: "EGP", currencySymbol: "ج.م", decimals: 2 },
  { iso: "AE", nameAr: "الإمارات", flag: "🇦🇪", currencyCode: "AED", currencySymbol: "د.إ", decimals: 2 },
  { iso: "KW", nameAr: "الكويت", flag: "🇰🇼", currencyCode: "KWD", currencySymbol: "د.ك", decimals: 3 },
  { iso: "QA", nameAr: "قطر", flag: "🇶🇦", currencyCode: "QAR", currencySymbol: "ر.ق", decimals: 2 },
  { iso: "BH", nameAr: "البحرين", flag: "🇧🇭", currencyCode: "BHD", currencySymbol: "د.ب", decimals: 3 },
  { iso: "OM", nameAr: "عُمان", flag: "🇴🇲", currencyCode: "OMR", currencySymbol: "ر.ع", decimals: 3 },
  { iso: "JO", nameAr: "الأردن", flag: "🇯🇴", currencyCode: "JOD", currencySymbol: "د.أ", decimals: 3 },
  { iso: "LB", nameAr: "لبنان", flag: "🇱🇧", currencyCode: "LBP", currencySymbol: "ل.ل", decimals: 2 },
  { iso: "IQ", nameAr: "العراق", flag: "🇮🇶", currencyCode: "IQD", currencySymbol: "د.ع", decimals: 2 },
  { iso: "YE", nameAr: "اليمن", flag: "🇾🇪", currencyCode: "YER", currencySymbol: "ر.ي", decimals: 2 },
  { iso: "PS", nameAr: "فلسطين", flag: "🇵🇸", currencyCode: "ILS", currencySymbol: "₪", decimals: 2 },
  { iso: "SY", nameAr: "سوريا", flag: "🇸🇾", currencyCode: "SYP", currencySymbol: "ل.س", decimals: 2 },
  { iso: "DZ", nameAr: "الجزائر", flag: "🇩🇿", currencyCode: "DZD", currencySymbol: "د.ج", decimals: 2 },
  { iso: "TN", nameAr: "تونس", flag: "🇹🇳", currencyCode: "TND", currencySymbol: "د.ت", decimals: 3 },
  { iso: "MA", nameAr: "المغرب", flag: "🇲🇦", currencyCode: "MAD", currencySymbol: "د.م", decimals: 2 },
  { iso: "LY", nameAr: "ليبيا", flag: "🇱🇾", currencyCode: "LYD", currencySymbol: "د.ل", decimals: 3 },
  { iso: "SD", nameAr: "السودان", flag: "🇸🇩", currencyCode: "SDG", currencySymbol: "ج.س", decimals: 2 },
  { iso: "MR", nameAr: "موريتانيا", flag: "🇲🇷", currencyCode: "MRU", currencySymbol: "أوقية", decimals: 2 },
  { iso: "SO", nameAr: "الصومال", flag: "🇸🇴", currencyCode: "SOS", currencySymbol: "ش.ص", decimals: 2 },
  { iso: "DJ", nameAr: "جيبوتي", flag: "🇩🇯", currencyCode: "DJF", currencySymbol: "ف.ج", decimals: 2 },
  { iso: "KM", nameAr: "جزر القمر", flag: "🇰🇲", currencyCode: "KMF", currencySymbol: "ف.ق", decimals: 2 },
];

const BY_ISO: Record<string, CountryInfo> =
  Object.fromEntries(ARAB_COUNTRIES.map((c) => [c.iso, c]));

// ─── Currency catalogue (for the invoice currency picker) ─────────────
// A selectable list of currencies used on the document forms. Includes the
// Arab-state currencies (derived from ARAB_COUNTRIES) plus the major foreign
// currencies a Saudi/Egyptian business commonly invoices in. Display only —
// the accounting base currency in SQLite never changes; choosing a non-base
// currency on a document just converts the entered prices to base via the
// exchange rate before the payload is saved.
export type CurrencyInfo = { code: string; nameAr: string; symbol: string };

const EXTRA_CURRENCIES: CurrencyInfo[] = [
  { code: "USD", nameAr: "دولار أمريكي", symbol: "$" },
  { code: "EUR", nameAr: "يورو", symbol: "€" },
  { code: "GBP", nameAr: "جنيه إسترليني", symbol: "£" },
  { code: "TRY", nameAr: "ليرة تركية", symbol: "₺" },
  { code: "CNY", nameAr: "يوان صيني", symbol: "¥" },
  { code: "INR", nameAr: "روبية هندية", symbol: "₹" },
];

export const CURRENCIES: CurrencyInfo[] = (() => {
  const seen = new Set<string>();
  const out: CurrencyInfo[] = [];
  for (const c of ARAB_COUNTRIES) {
    if (seen.has(c.currencyCode)) continue;
    seen.add(c.currencyCode);
    out.push({ code: c.currencyCode, nameAr: c.nameAr, symbol: c.currencySymbol });
  }
  for (const c of EXTRA_CURRENCIES) {
    if (seen.has(c.code)) continue;
    seen.add(c.code);
    out.push(c);
  }
  return out;
})();

const BY_CURRENCY: Record<string, CurrencyInfo> =
  Object.fromEntries(CURRENCIES.map((c) => [c.code, c]));

/** The company/operator base currency code (derived from the chosen country). */
export function baseCurrencyCode(): string {
  return getCountryInfo().currencyCode;
}

/** Lookup currency info by ISO-4217 code (falls back to the base currency). */
export function currencyByCode(code: string | null | undefined): CurrencyInfo {
  const c = (code || "").toUpperCase();
  return BY_CURRENCY[c] ?? { code: baseCurrencyCode(), nameAr: "", symbol: currencySymbol() };
}

/** Display symbol for any currency code (falls back to the base symbol). */
export function symbolForCurrency(code: string | null | undefined): string {
  return currencyByCode(code).symbol;
}

const DEFAULT_COUNTRY: CountryInfo = BY_ISO.SA;

/** Currently selected ISO-2 country code (defaults to "SA"). */
export function getCountryIso(): string {
  if (typeof window === "undefined") return DEFAULT_COUNTRY.iso;
  return (localStorage.getItem(LS_COUNTRY) || DEFAULT_COUNTRY.iso).toUpperCase();
}

/** True only once the operator has explicitly chosen a country. */
export function hasChosenCountry(): boolean {
  if (typeof window === "undefined") return false;
  const v = localStorage.getItem(LS_COUNTRY);
  return !!(v && v.trim());
}

/** Full info for the selected country (falls back to Saudi Arabia). */
export function getCountryInfo(): CountryInfo {
  return BY_ISO[getCountryIso()] ?? DEFAULT_COUNTRY;
}

/** Lookup any country by ISO code (case-insensitive). */
export function countryByIso(iso: string | null | undefined): CountryInfo {
  return BY_ISO[(iso || "").toUpperCase()] ?? DEFAULT_COUNTRY;
}

/** Synchronous currency symbol for the POS — safe outside React. */
export function currencySymbol(): string {
  return getCountryInfo().currencySymbol;
}

/**
 * Persist the chosen country. Writes localStorage (sync source of truth),
 * dispatches the shared tax/currency change event, and fire-and-forget
 * mirrors to SQLite in Tauri builds.
 */
export function setCountryIso(iso: string): void {
  if (typeof window === "undefined") return;
  const code = (iso || "").toUpperCase();
  if (!BY_ISO[code]) return;
  localStorage.setItem(LS_COUNTRY, code);
  window.dispatchEvent(new Event(EVT));
  void mirrorToTauri(LS_COUNTRY, code);
}

/** React hook — live currency symbol, updates when the country changes. */
export function useCurrencySymbol(): string {
  const [sym, setSym] = useState<string>(() => currencySymbol());
  useEffect(() => {
    const refresh = () => setSym(currencySymbol());
    window.addEventListener(EVT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(EVT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return sym;
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
    // Non-fatal — localStorage remains the source of truth.
  }
}
