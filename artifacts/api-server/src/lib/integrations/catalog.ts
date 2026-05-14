/**
 * Integration provider catalog — single source of truth for the
 * Marketplace UI and the per-connection wizard.
 *
 * `status: "coming_soon"` providers render a card but are NOT connectable
 * (the create-connection route rejects them). This lets us ship the
 * Marketplace UI in one go while the adapter implementations land
 * provider-by-provider.
 */
export type ProviderId =
  | "odoo" | "sap" | "dynamics" | "quickbooks" | "zoho"
  | "foodics" | "salla" | "zid" | "shopify"
  | "generic_rest" | "inbound_webhook";

export interface CredentialField {
  key: string;
  labelAr: string;
  type: "text" | "password" | "url";
  required: boolean;
  placeholder?: string;
  helperAr?: string;
}

export interface ProviderInfo {
  id: ProviderId;
  nameAr: string;
  nameEn: string;
  category: "erp" | "ecommerce" | "pos" | "accounting" | "custom";
  taglineAr: string;
  status: "stable" | "beta" | "coming_soon";
  capabilities: { pull: boolean; push: boolean };
  // Brand color used for the card accent — keep CSS-safe (no `#` prefix).
  accent: string;
  // Inline SVG logo data — small, brand-recognizable, no external requests.
  logoSvg: string;
  credentialFields: CredentialField[];
}

const odoo: ProviderInfo = {
  id: "odoo", nameAr: "أودو", nameEn: "Odoo",
  category: "erp", taglineAr: "نظام محاسبة شامل مفتوح المصدر",
  status: "stable", capabilities: { pull: true, push: true },
  accent: "8b5cf6",
  logoSvg: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="32" r="14" fill="#8b5cf6"/><circle cx="44" cy="32" r="10" fill="#a78bfa"/></svg>`,
  credentialFields: [
    { key: "baseUrl", labelAr: "رابط الخادم (URL)", type: "url", required: true, placeholder: "https://mycompany.odoo.com" },
    { key: "database", labelAr: "اسم قاعدة البيانات", type: "text", required: true, placeholder: "mycompany" },
    { key: "username", labelAr: "اسم المستخدم", type: "text", required: true },
    { key: "apiKey",   labelAr: "API Key (من Settings > Users > API Keys)", type: "password", required: true,
      helperAr: "أنشئ مفتاح API من حساب Odoo: Preferences → Account Security → New API Key" },
  ],
};

const salla: ProviderInfo = {
  id: "salla", nameAr: "سلة", nameEn: "Salla",
  category: "ecommerce", taglineAr: "منصة المتاجر الإلكترونية الأولى في السعودية",
  status: "stable", capabilities: { pull: true, push: true },
  accent: "10b981",
  logoSvg: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><path d="M12 24h40l-6 28H18z" fill="#10b981"/><circle cx="22" cy="56" r="3" fill="#065f46"/><circle cx="42" cy="56" r="3" fill="#065f46"/></svg>`,
  credentialFields: [
    { key: "accessToken", labelAr: "Access Token", type: "password", required: true,
      helperAr: "من لوحة تاجر سلة: التطبيقات → التطبيقات الخاصة → إنشاء تطبيق" },
    { key: "storeId", labelAr: "معرّف المتجر (Store ID)", type: "text", required: false, placeholder: "اختياري" },
  ],
};

const genericRest: ProviderInfo = {
  id: "generic_rest", nameAr: "REST API عام", nameEn: "Generic REST",
  category: "custom", taglineAr: "ربط أي نظام داخلي عبر JSON قياسي",
  status: "stable", capabilities: { pull: true, push: true },
  accent: "0ea5e9",
  logoSvg: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="20" width="48" height="24" rx="4" fill="#0ea5e9"/><text x="32" y="38" font-family="monospace" font-size="12" fill="white" text-anchor="middle" font-weight="bold">REST</text></svg>`,
  credentialFields: [
    { key: "baseUrl",   labelAr: "Base URL", type: "url", required: true, placeholder: "https://api.example.com/v1" },
    { key: "authType",  labelAr: "نوع المصادقة (bearer / basic / apikey)", type: "text", required: true, placeholder: "bearer" },
    { key: "secret",    labelAr: "السر/التوكن", type: "password", required: true },
    { key: "invoicesPath", labelAr: "مسار جلب الفواتير (GET)", type: "text", required: false, placeholder: "/invoices?status=posted&since={lastSync}" },
  ],
};

function comingSoon(id: ProviderId, nameAr: string, nameEn: string,
                    category: ProviderInfo["category"], taglineAr: string,
                    accent: string, logoSvg: string): ProviderInfo {
  return {
    id, nameAr, nameEn, category, taglineAr, status: "coming_soon",
    capabilities: { pull: false, push: false }, accent, logoSvg,
    credentialFields: [],
  };
}

export const PROVIDERS: ProviderInfo[] = [
  odoo, salla, genericRest,
  comingSoon("sap",       "SAP Business One", "SAP B1",            "erp",        "حلول ERP للمؤسسات الكبيرة", "0f4fa8",
    `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="20" width="48" height="24" rx="2" fill="#0f4fa8"/><text x="32" y="38" font-family="Arial" font-size="14" fill="white" text-anchor="middle" font-weight="bold">SAP</text></svg>`),
  comingSoon("dynamics",  "Microsoft Dynamics 365", "Dynamics 365", "erp",       "ERP وCRM من مايكروسوفت", "0078d4",
    `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="20" height="20" fill="#f25022"/><rect x="34" y="10" width="20" height="20" fill="#7fba00"/><rect x="10" y="34" width="20" height="20" fill="#00a4ef"/><rect x="34" y="34" width="20" height="20" fill="#ffb900"/></svg>`),
  comingSoon("quickbooks","QuickBooks Online", "QuickBooks",        "accounting", "الأشهر للمحاسبة في أمريكا الشمالية", "2ca01c",
    `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><circle cx="32" cy="32" r="24" fill="#2ca01c"/><text x="32" y="40" font-family="Arial" font-size="20" fill="white" text-anchor="middle" font-weight="bold">qb</text></svg>`),
  comingSoon("zoho",      "Zoho Books", "Zoho",                     "accounting", "حلول الأعمال السحابية", "e91e26",
    `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><text x="32" y="42" font-family="Arial" font-size="22" fill="#e91e26" text-anchor="middle" font-weight="bold">Zoho</text></svg>`),
  comingSoon("foodics",   "فودكس", "Foodics",                       "pos",        "أشهر POS للمطاعم في السعودية", "f97316",
    `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><circle cx="32" cy="32" r="22" fill="#f97316"/><text x="32" y="40" font-family="Arial" font-size="14" fill="white" text-anchor="middle" font-weight="bold">F</text></svg>`),
  comingSoon("zid",       "زد", "Zid",                              "ecommerce",  "منصة متاجر إلكترونية سعودية", "5a3eff",
    `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect x="12" y="12" width="40" height="40" rx="8" fill="#5a3eff"/><text x="32" y="42" font-family="Arial" font-size="20" fill="white" text-anchor="middle" font-weight="bold">Z</text></svg>`),
  comingSoon("shopify",   "Shopify", "Shopify",                     "ecommerce",  "منصة التجارة الإلكترونية العالمية", "95bf47",
    `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><path d="M32 8l16 8v32l-16 8-16-8V16z" fill="#95bf47"/><text x="32" y="40" font-family="Arial" font-size="20" fill="white" text-anchor="middle" font-weight="bold">S</text></svg>`),
  comingSoon("inbound_webhook", "Webhook وارد", "Inbound Webhook",  "custom",     "استقبال الفواتير عبر Push من نظامك", "64748b",
    `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="32" r="6" fill="#64748b"/><path d="M26 32h20M40 26l6 6-6 6" stroke="#64748b" stroke-width="3" fill="none"/></svg>`),
];

export function findProvider(id: string): ProviderInfo | null {
  return PROVIDERS.find(p => p.id === id) ?? null;
}
