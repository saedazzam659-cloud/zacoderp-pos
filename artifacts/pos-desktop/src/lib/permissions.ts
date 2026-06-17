// Screen-permission helpers (Task #207).
//
// Two layers:
//   1. Role defaults — hardcoded map below (admin sees all, cashier sees
//      only sales/returns/parked/daily/low_stock/items).
//   2. Per-user overrides — stored in user_permissions_local. An explicit
//      row (can_view=1|0) wins over the role default.
//
// All screens are listed in SCREEN_KEYS for the UserPermissionsAdmin UI.

import { invoke } from "./tauri-shim";

function hasTauri(): boolean {
  return typeof window !== "undefined" &&
    (("__TAURI_INTERNALS__" in window) || ("__TAURI__" in window));
}

export type ScreenKey =
  | "sales" | "returns" | "parked" | "daily"
  | "customers" | "items" | "item_groups" | "uom" | "scale" | "expiry"
  | "stock_import" | "low_stock"
  | "suppliers" | "supplier_groups" | "supplier_settlement" | "supplier_payment"
  | "purchases" | "purchase_orders" | "goods_receipts" | "purchase_returns" | "letters_of_credit"
  | "salespersons" | "customer_collection"
  | "sales_invoices" | "quotations" | "sales_orders" | "sales_returns" | "invoice_import"
  | "report_sales_daily" | "report_sales_by_period" | "report_sales_by_item" | "report_sales_by_customer"
  | "report_sales_daily_detailed" | "report_sales_payment_mix" | "report_sales_returns" | "report_sales_top_customers"
  | "report_purchases_by_supplier" | "report_purchases_by_item" | "report_purchases_by_period"
  | "report_purchases_returns" | "report_top_suppliers"
  | "report_supplier_statement" | "report_supplier_statement_detailed"
  | "report_supplier_balances" | "report_supplier_aging" | "report_lc_statement"
  | "cash_boxes" | "banks" | "financial_tx"
  | "currencies" | "exchange_rates" | "treasury_transfers"
  | "chart_of_accounts" | "journal_entries" | "cost_centers" | "taxes"
  | "posting_center" | "fiscal_periods" | "posting_control" | "pos_invoices"
  | "report_account_statement" | "report_customer_statement" | "report_income_statement"
  | "report_balance_sheet" | "report_trial_balance"
  | "warehouses" | "stocktakes" | "stock_adjustments" | "stock_movements" | "stock_transfers"
  | "item_card" | "stock_valuation"
  | "number_series" | "branches"
  | "user_permissions" | "dashboard" | "updates" | "users" | "settings_guide" | "zatca"
  | "pos_accounts";

export const SCREEN_KEYS: { key: ScreenKey; label: string; icon: string; group: string }[] = [
  { key: "sales", label: "البيع", icon: "🛒", group: "العمليات" },
  { key: "returns", label: "مرتجع المبيعات", icon: "↩️", group: "العمليات" },
  { key: "pos_invoices", label: "فواتير نقطة البيع", icon: "🧾", group: "العمليات" },
  { key: "parked", label: "السلال المعلّقة", icon: "📌", group: "العمليات" },
  { key: "daily", label: "تقرير اليومية", icon: "📊", group: "العمليات" },

  { key: "customers", label: "العملاء", icon: "👥", group: "الملفات" },
  { key: "items", label: "الأصناف", icon: "📦", group: "الملفات" },
  { key: "item_groups", label: "مجموعات الأصناف", icon: "🗂️", group: "الملفات" },
  { key: "uom", label: "وحدات القياس", icon: "📐", group: "الملفات" },
  { key: "stock_import", label: "استيراد الأرصدة", icon: "📥", group: "الملفات" },
  { key: "low_stock", label: "أصناف تحت الحد", icon: "⚠️", group: "الملفات" },
  { key: "expiry", label: "تقرير الصلاحية", icon: "⏳", group: "الملفات" },

  { key: "suppliers", label: "الموردون", icon: "🏭", group: "المشتريات" },
  { key: "supplier_groups", label: "مجموعات الموردين", icon: "🗂️", group: "المشتريات" },
  { key: "purchase_orders", label: "أوامر الشراء", icon: "📋", group: "المشتريات" },
  { key: "goods_receipts", label: "سندات الاستلام", icon: "📥", group: "المشتريات" },
  { key: "purchases", label: "فواتير الشراء", icon: "🧾", group: "المشتريات" },
  { key: "purchase_returns", label: "مرتجع الشراء", icon: "📤", group: "المشتريات" },
  { key: "letters_of_credit", label: "الاعتمادات المستندية", icon: "🌐", group: "المشتريات" },
  { key: "supplier_settlement", label: "تسوية الموردين", icon: "🤝", group: "المشتريات" },
  { key: "supplier_payment", label: "سند صرف للموردين", icon: "💵", group: "المشتريات" },

  { key: "salespersons", label: "مندوبو المبيعات", icon: "🧑‍💼", group: "المبيعات" },
  { key: "customer_collection", label: "تحصيل من العملاء", icon: "💵", group: "المبيعات" },
  { key: "quotations", label: "عروض الأسعار", icon: "📝", group: "المبيعات" },
  { key: "sales_orders", label: "أوامر البيع", icon: "📋", group: "المبيعات" },
  { key: "sales_invoices", label: "فواتير المبيعات", icon: "🧾", group: "المبيعات" },
  { key: "sales_returns", label: "مرتجع المبيعات", icon: "📥", group: "المبيعات" },
  { key: "invoice_import", label: "استيراد الفواتير", icon: "📂", group: "المبيعات" },

  { key: "report_sales_daily", label: "تقرير المبيعات اليومي", icon: "📅", group: "تقارير المبيعات" },
  { key: "report_sales_by_period", label: "المبيعات حسب الفترة", icon: "🗓️", group: "تقارير المبيعات" },
  { key: "report_sales_by_item", label: "المبيعات حسب الصنف", icon: "📦", group: "تقارير المبيعات" },
  { key: "report_sales_by_customer", label: "المبيعات حسب العميل", icon: "👥", group: "تقارير المبيعات" },
  { key: "report_sales_daily_detailed", label: "المبيعات اليومي التفصيلي", icon: "📑", group: "تقارير المبيعات" },
  { key: "report_sales_payment_mix", label: "المبيعات حسب طريقة الدفع", icon: "💳", group: "تقارير المبيعات" },
  { key: "report_sales_returns", label: "مرتجعات المبيعات", icon: "↩️", group: "تقارير المبيعات" },
  { key: "report_sales_top_customers", label: "أفضل العملاء", icon: "🏆", group: "تقارير المبيعات" },

  { key: "report_purchases_by_supplier", label: "المشتريات حسب المورد", icon: "🏭", group: "تقارير المشتريات" },
  { key: "report_purchases_by_item", label: "المشتريات حسب الصنف", icon: "📦", group: "تقارير المشتريات" },
  { key: "report_purchases_by_period", label: "المشتريات حسب الفترة", icon: "🗓️", group: "تقارير المشتريات" },
  { key: "report_purchases_returns", label: "مرتجعات المشتريات", icon: "🔁", group: "تقارير المشتريات" },
  { key: "report_top_suppliers", label: "أكبر الموردين", icon: "🏆", group: "تقارير المشتريات" },
  { key: "report_supplier_statement", label: "كشف حساب مورد", icon: "📄", group: "تقارير المشتريات" },
  { key: "report_supplier_statement_detailed", label: "كشف حساب مورد تفصيلي", icon: "📑", group: "تقارير المشتريات" },
  { key: "report_supplier_balances", label: "أرصدة الموردين", icon: "💼", group: "تقارير المشتريات" },
  { key: "report_supplier_aging", label: "أعمار ديون الموردين", icon: "⏱️", group: "تقارير المشتريات" },
  { key: "report_lc_statement", label: "كشف الاعتمادات المستندية", icon: "🌐", group: "تقارير المشتريات" },

  { key: "cash_boxes", label: "الخزن", icon: "💰", group: "الخزينة والبنوك" },
  { key: "banks", label: "البنوك", icon: "🏦", group: "الخزينة والبنوك" },
  { key: "financial_tx", label: "المعاملات المالية", icon: "💸", group: "الخزينة والبنوك" },
  { key: "treasury_transfers", label: "تحويل الخزن", icon: "🔁", group: "الخزينة والبنوك" },
  { key: "currencies", label: "العملات", icon: "🌐", group: "الخزينة والبنوك" },
  { key: "exchange_rates", label: "أسعار الصرف", icon: "💱", group: "الخزينة والبنوك" },

  { key: "chart_of_accounts", label: "شجرة الحسابات", icon: "🌳", group: "المحاسبة" },
  { key: "journal_entries", label: "القيود اليومية", icon: "📒", group: "المحاسبة" },
  { key: "posting_center", label: "مركز الترحيل", icon: "📮", group: "المحاسبة" },
  { key: "fiscal_periods", label: "الفترات المحاسبية", icon: "🗓️", group: "المحاسبة" },
  { key: "cost_centers", label: "مراكز التكلفة", icon: "🎯", group: "المحاسبة" },
  { key: "taxes", label: "الضرائب", icon: "🧾", group: "المحاسبة" },
  { key: "report_account_statement", label: "كشف حساب", icon: "📄", group: "التقارير المالية" },
  { key: "report_customer_statement", label: "كشف حساب عميل", icon: "🧑‍💼", group: "المبيعات" },
  { key: "report_income_statement", label: "قائمة الدخل", icon: "📈", group: "التقارير المالية" },
  { key: "report_balance_sheet", label: "الميزانية", icon: "⚖️", group: "التقارير المالية" },
  { key: "report_trial_balance", label: "ميزان المراجعة بالمجاميع", icon: "📊", group: "التقارير المالية" },

  { key: "warehouses", label: "المخازن", icon: "🏬", group: "المخازن" },
  { key: "stocktakes", label: "الجرد", icon: "📋", group: "المخازن" },
  { key: "stock_adjustments", label: "تسوية المخزون", icon: "⚖️", group: "المخازن" },
  { key: "stock_movements", label: "حركة المخزون", icon: "📈", group: "المخازن" },
  { key: "stock_transfers", label: "التحويل بين المخازن", icon: "🔄", group: "المخازن" },
  { key: "item_card", label: "كارت الصنف", icon: "🗃️", group: "المخازن" },
  { key: "stock_valuation", label: "تقييم المخزون", icon: "💰", group: "المخازن" },

  { key: "scale", label: "الميزان", icon: "⚖️", group: "الإعدادات" },
  { key: "branches", label: "الفروع", icon: "🏢", group: "الإعدادات" },
  { key: "number_series", label: "أرقام المسلسلات", icon: "🔢", group: "الإعدادات" },
  { key: "user_permissions", label: "صلاحيات المستخدمين", icon: "🛡️", group: "الإعدادات" },
  { key: "users", label: "المستخدمون", icon: "🔐", group: "الإعدادات" },
  { key: "dashboard", label: "لوحة التحكم", icon: "⚙️", group: "الإعدادات" },
  { key: "updates", label: "التحديثات", icon: "🔄", group: "الإعدادات" },
  { key: "settings_guide", label: "دليل الإعدادات", icon: "🏢", group: "الإعدادات" },
  { key: "zatca", label: "تسجيل زاتكا (مستقل)", icon: "🧾", group: "الإعدادات" },
  { key: "pos_accounts", label: "إعدادات حسابات نقاط البيع", icon: "💳", group: "الإعدادات" },
];

// Role default: which screens are visible by default for each role.
const ROLE_DEFAULTS: Record<"admin" | "cashier", ScreenKey[]> = {
  admin: SCREEN_KEYS.map((s) => s.key), // admin sees everything
  cashier: ["sales", "returns", "parked", "daily", "customers", "items", "low_stock"],
};

export function defaultsForRole(role: "admin" | "cashier"): Set<ScreenKey> {
  return new Set(ROLE_DEFAULTS[role] ?? []);
}

export type UserPermission = { userId: string; screenKey: ScreenKey; canView: boolean };

export async function listUserPermissions(userId: string): Promise<UserPermission[]> {
  if (!hasTauri()) return [];
  return await invoke<UserPermission[]>("permissions_list_for_user", { userId });
}
export async function setPermission(userId: string, screenKey: ScreenKey, canView: boolean): Promise<void> {
  if (!hasTauri()) return;
  await invoke("permissions_set", { userId, screenKey, canView });
}
export async function clearPermission(userId: string, screenKey: ScreenKey): Promise<void> {
  if (!hasTauri()) return;
  await invoke("permissions_clear", { userId, screenKey });
}
export async function clearAllPermissions(userId: string): Promise<void> {
  if (!hasTauri()) return;
  await invoke("permissions_clear_all", { userId });
}

/** Compute effective allowed-screens for a (role, overrides) pair. */
export function computeAllowed(
  role: "admin" | "cashier",
  overrides: UserPermission[],
): Set<ScreenKey> {
  const set = new Set(defaultsForRole(role));
  for (const o of overrides) {
    if (o.canView) set.add(o.screenKey);
    else set.delete(o.screenKey);
  }
  return set;
}

/** Cache the current user's allowed-set in localStorage so the sidebar
 *  filter is synchronous (avoids first-render flash). Refreshed on login
 *  and whenever the permissions admin saves a change. */
const LS_ALLOWED = "pos_desktop_allowed_screens";

export function persistAllowedToLS(allowed: Set<ScreenKey>): void {
  try { localStorage.setItem(LS_ALLOWED, JSON.stringify([...allowed])); } catch { /* quota */ }
}
export function loadAllowedFromLS(): Set<ScreenKey> | null {
  try {
    const raw = localStorage.getItem(LS_ALLOWED);
    if (!raw) return null;
    return new Set(JSON.parse(raw) as ScreenKey[]);
  } catch { return null; }
}
export function clearAllowedLS(): void {
  try { localStorage.removeItem(LS_ALLOWED); } catch { /* ignore */ }
}
