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
  dashboard:   "perms.groups.dashboard",
  sales:       "perms.groups.sales",
  purchasing:  "perms.groups.purchasing",
  inventory:   "perms.groups.inventory",
  accounting:  "perms.groups.accounting",
  accountingMaintenance: "perms.groups.accountingMaintenance",
  tax:         "perms.groups.tax",
  pos:         "perms.groups.pos",
  hr:          "perms.groups.hr",
  production:  "perms.groups.production",
  safety:      "perms.groups.safety",
  contracting: "perms.groups.contracting",
  maintenance: "perms.groups.maintenance",
  hotel:       "perms.groups.hotel",
  hospital:    "perms.groups.hospital",
  crm:         "perms.groups.crm",
  fixedAssets: "perms.groups.fixedAssets",
  security:    "perms.groups.security",
  aiTools:     "perms.groups.aiTools",
  voiceAssistant: "perms.groups.voiceAssistant",
  sessions:     "perms.groups.sessions",
  chat:         "perms.groups.chat",
  companyMaintenance: "perms.groups.companyMaintenance",
  fieldService: "perms.groups.fieldService",
  multiLink:    "perms.groups.multiLink",
  office:       "perms.groups.office",
};

export const PERMISSION_MODULES: ModuleDef[] = [
  { key: "dashboard",            label: "perms.modules.dashboard",            group: G.dashboard,  actions: VO },
  { key: "dashboard_kpis",       label: "perms.modules.dashboard_kpis",       group: G.dashboard,  actions: VO },
  { key: "dashboard_charts",     label: "perms.modules.dashboard_charts",     group: G.dashboard,  actions: VO },
  { key: "dashboard_alerts",     label: "perms.modules.dashboard_alerts",     group: G.dashboard,  actions: VO },
  { key: "dashboard_recent_invoices", label: "perms.modules.dashboard_recent_invoices", group: G.dashboard, actions: VO },
  { key: "regions",              label: "perms.modules.regions",              group: G.dashboard,  actions: VC },
  { key: "branches",             label: "perms.modules.branches",             group: G.dashboard,  actions: VC },
  { key: "zatca_setup",          label: "perms.modules.zatca_setup",          group: G.dashboard,  actions: ["view", "edit"] },
  { key: "general_settings",     label: "perms.modules.general_settings",     group: G.dashboard,  actions: ["view", "edit"] },
  { key: "company_profile",      label: "perms.modules.company_profile",      group: G.dashboard,  actions: ["view", "edit"] },
  { key: "users",                label: "perms.modules.users",                group: G.dashboard,  actions: VC },
  { key: "currencies",           label: "perms.modules.currencies",           group: G.dashboard,  actions: VC },
  { key: "sequences",            label: "perms.modules.sequences",            group: G.dashboard,  actions: VC },
  { key: "extensions",           label: "perms.modules.extensions",           group: G.dashboard,  actions: VO },

  { key: "office",               label: "perms.modules.office",               group: G.office,     actions: VO },

  { key: "customers",            label: "perms.modules.customers",            group: G.sales,      actions: VC },
  { key: "sales_quotations",     label: "perms.modules.sales_quotations",     group: G.sales,      actions: ALL },
  { key: "sales_invoices",       label: "perms.modules.sales_invoices",       group: G.sales,      actions: ALL },
  { key: "sales_returns",        label: "perms.modules.sales_returns",        group: G.sales,      actions: ALL },
  { key: "sales_settlements",    label: "perms.modules.sales_settlements",    group: G.sales,      actions: VC },
  { key: "sales_reps",           label: "perms.modules.sales_reps",           group: G.sales,      actions: VC },
  { key: "sales_reports",        label: "perms.modules.sales_reports",        group: G.sales,      actions: ["view", "export"] },
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
  { key: "accounting_maintenance", label: "perms.modules.accounting_maintenance", group: G.accountingMaintenance, actions: ALL },

  { key: "vat_declaration",      label: "perms.modules.vat_declaration",      group: G.tax,        actions: ["view", "export"] },

  // POS group — covers /pos-monitoring, /pos-settings and /pos-terminals.
  { key: "pos",                  label: "perms.modules.pos",                  group: G.pos,        actions: VC },

  // HR group — one module per logical screen.
  { key: "hr_employees",         label: "perms.modules.hr_employees",         group: G.hr,         actions: ALL },
  { key: "hr_attendance",        label: "perms.modules.hr_attendance",        group: G.hr,         actions: ALL },
  { key: "hr_loans",             label: "perms.modules.hr_loans",             group: G.hr,         actions: ALL },
  { key: "hr_payroll",           label: "perms.modules.hr_payroll",           group: G.hr,         actions: ALL },
  { key: "hr_eos",               label: "perms.modules.hr_eos",               group: G.hr,         actions: VC },
  { key: "hr_calculators",       label: "perms.modules.hr_calculators",       group: G.hr,         actions: VO },
  { key: "hr_settings",          label: "perms.modules.hr_settings",          group: G.hr,         actions: ["view", "edit"] },
  { key: "hr_face_attendance",   label: "perms.modules.hr_face_attendance",   group: G.hr,         actions: ALL },

  // Production & Manufacturing — backend key is "production"; one logical
  // module covers dashboard / orders / resources behind a single permission.
  { key: "production",           label: "perms.modules.production",           group: G.production,  actions: ALL },

  // Occupational Safety & Health (OSH / ISO 45001) — per-screen permission
  // keys. All three roll up to the single company-level `safety` module gate
  // (see COMPANY_MODULE_GATE backend + companyModuleGate.ts frontend).
  { key: "safety_dashboard",     label: "perms.modules.safety_dashboard",     group: G.safety,      actions: VO },
  { key: "safety_risk",          label: "perms.modules.safety_risk",          group: G.safety,      actions: VC },
  { key: "safety_incidents",     label: "perms.modules.safety_incidents",     group: G.safety,      actions: VC },

  // Contracting Management — backend key is "contracting"; covers projects,
  // contractors, bills, and the contracting dashboard behind a single permission.
  { key: "contracting",          label: "perms.modules.contracting",          group: G.contracting, actions: ALL },

  // Maintenance ERP — backend key is "maintenance"; covers assets, technicians,
  // work orders, and spare-parts consumption behind a single permission.
  { key: "maintenance",          label: "perms.modules.maintenance",          group: G.maintenance, actions: ALL },

  // Hotel ERP — backend key is "hotel"; covers hotels, rooms, guests,
  // bookings, payments, housekeeping, and AI engines (dynamic pricing,
  // recommendations, forecasting, maintenance prediction).
  { key: "hotel",                label: "perms.modules.hotel",                group: G.hotel,       actions: ALL },

  // Hospital / Clinic ERP — backend key is "hospital"; covers facilities,
  // doctors, patients, appointments / encounters, invoices, and the
  // NPHIES integration blueprint + AI helpers (claim risk, diagnosis
  // suggestion). The real NPHIES connection requires CCHI accreditation;
  // this module ships the FHIR R4 generator and an offline blueprint
  // dashboard so the workflow can be exercised end-to-end.
  { key: "hospital",             label: "perms.modules.hospital",             group: G.hospital,    actions: ALL },

  // CRM — backend key is "crm"; covers Leads, Opportunities, Activities,
  // Campaigns, Pipeline, plus AI helpers (lead scoring, forecast, alerts).
  { key: "crm",                  label: "perms.modules.crm",                  group: G.crm,         actions: ALL },

  // Fixed Assets — backend key "fixed_assets"; covers asset register,
  // categories, maintenance log, transfers, depreciation runs, and disposals.
  { key: "fixed_assets",         label: "perms.modules.fixed_assets",         group: G.fixedAssets, actions: ALL },

  // Security & Surveillance — backend key is "security_events"; covers the
  // security hub, events log, and notification rules.
  { key: "security_events",      label: "perms.modules.security_events",      group: G.security,    actions: VC },

  // ─── AI Tools (أدوات الذكاء الاصطناعي) ───────────────────────────────
  // The remaining AI Tools group (AI Reports + the in-app inbox). The
  // per-user `ai_tools` toggle governs who can reach the group; the Layout
  // gates the whole group via GROUP_PERMISSION_KEYS.aiTools = ["ai_tools"].
  { key: "ai_tools",             label: "perms.modules.ai_tools",             group: G.aiTools,            actions: VO },

  // ─── Voice Assistant / Sessions / Chat / Company Maintenance ─────────
  // These four screens were split out of the old "أدوات الذكاء الاصطناعي"
  // group into their own top-level sidebar groups, each with its own
  // company-level menu toggle. Per-user toggles let the company admin
  // govern who can reach each one. Voice assistant + sessions admin are
  // also requireAdmin at the nav level.
  { key: "voiceAssistant",       label: "perms.modules.voiceAssistant",       group: G.voiceAssistant,     actions: VO },
  { key: "sessions",             label: "perms.modules.sessions",             group: G.sessions,           actions: VC },
  { key: "chat",                 label: "perms.modules.chat",                 group: G.chat,               actions: VO },
  { key: "data_io",              label: "perms.modules.data_io",              group: G.companyMaintenance, actions: ["view", "create", "export"] },

  // ─── Field Service Management (FSM) ──────────────────────────────────
  // Standalone billable module gated by `field_service` company toggle.
  // Granular sub-permissions let the company admin govern which FSM
  // surfaces each user can see/use (locations, visits, plans, tickets,
  // tracking, reports).
  { key: "field_service_locations", label: "perms.modules.field_service_locations", group: G.fieldService, actions: ALL },
  { key: "field_service_visits",    label: "perms.modules.field_service_visits",    group: G.fieldService, actions: ALL },
  { key: "field_service_plans",     label: "perms.modules.field_service_plans",     group: G.fieldService, actions: ALL },
  { key: "field_service_tickets",   label: "perms.modules.field_service_tickets",   group: G.fieldService, actions: ALL },
  { key: "field_service_tracking",  label: "perms.modules.field_service_tracking",  group: G.fieldService, actions: VO },
  { key: "field_service_reports",   label: "perms.modules.field_service_reports",   group: G.fieldService, actions: ["view", "export"] },

  // ─── ربط متعدد (Multi-tenant External Gateway) ───────────────────────
  // Single permission gates the whole gateway-clients surface for the
  // company admin (onboarding 3rd-party companies, uploading their
  // invoices, dispatching to ZATCA, viewing reports, managing CSID).
  { key: "multi_link",              label: "perms.modules.multi_link",              group: G.multiLink,    actions: ALL },
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
