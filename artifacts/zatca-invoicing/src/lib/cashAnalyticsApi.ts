const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}/api/cash-analytics${path}`, { headers: authHeaders() });
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

export type CashBoxBalanceRow = {
  id: number; code: string; nameAr: string; nameEn: string | null;
  currencyId: number | null; isActive: boolean;
  totalIn: number; totalOut: number; balance: number;
};

export type BankBalanceRow = {
  id: number; code: string; nameAr: string; nameEn: string | null;
  bankName: string | null; accountNumber: string | null; iban: string | null;
  currencyId: number | null; isActive: boolean;
  totalIn: number; totalOut: number; balance: number;
};

export type StatementLine = {
  id: number;
  date: string;
  type: "receipt" | "payment" | "transfer_in" | "transfer_out";
  docNumber: string | null;
  description: string;
  debit: number;
  credit: number;
};

export type AccountStatement = { opening: number; lines: StatementLine[] };

export type DailySummaryRow = {
  date: string;
  totalIn: number;
  totalOut: number;
  receiptCount: number;
  paymentCount: number;
  net: number;
};

export type VoucherRow = {
  id: number;
  code: string;
  date: string;
  paymentType: "cash" | "bank";
  paymentTypeLabel: string;
  cashBoxId: number | null;
  bankAccountId: number | null;
  entityType: "customer" | "supplier" | "other";
  entityTypeLabel: string;
  entityName: string | null;
  description: string | null;
  amount: number;
};

export type TransferRow = {
  id: number;
  code: string;
  date: string;
  transferType: string;
  transferTypeLabel: string;
  fromName: string;
  toName: string;
  description: string | null;
  amount: number;
};

export const cashAnalyticsApi = {
  cashBalances:     (cid?: number, asOf?: string, branchId?: number) =>
    get<CashBoxBalanceRow[]>(`/cash-balances${qs({ companyId: cid, asOf, branchId })}`),
  bankBalances:     (cid?: number, asOf?: string, branchId?: number) =>
    get<BankBalanceRow[]>(`/bank-balances${qs({ companyId: cid, asOf, branchId })}`),
  cashBoxStatement: (cid: number | undefined, cashBoxId: number, from?: string, to?: string, branchId?: number) =>
    get<AccountStatement>(`/cash-box-statement${qs({ companyId: cid, cashBoxId, from, to, branchId })}`),
  bankStatement:    (cid: number | undefined, bankAccountId: number, from?: string, to?: string, branchId?: number) =>
    get<AccountStatement>(`/bank-statement${qs({ companyId: cid, bankAccountId, from, to, branchId })}`),
  dailySummary:     (cid?: number, from?: string, to?: string, scope: "all" | "cash" | "bank" = "all", branchId?: number) =>
    get<DailySummaryRow[]>(`/daily-summary${qs({ companyId: cid, from, to, scope, branchId })}`),
  receipts:         (cid: number | undefined, p: { from?: string; to?: string; paymentType?: string; cashBoxId?: number; bankAccountId?: number; entityType?: string; branchId?: number }) =>
    get<VoucherRow[]>(`/receipts${qs({ companyId: cid, ...p })}`),
  payments:         (cid: number | undefined, p: { from?: string; to?: string; paymentType?: string; cashBoxId?: number; bankAccountId?: number; entityType?: string; branchId?: number }) =>
    get<VoucherRow[]>(`/payments${qs({ companyId: cid, ...p })}`),
  transfers:        (cid?: number, from?: string, to?: string, transferType?: string, branchId?: number) =>
    get<TransferRow[]>(`/transfers${qs({ companyId: cid, from, to, transferType, branchId })}`),
};
