import { useTranslation } from "react-i18next";

// Both number and date formatters use Latin (Western) numerals so a
// printed Arabic report doesn't mix Arabic-Indic digits in amounts
// (٢٦٬٤٢٠٫٦٦) with Latin digits in dates (2025-05-22). The grouping /
// decimal *style* still follows the Arabic locale (e.g. NBSP grouping,
// Arabic comma) — only the digit glyphs are forced to Latin via the
// `-u-nu-latn` BCP-47 extension. This is the convention used by every
// Saudi accounting / ZATCA system in production.
export function getNumberLocale(lang: string): string {
  return lang.startsWith("ar") ? "ar-SA-u-nu-latn" : "en-US";
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
    fmtMoney: (n: any, currency = "SAR") =>
      `${formatNumber(n, lang)} ${currency === "SAR" ? t("common.currencySAR", { defaultValue: currency }) : currency}`,
  };
}
