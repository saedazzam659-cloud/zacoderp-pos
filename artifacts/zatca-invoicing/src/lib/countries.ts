// =====================================================================
// COUNTRY REGISTRATION CATALOG
// Default: Saudi Arabia · Gulf countries + Egypt + a global fallback.
// Each entry carries a bilingual display label, a bilingual compliance
// policy line shown at registration, and the default currency seeded for
// the new company on first save (matches the shape used by
// Currencies.tsx / currenciesTable).
// =====================================================================

export type CountryLang = "ar" | "en";

export interface CountryCurrency {
  code:   string;       // ISO 4217 — e.g. "SAR"
  nameAr: string;       // ريال سعودي
  nameEn: string;       // Saudi Riyal
  symbol: string;       // ر.س
}

export interface Country {
  code:     string;     // ISO 3166-1 alpha-2 — e.g. "SA". "GLOBAL" = catch-all.
  nameAr:   string;
  nameEn:   string;
  policyAr: string;
  policyEn: string;
  currency: CountryCurrency;
}

export const COUNTRIES: Country[] = [
  {
    code: "SA", nameAr: "السعودية", nameEn: "Saudi Arabia",
    policyAr: "الالتزام بأنظمة الزكاة والضرائب ZATCA",
    policyEn: "Compliance with ZATCA tax system",
    currency: { code: "SAR", nameAr: "ريال سعودي", nameEn: "Saudi Riyal", symbol: "ر.س" },
  },
  {
    code: "AE", nameAr: "الإمارات", nameEn: "United Arab Emirates",
    policyAr: "الالتزام بضريبة الشركات واللوائح التجارية",
    policyEn: "Corporate tax and business regulations compliance",
    currency: { code: "AED", nameAr: "درهم إماراتي", nameEn: "UAE Dirham", symbol: "د.إ" },
  },
  {
    code: "KW", nameAr: "الكويت", nameEn: "Kuwait",
    policyAr: "الالتزام بالقوانين التجارية المحلية",
    policyEn: "Compliance with local commercial laws",
    currency: { code: "KWD", nameAr: "دينار كويتي", nameEn: "Kuwaiti Dinar", symbol: "د.ك" },
  },
  {
    code: "QA", nameAr: "قطر", nameEn: "Qatar",
    policyAr: "الالتزام بلوائح وزارة التجارة والصناعة",
    policyEn: "Ministry of Commerce regulations compliance",
    currency: { code: "QAR", nameAr: "ريال قطري", nameEn: "Qatari Riyal", symbol: "ر.ق" },
  },
  {
    code: "BH", nameAr: "البحرين", nameEn: "Bahrain",
    policyAr: "الالتزام بضريبة القيمة المضافة والأنظمة التجارية",
    policyEn: "VAT and commercial regulations compliance",
    currency: { code: "BHD", nameAr: "دينار بحريني", nameEn: "Bahraini Dinar", symbol: "د.ب" },
  },
  {
    code: "OM", nameAr: "عُمان", nameEn: "Oman",
    policyAr: "الالتزام بالقوانين التجارية والضريبية العُمانية",
    policyEn: "Omani tax and commercial law compliance",
    currency: { code: "OMR", nameAr: "ريال عُماني", nameEn: "Omani Rial", symbol: "ر.ع" },
  },
  {
    code: "EG", nameAr: "مصر", nameEn: "Egypt",
    policyAr: "الالتزام بضريبة القيمة المضافة والقوانين المصرية",
    policyEn: "VAT and Egyptian tax compliance",
    currency: { code: "EGP", nameAr: "جنيه مصري", nameEn: "Egyptian Pound", symbol: "ج.م" },
  },
  {
    code: "GLOBAL", nameAr: "دول أخرى", nameEn: "Other Countries",
    policyAr: "سياسات عامة حسب الدولة",
    policyEn: "General policies depending on country",
    currency: { code: "USD", nameAr: "دولار أمريكي", nameEn: "US Dollar", symbol: "$" },
  },
];

export const DEFAULT_COUNTRY_CODE = "SA";

// Catch-all fallback used when an unknown code is passed; keeps display
// logic total without throwing.
const FALLBACK: Country = COUNTRIES[0];

export function getCountryByCode(code?: string | null): Country {
  if (!code) return FALLBACK;
  return COUNTRIES.find(c => c.code === code) ?? FALLBACK;
}

export function getCountryName(code: string | null | undefined, lang: CountryLang = "ar"): string {
  const c = getCountryByCode(code);
  return lang === "en" ? c.nameEn : c.nameAr;
}

export function getCountryPolicy(code: string | null | undefined, lang: CountryLang = "ar"): string {
  const c = getCountryByCode(code);
  return lang === "en" ? c.policyEn : c.policyAr;
}

export function getCountryCurrency(code: string | null | undefined): CountryCurrency {
  return getCountryByCode(code).currency;
}
