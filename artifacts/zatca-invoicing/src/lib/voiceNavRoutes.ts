/**
 * Voice navigation registry — every screen the user can reach by voice.
 *
 * The voice assistant sends this list to the LLM so it can map a phrase
 * like "افتح فاتورة مبيعات جديدة" or "go to inventory" to a concrete
 * route path. We keep AR + EN labels here (not in i18n keys) so the LLM
 * has the literal strings the user is likely to say, in either language,
 * without having to look anything up.
 *
 * Keep this file free of React imports — it's pure data.
 */

export type VoiceRoute = {
  /** Stable identifier sent back by the LLM in `navigate` commands. */
  id: string;
  /** wouter pathname to navigate to. */
  path: string;
  /** Arabic label as the user would say it. */
  ar: string;
  /** English label as the user would say it. */
  en: string;
  /** Other names the user might say (synonyms / abbreviations). */
  aliases?: string[];
  /** Permission key to filter the list by — same scheme as Layout sidebar. */
  permKey?: string;
  /** If true, only superadmins see/use this route. */
  superadminOnly?: boolean;
  /** If true, only admins (or superadmins) see/use this route. */
  adminOnly?: boolean;
};

export const VOICE_ROUTES: VoiceRoute[] = [
  // ── Dashboard / common ──────────────────────────────────────────────
  { id: "dashboard",        path: "/",              ar: "لوحة التحكم",        en: "Dashboard", aliases: ["الرئيسية", "الصفحة الرئيسية", "home"] },
  { id: "notifications",    path: "/notifications", ar: "التنبيهات",          en: "Notifications" },

  // ── Sales ───────────────────────────────────────────────────────────
  { id: "sales.invoices",         path: "/sales/invoices",       ar: "فواتير المبيعات",        en: "Sales Invoices",        aliases: ["المبيعات", "فواتير البيع"], permKey: "sales_invoices" },
  { id: "sales.invoices.new",     path: "/sales/invoices/new",   ar: "فاتورة مبيعات جديدة",   en: "New Sales Invoice",     aliases: ["فاتورة جديدة", "إنشاء فاتورة مبيعات", "بيع جديد"], permKey: "sales_invoices" },
  { id: "sales.quotations",       path: "/sales/quotations",     ar: "عروض الأسعار",            en: "Sales Quotations",      permKey: "sales_quotations" },
  { id: "sales.quotations.new",   path: "/sales/quotations/new", ar: "عرض سعر جديد",            en: "New Quotation",         permKey: "sales_quotations" },
  { id: "sales.orders",           path: "/sales/orders",         ar: "أوامر البيع",             en: "Sales Orders",          permKey: "sales_invoices" },
  { id: "sales.orders.new",       path: "/sales/orders/new",     ar: "أمر بيع جديد",            en: "New Sales Order",       permKey: "sales_invoices" },
  { id: "sales.returns",          path: "/sales/returns",        ar: "مرتجعات المبيعات",        en: "Sales Returns",         permKey: "sales_returns" },
  { id: "sales.settlements",      path: "/sales/settlements",    ar: "تسويات العملاء",          en: "Customer Settlements",  permKey: "sales_settlements" },
  { id: "sales.reports",          path: "/sales/reports",        ar: "تقارير المبيعات",         en: "Sales Reports",         permKey: "sales_reports" },
  { id: "sales.reps",             path: "/sales/reps",           ar: "مندوبو المبيعات",         en: "Sales Reps",            permKey: "sales_reps" },
  { id: "customers",              path: "/customers",            ar: "العملاء",                  en: "Customers",             permKey: "customers" },
  { id: "customers.new",          path: "/customers/new",        ar: "عميل جديد",                en: "New Customer",          permKey: "customers" },

  // ── Purchasing ──────────────────────────────────────────────────────
  { id: "purchasing.invoices",      path: "/purchasing/invoices",       ar: "فواتير المشتريات",     en: "Purchase Invoices",     permKey: "purchase_invoices" },
  { id: "purchasing.invoices.new",  path: "/purchasing/invoices/new",   ar: "فاتورة مشتريات جديدة", en: "New Purchase Invoice",  permKey: "purchase_invoices" },
  { id: "purchasing.orders",        path: "/purchasing/orders",         ar: "أوامر الشراء",          en: "Purchase Orders",       permKey: "purchase_invoices" },
  { id: "purchasing.orders.new",    path: "/purchasing/orders/new",     ar: "أمر شراء جديد",         en: "New Purchase Order",    permKey: "purchase_invoices" },
  { id: "purchasing.returns",       path: "/purchasing/returns",        ar: "مرتجعات المشتريات",     en: "Purchase Returns",      permKey: "purchase_returns" },
  { id: "purchasing.lc",            path: "/purchasing/lc",             ar: "الاعتمادات المستندية",  en: "Letters of Credit",     permKey: "purchase_invoices" },
  { id: "purchasing.settlements",   path: "/purchasing/settlements",    ar: "تسويات الموردين",       en: "Supplier Settlements",  permKey: "supplier_settlements" },
  { id: "purchasing.reports",       path: "/purchasing/reports",        ar: "تقارير المشتريات",      en: "Purchase Reports",      permKey: "purchase_invoices" },
  { id: "suppliers",                path: "/suppliers",                 ar: "الموردون",               en: "Suppliers",             permKey: "suppliers" },
  { id: "suppliers.new",            path: "/suppliers/new",             ar: "مورد جديد",              en: "New Supplier",          permKey: "suppliers" },
  { id: "purchasing.supplierGroups", path: "/purchasing/supplier-groups", ar: "مجموعات الموردين",   en: "Supplier Groups",       permKey: "suppliers" },

  // ── Cash & banks ────────────────────────────────────────────────────
  { id: "cash.boxes",            path: "/cash/boxes",            ar: "الصناديق النقدية",     en: "Cash Boxes",         permKey: "cash_boxes" },
  { id: "cash.banks",            path: "/cash/banks",            ar: "الحسابات البنكية",     en: "Bank Accounts",      permKey: "bank_accounts" },
  { id: "cash.receiptVouchers",  path: "/cash/receipt-vouchers", ar: "سندات القبض",          en: "Receipt Vouchers",   permKey: "receipt_vouchers" },
  { id: "cash.paymentVouchers",  path: "/cash/payment-vouchers", ar: "سندات الصرف",          en: "Payment Vouchers",   permKey: "payment_vouchers" },
  { id: "cash.transfers",        path: "/cash/transfers",        ar: "التحويلات النقدية",    en: "Cash Transfers",     permKey: "cash_boxes" },
  { id: "cash.reports",          path: "/cash/reports",          ar: "تقارير النقدية",       en: "Cash Reports",       permKey: "cash_boxes" },

  // ── Inventory ───────────────────────────────────────────────────────
  { id: "inventory.dashboard",    path: "/inventory",                  ar: "لوحة المخزون",          en: "Inventory Dashboard",  permKey: "items" },
  { id: "inventory.items",        path: "/inventory/items",            ar: "الأصناف",                en: "Items",                permKey: "items" },
  { id: "inventory.itemGroups",   path: "/inventory/item-groups",      ar: "مجموعات الأصناف",       en: "Item Groups",          permKey: "items" },
  { id: "inventory.units",        path: "/inventory/units",            ar: "وحدات القياس",          en: "Units",                permKey: "items" },
  { id: "inventory.warehouses",   path: "/inventory/warehouses",       ar: "المستودعات",             en: "Warehouses",           permKey: "warehouses" },
  { id: "inventory.warehouseGroups", path: "/inventory/warehouse-groups", ar: "مجموعات المستودعات", en: "Warehouse Groups",     permKey: "warehouses" },
  { id: "inventory.transfers",    path: "/inventory/transfers",        ar: "تحويلات المخزون",       en: "Stock Transfers",      permKey: "stock_transfers" },
  { id: "inventory.adjustments",  path: "/inventory/adjustments",      ar: "تسويات المخزون",        en: "Stock Adjustments",    permKey: "stock_adjustments" },
  { id: "inventory.counts",       path: "/inventory/counts",           ar: "جرد المخزون",            en: "Stock Counts",         permKey: "stock_counts" },
  { id: "inventory.offers",       path: "/inventory/offers",           ar: "العروض والتخفيضات",     en: "Offers",               permKey: "items" },
  { id: "inventory.ledger",       path: "/inventory/ledger",           ar: "حركة المخزون",           en: "Stock Ledger",         permKey: "items" },
  { id: "inventory.balance",      path: "/inventory/balance",          ar: "أرصدة المخزون",          en: "Stock Balance",        permKey: "items" },
  { id: "inventory.reports",      path: "/inventory/reports",          ar: "تقارير المخزون",         en: "Inventory Reports",    permKey: "items" },

  // ── Accounting ──────────────────────────────────────────────────────
  { id: "accounting.chart",          path: "/accounting/accounts",       ar: "دليل الحسابات",        en: "Chart of Accounts",   permKey: "accounts" },
  { id: "accounting.costCenters",    path: "/accounting/cost-centers",   ar: "مراكز التكلفة",         en: "Cost Centers",        permKey: "accounts" },
  { id: "accounting.fiscalPeriods",  path: "/accounting/fiscal-periods", ar: "الفترات المالية",       en: "Fiscal Periods",      permKey: "accounts" },
  { id: "accounting.journals",       path: "/accounting/journals",       ar: "القيود اليومية",        en: "Journal Entries",     permKey: "journal_entries" },
  { id: "accounting.journals.new",   path: "/accounting/journals/new",   ar: "قيد جديد",               en: "New Journal Entry",   permKey: "journal_entries" },
  { id: "accounting.reports.trial",  path: "/accounting/reports/trial-balance",     ar: "ميزان المراجعة",  en: "Trial Balance",     permKey: "accounting_reports" },
  { id: "accounting.reports.bs",     path: "/accounting/reports/balance-sheet",     ar: "الميزانية العمومية", en: "Balance Sheet",   permKey: "accounting_reports" },
  { id: "accounting.reports.is",     path: "/accounting/reports/income-statement",  ar: "قائمة الدخل",      en: "Income Statement", permKey: "accounting_reports" },
  { id: "accounting.reports.acc",    path: "/accounting/reports/account-statement", ar: "كشف حساب",         en: "Account Statement", permKey: "accounting_reports" },

  // ── HR ──────────────────────────────────────────────────────────────
  { id: "hr.employees",        path: "/hr/employees",       ar: "الموظفون",         en: "Employees",      permKey: "hr_employees" },
  { id: "hr.contracts",        path: "/hr/contracts",       ar: "عقود الموظفين",     en: "Contracts",      permKey: "hr_employees" },
  { id: "hr.attendance",       path: "/hr/attendance",      ar: "الحضور والانصراف",   en: "Attendance",     permKey: "hr_attendance" },
  { id: "hr.face",             path: "/hr/face",            ar: "الحضور بالذكاء الاصطناعي",  en: "AI Face Attendance",      permKey: "hr_face_attendance" },
  { id: "hr.face.kiosk",       path: "/hr/face/kiosk",      ar: "شاشة الحضور بالوجه",        en: "Face Attendance Kiosk",   permKey: "hr_face_attendance" },
  { id: "hr.face.enrollment",  path: "/hr/face/enrollment", ar: "تسجيل بصمة الوجه",          en: "Face Enrollment",         permKey: "hr_face_attendance" },
  { id: "hr.face.cameras",     path: "/hr/face/cameras",    ar: "كاميرات الحضور",            en: "Attendance Cameras",      permKey: "hr_face_attendance" },
  { id: "hr.face.logs",        path: "/hr/face/logs",       ar: "سجل التعرف على الوجه",     en: "Face Recognition Logs",   permKey: "hr_face_attendance" },
  { id: "hr.face.settings",    path: "/hr/face/settings",   ar: "إعدادات الحضور بالذكاء الاصطناعي", en: "AI Attendance Settings",  permKey: "hr_face_attendance" },
  { id: "hr.loans",            path: "/hr/loans",           ar: "السلف والقروض",      en: "Loans",          permKey: "hr_loans" },
  { id: "hr.payroll",          path: "/hr/payroll",         ar: "الرواتب",            en: "Payroll",        permKey: "hr_payroll" },
  { id: "hr.eos",              path: "/hr/end-of-service",  ar: "مكافأة نهاية الخدمة", en: "End of Service", permKey: "hr_eos" },
  { id: "hr.calculators",      path: "/hr/calculators",     ar: "حاسبات الموارد البشرية", en: "HR Calculators", permKey: "hr_calculators" },
  { id: "hr.settings",         path: "/hr/settings",        ar: "إعدادات الموارد البشرية", en: "HR Settings", permKey: "hr_settings" },
  { id: "hr.reports",          path: "/hr/reports",         ar: "تقارير الموارد البشرية", en: "HR Reports",     permKey: "hr_employees" },

  // ── Production ──────────────────────────────────────────────────────
  { id: "production.dashboard",  path: "/production",            ar: "لوحة الإنتاج",       en: "Production Dashboard", permKey: "production" },
  { id: "production.orders",     path: "/production/orders",     ar: "أوامر الإنتاج",       en: "Production Orders",    permKey: "production" },
  { id: "production.orders.new", path: "/production/orders/new", ar: "أمر إنتاج جديد",     en: "New Production Order", permKey: "production" },
  { id: "production.resources",  path: "/production/resources",  ar: "موارد الإنتاج",       en: "Production Resources", permKey: "production" },

  // ── ZATCA / e-invoicing ────────────────────────────────────────────
  { id: "zatca.setup",        path: "/zatca",            ar: "إعداد زاتكا",            en: "ZATCA Setup",         permKey: "zatca_setup" },
  { id: "zatca.bridge",       path: "/zatca-bridge",     ar: "جسر زاتكا",              en: "ZATCA Bridge",        permKey: "zatca_bridge" },
  { id: "zatca.report",       path: "/zatca-report",     ar: "تقرير زاتكا",            en: "ZATCA Report",        permKey: "zatca_report" },
  { id: "zatca.vat",          path: "/vat-declaration",  ar: "إقرار ضريبة القيمة المضافة", en: "VAT Declaration", permKey: "vat_declaration" },

  // ── POS ────────────────────────────────────────────────────────────
  { id: "pos.monitoring", path: "/pos-monitoring", ar: "مراقبة نقاط البيع",  en: "POS Monitoring", permKey: "pos" },
  { id: "pos.terminals",  path: "/pos-terminals",  ar: "أجهزة نقاط البيع",    en: "POS Terminals",  permKey: "pos" },
  { id: "pos.settings",   path: "/pos-settings",   ar: "إعدادات نقاط البيع",  en: "POS Settings",   permKey: "pos" },

  // ── Org & settings ─────────────────────────────────────────────────
  { id: "org.regions",   path: "/org/regions",   ar: "المناطق",     en: "Regions",   permKey: "regions" },
  { id: "org.branches",  path: "/org/branches",  ar: "الفروع",       en: "Branches",  permKey: "branches" },
  { id: "settings.general",   path: "/general-settings",            ar: "الإعدادات العامة",       en: "General Settings",       permKey: "general_settings" },
  { id: "settings.users",     path: "/users",                       ar: "المستخدمون",              en: "Users",                  permKey: "users", adminOnly: true },
  { id: "settings.currencies", path: "/settings/currencies",        ar: "العملات",                 en: "Currencies",             permKey: "currencies" },
  { id: "settings.accountingMappings", path: "/settings/accounting-mappings", ar: "ربط الحسابات", en: "Accounting Mappings", permKey: "general_settings" },
  { id: "settings.dataIo",    path: "/settings/data-io",            ar: "استيراد وتصدير البيانات", en: "Data Import / Export",  permKey: "data_io" },
  { id: "settings.sequences", path: "/settings/sequences",          ar: "إدارة التسلسلات",         en: "Document Sequences",     permKey: "sequences", adminOnly: true },

  // ── Super-admin ─────────────────────────────────────────────────────
  { id: "admin.requests",      path: "/admin/requests",         ar: "طلبات التسجيل",      en: "Registration Requests", superadminOnly: true },
  { id: "admin.companies",     path: "/companies",              ar: "الشركات",             en: "Companies",             superadminOnly: true },
  { id: "admin.subscriptions", path: "/admin/subscriptions",    ar: "الاشتراكات",          en: "Subscriptions",         superadminOnly: true },
  { id: "admin.plans",         path: "/admin/plans",            ar: "الخطط",                en: "Plans",                 superadminOnly: true },
  { id: "admin.modules",       path: "/admin/modules",          ar: "الوحدات",              en: "Modules",               superadminOnly: true },
  { id: "admin.menuPermissions", path: "/admin/menu-permissions", ar: "صلاحيات القوائم",  en: "Menu Permissions",      superadminOnly: true },
  { id: "admin.licenses",      path: "/admin/licenses",         ar: "التراخيص",            en: "Licenses",              superadminOnly: true },
  { id: "admin.security",      path: "/admin/security",         ar: "مركز الأمان",         en: "Security Center",       superadminOnly: true },
  { id: "admin.reports",       path: "/admin/reports",          ar: "تقارير المسؤول",      en: "Admin Reports",         superadminOnly: true },
  { id: "admin.backups",       path: "/admin/backups",          ar: "النسخ الاحتياطي",     en: "Backup Operations",     superadminOnly: true },
  { id: "admin.support",       path: "/admin/support",          ar: "بريد الدعم الفني",    en: "Support Inbox",         superadminOnly: true },
  { id: "admin.auditLog",      path: "/admin/audit-log",        ar: "سجل التدقيق",         en: "Audit Log",             adminOnly: true },
];

/** Filter the route list by the currently logged-in user's role/permissions. */
export function visibleVoiceRoutes(opts: {
  isSuperAdmin: boolean;
  isAdmin: boolean;
  hasPerm: (key: string) => boolean;
}): VoiceRoute[] {
  return VOICE_ROUTES.filter((r) => {
    if (r.superadminOnly && !opts.isSuperAdmin) return false;
    if (r.adminOnly && !opts.isAdmin && !opts.isSuperAdmin) return false;
    if (r.permKey && !opts.isSuperAdmin) {
      if (!opts.hasPerm(r.permKey)) return false;
    }
    return true;
  });
}
