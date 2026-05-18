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

export type FreeReturnRow = {
  itemId: number | null;
  itemCode: string | null;
  itemName: string;
  unit: string | null;
  freeQty: number;
  returnCount: number;
  costPrice: number;
  sellPrice: number;
  vatRate: number;
  sellPriceIncVat: number;
  costTotal: number;
  sellTotal: number;
  sellTotalIncVat: number;
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

export type DailyReportSummary = {
  invoiceCount: number; customerCount: number; lineCount: number; totalQty: number;
  subtotal: number; discount: number; vatAmount: number; totalAmount: number; avgInvoice: number;
  cashCount: number; cashAmount: number;
  bankCount: number; bankAmount: number;
  creditCount: number; creditAmount: number;
  returnCount: number; returnAmount: number; returnVat: number; netSales: number;
  receiptsCount: number; receiptsAmount: number;
};

export type DailyReportInvoice = {
  id: number; docNumber: string | null; time: string;
  customerId: number | null; customerNameAr: string; customerNameEn: string | null;
  salesRepId: number | null; salesRepNameAr: string | null; salesRepNameEn: string | null;
  branchId: number | null;   branchNameAr: string | null;   branchNameEn: string | null;
  lineCount: number; totalQty: number;
  subtotal: number; discount: number; vatAmount: number; totalAmount: number;
  paymentType: string; status: string; zatcaStatus: string | null;
};

export type DailyReportTopItem = {
  itemId: number | null; itemCode: string | null; itemName: string;
  qty: number; totalSales: number; invoiceCount: number;
};

export type DailyReportTopCustomer = {
  customerId: number | null; customerNameAr: string; customerNameEn: string | null;
  invoiceCount: number; totalSales: number;
};

export type DailyReportByRep = {
  salesRepId: number | null; salesRepNameAr: string; salesRepNameEn: string | null;
  invoiceCount: number; totalSales: number;
};

export type DailyReportByBranch = {
  branchId: number | null; branchNameAr: string; branchNameEn: string | null;
  invoiceCount: number; totalSales: number;
};

export type DailyReportByHour = { hour: number; invoiceCount: number; totalAmount: number };

export type DailyReportReceipt = {
  id: number; code: string; time: string;
  entityName: string | null; paymentType: string; amount: number;
};

export type DailyReport = {
  date: string;
  summary: DailyReportSummary;
  invoices:     DailyReportInvoice[];
  topItems:     DailyReportTopItem[];
  topCustomers: DailyReportTopCustomer[];
  byRep:        DailyReportByRep[];
  byBranch:     DailyReportByBranch[];
  byHour:       DailyReportByHour[];
  receipts:     DailyReportReceipt[];
};

// Detailed customer ledger row — extends the basic statement row with the
// embedded line-item drilldown (for invoices/returns) and voucher metadata
// (for receipts). Shape mirrors the server's /customer-statement-detailed.
export type CustomerStatementDetailedLineItem = {
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
export type CustomerStatementDetailedReceiptMeta = {
  paymentType: string | null;
  cashBoxName: string | null;
  bankAccountName: string | null;
  refNumber: string | null;
  description: string | null;
};
export type CustomerStatementDetailedRow = {
  id: number;
  date: string;
  type: "invoice" | "return" | "receipt";
  docNumber: string | null;
  debit: number;
  credit: number;
  description: string;
  // Payment method of the source document. For invoices/returns this is
  // 'credit' | 'cash' | 'bank'; for receipts it mirrors meta.paymentType.
  // Cash/bank invoices and returns have debit == credit (self-settled).
  paymentType?: string | null;
  vatAmount?: number;
  discountAmount?: number;
  lines?: CustomerStatementDetailedLineItem[];
  meta?: CustomerStatementDetailedReceiptMeta;
};
export type CustomerStatementDetailed = { opening: number; lines: CustomerStatementDetailedRow[] };

export type ProfitabilityLevel = "invoice" | "customer" | "branch";

export type ProfitabilityRow = {
  key: string;
  label: string;
  sublabel?: string | null;
  invoiceId?: number;
  invoiceNo?: string | null;
  invoiceDate?: string | null;
  customerId?: number | null;
  branchId?: number | null;
  docCount: number;
  revenue: number;
  cogs: number;
  profit: number;
  margin: number;
};

export type ProfitabilityReport = {
  level: ProfitabilityLevel;
  rows: ProfitabilityRow[];
  totals: { revenue: number; cogs: number; profit: number; margin: number };
};

export const salesAnalyticsApi = {
  profitability: (cid: number | undefined, params: {
    level: ProfitabilityLevel;
    from?: string; to?: string;
    branchId?: number | string;
    customerId?: number | string;
    itemId?: number | string;
  }) => get<ProfitabilityReport>(`/profitability${qs({
    companyId: cid,
    level: params.level,
    from: params.from,
    to: params.to,
    branchId: params.branchId,
    customerId: params.customerId,
    itemId: params.itemId,
  })}`),
  byCustomer:        (cid?: number, from?: string, to?: string, branchId?: number) =>
    get<SalesByCustomerRow[]>(`/by-customer${qs({ companyId: cid, from, to, branchId })}`),
  byItem:            (cid?: number, from?: string, to?: string, branchId?: number, regionId?: number) =>
    get<SalesByItemRow[]>(`/by-item${qs({ companyId: cid, from, to, branchId, regionId })}`),
  freeReturns:       (cid?: number, from?: string, to?: string, branchId?: number, regionId?: number) =>
    get<FreeReturnRow[]>(`/free-returns${qs({ companyId: cid, from, to, branchId, regionId })}`),
  byPeriod:          (cid?: number, from?: string, to?: string, groupBy: "day" | "month" = "day", branchId?: number) =>
    get<SalesByPeriodRow[]>(`/by-period${qs({ companyId: cid, from, to, groupBy, branchId })}`),
  customerStatement: (cid: number | undefined, customerId: number, from?: string, to?: string, branchId?: number) =>
    get<CustomerStatement>(`/customer-statement${qs({ companyId: cid, customerId, from, to, branchId })}`),
  customerStatementDetailed: (cid: number | undefined, customerId: number, from?: string, to?: string, branchId?: number) =>
    get<CustomerStatementDetailed>(`/customer-statement-detailed${qs({ companyId: cid, customerId, from, to, branchId })}`),
  aging:             (cid?: number, asOf?: string, branchId?: number) =>
    get<AgingRow[]>(`/aging${qs({ companyId: cid, asOf, branchId })}`),
  returnsByCustomer: (cid?: number, from?: string, to?: string, branchId?: number, regionId?: number) =>
    get<ReturnsByCustomerRow[]>(`/returns-by-customer${qs({ companyId: cid, from, to, branchId, regionId })}`),
  dailyReport:       (cid?: number, date?: string, branchId?: number, source?: "all" | "manual" | "pos") =>
    get<DailyReport>(`/daily-report${qs({ companyId: cid, date, branchId, source })}`),
  paymentMixReport:  (cid?: number, date?: string, branchId?: number) =>
    get<PaymentMixReport>(`/payment-mix-report${qs({ companyId: cid, date, branchId })}`),
  paymentMixAiInsights: async (payload: PaymentMixReport & { language?: "ar" | "en" }): Promise<PaymentMixAiInsights> => {
    const r = await fetch(`${API}/api/sales-analytics/payment-mix-report/ai-insights`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  dailyDetailedReport: (cid?: number, date?: string, branchId?: number) =>
    get<DailyDetailedReport>(`/daily-detailed-report${qs({ companyId: cid, date, branchId })}`),
};

export type DailyDetailedInvoice = {
  id: number;
  docNumber: string | null;
  time: string;
  customerId: number | null;
  customerNameAr: string;
  customerNameEn: string | null;
  branchId: number | null;
  branchNameAr: string | null;
  branchNameEn: string | null;
  salesRepId: number | null;
  salesRepNameAr: string | null;
  salesRepNameEn: string | null;
  paymentType: string;
  status: string;
  zatcaStatus: string | null;
  lineCount: number;
  totalQty: number;
  subtotal: number;
  discount: number;
  vatAmount: number;
  totalAmount: number;
};

export type DailyDetailedLine = {
  invoiceId: number;
  invoiceDocNumber: string | null;
  lineId: number;
  itemId: number | null;
  itemCode: string | null;
  itemName: string;
  unit: string | null;
  qty: number;
  unitPrice: number;
  discount: number;
  vatRate: number;
  lineTotal: number;
};

export type DailyDetailedItemRow = {
  itemId: number | null;
  itemCode: string | null;
  itemName: string;
  unit: string | null;
  qty: number;
  totalSales: number;
  invoiceCount: number;
};

export type DailyDetailedReport = {
  date: string;
  totals: {
    invoiceCount: number;
    receiptCount: number;
    invoicesAmount: number;
    receiptsAmount: number;
    totalAmount: number;
    methodsCount: number;
    lineCount: number;
    totalQty: number;
    subtotal: number;
    discount: number;
    vatAmount: number;
  };
  rows: PaymentMixMethodRow[];
  byHour: PaymentMixHourCell[];
  byBranch: PaymentMixBranchRow[];
  topCustomers: PaymentMixCustomerRow[];
  invoices: DailyDetailedInvoice[];
  lines: DailyDetailedLine[];
  byItem: DailyDetailedItemRow[];
};

export type PaymentMixMethodRow = {
  method: string;
  label: { ar: string; en: string };
  invoiceCount: number;
  receiptCount: number;
  invoicesAmount: number;
  receiptsAmount: number;
  totalAmount: number;
};
export type PaymentMixHourCell = { hour: number; method: string; amount: number; count: number };
export type PaymentMixBranchRow = {
  branchId: number | null;
  branchNameAr: string;
  branchNameEn: string | null;
  methods: Record<string, { count: number; amount: number }>;
  totalAmount: number;
};
export type PaymentMixCustomerRow = {
  customerId: number | null;
  customerNameAr: string;
  customerNameEn: string | null;
  methods: Record<string, { count: number; amount: number }>;
  totalAmount: number;
};
export type PaymentMixReport = {
  date: string;
  totals: {
    invoiceCount: number;
    receiptCount: number;
    invoicesAmount: number;
    receiptsAmount: number;
    totalAmount: number;
    methodsCount: number;
  };
  rows: PaymentMixMethodRow[];
  byHour: PaymentMixHourCell[];
  byBranch: PaymentMixBranchRow[];
  topCustomers: PaymentMixCustomerRow[];
};
export type PaymentMixAiInsights = {
  headline: string;
  highlights: string[];
  concerns: string[];
  recommendation: string;
};
