export type QuotationPrintLanguage = "ar" | "en";

export interface QuotationPrintCompanySettings {
  printQuotationShowQr?: boolean | null;
  printQuotationShowCurrencyName?: boolean | null;
  printQuotationShowCustomerAddress?: boolean | null;
}

export interface QuotationCurrency {
  code?: string | null;
  nameAr?: string | null;
  nameEn?: string | null;
}

/**
 * Legacy company rows do not have explicit values for these settings.
 * Keep the agreed defaults stable for both legacy and newly-created tenants:
 * QR hidden, currency name shown, customer address shown.
 */
export function getQuotationPrintOptions(company?: QuotationPrintCompanySettings | null) {
  return {
    showQr: company?.printQuotationShowQr === true,
    showCurrencyName: company?.printQuotationShowCurrencyName !== false,
    showCustomerAddress: company?.printQuotationShowCustomerAddress !== false,
  };
}

export function resolveQuotationCurrencyName(
  company: QuotationPrintCompanySettings | null | undefined,
  currency: QuotationCurrency | null | undefined,
  language: QuotationPrintLanguage,
): string {
  if (!getQuotationPrintOptions(company).showCurrencyName || !currency) return "";
  const preferred = language === "en" ? currency.nameEn : currency.nameAr;
  const fallback = language === "en" ? currency.nameAr : currency.nameEn;
  return String(preferred ?? fallback ?? "").trim();
}

export function buildQuotationCustomerAddress(
  customer: any,
  doc: any,
  language: QuotationPrintLanguage,
  countryName?: string,
): string {
  const building = customer?.buildingNumber ?? doc?.buyerBuildingNumber;
  const street = customer?.street ?? doc?.buyerStreet;
  const district = customer?.district ?? doc?.buyerDistrict;
  const city = customer?.city ?? doc?.buyerCity;
  const postal = customer?.postalCode ?? doc?.buyerPostalCode;
  const shortAddress = customer?.nationalAddressShort ?? doc?.buyerNationalAddressShort;

  const parts = [
    building ? (language === "en" ? `Building ${building}` : `مبنى ${building}`) : "",
    street,
    district,
    city,
    postal ? (language === "en" ? `Postal ${postal}` : `الرمز ${postal}`) : "",
    countryName,
    shortAddress,
  ].map((value) => String(value ?? "").trim()).filter(Boolean);

  return Array.from(new Set(parts)).join(language === "en" ? ", " : "، ");
}