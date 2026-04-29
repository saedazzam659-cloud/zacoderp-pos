// =====================================================================
// INDUSTRY CATALOG (multi-select) — STATIC FALLBACK ONLY
// Source of truth is the `industries` DB table (managed in
// /admin/industries) and exposed via /api/admin/industries/public.
// This file is consulted by the registration wizard solely as a
// graceful fallback if the live fetch fails so the chip strip never
// renders empty. Keep it in sync with DEFAULT_INDUSTRIES in
// artifacts/api-server/src/routes/adminIndustries.ts.
//
// `recommendedModules` now stores GRANULAR menu-permission keys
// (matching MENU_ITEMS in lib/menuItems.ts) so the registration flow
// can hand them straight to the server-side menuPermissions builder.
// =====================================================================

export interface Industry {
  code:               string;   // stable lookup key
  nameAr:             string;
  nameEn:             string;
  emoji:              string;   // small visual cue, no extra icon import
  recommendedModules: string[]; // GRANULAR menu permission keys (lib/menuItems.ts)
}

export const INDUSTRIES: Industry[] = [
  {
    code: "commercial", nameAr: "تجاري", nameEn: "Commercial", emoji: "🛒",
    recommendedModules: [
      "dashboard", "invoices", "customers", "suppliers",
      "inventory_mobile", "inventory_reports",
      "sales_module", "sales_reports",
      "purchases_module", "purchases_reports",
      "cash_module", "cash_reports", "accounts", "accounting_reports",
      "hr_module",
    ],
  },
  {
    code: "industrial", nameAr: "صناعي", nameEn: "Industrial", emoji: "🏭",
    recommendedModules: [
      "dashboard", "invoices", "customers", "suppliers",
      "inventory_mobile", "inventory_reports",
      "sales_module", "sales_reports",
      "purchases_module", "purchases_reports",
      "cash_module", "cash_reports", "accounts", "accounting_reports",
      "hr_module", "production",
    ],
  },
  {
    code: "contracting", nameAr: "مقاولات", nameEn: "Contracting", emoji: "🏗️",
    recommendedModules: [
      "dashboard", "invoices", "customers", "suppliers",
      "inventory_mobile", "inventory_reports",
      "sales_module", "sales_reports",
      "purchases_module", "purchases_reports",
      "cash_module", "cash_reports", "accounts", "accounting_reports",
      "hr_module", "production", "contracting",
    ],
  },
  {
    code: "medical", nameAr: "طبي", nameEn: "Medical", emoji: "🩺",
    recommendedModules: [
      "dashboard", "invoices", "customers",
      "sales_module", "sales_reports",
      "inventory_mobile", "inventory_reports",
      "pos",
      "cash_module", "accounts", "accounting_reports",
      "hr_module", "zatca", "reports",
    ],
  },
  {
    code: "hotels", nameAr: "فنادق", nameEn: "Hotels", emoji: "🏨",
    recommendedModules: [
      "dashboard", "invoices", "customers",
      "sales_module", "sales_reports",
      "pos",
      "inventory_mobile", "inventory_reports",
      "cash_module", "accounts", "accounting_reports",
      "hr_module", "zatca", "reports",
    ],
  },
];

export function getIndustryByCode(code: string): Industry | undefined {
  return INDUSTRIES.find(i => i.code === code);
}

// Returns the union of recommended modules across the given industry
// codes. Empty input → empty array (lets the form distinguish "no
// industry selected" from "industry selected but no recommendations").
export function unionRecommendedModules(industryCodes: string[]): string[] {
  const set = new Set<string>();
  for (const code of industryCodes) {
    const ind = getIndustryByCode(code);
    if (ind) for (const m of ind.recommendedModules) set.add(m);
  }
  return Array.from(set);
}
