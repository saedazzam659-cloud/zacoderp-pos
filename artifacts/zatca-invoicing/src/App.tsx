import { Switch, Route, Router as WouterRouter, useLocation, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Layout from "@/components/Layout";
import Dashboard from "@/pages/Dashboard";
import SuperAdminDashboard from "@/pages/SuperAdminDashboard";
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
import MenuPermissions from "@/pages/MenuPermissions";
import GeneralSettings from "@/pages/GeneralSettings";
import VATDeclaration from "@/pages/VATDeclaration";
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
// Accounting
import ChartOfAccounts from "@/pages/accounting/ChartOfAccounts";
import Regions  from "@/pages/org/Regions";
import Branches from "@/pages/org/Branches";
import JournalEntries from "@/pages/accounting/JournalEntries";
import JournalEntryForm from "@/pages/accounting/JournalEntryForm";
import Currencies from "@/pages/settings/Currencies";
// Accounting Reports
import AccountStatement from "@/pages/accounting/reports/AccountStatement";
import TrialBalance     from "@/pages/accounting/reports/TrialBalance";
import BalanceSheet     from "@/pages/accounting/reports/BalanceSheet";
import IncomeStatement  from "@/pages/accounting/reports/IncomeStatement";
// Purchasing
import SupplierGroups       from "@/pages/purchasing/SupplierGroups";
import LetterOfCredit       from "@/pages/purchasing/LetterOfCredit";
import PurchaseInvoices     from "@/pages/purchasing/PurchaseInvoices";
import PurchaseInvoiceForm  from "@/pages/purchasing/PurchaseInvoiceForm";
import PurchaseReturns      from "@/pages/purchasing/PurchaseReturns";
import SupplierSettlement   from "@/pages/purchasing/SupplierSettlement";

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

            {/* Company user routes */}
            {!isSuperAdmin && <Route path="/" component={Dashboard} />}
            {!isSuperAdmin && <Route path="/invoices" component={Invoices} />}
            {!isSuperAdmin && <Route path="/invoices/new" component={InvoiceNew} />}
            {!isSuperAdmin && <Route path="/invoices/:id" component={InvoiceDetails} />}
            {!isSuperAdmin && <Route path="/customers" component={Customers} />}
            {!isSuperAdmin && <Route path="/customers/new" component={CustomerNew} />}
            {!isSuperAdmin && <Route path="/suppliers" component={Suppliers} />}
            {!isSuperAdmin && <Route path="/suppliers/new" component={SupplierNew} />}
            {!isSuperAdmin && <Route path="/zatca">{() => <ZatcaIntegration />}</Route>}
            {!isSuperAdmin && <Route path="/general-settings" component={GeneralSettings} />}
            {!isSuperAdmin && <Route path="/vat-declaration" component={VATDeclaration} />}

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

            {/* Accounting routes */}
            {!isSuperAdmin && <Route path="/accounting/accounts" component={ChartOfAccounts} />}
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

            {/* Cash & Banks */}
            {!isSuperAdmin && <Route path="/cash/boxes"            component={CashBoxes}       />}
            {!isSuperAdmin && <Route path="/cash/banks"            component={BankAccounts}    />}
            {!isSuperAdmin && <Route path="/cash/receipt-vouchers" component={ReceiptVouchers} />}
            {!isSuperAdmin && <Route path="/cash/payment-vouchers" component={PaymentVouchers} />}
            {!isSuperAdmin && <Route path="/cash/transfers"        component={CashTransfers}   />}

            {/* Settings routes */}
            {!isSuperAdmin && <Route path="/settings/currencies" component={Currencies} />}

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
