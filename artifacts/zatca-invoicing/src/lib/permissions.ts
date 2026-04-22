// ─────────────────────────────────────────────────────────────────────
// Central registry of all permission-controlled modules in the app.
// Each module declares the actions it supports.
// The permissions JSON stored on a user has the shape:
//   { [moduleKey]: { [action]: boolean } }
// admin / superadmin always have full access regardless of this map.
// ─────────────────────────────────────────────────────────────────────

export type Action = "view" | "create" | "edit" | "delete" | "post" | "export";

export interface ModuleDef {
  key: string;
  label: string;
  group: string;
  actions: Action[];
}

const ALL: Action[] = ["view", "create", "edit", "delete", "post", "export"];
const VC:  Action[] = ["view", "create", "edit", "delete"];
const VO:  Action[] = ["view"];

export const PERMISSION_MODULES: ModuleDef[] = [
  // ─── Dashboard / general ─────────────────────────────────────────
  { key: "dashboard",         label: "اللوحة الرئيسية",          group: "عام",      actions: VO },
  { key: "general_settings",  label: "الإعدادات العامة",         group: "عام",      actions: ["view", "edit"] },
  { key: "branches",          label: "الفروع والمناطق",          group: "عام",      actions: VC },
  { key: "users",             label: "المستخدمون والصلاحيات",   group: "عام",      actions: VC },

  // ─── Sales ───────────────────────────────────────────────────────
  { key: "customers",         label: "العملاء",                  group: "المبيعات", actions: VC },
  { key: "sales_quotations",  label: "عروض الأسعار",             group: "المبيعات", actions: ALL },
  { key: "sales_invoices",    label: "فواتير المبيعات",          group: "المبيعات", actions: ALL },
  { key: "sales_returns",     label: "مرتجعات المبيعات",        group: "المبيعات", actions: ALL },
  { key: "sales_settlements", label: "تحصيل العملاء",            group: "المبيعات", actions: VC },
  { key: "zatca_bridge",      label: "جسر ZATCA",                group: "المبيعات", actions: ["view", "post"] },
  { key: "zatca_report",      label: "تقرير فواتير ZATCA",       group: "المبيعات", actions: ["view", "export"] },

  // ─── Purchasing ──────────────────────────────────────────────────
  { key: "suppliers",         label: "الموردون",                 group: "المشتريات", actions: VC },
  { key: "purchase_invoices", label: "فواتير المشتريات",        group: "المشتريات", actions: ALL },
  { key: "purchase_returns",  label: "مرتجعات المشتريات",       group: "المشتريات", actions: ALL },
  { key: "supplier_settlements", label: "تسوية الموردين",         group: "المشتريات", actions: VC },

  // ─── Inventory ───────────────────────────────────────────────────
  { key: "items",             label: "الأصناف",                  group: "المخزون",  actions: ALL },
  { key: "warehouses",        label: "المخازن",                  group: "المخزون",  actions: VC },
  { key: "stock_transfers",   label: "تحويلات المخزون",          group: "المخزون",  actions: ALL },
  { key: "stock_adjustments", label: "تسويات المخزون",           group: "المخزون",  actions: ALL },
  { key: "stock_counts",      label: "جرد المخزون",              group: "المخزون",  actions: ALL },
  { key: "inventory_reports", label: "تقارير المخزون",           group: "المخزون",  actions: ["view", "export"] },

  // ─── Accounting / Cash ───────────────────────────────────────────
  { key: "accounts",          label: "شجرة الحسابات",            group: "المحاسبة", actions: VC },
  { key: "journal_entries",   label: "القيود اليومية",           group: "المحاسبة", actions: ALL },
  { key: "cash_boxes",        label: "الخزائن",                  group: "المحاسبة", actions: VC },
  { key: "bank_accounts",     label: "الحسابات البنكية",          group: "المحاسبة", actions: VC },
  { key: "receipt_vouchers",  label: "سندات القبض",              group: "المحاسبة", actions: ALL },
  { key: "payment_vouchers",  label: "سندات الصرف",              group: "المحاسبة", actions: ALL },
  { key: "accounting_reports", label: "التقارير المحاسبية",       group: "المحاسبة", actions: ["view", "export"] },

  // ─── Tax ─────────────────────────────────────────────────────────
  { key: "vat_declaration",   label: "الإقرار الضريبي",          group: "الضرائب",  actions: ["view", "export"] },
];

export const PERMISSION_GROUPS = Array.from(new Set(PERMISSION_MODULES.map(m => m.group)));

export const ACTION_LABELS: Record<Action, string> = {
  view:   "عرض",
  create: "إضافة",
  edit:   "تعديل",
  delete: "حذف",
  post:   "ترحيل",
  export: "تصدير",
};

export type PermissionMap = Record<string, Partial<Record<Action, boolean>>>;

// ─── Helpers ─────────────────────────────────────────────────────────
export function emptyPermissions(): PermissionMap {
  const out: PermissionMap = {};
  for (const m of PERMISSION_MODULES) out[m.key] = {};
  return out;
}

export function fullPermissions(): PermissionMap {
  const out: PermissionMap = {};
  for (const m of PERMISSION_MODULES) {
    out[m.key] = {};
    for (const a of m.actions) out[m.key][a] = true;
  }
  return out;
}

export function viewOnlyPermissions(): PermissionMap {
  const out: PermissionMap = {};
  for (const m of PERMISSION_MODULES) {
    out[m.key] = {};
    if (m.actions.includes("view")) out[m.key].view = true;
  }
  return out;
}
