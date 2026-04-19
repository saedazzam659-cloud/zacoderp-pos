/**
 * وحدات القياس المتوافقة مع ZATCA (UN/CEFACT Codes)
 * ZATCA-Compliant Unit Codes — Annex A of ZATCA e-invoicing specifications
 * المرجع: دليل ZATCA الفني للفوترة الإلكترونية
 */
export const ZATCA_UNIT_CODES = [
  // ─── الأكثر استخداماً ───────────────────────────────────
  { code: "PCE",  nameAr: "قطعة",          nameEn: "Piece",             group: "عام" },
  { code: "EA",   nameAr: "وحدة",           nameEn: "Each",              group: "عام" },
  { code: "SET",  nameAr: "مجموعة",          nameEn: "Set",               group: "عام" },
  { code: "PAK",  nameAr: "طرد / عبوة",      nameEn: "Package",           group: "عام" },
  { code: "BOX",  nameAr: "صندوق",           nameEn: "Box",               group: "عام" },
  { code: "BAG",  nameAr: "كيس",             nameEn: "Bag",               group: "عام" },
  { code: "CAR",  nameAr: "كرتون",           nameEn: "Carton",            group: "عام" },
  // ─── الخدمات ─────────────────────────────────────────────
  { code: "HUR",  nameAr: "ساعة",            nameEn: "Hour",              group: "خدمات" },
  { code: "DAY",  nameAr: "يوم",             nameEn: "Day",               group: "خدمات" },
  { code: "WEE",  nameAr: "أسبوع",           nameEn: "Week",              group: "خدمات" },
  { code: "MON",  nameAr: "شهر",             nameEn: "Month",             group: "خدمات" },
  { code: "ANN",  nameAr: "سنة",             nameEn: "Year/Annual",       group: "خدمات" },
  { code: "E49",  nameAr: "عمل / مهمة",      nameEn: "Work Item",         group: "خدمات" },
  // ─── الوزن ───────────────────────────────────────────────
  { code: "KGM",  nameAr: "كيلوغرام",        nameEn: "Kilogram",          group: "وزن" },
  { code: "GRM",  nameAr: "غرام",            nameEn: "Gram",              group: "وزن" },
  { code: "TNE",  nameAr: "طن متري",          nameEn: "Metric Tonne",      group: "وزن" },
  { code: "LBR",  nameAr: "رطل",             nameEn: "Pound",             group: "وزن" },
  // ─── الطول ───────────────────────────────────────────────
  { code: "MTR",  nameAr: "متر",             nameEn: "Metre",             group: "طول" },
  { code: "CMT",  nameAr: "سنتيمتر",         nameEn: "Centimetre",        group: "طول" },
  { code: "MMT",  nameAr: "مليمتر",          nameEn: "Millimetre",        group: "طول" },
  { code: "KMT",  nameAr: "كيلومتر",         nameEn: "Kilometre",         group: "طول" },
  { code: "INH",  nameAr: "إنش",             nameEn: "Inch",              group: "طول" },
  // ─── المساحة ──────────────────────────────────────────────
  { code: "MTK",  nameAr: "متر مربع",         nameEn: "Square Metre",      group: "مساحة" },
  { code: "CMK",  nameAr: "سنتيمتر مربع",    nameEn: "Square Centimetre", group: "مساحة" },
  // ─── الحجم ───────────────────────────────────────────────
  { code: "MTQ",  nameAr: "متر مكعب",         nameEn: "Cubic Metre",       group: "حجم" },
  { code: "LTR",  nameAr: "لتر",             nameEn: "Litre",             group: "حجم" },
  { code: "MLT",  nameAr: "مليلتر",          nameEn: "Millilitre",        group: "حجم" },
  { code: "GLL",  nameAr: "غالون",           nameEn: "Gallon",            group: "حجم" },
  // ─── الطاقة ──────────────────────────────────────────────
  { code: "KWH",  nameAr: "كيلوواط/ساعة",    nameEn: "Kilowatt Hour",     group: "طاقة" },
  { code: "MWH",  nameAr: "ميغاواط/ساعة",    nameEn: "Megawatt Hour",     group: "طاقة" },
] as const;

export type ZatcaUnitCode = (typeof ZATCA_UNIT_CODES)[number]["code"];

export const ZATCA_UNIT_GROUPS = [...new Set(ZATCA_UNIT_CODES.map(u => u.group))];

export function getUnitLabel(code: string): string {
  const unit = ZATCA_UNIT_CODES.find(u => u.code === code);
  return unit ? `${unit.code} — ${unit.nameAr}` : code;
}
