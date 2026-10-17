import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ArrowUpLeft, BarChart3, Boxes, Building2, CalendarDays, ChevronDown, CircleAlert,
  Factory, FileText, Landmark, Package, RefreshCw, ShoppingBag, TrendingUp, Users,
} from "lucide-react";
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { appRouteHref } from "@/lib/appRouteHref";

type CurrencyTotal = { currencyCode: string; count: number; total: number };
type TrendPoint = { date: string; currencyCode: string; total: number; count: number };
type WarehouseStock = { warehouseId: number; nameAr: string; nameEn: string; qty: number; value: number };
type ModuleOverview = {
  sales: { invoicesByCurrency: CurrencyTotal[]; returnsByCurrency: CurrencyTotal[]; trend: TrendPoint[]; reportUrl: string } | null;
  purchases: { invoicesByCurrency: CurrencyTotal[]; returnsByCurrency: CurrencyTotal[]; trend: TrendPoint[]; reportUrl: string } | null;
  accounting: { postedEntries: number; totalsByCurrency: Array<{ currencyCode: string; debit: number; credit: number }>; reportUrl: string } | null;
  inventory: { items: number; warehouses: number; stockValue: number; belowReorder: number; byWarehouse: WarehouseStock[]; reportUrl: string } | null;
  production: { orders: number; produced: number; waste: number; byStatus: Array<{ status: string; count: number }>; reportUrl: string } | null;
  contracting: { projects: number; inProgress: number; completed: number; onHold: number; reportUrl: string } | null;
  hr: { employees: number; active: number; inactive: number; reportUrl: string } | null;
  fixedAssets: { assets: number; active: number; inMaintenance: number; reportUrl: string } | null;
  pos: { sessions: number; openSessions: number; closedSessions: number; reportUrl: string } | null;
  cash: { cashBoxes: number | null; bankAccounts: number | null; reportUrl: string } | null;
  maintenance: { orders: number; inProgress: number; scheduled: number; completed: number; reportUrl: string } | null;
  crm: { leads: number; opportunities: number; reportUrl: string } | null;
};
type ModuleKey = "sales" | "purchases" | "accounting" | "inventory" | "production" | "contracting" | "hr" | "fixedAssets" | "pos" | "cash" | "maintenance" | "crm";
type Overview = {
  options: {
    branches: Array<{ id: number; nameAr: string; nameEn: string }>;
    warehouses: Array<{ id: number; nameAr: string; nameEn: string; branchId: number }>;
  };
  modules: ModuleOverview;
  visibleModules: Record<ModuleKey, boolean>;
};

const API = import.meta.env.VITE_API_URL ?? "";
const today = () => new Date().toISOString().slice(0, 10);
const initialFrom = () => `${new Date().getFullYear()}-01-01`;
const moduleKeys: ModuleKey[] = ["sales", "purchases", "accounting", "inventory", "production", "contracting", "hr", "fixedAssets", "pos", "cash", "maintenance", "crm"];

function reportHref(reportUrl: string, params: Record<string, string>) {
  if (!reportUrl) return "#";
  try {
    const url = new URL(reportUrl, window.location.origin);
    Object.entries(params).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value);
    });
    return /^https?:\/\//.test(reportUrl) ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return reportUrl;
  }
}

export default function ModuleDashboards() {
  const { i18n } = useTranslation();
  const { token, user, actingCompanyId } = useAuth();
  const ar = i18n.language?.startsWith("ar") ?? true;
  const [fromDate, setFromDate] = useState(initialFrom);
  const [toDate, setToDate] = useState(today);
  const [branchId, setBranchId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [trendCurrency, setTrendCurrency] = useState<Record<string, string>>({});
  const companyId = actingCompanyId ?? user?.company?.id ?? user?.companyId;
  const labels = ar ? {
    title: "لوحات التشغيل", subtitle: "صورة موحّدة للأرقام التشغيلية، وفق صلاحيات وصولك.",
    range: "الفترة", from: "من تاريخ", to: "إلى تاريخ", branch: "الفرع", warehouse: "المستودع",
    allBranches: "كل الفروع المتاحة", allWarehouses: "كل المستودعات المتاحة", refresh: "تحديث",
    sales: "المبيعات", purchases: "المشتريات", accounting: "المحاسبة", inventory: "المخزون",
    production: "الإنتاج", contracting: "المقاولات", hr: "الموارد البشرية", fixedAssets: "الأصول الثابتة",
    pos: "نقاط البيع", cash: "النقد والبنوك", maintenance: "الصيانة", crm: "إدارة العملاء",
    invoices: "الفواتير", returns: "المرتجعات", count: "العدد", total: "الإجمالي",
    trend: "الحركة خلال الفترة", entries: "القيود المرحلة", debit: "مدين", credit: "دائن",
    items: "الأصناف", warehouses: "المستودعات", stockValue: "قيمة المخزون",
    reorder: "أصناف دون حد إعادة الطلب", byWarehouse: "تفصيل المستودعات",
    quantity: "الكمية", noData: "لا توجد بيانات لهذه الفترة والفلاتر.", noModules: "لا توجد لوحات تشغيل متاحة لحسابك.",
    error: "تعذر تحميل لوحات التشغيل.", retry: "إعادة المحاولة", report: "فتح التقرير", currency: "العملة",
    selectCurrency: "اختر العملة",
    snapshot: "الحالة الحالية", orders: "أوامر الإنتاج", produced: "الكمية المنتجة", waste: "الهالك",
    projects: "المشاريع", inProgress: "قيد التنفيذ", completed: "مكتملة", onHold: "متوقفة",
    employees: "الموظفون", active: "نشط", inactive: "غير نشط", assets: "الأصول",
    inMaintenance: "تحت الصيانة",
    sessions: "جلسات البيع", openSessions: "مفتوحة", closedSessions: "مغلقة",
    cashBoxes: "الخزن", bankAccounts: "الحسابات البنكية", maintenanceOrders: "أوامر الصيانة",
    scheduled: "مجدولة", leads: "العملاء المحتملون", opportunities: "الفرص",
  } : {
    title: "Operational dashboards", subtitle: "A consolidated view of operational activity within your access scope.",
    range: "Date range", from: "From date", to: "To date", branch: "Branch", warehouse: "Warehouse",
    allBranches: "All available branches", allWarehouses: "All available warehouses", refresh: "Refresh",
    sales: "Sales", purchases: "Purchases", accounting: "Accounting", inventory: "Inventory",
    production: "Production", contracting: "Contracting", hr: "Human resources", fixedAssets: "Fixed assets",
    pos: "Point of sale", cash: "Cash & banks", maintenance: "Maintenance", crm: "CRM",
    invoices: "Invoices", returns: "Returns", count: "Count", total: "Total",
    trend: "Activity over time", entries: "Posted entries", debit: "Debit", credit: "Credit",
    items: "Items", warehouses: "Warehouses", stockValue: "Stock value",
    reorder: "Below reorder level", byWarehouse: "Warehouse breakdown",
    quantity: "Quantity", noData: "No data for this period and filter selection.", noModules: "No operational dashboards are available for your account.",
    error: "Could not load operational dashboards.", retry: "Try again", report: "Open report", currency: "Currency",
    selectCurrency: "Select currency",
    snapshot: "Current snapshot", orders: "Production orders", produced: "Produced quantity", waste: "Waste",
    projects: "Projects", inProgress: "In progress", completed: "Completed", onHold: "On hold",
    employees: "Employees", active: "Active", inactive: "Inactive", assets: "Assets",
    inMaintenance: "In maintenance",
    sessions: "Sales sessions", openSessions: "Open", closedSessions: "Closed",
    cashBoxes: "Cash boxes", bankAccounts: "Bank accounts", maintenanceOrders: "Maintenance orders",
    scheduled: "Scheduled", leads: "Leads", opportunities: "Opportunities",
  };
  const query = useQuery<Overview>({
    queryKey: ["module-dashboards-overview", companyId, fromDate, toDate, branchId, warehouseId],
    enabled: Boolean(token),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (fromDate) params.set("fromDate", fromDate);
      if (toDate) params.set("toDate", toDate);
      if (branchId) params.set("branchId", branchId);
      if (warehouseId) params.set("warehouseId", warehouseId);
      const response = await fetch(`${API}/api/module-dashboards/overview?${params}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      return response.json() as Promise<Overview>;
    },
  });
  const data = query.data;
  const warehouses = useMemo(
    () => (data?.options.warehouses ?? []).filter(item => !branchId || String(item.branchId) === branchId),
    [data?.options.warehouses, branchId],
  );
  const visibleKeys = moduleKeys.filter(key => data?.visibleModules?.[key] && data.modules?.[key]);
  const filterParams = { fromDate, toDate, ...(branchId ? { branchId } : {}), ...(warehouseId ? { warehouseId } : {}) };
  const pickName = (nameAr: string, nameEn: string) => ar ? nameAr || nameEn : nameEn || nameAr;
  const money = (value: number) => new Intl.NumberFormat(ar ? "ar-SA" : "en", { maximumFractionDigits: 2 }).format(value);
  const moduleIcon = { sales: ShoppingBag, purchases: Boxes, accounting: Landmark, inventory: Package,
    production: Factory, contracting: Building2, hr: Users, fixedAssets: Package,
    pos: ShoppingBag, cash: Landmark, maintenance: Package, crm: Users };
  const moduleLabel = (key: ModuleKey) => labels[key];

  const renderCurrencyRows = (rows: CurrencyTotal[]) => rows.length ? (
    <div className="overflow-hidden rounded-xl border border-border/70">
      <div className="grid grid-cols-[1fr_auto_auto] gap-3 bg-muted/60 px-3 py-2 text-[11px] font-semibold text-muted-foreground">
        <span>{labels.currency}</span><span>{labels.count}</span><span>{labels.total}</span>
      </div>
      {rows.map((row, index) => (
        <div key={`${row.currencyCode}-${index}`} data-testid={`currency-row-${row.currencyCode}-${index}`}
          className="grid grid-cols-[1fr_auto_auto] gap-3 border-t border-border/60 px-3 py-2.5 text-sm">
          <span className="font-semibold tracking-wide">{row.currencyCode}</span>
          <span className="tabular-nums text-muted-foreground">{money(row.count)}</span>
          <span className="text-end font-semibold tabular-nums">{money(row.total)} <small className="text-[10px] font-medium text-muted-foreground">{row.currencyCode}</small></span>
        </div>
      ))}
    </div>
  ) : <p className="rounded-lg bg-muted/40 px-3 py-4 text-center text-xs text-muted-foreground">{labels.noData}</p>;

  const renderTrend = (points: TrendPoint[], moduleKey: "sales" | "purchases") => {
    const currencies = [...new Set(points.map(point => point.currencyCode))];
    const preferredCurrency = trendCurrency[moduleKey];
    const currency = currencies.includes(preferredCurrency) ? preferredCurrency : currencies[0];
    const chartData = points.filter(point => point.currencyCode === currency).map(point => ({
      date: point.date, total: point.total, count: point.count,
    }));
    return points.length ? <div className="mt-3">
      {currencies.length > 1 && <div className="mb-2 flex flex-wrap gap-1.5">
        {currencies.map(code => <button type="button" key={code} onClick={() => setTrendCurrency(current => ({ ...current, [moduleKey]: code }))}
          aria-pressed={code === currency} className={`rounded-md px-2 py-1 text-[10px] font-semibold ${code === currency ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>{code}</button>)}
      </div>}
      <div className="h-40 w-full" dir="ltr">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 4" vertical={false} />
            <XAxis dataKey="date" tickFormatter={(value: string) => value.slice(5)} tickLine={false} axisLine={false} fontSize={10} stroke="hsl(var(--muted-foreground))" />
            <YAxis tickLine={false} axisLine={false} fontSize={10} stroke="hsl(var(--muted-foreground))" />
            <Tooltip formatter={(value: number) => [money(value), currency]} labelFormatter={(value) => String(value)}
              contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 10, fontSize: 12 }} />
            <Line type="monotone" dataKey="total" stroke="hsl(var(--primary))" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {currencies.length > 1 && <p className="text-[10px] text-muted-foreground">{ar ? `الرسم يعرض ${currency} فقط؛ العملات لا تُجمع معاً.` : `Chart shows ${currency} only; currencies are never combined.`}</p>}
    </div> : <p className="rounded-lg bg-muted/40 px-3 py-4 text-center text-xs text-muted-foreground">{labels.noData}</p>;
  };

  const reportLink = (url: string, moduleKey: ModuleKey) => {
    const params = moduleKey === "inventory"
      ? { ...(branchId ? { branchId } : {}), ...(warehouseId ? { warehouseId } : {}) }
      : ["production", "contracting", "hr", "fixedAssets", "pos", "cash", "maintenance", "crm"].includes(moduleKey)
        ? (branchId ? { branchId } : {})
        : filterParams;
    return url ? <a href={appRouteHref(reportHref(url, params))} className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline" data-testid={`report-link-${url}`}>
    {labels.report}<ArrowUpLeft className="h-3.5 w-3.5" />
    </a> : null;
  };

  return <main dir={ar ? "rtl" : "ltr"} className="min-h-[60dvh] space-y-5 pb-8" data-testid="module-dashboards-page">
    <header className="relative overflow-hidden rounded-2xl border border-teal-900/10 bg-[linear-gradient(115deg,hsl(var(--primary)/.12),hsl(var(--card))_54%,hsl(var(--accent)/.55))] p-5 sm:p-7">
      <div className="absolute -end-10 -top-14 h-48 w-48 rounded-full border-[24px] border-primary/5" />
      <div className="relative flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[.16em] text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" /> Zacode ERP <span className="text-muted-foreground">/ {labels.range}</span>
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl" data-testid="text-module-dashboards-title">{labels.title}</h1>
          <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">{labels.subtitle}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}
          className="w-full gap-2 bg-background/80 sm:w-auto" data-testid="button-refresh-dashboards">
          <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} />{labels.refresh}
        </Button>
      </div>
    </header>

    <section className="rounded-2xl border bg-card p-4 shadow-sm sm:p-5" aria-label={labels.range}>
      <div className="mb-3 flex items-center gap-2 text-sm font-bold"><CalendarDays className="h-4 w-4 text-primary" />{labels.range}</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <label className="grid gap-1.5 text-xs font-semibold text-muted-foreground">{labels.from}
          <input type="date" value={fromDate} max={toDate || undefined} onChange={event => setFromDate(event.target.value)}
            className="h-10 min-w-0 rounded-lg border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30" data-testid="input-from-date" />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold text-muted-foreground">{labels.to}
          <input type="date" value={toDate} min={fromDate || undefined} onChange={event => setToDate(event.target.value)}
            className="h-10 min-w-0 rounded-lg border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30" data-testid="input-to-date" />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold text-muted-foreground">{labels.branch}
          <span className="relative"><select value={branchId} onChange={event => { setBranchId(event.target.value); setWarehouseId(""); }}
            className="h-10 w-full appearance-none rounded-lg border bg-background px-3 pe-9 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30" data-testid="select-branch">
            <option value="">{labels.allBranches}</option>{(data?.options.branches ?? []).map(branch => <option key={branch.id} value={branch.id}>{pickName(branch.nameAr, branch.nameEn)}</option>)}
          </select><ChevronDown className="pointer-events-none absolute end-3 top-3 h-4 w-4 text-muted-foreground" /></span>
        </label>
        <label className="grid gap-1.5 text-xs font-semibold text-muted-foreground">{labels.warehouse}
          <span className="relative"><select value={warehouseId} onChange={event => setWarehouseId(event.target.value)}
            className="h-10 w-full appearance-none rounded-lg border bg-background px-3 pe-9 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30" data-testid="select-warehouse">
            <option value="">{labels.allWarehouses}</option>{warehouses.map(warehouse => <option key={warehouse.id} value={warehouse.id}>{pickName(warehouse.nameAr, warehouse.nameEn)}</option>)}
          </select><ChevronDown className="pointer-events-none absolute end-3 top-3 h-4 w-4 text-muted-foreground" /></span>
        </label>
      </div>
    </section>

    {query.isLoading ? <div className="grid gap-4 xl:grid-cols-2">
      {[1, 2, 3, 4].map(index => <div key={index} className="animate-pulse rounded-2xl border bg-card p-5">
        <div className="mb-5 h-5 w-36 rounded bg-muted" /><div className="mb-3 h-20 rounded-xl bg-muted/70" /><div className="h-28 rounded-xl bg-muted/50" />
      </div>)}
    </div> : query.isError ? <div className="rounded-2xl border border-destructive/20 bg-destructive/5 p-6 text-center">
      <CircleAlert className="mx-auto mb-2 h-6 w-6 text-destructive" /><p className="text-sm font-semibold">{labels.error}</p>
      <Button variant="outline" size="sm" onClick={() => void query.refetch()} className="mt-3" data-testid="button-retry-dashboards">{labels.retry}</Button>
    </div> : visibleKeys.length === 0 ? <div className="rounded-2xl border border-dashed bg-card px-5 py-14 text-center">
      <BarChart3 className="mx-auto mb-3 h-8 w-8 text-primary/60" /><p className="text-sm font-semibold">{labels.noModules}</p>
    </div> : <div className="grid min-w-0 gap-4 xl:grid-cols-2">
      {visibleKeys.map(key => {
        const Icon = moduleIcon[key];
        const module: any = data!.modules[key]!;
        return <section key={key} className="min-w-0 overflow-hidden rounded-2xl border bg-card shadow-sm" data-testid={`module-card-${key}`}>
          <div className="flex items-center justify-between border-b border-border/70 px-4 py-4 sm:px-5">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Icon className="h-5 w-5" /></span>
            <div><h2 className="text-base font-bold">{moduleLabel(key)}</h2><p className="text-[11px] text-muted-foreground">
              {["inventory", "production", "contracting", "hr", "fixedAssets", "pos", "cash", "maintenance", "crm"].includes(key)
                ? (key === "inventory" ? (ar ? "الرصيد الحالي" : "Current balance") : labels.snapshot)
                : `${labels.range}: ${fromDate} — ${toDate}`}
            </p></div>
            </div>
            {reportLink(module.reportUrl, key)}
          </div>
          <div className="space-y-4 p-4 sm:p-5">
            {(key === "sales" || key === "purchases") && <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div><p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-foreground"><FileText className="h-3.5 w-3.5 text-primary" />{labels.invoices}</p>{renderCurrencyRows(module.invoicesByCurrency)}</div>
                <div><p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-foreground"><TrendingUp className="h-3.5 w-3.5 text-primary" />{labels.returns}</p>{renderCurrencyRows(module.returnsByCurrency)}</div>
              </div>
              <div className="border-t border-border/70 pt-3"><h3 className="text-xs font-bold">{labels.trend}</h3>{renderTrend(module.trend, key)}</div>
            </>}
            {key === "accounting" && <>
              <div className="rounded-xl bg-primary/[.06] p-4">
                <p className="text-xs font-semibold text-muted-foreground">{labels.entries}</p>
                <p className="mt-1 text-3xl font-extrabold tabular-nums">{money(module.postedEntries)}</p>
              </div>
              <div className="overflow-x-auto rounded-xl border border-border/70">
                <table className="w-full text-sm">
                  <thead className="bg-muted/60 text-[11px] text-muted-foreground"><tr><th className="px-3 py-2 text-start">{labels.currency}</th><th className="px-3 py-2 text-end">{labels.debit}</th><th className="px-3 py-2 text-end">{labels.credit}</th></tr></thead>
                  <tbody>{module.totalsByCurrency.map((row: { currencyCode: string; debit: number; credit: number }, index: number) => <tr key={`${row.currencyCode}-${index}`} className="border-t">
                    <td className="px-3 py-2.5 font-semibold">{row.currencyCode}</td><td className="px-3 py-2.5 text-end tabular-nums">{money(row.debit)}</td><td className="px-3 py-2.5 text-end tabular-nums">{money(row.credit)}</td>
                  </tr>)}</tbody>
                </table>
                {module.totalsByCurrency.length === 0 && <p className="p-4 text-center text-xs text-muted-foreground">{labels.noData}</p>}
              </div>
            </>}
            {key === "inventory" && <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  [labels.items, module.items], [labels.warehouses, module.warehouses],
                  [labels.stockValue, module.stockValue], [labels.reorder, module.belowReorder],
                ].map(([label, value]) => <div key={String(label)} className="rounded-xl bg-muted/55 p-3">
                  <p className="text-[10px] leading-tight text-muted-foreground">{label}</p><p className="mt-1.5 break-words text-lg font-bold tabular-nums">{money(Number(value))}</p>
                </div>)}
              </div>
              <div><h3 className="mb-2 text-xs font-bold">{labels.byWarehouse}</h3>
                <div className="overflow-x-auto rounded-xl border border-border/70">
                  <table className="w-full min-w-[420px] text-sm"><thead className="bg-muted/60 text-[11px] text-muted-foreground">
                    <tr><th className="px-3 py-2 text-start">{labels.warehouse}</th><th className="px-3 py-2 text-end">{labels.quantity}</th><th className="px-3 py-2 text-end">{labels.stockValue}</th></tr>
                  </thead><tbody>{module.byWarehouse.map((row: WarehouseStock) => <tr key={row.warehouseId} className="border-t">
                    <td className="px-3 py-2.5 font-semibold">{pickName(row.nameAr, row.nameEn)}</td><td className="px-3 py-2.5 text-end tabular-nums">{money(row.qty)}</td><td className="px-3 py-2.5 text-end tabular-nums">{money(row.value)}</td>
                  </tr>)}</tbody></table>
                  {module.byWarehouse.length === 0 && <p className="p-4 text-center text-xs text-muted-foreground">{labels.noData}</p>}
                </div>
              </div>
            </>}
            {key === "production" && <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[[labels.orders, module.orders], [labels.produced, module.produced], [labels.waste, module.waste]].map(([label, value]) =>
                  <div key={String(label)} className="rounded-xl bg-muted/55 p-3">
                    <p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1.5 text-lg font-bold tabular-nums">{money(Number(value))}</p>
                  </div>)}
              </div>
            </>}
            {key === "contracting" && <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[[labels.projects, module.projects], [labels.inProgress, module.inProgress], [labels.completed, module.completed], [labels.onHold, module.onHold]].map(([label, value]) =>
                  <div key={String(label)} className="rounded-xl bg-muted/55 p-3">
                    <p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1.5 text-lg font-bold tabular-nums">{money(Number(value))}</p>
                  </div>)}
              </div>
            </>}
            {key === "hr" && <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[[labels.employees, module.employees], [labels.active, module.active], [labels.inactive, module.inactive]].map(([label, value]) =>
                  <div key={String(label)} className="rounded-xl bg-muted/55 p-3">
                    <p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1.5 text-lg font-bold tabular-nums">{money(Number(value))}</p>
                  </div>)}
              </div>
            </>}
            {key === "fixedAssets" && <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[[labels.assets, module.assets], [labels.active, module.active], [labels.inMaintenance, module.inMaintenance]].map(([label, value]) =>
                  <div key={String(label)} className="rounded-xl bg-muted/55 p-3">
                    <p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1.5 text-lg font-bold tabular-nums">{money(Number(value))}</p>
                  </div>)}
              </div>
            </>}
            {key === "pos" && <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {[[labels.sessions, module.sessions], [labels.openSessions, module.openSessions], [labels.closedSessions, module.closedSessions]].map(([label, value]) =>
                <div key={String(label)} className="rounded-xl bg-muted/55 p-3"><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1.5 text-lg font-bold tabular-nums">{money(Number(value))}</p></div>)}
            </div>}
            {key === "cash" && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {module.cashBoxes !== null && <div className="rounded-xl bg-muted/55 p-3"><p className="text-[10px] text-muted-foreground">{labels.cashBoxes}</p><p className="mt-1.5 text-lg font-bold tabular-nums">{money(module.cashBoxes)}</p></div>}
              {module.bankAccounts !== null && <div className="rounded-xl bg-muted/55 p-3"><p className="text-[10px] text-muted-foreground">{labels.bankAccounts}</p><p className="mt-1.5 text-lg font-bold tabular-nums">{money(module.bankAccounts)}</p></div>}
            </div>}
            {key === "maintenance" && <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[[labels.maintenanceOrders, module.orders], [labels.inProgress, module.inProgress], [labels.scheduled, module.scheduled], [labels.completed, module.completed]].map(([label, value]) =>
                <div key={String(label)} className="rounded-xl bg-muted/55 p-3"><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1.5 text-lg font-bold tabular-nums">{money(Number(value))}</p></div>)}
            </div>}
            {key === "crm" && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[[labels.leads, module.leads], [labels.opportunities, module.opportunities]].map(([label, value]) =>
                <div key={String(label)} className="rounded-xl bg-muted/55 p-3"><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1.5 text-lg font-bold tabular-nums">{money(Number(value))}</p></div>)}
            </div>}
          </div>
        </section>;
      })}
    </div>}
  </main>;
}
