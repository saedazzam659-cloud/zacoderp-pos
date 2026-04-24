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
import LicenseManagement from "@/pages/LicenseManagement";
import GeneralSettings from "@/pages/GeneralSettings";
import VATDeclaration from "@/pages/VATDeclaration";
// HR
import Employees from "@/pages/hr/Employees";
import EmployeeContracts from "@/pages/hr/EmployeeContracts";
import Attendance from "@/pages/hr/Attendance";
import EmployeeLoans from "@/pages/hr/EmployeeLoans";
import Payroll from "@/pages/hr/Payroll";
import AllContracts from "@/pages/hr/AllContracts";
import EndOfService from "@/pages/hr/EndOfService";
import HRCalculators from "@/pages/hr/HRCalculators";
import HRSettings from "@/pages/hr/HRSettings";
import PosMonitoring from "@/pages/pos/Monitoring";
import PosSettings from "@/pages/pos/PosSettings";
import PosTerminals from "@/pages/pos/PosTerminals";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { Loader2 } from "lucide-react";
// Inventory
import InventoryDashboard from "@/pages/inventory/InventoryDashboard";
import WarehouseGroups from "@/pages/inventory/WarehouseGroups";
import Warehouses from "@/pages/inventory/Warehouses";
import ItemGroups from "@/pages/inventory/ItemGroups";
import Units from "@/pages/inventory/Units";
import Items from "@/pages/inventory/Items";
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
import PurchaseReturns      from "@/pages/purchasing/PurchaseReturns";
import SupplierSettlement   from "@/pages/purchasing/SupplierSettlement";
// Sales Reports
import SalesReportsHub      from "@/pages/sales/reports/SalesReportsHub";
import CustomerStatement    from "@/pages/sales/reports/CustomerStatement";
import CustomerBalances     from "@/pages/sales/reports/CustomerBalances";
import AgingReport          from "@/pages/sales/reports/AgingReport";
import SalesByCustomer      from "@/pages/sales/reports/SalesByCustomer";
import SalesByItem          from "@/pages/sales/reports/SalesByItem";
import SalesByPeriod        from "@/pages/sales/reports/SalesByPeriod";
import TopCustomers         from "@/pages/sales/reports/TopCustomers";
import SalesReturnsReport   from "@/pages/sales/reports/SalesReturnsReport";
import PurchaseReportsHub      from "@/pages/purchasing/reports/PurchaseReportsHub";
import SupplierStatement       from "@/pages/purchasing/reports/SupplierStatement";
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
            {isSuperAdmin && <Route path="/admin/licenses" component={LicenseManagement} />}
            {isSuperAdmin && <Route path="/admin/orphan-stock" component={OrphanStockCleanup} />}
            {isSuperAdmin && <Route path="/admin/ai-fix" component={AICompanyFix} />}
            {isSuperAdmin && <Route path="/admin/support" component={SupportInbox} />}
            {isSuperAdmin && <Route path="/admin/support-settings" component={SupportSettings} />}
            {(isSuperAdmin || user?.role === "admin") && <Route path="/admin/audit-log" component={AuditLog} />}
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
            {!isSuperAdmin && <Route path="/zatca">{() => <ZatcaIntegration />}</Route>}
            {!isSuperAdmin && <Route path="/zatca-bridge" component={ZatcaBridge} />}
            {!isSuperAdmin && <Route path="/zatca-report" component={ZatcaReport} />}
            {!isSuperAdmin && <Route path="/general-settings" component={GeneralSettings} />}
            {!isSuperAdmin && user?.role === "admin" && <PermRoute path="/users" module="users" component={Users} />}
            {!isSuperAdmin && <PermRoute path="/vat-declaration" module="vat_declaration" component={VATDeclaration} />}

            {/* HR routes */}
            <Route path="/pos-monitoring" component={PosMonitoring} />
            <Route path="/pos-settings" component={PosSettings} />
            <Route path="/pos-terminals" component={PosTerminals} />
            {!isSuperAdmin && <Route path="/hr/employees" component={Employees} />}
            {!isSuperAdmin && <Route path="/hr/employees/:id/contracts" component={EmployeeContracts} />}
            {!isSuperAdmin && <Route path="/hr/attendance" component={Attendance} />}
            {!isSuperAdmin && <Route path="/hr/loans" component={EmployeeLoans} />}
            {!isSuperAdmin && <Route path="/hr/payroll" component={Payroll} />}
            {!isSuperAdmin && <Route path="/hr/contracts" component={AllContracts} />}
            {!isSuperAdmin && <Route path="/hr/end-of-service" component={EndOfService} />}
            {!isSuperAdmin && <Route path="/hr/calculators" component={HRCalculators} />}
            {!isSuperAdmin && <Route path="/hr/settings" component={HRSettings} />}

            {/* Inventory routes */}
            {!isSuperAdmin && <Route path="/inventory" component={InventoryDashboard} />}
            {!isSuperAdmin && <PermRoute path="/inventory/warehouse-groups" module="warehouses"        component={WarehouseGroups} />}
            {!isSuperAdmin && <PermRoute path="/inventory/warehouses"       module="warehouses"        component={Warehouses} />}
            {!isSuperAdmin && <PermRoute path="/inventory/item-groups"      module="items"             component={ItemGroups} />}
            {!isSuperAdmin && <PermRoute path="/inventory/units"            module="items"             component={Units} />}
            {!isSuperAdmin && <PermRoute path="/inventory/items"            module="items"             component={Items} />}
            {!isSuperAdmin && <PermRoute path="/inventory/items/new"        module="items" action="create" component={Items} />}
            {!isSuperAdmin && <PermRoute path="/inventory/transfers"        module="stock_transfers"   component={StockTransfer} />}
            {!isSuperAdmin && <PermRoute path="/inventory/transfers/new"    module="stock_transfers" action="create" component={StockTransfer} />}
            {!isSuperAdmin && <PermRoute path="/inventory/adjustments"      module="stock_adjustments" component={StockAdjustment} />}
            {!isSuperAdmin && <PermRoute path="/inventory/adjustments/new"  module="stock_adjustments" action="create" component={StockAdjustment} />}
            {!isSuperAdmin && <PermRoute path="/inventory/counts"           module="stock_counts"      component={StockCounting} />}
            {!isSuperAdmin && <PermRoute path="/inventory/counts/new"       module="stock_counts" action="create" component={StockCounting} />}
            {!isSuperAdmin && <Route path="/inventory/ledger" component={StockLedger} />}
            {!isSuperAdmin && <Route path="/inventory/balance" component={StockBalance} />}
            {/* Inventory Reports */}
            {!isSuperAdmin && <Route path="/inventory/reports"                  component={InventoryReportsHub} />}
            {!isSuperAdmin && <Route path="/inventory/reports/stock-balance"    component={StockBalance} />}
            {!isSuperAdmin && <Route path="/inventory/reports/stock-ledger"     component={StockLedger} />}
            {!isSuperAdmin && <Route path="/inventory/reports/item-card"        component={ItemCard} />}
            {!isSuperAdmin && <Route path="/inventory/reports/low-stock"        component={LowStockReport} />}
            {!isSuperAdmin && <Route path="/inventory/reports/valuation"        component={ValuationByWarehouse} />}
            {!isSuperAdmin && <Route path="/inventory/reports/slow-moving"      component={SlowMovingItems} />}

            {/* Accounting routes */}
            {!isSuperAdmin && <Route path="/accounting"><Redirect to="/accounting/accounts" /></Route>}
            {!isSuperAdmin && <PermRoute path="/accounting/accounts"       module="accounts"        component={ChartOfAccounts} />}
            {!isSuperAdmin && <PermRoute path="/accounting/cost-centers"   module="accounts"        component={CostCenters} />}
            {!isSuperAdmin && <PermRoute path="/accounting/fiscal-periods" module="accounts"        component={FiscalPeriods} />}
            {!isSuperAdmin && <PermRoute path="/accounting/journals"       module="journal_entries" component={JournalEntries} />}
            {!isSuperAdmin && <PermRoute path="/accounting/journals/new"   module="journal_entries" action="create" component={JournalEntryForm} />}
            {!isSuperAdmin && <PermRoute path="/accounting/journals/:id"   module="journal_entries" component={JournalEntryForm} />}
            {/* Accounting Reports */}
            {!isSuperAdmin && <Route path="/accounting/reports"><Redirect to="/accounting/reports/trial-balance" /></Route>}
            {!isSuperAdmin && <Route path="/accounting/reports/account-statement" component={AccountStatement} />}
            {!isSuperAdmin && <Route path="/accounting/reports/trial-balance"     component={TrialBalance} />}
            {!isSuperAdmin && <Route path="/accounting/reports/balance-sheet"     component={BalanceSheet} />}
            {!isSuperAdmin && <Route path="/accounting/reports/income-statement"  component={IncomeStatement} />}

            {/* Org routes */}
            {!isSuperAdmin && <Route path="/org"><Redirect to="/org/branches" /></Route>}
            {!isSuperAdmin && <Route path="/org/regions"  component={Regions} />}
            {!isSuperAdmin && <Route path="/org/branches" component={Branches} />}

            {/* Purchasing routes */}
            {!isSuperAdmin && <Route path="/purchasing"><Redirect to="/purchasing/invoices" /></Route>}
            {!isSuperAdmin && <Route path="/purchasing/supplier-groups" component={SupplierGroups} />}
            {!isSuperAdmin && <Route path="/purchasing/lc"              component={LetterOfCredit} />}
            {!isSuperAdmin && <Route path="/purchasing/invoices/new"    component={PurchaseInvoiceForm} />}
            {!isSuperAdmin && <Route path="/purchasing/invoices/:id"    component={PurchaseInvoiceForm} />}
            {!isSuperAdmin && <Route path="/purchasing/invoices"        component={PurchaseInvoices} />}
            {!isSuperAdmin && <Route path="/purchasing/returns"         component={PurchaseReturns} />}
            {!isSuperAdmin && <Route path="/purchasing/settlements"     component={SupplierSettlement} />}

            {/* Sales routes */}
            {!isSuperAdmin && <Route path="/sales"><Redirect to="/sales/invoices" /></Route>}
            {!isSuperAdmin && <PermRoute path="/sales/invoices/new"   module="sales_invoices"   action="create" component={SalesInvoiceForm} />}
            {!isSuperAdmin && <PermRoute path="/sales/invoices/:id"   module="sales_invoices"   component={SalesInvoiceForm} />}
            {!isSuperAdmin && <PermRoute path="/sales/invoices"       module="sales_invoices"   component={SalesInvoices} />}
            {!isSuperAdmin && <PermRoute path="/sales/quotations/new" module="sales_quotations" action="create" component={SalesQuotationForm} />}
            {!isSuperAdmin && <PermRoute path="/sales/quotations/:id" module="sales_quotations" component={SalesQuotationForm} />}
            {!isSuperAdmin && <PermRoute path="/sales/quotations"     module="sales_quotations" component={SalesQuotations} />}
            {!isSuperAdmin && <PermRoute path="/sales/returns"        module="sales_returns"    component={SalesReturns} />}

            {/* Customers & Sales Reports */}
            {!isSuperAdmin && <Route path="/sales/reports/customer-statement" component={CustomerStatement} />}
            {!isSuperAdmin && <Route path="/sales/reports/customer-balances"  component={CustomerBalances} />}
            {!isSuperAdmin && <Route path="/sales/reports/aging"              component={AgingReport} />}
            {!isSuperAdmin && <Route path="/sales/reports/sales-by-customer"  component={SalesByCustomer} />}
            {!isSuperAdmin && <Route path="/sales/reports/sales-by-item"      component={SalesByItem} />}
            {!isSuperAdmin && <Route path="/sales/reports/sales-by-period"    component={SalesByPeriod} />}
            {!isSuperAdmin && <Route path="/sales/reports/top-customers"      component={TopCustomers} />}
            {!isSuperAdmin && <Route path="/sales/reports/returns"            component={SalesReturnsReport} />}
            {!isSuperAdmin && <Route path="/sales/reports"                    component={SalesReportsHub} />}
            {!isSuperAdmin && <Route path="/purchasing/reports/supplier-statement"   component={SupplierStatement} />}
            {!isSuperAdmin && <Route path="/purchasing/reports/supplier-balances"    component={SupplierBalances} />}
            {!isSuperAdmin && <Route path="/purchasing/reports/aging"                component={SupplierAgingReport} />}
            {!isSuperAdmin && <Route path="/purchasing/reports/purchases-by-supplier" component={PurchasesBySupplier} />}
            {!isSuperAdmin && <Route path="/purchasing/reports/purchases-by-item"    component={PurchasesByItem} />}
            {!isSuperAdmin && <Route path="/purchasing/reports/purchases-by-period"  component={PurchasesByPeriod} />}
            {!isSuperAdmin && <Route path="/purchasing/reports/top-suppliers"        component={TopSuppliers} />}
            {!isSuperAdmin && <Route path="/purchasing/reports/returns"              component={PurchaseReturnsReport} />}
            {!isSuperAdmin && <Route path="/purchasing/reports"                      component={PurchaseReportsHub} />}

            {!isSuperAdmin && <Route path="/cash/reports/cash-balances"      component={CashBalances} />}
            {!isSuperAdmin && <Route path="/cash/reports/bank-balances"      component={BankBalances} />}
            {!isSuperAdmin && <Route path="/cash/reports/cash-box-statement" component={CashBoxStatement} />}
            {!isSuperAdmin && <Route path="/cash/reports/bank-statement"     component={BankAccountStatement} />}
            {!isSuperAdmin && <Route path="/cash/reports/daily-summary"      component={CashFlowReport} />}
            {!isSuperAdmin && <Route path="/cash/reports/receipts"           component={ReceiptVouchersReport} />}
            {!isSuperAdmin && <Route path="/cash/reports/payments"           component={PaymentVouchersReport} />}
            {!isSuperAdmin && <Route path="/cash/reports/transfers"          component={TransfersReport} />}
            {!isSuperAdmin && <Route path="/cash/reports"                    component={CashReportsHub} />}
            {!isSuperAdmin && <Route path="/sales/settlements"       component={CustomerSettlement} />}

            {/* Cash & Banks */}
            {!isSuperAdmin && <Route path="/cash"><Redirect to="/cash/boxes" /></Route>}
            {!isSuperAdmin && <PermRoute path="/cash/boxes"            module="cash_boxes"        component={CashBoxes}       />}
            {!isSuperAdmin && <PermRoute path="/cash/banks"            module="bank_accounts"     component={BankAccounts}    />}
            {!isSuperAdmin && <PermRoute path="/cash/receipt-vouchers" module="receipt_vouchers"  component={ReceiptVouchers} />}
            {!isSuperAdmin && <PermRoute path="/cash/payment-vouchers" module="payment_vouchers"  component={PaymentVouchers} />}
            {!isSuperAdmin && <PermRoute path="/cash/transfers"        module="cash_boxes"        component={CashTransfers}   />}

            {/* Settings routes */}
            {!isSuperAdmin && <Route path="/settings/currencies" component={Currencies} />}
            {!isSuperAdmin && <Route path="/settings/accounting-mappings" component={AccountingMappings} />}
            {!isSuperAdmin && <Route path="/sales/reps" component={SalesReps} />}

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
            <AppRoutes />
          </AuthProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
