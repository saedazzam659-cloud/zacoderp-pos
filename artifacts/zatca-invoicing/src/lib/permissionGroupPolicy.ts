export type GroupPermissionUser = {
  role?: string;
  permissions?: Record<string, { view?: boolean } | undefined>;
} | null | undefined;

/**
 * Canonical company menu keys for each top-level sidebar group. These are the
 * keys controlled by SuperAdmin → Menu Permissions. Do not mix historical
 * per-screen/user keys into this map: an explicit false on the canonical
 * product toggle must remain authoritative.
 */
export const GROUP_COMPANY_MENU_KEYS = {
  dashboard: ["dashboard"],
  zatca: ["zatca"],
  inventory: ["inventory_mobile", "inventory_reports"],
  sister: ["sister_companies"],
  office: ["office"],
  deliveryDocs: ["delivery_receipt_docs"],
  trainingRoom: ["training_room"],
  sales: ["sales_module", "sales_reports"],
  purchasing: ["purchases_module", "purchases_reports"],
  cash: ["cash_module", "cash_reports"],
  accounting: ["accounts", "accounting_reports", "accounting_maintenance"],
  hr: ["hr_module"],
  production: ["production"],
  safety: ["safety"],
  contracting: ["contracting"],
  maintenance: ["maintenance"],
  installments: ["installments"],
  hotel: ["hotel"],
  hospital: ["hospital"],
  crm: ["crm"],
  fixedAssets: ["fixed_assets"],
  pos: ["pos"],
  security: ["security_events"],
  aiTools: ["ai_tools"],
  voiceAssistant: ["voice_assistant"],
  sessions: ["sessions"],
  chat: ["chat"],
  companyMaintenance: ["company_maintenance"],
  extensions: ["extensions_platform"],
  multiLink: ["multi_link"],
  liveMonitoring: ["user_tracking"],
} as const;

export type PermissionGroupKey = keyof typeof GROUP_COMPANY_MENU_KEYS;

/**
 * Granular users.permissions keys that can render content inside each sidebar
 * group. The Record type forces every company group to have a matching user
 * policy entry.
 */
export const GROUP_USER_PERMISSION_KEYS: Record<PermissionGroupKey, readonly string[]> = {
  dashboard: [
    "dashboard", "dashboard_kpis", "dashboard_charts", "dashboard_alerts",
    "dashboard_recent_invoices", "regions", "branches", "general_settings",
    "company_profile", "users", "currencies", "sequences", "vat_declaration",
    "seo_dashboard",
  ],
  zatca: ["zatca_setup", "zatca_bridge", "zatca_report"],
  inventory: [
    "items", "brands", "warehouses", "stock_transfers", "stock_adjustments",
    "stock_counts", "inventory_reports",
  ],
  sister: ["sister_companies"],
  office: ["office"],
  deliveryDocs: ["delivery_receipt_docs"],
  trainingRoom: ["training_room"],
  sales: [
    "customers", "sales_invoices", "sales_quotations", "sales_returns",
    "sales_settlements", "sales_reps", "sales_reports", "customer_notes",
    "zatca_bridge", "zatca_report", "receipt_vouchers",
  ],
  purchasing: [
    "suppliers", "purchase_invoices", "purchase_returns",
    "supplier_settlements", "supplier_notes", "payment_vouchers",
  ],
  cash: ["cash_boxes", "bank_accounts", "receipt_vouchers", "payment_vouchers"],
  accounting: [
    "accounts", "journal_entries", "accounting_reports",
    "accounting_maintenance",
  ],
  hr: [
    "hr_employees", "hr_attendance", "hr_face_attendance", "hr_loans",
    "hr_payroll", "hr_eos", "hr_calculators", "hr_settings",
  ],
  production: ["production"],
  safety: ["safety_dashboard", "safety_risk", "safety_incidents"],
  contracting: ["contracting"],
  maintenance: ["maintenance"],
  installments: ["installments"],
  hotel: ["hotel"],
  hospital: ["hospital"],
  crm: ["crm"],
  fixedAssets: ["fixed_assets"],
  pos: ["pos"],
  security: ["security_events"],
  aiTools: ["ai_tools"],
  voiceAssistant: ["voiceAssistant"],
  sessions: ["sessions"],
  chat: ["chat"],
  companyMaintenance: ["data_io"],
  extensions: ["extensions"],
  multiLink: ["multi_link"],
  liveMonitoring: ["user_tracking"],
};

export function companyAllowsPermissionGroup(
  menuPermissions: Record<string, boolean>,
  group: PermissionGroupKey,
): boolean {
  return GROUP_COMPANY_MENU_KEYS[group].some(
    key => menuPermissions[key] === true,
  );
}

/**
 * Per-user half of sidebar group visibility.
 *
 * Company product toggles are evaluated separately because their keys are not
 * stored in users.permissions. A purchasing company toggle such as
 * `purchases_module` must therefore never be intersected with granular user
 * keys such as `suppliers` or `purchase_invoices`.
 */
export function userAllowsPermissionGroup(
  user: GroupPermissionUser,
  userPermissionKeys: readonly string[],
  isSuperAdmin = false,
): boolean {
  if (isSuperAdmin) return true;
  if (user?.role === "admin") return true;

  const userPerms = user?.permissions ?? {};
  // Preserve the legacy behavior only for users that have no RBAC map at all.
  if (Object.keys(userPerms).length === 0) return true;

  return userPermissionKeys.some(key => userPerms[key]?.view === true);
}