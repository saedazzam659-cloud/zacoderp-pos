// Server-side canonical catalog of granular menu-permission keys.
//
// Mirror of the client catalog in
// `artifacts/zatca-invoicing/src/lib/menuItems.ts` (MENU_ITEMS keys).
// Kept here as a hardcoded set — not imported across the artifact
// boundary — because:
//   1. The api-server has no compile-time dependency on the web
//      artifact (and shouldn't, per pnpm-workspace rules), and
//   2. We want a deliberate, reviewed list rather than blindly trusting
//      whatever the UI ships.
//
// USAGE
//   - `routes/adminIndustries.ts` rejects any non-canonical key on
//     create/update so a typo can never reach the DB.
//   - `routes/auth.ts` filters the OR-merge from industries through
//     this set so even a previously persisted bad key can't leak into
//     a freshly-registered company's `menu_permissions` JSONB.
//   - `index.ts` migration uses it as the universe of "real" keys.
//
// HOW TO ADD A NEW KEY
//   1. Add it to MENU_ITEMS in lib/menuItems.ts (web artifact).
//   2. Add it here. The two MUST stay in sync; an end-to-end test
//      asserts shape compatibility on registration.
export const CANONICAL_MENU_PERMISSION_KEYS: ReadonlySet<string> = new Set([
  // ── رئيسي ──
  "dashboard",
  // ── الأعمال ──
  "invoices",
  "customers",
  "suppliers",
  "reports",
  // ── المخازن ──
  "inventory_mobile",
  "inventory_reports",
  // Sister Companies — locked by default; SuperAdmin enables per tenant.
  "sister_companies",
  // ── المبيعات ──
  "sales_module",
  "sales_reports",
  // ── المشتريات ──
  "purchases_module",
  "purchases_reports",
  // ── نقاط البيع ──
  "pos",
  // ── المحاسبة ──
  "cash_module",
  "cash_reports",
  "accounts",
  "accounting_reports",
  "accounting_maintenance",
  // ── شؤون الموظفين ──
  "hr_module",
  // ── إدارة المقاولات ──
  "contracting",
  // ── الإنتاج والتصنيع ──
  "production",
  // ── إدارة الصيانة ──
  // Backend gate key for the Maintenance ERP (assets, technicians, work
  // orders, spare parts). Mirrors the `maintenance` entry in the web
  // artifact's MENU_ITEMS catalog. Was previously missing here, which
  // meant the registration explicit-deny fill skipped it and the
  // sidebar Proxy defaulted the missing key to "allowed" — so freshly
  // registered tenants saw the maintenance group even when the chosen
  // industry preset never granted it.
  "maintenance",
  // ── إدارة الفنادق الذكية ──
  "hotel",
  // ── إدارة المستشفيات والمستوصفات ──
  "hospital",
  "crm",
  "fixed_assets",
  // ── الأمن والمراقبة ──
  "security_events",
  // ── تحليلات SEO (SuperAdmin only — no parent billable module) ──
  "seo_dashboard",
  // ── المتجر الإلكتروني ──
  "online_store",
  // ── أدوات الذكاء الاصطناعي (SuperAdmin only — no parent billable module) ──
  "ai_tools",
  // ── الاتصال الداخلي ──
  "chat",
  // ── البيع بالتقسيط الذكي ──
  "installments",
  // ── الخدمة الميدانية ──
  // Standalone billable module (Field Service Management). Gates the
  // entire /hr/field surface — locations, visits, plans, tickets,
  // tracking, reports — independently of `hr_module`.
  "field_service",
  // ── تتبع مواقع المستخدمين (Check-in/Check-out + dashboard + alerts) ──
  "user_tracking",
  // ── النظام ──
  "zatca",
  // ── ربط متعدد ──
  // Multi-tenant external invoice gateway (onboarding 3rd-party
  // companies, invoice intake, ZATCA dispatch, CSID management,
  // reports). Single permission key gates the entire sidebar group.
  "multi_link",
]);

// Convenience helper: drop unknown keys, dedupe, preserve order.
export function filterCanonicalKeys(input: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== "string") continue;
    const k = v.trim();
    if (!k || seen.has(k)) continue;
    if (!CANONICAL_MENU_PERMISSION_KEYS.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}
