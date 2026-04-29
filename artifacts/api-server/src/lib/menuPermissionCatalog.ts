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
  // ── الأمن والمراقبة ──
  "security_events",
  // ── تحليلات SEO (SuperAdmin only — no parent billable module) ──
  "seo_dashboard",
  // ── أدوات الذكاء الاصطناعي (SuperAdmin only — no parent billable module) ──
  "ai_tools",
  // ── النظام ──
  "zatca",
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
