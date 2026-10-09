import { Switch, Route, Router as WouterRouter, Link } from "wouter";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
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
import RestaurantAI from "@/pages/RestaurantAI";
import PosEntry from "@/pages/PosEntry";
import { useEnterAdvances } from "@/hooks/useEnterAdvances";
import ReturnsPage from "@/pages/Returns";
import { api, getToken, type AuthUser } from "@/lib/api";

const queryClient = new QueryClient();

type PosFeature = "pos_cashier" | "pos_returns" | "pos_waiter" | "pos_kitchen";
type PosAction = "view" | "create" | "edit" | "post";

function PosAccessGate({
  feature,
  action = "view",
  children,
}: {
  feature: PosFeature;
  action?: PosAction;
  children: ReactNode;
}) {
  const hasToken = Boolean(getToken());
  const meQuery = useQuery<AuthUser>({
    queryKey: ["pos-access-user"],
    queryFn: api.me,
    enabled: hasToken,
    retry: false,
    staleTime: 0,
  });

  if (!hasToken) {
    return (
      <main dir="rtl" className="grid min-h-[100dvh] place-items-center bg-slate-50 p-6 text-slate-900">
        <section className="w-full max-w-md rounded-2xl border bg-white p-7 text-center shadow-sm">
          <h1 className="text-xl font-black">تسجيل الدخول مطلوب</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">سجّل الدخول بحساب نقطة بيع للوصول إلى هذه الشاشة.</p>
          <Link href="/login" className="mt-5 inline-flex h-11 items-center justify-center rounded-xl bg-primary px-5 font-bold text-primary-foreground" data-testid="link-pos-login">
            الانتقال إلى تسجيل الدخول
          </Link>
        </section>
      </main>
    );
  }

  if (meQuery.isLoading) {
    return (
      <main dir="rtl" className="grid min-h-[100dvh] place-items-center bg-slate-50 p-6 text-slate-700">
        <p role="status" className="rounded-xl border bg-white px-5 py-4 text-sm font-bold shadow-sm" data-testid="status-pos-access-loading">
          جارٍ التحقق من صلاحيات نقطة البيع...
        </p>
      </main>
    );
  }

  if (meQuery.isError || !meQuery.data) {
    return (
      <main dir="rtl" className="grid min-h-[100dvh] place-items-center bg-slate-50 p-6 text-slate-900">
        <section className="w-full max-w-md rounded-2xl border bg-white p-7 text-center shadow-sm">
          <h1 className="text-xl font-black">تعذّر التحقق من الجلسة</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">{meQuery.error instanceof Error ? meQuery.error.message : "يرجى تسجيل الدخول مجدداً."}</p>
          <Link href="/login" className="mt-5 inline-flex h-11 items-center justify-center rounded-xl bg-primary px-5 font-bold text-primary-foreground" data-testid="link-pos-login">
            تسجيل الدخول مجدداً
          </Link>
        </section>
      </main>
    );
  }

  const user = meQuery.data;
  const isSuperAdmin = user.role === "superadmin";
  const companyEnabled = user.companyMenuPermissions?.[feature] === true;
  const userAllowed = user.role === "admin" || user.permissions?.[feature]?.[action] === true;
  if (!isSuperAdmin && (!companyEnabled || !userAllowed)) {
    return (
      <main dir="rtl" className="grid min-h-[100dvh] place-items-center bg-slate-50 p-6 text-slate-900">
        <section className="w-full max-w-md rounded-2xl border bg-white p-7 text-center shadow-sm">
          <h1 className="text-xl font-black">لا تملك صلاحية الوصول</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">هذا الموديل غير مفعّل لشركتك أو لم يمنحك مدير الشركة صلاحية استخدامه.</p>
          <Link href="/" className="mt-5 inline-flex h-11 items-center justify-center rounded-xl border px-5 font-bold" data-testid="link-pos-home">
            العودة
          </Link>
        </section>
      </main>
    );
  }

  return children;
}

function CashierRoute() {
  return <PosAccessGate feature="pos_cashier"><CashierPage /></PosAccessGate>;
}

function SupermarketRoute() {
  return <PosAccessGate feature="pos_cashier"><SupermarketPage /></PosAccessGate>;
}

function ReturnsRoute() {
  return <PosAccessGate feature="pos_returns"><ReturnsPage /></PosAccessGate>;
}

function RestaurantRoute() {
  return <PosAccessGate feature="pos_waiter"><RestaurantHub /></PosAccessGate>;
}

function WaiterRoute() {
  return <PosAccessGate feature="pos_waiter"><WaiterApp /></PosAccessGate>;
}

function KitchenRoute() {
  return <PosAccessGate feature="pos_kitchen"><KitchenDisplay /></PosAccessGate>;
}

function RestaurantSettingsRoute() {
  return <PosAccessGate feature="pos_waiter" action="edit"><RestaurantSettings /></PosAccessGate>;
}

function RestaurantAIRoute() {
  return <PosAccessGate feature="pos_waiter"><RestaurantAI /></PosAccessGate>;
}

function Router() {
  return (
    <Switch>
      <Route path="/entry" component={PosEntry} />
      <Route path="/" component={LoginPage} />
      <Route path="/login" component={LoginPage} />
      <Route path="/pos" component={CashierRoute} />
      <Route path="/super" component={SupermarketRoute} />
      <Route path="/returns" component={ReturnsRoute} />
      <Route path="/restaurant" component={RestaurantRoute} />
      <Route path="/waiter" component={WaiterRoute} />
      <Route path="/kitchen" component={KitchenRoute} />
      <Route path="/restaurant-settings" component={RestaurantSettingsRoute} />
      <Route path="/restaurant-ai" component={RestaurantAIRoute} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  // Enter-as-Tab navigation across login + cashier forms — Enter on the last
  // field triggers the primary action (Login / Save). Open dropdowns and
  // textareas keep their default Enter behaviour. See useEnterAdvances.
  useEnterAdvances();
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
