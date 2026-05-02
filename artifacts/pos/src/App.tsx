import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import LoginPage from "@/pages/Login";
import CashierPage from "@/pages/Cashier";
import SupermarketPage from "@/pages/Supermarket";
import RestaurantHub from "@/pages/RestaurantHub";
import WaiterApp from "@/pages/WaiterApp";
import KitchenDisplay from "@/pages/KitchenDisplay";
import RestaurantSettings from "@/pages/RestaurantSettings";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={LoginPage} />
      <Route path="/login" component={LoginPage} />
      <Route path="/pos" component={CashierPage} />
      <Route path="/super" component={SupermarketPage} />
      <Route path="/restaurant" component={RestaurantHub} />
      <Route path="/waiter" component={WaiterApp} />
      <Route path="/kitchen" component={KitchenDisplay} />
      <Route path="/restaurant-settings" component={RestaurantSettings} />
      <Route component={NotFound} />
    </Switch>
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
