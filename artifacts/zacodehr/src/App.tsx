import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
  Redirect
} from 'wouter';
import { getToken } from '@/lib/api';
import { Layout } from '@/components/layout';

import Login from '@/pages/login';
import Dashboard from '@/pages/dashboard';
import Attendance from '@/pages/attendance';
import Requests from '@/pages/requests';
import Payslips from '@/pages/payslips';
import Profile from '@/pages/profile';

const queryClient = new QueryClient();

function ProtectedRoute({ component: Component, ...rest }: any) {
  const token = getToken();
  if (!token) return <Redirect to="/login" />;
  
  return (
    <Route {...rest}>
      <Layout>
        <Component />
      </Layout>
    </Route>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/login" component={Login} />
        <ProtectedRoute path="/" component={Dashboard} />
        <ProtectedRoute path="/attendance" component={Attendance} />
        <ProtectedRoute path="/requests" component={Requests} />
        <ProtectedRoute path="/payslips" component={Payslips} />
        <ProtectedRoute path="/profile" component={Profile} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
