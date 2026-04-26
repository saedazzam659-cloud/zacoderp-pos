const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  });
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export type DashboardKpis = {
  todayNetSales: number;
  todayInvoiceCount: number;
  todayPostedCount: number;
  weekNetSales: number;
  weekInvoiceCount: number;
  monthNetSales: number;
  monthInvoiceCount: number;
  avgInvoiceMonth: number;
  cashCollectedToday: number;
  cashReceiptsCount: number;
  topCustomer: {
    customerId: number | null;
    nameAr: string;
    nameEn: string | null;
    total: number;
  } | null;
  topItem: {
    itemId: number | null;
    name: string;
    total: number;
    qty: number;
  } | null;
};

export type DashboardCharts = {
  sales30d:    Array<{ date: string;  total: number; count: number }>;
  paymentMix:  Array<{ paymentType: string; total: number; count: number }>;
  byBranch:    Array<{ branchId: number | null; branchNameAr: string; branchNameEn: string | null; total: number; count: number }>;
  monthly12m:  Array<{ month: string; total: number; count: number }>;
};

export type DashboardAlerts = {
  zatcaPendingCount: number;
  lowStockCount: number;
  openPosSessionsCount: number;
  unreadNotificationsCount: number;
  lowStockSample: Array<{
    itemId: number; code: string; nameAr: string; nameEn: string | null;
    reorderLevel: number; currentQty: number;
  }>;
  openSessionsSample: Array<{
    id: number; userId: number; branchId: number | null;
    openedAt: string | Date; openingCash: number;
  }>;
};

export type DashboardMyDay = {
  userId: number | null;
  myTodayNetSales: number;
  myTodayInvoiceCount: number;
  myDraftsCount: number;
  myRecentInvoices: Array<{
    id: number;
    docNumber: string | null;
    invoiceDate: string;
    status: string;
    totalAmount: number;
    customerId: number | null;
  }>;
};

export type DashboardOverview = {
  date: string;
  kpis:   DashboardKpis;
  charts: DashboardCharts;
  alerts: DashboardAlerts;
  myDay:  DashboardMyDay;
};

export const dashboardOverviewApi = {
  async overview(opts: { date?: string; branchId?: number } = {}): Promise<DashboardOverview> {
    const r = await fetch(
      `${API}/api/dashboard/overview${qs({ date: opts.date, branchId: opts.branchId })}`,
      { headers: authHeaders() },
    );
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
};
