// Shared menu-permissions catalog used by:
//   • /admin/menu-permissions (the per-company toggle grid)
//   • /admin/industries        (the industry → menu-keys multi-select)
//   • /register                (the chip strip that auto-grants menus on signup)
//
// Keeping ONE source of truth for the keys, labels, and section grouping
// avoids the classic "two arrays drift apart" bug — adding a new sidebar
// item only requires editing this file (and the icon map in
// MenuPermissions.tsx, which is purely cosmetic).

export interface MenuItem {
  key:     string;
  label:   string;
  section: string;
}

export const MENU_ITEMS: MenuItem[] = [
  { key: "dashboard",          label: "لوحة التحكم",                section: "رئيسي" },

  { key: "invoices",           label: "الفواتير",                    section: "الأعمال" },
  { key: "customers",          label: "العملاء",                     section: "الأعمال" },
  { key: "suppliers",          label: "الموردون",                    section: "الأعمال" },
  { key: "reports",            label: "الإقرار الضريبي",            section: "الأعمال" },

  { key: "inventory_mobile",   label: "موبيل المخازن",              section: "المخازن" },
  { key: "inventory_reports",  label: "تقارير المخازن",             section: "المخازن" },

  { key: "sales_module",       label: "العملاء والمبيعات",          section: "المبيعات" },
  { key: "sales_reports",      label: "تقارير العملاء والمبيعات",   section: "المبيعات" },

  { key: "purchases_module",   label: "الموردون والمشتريات",        section: "المشتريات" },
  { key: "purchases_reports",  label: "تقارير الموردين والمشتريات", section: "المشتريات" },

  { key: "pos",                label: "نقاط البيع",                  section: "نقاط البيع" },

  { key: "cash_module",        label: "النقد والبنوك",              section: "المحاسبة" },
  { key: "cash_reports",       label: "تقارير النقد والبنوك",       section: "المحاسبة" },
  { key: "accounts",           label: "الحسابات العامة",            section: "المحاسبة" },
  { key: "accounting_reports", label: "التقارير المحاسبية",         section: "المحاسبة" },
  { key: "accounting_maintenance", label: "الصيانة المحاسبية وميزان المراجعة", section: "المحاسبة" },

  { key: "hr_module",          label: "شؤون الموظفين",              section: "شؤون الموظفين" },

  { key: "contracting",        label: "إدارة المقاولات",            section: "إدارة المقاولات" },

  { key: "production",         label: "الإنتاج والتصنيع",           section: "الإنتاج والتصنيع" },

  { key: "maintenance",        label: "إدارة الصيانة",              section: "إدارة الصيانة" },

  { key: "hotel",              label: "إدارة الفنادق الذكية",       section: "إدارة الفنادق" },

  { key: "hospital",           label: "إدارة المستشفيات والمستوصفات", section: "إدارة المستشفيات" },

  { key: "crm",                label: "إدارة علاقات العملاء (CRM)", section: "إدارة CRM" },

  { key: "fixed_assets",       label: "إدارة الأصول الثابتة",       section: "الأصول الثابتة" },

  { key: "security_events",    label: "الأمن والمراقبة",            section: "الأمن والمراقبة" },

  { key: "seo_dashboard",      label: "إدارة SEO",                  section: "تحليلات SEO" },

  { key: "online_store",       label: "المتجر الإلكتروني",          section: "المتجر الإلكتروني" },

  { key: "ai_tools",           label: "أدوات الذكاء الاصطناعي",     section: "أدوات الذكاء الاصطناعي" },

  { key: "zatca",              label: "ربط ZATCA",                   section: "النظام" },
];

export const SECTIONS: string[] = Array.from(new Set(MENU_ITEMS.map(m => m.section)));

// Quick lookup helpers — kept here so callers don't need to repeat the
// `Map.from(MENU_ITEMS)` boilerplate.
export const MENU_ITEM_BY_KEY: Record<string, MenuItem> = Object.fromEntries(
  MENU_ITEMS.map(m => [m.key, m]),
);

// ─────────────────────────────────────────────────────────────────────
// Reverse mapping: menu permission key → high-level billable module key
// (the catalog managed in /admin/modules). When an industry template
// grants a permission like "sales_module", the registration wizard will
// also auto-add the parent module ("sales") to the user's billing
// selection so they aren't seeing a menu they aren't paying for.
// `null` means the permission is "core" (always-on, no billing module).
// Mirrors the MODULE_PERMISSIONS map server-side in routes/auth.ts.
// ─────────────────────────────────────────────────────────────────────
export const PERMISSION_TO_MODULE: Record<string, string | null> = {
  dashboard:          null,           // always-on core
  invoices:           null,           // always-on core
  customers:          null,           // always-on core (also tied to "sales" but free)
  suppliers:          "purchasing",
  reports:            "zatca",
  inventory_mobile:   "inventory",
  inventory_reports:  "inventory",
  sales_module:       "sales",
  sales_reports:      "sales",
  purchases_module:   "purchasing",
  purchases_reports:  "purchasing",
  pos:                "pos",
  cash_module:        "cash",
  cash_reports:       "cash",
  accounts:           "accounting",
  accounting_reports: "accounting",
  accounting_maintenance: "accounting",
  hr_module:          "hr",
  contracting:        "contracting",
  production:         "production",
  maintenance:        "maintenance",
  hotel:              "hotel",
  hospital:           "hospital",
  crm:                "crm",
  fixed_assets:       "fixed_assets",
  security_events:    "security",
  seo_dashboard:      null,           // SuperAdmin tool, not billed per-company
  online_store:       null,           // included for now (no separate billable module)
  ai_tools:           null,           // SuperAdmin tool, not billed per-company
  zatca:              "zatca",
};

// Resolve the unique set of high-level module keys implied by a list of
// granular menu-permission keys. Used by the registration wizard to
// auto-add modules to the billing selection when an industry chip is
// activated. Deduped via Set; nullable parents (core keys) are skipped.
export const deriveModulesFromMenuKeys = (menuKeys: string[]): string[] => {
  const out = new Set<string>();
  for (const k of menuKeys) {
    const parent = PERMISSION_TO_MODULE[k];
    if (parent) out.add(parent);
  }
  return Array.from(out);
};

// Theme tokens reused by both /admin/menu-permissions and
// /admin/industries so the section chips look identical across pages.
export const SECTION_THEME: Record<string, { bg: string; text: string; border: string }> = {
  "رئيسي":               { bg: "bg-blue-50",     text: "text-blue-700",     border: "border-blue-200" },
  "الأعمال":              { bg: "bg-emerald-50",  text: "text-emerald-700",  border: "border-emerald-200" },
  "المخازن":              { bg: "bg-amber-50",    text: "text-amber-700",    border: "border-amber-200" },
  "المبيعات":             { bg: "bg-cyan-50",     text: "text-cyan-700",     border: "border-cyan-200" },
  "المشتريات":            { bg: "bg-orange-50",   text: "text-orange-700",   border: "border-orange-200" },
  "نقاط البيع":           { bg: "bg-teal-50",     text: "text-teal-700",     border: "border-teal-200" },
  "المحاسبة":             { bg: "bg-indigo-50",   text: "text-indigo-700",   border: "border-indigo-200" },
  "شؤون الموظفين":         { bg: "bg-rose-50",     text: "text-rose-700",     border: "border-rose-200" },
  "إدارة المقاولات":       { bg: "bg-yellow-50",   text: "text-yellow-700",   border: "border-yellow-200" },
  "الإنتاج والتصنيع":      { bg: "bg-stone-50",    text: "text-stone-700",    border: "border-stone-200" },
  "إدارة الصيانة":         { bg: "bg-orange-50",   text: "text-orange-700",   border: "border-orange-200" },
  "إدارة الفنادق":         { bg: "bg-teal-50",     text: "text-teal-700",     border: "border-teal-200" },
  "إدارة المستشفيات":      { bg: "bg-sky-50",      text: "text-sky-700",      border: "border-sky-200" },
  "إدارة CRM":             { bg: "bg-pink-50",     text: "text-pink-700",     border: "border-pink-200" },
  "الأصول الثابتة":        { bg: "bg-emerald-50",  text: "text-emerald-700",  border: "border-emerald-200" },
  "الأمن والمراقبة":       { bg: "bg-slate-50",    text: "text-slate-700",    border: "border-slate-200" },
  "تحليلات SEO":           { bg: "bg-fuchsia-50",  text: "text-fuchsia-700",  border: "border-fuchsia-200" },
  "أدوات الذكاء الاصطناعي": { bg: "bg-violet-50",   text: "text-violet-700",   border: "border-violet-200" },
  "النظام":               { bg: "bg-purple-50",   text: "text-purple-700",   border: "border-purple-200" },
};
