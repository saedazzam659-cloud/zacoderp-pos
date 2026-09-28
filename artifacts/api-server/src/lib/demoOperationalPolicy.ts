// Explicit operational allowlist. Never infer privilege from a role, username,
// client flag, or an unknown module. Administrative/settings keys stay untouched.
export const DEMO_OPERATIONAL_MODULES = [
  "customers", "sales_reps", "sales_quotations", "sales_invoices",
  "sales_invoice_overdraft", "sales_returns", "sales_settlements", "sales_reports",
  "customer_notes", "suppliers", "purchase_invoices", "purchase_returns",
  "supplier_settlements", "supplier_notes", "receipt_vouchers", "payment_vouchers", "cash_boxes", "bank_accounts",
  "journal_entries", "accounting_reports", "pos", "items", "brands", "warehouses",
  "stock_transfers", "stock_adjustments", "stock_counts", "inventory_reports",
  "item_usage_override", "hr_employees", "hr_attendance", "hr_loans", "hr_payroll",
  "hr_eos", "hr_calculators", "contracting", "production", "simple_manufacturing",
  "safety", "safety_dashboard", "safety_risk", "safety_incidents", "maintenance",
  "installments", "hotel", "hospital", "crm", "fixed_assets", "vat_declaration",
  "field_service_locations", "field_service_visits", "field_service_plans",
  "field_service_tickets", "field_service_tracking", "field_service_reports",
  "delivery_receipt_docs", "hr_face_attendance", "contracting_guarantee_override",
  "dashboard", "dashboard_kpis", "dashboard_charts", "dashboard_alerts", "dashboard_recent_invoices",
] as const;

export function canManageDemoOperationalSetting(
  actor: { id: number; role: string; companyId: number | null } | undefined,
  target: { id: number; role: string; companyId: number | null; isDemoShadow: boolean; demoDeviceIsolation: boolean } | undefined,
  value: unknown,
): boolean {
  return typeof value === "boolean" && !!actor && !!target &&
    (actor.role === "superadmin" || actor.role === "admin") &&
    actor.id !== target.id && target.companyId != null &&
    (actor.role === "superadmin" || actor.companyId === target.companyId) &&
    target.role !== "superadmin" && !target.isDemoShadow && target.demoDeviceIsolation === true;
}

const operationalRoots = new Set([
  "customers", "suppliers", "invoices", "dashboard", "reports", "inventory",
  "journal-entries", "trial-balances", "accounting-reports", "purchasing",
  "goods-receipts", "goods-deliveries", "sales", "posting-center", "sales-analytics",
  "purchases-analytics", "cash-boxes", "bank-accounts", "receipt-vouchers",
  "payment-vouchers", "cash-transfers", "cash-analytics", "bank-reconciliation",
  "production", "simple-manufacturing", "safety", "adjustments", "employees",
  "hr-core", "attendance-plus", "hr", "pos-sessions", "pos", "pos-restaurant",
  "sales-reps", "offers", "contracting", "contracting-accounting", "maintenance", "installments", "hotel",
  "hospital", "crm", "fixed-assets", "delivery-receipt-documents", "pos-operations", "account-notes",
]);

/** Only known operational API trees may consume the overlay. Mixed routers
 * have administrative/setup subroutes too: those use original rights. */
export function isDemoOperationalRequest(url: string): boolean {
  let path: string;
  try { path = decodeURIComponent(url.split("?")[0]).toLowerCase(); }
  catch { return false; }
  const parts = path.split("/").filter(Boolean);
  if (parts.shift() !== "api" || !operationalRoots.has(parts[0])) return false;
  return !parts.some(part =>
    /(?:^|[-_])(settings?|config(?:uration)?|setup|mappings?|permissions?|subscriptions?|users|admin|security|seed|reset|purge|backup|restore|kiosk|cameras|tokens|devices|licenses)(?:$|[-_])/.test(part));
}

export function effectiveDemoPermissions(
  original: Record<string, any> | null | undefined,
  verified: boolean,
) {
  if (!verified) return original;
  const result = { ...original };
  for (const key of DEMO_OPERATIONAL_MODULES) {
    result[key] = { ...result[key], view: true, create: true, edit: true,
      delete: true, post: true, unpost: true, export: true, review: true,
      approve: true, pay: true, cancel: true, overrun: true, correct: true };
  }
  return result;
}