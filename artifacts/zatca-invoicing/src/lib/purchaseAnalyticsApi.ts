const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}/api/purchases-analytics${path}`, { headers: authHeaders() });
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

export type PurchasesBySupplierRow = {
  supplierId: number | null;
  supplierNameAr: string;
  supplierNameEn: string | null;
  invoiceCount: number;
  totalPurchases: number;
  subtotal: number;
  vatAmount: number;
  totalReturns: number;
  netPurchases: number;
  totalPaid: number;
};

export type PurchasesByItemRow = {
  itemId: number | null;
  itemCode: string | null;
  itemName: string;
  unit: string | null;
  qty: number;
  totalPurchases: number;
  invoiceCount: number;
};

export type PurchasesByPeriodRow = {
  period: string;
  invoiceCount: number;
  subtotal: number;
  vatAmount: number;
  totalAmount: number;
};

export type SupplierStatementLine = {
  date: string;
  type: "invoice" | "return" | "payment";
  docNumber: string | null;
  debit: number;
  credit: number;
  description: string;
};

export type SupplierStatement = { opening: number; lines: SupplierStatementLine[] };

export type SupplierAgingRow = {
  supplierId: number;
  supplierNameAr: string;
  supplierNameEn: string | null;
  phone: string | null;
  current: number;
  d30: number;
  d60: number;
  d90: number;
  d90plus: number;
  total: number;
};

export type ReturnsBySupplierRow = {
  supplierId: number | null;
  supplierNameAr: string;
  supplierNameEn: string | null;
  returnCount: number;
  totalAmount: number;
  totalVat: number;
};

// Detailed supplier ledger row — extends the basic statement row with the
// embedded line-item drilldown (invoices/returns) and voucher metadata
// (سند صرف). Shape mirrors the server's /supplier-statement-detailed.
export type SupplierStatementDetailedLineItem = {
  itemCode: string | null;
  itemName: string;
  unit: string | null;
  qty: number;
  unitPrice: number;
  discount: number;
  vatRate: number;
  vatAmount: number;
  netAmount: number;
  lineTotal: number;
};
export type SupplierStatementDetailedPaymentMeta = {
  paymentType: string | null;
  cashBoxName: string | null;
  bankAccountName: string | null;
  refNumber: string | null;
  description: string | null;
};
export type SupplierStatementDetailedRow = {
  id: number;
  date: string;
  type: "invoice" | "return" | "payment";
  docNumber: string | null;
  debit: number;
  credit: number;
  description: string;
  // Payment method of the source document. For invoices/returns this is
  // 'credit' | 'cash' | 'bank'; for payments it mirrors meta.paymentType.
  // Cash/bank invoices and returns have debit == credit (self-settled).
  paymentType?: string | null;
  vatAmount?: number;
  discountAmount?: number;
  lines?: SupplierStatementDetailedLineItem[];
  meta?: SupplierStatementDetailedPaymentMeta;
};
export type SupplierStatementDetailed = { opening: number; lines: SupplierStatementDetailedRow[] };

export const purchaseAnalyticsApi = {
  bySupplier:        (cid?: number, from?: string, to?: string, branchId?: number) =>
    get<PurchasesBySupplierRow[]>(`/by-supplier${qs({ companyId: cid, from, to, branchId })}`),
  byItem:            (cid?: number, from?: string, to?: string, branchId?: number) =>
    get<PurchasesByItemRow[]>(`/by-item${qs({ companyId: cid, from, to, branchId })}`),
  byPeriod:          (cid?: number, from?: string, to?: string, groupBy: "day" | "month" = "day", branchId?: number) =>
    get<PurchasesByPeriodRow[]>(`/by-period${qs({ companyId: cid, from, to, groupBy, branchId })}`),
  supplierStatement: (cid: number | undefined, supplierId: number, from?: string, to?: string, branchId?: number) =>
    get<SupplierStatement>(`/supplier-statement${qs({ companyId: cid, supplierId, from, to, branchId })}`),
  supplierStatementDetailed: (cid: number | undefined, supplierId: number, from?: string, to?: string, branchId?: number) =>
    get<SupplierStatementDetailed>(`/supplier-statement-detailed${qs({ companyId: cid, supplierId, from, to, branchId })}`),
  aging:             (cid?: number, asOf?: string, branchId?: number) =>
    get<SupplierAgingRow[]>(`/aging${qs({ companyId: cid, asOf, branchId })}`),
  returnsBySupplier: (cid?: number, from?: string, to?: string, branchId?: number) =>
    get<ReturnsBySupplierRow[]>(`/returns-by-supplier${qs({ companyId: cid, from, to, branchId })}`),
};
