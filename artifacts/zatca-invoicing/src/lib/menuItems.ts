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
  { key: "sister_companies",   label: "معاملات الشركات الشقيقة",    section: "معاملات الشركات الشقيقة" },
  { key: "multi_domain",       label: "إدارة النطاقات المتعددة",     section: "إدارة النظام" },
  { key: "customer_notes",     label: "إشعارات دائنة/مدينة (عملاء)", section: "المبيعات" },
  { key: "supplier_notes",     label: "إشعارات دائنة/مدينة (موردين)", section: "المشتريات" },

  { key: "sales_module",       label: "العملاء والمبيعات",          section: "المبيعات" },
  { key: "sales_reports",      label: "تقارير العملاء والمبيعات",   section: "المبيعات" },

  { key: "purchases_module",   label: "الموردون والمشتريات",        section: "المشتريات" },
  { key: "purchases_reports",  label: "تقارير الموردين والمشتريات", section: "المشتريات" },

  { key: "pos",                label: "نقاط البيع",                  section: "نقاط البيع" },

  { key: "cash_module",        label: "النقد والبنوك",              section: "الحسابات العامة" },
  { key: "cash_reports",       label: "تقارير النقد والبنوك",       section: "الحسابات العامة" },
  { key: "accounts",           label: "الحسابات العامة",            section: "الحسابات العامة" },
  { key: "accounting_reports", label: "التقارير المحاسبية",         section: "الحسابات العامة" },
  { key: "accounting_maintenance", label: "الصيانة المحاسبية وميزان المراجعة", section: "صيانة الحسابات" },

  { key: "hr_module",          label: "شؤون الموظفين",              section: "شؤون الموظفين" },

  { key: "contracting",        label: "إدارة المقاولات",            section: "إدارة المقاولات" },

  { key: "production",         label: "الإنتاج والتصنيع",           section: "الإنتاج والتصنيع" },

  { key: "safety",             label: "السلامة والصحة المهنية",      section: "السلامة والصحة المهنية" },

  { key: "maintenance",        label: "إدارة الصيانة",              section: "إدارة الصيانة" },

  { key: "hotel",              label: "إدارة الفنادق الذكية",       section: "إدارة الفنادق" },

  { key: "hospital",           label: "إدارة المستشفيات والمستوصفات", section: "إدارة المستشفيات" },

  { key: "crm",                label: "إدارة علاقات العملاء (CRM)", section: "إدارة CRM" },

  { key: "fixed_assets",       label: "إدارة الأصول الثابتة",       section: "الأصول الثابتة" },

  { key: "security_events",    label: "الأمن والمراقبة",            section: "الأمن والمراقبة" },

  { key: "seo_dashboard",      label: "إدارة SEO",                  section: "تحليلات SEO" },

  { key: "online_store",       label: "المتجر الإلكتروني",          section: "المتجر الإلكتروني" },

  { key: "field_service",      label: "الخدمة الميدانية",            section: "الخدمة الميدانية" },

  { key: "ai_tools",           label: "أدوات الذكاء الاصطناعي",     section: "أدوات الذكاء الاصطناعي" },

  { key: "voice_assistant",    label: "إعدادات المساعد الصوتي",     section: "إعدادات المساعد الصوتي" },

  { key: "sessions",           label: "الجلسات",                    section: "الجلسات" },

  { key: "chat",               label: "الاتصال الداخلي",            section: "الاتصال الداخلي" },

  { key: "company_maintenance", label: "صيانة الشركات",             section: "صيانة الشركات" },

  { key: "installments",       label: "البيع بالتقسيط الذكي",       section: "البيع بالتقسيط" },

  { key: "user_tracking",      label: "تتبع مواقع المستخدمين",       section: "المراقبة المباشرة" },

  { key: "zatca",              label: "ربط ZATCA",                   section: "النظام" },

  // ── ربط متعدد ──────────────────────────────────────────────────
  // Multi-tenant external invoice gateway: a top-level group housing
  // every screen related to onboarding 3rd-party companies, uploading
  // their invoices, monitoring submission status, reports & CSID
  // management. Single permission key drives the whole collapsible
  // sidebar group + the per-company MenuPermissions toggle.
  { key: "multi_link",         label: "ربط متعدد",                  section: "ربط متعدد" },
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
  // Sister-companies module is LOCKED BY DEFAULT (option B): the
  // SuperAdmin must explicitly enable it per company from
  // /admin/menu-permissions. There is no parent billable module — the
  // permission key itself is the on/off switch.
  sister_companies:   null,
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
  safety:             null,            // OSH module — toggle is the on/off switch, no separate billable module
  safety_dashboard:   null,            // OSH per-screen key — rolls up to the `safety` toggle
  safety_risk:        null,            // OSH per-screen key — rolls up to the `safety` toggle
  safety_incidents:   null,            // OSH per-screen key — rolls up to the `safety` toggle
  maintenance:        "maintenance",
  hotel:              "hotel",
  hospital:           "hospital",
  crm:                "crm",
  fixed_assets:       "fixed_assets",
  security_events:    "security",
  seo_dashboard:      null,           // SuperAdmin tool, not billed per-company
  online_store:       null,           // included for now (no separate billable module)
  field_service:      "field_service", // standalone billable module — Field Service Management (FSM)
  ai_tools:           null,           // SuperAdmin tool, not billed per-company
  voice_assistant:    null,           // admin-only settings screen, no separate billable module
  sessions:           null,           // sessions group, no separate billable module
  company_maintenance: null,          // data import/export, no separate billable module
  installments:       "installments",
  user_tracking:      null,
  zatca:              "zatca",
  multi_link:         null,           // SuperAdmin / partner tool, not billed per-company
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

// ─────────────────────────────────────────────────────────────────────
// PER-SCREEN VISIBILITY REGISTRY (MODULE_GROUPS)
//
// One source of truth describing, for every high-level module, the exact
// list of individual sidebar screens (and their reports) that live under
// it. Drives THREE surfaces identically:
//   • /admin/menu-permissions  — expandable per-screen toggles
//   • /register                — the "مخصص" custom picker + size tiers
//   • SuperAdmin add-company    — the same reusable picker
//
// VISIBILITY MODEL
//   Each screen is gated by a dedicated key `nav:<path>` stored in
//   companies.menuPermissions. ABSENT ⇒ visible (default-on, so existing
//   tenants are never affected). Setting it to `false` hides ONLY that
//   sidebar link — the module-level API gate is untouched (no 403 risk).
//   See companyAllowsScreen() in lib/companyModuleGate.ts and the check in
//   Layout.tsx navItemAllowed.
//
//   `moduleKeys` = the high-level menuPermissions keys that turn the whole
//   module on/off (the coarse toggles already shown on menu-permissions).
//   Enabling a module = setting those keys true; the per-screen nav:* keys
//   then refine which screens appear inside the enabled module.
// ─────────────────────────────────────────────────────────────────────
export interface ModuleScreen {
  path:  string;   // route (matches NavItem `href`) — visibility key is `nav:<path>`
  label: string;   // Arabic screen label
  report?: boolean; // true → grouped under the module's "التقارير" subsection in pickers
}
export interface ModuleGroupDef {
  key:        string;        // group key (mirrors GROUP_PERMISSION_KEYS in Layout.tsx)
  label:      string;        // Arabic module label
  emoji:      string;        // cosmetic chip glyph
  moduleKeys: string[];      // high-level menuPermissions keys gating the whole module
  screens:    ModuleScreen[];
}

// Helper to build the `nav:<path>` visibility key from a route.
export const screenKey = (path: string): string => `nav:${path}`;

export const MODULE_GROUPS: ModuleGroupDef[] = [
  {
    key: "dashboard", label: "لوحة التحكم والإعدادات", emoji: "🏠", moduleKeys: ["dashboard"],
    screens: [
      { path: "/org/regions", label: "المناطق الجغرافية" },
      { path: "/org/branches", label: "الفروع" },
      { path: "/general-settings", label: "الإعدادات العامة" },
      { path: "/users", label: "المستخدمون" },
      { path: "/settings/currencies", label: "العملات والتحويل" },
      { path: "/settings/accounting-mappings", label: "ربط القيود المحاسبية" },
      { path: "/settings/sequences", label: "مسلسل الحركات" },
      { path: "/vat-declaration", label: "الإقرار الضريبي" },
      { path: "/seo", label: "إدارة SEO" },
      { path: "/admin/audit-log", label: "سجل النشاط" },
    ],
  },
  {
    key: "zatca", label: "ربط ZATCA", emoji: "🧾", moduleKeys: ["zatca"],
    screens: [
      { path: "/zatca", label: "ربط ZATCA" },
      { path: "/invoices", label: "الفواتير" },
      { path: "/zatca-bridge", label: "جسر ZATCA" },
      { path: "/zatca-report", label: "تقرير فواتير ZATCA", report: true },
    ],
  },
  {
    key: "sales", label: "العملاء والمبيعات", emoji: "🛒", moduleKeys: ["sales_module", "sales_reports"],
    screens: [
      { path: "/customers", label: "العملاء" },
      { path: "/sales/customer-groups", label: "مجموعات العملاء" },
      { path: "/sales/reps", label: "مناديب المبيعات" },
      { path: "/sales/reps/commissions", label: "عمولات المناديب" },
      { path: "/sales/quotations", label: "عروض الأسعار" },
      { path: "/sales/orders", label: "أوامر البيع" },
      { path: "/sales/invoices", label: "فواتير المبيعات" },
      { path: "/sales/returns", label: "مرتجعات المبيعات" },
      { path: "/sales/customer-credit-notes", label: "إشعارات دائنة - عملاء" },
      { path: "/sales/customer-debit-notes", label: "إشعارات مدينة - عملاء" },
      { path: "/sales/settlements", label: "تحصيل العملاء" },
      { path: "/sales/reports", label: "كل التقارير", report: true },
      { path: "/sales/reports/customer-statement", label: "كشف حساب عميل", report: true },
      { path: "/sales/reports/customer-statement-detailed", label: "كشف حساب عميل تفصيلي", report: true },
      { path: "/sales/reports/customer-balances", label: "أرصدة العملاء", report: true },
      { path: "/sales/reports/aging", label: "تحليل أعمار الديون", report: true },
      { path: "/sales/reports/sales-by-customer", label: "المبيعات حسب العميل", report: true },
      { path: "/sales/reports/sales-by-item", label: "المبيعات حسب الصنف", report: true },
      { path: "/sales/reports/sales-by-period", label: "المبيعات اليومية / الشهرية", report: true },
      { path: "/sales/reports/top-customers", label: "أفضل العملاء", report: true },
      { path: "/sales/reports/returns", label: "مرتجعات المبيعات", report: true },
      { path: "/sales/reports/payment-mix", label: "تقرير طرق الدفع (AI)", report: true },
      { path: "/sales/reports/daily-detailed", label: "تقرير مبيعات تفصيلي يومي", report: true },
      { path: "/sales/reports/profitability", label: "تقرير الربحية", report: true },
    ],
  },
  {
    key: "purchasing", label: "الموردون والمشتريات", emoji: "🚚", moduleKeys: ["purchases_module", "purchases_reports"],
    screens: [
      { path: "/suppliers", label: "الموردون" },
      { path: "/purchasing/supplier-groups", label: "مجموعات الموردين" },
      { path: "/purchasing/lc", label: "الاعتمادات المستندية" },
      { path: "/purchasing/lc-expense-entry", label: "إدخال مصروف اعتماد" },
      { path: "/purchasing/orders", label: "أوامر الشراء" },
      { path: "/purchasing/invoices", label: "فواتير المشتريات" },
      { path: "/purchasing/returns", label: "مرتجعات المشتريات" },
      { path: "/purchasing/supplier-credit-notes", label: "إشعارات دائنة - موردين" },
      { path: "/purchasing/supplier-debit-notes", label: "إشعارات مدينة - موردين" },
      { path: "/purchasing/settlements", label: "تسوية الموردين" },
      { path: "/purchasing/reports", label: "كل التقارير", report: true },
      { path: "/purchasing/reports/supplier-statement", label: "كشف حساب مورد", report: true },
      { path: "/purchasing/reports/supplier-statement-detailed", label: "كشف حساب مورد تفصيلي", report: true },
      { path: "/purchasing/reports/supplier-balances", label: "أرصدة الموردين", report: true },
      { path: "/purchasing/reports/aging", label: "أعمار الذمم الدائنة", report: true },
      { path: "/purchasing/reports/purchases-by-supplier", label: "المشتريات حسب المورد", report: true },
      { path: "/purchasing/reports/purchases-by-item", label: "المشتريات حسب الصنف", report: true },
      { path: "/purchasing/reports/purchases-by-period", label: "المشتريات اليومية / الشهرية", report: true },
      { path: "/purchasing/reports/top-suppliers", label: "أكبر الموردين", report: true },
      { path: "/purchasing/reports/returns", label: "مرتجعات المشتريات", report: true },
      { path: "/purchasing/reports/lc-statement", label: "كشف حساب الاعتمادات", report: true },
    ],
  },
  {
    key: "inventory", label: "المخازن", emoji: "📦", moduleKeys: ["inventory_mobile", "inventory_reports"],
    screens: [
      { path: "/inventory", label: "لوحة المخازن" },
      { path: "/inventory/items", label: "الأصناف" },
      { path: "/inventory/item-groups", label: "مجموعات الأصناف" },
      { path: "/inventory/units", label: "وحدات القياس" },
      { path: "/inventory/warehouses", label: "المخازن" },
      { path: "/inventory/warehouse-groups", label: "مجموعات المخازن" },
      { path: "/inventory/goods-receipts", label: "إذن استلام البضاعة" },
      { path: "/inventory/goods-deliveries", label: "إذن تسليم البضاعة" },
      { path: "/inventory/transfers", label: "التحويل بين المخازن" },
      { path: "/inventory/adjustments", label: "التسوية المخزنية" },
      { path: "/inventory/counts", label: "الجرد المخزني" },
      { path: "/inventory/offers", label: "العروض" },
      { path: "/inventory/reports", label: "كل التقارير", report: true },
      { path: "/inventory/reports/stock-balance", label: "رصيد المخزون", report: true },
      { path: "/inventory/reports/stock-ledger", label: "دفتر حركة المخزون", report: true },
      { path: "/inventory/reports/item-card", label: "كارت الصنف", report: true },
      { path: "/inventory/reports/low-stock", label: "الأصناف منخفضة المخزون", report: true },
      { path: "/inventory/reports/valuation", label: "تقييم المخزون حسب المخزن", report: true },
      { path: "/inventory/reports/slow-moving", label: "الأصناف الراكدة", report: true },
      { path: "/inventory/reports/free-quantities", label: "الكميات المجانية", report: true },
      { path: "/inventory/reports/item-sales-valuation", label: "مبيعات الأصناف (بالتكلفة/البيع)", report: true },
      { path: "/inventory/reports/stocktake", label: "جرد المخازن", report: true },
    ],
  },
  {
    key: "sister", label: "معاملات الشركات الشقيقة", emoji: "🤝", moduleKeys: ["sister_companies"],
    screens: [
      { path: "/inventory/sister-companies", label: "الشركات الشقيقة" },
      { path: "/inventory/sister-transfers", label: "تحويلات الشركات الشقيقة" },
      { path: "/inventory/sister-returns", label: "مرتجعات الشركات الشقيقة" },
      { path: "/inventory/sister-settlements", label: "تسويات الشركات الشقيقة" },
      { path: "/inventory/sister-statements", label: "كشف حساب الشركات الشقيقة", report: true },
    ],
  },
  {
    key: "cash", label: "النقد والبنوك", emoji: "💵", moduleKeys: ["cash_module", "cash_reports"],
    screens: [
      { path: "/cash/boxes", label: "الخزن" },
      { path: "/cash/banks", label: "البنوك" },
      { path: "/cash/receipt-vouchers", label: "سندات القبض" },
      { path: "/cash/payment-vouchers", label: "سندات الصرف" },
      { path: "/cash/transfers", label: "التحويلات" },
      { path: "/cash/financial-transactions", label: "المعاملات المالية" },
      { path: "/cash/reports", label: "كل التقارير", report: true },
      { path: "/cash/reports/cash-balances", label: "أرصدة الخزائن", report: true },
      { path: "/cash/reports/bank-balances", label: "أرصدة البنوك", report: true },
      { path: "/cash/reports/cash-box-statement", label: "كشف حساب خزينة", report: true },
      { path: "/cash/reports/bank-statement", label: "كشف حساب بنكي", report: true },
      { path: "/cash/reports/daily-summary", label: "الحركة اليومية للنقدية", report: true },
      { path: "/cash/reports/receipts", label: "تقرير سندات القبض", report: true },
      { path: "/cash/reports/payments", label: "تقرير سندات الصرف", report: true },
      { path: "/cash/reports/transfers", label: "تقرير التحويلات", report: true },
    ],
  },
  {
    key: "accounting", label: "الحسابات العامة", emoji: "📒", moduleKeys: ["accounts", "accounting_reports", "accounting_maintenance"],
    screens: [
      { path: "/accounting/accounts", label: "شجرة الحسابات" },
      { path: "/accounting/cost-centers", label: "مراكز التكلفة" },
      { path: "/accounting/taxes", label: "إدارة الضرائب" },
      { path: "/accounting/fiscal-periods", label: "الفترات المالية" },
      { path: "/accounting/journals", label: "القيود المحاسبية" },
      { path: "/accounting/posting-center", label: "مركز الترحيل" },
      { path: "/accounting/maintenance", label: "الصيانة المحاسبية وميزان المراجعة" },
      { path: "/accounting/standards", label: "المعايير المحاسبية" },
      { path: "/accounting/reports/account-statement", label: "كشف حساب", report: true },
      { path: "/accounting/reports/trial-balance", label: "ميزان المراجعة بالمجاميع", report: true },
      { path: "/accounting/reports/balance-sheet", label: "المركز المالي", report: true },
      { path: "/accounting/reports/income-statement", label: "قائمة الدخل", report: true },
      { path: "/accounting/reports/bank-cash-flow", label: "تحليل حركة البنك (دفترياً)", report: true },
      { path: "/accounting/reports/forecast-income-statement", label: "قائمة دخل تقديرية (AI)", report: true },
      { path: "/accounting/reports/tax-declaration", label: "الإقرار الضريبي", report: true },
    ],
  },
  {
    key: "pos", label: "نقاط البيع", emoji: "🧮", moduleKeys: ["pos"],
    screens: [
      { path: "/pos-monitoring", label: "مراقبة نقاط البيع" },
      { path: "/pos-operations", label: "عمليات نقاط البيع" },
      { path: "/pos-terminals", label: "محطات البيع" },
      { path: "/pos-settings", label: "إعدادات نقاط البيع" },
    ],
  },
  {
    key: "hr", label: "شؤون الموظفين", emoji: "👥", moduleKeys: ["hr_module"],
    screens: [
      { path: "/hr/employees", label: "الموظفون" },
      { path: "/hr/contracts", label: "العقود" },
      { path: "/hr/attendance", label: "الحضور والانصراف" },
      { path: "/hr/face", label: "الحضور بالذكاء الاصطناعي" },
      { path: "/hr/loans", label: "السلف والعُهد" },
      { path: "/hr/payroll", label: "مسيرات الرواتب" },
      { path: "/hr/end-of-service", label: "مكافأة نهاية الخدمة" },
      { path: "/hr/calculators", label: "حاسبات الموارد البشرية" },
      { path: "/hr/reports", label: "التقارير", report: true },
      { path: "/hr/settings", label: "إعدادات حسابات الموارد البشرية" },
    ],
  },
  {
    key: "field_service", label: "الخدمة الميدانية (FSM)", emoji: "📲", moduleKeys: ["field_service"],
    screens: [
      { path: "/hr/field", label: "لوحة الخدمة الميدانية" },
      { path: "/hr/field/check-in", label: "تسجيل زيارة من الجوال" },
      { path: "/hr/field/locations", label: "سجل المواقع الميدانية" },
      { path: "/hr/field/plans", label: "خطط الزيارات اليومية" },
      { path: "/hr/field/tickets", label: "تذاكر الخدمة" },
      { path: "/hr/field/tracking", label: "التتبع المباشر" },
      { path: "/hr/field/reports", label: "التقارير ومؤشرات الأداء", report: true },
    ],
  },
  {
    key: "production", label: "الإنتاج والتصنيع", emoji: "🏭", moduleKeys: ["production"],
    screens: [
      { path: "/production/guide", label: "دليل تشغيل التصنيع" },
      { path: "/production", label: "لوحة الإنتاج" },
      { path: "/production/settings", label: "إعدادات التصنيع" },
      { path: "/production/work-centers", label: "مراكز العمل" },
      { path: "/production/resources", label: "الماكينات والموارد" },
      { path: "/production/shifts", label: "تقويم الورديات" },
      { path: "/production/quality-templates", label: "قوالب فحص الجودة" },
      { path: "/production/routings", label: "قوالب مراحل الإنتاج" },
      { path: "/production/bom-templates", label: "قوالب المكوّنات (BOM)" },
      { path: "/production/mrp", label: "تخطيط احتياجات المواد (MRP)" },
      { path: "/production/orders", label: "أوامر الإنتاج" },
      { path: "/production/approvals", label: "اعتماد أوامر الإنتاج" },
      { path: "/production/board", label: "خط الإنتاج المرئي" },
      { path: "/production/quality", label: "مراقبة الجودة" },
      { path: "/production/downtime", label: "التوقّفات وكفاءة المعدات (OEE)" },
      { path: "/production/kpis", label: "لوحة مؤشرات التصنيع" },
      { path: "/production/cost-rollup", label: "تكلفة المنتج المعيارية" },
      { path: "/production/quality-report", label: "تقرير مراقبة الجودة", report: true },
      { path: "/production/waste-report", label: "تقرير الهالك والتالف", report: true },
      { path: "/production/operator-performance", label: "أداء المشغّلين", report: true },
      { path: "/production/my-performance", label: "أدائي", report: true },
      { path: "/production/traceability", label: "تتبّع التشغيلات" },
    ],
  },
  {
    key: "safety", label: "السلامة والصحة المهنية", emoji: "🦺", moduleKeys: ["safety"],
    screens: [
      { path: "/safety", label: "لوحة السلامة" },
      { path: "/safety/risk-assessments", label: "سجل المخاطر" },
      { path: "/safety/incidents", label: "الحوادث والإصابات" },
    ],
  },
  {
    key: "contracting", label: "إدارة المقاولات", emoji: "🏗️", moduleKeys: ["contracting"],
    screens: [
      { path: "/contracting", label: "لوحة المقاولات" },
      { path: "/contracting/projects", label: "المشاريع" },
      { path: "/contracting/contractors", label: "المقاولون والموردون" },
      { path: "/contracting/bills", label: "المستخلصات" },
    ],
  },
  {
    key: "maintenance", label: "إدارة الصيانة", emoji: "🔧", moduleKeys: ["maintenance"],
    screens: [
      { path: "/maintenance", label: "لوحة الصيانة" },
      { path: "/maintenance/assets", label: "الأصول والمعدات" },
      { path: "/maintenance/technicians", label: "الفنيون" },
      { path: "/maintenance/orders", label: "أوامر الصيانة" },
    ],
  },
  {
    key: "installments", label: "البيع بالتقسيط الذكي", emoji: "💳", moduleKeys: ["installments"],
    screens: [
      { path: "/installments", label: "لوحة التقسيط" },
      { path: "/installments/contracts", label: "عقود التقسيط" },
      { path: "/installments/collection", label: "شاشة التحصيل" },
      { path: "/installments/reports", label: "تقارير التقسيط", report: true },
      { path: "/installments/settings", label: "إعدادات التقسيط" },
    ],
  },
  {
    key: "hotel", label: "إدارة الفنادق الذكية", emoji: "🏨", moduleKeys: ["hotel"],
    screens: [
      { path: "/hotel", label: "لوحة الفنادق" },
      { path: "/hotel/hotels", label: "الفنادق" },
      { path: "/hotel/rooms", label: "الغرف" },
      { path: "/hotel/guests", label: "النزلاء" },
      { path: "/hotel/bookings", label: "الحجوزات" },
      { path: "/hotel/housekeeping", label: "خدمة الغرف" },
      { path: "/hotel/ai", label: "الذكاء الاصطناعي للفنادق" },
    ],
  },
  {
    key: "hospital", label: "إدارة المستشفيات والمستوصفات", emoji: "🏥", moduleKeys: ["hospital"],
    screens: [
      { path: "/hospital", label: "لوحة المستشفيات" },
      { path: "/hospital/hospitals", label: "المنشآت الطبية" },
      { path: "/hospital/doctors", label: "الأطباء" },
      { path: "/hospital/patients", label: "المرضى" },
      { path: "/hospital/appointments", label: "المواعيد والكشوفات" },
      { path: "/hospital/invoices", label: "الفواتير الطبية" },
      { path: "/hospital/ai", label: "الذكاء الاصطناعي و NPHIES" },
    ],
  },
  {
    key: "crm", label: "إدارة علاقات العملاء (CRM)", emoji: "📇", moduleKeys: ["crm"],
    screens: [
      { path: "/crm", label: "لوحة CRM" },
      { path: "/crm/leads", label: "العملاء المحتملون" },
      { path: "/crm/opportunities", label: "الفرص" },
      { path: "/crm/activities", label: "الأنشطة" },
      { path: "/crm/campaigns", label: "الحملات" },
      { path: "/crm/pipeline", label: "خط الأنابيب" },
      { path: "/crm/ai", label: "الذكاء الاصطناعي للـ CRM" },
    ],
  },
  {
    key: "fixedAssets", label: "الأصول الثابتة", emoji: "🏢", moduleKeys: ["fixed_assets"],
    screens: [
      { path: "/fixed-assets", label: "لوحة الأصول الثابتة" },
      { path: "/fixed-assets/assets", label: "سجل الأصول" },
      { path: "/fixed-assets/categories", label: "فئات الأصول" },
      { path: "/fixed-assets/maintenance", label: "صيانة الأصول" },
      { path: "/fixed-assets/transfers", label: "نقل الأصول" },
      { path: "/fixed-assets/depreciation", label: "الإهلاك" },
      { path: "/fixed-assets/disposals", label: "التخلص (بيع/تخريد)" },
      { path: "/fixed-assets/reports", label: "تقارير الأصول", report: true },
      { path: "/fixed-assets/ai", label: "الذكاء الاصطناعي للأصول" },
    ],
  },
  {
    key: "onlineStore", label: "المتجر الإلكتروني", emoji: "🛍️", moduleKeys: ["online_store"],
    screens: [
      { path: "/online-store", label: "المتجر الإلكتروني" },
    ],
  },
  {
    key: "security", label: "الأمن والمراقبة", emoji: "🛡️", moduleKeys: ["security_events"],
    screens: [
      { path: "/security/events", label: "الأحداث الأمنية" },
      { path: "/security/devices", label: "أجهزة التسجيل" },
      { path: "/security/cameras", label: "الكاميرات" },
      { path: "/security/live", label: "العرض المباشر" },
      { path: "/security/ai", label: "الذكاء الأمني" },
      { path: "/security/reports", label: "تقارير الأمن", report: true },
    ],
  },
  {
    key: "liveMonitoring", label: "المراقبة المباشرة (تتبع المواقع)", emoji: "📍", moduleKeys: ["user_tracking"],
    screens: [
      { path: "/user-tracking", label: "تتبع المواقع" },
      { path: "/user-tracking/live", label: "التتبع المباشر" },
      { path: "/user-tracking/attendance", label: "تقرير الحضور والانصراف", report: true },
      { path: "/user-tracking/movement-report", label: "تقرير تحركات المستخدمين", report: true },
    ],
  },
];

export const MODULE_GROUP_BY_KEY: Record<string, ModuleGroupDef> = Object.fromEntries(
  MODULE_GROUPS.map(g => [g.key, g]),
);

// ─── Size presets (باقات جاهزة) — صغيرة / متوسطة / كبيرة ─────────────────
// Each tier is a set of high-level module keys. صغيرة/متوسطة are explicit;
// كبيرة = every module key found in MODULE_GROUPS (the full suite).
const TIER_SMALL_MODULES = [
  "dashboard", "sales_module", "sales_reports",
  "inventory_mobile", "inventory_reports", "pos",
  "accounts", "accounting_reports", "cash_module", "cash_reports",
  "reports", "zatca",
];
const TIER_MEDIUM_MODULES = [
  ...TIER_SMALL_MODULES,
  "purchases_module", "purchases_reports",
  "fixed_assets", "accounting_maintenance", "hr_module",
];
const TIER_LARGE_MODULES = Array.from(
  new Set([
    ...TIER_MEDIUM_MODULES,
    ...MODULE_GROUPS.flatMap(g => g.moduleKeys),
    "production", "contracting", "sister_companies",
    "crm", "maintenance", "online_store", "installments",
    "hotel", "hospital", "security_events", "safety", "user_tracking",
  ]),
);

export interface SizeTier {
  key: "small" | "medium" | "large";
  label: string;
  desc: string;
  emoji: string;
  moduleKeys: string[];
}
export const SIZE_TIERS: SizeTier[] = [
  { key: "small",  label: "شركة صغيرة",  emoji: "🌱", desc: "مبيعات + مخازن أساسي + نقاط بيع + حسابات أساسية + الإقرار الضريبي وزاتكا", moduleKeys: TIER_SMALL_MODULES },
  { key: "medium", label: "شركة متوسطة", emoji: "🌿", desc: "كل ما سبق + المشتريات الكاملة + التقارير + الأصول الثابتة + الصيانة المحاسبية + شؤون الموظفين", moduleKeys: TIER_MEDIUM_MODULES },
  { key: "large",  label: "شركة كبيرة",  emoji: "🌳", desc: "كل الوحدات: إنتاج + مقاولات + شركات شقيقة + موارد بشرية + متجر إلكتروني + CRM والمزيد", moduleKeys: TIER_LARGE_MODULES },
];

// Theme tokens reused by both /admin/menu-permissions and
// /admin/industries so the section chips look identical across pages.
export const SECTION_THEME: Record<string, { bg: string; text: string; border: string }> = {
  "رئيسي":               { bg: "bg-blue-50",     text: "text-blue-700",     border: "border-blue-200" },
  "الأعمال":              { bg: "bg-emerald-50",  text: "text-emerald-700",  border: "border-emerald-200" },
  "المخازن":              { bg: "bg-amber-50",    text: "text-amber-700",    border: "border-amber-200" },
  "المبيعات":             { bg: "bg-cyan-50",     text: "text-cyan-700",     border: "border-cyan-200" },
  "المشتريات":            { bg: "bg-orange-50",   text: "text-orange-700",   border: "border-orange-200" },
  "نقاط البيع":           { bg: "bg-teal-50",     text: "text-teal-700",     border: "border-teal-200" },
  "الحسابات العامة":       { bg: "bg-indigo-50",   text: "text-indigo-700",   border: "border-indigo-200" },
  "صيانة الحسابات":        { bg: "bg-violet-50",   text: "text-violet-700",   border: "border-violet-200" },
  "شؤون الموظفين":         { bg: "bg-rose-50",     text: "text-rose-700",     border: "border-rose-200" },
  "إدارة المقاولات":       { bg: "bg-yellow-50",   text: "text-yellow-700",   border: "border-yellow-200" },
  "الإنتاج والتصنيع":      { bg: "bg-stone-50",    text: "text-stone-700",    border: "border-stone-200" },
  "السلامة والصحة المهنية": { bg: "bg-red-50",      text: "text-red-700",      border: "border-red-200" },
  "إدارة الصيانة":         { bg: "bg-orange-50",   text: "text-orange-700",   border: "border-orange-200" },
  "إدارة الفنادق":         { bg: "bg-teal-50",     text: "text-teal-700",     border: "border-teal-200" },
  "إدارة المستشفيات":      { bg: "bg-sky-50",      text: "text-sky-700",      border: "border-sky-200" },
  "إدارة CRM":             { bg: "bg-pink-50",     text: "text-pink-700",     border: "border-pink-200" },
  "الأصول الثابتة":        { bg: "bg-emerald-50",  text: "text-emerald-700",  border: "border-emerald-200" },
  "الأمن والمراقبة":       { bg: "bg-slate-50",    text: "text-slate-700",    border: "border-slate-200" },
  "تحليلات SEO":           { bg: "bg-fuchsia-50",  text: "text-fuchsia-700",  border: "border-fuchsia-200" },
  "أدوات الذكاء الاصطناعي": { bg: "bg-violet-50",   text: "text-violet-700",   border: "border-violet-200" },
  "إعدادات المساعد الصوتي": { bg: "bg-violet-50",   text: "text-violet-700",   border: "border-violet-200" },
  "الجلسات":              { bg: "bg-indigo-50",   text: "text-indigo-700",   border: "border-indigo-200" },
  "صيانة الشركات":         { bg: "bg-slate-50",    text: "text-slate-700",    border: "border-slate-200" },
  "النظام":               { bg: "bg-purple-50",   text: "text-purple-700",   border: "border-purple-200" },
  "الاتصال الداخلي":       { bg: "bg-green-50",    text: "text-green-700",    border: "border-green-200" },
  "البيع بالتقسيط":         { bg: "bg-lime-50",     text: "text-lime-700",     border: "border-lime-200" },
  "الخدمة الميدانية":       { bg: "bg-blue-50",     text: "text-blue-700",     border: "border-blue-200" },
  "تتبع المواقع":          { bg: "bg-indigo-50",   text: "text-indigo-700",   border: "border-indigo-200" },
  "ربط متعدد":              { bg: "bg-cyan-50",     text: "text-cyan-700",     border: "border-cyan-200" },
  "معاملات الشركات الشقيقة": { bg: "bg-amber-50",    text: "text-amber-700",    border: "border-amber-200" },
};
