const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}/api/sales-analytics${path}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  });
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export type SalesByCustomerRow = {
  customerId: number | null;
  customerNameAr: string;
  customerNameEn: string | null;
  invoiceCount: number;
  totalSales: number;
  subtotal: number;
  vatAmount: number;
  totalReturns: number;
  netSales: number;
  totalPaid: number;
};

export type SalesByItemRow = {
  itemId: number | null;
  itemCode: string | null;
  itemName: string;
  unit: string | null;
  qty: number;
  totalSales: number;
  invoiceCount: number;
};

export type SalesByPeriodRow = {
  period: string;
  invoiceCount: number;
  subtotal: number;
  vatAmount: number;
  totalAmount: number;
};

export type CustomerStatementLine = {
  date: string;
  type: "invoice" | "return" | "receipt";
  docNumber: string | null;
  debit: number;
  credit: number;
  description: string;
};

export type CustomerStatement = { opening: number; lines: CustomerStatementLine[] };

export type AgingRow = {
  customerId: number;
  customerNameAr: string;
  customerNameEn: string | null;
  phone: string | null;
  current: number;
  d30: number;
  d60: number;
  d90: number;
  d90plus: number;
  total: number;
};

export type ReturnsByCustomerRow = {
  customerId: number | null;
  customerNameAr: string;
  customerNameEn: string | null;
  returnCount: number;
  totalAmount: number;
  totalVat: number;
};

export const salesAnalyticsApi = {
  byCustomer:        (cid?: number, from?: string, to?: string) => get<SalesByCustomerRow[]>(`/by-customer${qs({ companyId: cid, from, to })}`),
  byItem:            (cid?: number, from?: string, to?: string) => get<SalesByItemRow[]>(`/by-item${qs({ companyId: cid, from, to })}`),
  byPeriod:          (cid?: number, from?: string, to?: string, groupBy: "day" | "month" = "day") =>
    get<SalesByPeriodRow[]>(`/by-period${qs({ companyId: cid, from, to, groupBy })}`),
  customerStatement: (cid: number | undefined, customerId: number, from?: string, to?: string) =>
    get<CustomerStatement>(`/customer-statement${qs({ companyId: cid, customerId, from, to })}`),
  aging:             (cid?: number, asOf?: string) => get<AgingRow[]>(`/aging${qs({ companyId: cid, asOf })}`),
  returnsByCustomer: (cid?: number, from?: string, to?: string) => get<ReturnsByCustomerRow[]>(`/returns-by-customer${qs({ companyId: cid, from, to })}`),
};
