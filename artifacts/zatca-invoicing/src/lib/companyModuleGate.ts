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
  // POS
  pos: "pos",
  // Inventory
  items: "inventory_reports",
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
  security_events: "security_events",
  // Tax / general invoices
  vat_declaration: "reports",
};

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
  const raw = user?.company?.menuPermissions;
  if (raw == null) return true;
  let parsed: Record<string, boolean>;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return true;
  }
  if (!parsed || typeof parsed !== "object") return true;
  return parsed[gateKey] !== false;
}
