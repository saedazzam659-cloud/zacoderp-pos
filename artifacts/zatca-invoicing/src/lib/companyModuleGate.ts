// ─────────────────────────────────────────────────────────────────────────
// Company-level module gate
//
// Maps the granular per-module permKey used by Layout.tsx, usePermission and
// the backend's `requirePermission(module, action)` calls to the high-level
// module key shown on the SuperAdmin → MenuPermissions screen
// (companies.menuPermissions JSON).
//
// SOURCE OF TRUTH for the frontend. The same map is duplicated server-side
// in artifacts/api-server/src/middleware/permissions.ts — keep both in sync
// (and keep the high-level keys in sync with MENU_ITEMS in
// artifacts/zatca-invoicing/src/pages/MenuPermissions.tsx).
//
// When a permKey is NOT in this map, no company-level gate applies — only
// the per-user permission map gates the screen/action. Use this for system
// settings (users, branches, sequences, …) that are not bound to a billable
// product module.
// ─────────────────────────────────────────────────────────────────────────

export const COMPANY_MODULE_GATE: Record<string, string> = {
  // Sales / Customers
  customers: "sales_module",
  sales_reps: "sales_module",
  sales_quotations: "sales_module",
  sales_invoices: "sales_module",
  sales_returns: "sales_module",
  sales_settlements: "sales_module",
  sales_reports: "sales_reports",
  // Purchasing / Suppliers
  suppliers: "purchases_module",
  purchase_invoices: "purchases_module",
  purchase_returns: "purchases_module",
  supplier_settlements: "purchases_module",
  // Cash & Banks
  cash_boxes: "cash_module",
  bank_accounts: "cash_module",
  receipt_vouchers: "cash_module",
  payment_vouchers: "cash_module",
  // Accounting / Ledger
  accounts: "accounts",
  journal_entries: "accounts",
  accounting_reports: "accounting_reports",
  accounting_maintenance: "accounting_maintenance",
  // POS
  pos: "pos",
  // Inventory
  items: "inventory_reports",
  // Brands (العلامات التجارية) — own per-user permission key, rolls up to the
  // existing inventory company toggle. Mirror of the backend COMPANY_MODULE_GATE.
  brands: "inventory_reports",
  warehouses: "inventory_reports",
  stock_transfers: "inventory_reports",
  stock_adjustments: "inventory_reports",
  stock_counts: "inventory_reports",
  // HR
  hr_employees: "hr_module",
  hr_attendance: "hr_module",
  hr_face_attendance: "hr_module",
  hr_loans: "hr_module",
  hr_payroll: "hr_module",
  hr_eos: "hr_module",
  hr_calculators: "hr_module",
  hr_settings: "hr_module",
  // ZATCA
  zatca_setup: "zatca",
  zatca_bridge: "zatca",
  zatca_report: "zatca",
  // Operations modules
  contracting: "contracting",
  production: "production",
  // Occupational Safety & Health (OSH / ISO 45001) — standalone gate. Mirror
  // of the backend COMPANY_MODULE_GATE; keep both maps in sync. The three
  // per-screen permission keys all roll up to the single `safety` company
  // module toggle.
  safety: "safety",
  safety_dashboard: "safety",
  safety_risk: "safety",
  safety_incidents: "safety",
  maintenance: "maintenance",
  hotel: "hotel",
  hospital: "hospital",
  fixed_assets: "fixed_assets",
  security_events: "security_events",
  // SEO Manager — site analytics dashboard granted per company.
  seo_dashboard: "seo_dashboard",
  // AI Tools & spun-out groups — AI Reports stays under the `ai_tools`
  // company toggle; the voice assistant, sessions, internal chat, and data
  // import/export screens each have their own top-level company toggle now
  // (voice_assistant / sessions / chat / company_maintenance). Disabling a
  // toggle hides its sidebar group and 403s any backend access to its gated
  // modules. Keep in sync with the backend COMPANY_MODULE_GATE.
  data_io: "company_maintenance",
  voiceAssistant: "voice_assistant",
  sessions: "sessions",
  chat: "chat",
  ai_reports: "ai_tools",
  // Tax / general invoices
  vat_declaration: "reports",
  // Field Service Management — standalone billable module. SuperAdmin
  // toggles `field_service` per company; all FSM sub-permissions roll
  // up to it so disabling the toggle hides the entire module + 403s
  // every /api/hr/field/* call regardless of per-user grants.
  field_service_locations: "field_service",
  field_service_visits:    "field_service",
  field_service_plans:     "field_service",
  field_service_tickets:   "field_service",
  field_service_tracking:  "field_service",
  field_service_reports:   "field_service",
  // Extension Platform (Phase 0) — additive "outer shell". Default OFF; a
  // company sees the الإضافات group ONLY after SuperAdmin grants the
  // `extensions_platform` toggle. Mirror of the backend COMPANY_MODULE_GATE.
  extensions: "extensions_platform",
  // Zacode Office (أوفيس زاكود) — additive in-browser Word + Excel editor.
  // Default OFF; a company sees/uses the office suite ONLY after SuperAdmin
  // grants the `office` toggle. Single key gates every office route.
  office: "office",
  // Goods Receipt / Delivery documents (مستندات الاستلام والتسليم) — pure
  // archive module linked to invoices. Single key gates the sidebar group +
  // every /api/delivery-receipt-documents/* call. Mirror of the backend
  // COMPANY_MODULE_GATE.
  delivery_receipt_docs: "delivery_receipt_docs",
};

// Modules whose gate is LOCKED by default — an ABSENT key means OFF (the inverse
// of the normal default-on). Keep in sync with permissions.ts (backend) and
// DEFAULT_OFF_KEYS in MenuPermissions.tsx.
const MODULE_GATE_DEFAULT_OFF = new Set<string>(["extensions_platform", "office"]);

// True when the company has NOT explicitly disabled the high-level module
// associated with `permKey`. Mirrors parsePerms semantics in
// MenuPermissions.tsx — missing JSON, missing key, or unparseable JSON all
// default to "allowed" so legacy companies without menuPermissions are not
// locked out.
//
// Pass the auth user object (must have .company.menuPermissions populated by
// /api/auth/me).
export function companyAllowsModule(user: any, permKey?: string): boolean {
  if (!permKey) return true;
  const gateKey = COMPANY_MODULE_GATE[permKey];
  if (!gateKey) return true;
  const defaultOff = MODULE_GATE_DEFAULT_OFF.has(gateKey);
  const raw = user?.company?.menuPermissions;
  if (raw == null) return !defaultOff;
  let parsed: Record<string, boolean>;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return !defaultOff;
  }
  if (!parsed || typeof parsed !== "object") return !defaultOff;
  return defaultOff ? parsed[gateKey] === true : parsed[gateKey] !== false;
}

// ─────────────────────────────────────────────────────────────────────────
// Per-SCREEN visibility overlay
//
// Independent of the coarse module gate above. A SuperAdmin can hide an
// individual sidebar link for a tenant by setting `nav:<path>` = false in
// companies.menuPermissions. ABSENT ⇒ visible (default-on), so existing
// tenants — who have no `nav:*` keys at all — are completely unaffected.
//
// This ONLY controls sidebar visibility; the backend API gate stays at the
// module level (see COMPANY_MODULE_GATE), so a merely-hidden screen never
// produces a 403. Superadmins bypass this in Layout.tsx (they must still be
// able to manage every screen).
// ─────────────────────────────────────────────────────────────────────────
export const navScreenKey = (path: string): string => `nav:${path}`;

export function companyAllowsScreen(user: any, href?: string): boolean {
  if (!href) return true;
  const raw = user?.company?.menuPermissions;
  if (raw == null) return true;
  let parsed: Record<string, boolean>;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return true;
  }
  if (!parsed || typeof parsed !== "object") return true;
  return parsed[`nav:${href}`] !== false;
}
