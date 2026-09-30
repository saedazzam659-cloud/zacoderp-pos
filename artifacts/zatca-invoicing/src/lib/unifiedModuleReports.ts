import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ArrowLeftRight,
  BarChart3,
  BookOpen,
  Building2,
  CalendarDays,
  Clock3,
  CreditCard,
  FileText,
  Gift,
  Landmark,
  Package,
  RotateCcw,
  ShieldCheck,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { MODULE_GROUPS } from "./menuItems";

export type UnifiedReportModuleId =
  | "zatca"
  | "sales"
  | "purchasing"
  | "inventory"
  | "sister"
  | "cash"
  | "accounting"
  | "internal-control"
  | "hr"
  | "field-service"
  | "production"
  | "installments"
  | "fixed-assets"
  | "security"
  | "user-tracking";

export type UnifiedReportLink = {
  href: string;
  label: string;
  permissionKey: string;
  companyGateKey?: string;
  icon: LucideIcon;
};

export type UnifiedReportModule = {
  id: UnifiedReportModuleId;
  label: string;
  icon: LucideIcon;
  legacyHref: string;
  reports: UnifiedReportLink[];
};

type ReportAccess = Pick<UnifiedReportLink, "permissionKey" | "companyGateKey">;

// This map intentionally mirrors the permission used by the existing App
// routes. A screen is omitted from the chooser unless its permission is
// explicitly listed here.
const REPORT_ACCESS: Record<string, ReportAccess> = {
  "/zatca-report": { permissionKey: "zatca_report" },

  "/sales/reports/customer-statement": { permissionKey: "sales_reports" },
  "/sales/reports/customer-statement-detailed": { permissionKey: "sales_reports" },
  "/sales/reports/customer-balances": { permissionKey: "sales_reports" },
  "/sales/reports/invoice-payment-status": { permissionKey: "sales_reports" },
  "/sales/reports/aging": { permissionKey: "sales_reports" },
  "/sales/reports/sales-by-customer": { permissionKey: "sales_reports" },
  "/sales/reports/sales-by-item": { permissionKey: "sales_reports" },
  "/sales/reports/sales-by-period": { permissionKey: "sales_reports" },
  "/sales/reports/top-customers": { permissionKey: "sales_reports" },
  "/sales/reports/returns": { permissionKey: "sales_reports" },
  "/sales/reports/payment-mix": { permissionKey: "sales_reports" },
  "/sales/reports/daily-detailed": { permissionKey: "sales_reports" },
  "/sales/reports/profitability": { permissionKey: "sales_reports" },
  "/sales/reports/additional": {
    permissionKey: "sales_reports",
    companyGateKey: "additional_sales_reports",
  },

  "/purchasing/reports/supplier-statement": { permissionKey: "suppliers" },
  "/purchasing/reports/supplier-statement-detailed": { permissionKey: "suppliers" },
  "/purchasing/reports/supplier-balances": { permissionKey: "suppliers" },
  "/purchasing/reports/invoice-payment-status": { permissionKey: "purchase_invoices" },
  "/purchasing/reports/aging": { permissionKey: "purchase_invoices" },
  "/purchasing/reports/purchases-by-supplier": { permissionKey: "purchase_invoices" },
  "/purchasing/reports/purchases-by-item": { permissionKey: "purchase_invoices" },
  "/purchasing/reports/purchases-by-period": { permissionKey: "purchase_invoices" },
  "/purchasing/reports/purchases-vat-register": { permissionKey: "purchase_invoices" },
  "/purchasing/reports/top-suppliers": { permissionKey: "suppliers" },
  "/purchasing/reports/returns": { permissionKey: "purchase_returns" },
  "/purchasing/reports/lc-statement": { permissionKey: "purchase_invoices" },
  "/purchasing/reports/additional": {
    permissionKey: "purchase_invoices",
    companyGateKey: "additional_purchase_reports",
  },

  "/inventory/sister-statements": { permissionKey: "sister_companies" },

  "/cash/reports/cash-balances": { permissionKey: "cash_boxes" },
  "/cash/reports/bank-balances": { permissionKey: "bank_accounts" },
  "/cash/reports/cash-box-statement": { permissionKey: "cash_boxes" },
  "/cash/reports/bank-statement": { permissionKey: "bank_accounts" },
  "/cash/reports/daily-summary": { permissionKey: "cash_boxes" },
  "/cash/reports/receipts": { permissionKey: "receipt_vouchers" },
  "/cash/reports/payments": { permissionKey: "payment_vouchers" },
  "/cash/reports/transfers": { permissionKey: "cash_boxes" },
  "/cash/reports/bank-reconciliation": { permissionKey: "bank_accounts" },

  "/accounting/reports/account-statement": { permissionKey: "accounting_reports" },
  "/accounting/reports/trial-balance": { permissionKey: "accounting_reports" },
  "/accounting/reports/balance-sheet": { permissionKey: "accounting_reports" },
  "/accounting/reports/income-statement": { permissionKey: "accounting_reports" },
  "/accounting/reports/bank-cash-flow": { permissionKey: "accounting_reports" },
  "/accounting/reports/cash-flow": { permissionKey: "accounting_reports" },
  "/accounting/reports/forecast-income-statement": { permissionKey: "accounting_reports" },
  "/accounting/reports/tax-declaration": { permissionKey: "accounting_reports" },
  "/accounting/reports/adjustments-schedule": { permissionKey: "accounting_reports" },
  "/accounting/reports/additional": {
    permissionKey: "accounting_reports",
    companyGateKey: "additional_accounting_reports",
  },

  "/internal-control/permissions": { permissionKey: "internal_control_cases" },
  "/internal-control/documents": { permissionKey: "internal_control_cases" },
  "/internal-control/anomalies": { permissionKey: "internal_control_cases" },
  "/internal-control/projects": { permissionKey: "internal_control_cases" },
  "/internal-control/inventory": { permissionKey: "internal_control_cases" },
  "/internal-control/finance": { permissionKey: "internal_control_cases" },
  "/internal-control/log": { permissionKey: "internal_control_log" },
  "/internal-control/rules": { permissionKey: "internal_control_rules" },

  "/hr/reports/employees": { permissionKey: "hr_employees" },
  "/hr/reports/payroll": { permissionKey: "hr_payroll" },
  "/hr/reports/attendance": { permissionKey: "hr_attendance" },
  "/hr/reports/contracts": { permissionKey: "hr_employees" },
  "/hr/reports/documents": { permissionKey: "hr_employees" },
  "/hr/reports/loans": { permissionKey: "hr_loans" },
  "/hr/reports/eos": { permissionKey: "hr_eos" },
  "/hr/reports/employee-cost": { permissionKey: "hr_payroll" },
  "/hr/reports/leaves": { permissionKey: "hr_employees" },

  "/hr/field/reports": {
    permissionKey: "field_service_reports",
    companyGateKey: "field_service",
  },

  "/production/quality-report": { permissionKey: "production" },
  "/production/waste-report": { permissionKey: "production" },
  "/production/operator-performance": { permissionKey: "production" },
  "/production/my-performance": { permissionKey: "production" },

  "/installments/reports": { permissionKey: "installments" },
  "/fixed-assets/reports": { permissionKey: "fixed_assets" },
  "/security/reports": { permissionKey: "security_events" },
  "/user-tracking/attendance": { permissionKey: "user_tracking" },
  "/user-tracking/movement-report": { permissionKey: "user_tracking" },
};

const GROUP_TO_MODULE: Partial<Record<string, UnifiedReportModuleId>> = {
  zatca: "zatca",
  sales: "sales",
  purchasing: "purchasing",
  sister: "sister",
  cash: "cash",
  accounting: "accounting",
  additionalAccountingReports: "accounting",
  internalControl: "internal-control",
  hr: "hr",
  field_service: "field-service",
  production: "production",
  installments: "installments",
  fixedAssets: "fixed-assets",
  security: "security",
  liveMonitoring: "user-tracking",
};

const MODULE_PRESENTATION: Record<
  UnifiedReportModuleId,
  { label: string; icon: LucideIcon; legacyHref: string }
> = {
  zatca: { label: "تقارير ZATCA", icon: FileText, legacyHref: "/zatca-report" },
  sales: { label: "تقارير المبيعات", icon: TrendingUp, legacyHref: "/sales/reports" },
  purchasing: { label: "تقارير المشتريات", icon: Package, legacyHref: "/purchasing/reports" },
  inventory: { label: "تقارير المخازن", icon: Package, legacyHref: "/inventory/reports" },
  sister: { label: "تقارير الشركات الشقيقة", icon: Building2, legacyHref: "/inventory/sister-statements" },
  cash: { label: "تقارير النقد والبنوك", icon: Wallet, legacyHref: "/cash/reports" },
  accounting: { label: "التقارير المحاسبية", icon: BookOpen, legacyHref: "/accounting/reports" },
  "internal-control": { label: "تقارير الرقابة الداخلية", icon: ShieldCheck, legacyHref: "/internal-control" },
  hr: { label: "تقارير الموارد البشرية", icon: Users, legacyHref: "/hr/reports" },
  "field-service": { label: "تقارير الخدمة الميدانية", icon: Activity, legacyHref: "/hr/field/reports" },
  production: { label: "تقارير الإنتاج", icon: BarChart3, legacyHref: "/production" },
  installments: { label: "تقارير التقسيط", icon: CreditCard, legacyHref: "/installments/reports" },
  "fixed-assets": { label: "تقارير الأصول الثابتة", icon: Landmark, legacyHref: "/fixed-assets/reports" },
  security: { label: "تقارير الأمن", icon: ShieldCheck, legacyHref: "/security/reports" },
  "user-tracking": { label: "تقارير تتبع المستخدمين", icon: Activity, legacyHref: "/user-tracking" },
};

export const UNIFIED_REPORT_MODULE_OPTIONS = Object.entries(MODULE_PRESENTATION).map(
  ([id, presentation]) => ({ id: id as UnifiedReportModuleId, label: presentation.label }),
);

const EXTRA_REPORTS: Array<{
  moduleId: UnifiedReportModuleId;
  href: string;
  label: string;
  permissionKey: string;
  companyGateKey?: string;
}> = [
  { moduleId: "zatca", href: "/vat-declaration", label: "إقرار ضريبة القيمة المضافة", permissionKey: "vat_declaration" },
  { moduleId: "sales", href: "/sales/reports/daily", label: "تقرير المبيعات اليومي", permissionKey: "sales_reports" },
  { moduleId: "sales", href: "/sales/reports/free-returns", label: "مرتجع الكميات المجانية", permissionKey: "sales_reports" },
  { moduleId: "cash", href: "/cash/reports/bank-reconciliation", label: "مطابقة كشف البنك", permissionKey: "bank_accounts" },
  { moduleId: "hr", href: "/hr/reports/employees", label: "تقرير الموظفين", permissionKey: "hr_employees" },
  { moduleId: "hr", href: "/hr/reports/payroll", label: "تقرير الرواتب", permissionKey: "hr_payroll" },
  { moduleId: "hr", href: "/hr/reports/attendance", label: "تقرير الحضور والانصراف", permissionKey: "hr_attendance" },
  { moduleId: "hr", href: "/hr/reports/contracts", label: "تقرير العقود", permissionKey: "hr_employees" },
  { moduleId: "hr", href: "/hr/reports/documents", label: "تقرير انتهاء الوثائق", permissionKey: "hr_employees" },
  { moduleId: "hr", href: "/hr/reports/loans", label: "تقرير السلف", permissionKey: "hr_loans" },
  { moduleId: "hr", href: "/hr/reports/eos", label: "تقرير نهاية الخدمة", permissionKey: "hr_eos" },
  { moduleId: "hr", href: "/hr/reports/employee-cost", label: "تقرير تكلفة الموظفين", permissionKey: "hr_payroll" },
  { moduleId: "hr", href: "/hr/reports/leaves", label: "تقرير الإجازات", permissionKey: "hr_employees" },
];

const REPORT_ICONS: Array<{ match: RegExp; icon: LucideIcon }> = [
  { match: /statement|ledger|كشف|دفتر|سجل/i, icon: BookOpen },
  { match: /balance|aging|رصيد|أرصدة|ذمم/i, icon: Wallet },
  { match: /sales-by|purchases-by|period|daily|يومي|فترة|حسب/i, icon: BarChart3 },
  { match: /return|مرتجع/i, icon: RotateCcw },
  { match: /payment|cash|bank|قبض|صرف|بنك|نقد/i, icon: ArrowLeftRight },
  { match: /employee|payroll|attendance|contracts|leaves|موظف|رواتب|حضور|عقود|إجازة/i, icon: Users },
  { match: /vat|tax|ضريبة|إقرار/i, icon: FileText },
  { match: /stock|item|warehouse|batch|expiry|مخزون|صنف|مخزن|دفعات|صلاحية/i, icon: Package },
  { match: /performance|quality|waste|أداء|جودة|هالك/i, icon: TrendingUp },
  { match: /installment|credit|تقسيط|اعتماد/i, icon: CreditCard },
  { match: /security|permissions|rules|أمن|صلاحيات|قواعد/i, icon: ShieldCheck },
  { match: /schedule|calendar|جدول/i, icon: CalendarDays },
  { match: /sister|شقيقة/i, icon: Building2 },
  { match: /clock|time|وقت/i, icon: Clock3 },
  { match: /gift|free|مجاني/i, icon: Gift },
];

function iconForReport(label: string): LucideIcon {
  return REPORT_ICONS.find(({ match }) => match.test(label))?.icon ?? FileText;
}

const modules = new Map<UnifiedReportModuleId, UnifiedReportModule>();

for (const group of MODULE_GROUPS) {
  const moduleId = GROUP_TO_MODULE[group.key];
  if (!moduleId || moduleId === "inventory") continue;

  const presentation = MODULE_PRESENTATION[moduleId];
  let module = modules.get(moduleId);
  if (!module) {
    module = { id: moduleId, ...presentation, reports: [] };
    modules.set(moduleId, module);
  }

  for (const screen of group.screens) {
    if (!screen.report) continue;
    const access = REPORT_ACCESS[screen.path];
    if (!access) continue;
    if (module.reports.some((report) => report.href === screen.path)) continue;
    module.reports.push({
      href: screen.path,
      label: screen.label,
      ...access,
      icon: iconForReport(screen.label),
    });
  }
}

for (const report of EXTRA_REPORTS) {
  let module = modules.get(report.moduleId);
  if (!module) {
    module = {
      id: report.moduleId,
      ...MODULE_PRESENTATION[report.moduleId],
      reports: [],
    };
    modules.set(report.moduleId, module);
  }
  if (module.reports.some((item) => item.href === report.href)) continue;
  module.reports.push({
    href: report.href,
    label: report.label,
    permissionKey: report.permissionKey,
    companyGateKey: report.companyGateKey,
    icon: iconForReport(report.label),
  });
}

export const UNIFIED_REPORT_MODULES = Array.from(modules.values())
  .filter((module) => module.reports.length > 0);

export function getUnifiedReportModule(
  id: string | undefined,
): UnifiedReportModule | undefined {
  return UNIFIED_REPORT_MODULES.find((module) => module.id === id);
}