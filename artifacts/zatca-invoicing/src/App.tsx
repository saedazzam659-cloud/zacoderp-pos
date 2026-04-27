import { Switch, Route, Router as WouterRouter, useLocation, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Layout from "@/components/Layout";
import PermRoute from "@/components/PermRoute";
import Dashboard from "@/pages/Dashboard";
import SuperAdminDashboard from "@/pages/SuperAdminDashboard";
import OrphanStockCleanup from "@/pages/admin/OrphanStockCleanup";
import AICompanyFix from "@/pages/admin/AICompanyFix";
import SupportInbox from "@/pages/admin/SupportInbox";
import SupportSettings from "@/pages/admin/SupportSettings";
import AuditLog from "@/pages/admin/AuditLog";
import WorkSessions from "@/pages/WorkSessions";
import WorkSessionSettings from "@/pages/WorkSessionSettings";
import VoiceAssistantSettings from "@/pages/VoiceAssistantSettings";
import SessionsAdmin from "@/pages/SessionsAdmin";
import SecurityCenter from "@/pages/admin/SecurityCenter";
import SuperAdminSecurity from "@/pages/admin/SuperAdminSecurity";
import RecoverSuperAdmin from "@/pages/RecoverSuperAdmin";
import ReportsHub from "@/pages/admin/reports/ReportsHub";
import CompanyPerformanceReport from "@/pages/admin/reports/CompanyPerformanceReport";
import OperationalSummaryReport from "@/pages/admin/reports/OperationalSummaryReport";
import PlanUsageReport from "@/pages/admin/reports/PlanUsageReport";
import RevenueByPlanReport from "@/pages/admin/reports/RevenueByPlanReport";
import Notifications from "@/pages/Notifications";
import RegistrationRequests from "@/pages/RegistrationRequests";
import Companies from "@/pages/Companies";
import CompanyNew from "@/pages/CompanyNew";
import CompanyDetails from "@/pages/CompanyDetails";
import Customers from "@/pages/Customers";
import CustomerNew from "@/pages/CustomerNew";
import Invoices from "@/pages/Invoices";
import InvoiceNew from "@/pages/InvoiceNew";
import InvoiceDetails from "@/pages/InvoiceDetails";
import Suppliers from "@/pages/Suppliers";
import SupplierNew from "@/pages/SupplierNew";
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import PendingApproval from "@/pages/PendingApproval";
import Settings from "@/pages/Settings";
import SubscriptionManagement from "@/pages/SubscriptionManagement";
import PlanSettings from "@/pages/PlanSettings";
import ZatcaIntegration from "@/pages/ZatcaIntegration";
import ZatcaBridge from "@/pages/ZatcaBridge";
import ZatcaReport from "@/pages/ZatcaReport";
import Users from "@/pages/Users";
import MenuPermissions from "@/pages/MenuPermissions";
import Modules from "@/pages/admin/Modules";
import LicenseManagement from "@/pages/LicenseManagement";
import BackupOperations from "@/pages/BackupOperations";
import GeneralSettings from "@/pages/GeneralSettings";
import VATDeclaration from "@/pages/VATDeclaration";
// Hubs (Odoo-style large-tile landing pages)
import SalesHub from "@/pages/sales/SalesHub";
import PurchasingHub from "@/pages/purchasing/PurchasingHub";
import CashHub from "@/pages/cash/CashHub";
import AccountingHub from "@/pages/accounting/AccountingHub";
import HrHub from "@/pages/hr/HrHub";
import SecurityHub from "@/pages/security/SecurityHub";
import SecurityEvents from "@/pages/security/SecurityEvents";
import SecurityNotificationRules from "@/pages/security/SecurityNotificationRules";
import PosHub from "@/pages/pos/PosHub";
import ControlPanelHub from "@/pages/ControlPanelHub";
// HR
import Employees from "@/pages/hr/Employees";
import EmployeeContracts from "@/pages/hr/EmployeeContracts";
import Attendance from "@/pages/hr/Attendance";
import EmployeeLoans from "@/pages/hr/EmployeeLoans";
import Payroll from "@/pages/hr/Payroll";
import AllContracts from "@/pages/hr/AllContracts";
import EndOfService from "@/pages/hr/EndOfService";
import ProductionDashboard from "@/pages/ProductionDashboard";
import ProductionOrders from "@/pages/ProductionOrders";
import ProductionOrderDetail from "@/pages/ProductionOrderDetail";
import ProductionResources from "@/pages/ProductionResources";
import HRCalculators from "@/pages/hr/HRCalculators";
import HRSettings from "@/pages/hr/HRSettings";
import HRReportsHub from "@/pages/hr/reports/HRReportsHub";
import FaceAttendanceHub from "@/pages/hr/face/FaceAttendanceHub";
import FaceEnrollment from "@/pages/hr/face/FaceEnrollment";
import LiveAttendanceKiosk from "@/pages/hr/face/LiveAttendanceKiosk";
import AttendanceCameras from "@/pages/hr/face/AttendanceCameras";
import FaceAttendanceLogs from "@/pages/hr/face/FaceAttendanceLogs";
import FaceAttendanceSettings from "@/pages/hr/face/FaceAttendanceSettings";
import HRReportEmployees from "@/pages/hr/reports/EmployeesReport";
import HRReportPayroll from "@/pages/hr/reports/PayrollReport";
import HRReportAttendance from "@/pages/hr/reports/AttendanceReport";
import HRReportContracts from "@/pages/hr/reports/ContractsReport";
import HRReportDocuments from "@/pages/hr/reports/DocumentsExpiryReport";
import HRReportLoans from "@/pages/hr/reports/LoansReport";
import HRReportEos from "@/pages/hr/reports/EOSReport";
import HRReportEmployeeCost from "@/pages/hr/reports/EmployeeCostReport";
import HRReportLeaves from "@/pages/hr/reports/LeavesReport";
import PosMonitoring from "@/pages/pos/Monitoring";
import PosSettings from "@/pages/pos/PosSettings";
import PosTerminals from "@/pages/pos/PosTerminals";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { ScreenActionsProvider } from "@/contexts/ScreenActionsContext";
import { Loader2 } from "lucide-react";
// Inventory
import InventoryDashboard from "@/pages/inventory/InventoryDashboard";
import WarehouseGroups from "@/pages/inventory/WarehouseGroups";
import Warehouses from "@/pages/inventory/Warehouses";
import ItemGroups from "@/pages/inventory/ItemGroups";
import Units from "@/pages/inventory/Units";
import Items from "@/pages/inventory/Items";
import Offers from "@/pages/inventory/Offers";
import OfferForm from "@/pages/inventory/OfferForm";
import StockTransfer from "@/pages/inventory/StockTransfer";
import StockAdjustment from "@/pages/inventory/StockAdjustment";
import StockCounting from "@/pages/inventory/StockCounting";
import StockLedger from "@/pages/inventory/StockLedger";
import StockBalance from "@/pages/inventory/StockBalance";
// Inventory Reports
import InventoryReportsHub  from "@/pages/inventory/reports/InventoryReportsHub";
import ItemCard              from "@/pages/inventory/reports/ItemCard";
import LowStockReport        from "@/pages/inventory/reports/LowStockReport";
import ValuationByWarehouse  from "@/pages/inventory/reports/ValuationByWarehouse";
import SlowMovingItems       from "@/pages/inventory/reports/SlowMovingItems";
// Accounting
import ChartOfAccounts from "@/pages/accounting/ChartOfAccounts";
import Regions  from "@/pages/org/Regions";
import Branches from "@/pages/org/Branches";
import JournalEntries from "@/pages/accounting/JournalEntries";
import JournalEntryForm from "@/pages/accounting/JournalEntryForm";
import Currencies from "@/pages/settings/Currencies";
import AccountingMappings from "@/pages/settings/AccountingMappings";
import DataImportExport from "@/pages/settings/DataImportExport";
import Sequences from "@/pages/settings/Sequences";
import SalesReps from "@/pages/sales/SalesReps";
// Accounting Reports
import AccountStatement from "@/pages/accounting/reports/AccountStatement";
import TrialBalance     from "@/pages/accounting/reports/TrialBalance";
import BalanceSheet     from "@/pages/accounting/reports/BalanceSheet";
import IncomeStatement  from "@/pages/accounting/reports/IncomeStatement";
import FiscalPeriods    from "@/pages/accounting/FiscalPeriods";
import CostCenters     from "@/pages/accounting/CostCenters";
// Purchasing
import SupplierGroups       from "@/pages/purchasing/SupplierGroups";
import LetterOfCredit       from "@/pages/purchasing/LetterOfCredit";
import PurchaseInvoices     from "@/pages/purchasing/PurchaseInvoices";
import PurchaseInvoiceForm  from "@/pages/purchasing/PurchaseInvoiceForm";
import PurchaseOrders       from "@/pages/purchasing/PurchaseOrders";
import PurchaseOrderForm    from "@/pages/purchasing/PurchaseOrderForm";
import PurchaseReturns      from "@/pages/purchasing/PurchaseReturns";
import SupplierSettlement   from "@/pages/purchasing/SupplierSettlement";
// Sales Reports
import SalesReportsHub      from "@/pages/sales/reports/SalesReportsHub";
import CustomerStatement    from "@/pages/sales/reports/CustomerStatement";
import CustomerStatementDetailed from "@/pages/sales/reports/CustomerStatementDetailed";
import CustomerBalances     from "@/pages/sales/reports/CustomerBalances";
import AgingReport          from "@/pages/sales/reports/AgingReport";
import SalesByCustomer      from "@/pages/sales/reports/SalesByCustomer";
import SalesByItem          from "@/pages/sales/reports/SalesByItem";
import SalesByPeriod        from "@/pages/sales/reports/SalesByPeriod";
import DailyReport          from "@/pages/sales/reports/DailyReport";
import TopCustomers         from "@/pages/sales/reports/TopCustomers";
import SalesReturnsReport   from "@/pages/sales/reports/SalesReturnsReport";
import PurchaseReportsHub      from "@/pages/purchasing/reports/PurchaseReportsHub";
import SupplierStatement       from "@/pages/purchasing/reports/SupplierStatement";
import SupplierStatementDetailed from "@/pages/purchasing/reports/SupplierStatementDetailed";
import SupplierBalances        from "@/pages/purchasing/reports/SupplierBalances";
import SupplierAgingReport     from "@/pages/purchasing/reports/SupplierAgingReport";
import PurchasesBySupplier     from "@/pages/purchasing/reports/PurchasesBySupplier";
import PurchasesByItem         from "@/pages/purchasing/reports/PurchasesByItem";
import PurchasesByPeriod       from "@/pages/purchasing/reports/PurchasesByPeriod";
import TopSuppliers            from "@/pages/purchasing/reports/TopSuppliers";
import PurchaseReturnsReport   from "@/pages/purchasing/reports/PurchaseReturnsReport";

import CashReportsHub          from "@/pages/cash/reports/CashReportsHub";
import CashBalances            from "@/pages/cash/reports/CashBalances";
import BankBalances            from "@/pages/cash/reports/BankBalances";
import CashBoxStatement        from "@/pages/cash/reports/CashBoxStatement";
import BankAccountStatement    from "@/pages/cash/reports/BankAccountStatement";
import CashFlowReport          from "@/pages/cash/reports/CashFlowReport";
import ReceiptVouchersReport   from "@/pages/cash/reports/ReceiptVouchersReport";
import PaymentVouchersReport   from "@/pages/cash/reports/PaymentVouchersReport";
import TransfersReport         from "@/pages/cash/reports/TransfersReport";
// Sales
import SalesInvoices        from "@/pages/sales/SalesInvoices";
import SalesInvoiceForm     from "@/pages/sales/SalesInvoiceForm";
import SalesQuotations      from "@/pages/sales/SalesQuotations";
import SalesQuotationForm   from "@/pages/sales/SalesQuotationForm";
import SalesOrders          from "@/pages/sales/SalesOrders";
import SalesOrderForm       from "@/pages/sales/SalesOrderForm";
import SalesReturns         from "@/pages/sales/SalesReturns";
import CustomerSettlement   from "@/pages/sales/CustomerSettlement";

import CashBoxes        from "@/pages/cash/CashBoxes";
import BankAccounts     from "@/pages/cash/BankAccounts";
import ReceiptVouchers  from "@/pages/cash/ReceiptVouchers";
import PaymentVouchers  from "@/pages/cash/PaymentVouchers";
import CashTransfers    from "@/pages/cash/CashTransfers";

const queryClient = new QueryClient();

function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background" dir="rtl">
      <div className="text-center space-y-3">
        <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto" />
        <p className="text-sm text-muted-foreground">جاري التحقق من الجلسة...</p>
      </div>
    </div>
  );
}

const PUBLIC_PATHS = ["/login", "/register", "/pending-approval"];

function AppRoutes() {
  const { isAuthenticated, loading, user } = useAuth();
  const [location] = useLocation();

  if (loading) return <LoadingScreen />;

  const isPublic = PUBLIC_PATHS.some(p => location === p || location.startsWith(p));

  // Redirect logged-in users away from auth pages
  if (isAuthenticated && (location === "/login" || location === "/register")) {
    return <Redirect to="/" />;
  }

  // Redirect unauthenticated users to login
  if (!isAuthenticated && !isPublic) {
    return <Redirect to="/login" />;
  }

  const isSuperAdmin = user?.role === "superadmin";

  return (
    <Switch>
      {/* Public routes */}
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      <Route path="/pending-approval" component={PendingApproval} />
      <Route path="/recover-superadmin" component={RecoverSuperAdmin} />
      <Route path="/recover-superadmin/:token" component={RecoverSuperAdmin} />

      {/* Protected routes */}
      <Route>
        <Layout>
          <Switch>
            {/* Superadmin routes */}
            {isSuperAdmin && <Route path="/" component={SuperAdminDashboard} />}
            {isSuperAdmin && <Route path="/admin/requests" component={RegistrationRequests} />}
            {isSuperAdmin && <Route path="/companies" component={Companies} />}
            {isSuperAdmin && <Route path="/companies/new" component={CompanyNew} />}
            {isSuperAdmin && <Route path="/companies/:id" component={CompanyDetails} />}
            {isSuperAdmin && <Route path="/admin/subscriptions" component={SubscriptionManagement} />}
            {isSuperAdmin && <Route path="/admin/plans" component={PlanSettings} />}
            {isSuperAdmin && <Route path="/admin/menu-permissions" component={MenuPermissions} />}
            {isSuperAdmin && <Route path="/admin/modules" component={Modules} />}
            {isSuperAdmin && <Route path="/admin/licenses" component={LicenseManagement} />}
            {isSuperAdmin && <Route path="/admin/security-superadmin" component={SuperAdminSecurity} />}
            {isSuperAdmin && <Route path="/admin/security" component={SecurityCenter} />}
            {isSuperAdmin && <Route path="/admin/reports" component={ReportsHub} />}
            {isSuperAdmin && <Route path="/admin/reports/company-performance" component={CompanyPerformanceReport} />}
            {isSuperAdmin && <Route path="/admin/reports/operational-summary" component={OperationalSummaryReport} />}
            {isSuperAdmin && <Route path="/admin/reports/plan-usage" component={PlanUsageReport} />}
            {isSuperAdmin && <Route path="/admin/reports/revenue-by-plan" component={RevenueByPlanReport} />}
            {isSuperAdmin && <Route path="/admin/backups" component={BackupOperations} />}
            {isSuperAdmin && <Route path="/admin/orphan-stock" component={OrphanStockCleanup} />}
            {isSuperAdmin && <Route path="/admin/ai-fix" component={AICompanyFix} />}
            {isSuperAdmin && <Route path="/admin/support" component={SupportInbox} />}
            {isSuperAdmin && <Route path="/admin/support-settings" component={SupportSettings} />}
            {(isSuperAdmin || user?.role === "admin") && <Route path="/admin/audit-log" component={AuditLog} />}
            {/* Work sessions are inherently per-company/per-user. Superadmin
                has no companyId so the feature doesn't apply to them. */}
            {!isSuperAdmin && <Route path="/work-sessions/settings" component={WorkSessionSettings} />}
            {!isSuperAdmin && <Route path="/work-sessions" component={WorkSessions} />}
            {!isSuperAdmin && <Route path="/voice-assistant/settings" component={VoiceAssistantSettings} />}
            {/* Manual sessions: admin-managed entity (separate from per-login work_sessions log).
                Gated against the "sessions" permission key (admin & superadmin pass automatically). */}
            {!isSuperAdmin && <PermRoute path="/sessions" module="sessions" component={SessionsAdmin} />}
            <Route path="/notifications" component={Notifications} />

            {/* Company user routes */}
            {!isSuperAdmin && <Route path="/" component={Dashboard} />}
            {!isSuperAdmin && <PermRoute path="/invoices"      module="sales_invoices" component={Invoices} />}
            {!isSuperAdmin && <PermRoute path="/invoices/new"  module="sales_invoices" action="create" component={InvoiceNew} />}
            {!isSuperAdmin && <PermRoute path="/invoices/:id"  module="sales_invoices" component={InvoiceDetails} />}
            {!isSuperAdmin && <PermRoute path="/customers"     module="customers" component={Customers} />}
            {!isSuperAdmin && <PermRoute path="/customers/new" module="customers" action="create" component={CustomerNew} />}
            {!isSuperAdmin && <PermRoute path="/customers/:id" module="customers" component={CustomerNew} />}
            {!isSuperAdmin && <PermRoute path="/suppliers"     module="suppliers" component={Suppliers} />}
            {!isSuperAdmin && <PermRoute path="/suppliers/new" module="suppliers" action="create" component={SupplierNew} />}
            {!isSuperAdmin && <PermRoute path="/zatca"         module="zatca_setup"   component={ZatcaIntegration} />}
            {!isSuperAdmin && <PermRoute path="/zatca-bridge"  module="zatca_bridge"  component={ZatcaBridge} />}
            {!isSuperAdmin && <PermRoute path="/zatca-report"  module="zatca_report"  component={ZatcaReport} />}
            {!isSuperAdmin && <PermRoute path="/general-settings" module="general_settings" component={GeneralSettings} />}
            {!isSuperAdmin && user?.role === "admin" && <PermRoute path="/users" module="users" component={Users} />}
            {isSuperAdmin && <Route path="/users" component={Users} />}
            {!isSuperAdmin && <PermRoute path="/vat-declaration" module="vat_declaration" component={VATDeclaration} />}

            {/* POS routes (gated behind the "pos" module — same as the sidebar permKey) */}
            {isSuperAdmin && <Route path="/pos-monitoring" component={PosMonitoring} />}
            {!isSuperAdmin && <PermRoute path="/pos-management"  module="pos" component={PosHub} />}
            {!isSuperAdmin && <PermRoute path="/pos-monitoring" module="pos" component={PosMonitoring} />}
            {!isSuperAdmin && <PermRoute path="/pos-settings"   module="pos" component={PosSettings} />}
            {!isSuperAdmin && <PermRoute path="/pos-terminals"  module="pos" component={PosTerminals} />}
            {/* Control-Panel hub: any tenant user can land here; tile-level perm gating filters which tiles render. */}
            {!isSuperAdmin && <Route path="/control-panel" component={ControlPanelHub} />}

            {/* HR routes — gated per logical screen against the matching hr_* module */}
            {/* HR hub landing: open to any tenant user — the hub itself filters
                tiles by perm, and the sidebar HR group is hidden when the user
                has no hr_* perms at all. Don't gate against hr_employees here
                or users with only payroll/attendance perms get a 403 wall. */}
            {!isSuperAdmin && <Route path="/hr" component={HrHub} />}
            {!isSuperAdmin && <PermRoute path="/hr/employees"               module="hr_employees"   component={Employees} />}
            {!isSuperAdmin && <PermRoute path="/hr/employees/:id/contracts" module="hr_employees"   component={EmployeeContracts} />}
            {!isSuperAdmin && <PermRoute path="/hr/contracts"               module="hr_employees"   component={AllContracts} />}
            {!isSuperAdmin && <PermRoute path="/hr/attendance"              module="hr_attendance"  component={Attendance} />}
            {!isSuperAdmin && <PermRoute path="/hr/loans"                   module="hr_loans"       component={EmployeeLoans} />}
            {!isSuperAdmin && <PermRoute path="/hr/payroll"                 module="hr_payroll"     component={Payroll} />}
            {!isSuperAdmin && <PermRoute path="/hr/end-of-service"          module="hr_eos"         component={EndOfService} />}
            {!isSuperAdmin && <PermRoute path="/hr/calculators"             module="hr_calculators" component={HRCalculators} />}
            {!isSuperAdmin && <PermRoute path="/hr/settings"                module="hr_settings"    component={HRSettings} />}
            {!isSuperAdmin && <PermRoute path="/hr/face"                    module="hr_face_attendance" component={FaceAttendanceHub} />}
            {!isSuperAdmin && <PermRoute path="/hr/face/enrollment"         module="hr_face_attendance" component={FaceEnrollment} />}
            {!isSuperAdmin && <PermRoute path="/hr/face/kiosk"              module="hr_face_attendance" component={LiveAttendanceKiosk} />}
            {!isSuperAdmin && <PermRoute path="/hr/face/cameras"            module="hr_face_attendance" component={AttendanceCameras} />}
            {!isSuperAdmin && <PermRoute path="/hr/face/logs"               module="hr_face_attendance" component={FaceAttendanceLogs} />}
            {!isSuperAdmin && <PermRoute path="/hr/face/settings"           module="hr_face_attendance" component={FaceAttendanceSettings} />}
            {!isSuperAdmin && <PermRoute path="/security"        module="security_events" component={SecurityHub} />}
            {!isSuperAdmin && <PermRoute path="/security/events" module="security_events" component={SecurityEvents} />}
            {!isSuperAdmin && <PermRoute path="/security/notification-rules" module="security_events" component={SecurityNotificationRules} />}

            {!isSuperAdmin && <PermRoute path="/production"                  module="production"     component={ProductionDashboard} />}
            {!isSuperAdmin && <PermRoute path="/production/orders"           module="production"     component={ProductionOrders} />}
            {!isSuperAdmin && <PermRoute path="/production/orders/:id"       module="production"     component={ProductionOrderDetail} />}
            {!isSuperAdmin && <PermRoute path="/production/resources"        module="production"     component={ProductionResources} />}
            {/* HR reports — all gated against hr_employees permission */}
            {!isSuperAdmin && <PermRoute path="/hr/reports"                 module="hr_employees"   component={HRReportsHub} />}
            {!isSuperAdmin && <PermRoute path="/hr/reports/employees"       module="hr_employees"   component={HRReportEmployees} />}
            {!isSuperAdmin && <PermRoute path="/hr/reports/payroll"         module="hr_payroll"     component={HRReportPayroll} />}
            {!isSuperAdmin && <PermRoute path="/hr/reports/attendance"      module="hr_attendance"  component={HRReportAttendance} />}
            {!isSuperAdmin && <PermRoute path="/hr/reports/contracts"       module="hr_employees"   component={HRReportContracts} />}
            {!isSuperAdmin && <PermRoute path="/hr/reports/documents"       module="hr_employees"   component={HRReportDocuments} />}
            {!isSuperAdmin && <PermRoute path="/hr/reports/loans"           module="hr_loans"       component={HRReportLoans} />}
            {!isSuperAdmin && <PermRoute path="/hr/reports/eos"             module="hr_eos"         component={HRReportEos} />}
            {!isSuperAdmin && <PermRoute path="/hr/reports/employee-cost"   module="hr_payroll"     component={HRReportEmployeeCost} />}
            {!isSuperAdmin && <PermRoute path="/hr/reports/leaves"          module="hr_employees"   component={HRReportLeaves} />}

            {/* Inventory routes */}
            {!isSuperAdmin && <PermRoute path="/inventory" module="items" component={InventoryDashboard} />}
            {!isSuperAdmin && <PermRoute path="/inventory/warehouse-groups" module="warehouses"        component={WarehouseGroups} />}
            {!isSuperAdmin && <PermRoute path="/inventory/warehouses"       module="warehouses"        component={Warehouses} />}
            {!isSuperAdmin && <PermRoute path="/inventory/item-groups"      module="items"             component={ItemGroups} />}
            {!isSuperAdmin && <PermRoute path="/inventory/units"            module="items"             component={Units} />}
            {!isSuperAdmin && <PermRoute path="/inventory/items"            module="items"             component={Items} />}
            {!isSuperAdmin && <PermRoute path="/inventory/items/new"        module="items" action="create" component={Items} />}
            {!isSuperAdmin && <PermRoute path="/inventory/offers"           module="items"             component={Offers} />}
            {!isSuperAdmin && <PermRoute path="/inventory/offers/new"       module="items" action="create" component={OfferForm} />}
            {!isSuperAdmin && <PermRoute path="/inventory/offers/:id/edit"  module="items" action="update" component={OfferForm} />}
            {!isSuperAdmin && <PermRoute path="/inventory/transfers"        module="stock_transfers"   component={StockTransfer} />}
            {!isSuperAdmin && <PermRoute path="/inventory/transfers/new"    module="stock_transfers" action="create" component={StockTransfer} />}
            {!isSuperAdmin && <PermRoute path="/inventory/adjustments"      module="stock_adjustments" component={StockAdjustment} />}
            {!isSuperAdmin && <PermRoute path="/inventory/adjustments/new"  module="stock_adjustments" action="create" component={StockAdjustment} />}
            {!isSuperAdmin && <PermRoute path="/inventory/counts"           module="stock_counts"      component={StockCounting} />}
            {!isSuperAdmin && <PermRoute path="/inventory/counts/new"       module="stock_counts" action="create" component={StockCounting} />}
            {!isSuperAdmin && <PermRoute path="/inventory/ledger"  module="items" component={StockLedger} />}
            {!isSuperAdmin && <PermRoute path="/inventory/balance" module="items" component={StockBalance} />}
            {/* Inventory Reports */}
            {!isSuperAdmin && <PermRoute path="/inventory/reports"                  module="items" component={InventoryReportsHub} />}
            {!isSuperAdmin && <PermRoute path="/inventory/reports/stock-balance"    module="items" component={StockBalance} />}
            {!isSuperAdmin && <PermRoute path="/inventory/reports/stock-ledger"     module="items" component={StockLedger} />}
            {!isSuperAdmin && <PermRoute path="/inventory/reports/item-card"        module="items" component={ItemCard} />}
            {!isSuperAdmin && <PermRoute path="/inventory/reports/low-stock"        module="items" component={LowStockReport} />}
            {!isSuperAdmin && <PermRoute path="/inventory/reports/valuation"        module="items" component={ValuationByWarehouse} />}
            {!isSuperAdmin && <PermRoute path="/inventory/reports/slow-moving"      module="items" component={SlowMovingItems} />}

            {/* Accounting routes */}
            {!isSuperAdmin && <Route path="/accounting" component={AccountingHub} />}
            {!isSuperAdmin && <PermRoute path="/accounting/accounts"       module="accounts"        component={ChartOfAccounts} />}
            {!isSuperAdmin && <PermRoute path="/accounting/cost-centers"   module="accounts"        component={CostCenters} />}
            {!isSuperAdmin && <PermRoute path="/accounting/fiscal-periods" module="accounts"        component={FiscalPeriods} />}
            {!isSuperAdmin && <PermRoute path="/accounting/journals"       module="journal_entries" component={JournalEntries} />}
            {!isSuperAdmin && <PermRoute path="/accounting/journals/new"   module="journal_entries" action="create" component={JournalEntryForm} />}
            {!isSuperAdmin && <PermRoute path="/accounting/journals/:id"   module="journal_entries" component={JournalEntryForm} />}
            {/* Accounting Reports */}
            {!isSuperAdmin && <Route path="/accounting/reports"><Redirect to="/accounting/reports/trial-balance" /></Route>}
            {!isSuperAdmin && <PermRoute path="/accounting/reports/account-statement" module="accounting_reports" component={AccountStatement} />}
            {!isSuperAdmin && <PermRoute path="/accounting/reports/trial-balance"     module="accounting_reports" component={TrialBalance} />}
            {!isSuperAdmin && <PermRoute path="/accounting/reports/balance-sheet"     module="accounting_reports" component={BalanceSheet} />}
            {!isSuperAdmin && <PermRoute path="/accounting/reports/income-statement"  module="accounting_reports" component={IncomeStatement} />}

            {/* Org routes */}
            {!isSuperAdmin && <Route path="/org"><Redirect to="/org/branches" /></Route>}
            {!isSuperAdmin && <PermRoute path="/org/regions"  module="regions"  component={Regions} />}
            {!isSuperAdmin && <PermRoute path="/org/branches" module="branches" component={Branches} />}

            {/* Purchasing routes */}
            {!isSuperAdmin && <Route path="/purchasing" component={PurchasingHub} />}
            {!isSuperAdmin && <PermRoute path="/purchasing/supplier-groups" module="suppliers"             component={SupplierGroups} />}
            {!isSuperAdmin && <PermRoute path="/purchasing/lc"              module="purchase_invoices"     component={LetterOfCredit} />}
            {!isSuperAdmin && <PermRoute path="/purchasing/invoices/new"    module="purchase_invoices" action="create" component={PurchaseInvoiceForm} />}
            {!isSuperAdmin && <PermRoute path="/purchasing/invoices/:id"    module="purchase_invoices"     component={PurchaseInvoiceForm} />}
            {!isSuperAdmin && <PermRoute path="/purchasing/invoices"        module="purchase_invoices"     component={PurchaseInvoices} />}
            {/* Purchase Orders piggy-back on purchase_invoices permission — no module migration needed */}
            {!isSuperAdmin && <PermRoute path="/purchasing/orders/new"      module="purchase_invoices" action="create" component={PurchaseOrderForm} />}
            {!isSuperAdmin && <PermRoute path="/purchasing/orders/:id"      module="purchase_invoices"     component={PurchaseOrderForm} />}
            {!isSuperAdmin && <PermRoute path="/purchasing/orders"          module="purchase_invoices"     component={PurchaseOrders} />}
            {!isSuperAdmin && <PermRoute path="/purchasing/returns"         module="purchase_returns"      component={PurchaseReturns} />}
            {!isSuperAdmin && <PermRoute path="/purchasing/settlements"     module="supplier_settlements"  component={SupplierSettlement} />}

            {/* Sales routes */}
            {!isSuperAdmin && <Route path="/sales" component={SalesHub} />}
            {!isSuperAdmin && <PermRoute path="/sales/invoices/new"   module="sales_invoices"   action="create" component={SalesInvoiceForm} />}
            {!isSuperAdmin && <PermRoute path="/sales/invoices/:id"   module="sales_invoices"   component={SalesInvoiceForm} />}
            {!isSuperAdmin && <PermRoute path="/sales/invoices"       module="sales_invoices"   component={SalesInvoices} />}
            {!isSuperAdmin && <PermRoute path="/sales/quotations/new" module="sales_quotations" action="create" component={SalesQuotationForm} />}
            {!isSuperAdmin && <PermRoute path="/sales/quotations/:id" module="sales_quotations" component={SalesQuotationForm} />}
            {!isSuperAdmin && <PermRoute path="/sales/quotations"     module="sales_quotations" component={SalesQuotations} />}
            {/* Sales Orders piggy-back on sales_invoices permission — no module migration needed */}
            {!isSuperAdmin && <PermRoute path="/sales/orders/new"     module="sales_invoices"   action="create" component={SalesOrderForm} />}
            {!isSuperAdmin && <PermRoute path="/sales/orders/:id"     module="sales_invoices"   component={SalesOrderForm} />}
            {!isSuperAdmin && <PermRoute path="/sales/orders"         module="sales_invoices"   component={SalesOrders} />}
            {!isSuperAdmin && <PermRoute path="/sales/returns"        module="sales_returns"    component={SalesReturns} />}

            {/* Customers & Sales Reports */}
            {!isSuperAdmin && <PermRoute path="/sales/reports/customer-statement" module="sales_reports"  component={CustomerStatement} />}
            {!isSuperAdmin && <PermRoute path="/sales/reports/customer-statement-detailed" module="sales_reports"  component={CustomerStatementDetailed} />}
            {!isSuperAdmin && <PermRoute path="/sales/reports/customer-balances"  module="sales_reports"  component={CustomerBalances} />}
            {!isSuperAdmin && <PermRoute path="/sales/reports/aging"              module="sales_reports"  component={AgingReport} />}
            {!isSuperAdmin && <PermRoute path="/sales/reports/sales-by-customer"  module="sales_reports"  component={SalesByCustomer} />}
            {!isSuperAdmin && <PermRoute path="/sales/reports/sales-by-item"      module="sales_reports"  component={SalesByItem} />}
            {!isSuperAdmin && <PermRoute path="/sales/reports/sales-by-period"    module="sales_reports"  component={SalesByPeriod} />}
            {!isSuperAdmin && <PermRoute path="/sales/reports/daily"              module="sales_reports"  component={DailyReport} />}
            {!isSuperAdmin && <PermRoute path="/sales/reports/top-customers"      module="sales_reports"  component={TopCustomers} />}
            {!isSuperAdmin && <PermRoute path="/sales/reports/returns"            module="sales_reports"  component={SalesReturnsReport} />}
            {!isSuperAdmin && <PermRoute path="/sales/reports"                    module="sales_reports"  component={SalesReportsHub} />}
            {!isSuperAdmin && <PermRoute path="/purchasing/reports/supplier-statement"   module="suppliers"          component={SupplierStatement} />}
            {!isSuperAdmin && <PermRoute path="/purchasing/reports/supplier-statement-detailed"   module="suppliers"          component={SupplierStatementDetailed} />}
            {!isSuperAdmin && <PermRoute path="/purchasing/reports/supplier-balances"    module="suppliers"          component={SupplierBalances} />}
            {!isSuperAdmin && <PermRoute path="/purchasing/reports/aging"                module="purchase_invoices"  component={SupplierAgingReport} />}
            {!isSuperAdmin && <PermRoute path="/purchasing/reports/purchases-by-supplier" module="purchase_invoices" component={PurchasesBySupplier} />}
            {!isSuperAdmin && <PermRoute path="/purchasing/reports/purchases-by-item"    module="purchase_invoices"  component={PurchasesByItem} />}
            {!isSuperAdmin && <PermRoute path="/purchasing/reports/purchases-by-period"  module="purchase_invoices"  component={PurchasesByPeriod} />}
            {!isSuperAdmin && <PermRoute path="/purchasing/reports/top-suppliers"        module="suppliers"          component={TopSuppliers} />}
            {!isSuperAdmin && <PermRoute path="/purchasing/reports/returns"              module="purchase_returns"   component={PurchaseReturnsReport} />}
            {!isSuperAdmin && <PermRoute path="/purchasing/reports"                      module="purchase_invoices"  component={PurchaseReportsHub} />}

            {!isSuperAdmin && <PermRoute path="/cash/reports/cash-balances"      module="cash_boxes"        component={CashBalances} />}
            {!isSuperAdmin && <PermRoute path="/cash/reports/bank-balances"      module="bank_accounts"     component={BankBalances} />}
            {!isSuperAdmin && <PermRoute path="/cash/reports/cash-box-statement" module="cash_boxes"        component={CashBoxStatement} />}
            {!isSuperAdmin && <PermRoute path="/cash/reports/bank-statement"     module="bank_accounts"     component={BankAccountStatement} />}
            {!isSuperAdmin && <PermRoute path="/cash/reports/daily-summary"      module="cash_boxes"        component={CashFlowReport} />}
            {!isSuperAdmin && <PermRoute path="/cash/reports/receipts"           module="receipt_vouchers"  component={ReceiptVouchersReport} />}
            {!isSuperAdmin && <PermRoute path="/cash/reports/payments"           module="payment_vouchers"  component={PaymentVouchersReport} />}
            {!isSuperAdmin && <PermRoute path="/cash/reports/transfers"          module="cash_boxes"        component={TransfersReport} />}
            {!isSuperAdmin && <PermRoute path="/cash/reports"                    module="cash_boxes"        component={CashReportsHub} />}
            {!isSuperAdmin && <PermRoute path="/sales/settlements"               module="sales_settlements" component={CustomerSettlement} />}

            {/* Cash & Banks */}
            {!isSuperAdmin && <Route path="/cash" component={CashHub} />}
            {!isSuperAdmin && <PermRoute path="/cash/boxes"            module="cash_boxes"        component={CashBoxes}       />}
            {!isSuperAdmin && <PermRoute path="/cash/banks"            module="bank_accounts"     component={BankAccounts}    />}
            {!isSuperAdmin && <PermRoute path="/cash/receipt-vouchers" module="receipt_vouchers"  component={ReceiptVouchers} />}
            {!isSuperAdmin && <PermRoute path="/cash/payment-vouchers" module="payment_vouchers"  component={PaymentVouchers} />}
            {!isSuperAdmin && <PermRoute path="/cash/transfers"        module="cash_boxes"        component={CashTransfers}   />}

            {/* Settings routes */}
            {!isSuperAdmin && <PermRoute path="/settings/currencies"          module="currencies"       component={Currencies} />}
            {!isSuperAdmin && <PermRoute path="/settings/accounting-mappings" module="general_settings" component={AccountingMappings} />}
            {!isSuperAdmin && <PermRoute path="/settings/data-io"             module="data_io"          component={DataImportExport} />}
            {!isSuperAdmin && user?.role === "admin" && <PermRoute path="/settings/sequences" module="sequences" component={Sequences} />}
            {!isSuperAdmin && <PermRoute path="/sales/reps"                   module="sales_reps"       component={SalesReps} />}

            {/* Shared routes */}
            <Route path="/settings" component={Settings} />
            <Route component={NotFound} />
          </Switch>
        </Layout>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AuthProvider>
            <ScreenActionsProvider>
              <AppRoutes />
            </ScreenActionsProvider>
          </AuthProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
