// ─────────────────────────────────────────────────────────────────────
// Central registry of all permission-controlled modules in the app.
// Labels and group names are i18n keys; resolve via t(label) in the UI.
// ─────────────────────────────────────────────────────────────────────

export type Action = "view" | "create" | "edit" | "delete" | "post" | "export";

export interface ModuleDef {
  key: string;
  label: string;       // i18n key
  group: string;       // i18n key
  actions: Action[];
}

const ALL: Action[] = ["view", "create", "edit", "delete", "post", "export"];
const VC:  Action[] = ["view", "create", "edit", "delete"];
const VO:  Action[] = ["view"];

const G = {
  dashboard:  "perms.groups.dashboard",
  sales:      "perms.groups.sales",
  purchasing: "perms.groups.purchasing",
  inventory:  "perms.groups.inventory",
  accounting: "perms.groups.accounting",
  tax:        "perms.groups.tax",
};

export const PERMISSION_MODULES: ModuleDef[] = [
  { key: "dashboard",            label: "perms.modules.dashboard",            group: G.dashboard,  actions: VO },
  { key: "regions",              label: "perms.modules.regions",              group: G.dashboard,  actions: VC },
  { key: "branches",             label: "perms.modules.branches",             group: G.dashboard,  actions: VC },
  { key: "zatca_setup",          label: "perms.modules.zatca_setup",          group: G.dashboard,  actions: ["view", "edit"] },
  { key: "general_settings",     label: "perms.modules.general_settings",     group: G.dashboard,  actions: ["view", "edit"] },
  { key: "users",                label: "perms.modules.users",                group: G.dashboard,  actions: VC },
  { key: "currencies",           label: "perms.modules.currencies",           group: G.dashboard,  actions: VC },

  { key: "customers",            label: "perms.modules.customers",            group: G.sales,      actions: VC },
  { key: "sales_quotations",     label: "perms.modules.sales_quotations",     group: G.sales,      actions: ALL },
  { key: "sales_invoices",       label: "perms.modules.sales_invoices",       group: G.sales,      actions: ALL },
  { key: "sales_returns",        label: "perms.modules.sales_returns",        group: G.sales,      actions: ALL },
  { key: "sales_settlements",    label: "perms.modules.sales_settlements",    group: G.sales,      actions: VC },
  { key: "zatca_bridge",         label: "perms.modules.zatca_bridge",         group: G.sales,      actions: ["view", "post"] },
  { key: "zatca_report",         label: "perms.modules.zatca_report",         group: G.sales,      actions: ["view", "export"] },

  { key: "suppliers",            label: "perms.modules.suppliers",            group: G.purchasing, actions: VC },
  { key: "purchase_invoices",    label: "perms.modules.purchase_invoices",    group: G.purchasing, actions: ALL },
  { key: "purchase_returns",     label: "perms.modules.purchase_returns",     group: G.purchasing, actions: ALL },
  { key: "supplier_settlements", label: "perms.modules.supplier_settlements", group: G.purchasing, actions: VC },

  { key: "items",                label: "perms.modules.items",                group: G.inventory,  actions: ALL },
  { key: "warehouses",           label: "perms.modules.warehouses",           group: G.inventory,  actions: VC },
  { key: "stock_transfers",      label: "perms.modules.stock_transfers",      group: G.inventory,  actions: ALL },
  { key: "stock_adjustments",    label: "perms.modules.stock_adjustments",    group: G.inventory,  actions: ALL },
  { key: "stock_counts",         label: "perms.modules.stock_counts",         group: G.inventory,  actions: ALL },
  { key: "inventory_reports",    label: "perms.modules.inventory_reports",    group: G.inventory,  actions: ["view", "export"] },

  { key: "accounts",             label: "perms.modules.accounts",             group: G.accounting, actions: VC },
  { key: "journal_entries",      label: "perms.modules.journal_entries",      group: G.accounting, actions: ALL },
  { key: "cash_boxes",           label: "perms.modules.cash_boxes",           group: G.accounting, actions: VC },
  { key: "bank_accounts",        label: "perms.modules.bank_accounts",        group: G.accounting, actions: VC },
  { key: "receipt_vouchers",     label: "perms.modules.receipt_vouchers",     group: G.accounting, actions: ALL },
  { key: "payment_vouchers",     label: "perms.modules.payment_vouchers",     group: G.accounting, actions: ALL },
  { key: "accounting_reports",   label: "perms.modules.accounting_reports",   group: G.accounting, actions: ["view", "export"] },

  { key: "vat_declaration",      label: "perms.modules.vat_declaration",      group: G.tax,        actions: ["view", "export"] },
];

export const PERMISSION_GROUPS = Array.from(new Set(PERMISSION_MODULES.map(m => m.group)));

export const ACTION_LABELS: Record<Action, string> = {
  view:   "perms.actions.view",
  create: "perms.actions.create",
  edit:   "perms.actions.edit",
  delete: "perms.actions.delete",
  post:   "perms.actions.post",
  export: "perms.actions.export",
};

export type PermissionMap = Record<string, Partial<Record<Action, boolean>>>;

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
