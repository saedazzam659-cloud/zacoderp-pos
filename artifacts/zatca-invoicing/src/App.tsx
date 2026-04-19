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
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { Loader2 } from "lucide-react";

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

            {/* Company user routes */}
            {!isSuperAdmin && <Route path="/" component={Dashboard} />}
            {!isSuperAdmin && <Route path="/invoices" component={Invoices} />}
            {!isSuperAdmin && <Route path="/invoices/new" component={InvoiceNew} />}
            {!isSuperAdmin && <Route path="/invoices/:id" component={InvoiceDetails} />}
            {!isSuperAdmin && <Route path="/customers" component={Customers} />}
            {!isSuperAdmin && <Route path="/customers/new" component={CustomerNew} />}
            {!isSuperAdmin && <Route path="/suppliers" component={Suppliers} />}
            {!isSuperAdmin && <Route path="/suppliers/new" component={SupplierNew} />}
            {!isSuperAdmin && <Route path="/zatca" component={ZatcaIntegration} />}

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
