// ─────────────────────────────────────────────────────────────────────────
// Windows desktop-app module registry (Task #226)
//
// SINGLE SOURCE OF TRUTH for every screen the Windows app (PosShell) can show.
// Each screen ("view") is mapped to:
//   • module  — the coarse, SuperAdmin-toggleable module key. The cloud pushes
//               a { <module>: boolean } map through /api/sync/pull → settings;
//               a module set to `false` hides every view that rolls up to it.
//   • profile — which first-run app profile the view belongs to:
//               "pos" = minimal cash-register profile (always shown),
//               "erp" = full-ERP-only screens (hidden when the machine was set
//                       up as "POS only" at first run).
//
// Adding a new Windows screen is a SMALL, documented edit IN ONE PLACE:
//   1. add the view literal to `WindowsView` below,
//   2. add a row to `VIEW_MODULE` (module + profile),
//   3. (PosShell) add its nav entry + render branch as usual.
// The remote gate + profile gate then apply automatically via isModuleEnabled().
//
// The high-level module keys + Arabic labels are duplicated, by design, in the
// web SuperAdmin screen artifacts/zatca-invoicing/src/pages/WindowsAppPermissions.tsx
// (the two artifacts cannot import from each other — same convention as
// COMPANY_MODULE_GATE). Keep WINDOWS_MODULES in sync with that file.
// ─────────────────────────────────────────────────────────────────────────

export type WindowsView =
  | "sales" | "returns" | "pending" | "parked" | "daily"
  | "customers" | "items" | "item_groups" | "uom" | "dashboard" | "updates" | "users"
  | "expiry" | "scale" | "stock_import" | "low_stock" | "network"
  | "suppliers" | "purchases" | "purchase_returns"
  | "salespersons"
  | "sales_invoices" | "quotations" | "sales_orders" | "sales_returns" | "invoice_import"
  | "report_sales_daily" | "report_sales_by_period" | "report_sales_by_item" | "report_sales_by_customer"
  | "report_sales_daily_detailed" | "report_sales_payment_mix" | "report_sales_returns" | "report_sales_top_customers"
  | "cash_boxes" | "banks" | "financial_tx"
  | "currencies" | "exchange_rates" | "treasury_transfers"
  | "chart_of_accounts" | "journal_entries" | "user_permissions"
  | "cost_centers" | "branches" | "taxes"
  | "report_account_statement" | "report_customer_statement" | "report_income_statement"
  | "report_balance_sheet" | "report_trial_balance"
  | "warehouses" | "stocktakes" | "stock_adjustments" | "stock_movements" | "stock_transfers"
  | "number_series" | "settings_guide" | "zatca";

export type WindowsModuleKey =
  | "pos"          // cash-register core: sales, returns, parked, daily, pending
  | "customers"    // customer master
  | "inventory"    // items, uom, warehouses, stock ops, low-stock, expiry, import
  | "purchasing"   // suppliers, purchase invoices/returns
  | "sales_docs"   // full sales invoices/returns (back-office, not the POS register)
  | "cash_banks"   // cash boxes, banks, financial tx, treasury, currencies, FX
  | "accounting"   // CoA, journal, cost centers, taxes, financial reports
  | "control";     // branches, users, permissions, number series, settings, system

export type AppProfile = "pos" | "erp";

// Coarse modules shown on the web SuperAdmin toggle grid. Order = display order.
export const WINDOWS_MODULES: { key: WindowsModuleKey; label: string; group: string }[] = [
  { key: "pos",        label: "نقطة البيع (بيع / مرتجع / يومية)", group: "العمليات" },
  { key: "customers",  label: "العملاء",                          group: "الملفات" },
  { key: "inventory",  label: "المخازن والأصناف",                 group: "المخازن" },
  { key: "purchasing", label: "المشتريات والموردون",              group: "المشتريات" },
  { key: "sales_docs", label: "فواتير المبيعات (الخلفية)",        group: "المبيعات" },
  { key: "cash_banks", label: "النقد والبنوك",                    group: "الخزينة" },
  { key: "accounting", label: "الحسابات والتقارير المالية",       group: "المحاسبة" },
  { key: "control",    label: "التحكم والإعدادات",                group: "النظام" },
];

type ViewMeta = { module: WindowsModuleKey; profile: AppProfile };

// EVERY WindowsView MUST appear here (enforced by the Record<> type).
export const VIEW_MODULE: Record<WindowsView, ViewMeta> = {
  // ── POS core (minimal profile) ──────────────────────────────────────
  sales:   { module: "pos", profile: "pos" },
  returns: { module: "pos", profile: "pos" },
  pending: { module: "pos", profile: "pos" },
  parked:  { module: "pos", profile: "pos" },
  daily:   { module: "pos", profile: "pos" },
  // Customers + the catalog basics are needed even by a pure cash register.
  customers:    { module: "customers", profile: "pos" },
  items:        { module: "inventory", profile: "pos" },
  item_groups:  { module: "inventory", profile: "pos" },
  uom:          { module: "inventory", profile: "pos" },
  low_stock:    { module: "inventory", profile: "pos" },
  stock_import: { module: "inventory", profile: "pos" },
  invoice_import: { module: "pos", profile: "pos" },
  expiry:       { module: "inventory", profile: "pos" },
  scale:        { module: "control",   profile: "pos" },
  network:      { module: "control",   profile: "pos" },
  dashboard:    { module: "control",   profile: "pos" },
  updates:      { module: "control",   profile: "pos" },
  settings_guide: { module: "control", profile: "pos" },
  zatca: { module: "control", profile: "pos" },
  // ── ERP-only screens (hidden in the "POS only" profile) ─────────────
  warehouses:        { module: "inventory", profile: "erp" },
  stocktakes:        { module: "inventory", profile: "erp" },
  stock_adjustments: { module: "inventory", profile: "erp" },
  stock_movements:   { module: "inventory", profile: "erp" },
  stock_transfers:   { module: "inventory", profile: "erp" },
  suppliers:         { module: "purchasing", profile: "erp" },
  purchases:         { module: "purchasing", profile: "erp" },
  purchase_returns:  { module: "purchasing", profile: "erp" },
  salespersons:      { module: "sales_docs", profile: "erp" },
  sales_invoices:    { module: "sales_docs", profile: "erp" },
  quotations:        { module: "sales_docs", profile: "erp" },
  sales_orders:      { module: "sales_docs", profile: "erp" },
  sales_returns:     { module: "sales_docs", profile: "erp" },
  report_sales_daily:       { module: "sales_docs", profile: "erp" },
  report_sales_by_period:   { module: "sales_docs", profile: "erp" },
  report_sales_by_item:     { module: "sales_docs", profile: "erp" },
  report_sales_by_customer: { module: "sales_docs", profile: "erp" },
  report_sales_daily_detailed: { module: "sales_docs", profile: "erp" },
  report_sales_payment_mix: { module: "sales_docs", profile: "erp" },
  report_sales_returns: { module: "sales_docs", profile: "erp" },
  report_sales_top_customers: { module: "sales_docs", profile: "erp" },
  cash_boxes:        { module: "cash_banks", profile: "erp" },
  banks:             { module: "cash_banks", profile: "erp" },
  financial_tx:      { module: "cash_banks", profile: "erp" },
  treasury_transfers:{ module: "cash_banks", profile: "erp" },
  currencies:        { module: "cash_banks", profile: "erp" },
  exchange_rates:    { module: "cash_banks", profile: "erp" },
  chart_of_accounts: { module: "accounting", profile: "erp" },
  journal_entries:   { module: "accounting", profile: "erp" },
  cost_centers:      { module: "accounting", profile: "erp" },
  taxes:             { module: "accounting", profile: "erp" },
  report_account_statement: { module: "accounting", profile: "erp" },
  report_customer_statement: { module: "accounting", profile: "erp" },
  report_income_statement:  { module: "accounting", profile: "erp" },
  report_balance_sheet:     { module: "accounting", profile: "erp" },
  report_trial_balance:     { module: "accounting", profile: "erp" },
  branches:          { module: "control", profile: "erp" },
  users:             { module: "control", profile: "erp" },
  user_permissions:  { module: "control", profile: "erp" },
  number_series:     { module: "control", profile: "erp" },
};

export function moduleForView(v: WindowsView): WindowsModuleKey {
  return VIEW_MODULE[v]?.module ?? "control";
}
export function profileForView(v: WindowsView): AppProfile {
  return VIEW_MODULE[v]?.profile ?? "erp";
}
