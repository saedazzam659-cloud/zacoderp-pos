import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard, Building2, FileText, Users, Settings,
  Bell, Menu, Truck, LogOut, ChevronDown, ChevronRight, ShieldCheck,
  Package, Clock, Settings2, Link2, SlidersHorizontal, Sliders, BarChart3,
  Warehouse, Ruler, ArrowRightLeft, ClipboardList, BookOpen, BarChart2,
  Tag, Layers, BookMarked, MapPin, Building2 as BranchIcon, DollarSign,
  TrendingUp, Scale, PieChart, ShoppingCart, CreditCard, RotateCcw, Banknote,
  Wallet, Landmark, ArrowDownCircle, ArrowUpCircle, ArrowLeftRight,
  Search, Home, HelpCircle, ChevronLeft, Mic,
  ShoppingBag, FileSignature, KeyRound, CalendarRange, Target, Undo2, ExternalLink, UserCog, Calculator,
  Activity, MonitorSmartphone, AlertTriangle, Sparkles, MessageSquare, Inbox, BadgeCheck, Stethoscope,
  ScrollText, Database, ListOrdered, HardDrive,
  Factory, Cog, ScanFace, Store, ShieldAlert, Briefcase,
  type LucideIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useAuth } from "@/contexts/AuthContext";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { NotificationBell } from "@/components/NotificationBell";
import SessionCountdown from "@/components/SessionCountdown";
import ScreenAssistant from "@/components/ScreenAssistant";
import VoiceAssistantWidget from "@/components/VoiceAssistantWidget";
import SessionPickerModal from "@/components/SessionPickerModal";
import SessionIndicator from "@/components/SessionIndicator";
import { SUPPORTED_LANGUAGES, normalizeLang } from "@/i18n";

// ─── Nav definitions ───────────────────────────────────────────────────────────
type NavDef = { nameKey: string; href: string; icon: any; exact?: boolean; permKey?: string;
  /** When true, hide this entry from non-admin users even if they were granted the matching permission.
   *  Use for screens whose backend is hard-coded admin-only (e.g. user management) so non-admins
   *  don't see a menu link that would 404 / 403 when clicked. */
  requireAdmin?: boolean;
};

// Returns true when this nav item should be visible to the given user.
// Rules:
//   - admins and superadmins always see everything (skip per-screen filtering).
//   - items without a permKey have no per-screen gate and stay visible.
//   - otherwise, the user must have permissions[permKey].view === true.
// Centralized so leaf-level (NavItem) and group-level filtering stay in sync.
function navItemAllowed(item: NavDef, user: any): boolean {
  if (!user) return false;
  if (user.role === "superadmin" || user.role === "admin") return true;
  // Admin-only items stay hidden for regular users regardless of granted perms,
  // because their backend endpoints require admin role and would 403/404.
  if (item.requireAdmin) return false;
  if (!item.permKey) return true;
  const perm = (user.permissions ?? {})[item.permKey];
  return !!perm?.view;
}
function filterNav(items: NavDef[], user: any): NavDef[] {
  return items.filter(i => navItemAllowed(i, user));
}
// Group-level visibility: a collapsible group should hide entirely when the
// user has no .view perm for ANY of the modules it contains. Admins/superadmins
// always see everything.
function groupVisible(user: any, moduleKeys: string[]): boolean {
  if (!user) return false;
  if (user.role === "superadmin" || user.role === "admin") return true;
  const perms = user.permissions ?? {};
  return moduleKeys.some(k => !!perms[k]?.view);
}

// Module key sets per sidebar group. Keep in sync with the subNav arrays
// below — if a permKey is added/removed from a subNav, mirror it here so
// the parent group hides correctly when no children are accessible.
const SALES_GROUP_PERMS         = ["customers","sales_invoices","sales_quotations","sales_returns","sales_settlements","sales_reps","sales_reports","zatca_bridge","zatca_report"];
const SALES_REPORTS_PERMS       = ["sales_reports"];
const PURCHASING_GROUP_PERMS    = ["suppliers","purchase_invoices","purchase_returns","supplier_settlements"];
const PURCHASING_REPORTS_PERMS  = ["suppliers","purchase_invoices","purchase_returns"];
const CASH_GROUP_PERMS          = ["cash_boxes","bank_accounts","receipt_vouchers","payment_vouchers"];
const CASH_REPORTS_PERMS        = ["cash_boxes","bank_accounts","receipt_vouchers","payment_vouchers"];
const INVENTORY_GROUP_PERMS     = ["items","warehouses","stock_transfers","stock_adjustments","stock_counts"];
// All inventory report routes are gated as module="items" in App.tsx, so the
// group should mirror that exactly — a user with only `warehouses.view` has
// nothing accessible inside this group.
const INVENTORY_REPORTS_PERMS   = ["items"];
// Includes "accounting_reports" so users who only have the reports
// permission still see the (now-parent) Accounting menu, since the
// accounting reports section is nested INSIDE this group.
const ACCOUNTING_GROUP_PERMS    = ["accounts","journal_entries","accounting_reports"];
const ACCOUNTING_REPORTS_PERMS  = ["accounting_reports"];

const superAdminNav: NavDef[] = [
  { nameKey: "nav.infoBoard",            href: "/",                         icon: LayoutDashboard, exact: true },
  { nameKey: "nav.registrationRequests", href: "/admin/requests",           icon: Clock },
  { nameKey: "nav.licenses",             href: "/admin/licenses",           icon: KeyRound },
  { nameKey: "nav.backupOperations",     href: "/admin/backups",            icon: HardDrive },
  { nameKey: "nav.securityCenter",       href: "/admin/security",           icon: ShieldCheck },
  { nameKey: "nav.superAdminSecurity",   href: "/admin/security-superadmin", icon: ShieldCheck },
  { nameKey: "nav.reportsHub",           href: "/admin/reports",            icon: BarChart3 },
  { nameKey: "nav.subscriptions",        href: "/admin/subscriptions",      icon: Package },
  { nameKey: "nav.plans",                href: "/admin/plans",              icon: Settings2 },
  { nameKey: "nav.modules",              href: "/admin/modules",            icon: Layers },
  { nameKey: "nav.menuPermissions",      href: "/admin/menu-permissions",   icon: SlidersHorizontal },
  { nameKey: "nav.orphanStock",          href: "/admin/orphan-stock",       icon: AlertTriangle },
  { nameKey: "nav.aiCompanyFix",         href: "/admin/ai-fix",             icon: Sparkles },
  { nameKey: "nav.dataDoctor",           href: "/admin/data-doctor",        icon: Stethoscope },
  { nameKey: "nav.supportInbox",         href: "/admin/support",            icon: Inbox },
  { nameKey: "nav.supportSettings",      href: "/admin/support-settings",   icon: MessageSquare },
  { nameKey: "nav.auditLog",             href: "/admin/audit-log",          icon: ScrollText },
  { nameKey: "nav.companies",            href: "/companies",                icon: Building2 },
  { nameKey: "nav.posMonitoring",        href: "/pos-monitoring",           icon: Activity },
];
// POS items used to live as flat NavItems in companyBusinessNav. Per the
// user's request they're now grouped under a collapsible "إدارة نقاط البيع"
// (POS Management) parent group rendered by PosNavGroup, so this list
// stays empty (kept around for future business-level top-level NavItems).
const companyBusinessNav: NavDef[] = [];

// ── POS Management submenu ──────────────────────────────────────────────
// Collected from the legacy companyBusinessNav entries; gated on the same
// `pos` permission they had individually.
const posSubNav: NavDef[] = [
  { nameKey: "nav.posMonitoring", href: "/pos-monitoring", icon: Activity,          permKey: "pos" },
  { nameKey: "nav.posTerminals",  href: "/pos-terminals",  icon: MonitorSmartphone, permKey: "pos" },
  { nameKey: "nav.posSettings",   href: "/pos-settings",   icon: Settings,          permKey: "pos" },
];
const POS_GROUP_PERMS = ["pos"];
// HR submenu — sits under the "شؤون الموظفين" (HR) collapsible group.
const hrSubNav: NavDef[] = [
  { nameKey: "nav.hrEmployeesList", href: "/hr/employees",       icon: UserCog,         permKey: "hr_employees" },
  { nameKey: "nav.hrContracts",     href: "/hr/contracts",       icon: FileSignature,   permKey: "hr_employees" },
  { nameKey: "nav.hrAttendance",    href: "/hr/attendance",      icon: CalendarRange,   permKey: "hr_attendance" },
  { nameKey: "nav.hrFaceAttendance",href: "/hr/face",            icon: ScanFace,        permKey: "hr_face_attendance" },
  { nameKey: "nav.hrLoans",         href: "/hr/loans",           icon: Wallet,          permKey: "hr_loans" },
  { nameKey: "nav.hrPayroll",       href: "/hr/payroll",         icon: Banknote,        permKey: "hr_payroll" },
  { nameKey: "nav.hrEos",           href: "/hr/end-of-service",  icon: Scale,           permKey: "hr_eos" },
  { nameKey: "nav.hrCalculators",   href: "/hr/calculators",     icon: Calculator,      permKey: "hr_calculators" },
  { nameKey: "nav.hrReports",       href: "/hr/reports",         icon: BarChart3,       permKey: "hr_employees" },
  { nameKey: "nav.hrSettings",      href: "/hr/settings",        icon: Settings,        permKey: "hr_settings" },
];
const HR_GROUP_PERMS = [
  "hr_employees", "hr_attendance", "hr_face_attendance", "hr_loans", "hr_payroll",
  "hr_eos", "hr_calculators", "hr_settings",
];
// ── Production / Manufacturing submenu ──────────────────────────────────
// Sub-items live under the "نظام الإنتاج والتصنيع" collapsible group. The
// group uses a single `production` permission key — admins/superadmins
// always see it; tenant users need permissions.production.view = true.
const productionSubNav: NavDef[] = [
  { nameKey: "nav.productionDashboard", href: "/production",           icon: BarChart3, permKey: "production", exact: true },
  { nameKey: "nav.productionOrders",    href: "/production/orders",    icon: ClipboardList, permKey: "production" },
  { nameKey: "nav.productionResources", href: "/production/resources", icon: Cog, permKey: "production" },
];
const PRODUCTION_GROUP_PERMS = ["production"];
// Sub-items live under the "الأمن والمراقبة" collapsible group.
const securitySubNav: NavDef[] = [
  { nameKey: "security.nav.events", href: "/security/events", icon: ShieldAlert, permKey: "security_events" },
];
const SECURITY_GROUP_PERMS = ["security_events"];
const dashboardSubNav: NavDef[] = [
  { nameKey: "nav.regions",         href: "/org/regions",         icon: MapPin,     permKey: "regions" },
  { nameKey: "nav.branches",        href: "/org/branches",        icon: BranchIcon, permKey: "branches" },
  { nameKey: "nav.generalSettings", href: "/general-settings",    icon: Sliders,    permKey: "general_settings" },
  { nameKey: "nav.users",           href: "/users",               icon: Users,      permKey: "users", requireAdmin: true },
  { nameKey: "nav.currencies",      href: "/settings/currencies", icon: DollarSign, permKey: "currencies" },
  // accountingMappings: gate under "general_settings" since it's a chart-of-accounts wiring screen.
  { nameKey: "nav.accountingMappings", href: "/settings/accounting-mappings", icon: BookMarked, permKey: "general_settings" },
  { nameKey: "nav.dataIo",          href: "/settings/data-io",    icon: Database,   permKey: "data_io" },
  // Sequence management is admin-only at the backend, so the link is hidden
  // from non-admins regardless of permission grant (avoids 403/404 on click).
  { nameKey: "nav.sequences",       href: "/settings/sequences",  icon: ListOrdered, permKey: "sequences", requireAdmin: true },
  { nameKey: "nav.vatDeclaration",  href: "/vat-declaration",     icon: BarChart3,  permKey: "vat_declaration" },
  // Audit log was previously rendered as a standalone top-level item gated by
  // user.role==="admin"; per the user's request it's now nested under the
  // dashboard/control-panel group. requireAdmin keeps the same admin-only gate.
  { nameKey: "nav.auditLog",        href: "/admin/audit-log",     icon: ScrollText, requireAdmin: true },
  // Work-sessions: visible to every company user (each sees their own
  // sessions; admins see the whole company). No requireAdmin gate.
  // Hidden from superadmin entirely — superadmin has no companyId so the
  // feature does not apply to them. Renamed in the i18n catalog to
  // "سجل الجلسات" / "Session Log" to disambiguate from the new manual
  // sessions admin page below — the route + behaviour are unchanged.
  { nameKey: "nav.workSessions",    href: "/work-sessions",       icon: Clock },
  // Manual Sessions admin: NEW entity (separate from the per-login
  // work_sessions log above). Admin creates sessions and assigns users;
  // each user picks one at login and operations are tagged with it.
  // Gated on the new "sessions" perm key — admins always pass.
  { nameKey: "nav.sessionsAdmin",   href: "/sessions",            icon: Briefcase, permKey: "sessions", requireAdmin: true },
  // Voice Assistant — admin-only screen for company-wide voice activation,
  // AI model + a recent-commands log. Hidden from superadmin (no companyId).
  { nameKey: "nav.voiceAssistantSettings", href: "/voice-assistant/settings", icon: Mic, permKey: "voiceAssistant", requireAdmin: true },
  // In-app inbox — every company user has one (reports, system messages).
  { nameKey: "nav.inbox",        href: "/inbox",       icon: Inbox },
  // AI Reports — admin-only natural-language report generator.
  { nameKey: "nav.aiReports",    href: "/ai-reports",  icon: Sparkles, requireAdmin: true },
];

// "ربط ZATCA" — top-level group for ZATCA integration screens. Per the
// user's request these were lifted out of the dashboard/control-panel
// group so they get their own visible category in the sidebar.
const zatcaGroupSubNav: NavDef[] = [
  { nameKey: "nav.zatcaLink",   href: "/zatca",        icon: Link2,     permKey: "zatca_setup" },
  { nameKey: "nav.invoices",    href: "/invoices",     icon: FileText,  permKey: "sales_invoices" },
  // Moved out of the Sales group per the user's request — these two screens
  // belong with the rest of the ZATCA integration surface, not with the
  // sales-cycle screens. Permission keys (zatca_bridge / zatca_report)
  // unchanged so existing per-user grants keep working.
  { nameKey: "nav.zatcaBridge", href: "/zatca-bridge", icon: Link2,     permKey: "zatca_bridge" },
  { nameKey: "nav.zatcaReport", href: "/zatca-report", icon: BarChart3, permKey: "zatca_report" },
];

const purchasingSubNav: NavDef[] = [
  { nameKey: "nav.suppliers",            href: "/suppliers",                  icon: Truck,        permKey: "suppliers" },
  // supplier_groups + lc piggy-back on the suppliers permission (no dedicated module key).
  { nameKey: "nav.supplierGroups",       href: "/purchasing/supplier-groups", icon: Users,        permKey: "suppliers" },
  { nameKey: "nav.lc",                   href: "/purchasing/lc",              icon: CreditCard,   permKey: "purchase_invoices" },
  // Purchase orders piggy-back on the purchase_invoices permission key.
  { nameKey: "nav.purchaseOrders",       href: "/purchasing/orders",          icon: ClipboardList, permKey: "purchase_invoices" },
  { nameKey: "nav.purchaseInvoices",     href: "/purchasing/invoices",        icon: ShoppingCart, permKey: "purchase_invoices" },
  { nameKey: "nav.purchaseReturns",      href: "/purchasing/returns",         icon: RotateCcw,    permKey: "purchase_returns" },
  { nameKey: "nav.supplierSettlements",  href: "/purchasing/settlements",     icon: Banknote,     permKey: "supplier_settlements" },
];
const salesSubNav: NavDef[] = [
  { nameKey: "nav.customers",            href: "/customers",         icon: Users,           permKey: "customers" },
  { nameKey: "nav.salesReps",            href: "/sales/reps",        icon: BadgeCheck,      permKey: "sales_reps" },
  { nameKey: "nav.quotations",           href: "/sales/quotations",  icon: FileSignature,   permKey: "sales_quotations" },
  // Sales orders piggy-back on the sales_invoices permission key.
  { nameKey: "nav.salesOrders",          href: "/sales/orders",      icon: ClipboardList,   permKey: "sales_invoices" },
  { nameKey: "nav.salesInvoices",        href: "/sales/invoices",    icon: ShoppingBag,     permKey: "sales_invoices" },
  { nameKey: "nav.salesReturns",         href: "/sales/returns",     icon: RotateCcw,       permKey: "sales_returns" },
  { nameKey: "nav.customerSettlements",  href: "/sales/settlements", icon: ArrowDownCircle, permKey: "sales_settlements" },
  // Note: nav.zatcaBridge and nav.zatcaReport were moved out of this group
  // into zatcaGroupSubNav (the "ربط ZATCA" group) per the user's request —
  // they belong with the ZATCA integration screens, not the sales cycle.
];
const companySystemNav: NavDef[] = [];

const accountingSubNav: NavDef[] = [
  { nameKey: "nav.chartOfAccounts", href: "/accounting/accounts",       icon: BookMarked,    permKey: "accounts" },
  // cost_centers + fiscal_periods piggy-back on accounts (no dedicated module key).
  { nameKey: "nav.costCenters",     href: "/accounting/cost-centers",   icon: Target,        permKey: "accounts" },
  { nameKey: "nav.fiscalPeriods",   href: "/accounting/fiscal-periods", icon: CalendarRange, permKey: "accounts" },
  { nameKey: "nav.journals",        href: "/accounting/journals",       icon: BookOpen,      permKey: "journal_entries" },
];
const reportsSubNav: NavDef[] = [
  { nameKey: "nav.accountStatement", href: "/accounting/reports/account-statement", icon: FileText,   permKey: "accounting_reports" },
  { nameKey: "nav.trialBalance",     href: "/accounting/reports/trial-balance",     icon: Scale,      permKey: "accounting_reports" },
  { nameKey: "nav.balanceSheet",     href: "/accounting/reports/balance-sheet",     icon: PieChart,   permKey: "accounting_reports" },
  { nameKey: "nav.incomeStatement",  href: "/accounting/reports/income-statement",  icon: TrendingUp, permKey: "accounting_reports" },
];
const cashSubNav: NavDef[] = [
  { nameKey: "nav.cashBoxes",        href: "/cash/boxes",            icon: Wallet,          permKey: "cash_boxes" },
  { nameKey: "nav.banks",            href: "/cash/banks",            icon: Landmark,        permKey: "bank_accounts" },
  { nameKey: "nav.receiptVouchers",  href: "/cash/receipt-vouchers", icon: ArrowDownCircle, permKey: "receipt_vouchers" },
  { nameKey: "nav.paymentVouchers",  href: "/cash/payment-vouchers", icon: ArrowUpCircle,   permKey: "payment_vouchers" },
  // transfers: no dedicated module key; gate under cash_boxes.
  { nameKey: "nav.transfers",        href: "/cash/transfers",        icon: ArrowLeftRight,  permKey: "cash_boxes" },
];

const inventoryHeader: NavDef = { nameKey: "nav.inventoryDashboard", href: "/inventory", icon: LayoutDashboard, exact: true };
const inventorySubNav: NavDef[] = [
  { nameKey: "nav.items",             href: "/inventory/items",            icon: Package,           permKey: "items" },
  // item_groups + units piggy-back on items (no dedicated module key).
  { nameKey: "nav.itemGroups",        href: "/inventory/item-groups",      icon: Tag,               permKey: "items" },
  { nameKey: "nav.units",             href: "/inventory/units",            icon: Ruler,             permKey: "items" },
  { nameKey: "nav.warehouses",        href: "/inventory/warehouses",       icon: Warehouse,         permKey: "warehouses" },
  { nameKey: "nav.warehouseGroups",   href: "/inventory/warehouse-groups", icon: Layers,            permKey: "warehouses" },
  { nameKey: "nav.stockTransfers",    href: "/inventory/transfers",        icon: ArrowRightLeft,    permKey: "stock_transfers" },
  { nameKey: "nav.stockAdjustments",  href: "/inventory/adjustments",      icon: SlidersHorizontal, permKey: "stock_adjustments" },
  { nameKey: "nav.stockCounts",       href: "/inventory/counts",           icon: ClipboardList,     permKey: "stock_counts" },
  { nameKey: "nav.offers",            href: "/inventory/offers",           icon: Tag,               permKey: "items" },
];

const inventoryReportsHeader: NavDef = { nameKey: "nav.allReports", href: "/inventory/reports", icon: LayoutDashboard, exact: true };
const inventoryReportsSubNav: NavDef[] = [
  { nameKey: "navExtra.stockBalance", href: "/inventory/reports/stock-balance", icon: BarChart2,         permKey: "items" },
  { nameKey: "navExtra.stockLedger",  href: "/inventory/reports/stock-ledger",  icon: BookOpen,          permKey: "items" },
  { nameKey: "navExtra.itemCard",     href: "/inventory/reports/item-card",     icon: ClipboardList,     permKey: "items" },
  { nameKey: "navExtra.lowStock",     href: "/inventory/reports/low-stock",     icon: SlidersHorizontal, permKey: "items" },
  { nameKey: "navExtra.valuation",    href: "/inventory/reports/valuation",     icon: Wallet,            permKey: "items" },
  { nameKey: "navExtra.slowMoving",   href: "/inventory/reports/slow-moving",   icon: Layers,            permKey: "items" },
];

// ─── HubGroupButton ───────────────────────────────────────────────────────────
// Shared parent-row for a top-level NavGroup. Splits the row into a Link
// (icon + label → hub landing page) and a separate chevron button (toggle
// expand/collapse only). Clicking the link auto-expands the group as well,
// so the user lands on the hub AND sees the children in the sidebar.
function HubGroupButton({
  hubHref, icon: Icon, label, isOn, open, onToggle, onNavigate,
}: {
  hubHref: string;
  icon: LucideIcon;
  label: string;
  isOn: boolean;
  open: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}) {
  // Striking blue parent rows for every top-level group:
  //   • idle    → light blue card with bold blue text
  //   • active  → solid vivid blue with white text + soft glow
  //   • open    → slightly deeper blue tint so the user sees which one is expanded
  const stateClasses = isOn
    ? "bg-blue-600 text-white hover:bg-blue-700 shadow-md ring-1 ring-blue-500/40 dark:bg-blue-500 dark:hover:bg-blue-600"
    : open
      ? "bg-blue-100 text-blue-800 hover:bg-blue-200 dark:bg-blue-900/60 dark:text-blue-100 dark:hover:bg-blue-900"
      : "bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-200 dark:hover:bg-blue-900/60";
  return (
    <div
      className={cn(
        "flex items-center rounded-lg pe-1 transition-all duration-200 group shadow-sm",
        stateClasses,
      )}
    >
      <Link
        href={hubHref}
        onClick={() => { if (!open) onToggle(); onNavigate(); }}
        className="flex-1 min-w-0 flex items-center gap-3 px-3 py-2 text-sm font-bold"
        data-testid={`hub-group-link-${hubHref.replace(/\//g, "")}`}
      >
        <Icon className="h-4 w-4 shrink-0" strokeWidth={2.5} />
        <span className="flex-1 text-start">{label}</span>
      </Link>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(); }}
        aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
        data-testid={`hub-group-toggle-${hubHref.replace(/\//g, "")}`}
        data-state={open ? "open" : "closed"}
        className={cn(
          "p-1.5 rounded-md opacity-80 hover:opacity-100 transition shrink-0",
          isOn
            ? "hover:bg-white/20"
            : "hover:bg-blue-200/70 dark:hover:bg-blue-800/60",
        )}
      >
        {open
          ? <ChevronDown  className="h-3.5 w-3.5" strokeWidth={2.5} />
          : <ChevronRight className="h-3.5 w-3.5" strokeWidth={2.5} />}
      </button>
    </div>
  );
}

// ─── CashNavGroup ──────────────────────────────────────────────────────────────
// Cash & bank reports are nested INSIDE this group (per the user's request).
function CashNavGroup({
  location, onNavigate, open, onToggle, reportsOpen, onReportsToggle,
}: {
  location: string; onNavigate: () => void; open: boolean; onToggle: () => void;
  reportsOpen: boolean; onReportsToggle: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth() as any;
  if (!groupVisible(user, CASH_GROUP_PERMS)) return null;
  // Treat /cash/reports as part of the parent group so the parent stays
  // highlighted while the user is browsing inside its nested reports.
  const isOnCash = location.startsWith("/cash");
  return (
    <div>
      <HubGroupButton
        hubHref="/cash"
        icon={Wallet}
        label={t("nav.cashGroup")}
        isOn={isOnCash}
        open={open}
        onToggle={onToggle}
        onNavigate={onNavigate}
      />
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 start-[26px] w-px bg-sidebar-border/60" />
          {cashSubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
          <CashReportsNavGroup
            location={location}
            onNavigate={onNavigate}
            open={reportsOpen}
            onToggle={onReportsToggle}
          />
        </div>
      )}
    </div>
  );
}

// ─── CashReportsNavGroup ──────────────────────────────────────────────────────
const cashReportsSubNav: NavDef[] = [
  { nameKey: "navExtra.cashBalances",     href: "/cash/reports/cash-balances",      icon: FileText, permKey: "cash_boxes" },
  { nameKey: "navExtra.bankBalances",     href: "/cash/reports/bank-balances",      icon: FileText, permKey: "bank_accounts" },
  { nameKey: "navExtra.cashBoxStatement", href: "/cash/reports/cash-box-statement", icon: FileText, permKey: "cash_boxes" },
  { nameKey: "navExtra.bankStatement",    href: "/cash/reports/bank-statement",     icon: FileText, permKey: "bank_accounts" },
  { nameKey: "navExtra.dailySummary",     href: "/cash/reports/daily-summary",      icon: FileText, permKey: "cash_boxes" },
  { nameKey: "navExtra.receiptsReport",   href: "/cash/reports/receipts",           icon: FileText, permKey: "receipt_vouchers" },
  { nameKey: "navExtra.paymentsReport",   href: "/cash/reports/payments",           icon: FileText, permKey: "payment_vouchers" },
  { nameKey: "navExtra.transfersReport",  href: "/cash/reports/transfers",          icon: FileText, permKey: "cash_boxes" },
];
const cashReportsHeader: NavDef = { nameKey: "nav.allReports", href: "/cash/reports", icon: BarChart2 };

function CashReportsNavGroup({
  location, onNavigate, open, onToggle,
}: { location: string; onNavigate: () => void; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth() as any;
  if (!groupVisible(user, CASH_REPORTS_PERMS)) return null;
  const isOnReports = location.startsWith("/cash/reports");
  return (
    <div>
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          isOnReports && !open
            ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
            : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )}
      >
        <BarChart2 className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-start">{t("nav.cashReports")}</span>
        {open
          ? <ChevronDown  className="h-3.5 w-3.5 shrink-0 opacity-60" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />}
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 start-[26px] w-px bg-sidebar-border/60" />
          <NavItem item={cashReportsHeader} location={location} onClick={onNavigate} indent />
          {cashReportsSubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
const DEFAULT_PERMS: Record<string, boolean> = {
  dashboard: true, invoices: true, customers: true, suppliers: true,
  zatca: true, reports: true, inventory: true,
};
function parseMenuPerms(raw: string | null | undefined): Record<string, boolean> {
  try { return { ...DEFAULT_PERMS, ...JSON.parse(raw ?? "{}") }; }
  catch { return { ...DEFAULT_PERMS }; }
}
const PLAN_KEYS: Record<string, string> = {
  starter: "plans.starter", professional: "plans.professional", enterprise: "plans.enterprise",
};

// ─── NavItem (stable, top-level component) ─────────────────────────────────────
function NavItem({
  item, location, onClick, indent = false,
}: {
  item: NavDef;
  location: string;
  onClick?: () => void;
  indent?: boolean;
}) {
  const { t } = useTranslation();
  const { user } = useAuth() as any;
  // Per-user permission filter — hide entirely when the user lacks .view perm
  // for this screen. Admins/superadmins always see everything (handled inside
  // navItemAllowed).
  if (!navItemAllowed(item, user)) return null;
  const isActive = item.exact
    ? location === item.href
    : location.startsWith(item.href) && item.href !== "/";
  // All internal sidebar sub-links (children of every main group) use a
  // purple text color per the user's request. The active row still uses the
  // contrasting "primary pill" highlight so the user always knows where they
  // are; only its label/icon color changes (white-on-pill stays).
  return (
    <div className={cn(
      "flex items-center rounded-lg pe-1 transition-colors group",
      isActive
        ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
        : "text-purple-700 hover:bg-purple-50 hover:text-purple-900 dark:text-purple-300 dark:hover:bg-purple-950/40 dark:hover:text-purple-100"
    )}>
      <Link href={item.href} className="block flex-1 min-w-0" onClick={onClick}>
        <span className={cn(
          "flex items-center gap-3 px-3 py-2 text-sm font-medium",
          indent && "ps-8",
        )}>
          <item.icon className="h-4 w-4 shrink-0" />
          {t(item.nameKey)}
        </span>
      </Link>
      <a
        href={item.href}
        target="_blank"
        rel="noopener noreferrer"
        title={t("nav.openInNewTab", "فتح في تبويب جديد")}
        className={cn(
          "p-1.5 rounded-md opacity-60 hover:opacity-100 hover:bg-black/10 dark:hover:bg-white/10 transition",
          isActive
            ? "text-sidebar-primary-foreground"
            : "text-purple-500 dark:text-purple-400",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}

// ─── PurchasingNavGroup ────────────────────────────────────────────────────────
// Suppliers/purchasing reports are nested INSIDE this group (per the user's
// request) — they no longer live as a sibling top-level item.
function PurchasingNavGroup({
  location, onNavigate, open, onToggle, reportsOpen, onReportsToggle,
}: {
  location: string;
  onNavigate: () => void;
  open: boolean;
  onToggle: () => void;
  reportsOpen: boolean;
  onReportsToggle: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth() as any;
  if (!groupVisible(user, PURCHASING_GROUP_PERMS)) return null;
  // Treat /purchasing/reports as part of the parent group so the parent stays
  // highlighted while the user is browsing inside its nested reports.
  const isOnPurchasing = (location.startsWith("/purchasing") || location.startsWith("/suppliers"));
  return (
    <div>
      <HubGroupButton
        hubHref="/purchasing"
        icon={ShoppingCart}
        label={t("nav.purchasingGroup")}
        isOn={isOnPurchasing}
        open={open}
        onToggle={onToggle}
        onNavigate={onNavigate}
      />
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 start-[26px] w-px bg-sidebar-border/60" />
          {purchasingSubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
          <PurchasingReportsNavGroup
            location={location}
            onNavigate={onNavigate}
            open={reportsOpen}
            onToggle={onReportsToggle}
          />
        </div>
      )}
    </div>
  );
}

// ─── SalesNavGroup ─────────────────────────────────────────────────────────────
// Reports for customers/sales are nested INSIDE this group (per the user's
// request) so they live under their parent module instead of as a sibling
// top-level menu. The reports sub-collapsible carries its own open state
// driven by `reportsOpen` / `onReportsToggle` (still managed in Layout
// state, just rendered here).
function SalesNavGroup({
  location, onNavigate, open, onToggle, reportsOpen, onReportsToggle,
}: {
  location: string;
  onNavigate: () => void;
  open: boolean;
  onToggle: () => void;
  reportsOpen: boolean;
  onReportsToggle: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth() as any;
  if (!groupVisible(user, SALES_GROUP_PERMS)) return null;
  // Treat /sales/reports as part of the parent group so the parent stays
  // highlighted while the user is browsing inside its nested reports.
  const isOnSales = location.startsWith("/sales") || location.startsWith("/customers");
  return (
    <div>
      <HubGroupButton
        hubHref="/sales"
        icon={ShoppingBag}
        label={t("nav.salesGroup")}
        isOn={isOnSales}
        open={open}
        onToggle={onToggle}
        onNavigate={onNavigate}
      />
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 start-[26px] w-px bg-sidebar-border/60" />
          {salesSubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
          <SalesReportsNavGroup
            location={location}
            onNavigate={onNavigate}
            open={reportsOpen}
            onToggle={onReportsToggle}
          />
        </div>
      )}
    </div>
  );
}

// ─── SalesReportsNavGroup ─────────────────────────────────────────────────────
const salesReportsSubNav: NavDef[] = [
  { nameKey: "navExtra.customerStatement",  href: "/sales/reports/customer-statement", icon: FileText, permKey: "sales_reports" },
  { nameKey: "navExtra.customerStatementDetailed", href: "/sales/reports/customer-statement-detailed", icon: FileText, permKey: "sales_reports" },
  { nameKey: "navExtra.customerBalances",   href: "/sales/reports/customer-balances",  icon: FileText, permKey: "sales_reports" },
  { nameKey: "navExtra.salesAging",         href: "/sales/reports/aging",              icon: FileText, permKey: "sales_reports" },
  { nameKey: "navExtra.salesByCustomer",    href: "/sales/reports/sales-by-customer",  icon: FileText, permKey: "sales_reports" },
  { nameKey: "navExtra.salesByItem",        href: "/sales/reports/sales-by-item",      icon: FileText, permKey: "sales_reports" },
  { nameKey: "navExtra.salesByPeriod",      href: "/sales/reports/sales-by-period",    icon: FileText, permKey: "sales_reports" },
  { nameKey: "navExtra.topCustomers",       href: "/sales/reports/top-customers",      icon: FileText, permKey: "sales_reports" },
  { nameKey: "navExtra.salesReturnsReport", href: "/sales/reports/returns",            icon: FileText, permKey: "sales_reports" },
];
const salesReportsHeader: NavDef = { nameKey: "nav.allReports", href: "/sales/reports", icon: BarChart2, permKey: "sales_reports" };

function SalesReportsNavGroup({
  location, onNavigate, open, onToggle,
}: {
  location: string;
  onNavigate: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth() as any;
  if (!groupVisible(user, SALES_REPORTS_PERMS)) return null;
  const isOnReports = location.startsWith("/sales/reports");
  return (
    <div>
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          isOnReports && !open
            ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
            : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )}
      >
        <BarChart2 className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-start">{t("navExtra.salesReportsGroup")}</span>
        {open
          ? <ChevronDown  className="h-3.5 w-3.5 shrink-0 opacity-60" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />}
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 start-[26px] w-px bg-sidebar-border/60" />
          <NavItem item={salesReportsHeader} location={location} onClick={onNavigate} indent />
          {salesReportsSubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── PurchasingReportsNavGroup ────────────────────────────────────────────────
const purchasingReportsSubNav: NavDef[] = [
  { nameKey: "navExtra.supplierStatement",      href: "/purchasing/reports/supplier-statement",    icon: FileText, permKey: "suppliers" },
  { nameKey: "navExtra.supplierStatementDetailed", href: "/purchasing/reports/supplier-statement-detailed", icon: FileText, permKey: "suppliers" },
  { nameKey: "navExtra.supplierBalances",       href: "/purchasing/reports/supplier-balances",     icon: FileText, permKey: "suppliers" },
  { nameKey: "navExtra.purchaseAging",          href: "/purchasing/reports/aging",                 icon: FileText, permKey: "purchase_invoices" },
  { nameKey: "navExtra.purchasesBySupplier",    href: "/purchasing/reports/purchases-by-supplier", icon: FileText, permKey: "purchase_invoices" },
  { nameKey: "navExtra.purchasesByItem",        href: "/purchasing/reports/purchases-by-item",     icon: FileText, permKey: "purchase_invoices" },
  { nameKey: "navExtra.purchasesByPeriod",      href: "/purchasing/reports/purchases-by-period",   icon: FileText, permKey: "purchase_invoices" },
  { nameKey: "navExtra.topSuppliers",           href: "/purchasing/reports/top-suppliers",         icon: FileText, permKey: "suppliers" },
  { nameKey: "navExtra.purchaseReturnsReport",  href: "/purchasing/reports/returns",               icon: FileText, permKey: "purchase_returns" },
];
const purchasingReportsHeader: NavDef = { nameKey: "nav.allReports", href: "/purchasing/reports", icon: BarChart2 };

function PurchasingReportsNavGroup({
  location, onNavigate, open, onToggle,
}: {
  location: string;
  onNavigate: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth() as any;
  if (!groupVisible(user, PURCHASING_REPORTS_PERMS)) return null;
  const isOnReports = location.startsWith("/purchasing/reports");
  return (
    <div>
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          isOnReports && !open
            ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
            : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )}
      >
        <BarChart2 className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-start">{t("navExtra.purchaseReportsGroup")}</span>
        {open
          ? <ChevronDown  className="h-3.5 w-3.5 shrink-0 opacity-60" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />}
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 start-[26px] w-px bg-sidebar-border/60" />
          <NavItem item={purchasingReportsHeader} location={location} onClick={onNavigate} indent />
          {purchasingReportsSubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── InventoryNavGroup (stable, top-level component) ──────────────────────────
// Inventory reports are nested INSIDE this group (per the user's request) so
// they live under their parent module instead of as a sibling top-level menu.
// The nested reports collapsible carries its own open state driven by
// `reportsOpen` / `onReportsToggle` (still managed in Layout state).
function InventoryNavGroup({
  location, onNavigate, open, onToggle, reportsOpen, onReportsToggle,
}: {
  location: string;
  onNavigate: () => void;
  open: boolean;
  onToggle: () => void;
  reportsOpen: boolean;
  onReportsToggle: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth() as any;
  if (!groupVisible(user, INVENTORY_GROUP_PERMS)) return null;
  // Treat /inventory/reports as part of the parent group so the parent stays
  // highlighted while the user is browsing inside its nested reports.
  const isOnInventory = location.startsWith("/inventory");
  return (
    <div>
      {/* Toggle button */}
      <HubGroupButton
        hubHref="/inventory"
        icon={Warehouse}
        label={t("navExtra.inventoryModule")}
        isOn={isOnInventory}
        open={open}
        onToggle={onToggle}
        onNavigate={onNavigate}
      />

      {/* Sub-items */}
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 start-[26px] w-px bg-sidebar-border/60" />
          <NavItem item={inventoryHeader} location={location} onClick={onNavigate} indent />
          {inventorySubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
          <InventoryReportsNavGroup
            location={location}
            onNavigate={onNavigate}
            open={reportsOpen}
            onToggle={onReportsToggle}
          />
        </div>
      )}
    </div>
  );
}

// ─── InventoryReportsNavGroup ─────────────────────────────────────────────────
function InventoryReportsNavGroup({
  location, onNavigate, open, onToggle,
}: {
  location: string;
  onNavigate: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth() as any;
  if (!groupVisible(user, INVENTORY_REPORTS_PERMS)) return null;
  const isOnReports = location.startsWith("/inventory/reports");
  return (
    <div>
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          isOnReports && !open
            ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
            : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )}
      >
        <BarChart2 className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-start">{t("nav.inventoryReports")}</span>
        {open
          ? <ChevronDown  className="h-3.5 w-3.5 shrink-0 opacity-60" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />}
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 start-[26px] w-px bg-sidebar-border/60" />
          <NavItem item={inventoryReportsHeader} location={location} onClick={onNavigate} indent />
          {inventoryReportsSubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── ReportsNavGroup ───────────────────────────────────────────────────────────
function ReportsNavGroup({
  location, onNavigate, open, onToggle,
}: {
  location: string;
  onNavigate: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth() as any;
  if (!groupVisible(user, ACCOUNTING_REPORTS_PERMS)) return null;
  const isOnReports = location.startsWith("/accounting/reports");
  return (
    <div>
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          isOnReports && !open
            ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
            : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )}
      >
        <BarChart2 className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-start">{t("navExtra.accountingReports")}</span>
        {open
          ? <ChevronDown  className="h-3.5 w-3.5 shrink-0 opacity-60" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
        }
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 start-[26px] w-px bg-sidebar-border/60" />
          {reportsSubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── DashboardNavGroup ─────────────────────────────────────────────────────────
// "لوحة التحكم" — pure collapsible group of settings/admin sub-items. The
// dashboard page itself ("/") is now reached via the separate top-level
// "لوحة المعلومات" entry rendered above this group.
function DashboardNavGroup({
  location, onNavigate, open, onToggle,
}: {
  location: string;
  onNavigate: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const isOnSub = location === "/control-panel" || dashboardSubNav.some(i => location.startsWith(i.href) && i.href !== "/");
  return (
    <div>
      <HubGroupButton
        hubHref="/control-panel"
        icon={Settings}
        label={t("nav.dashboard")}
        isOn={isOnSub}
        open={open}
        onToggle={onToggle}
        onNavigate={onNavigate}
      />
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 start-[26px] w-px bg-sidebar-border/60" />
          {dashboardSubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── ZatcaNavGroup ────────────────────────────────────────────────────────────
// Top-level "ربط ZATCA" group. Mirrors DashboardNavGroup but with its own
// hub href (/zatca, the most-frequently-clicked of the two children) so a
// single click on the group header takes the user straight to the integration
// landing page instead of needing to expand+click.
function ZatcaNavGroup({
  location, onNavigate, open, onToggle,
}: {
  location: string;
  onNavigate: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const isOnSub = zatcaGroupSubNav.some(i => location.startsWith(i.href));
  return (
    <div>
      <HubGroupButton
        hubHref="/zatca"
        icon={Link2}
        label={t("nav.zatcaGroup")}
        isOn={isOnSub}
        open={open}
        onToggle={onToggle}
        onNavigate={onNavigate}
      />
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 start-[26px] w-px bg-sidebar-border/60" />
          {zatcaGroupSubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── AccountingNavGroup ───────────────────────────────────────────────────────
// Accounting reports are nested INSIDE this group (per the user's request) —
// they no longer live as a sibling top-level item.
function AccountingNavGroup({
  location, onNavigate, open, onToggle, reportsOpen, onReportsToggle,
}: {
  location: string; onNavigate: () => void; open: boolean; onToggle: () => void;
  reportsOpen: boolean; onReportsToggle: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth() as any;
  if (!groupVisible(user, ACCOUNTING_GROUP_PERMS)) return null;
  // Treat /accounting/reports as part of the parent group so the parent stays
  // highlighted while the user is browsing inside its nested reports.
  const isOnSub = location.startsWith("/accounting") || accountingSubNav.some(i => location.startsWith(i.href));
  return (
    <div>
      <HubGroupButton
        hubHref="/accounting"
        icon={BookMarked}
        label={t("nav.accountingGroup")}
        isOn={isOnSub}
        open={open}
        onToggle={onToggle}
        onNavigate={onNavigate}
      />
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 start-[26px] w-px bg-sidebar-border/60" />
          {accountingSubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
          <ReportsNavGroup
            location={location}
            onNavigate={onNavigate}
            open={reportsOpen}
            onToggle={onReportsToggle}
          />
        </div>
      )}
    </div>
  );
}

// ─── PosNavGroup ──────────────────────────────────────────────────────────────
// Collapsible "إدارة نقاط البيع" (POS Management) group — collects the
// previously-flat posMonitoring / posTerminals / posSettings entries under
// a single parent (per the user's request).
function PosNavGroup({
  location, onNavigate, open, onToggle,
}: { location: string; onNavigate: () => void; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  if (!groupVisible(user, POS_GROUP_PERMS)) return null;
  const isOnSub = location.startsWith("/pos-management") || location.startsWith("/pos") || posSubNav.some(i => location.startsWith(i.href));
  return (
    <div>
      <HubGroupButton
        hubHref="/pos-management"
        icon={Store}
        label={t("nav.posManagement")}
        isOn={isOnSub}
        open={open}
        onToggle={onToggle}
        onNavigate={onNavigate}
      />
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 start-[26px] w-px bg-sidebar-border/60" />
          {posSubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── HrNavGroup ───────────────────────────────────────────────────────────────
function HrNavGroup({
  location, onNavigate, open, onToggle,
}: { location: string; onNavigate: () => void; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  if (!groupVisible(user, HR_GROUP_PERMS)) return null;
  const isOnSub = location.startsWith("/hr") || hrSubNav.some(i => location.startsWith(i.href));
  return (
    <div>
      <HubGroupButton
        hubHref="/hr"
        icon={UserCog}
        label={t("nav.hrEmployees")}
        isOn={isOnSub}
        open={open}
        onToggle={onToggle}
        onNavigate={onNavigate}
      />
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 start-[26px] w-px bg-sidebar-border/60" />
          {hrSubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── ProductionNavGroup ──────────────────────────────────────────────────────
// Collapsible "نظام الإنتاج والتصنيع" group — mirrors HrNavGroup but gated
// by a single `production` permission key. Visible to all admins/superadmins.
function ProductionNavGroup({
  location, onNavigate, open, onToggle,
}: { location: string; onNavigate: () => void; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  if (!groupVisible(user, PRODUCTION_GROUP_PERMS)) return null;
  const isOnSub = productionSubNav.some(i => location.startsWith(i.href));
  return (
    <div>
      <HubGroupButton
        hubHref="/production"
        icon={Factory}
        label={t("nav.productionGroup")}
        isOn={isOnSub}
        open={open}
        onToggle={onToggle}
        onNavigate={onNavigate}
      />
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 start-[26px] w-px bg-sidebar-border/60" />
          {productionSubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SecurityNavGroup ────────────────────────────────────────────────────────
// Collapsible "الأمن والمراقبة" group — mirrors ProductionNavGroup, gated
// by the `security_events` permission.
function SecurityNavGroup({
  location, onNavigate, open, onToggle,
}: { location: string; onNavigate: () => void; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  if (!groupVisible(user, SECURITY_GROUP_PERMS)) return null;
  const isOnSub = location === "/security" || securitySubNav.some(i => location.startsWith(i.href));
  return (
    <div>
      <HubGroupButton
        hubHref="/security"
        icon={ShieldAlert}
        label={t("security.nav.group")}
        isOn={isOnSub}
        open={open}
        onToggle={onToggle}
        onNavigate={onNavigate}
      />
      {open && (
        <div className="mt-0.5 space-y-0.5 relative">
          <div className="absolute top-0 bottom-0 start-[26px] w-px bg-sidebar-border/60" />
          {securitySubNav.map(item => (
            <NavItem key={item.href} item={item} location={location} onClick={onNavigate} indent />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SidebarInner (stable, top-level component) ───────────────────────────────
// All state that needs to persist lives in Layout and is passed as props here.
function SidebarInner({
  location,
  isSuperAdmin,
  user,
  menuPerms,
  dashboardOpen,
  onDashboardToggle,
  zatcaGroupOpen,
  onZatcaGroupToggle,
  inventoryOpen,
  onInventoryToggle,
  invReportsOpen,
  onInvReportsToggle,
  reportsOpen,
  onReportsToggle,
  purchasingOpen,
  onPurchasingToggle,
  purchasingReportsOpen,
  onPurchasingReportsToggle,
  salesOpen,
  onSalesToggle,
  salesReportsOpen,
  onSalesReportsToggle,
  cashOpen,
  onCashToggle,
  cashReportsOpen,
  onCashReportsToggle,
  accountingOpen,
  onAccountingToggle,
  hrOpen,
  onHrToggle,
  productionOpen,
  onProductionToggle,
  posOpen,
  onPosToggle,
  securityOpen,
  onSecurityToggle,
  onNavigate,
  onLogout,
}: {
  location: string;
  isSuperAdmin: boolean;
  user: any;
  menuPerms: Record<string, boolean>;
  dashboardOpen: boolean;
  onDashboardToggle: () => void;
  zatcaGroupOpen: boolean;
  onZatcaGroupToggle: () => void;
  inventoryOpen: boolean;
  onInventoryToggle: () => void;
  invReportsOpen: boolean;
  onInvReportsToggle: () => void;
  reportsOpen: boolean;
  onReportsToggle: () => void;
  purchasingOpen: boolean;
  onPurchasingToggle: () => void;
  purchasingReportsOpen: boolean;
  onPurchasingReportsToggle: () => void;
  salesOpen: boolean;
  onSalesToggle: () => void;
  salesReportsOpen: boolean;
  onSalesReportsToggle: () => void;
  cashOpen: boolean;
  onCashToggle: () => void;
  cashReportsOpen: boolean;
  onCashReportsToggle: () => void;
  accountingOpen: boolean;
  onAccountingToggle: () => void;
  hrOpen: boolean;
  onHrToggle: () => void;
  productionOpen: boolean;
  onProductionToggle: () => void;
  posOpen: boolean;
  onPosToggle: () => void;
  securityOpen: boolean;
  onSecurityToggle: () => void;
  onNavigate: () => void;
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  const filteredBusiness = companyBusinessNav.filter(i => !i.permKey || menuPerms[i.permKey] !== false);
  const filteredSystem   = companySystemNav.filter(i => !i.permKey || menuPerms[i.permKey] !== false);

  const planColor =
    user?.subscription?.plan === "starter"      ? "text-blue-700 bg-blue-50 border-blue-200" :
    user?.subscription?.plan === "professional" ? "text-primary bg-primary/10 border-primary/20" :
    user?.subscription?.plan === "enterprise"   ? "text-amber-700 bg-amber-50 border-amber-200" :
    "text-muted-foreground bg-muted border-border";

  return (
    <>
      {/* Logo */}
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-sidebar-border px-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm shadow">Z</div>
          <div>
            <p className="text-sm font-bold text-sidebar-foreground leading-tight">{t("auth.appName")}</p>
            <p className="text-[10px] text-sidebar-foreground/50 leading-tight">ZATCA e-Invoicing</p>
          </div>
        </div>
        <div className="hidden md:flex items-center gap-1 text-[10px] text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">
          <ShieldCheck className="h-2.5 w-2.5" /><span>ZATCA</span>
        </div>
      </div>

      {/* Context badge */}
      {isSuperAdmin ? (
        <div className="mx-3 mt-3 mb-1 rounded-lg border bg-purple-50 border-purple-200 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-3.5 w-3.5 text-purple-600 shrink-0" />
            <span className="text-xs font-semibold text-purple-800">{t("topbar.superAdminPanel")}</span>
          </div>
          <p className="text-[10px] text-purple-600 mt-0.5">{t("topbar.superAdminSub")}</p>
        </div>
      ) : user?.company ? (
        <div className="mx-3 mt-3 mb-1 rounded-lg border bg-sidebar-accent/40 px-3 py-2.5">
          <div className="flex items-center gap-2 mb-0.5">
            <Building2 className="h-3.5 w-3.5 text-sidebar-foreground/60 shrink-0" />
            <span className="text-xs font-semibold text-sidebar-foreground truncate">{user.company.nameAr}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-mono text-sidebar-foreground/50 truncate">{user.company.vatNumber}</span>
            {user.subscription?.plan && (
              <span className={cn("text-[10px] border rounded-full px-1.5 py-0 font-medium shrink-0", planColor)}>
                {PLAN_KEYS[user.subscription.plan] ? t(PLAN_KEYS[user.subscription.plan]) : user.subscription.plan}
              </span>
            )}
          </div>
        </div>
      ) : null}

      {/* Navigation */}
      <nav className="flex-1 px-3 py-2 space-y-4 overflow-y-auto">
        {isSuperAdmin ? (
          <div className="space-y-0.5">
            {superAdminNav.map(item => (
              <NavItem key={item.href} item={item} location={location} onClick={onNavigate} />
            ))}
          </div>
        ) : (
          <>
            {menuPerms.dashboard !== false && (
              <div className="space-y-0.5">
                <NavItem
                  item={{ nameKey: "nav.infoBoard", href: "/", icon: LayoutDashboard, exact: true }}
                  location={location}
                  onClick={onNavigate}
                />
                <DashboardNavGroup
                  location={location}
                  onNavigate={onNavigate}
                  open={dashboardOpen}
                  onToggle={onDashboardToggle}
                />
              </div>
            )}

            {menuPerms.zatca !== false && (
              <div className="space-y-0.5">
                <ZatcaNavGroup
                  location={location}
                  onNavigate={onNavigate}
                  open={zatcaGroupOpen}
                  onToggle={onZatcaGroupToggle}
                />
              </div>
            )}

            {menuPerms.inventory !== false && (
              <div className="space-y-0.5">
                <InventoryNavGroup
                  location={location}
                  onNavigate={onNavigate}
                  open={inventoryOpen}
                  onToggle={onInventoryToggle}
                  reportsOpen={invReportsOpen}
                  onReportsToggle={onInvReportsToggle}
                />
              </div>
            )}

            <div className="space-y-0.5">
              <SalesNavGroup
                location={location}
                onNavigate={onNavigate}
                open={salesOpen}
                onToggle={onSalesToggle}
                reportsOpen={salesReportsOpen}
                onReportsToggle={onSalesReportsToggle}
              />
            </div>

            <div className="space-y-0.5">
              <PurchasingNavGroup
                location={location}
                onNavigate={onNavigate}
                open={purchasingOpen}
                onToggle={onPurchasingToggle}
                reportsOpen={purchasingReportsOpen}
                onReportsToggle={onPurchasingReportsToggle}
              />
            </div>

            <div className="space-y-0.5">
              <CashNavGroup
                location={location}
                onNavigate={onNavigate}
                open={cashOpen}
                onToggle={onCashToggle}
                reportsOpen={cashReportsOpen}
                onReportsToggle={onCashReportsToggle}
              />
            </div>

            <div className="space-y-0.5">
              <AccountingNavGroup
                location={location}
                onNavigate={onNavigate}
                open={accountingOpen}
                onToggle={onAccountingToggle}
                reportsOpen={reportsOpen}
                onReportsToggle={onReportsToggle}
              />
            </div>

            {menuPerms.hr_module !== false && (
              <div className="space-y-0.5">
                <HrNavGroup
                  location={location}
                  onNavigate={onNavigate}
                  open={hrOpen}
                  onToggle={onHrToggle}
                />
              </div>
            )}

            <div className="space-y-0.5">
              <ProductionNavGroup
                location={location}
                onNavigate={onNavigate}
                open={productionOpen}
                onToggle={onProductionToggle}
              />
            </div>

            <div className="space-y-0.5">
              <PosNavGroup
                location={location}
                onNavigate={onNavigate}
                open={posOpen}
                onToggle={onPosToggle}
              />
            </div>

            <div className="space-y-0.5">
              <SecurityNavGroup
                location={location}
                onNavigate={onNavigate}
                open={securityOpen}
                onToggle={onSecurityToggle}
              />
            </div>

            {filteredBusiness.length > 0 && (
              <div className="space-y-0.5">
                {filteredBusiness.map(item => (
                  <NavItem key={item.href} item={item} location={location} onClick={onNavigate} />
                ))}
              </div>
            )}

            {filteredSystem.length > 0 && (
              <div className="space-y-0.5">
                {filteredSystem.map(item => (
                  <NavItem key={item.href} item={item} location={location} onClick={onNavigate} />
                ))}
              </div>
            )}
          </>
        )}
      </nav>

      {/* User footer */}
      <div className="border-t border-sidebar-border p-3">
        {!isSuperAdmin && user?.subscription && (
          <div className="mb-2 flex items-center gap-2 px-2 py-1.5 rounded-md bg-sidebar-accent/30 text-xs text-sidebar-foreground/60">
            <Package className="h-3 w-3 shrink-0" />
            <span>{t("topbar.expires")}: {user.subscription.endDate ? new Date(user.subscription.endDate).toLocaleDateString() : "—"}</span>
          </div>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-full items-center gap-3 rounded-lg px-2 py-2 hover:bg-sidebar-accent transition-colors text-start">
              <Avatar className="h-8 w-8 shrink-0">
                <AvatarFallback className={cn(
                  "text-xs font-bold",
                  isSuperAdmin ? "bg-purple-100 text-purple-700" : "bg-primary text-primary-foreground"
                )}>
                  {user?.username?.[0]?.toUpperCase() ?? "م"}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0 text-start">
                <p className="text-sm font-medium text-sidebar-foreground truncate">{user?.username ?? t("topbar.user")}</p>
                <p className="text-xs text-sidebar-foreground/50 truncate">
                  {isSuperAdmin ? t("topbar.superAdmin") : user?.role === "admin" ? t("topbar.manager") : t("topbar.user")}
                </p>
              </div>
              <ChevronDown className="h-3.5 w-3.5 text-sidebar-foreground/40 shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-52">
            <DropdownMenuLabel className="font-normal">
              <div>
                <p className="text-sm font-medium">{user?.username}</p>
                <p className="text-xs text-muted-foreground">
                  {isSuperAdmin ? t("topbar.superAdmin") : user?.role === "admin" ? t("topbar.companyManager") : t("topbar.user")}
                </p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="gap-2 cursor-pointer">
              <Link href="/settings">
                <Settings className="h-4 w-4" />{t("topbar.accountSettings")}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onLogout} className="text-destructive focus:text-destructive gap-2">
              <LogOut className="h-4 w-4" />{t("topbar.logout")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

// ─── Breadcrumb Resolver ──────────────────────────────────────────────────────
// Build a complete map of href → { label, parent } from all nav definitions
type CrumbInfo = { label: string; parent?: string };
const ROUTE_MAP: Record<string, CrumbInfo> = (() => {
  const map: Record<string, CrumbInfo> = {
    "/":                              { label: "nav.infoBoard" },
    "/companies":                     { label: "nav.companies" },
    "/customers":                     { label: "nav.customers" },
    "/customers/new":                 { label: "navExtra.newCustomer",       parent: "/customers" },
    "/suppliers/new":                 { label: "navExtra.newSupplier",       parent: "/suppliers" },
    "/invoices/new":                  { label: "navExtra.newInvoice",        parent: "/invoices" },
    "/settings":                      { label: "nav.settings" },
    "/admin/requests":                { label: "nav.registrationRequests" },
    "/admin/licenses":                { label: "nav.licenses" },
    "/admin/subscriptions":           { label: "nav.subscriptions" },
    "/admin/plans":                   { label: "nav.plans" },
    "/admin/modules":                 { label: "nav.modules" },
    "/admin/menu-permissions":        { label: "nav.menuPermissions" },
    "/inventory":                     { label: "navExtra.inventoryRoot" },
    "/cash":                          { label: "nav.cashGroup" },
    "/cash/reports":                  { label: "nav.cashReports", parent: "/cash" },
    "/purchasing":                    { label: "nav.purchasingGroup" },
    "/sales":                         { label: "nav.salesGroup" },
    "/sales/invoices/new":            { label: "navExtra.newSalesInvoice", parent: "/sales/invoices" },
    "/sales/quotations/new":          { label: "navExtra.newQuotation",    parent: "/sales/quotations" },
    "/sales/reports":                 { label: "navExtra.salesReportsGroup", parent: "/sales" },
    "/purchasing/reports":            { label: "navExtra.purchaseReportsGroup", parent: "/purchasing" },
    "/inventory/reports":             { label: "nav.inventoryReports", parent: "/inventory" },
    "/accounting":                    { label: "navExtra.accountingRoot" },
    "/accounting/fiscal-periods":     { label: "nav.fiscalPeriods", parent: "/accounting" },
    "/accounting/reports":            { label: "navExtra.accountingReports", parent: "/accounting" },
    "/org":                           { label: "navExtra.orgRoot" },
    // Virtual "POS Management" parent — has no dedicated route, but supplies
    // a breadcrumb label for posSubNav children below.
    "/pos-management":                 { label: "nav.posManagement" },
  };
  const all = [
    ...dashboardSubNav,
    ...purchasingSubNav.map(i => ({ ...i, parent: "/purchasing" })),
    ...salesSubNav.map(i => ({ ...i, parent: "/sales" })),
    ...companySystemNav.map(i => ({ ...i, parent: "/accounting" })),
    ...reportsSubNav.map(i => ({ ...i, parent: "/accounting/reports" })),
    ...cashSubNav.map(i => ({ ...i, parent: "/cash" })),
    ...cashReportsSubNav.map(i => ({ ...i, parent: "/cash/reports" })),
    salesReportsHeader,
    ...salesReportsSubNav.map(i => ({ ...i, parent: "/sales/reports" })),
    purchasingReportsHeader,
    ...purchasingReportsSubNav.map(i => ({ ...i, parent: "/purchasing/reports" })),
    inventoryHeader,
    ...inventorySubNav.map(i => ({ ...i, parent: "/inventory" })),
    inventoryReportsHeader,
    ...inventoryReportsSubNav.map(i => ({ ...i, parent: "/inventory/reports" })),
    ...companyBusinessNav,
    ...posSubNav.map(i => ({ ...i, parent: "/pos-management" })),
    ...hrSubNav,
    ...productionSubNav,
  ];
  for (const item of all) {
    map[item.href] = {
      label: (item as any).nameKey ?? (item as any).name ?? "",
      parent: (item as any).parent,
    };
  }
  return map;
})();

function getBreadcrumbs(location: string, t: (k: string) => string): { label: string; href?: string }[] {
  const resolve = (label: string) => label.includes(".") ? t(label) : label;
  if (location === "/") return [{ label: t("nav.infoBoard") }];
  const tryPaths: string[] = [];
  let current: string | undefined = location;
  while (current && current !== "/") {
    if (ROUTE_MAP[current]) { tryPaths.unshift(current); break; }
    const idx = current.lastIndexOf("/");
    current = idx > 0 ? current.slice(0, idx) : "/";
  }
  const chain: string[] = [];
  let cursor: string | undefined = tryPaths[0];
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    chain.unshift(cursor);
    cursor = ROUTE_MAP[cursor]?.parent;
  }
  const crumbs: { label: string; href?: string }[] = [{ label: t("topbar.home"), href: "/" }];
  for (let i = 0; i < chain.length; i++) {
    const path = chain[i];
    const info = ROUTE_MAP[path];
    if (!info) continue;
    crumbs.push({
      label: resolve(info.label),
      href: i === chain.length - 1 ? undefined : path,
    });
  }
  if (crumbs.length === 1) crumbs.push({ label: t("topbar.page") });
  return crumbs;
}

// ─── TopBar (Odoo-style header) ───────────────────────────────────────────────
function TopBar({
  location, user, isSuperAdmin, onMobileMenu, onLogout,
}: {
  location: string;
  user: any;
  isSuperAdmin: boolean;
  onMobileMenu: () => void;
  onLogout: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [, navigate] = useLocation();
  const crumbs = useMemo(() => getBreadcrumbs(location, t), [location, t, i18n.language]);

  // Update browser tab title to current page name (so opening in a new tab shows the screen name)
  useEffect(() => {
    const last = crumbs[crumbs.length - 1]?.label;
    const appName = t("app.name", "ZATCA e-Invoicing");
    document.title = last && last !== t("topbar.page") ? `${last} — ${appName}` : appName;
  }, [crumbs, t]);

  return (
    <header className="sticky top-0 z-10 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
      {/* Row 1: search + actions */}
      <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
        <Button
          variant="ghost" size="icon" className="md:hidden -ms-2"
          onClick={onMobileMenu}
        >
          <Menu className="h-5 w-5" />
        </Button>

        {/* Search */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute end-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            type="search"
            placeholder={t("topbar.quickSearch")}
            className="h-9 pe-9 ps-3 bg-muted/40 border-transparent focus-visible:bg-card focus-visible:border-input"
          />
        </div>

        <div className="flex-1" />

        {/* Right cluster */}
        <div className="flex items-center gap-1">
          {/* Quick links to documents */}
          <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-primary hover:bg-primary/10" title={t("nav.salesInvoices")}
            onClick={() => navigate("/sales/invoices")}>
            <ShoppingBag className="h-[18px] w-[18px]" />
          </Button>
          <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-orange-600 hover:bg-orange-50" title={t("nav.salesReturns")}
            onClick={() => navigate("/sales/returns")}>
            <Undo2 className="h-[18px] w-[18px]" />
          </Button>
          <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-primary hover:bg-primary/10" title={t("nav.purchaseInvoices")}
            onClick={() => navigate("/purchasing/invoices")}>
            <ShoppingCart className="h-[18px] w-[18px]" />
          </Button>
          <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-orange-600 hover:bg-orange-50" title={t("nav.purchaseReturns")}
            onClick={() => navigate("/purchasing/returns")}>
            <RotateCcw className="h-[18px] w-[18px]" />
          </Button>
          <div className="h-5 w-px bg-border mx-1" />
          <LanguageSwitcher variant="compact" />
          <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-foreground" title={t("topbar.help")}>
            <HelpCircle className="h-[18px] w-[18px]" />
          </Button>
          <NotificationBell />
          <SessionCountdown />
          {/* Manual-session indicator: shows the user's currently-selected
              session (admin-managed entity) and lets them switch on the fly.
              Self-hides when the user has no sessions assigned. Distinct from
              SessionCountdown which tracks the per-login work_sessions clock. */}
          <SessionIndicator />
          <div className="h-5 w-px bg-border mx-1" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-accent transition-colors">
                <Avatar className="h-7 w-7">
                  <AvatarFallback className={cn(
                    "text-[11px] font-bold",
                    isSuperAdmin ? "bg-purple-100 text-purple-700" : "bg-primary text-primary-foreground"
                  )}>
                    {user?.username?.[0]?.toUpperCase() ?? "م"}
                  </AvatarFallback>
                </Avatar>
                <div className="hidden lg:block text-start">
                  <p className="text-xs font-medium leading-tight">{user?.username ?? t("topbar.user")}</p>
                  <p className="text-[10px] text-muted-foreground leading-tight">
                    {isSuperAdmin ? t("topbar.superAdmin") : user?.role === "admin" ? t("topbar.manager") : t("topbar.user")}
                  </p>
                </div>
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground hidden lg:block" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="font-normal">
                <div>
                  <p className="text-sm font-medium">{user?.username}</p>
                  <p className="text-xs text-muted-foreground">
                    {isSuperAdmin ? t("topbar.superAdmin") : user?.role === "admin" ? t("topbar.companyManager") : t("topbar.user")}
                  </p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild className="gap-2 cursor-pointer">
                <Link href="/settings">
                  <Settings className="h-4 w-4" />{t("topbar.accountSettings")}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onLogout} className="text-destructive focus:text-destructive gap-2">
                <LogOut className="h-4 w-4" />{t("topbar.logout")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Row 2: breadcrumb + page title */}
      <div className="flex items-center gap-3 px-4 sm:px-6 py-2.5 border-t border-border/60 bg-muted/20">
        <nav className="flex items-center gap-1.5 text-xs flex-1 min-w-0 overflow-hidden">
          {crumbs.map((c, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <React.Fragment key={`${c.label}-${i}`}>
                {i > 0 && (i18n.dir() === "rtl"
                  ? <ChevronLeft className="h-3 w-3 text-muted-foreground/50 shrink-0" />
                  : <ChevronRight className="h-3 w-3 text-muted-foreground/50 shrink-0" />
                )}
                {c.href && !isLast ? (
                  <Link
                    href={c.href}
                    className="text-muted-foreground hover:text-foreground transition-colors truncate"
                  >
                    {i === 0 ? <Home className="h-3.5 w-3.5 inline -mt-0.5" /> : c.label}
                  </Link>
                ) : (
                  <span className={cn(
                    "truncate",
                    isLast ? "font-semibold text-foreground" : "text-muted-foreground"
                  )}>
                    {i === 0 && !isLast ? <Home className="h-3.5 w-3.5 inline -mt-0.5" /> : c.label}
                  </span>
                )}
              </React.Fragment>
            );
          })}
        </nav>
        <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-md bg-card border border-border/60 text-muted-foreground shrink-0">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          {t("topbar.online")}
        </span>
      </div>
    </header>
  );
}

// ─── Main Layout ───────────────────────────────────────────────────────────────
export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const [mobileOpen, setMobileOpen]           = useState(false);
  const [dashboardOpen, setDashboardOpen]     = useState(() =>
    ["/org/", "/general-settings", "/settings/currencies", "/settings/accounting-mappings", "/vat-declaration"].some(p => location.startsWith(p))
  );
  // ربط ZATCA group — auto-expanded when on /zatca or /invoices.
  const [zatcaGroupOpen, setZatcaGroupOpen]   = useState(() =>
    ["/zatca", "/invoices"].some(p => location.startsWith(p))
  );
  // Reports are nested INSIDE the inventory group, so any /inventory/* route
  // (including /inventory/reports/*) auto-expands the parent.
  const [inventoryOpen, setInventoryOpen]     = useState(() => location.startsWith("/inventory"));
  const [invReportsOpen, setInvReportsOpen]   = useState(() => location.startsWith("/inventory/reports"));
  const [reportsOpen, setReportsOpen]         = useState(() => location.startsWith("/accounting/reports"));
  // Reports are nested INSIDE the purchasing group, so any /purchasing/* route
  // (including /purchasing/reports/*) auto-expands the parent.
  const [purchasingOpen, setPurchasingOpen]   = useState(() => location.startsWith("/purchasing") || location.startsWith("/suppliers"));
  const [purchasingReportsOpen, setPurchasingReportsOpen] = useState(() => location.startsWith("/purchasing/reports"));
  // Sales reports are nested INSIDE the sales group, so any /sales/* route
  // (including /sales/reports/*) auto-expands the parent.
  const [salesOpen,      setSalesOpen]        = useState(() => location.startsWith("/sales") || location.startsWith("/customers"));
  const [salesReportsOpen, setSalesReportsOpen] = useState(() => location.startsWith("/sales/reports"));
  // Reports are nested INSIDE the cash group, so any /cash/* route
  // (including /cash/reports/*) auto-expands the parent.
  const [cashOpen,       setCashOpen]         = useState(() => location.startsWith("/cash"));
  const [cashReportsOpen, setCashReportsOpen] = useState(() => location.startsWith("/cash/reports"));
  // Reports are nested INSIDE the accounting group, so /accounting/reports/*
  // (in addition to accounts/journals) auto-expands the parent.
  const [accountingOpen, setAccountingOpen]   = useState(() => location.startsWith("/accounting/accounts") || location.startsWith("/accounting/journals") || location.startsWith("/accounting/reports"));
  const [hrOpen,         setHrOpen]           = useState(() => location.startsWith("/hr/"));
  const [productionOpen, setProductionOpen]   = useState(() => location.startsWith("/production"));
  // Auto-expand the POS group when the user lands directly on any of the
  // pos-monitoring / pos-terminals / pos-settings routes.
  const [posOpen,        setPosOpen]          = useState(() =>
    location.startsWith("/pos-monitoring") || location.startsWith("/pos-terminals") || location.startsWith("/pos-settings")
  );
  const [securityOpen,   setSecurityOpen]     = useState(() => location.startsWith("/security"));

  const isSuperAdmin = user?.role === "superadmin";
  const menuPerms    = parseMenuPerms(user?.company?.menuPermissions);

  // Accordion behavior — only ONE top-level group may be expanded at a time.
  // When the user opens a main group, every other top-level group collapses.
  // Sub-groups (the *Reports children inside Sales/Purchasing/Cash/Inventory/
  // Accounting) are NOT part of the accordion — they live inside their parent
  // and their own open/closed state is independent.
  type TopLevelGroup =
    | "dashboard" | "zatcaGroup" | "inventory" | "accounting"
    | "purchasing" | "sales" | "cash" | "hr" | "production"
    | "pos" | "security";
  const closeOtherTopLevelGroups = (keep: TopLevelGroup) => {
    if (keep !== "dashboard")  setDashboardOpen(false);
    if (keep !== "zatcaGroup") setZatcaGroupOpen(false);
    if (keep !== "inventory")  setInventoryOpen(false);
    if (keep !== "accounting") setAccountingOpen(false);
    if (keep !== "purchasing") setPurchasingOpen(false);
    if (keep !== "sales")      setSalesOpen(false);
    if (keep !== "cash")       setCashOpen(false);
    if (keep !== "hr")         setHrOpen(false);
    if (keep !== "production") setProductionOpen(false);
    if (keep !== "pos")        setPosOpen(false);
    if (keep !== "security")   setSecurityOpen(false);
  };
  // Each top-level toggle: flip its own state. When the row is currently
  // CLOSED (i.e. the click is about to OPEN it), also collapse every other
  // top-level group so the sidebar behaves as a single-pane accordion.
  // We compare against the currently-rendered `*Open` value (captured via
  // closure each render) so we can call `closeOtherTopLevelGroups` BEFORE
  // `setSelf` rather than from inside the updater function — which keeps
  // each setState call at the top level of the handler and avoids cascading
  // setState calls inside another setState's reducer.
  const makeAccordionToggle = (
    keep: TopLevelGroup,
    isOpenNow: boolean,
    setSelf: React.Dispatch<React.SetStateAction<boolean>>,
  ) => () => {
    if (!isOpenNow) closeOtherTopLevelGroups(keep);
    setSelf(v => !v);
  };
  const handleDashboardToggle  = makeAccordionToggle("dashboard",  dashboardOpen,  setDashboardOpen);
  const handleZatcaGroupToggle = makeAccordionToggle("zatcaGroup", zatcaGroupOpen, setZatcaGroupOpen);
  const handleInventoryToggle  = makeAccordionToggle("inventory",  inventoryOpen,  setInventoryOpen);
  const handleAccountingToggle = makeAccordionToggle("accounting", accountingOpen, setAccountingOpen);
  const handlePurchasingToggle = makeAccordionToggle("purchasing", purchasingOpen, setPurchasingOpen);
  const handleSalesToggle      = makeAccordionToggle("sales",      salesOpen,      setSalesOpen);
  const handleCashToggle       = makeAccordionToggle("cash",       cashOpen,       setCashOpen);
  const handleHrToggle         = makeAccordionToggle("hr",         hrOpen,         setHrOpen);
  const handleProductionToggle = makeAccordionToggle("production", productionOpen, setProductionOpen);
  const handlePosToggle        = makeAccordionToggle("pos",        posOpen,        setPosOpen);
  const handleSecurityToggle   = makeAccordionToggle("security",   securityOpen,   setSecurityOpen);
  // Sub-group toggles (nested reports) — independent of the accordion.
  const handleInvReportsToggle        = () => setInvReportsOpen(v => !v);
  const handleReportsToggle           = () => setReportsOpen(v => !v);
  const handlePurchasingReportsToggle = () => setPurchasingReportsOpen(v => !v);
  const handleSalesReportsToggle      = () => setSalesReportsOpen(v => !v);
  const handleCashReportsToggle       = () => setCashReportsOpen(v => !v);
  const closeMobile = () => setMobileOpen(false);

  // ─── Auto-expand groups on direct URL navigation ───────────────────────
  // The useState initializers above only run ONCE at mount. When the user
  // navigates between routes (via Link or by typing the URL), the relevant
  // group must auto-expand so the children become visible. We only OPEN
  // (never CLOSE) here so that a manual chevron-collapse stays sticky while
  // the user remains inside the group.
  useEffect(() => {
    // Resolve which (if any) top-level group the current URL belongs to. Only
    // one match is possible because the prefixes are disjoint. When a match is
    // found, open it AND collapse all other top-level groups so the accordion
    // stays consistent with the user clicking the group themselves.
    let target: TopLevelGroup | null = null;
    if (location.startsWith("/sales") || location.startsWith("/customers")) target = "sales";
    else if (location.startsWith("/purchasing") || location.startsWith("/suppliers")) target = "purchasing";
    else if (location.startsWith("/cash")) target = "cash";
    else if (location.startsWith("/accounting")) target = "accounting";
    else if (location.startsWith("/inventory")) target = "inventory";
    else if (location.startsWith("/production")) target = "production";
    else if (location.startsWith("/hr/") || location === "/hr") target = "hr";
    else if (location.startsWith("/security")) target = "security";
    else if (
      location.startsWith("/pos-monitoring") ||
      location.startsWith("/pos-terminals") ||
      location.startsWith("/pos-settings") ||
      location === "/pos-management"
    ) target = "pos";
    else if (
      ["/org/", "/general-settings", "/settings/",
       "/vat-declaration", "/users",
       "/control-panel"].some(p => location.startsWith(p))
    ) target = "dashboard";
    else if (["/zatca", "/invoices"].some(p => location.startsWith(p))) target = "zatcaGroup";

    if (target) {
      const setterByGroup: Record<TopLevelGroup, React.Dispatch<React.SetStateAction<boolean>>> = {
        dashboard:  setDashboardOpen,
        zatcaGroup: setZatcaGroupOpen,
        inventory:  setInventoryOpen,
        accounting: setAccountingOpen,
        purchasing: setPurchasingOpen,
        sales:      setSalesOpen,
        cash:       setCashOpen,
        hr:         setHrOpen,
        production: setProductionOpen,
        pos:        setPosOpen,
        security:   setSecurityOpen,
      };
      setterByGroup[target](true);
      closeOtherTopLevelGroups(target);
    }
  }, [location]);

  const sharedProps = {
    location,
    isSuperAdmin,
    user,
    menuPerms,
    dashboardOpen,
    onDashboardToggle: handleDashboardToggle,
    zatcaGroupOpen,
    onZatcaGroupToggle: handleZatcaGroupToggle,
    inventoryOpen,
    onInventoryToggle: handleInventoryToggle,
    invReportsOpen,
    onInvReportsToggle: handleInvReportsToggle,
    reportsOpen,
    onReportsToggle: handleReportsToggle,
    purchasingOpen,
    onPurchasingToggle: handlePurchasingToggle,
    purchasingReportsOpen,
    onPurchasingReportsToggle: handlePurchasingReportsToggle,
    salesOpen,
    onSalesToggle: handleSalesToggle,
    salesReportsOpen,
    onSalesReportsToggle: handleSalesReportsToggle,
    cashOpen,
    onCashToggle: handleCashToggle,
    cashReportsOpen,
    onCashReportsToggle: handleCashReportsToggle,
    accountingOpen,
    onAccountingToggle: handleAccountingToggle,
    hrOpen,
    onHrToggle: handleHrToggle,
    productionOpen,
    onProductionToggle: handleProductionToggle,
    posOpen,
    onPosToggle: handlePosToggle,
    securityOpen,
    onSecurityToggle: handleSecurityToggle,
    onNavigate: closeMobile,
    onLogout: logout,
  };

  const { i18n } = useTranslation();
  const langCode = normalizeLang(i18n.language);
  const langMeta = SUPPORTED_LANGUAGES.find(l => l.code === langCode) ?? SUPPORTED_LANGUAGES[0];
  const isRtl = langMeta.dir === "rtl";

  return (
    <div className="flex min-h-screen w-full flex-col bg-background" dir={langMeta.dir}>
      {/* Desktop Sidebar */}
      <aside className={cn(
        "fixed inset-y-0 z-20 hidden w-64 flex-col bg-sidebar md:flex",
        isRtl ? "right-0 border-l border-border" : "left-0 border-r border-border"
      )}>
        <SidebarInner {...sharedProps} />
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={closeMobile} />
      )}
      <aside className={cn(
        "fixed inset-y-0 z-40 flex w-72 flex-col bg-sidebar transition-transform duration-200 md:hidden",
        isRtl
          ? `right-0 border-l border-border ${mobileOpen ? "translate-x-0" : "translate-x-full"}`
          : `left-0 border-r border-border ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`
      )}>
        <SidebarInner {...sharedProps} />
      </aside>

      {/* Main content */}
      <div className={cn("flex flex-col min-h-screen", isRtl ? "md:mr-64" : "md:ml-64")}>
        <TopBar
          location={location}
          user={user}
          isSuperAdmin={isSuperAdmin}
          onMobileMenu={() => setMobileOpen(true)}
          onLogout={logout}
        />
        <main className="flex-1 p-4 sm:p-6 md:p-8 bg-muted/30">{children}</main>
      </div>

      {/* Manual-session picker: opens once per login when the user has 0 or
          >1 assigned sessions; auto-selects silently when there's exactly 1.
          Mounted globally so the prompt appears regardless of which page the
          user lands on after login. */}
      {/* Session picker is only forced on regular users — admins/superadmins
          assign sessions to employees and shouldn't be prompted to pick one
          themselves. The SessionIndicator in the topbar still lets them
          opt-in and switch sessions whenever they want. */}
      {!isSuperAdmin && user?.role !== "admin" && <SessionPickerModal />}

      {/* Global AI assistant — floating widget rendered on every authenticated
          screen. The component itself self-hides when the user is not
          authenticated and auto-derives the screen context from the URL. */}
      <ScreenAssistant />

      {/* Voice Assistant — floating mic widget. Self-hides when:
          • user is unauthenticated
          • voice_assistant_settings.enabled is false for the company
          • the browser does not support webkitSpeechRecognition
          The widget calls /api/voice-assistant/settings/me/effective on
          mount to read the gate flags. */}
      {!isSuperAdmin && <VoiceAssistantWidget />}
    </div>
  );
}
