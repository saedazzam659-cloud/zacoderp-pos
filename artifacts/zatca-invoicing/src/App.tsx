import { Switch, Route, Router as WouterRouter, useLocation, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Layout from "@/components/Layout";
import Dashboard from "@/pages/Dashboard";
import SuperAdminDashboard from "@/pages/SuperAdminDashboard";
import OrphanStockCleanup from "@/pages/admin/OrphanStockCleanup";
import AICompanyFix from "@/pages/admin/AICompanyFix";
import SupportInbox from "@/pages/admin/SupportInbox";
import SupportSettings from "@/pages/admin/SupportSettings";
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
            <Route path="/notifications" component={Notifications} />

            {/* Company user routes */}
            {!isSuperAdmin && <Route path="/" component={Dashboard} />}
            {!isSuperAdmin && <Route path="/invoices" component={Invoices} />}
            {!isSuperAdmin && <Route path="/invoices/new" component={InvoiceNew} />}
            {!isSuperAdmin && <Route path="/invoices/:id" component={InvoiceDetails} />}
            {!isSuperAdmin && <Route path="/customers" component={Customers} />}
            {!isSuperAdmin && <Route path="/customers/new" component={CustomerNew} />}
            {!isSuperAdmin && <Route path="/customers/:id" component={CustomerNew} />}
            {!isSuperAdmin && <Route path="/suppliers" component={Suppliers} />}
            {!isSuperAdmin && <Route path="/suppliers/new" component={SupplierNew} />}
            {!isSuperAdmin && <Route path="/zatca">{() => <ZatcaIntegration />}</Route>}
            {!isSuperAdmin && <Route path="/zatca-bridge" component={ZatcaBridge} />}
            {!isSuperAdmin && <Route path="/zatca-report" component={ZatcaReport} />}
            {!isSuperAdmin && <Route path="/general-settings" component={GeneralSettings} />}
            {!isSuperAdmin && user?.role === "admin" && <Route path="/users" component={Users} />}
            {!isSuperAdmin && <Route path="/vat-declaration" component={VATDeclaration} />}

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
            {!isSuperAdmin && <Route path="/inventory/warehouse-groups" component={WarehouseGroups} />}
            {!isSuperAdmin && <Route path="/inventory/warehouses" component={Warehouses} />}
            {!isSuperAdmin && <Route path="/inventory/item-groups" component={ItemGroups} />}
            {!isSuperAdmin && <Route path="/inventory/units" component={Units} />}
            {!isSuperAdmin && <Route path="/inventory/items" component={Items} />}
            {!isSuperAdmin && <Route path="/inventory/items/new" component={Items} />}
            {!isSuperAdmin && <Route path="/inventory/transfers" component={StockTransfer} />}
            {!isSuperAdmin && <Route path="/inventory/transfers/new" component={StockTransfer} />}
            {!isSuperAdmin && <Route path="/inventory/adjustments" component={StockAdjustment} />}
            {!isSuperAdmin && <Route path="/inventory/adjustments/new" component={StockAdjustment} />}
            {!isSuperAdmin && <Route path="/inventory/counts" component={StockCounting} />}
            {!isSuperAdmin && <Route path="/inventory/counts/new" component={StockCounting} />}
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
            {!isSuperAdmin && <Route path="/accounting/accounts" component={ChartOfAccounts} />}
            {!isSuperAdmin && <Route path="/accounting/cost-centers" component={CostCenters} />}
            {!isSuperAdmin && <Route path="/accounting/fiscal-periods" component={FiscalPeriods} />}
            {!isSuperAdmin && <Route path="/accounting/journals"     component={JournalEntries} />}
            {!isSuperAdmin && <Route path="/accounting/journals/new" component={JournalEntryForm} />}
            {!isSuperAdmin && <Route path="/accounting/journals/:id" component={JournalEntryForm} />}
            {/* Accounting Reports */}
            {!isSuperAdmin && <Route path="/accounting/reports/account-statement" component={AccountStatement} />}
            {!isSuperAdmin && <Route path="/accounting/reports/trial-balance"     component={TrialBalance} />}
            {!isSuperAdmin && <Route path="/accounting/reports/balance-sheet"     component={BalanceSheet} />}
            {!isSuperAdmin && <Route path="/accounting/reports/income-statement"  component={IncomeStatement} />}

            {/* Org routes */}
            {!isSuperAdmin && <Route path="/org/regions"  component={Regions} />}
            {!isSuperAdmin && <Route path="/org/branches" component={Branches} />}

            {/* Purchasing routes */}
            {!isSuperAdmin && <Route path="/purchasing/supplier-groups" component={SupplierGroups} />}
            {!isSuperAdmin && <Route path="/purchasing/lc"              component={LetterOfCredit} />}
            {!isSuperAdmin && <Route path="/purchasing/invoices/new"    component={PurchaseInvoiceForm} />}
            {!isSuperAdmin && <Route path="/purchasing/invoices/:id"    component={PurchaseInvoiceForm} />}
            {!isSuperAdmin && <Route path="/purchasing/invoices"        component={PurchaseInvoices} />}
            {!isSuperAdmin && <Route path="/purchasing/returns"         component={PurchaseReturns} />}
            {!isSuperAdmin && <Route path="/purchasing/settlements"     component={SupplierSettlement} />}

            {/* Sales routes */}
            {!isSuperAdmin && <Route path="/sales/invoices/new"      component={SalesInvoiceForm} />}
            {!isSuperAdmin && <Route path="/sales/invoices/:id"      component={SalesInvoiceForm} />}
            {!isSuperAdmin && <Route path="/sales/invoices"          component={SalesInvoices} />}
            {!isSuperAdmin && <Route path="/sales/quotations/new"    component={SalesQuotationForm} />}
            {!isSuperAdmin && <Route path="/sales/quotations/:id"    component={SalesQuotationForm} />}
            {!isSuperAdmin && <Route path="/sales/quotations"        component={SalesQuotations} />}
            {!isSuperAdmin && <Route path="/sales/returns"           component={SalesReturns} />}

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
            {!isSuperAdmin && <Route path="/cash/boxes"            component={CashBoxes}       />}
            {!isSuperAdmin && <Route path="/cash/banks"            component={BankAccounts}    />}
            {!isSuperAdmin && <Route path="/cash/receipt-vouchers" component={ReceiptVouchers} />}
            {!isSuperAdmin && <Route path="/cash/payment-vouchers" component={PaymentVouchers} />}
            {!isSuperAdmin && <Route path="/cash/transfers"        component={CashTransfers}   />}

            {/* Settings routes */}
            {!isSuperAdmin && <Route path="/settings/currencies" component={Currencies} />}
            {!isSuperAdmin && <Route path="/settings/accounting-mappings" component={AccountingMappings} />}

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
