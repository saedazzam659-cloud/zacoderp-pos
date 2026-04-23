// Shared ERP API client for the POS app.
// Uses the same `zatca_token` localStorage key as the main ZATCA app
// so a single sign-in works across both products on the same domain.

const API = (import.meta.env.VITE_API_URL ?? "") as string;
const TOKEN_KEY = "zatca_token";
const USER_KEY = "zatca_user";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function getStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

export function setStoredUser(user: AuthUser): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function handle<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = "حدث خطأ في الاتصال";
    try {
      const data = await r.json();
      msg = data?.error || data?.message || msg;
    } catch {
      try {
        msg = await r.text();
      } catch {}
    }
    if (r.status === 401) clearAuth();
    throw new Error(msg);
  }
  if (r.status === 204) return undefined as T;
  return r.json() as Promise<T>;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handle<T>(r);
}

// ─── Types ────────────────────────────────────────────────────────────────

export type AuthUser = {
  id: number;
  username: string;
  email: string | null;
  role: string;
  companyId: number | null;
  nameAr?: string | null;
  company?: {
    id: number;
    nameAr: string;
    nameEn?: string | null;
    vatNumber: string;
    crNumber: string;
    city?: string | null;
  } | null;
};

export type LoginResponse = {
  token: string;
  sessionId: string;
  user: AuthUser;
};

export type Branch = {
  id: number;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  city?: string | null;
};

export type CashBox = {
  id: number;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  branchId?: number | null;
  accountId?: number | null;
};

export type ItemGroup = {
  id: number;
  code: string;
  nameAr: string;
  nameEn?: string | null;
};

export type Warehouse = {
  id: number;
  code: string;
  nameAr: string;
  isActive?: boolean;
};

export type Item = {
  id: number;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  barcode?: string | null;
  groupId?: number | null;
  unitId?: number | null;
  itemType: "stock" | "service";
  salePrice: string;
  costPrice: string;
  vatRate: string;
  imageUrl?: string | null;
  unit?: { id: number; nameAr: string } | null;
  group?: { id: number; nameAr: string } | null;
};

export type Customer = {
  id: number;
  nameAr: string;
  vatNumber?: string | null;
  phone?: string | null;
};

export type CreateInvoiceLine = {
  itemId: number;
  itemName: string;
  itemCode?: string | null;
  unit?: string | null;
  unitId?: number | null;
  warehouseId?: number | null;
  qty: number;
  unitPrice: number;
  discount: number;
  vatRate: number;
  lineTotal: number;
};

export type CreateInvoiceBody = {
  invoiceDate: string;
  customerId?: number | null;
  branchId?: number | null;
  paymentType: "cash" | "bank" | "credit";
  cashBoxId?: number | null;
  bankAccountId?: number | null;
  currencyCode?: string;
  subtotal: number;
  vatAmount: number;
  discountAmount: number;
  totalAmount: number;
  priceIncludesVat?: boolean;
  notes?: string | null;
  lines: CreateInvoiceLine[];
  posSessionId?: number | null;
};

export type PosTerminal = {
  id:          number;
  code:        string;
  nameAr:      string;
  nameEn:      string | null;
  branchId:    number;
  branchName:  string | null;
  machineCode: string | null;
  cashBoxId:   number | null;
  cashBoxName: string | null;
  isActive:    boolean;
  notes:       string | null;
  busyUserId:  number | null;
};

export type PosSession = {
  id: number;
  companyId: number;
  userId: number;
  branchId: number | null;
  cashBoxId: number | null;
  posTerminalId?: number | null;
  openingCash: string;
  closingCash: string | null;
  openedAt: string;
  closedAt: string | null;
  status: "open" | "closed" | "force_closed";
};

export type SalesInvoice = {
  id: number;
  docNumber: string | null;
  invoiceDate: string;
  totalAmount: string;
  status: string;
  customerName?: string | null;
  customerId?: number | null;
  branchId?: number | null;
  subtotal?: string;
  vatAmount?: string;
  discountAmount?: string;
  priceIncludesVat?: boolean;
  paymentType?: string;
  currencyCode?: string;
  lines?: SalesInvoiceLine[];
};

export type SalesInvoiceLine = {
  id: number;
  itemId: number | null;
  itemName: string;
  itemCode?: string | null;
  unit?: string | null;
  unitId?: number | null;
  warehouseId?: number | null;
  qty: string;
  unitPrice: string;
  discount?: string;
  vatRate: string;
  lineTotal: string;
};

export type CreateReturnLine = {
  itemId: number | null;
  itemName: string;
  itemCode?: string | null;
  unit?: string | null;
  unitId?: number | null;
  warehouseId?: number | null;
  qty: number;
  unitPrice: number;
  discount?: number;
  vatRate: number;
  lineTotal: number;
};

export type CreateReturnBody = {
  returnDate: string;
  customerId?: number | null;
  branchId?: number | null;
  invoiceId?: number | null;
  paymentType: "cash" | "bank" | "credit";
  cashBoxId?: number | null;
  bankAccountId?: number | null;
  currencyCode?: string;
  totalAmount: number;
  vatAmount: number;
  discountAmount: number;
  priceIncludesVat?: boolean;
  notes?: string | null;
  lines: CreateReturnLine[];
};

// ─── Endpoints ────────────────────────────────────────────────────────────

export const api = {
  // Auth
  login: (username: string, password: string) =>
    req<LoginResponse>("POST", "/api/auth/login", { username, password }),
  me: () => req<AuthUser>("GET", "/api/auth/me"),
  logout: () => req<{ ok: true }>("POST", "/api/auth/logout"),

  // Inventory
  getItems: (companyId: number) =>
    req<Item[]>("GET", `/api/inventory/items?companyId=${companyId}`),
  getItemGroups: (companyId: number) =>
    req<ItemGroup[]>("GET", `/api/inventory/item-groups?companyId=${companyId}`),
  getWarehouses: (companyId: number) =>
    req<Warehouse[]>("GET", `/api/inventory/warehouses?companyId=${companyId}`),

  // Org
  getBranches: (companyId: number) =>
    req<Branch[]>("GET", `/api/org/branches?companyId=${companyId}`),
  getCashBoxes: (companyId: number) =>
    req<CashBox[]>("GET", `/api/cash-boxes?companyId=${companyId}`),

  // Customers
  getCustomers: (companyId: number) =>
    req<Customer[]>("GET", `/api/customers?companyId=${companyId}`),

  // POS payment-method → account mappings (per company)
  getPosSettings: (companyId: number) =>
    req<{
      posCashCashBoxId:       number | null;
      posCardBankAccountId:   number | null;
      posAppleBankAccountId:  number | null;
      posWalletBankAccountId: number | null;
    }>("GET", `/api/companies/${companyId}/pos-settings`),

  // Sales
  createSalesInvoice: (body: CreateInvoiceBody) =>
    req<SalesInvoice>("POST", "/api/sales/sales-invoices", body),
  postSalesInvoice: (id: number) =>
    req<SalesInvoice>("PATCH", `/api/sales/sales-invoices/${id}/post`),
  listSalesInvoices: (companyId: number, q?: string) =>
    req<SalesInvoice[]>("GET", `/api/sales/sales-invoices?companyId=${companyId}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  getSalesInvoice: (id: number) =>
    req<SalesInvoice>("GET", `/api/sales/sales-invoices/${id}`),
  listSalesReturns: (companyId: number) =>
    req<SalesInvoice[]>("GET", `/api/sales/sales-returns?companyId=${companyId}`),
  createSalesReturn: (body: CreateReturnBody) =>
    req<{ id: number; docNumber: string | null }>("POST", "/api/sales/sales-returns", body),
  postSalesReturn: (id: number) =>
    req<{ id: number }>("PATCH", `/api/sales/sales-returns/${id}/post`),

  // POS Terminals (طرق البيع) — for the login picker.
  getPosTerminals: (opts?: { branchId?: number; activeOnly?: boolean }) => {
    const qs = new URLSearchParams();
    if (opts?.branchId)   qs.set("branchId", String(opts.branchId));
    if (opts?.activeOnly) qs.set("activeOnly", "1");
    const s = qs.toString();
    return req<PosTerminal[]>("GET", `/api/pos-terminals${s ? `?${s}` : ""}`);
  },

  // POS Sessions
  getCurrentPosSession: () =>
    req<PosSession | null>("GET", "/api/pos-sessions/current"),
  openPosSession: (body: {
    branchId?: number | null;
    cashBoxId?: number | null;
    openingCash?: number;
    device?: string;
    posTerminalId?: number | null;
    machineCode?: string | null;
  }) =>
    req<PosSession>("POST", "/api/pos-sessions/open", body),
  closePosSession: (id: number, body: { closingCash?: number; notes?: string }) =>
    req<PosSession>("POST", `/api/pos-sessions/${id}/close`, body),
};

const POS_SESSION_KEY = "zatca_pos_session_id";
export function getPosSessionId(): number | null {
  try {
    const v = localStorage.getItem(POS_SESSION_KEY);
    return v ? Number(v) : null;
  } catch { return null; }
}
export function setPosSessionId(id: number | null): void {
  try {
    if (id == null) localStorage.removeItem(POS_SESSION_KEY);
    else localStorage.setItem(POS_SESSION_KEY, String(id));
  } catch {}
}
