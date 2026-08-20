export type LocalSuperadminScreen = {
  id: string;
  label: string;
  paths: string[];
};

export const LOCAL_SUPERADMIN_SCREENS: LocalSuperadminScreen[] = [
  { id: "dashboard", label: "لوحة المعلومات", paths: ["/"] },
  { id: "enter_company", label: "الدخول إلى شركة", paths: ["/admin/enter-company"] },
  { id: "companies", label: "إدارة الشركات", paths: ["/companies"] },
  { id: "registration_requests", label: "طلبات التسجيل", paths: ["/admin/requests"] },
  { id: "trainee_requests", label: "طلبات المتدربين", paths: ["/admin/trainee-requests"] },
  { id: "licenses", label: "التراخيص", paths: ["/admin/licenses"] },
  { id: "pos_devices", label: "أجهزة نقاط البيع", paths: ["/admin/pos-devices"] },
  { id: "offline_licenses", label: "تراخيص دون اتصال", paths: ["/admin/offline-licenses"] },
  { id: "download_codes", label: "رموز التنزيل", paths: ["/admin/download-codes"] },
  { id: "domains", label: "إدارة النطاقات", paths: ["/admin/domains"] },
  { id: "agent_servers", label: "سيرفرات الوكلاء", paths: ["/admin/agent-servers"] },
  { id: "external_databases", label: "قواعد البيانات الخارجية", paths: ["/admin/external-databases"] },
  { id: "email_channels", label: "قنوات البريد", paths: ["/admin/email-channels"] },
  { id: "backups", label: "النسخ الاحتياطي", paths: ["/admin/backups"] },
  { id: "security_center", label: "مركز الأمان", paths: ["/admin/security"] },
  { id: "superadmin_security", label: "أمان Super Admin", paths: ["/admin/security-superadmin"] },
  { id: "reports", label: "تقارير المنصة", paths: ["/admin/reports"] },
  { id: "subscriptions", label: "الاشتراكات", paths: ["/admin/subscriptions"] },
  { id: "resellers", label: "الموزعون", paths: ["/admin/resellers"] },
  { id: "partners", label: "الشركاء", paths: ["/admin/partners"] },
  { id: "dev_cloud", label: "السحابة التطويرية", paths: ["/admin/dev-cloud"] },
  { id: "dev_studio", label: "DevStudio", paths: ["/admin/dev-studio"] },
  { id: "marketplace", label: "سوق الإضافات", paths: ["/admin/marketplace"] },
  { id: "plans", label: "الباقات والخطط", paths: ["/admin/plans"] },
  { id: "modules", label: "الوحدات", paths: ["/admin/modules"] },
  { id: "industries", label: "أنواع الأنشطة", paths: ["/admin/industries"] },
  { id: "company_cloning", label: "نسخ الشركات", paths: ["/admin/company-cloning"] },
  { id: "menu_permissions", label: "صلاحيات القوائم", paths: ["/admin/menu-permissions"] },
  { id: "windows_app_permissions", label: "صلاحيات تطبيق ويندوز", paths: ["/admin/windows-app-permissions"] },
  { id: "gateway_clients", label: "عملاء البوابة", paths: ["/admin/gateway-clients", "/admin/gateway-overview"] },
  { id: "orphan_stock", label: "معالجة المخزون اليتيم", paths: ["/admin/orphan-stock"] },
  { id: "database_stats", label: "إحصاءات قاعدة البيانات", paths: ["/admin/db-stats"] },
  { id: "ai_company_fix", label: "إصلاح الشركات بالذكاء الاصطناعي", paths: ["/admin/ai-fix"] },
  { id: "data_doctor", label: "طبيب البيانات", paths: ["/admin/data-doctor", "/admin/data-copy"] },
  { id: "support_inbox", label: "صندوق الدعم", paths: ["/admin/support"] },
  { id: "support_settings", label: "إعدادات الدعم", paths: ["/admin/support-settings"] },
  { id: "support_call", label: "مكالمة الدعم", paths: ["/admin/support-call"] },
  { id: "seo_dashboard", label: "لوحة SEO", paths: ["/admin/seo"] },
  { id: "seo_ai_studio", label: "استوديو SEO الذكي", paths: ["/admin/seo/ai"] },
  { id: "ai_controls", label: "ضوابط الذكاء الاصطناعي", paths: ["/admin/ai-controls"] },
  { id: "audit_log", label: "سجل التدقيق", paths: ["/admin/audit-log"] },
  { id: "pos_monitoring", label: "مراقبة نقاط البيع", paths: ["/pos-monitoring"] },
  { id: "users", label: "إدارة المستخدمين", paths: ["/users"] },
  { id: "invoice_field_policies", label: "سياسات حقول الفاتورة", paths: ["/admin/invoice-field-policies"] },
];

export const DEFAULT_LOCAL_SUPERADMIN_SCREENS = LOCAL_SUPERADMIN_SCREENS.map(screen => screen.id);

export function isLocalSuperadminScreenAllowed(path: string, selected: string[] | null): boolean {
  if (selected == null) return true;
  const matching = LOCAL_SUPERADMIN_SCREENS
    .flatMap(screen => screen.paths.map(prefix => ({ id: screen.id, prefix })))
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find(({ prefix }) => path === prefix || (prefix !== "/" && path.startsWith(`${prefix}/`)));
  if (matching) return selected.includes(matching.id);
  // A local Super Admin page missed by the catalog must fail closed rather
  // than becoming an accidental bypass. Shared pages such as notifications
  // remain available because they are outside these privileged prefixes.
  if (path.startsWith("/admin/") || path === "/companies" || path.startsWith("/companies/")) return false;
  return true;
}