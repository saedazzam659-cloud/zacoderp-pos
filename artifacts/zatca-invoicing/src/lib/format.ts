import { useTranslation } from "react-i18next";

// Numbers are ALWAYS formatted in the international (en-US) style —
// Latin digits, comma thousands separator, period decimal point
// (1,000 / 100,000.34) — regardless of UI language. This matches the
// Excel-style convention users expect for amounts and avoids the
// Arabic-locale grouping marks (٬ / NBSP) that read ambiguously.
export function getNumberLocale(_lang: string): string {
  return "en-US";
}

/**
 * Pure international-style number formatter (comma thousands separator,
 * period decimal). Use for DISPLAY ONLY — never for input values, payloads,
 * exports, or anything parsed back to a number.
 */
export function fmtNum(n: any, decimals = 2): string {
  const num = Number(n ?? 0);
  if (!isFinite(num)) return (0).toFixed(decimals);
  return num.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Display amount with exactly 2 decimals + comma grouping: 100,000.34 */
export const fmt2 = (n: any) => fmtNum(n, 2);

/** Display integer with comma grouping: 100,000 (no decimals). */
export function fmtInt0(n: any): string {
  const num = Number(n ?? 0);
  if (!isFinite(num)) return "0";
  return Math.round(num).toLocaleString("en-US");
}

/** Display quantity with comma grouping, up to `maxDecimals` (trailing zeros trimmed). */
export function fmtQty(n: any, maxDecimals = 2): string {
  const num = Number(n ?? 0);
  if (!isFinite(num)) return "0";
  return num.toLocaleString("en-US", { maximumFractionDigits: maxDecimals });
}

// Central currency-symbol registry. Mirrors the symbols seeded in
// lib/countries.ts plus a few common globals. Used as the fallback when a
// company-defined currency row carries no explicit `symbol`.
export const CURRENCY_SYMBOLS: Record<string, string> = {
  SAR: "ر.س", AED: "د.إ", KWD: "د.ك", QAR: "ر.ق", BHD: "د.ب",
  OMR: "ر.ع", EGP: "ج.م", USD: "$", EUR: "€", GBP: "£",
  JOD: "د.أ", JPY: "¥", CNY: "¥", TRY: "₺", INR: "₹",
};

/**
 * Resolve the display symbol for a currency code.
 * Precedence: company currency row's explicit `symbol` → built-in map → the
 * raw code itself (so an unknown currency degrades gracefully, never throws).
 */
export function currencySymbol(
  code?: string | null,
  currencies?: Array<{ code: string; symbol?: string | null }>,
): string {
  if (!code) return CURRENCY_SYMBOLS.SAR;
  const row = currencies?.find(c => c.code === code);
  if (row?.symbol) return row.symbol;
  return CURRENCY_SYMBOLS[code] ?? code;
}

export function getDateLocale(lang: string): string {
  return lang.startsWith("ar") ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB";
}

export function formatNumber(
  n: any,
  lang: string,
  opts: Intl.NumberFormatOptions = { minimumFractionDigits: 2, maximumFractionDigits: 2 }
): string {
  const num = Number(n || 0);
  if (!isFinite(num)) return "0";
  return num.toLocaleString(getNumberLocale(lang), opts);
}

export function formatInt(n: any, lang: string): string {
  return formatNumber(n, lang, { maximumFractionDigits: 0 });
}

export function formatDate(value: any, lang: string): string {
  if (!value) return "";
  const d = typeof value === "string" ? new Date(value) : (value as Date);
  if (isNaN(d.getTime())) return String(value);
  try {
    return d.toLocaleDateString(getDateLocale(lang), {
      year: "numeric", month: "2-digit", day: "2-digit",
    });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** React hook giving locale-aware formatters that update when language changes. */
export function useFormatters() {
  const { i18n, t } = useTranslation();
  const lang = i18n.language || "ar";
  return {
    lang,
    isRtl: lang.startsWith("ar"),
    fmt:    (n: any, opts?: Intl.NumberFormatOptions) => formatNumber(n, lang, opts),
    fmtInt: (n: any) => formatInt(n, lang),
    fmtDate: (v: any) => formatDate(v, lang),
    fmtMoney: (
      n: any,
      currency = "SAR",
      currencies?: Array<{ code: string; symbol?: string | null }>,
    ) => `${formatNumber(n, lang)} ${currencySymbol(currency, currencies)}`,
  };
}
