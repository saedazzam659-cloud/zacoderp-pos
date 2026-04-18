import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Layout from "@/components/Layout";
import Dashboard from "@/pages/Dashboard";
import Companies from "@/pages/Companies";
import CompanyNew from "@/pages/CompanyNew";
import CompanyDetails from "@/pages/CompanyDetails";
import Customers from "@/pages/Customers";
import CustomerNew from "@/pages/CustomerNew";
import Invoices from "@/pages/Invoices";
import InvoiceNew from "@/pages/InvoiceNew";
import InvoiceDetails from "@/pages/InvoiceDetails";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/companies" component={Companies} />
        <Route path="/companies/new" component={CompanyNew} />
        <Route path="/companies/:id" component={CompanyDetails} />
        <Route path="/customers" component={Customers} />
        <Route path="/customers/new" component={CustomerNew} />
        <Route path="/invoices" component={Invoices} />
        <Route path="/invoices/new" component={InvoiceNew} />
        <Route path="/invoices/:id" component={InvoiceDetails} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
