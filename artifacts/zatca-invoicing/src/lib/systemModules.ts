// =====================================================================
// SYSTEM MODULE CATALOG (selectable at registration)
// 8 high-level modules grouped by category. Each module bundles one or
// more low-level menuPermissions keys (the same keys MenuPermissions.tsx
// uses), so toggling a module on automatically grants every permission
// it covers. The monthly price is the per-module add-on used by the
// pricing formula:
//
//   total = basePlan + max(0, selected - includedModules) × moduleAddOn
//
// where `includedModules` comes from PLAN_INCLUDED below (per plan tier)
// and `moduleAddOn` is the average of the selected modules' prices —
// kept simple so the price line always shows a clean breakdown.
// =====================================================================

export type ModuleCategory =
  | "core"        // dashboard, invoices — always included, NOT shown
  | "sales"
  | "operations"
  | "finance"
  | "people"
  | "compliance";

export interface SystemModule {
  key:           string;       // stable selection key (sales, inventory, …)
  nameAr:        string;
  nameEn:        string;
  descAr:        string;       // one-liner shown under the module name
  emoji:         string;
  category:      ModuleCategory;
  categoryAr:    string;       // section header in the UI
  monthlyPrice:  number;       // SAR/month per-module add-on rate
  permissions:   string[];     // menuPermissions keys this module unlocks
  alwaysOn?:     boolean;      // core modules — always selected, not toggleable
}

// The catalog. Keys here are referenced by industries.ts.
export const SYSTEM_MODULES: SystemModule[] = [
  // ── Core (always on, hidden from picker) ─────────────────────────
  {
    key: "core", nameAr: "الأساسيات", nameEn: "Core", descAr: "لوحة التحكم والفواتير الأساسية",
    emoji: "⚙️", category: "core", categoryAr: "الأساسيات",
    monthlyPrice: 0, alwaysOn: true,
    permissions: ["dashboard", "invoices", "customers"],
  },

  // ── Sales & Customers ────────────────────────────────────────────
  {
    key: "sales", nameAr: "العملاء والمبيعات", nameEn: "Sales", descAr: "إدارة العملاء، عروض الأسعار، فواتير المبيعات وتقاريرها",
    emoji: "📈", category: "sales", categoryAr: "المبيعات والعملاء",
    monthlyPrice: 35,
    permissions: ["sales_module", "sales_reports", "customers"],
  },

  // ── Operations: Purchasing + Inventory + POS ─────────────────────
  {
    key: "purchasing", nameAr: "المشتريات والموردون", nameEn: "Purchasing", descAr: "إدارة الموردين، أوامر وفواتير الشراء والتقارير",
    emoji: "🛍️", category: "operations", categoryAr: "العمليات",
    monthlyPrice: 35,
    permissions: ["purchases_module", "purchases_reports", "suppliers"],
  },
  {
    key: "inventory", nameAr: "المخزون والمستودعات", nameEn: "Inventory", descAr: "تتبّع الأصناف، الأرصدة، التحويلات، الجرد وتقارير المخازن",
    emoji: "📦", category: "operations", categoryAr: "العمليات",
    monthlyPrice: 40,
    permissions: ["inventory_mobile", "inventory_reports"],
  },
  {
    key: "pos", nameAr: "نقاط البيع", nameEn: "POS", descAr: "كاشير، جلسات، أجهزة نقاط البيع ومتابعة لحظية",
    emoji: "🧾", category: "operations", categoryAr: "العمليات",
    monthlyPrice: 45,
    permissions: ["pos"],
  },

  // ── Finance: Cash + Accounting ───────────────────────────────────
  {
    key: "cash", nameAr: "النقد والبنوك", nameEn: "Cash & Banks", descAr: "صناديق نقدية، حسابات بنكية، سندات قبض وصرف، تحويلات",
    emoji: "💰", category: "finance", categoryAr: "المالية",
    monthlyPrice: 30,
    permissions: ["cash_module", "cash_reports"],
  },
  {
    key: "accounting", nameAr: "المحاسبة العامة", nameEn: "Accounting", descAr: "دليل الحسابات، القيود، مراكز التكلفة، الفترات المالية والتقارير",
    emoji: "📒", category: "finance", categoryAr: "المالية",
    monthlyPrice: 50,
    permissions: ["accounts", "accounting_reports"],
  },

  // ── People ───────────────────────────────────────────────────────
  {
    key: "hr", nameAr: "شؤون الموظفين", nameEn: "HR", descAr: "بيانات الموظفين، الرواتب والمسيّرات الشهرية",
    emoji: "👥", category: "people", categoryAr: "الموارد البشرية",
    monthlyPrice: 35,
    permissions: ["hr_module"],
  },

  // ── Operations: Contracting + Production + Security ─────────────
  {
    key: "contracting", nameAr: "إدارة المقاولات", nameEn: "Contracting", descAr: "المشاريع، المقاولون الباطن، العقود، المستخلصات والموارد",
    emoji: "🏗️", category: "operations", categoryAr: "العمليات",
    monthlyPrice: 60,
    permissions: ["contracting"],
  },
  {
    key: "production", nameAr: "الإنتاج والتصنيع", nameEn: "Manufacturing", descAr: "أوامر الإنتاج، الماكينات والموارد الصناعية",
    emoji: "🏭", category: "operations", categoryAr: "العمليات",
    monthlyPrice: 50,
    permissions: ["production"],
  },
  {
    key: "security", nameAr: "الأمن والمراقبة", nameEn: "Security & Surveillance", descAr: "أحداث الأمن، تصنيف الحوادث وتحليل صور المراقبة",
    emoji: "📹", category: "operations", categoryAr: "العمليات",
    monthlyPrice: 40,
    permissions: ["security_events"],
  },
  {
    key: "maintenance", nameAr: "إدارة الصيانة", nameEn: "Maintenance & Assets", descAr: "تتبّع الأصول والمعدات، الفنّيين، أوامر الصيانة وقطع الغيار",
    emoji: "🔧", category: "operations", categoryAr: "العمليات",
    monthlyPrice: 50,
    permissions: ["maintenance"],
  },

  // ── Compliance ───────────────────────────────────────────────────
  {
    key: "zatca", nameAr: "الفوترة الإلكترونية وZATCA", nameEn: "ZATCA Integration", descAr: "ربط هيئة الزكاة، شهادات CSR/CSID، QR وUBL XML",
    emoji: "🛡️", category: "compliance", categoryAr: "الالتزام الضريبي",
    monthlyPrice: 25,
    permissions: ["zatca", "reports"],
  },
];

// Plan tier → modules included free of charge. Above this count, every
// extra module adds (avg module price) to the bill — see priceFor().
export const PLAN_INCLUDED: Record<string, number> = {
  starter:      2,      // 2 modules free
  professional: 5,      // 5 modules free
  enterprise:   100,    // effectively unlimited (we cap at SYSTEM_MODULES.length anyway)
};

// Public list (excludes always-on core).
export const SELECTABLE_MODULES: SystemModule[] = SYSTEM_MODULES.filter(m => !m.alwaysOn);

// Distinct categories in display order.
export const CATEGORIES: { key: ModuleCategory; nameAr: string }[] = [
  { key: "sales",      nameAr: "المبيعات والعملاء" },
  { key: "operations", nameAr: "العمليات" },
  { key: "finance",    nameAr: "المالية" },
  { key: "people",     nameAr: "الموارد البشرية" },
  { key: "compliance", nameAr: "الالتزام الضريبي" },
];

// Quick lookup map.
const BY_KEY: Record<string, SystemModule> = Object.fromEntries(
  SYSTEM_MODULES.map(m => [m.key, m]),
);
export function getModuleByKey(key: string): SystemModule | undefined {
  return BY_KEY[key];
}

// Pricing helper. Returns base + extras + total + breakdown.
//
// Pricing model: when more modules are selected than the plan includes
// for free, the CHEAPEST `included` modules are treated as free and the
// REMAINING modules are charged at their actual per-module monthly
// price. This keeps the UI honest — the "+35 ر.س" tag next to a module
// is exactly what the user pays for it once it crosses the free budget.
export interface PriceBreakdown {
  base:          number;   // plan base price (monthly)
  selectedCount: number;   // total selected modules
  includedFree:  number;   // count counted as free (the cheapest N)
  extraCount:    number;   // count of paid extras
  extraSubtotal: number;   // SUM of paid extras' actual monthly prices
  total:         number;   // monthly grand total
}

export function priceFor(opts: {
  basePlanMonthly: number;
  planKey:         string;
  selectedKeys:    string[];   // subset of SELECTABLE_MODULES keys
}): PriceBreakdown {
  const included = PLAN_INCLUDED[opts.planKey] ?? 0;
  // Filter to known + selectable, ignore unknowns / core (free).
  const selected = opts.selectedKeys
    .map(getModuleByKey)
    .filter((m): m is SystemModule => !!m && !m.alwaysOn);

  // Cheapest N go free; the rest are paid at their REAL price.
  const sortedPrices = selected.map(m => m.monthlyPrice).sort((a, b) => a - b);
  const freeCount    = Math.min(included, sortedPrices.length);
  const freeAmount   = sortedPrices.slice(0, freeCount).reduce((s, p) => s + p, 0);
  const grossTotal   = sortedPrices.reduce((s, p) => s + p, 0);
  const extraSubtotal = grossTotal - freeAmount;

  return {
    base:          opts.basePlanMonthly,
    selectedCount: selected.length,
    includedFree:  freeCount,
    extraCount:    selected.length - freeCount,
    extraSubtotal,
    total:         opts.basePlanMonthly + extraSubtotal,
  };
}

// Build the menuPermissions JSON the API expects given a list of
// selected module keys. Always grants core permissions on top of the
// user's selection.
export function buildMenuPermissions(selectedKeys: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  // Core permissions always on
  for (const m of SYSTEM_MODULES) {
    if (m.alwaysOn) for (const p of m.permissions) out[p] = true;
  }
  // User-selected modules
  for (const key of selectedKeys) {
    const m = getModuleByKey(key);
    if (!m || m.alwaysOn) continue;
    for (const p of m.permissions) out[p] = true;
  }
  return out;
}
