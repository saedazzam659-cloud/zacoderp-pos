// =====================================================================
// INDUSTRY CATALOG (multi-select)
// Used by the registration wizard to pre-select a recommended set of
// system modules for the new company. Multi-select: a user can pick any
// subset of industries; the recommended modules are the UNION across the
// selected industries.
// `recommendedModules` references high-level keys from systemModules.ts —
// keep the two files in sync.
// =====================================================================

export interface Industry {
  code:               string;   // stable lookup key
  nameAr:             string;
  nameEn:             string;
  emoji:              string;   // small visual cue, no extra icon import
  recommendedModules: string[]; // module keys from systemModules.ts
}

// NOTE: "core" module (dashboard + invoices) is alwaysOn and granted automatically,
// so it does NOT need to appear in recommendedModules. The wizard already shows
// its permissions as enabled by default for every company.
//
// Industry tiers (per product spec):
//   commercial  → inventory, sales, purchasing, accounting, hr
//   industrial  → commercial + production
//   contracting → industrial  + contracting management
export const INDUSTRIES: Industry[] = [
  {
    code: "commercial", nameAr: "تجاري", nameEn: "Commercial", emoji: "🛒",
    recommendedModules: ["inventory", "sales", "purchasing", "accounting", "hr"],
  },
  {
    code: "industrial", nameAr: "صناعي", nameEn: "Industrial", emoji: "🏭",
    recommendedModules: ["inventory", "sales", "purchasing", "accounting", "hr", "production"],
  },
  {
    code: "contracting", nameAr: "مقاولات", nameEn: "Contracting", emoji: "🏗️",
    recommendedModules: ["inventory", "sales", "purchasing", "accounting", "hr", "production", "contracting"],
  },
  {
    code: "medical", nameAr: "طبي", nameEn: "Medical", emoji: "🩺",
    recommendedModules: ["sales", "inventory", "cash", "accounting", "hr", "zatca", "pos"],
  },
  {
    code: "hotels", nameAr: "فنادق", nameEn: "Hotels", emoji: "🏨",
    recommendedModules: ["sales", "pos", "inventory", "cash", "accounting", "hr", "zatca"],
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
