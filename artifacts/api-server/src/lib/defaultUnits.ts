export interface DefaultUnit {
  code: string;
  nameAr: string;
  nameEn: string;
}

/**
 * Standard set of measurement units seeded for every new tenant so the
 * line-level "الوحدة" picker on sales / purchase documents is populated
 * out of the box. All conversion factors are 1 — per-item alternate-unit
 * conversions (e.g. carton = 12 pcs) are defined separately per item via
 * item_unit_prices, not on the global unit row.
 */
export const DEFAULT_UNITS: DefaultUnit[] = [
  { code: "PCS", nameAr: "قطعة", nameEn: "Piece" },
  { code: "BOX", nameAr: "علبة", nameEn: "Box" },
  { code: "CTN", nameAr: "كرتون", nameEn: "Carton" },
  { code: "PKT", nameAr: "عبوة", nameEn: "Packet" },
  { code: "DZN", nameAr: "دستة", nameEn: "Dozen" },
  { code: "BAG", nameAr: "كيس", nameEn: "Bag" },
  { code: "SET", nameAr: "طقم", nameEn: "Set" },
  { code: "KG", nameAr: "كيلوجرام", nameEn: "Kilogram" },
  { code: "GM", nameAr: "جرام", nameEn: "Gram" },
  { code: "LTR", nameAr: "لتر", nameEn: "Liter" },
  { code: "ML", nameAr: "مليلتر", nameEn: "Milliliter" },
  { code: "MTR", nameAr: "متر", nameEn: "Meter" },
];
