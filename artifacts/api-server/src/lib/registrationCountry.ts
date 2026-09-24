// Registration-only defaults. Never used to migrate existing companies or to
// infer compliance eligibility. Keep the country/currency codes aligned with
// the public registration catalog (zatca-invoicing/src/lib/countries.ts).
import { db, currenciesTable, taxesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
export const REGISTRATION_COUNTRIES = {
  SA: { currency: { code: "SAR", nameAr: "ريال سعودي", nameEn: "Saudi Riyal", symbol: "ر.س" }, rate: "15" },
  AE: { currency: { code: "AED", nameAr: "درهم إماراتي", nameEn: "UAE Dirham", symbol: "د.إ" }, rate: "5" },
  KW: { currency: { code: "KWD", nameAr: "دينار كويتي", nameEn: "Kuwaiti Dinar", symbol: "د.ك" }, rate: "0" },
  QA: { currency: { code: "QAR", nameAr: "ريال قطري", nameEn: "Qatari Riyal", symbol: "ر.ق" }, rate: "0" },
  BH: { currency: { code: "BHD", nameAr: "دينار بحريني", nameEn: "Bahraini Dinar", symbol: "د.ب" }, rate: "10" },
  OM: { currency: { code: "OMR", nameAr: "ريال عُماني", nameEn: "Omani Rial", symbol: "ر.ع" }, rate: "5" },
  EG: { currency: { code: "EGP", nameAr: "جنيه مصري", nameEn: "Egyptian Pound", symbol: "ج.م" }, rate: "14" },
  GLOBAL: { currency: { code: "USD", nameAr: "دولار أمريكي", nameEn: "US Dollar", symbol: "$" }, rate: "0" },
} as const;

export function registrationCountry(input: unknown, override?: unknown) {
  const code = input === undefined || input === null ? "SA" : input;
  if (typeof code !== "string" || !Object.prototype.hasOwnProperty.call(REGISTRATION_COUNTRIES, code)) {
    throw new Error("الدولة المختارة غير مدعومة");
  }
  const profile = REGISTRATION_COUNTRIES[code as keyof typeof REGISTRATION_COUNTRIES];
  if (override !== undefined && override !== null &&
    (typeof override !== "string" || !Object.values(REGISTRATION_COUNTRIES).some(p => p.currency.code === override))) {
    throw new Error("العملة المختارة غير مدعومة");
  }
  const currency = Object.values(REGISTRATION_COUNTRIES).find(p => p.currency.code === override)?.currency ?? profile.currency;
  return { code, currency, rate: profile.rate };
}

// Scoped to the ID of the just-created company. Idempotent if its default
// was already configured manually; never updates an existing company's rows.
export async function seedRegistrationCountryDefaults(
  companyId: number,
  profile: ReturnType<typeof registrationCountry>,
  database: Pick<typeof db, "select" | "insert"> = db,
) {
  const [currency] = await database.select({ id: currenciesTable.id }).from(currenciesTable)
    .where(and(eq(currenciesTable.companyId, companyId), eq(currenciesTable.isDefault, true))).limit(1);
  if (!currency) await database.insert(currenciesTable).values({
    companyId, ...profile.currency, isDefault: true, isActive: true,
  });
  const [tax] = await database.select({ id: taxesTable.id }).from(taxesTable)
    .where(and(eq(taxesTable.companyId, companyId), eq(taxesTable.isDefault, true))).limit(1);
  if (!tax) await database.insert(taxesTable).values({
    companyId, code: `VAT${profile.rate}`,
    nameAr: `ضريبة القيمة المضافة ${profile.rate}%`,
    nameEn: `VAT ${profile.rate}%`,
    rate: profile.rate, rateType: "percent",
    isDefault: true, isSystem: profile.code === "SA", isActive: true,
  });
}