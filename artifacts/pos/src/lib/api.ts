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
};

export type SalesInvoice = {
  id: number;
  docNumber: string | null;
  invoiceDate: string;
  totalAmount: string;
  status: string;
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

  // Sales
  createSalesInvoice: (body: CreateInvoiceBody) =>
    req<SalesInvoice>("POST", "/api/sales/sales-invoices", body),
  postSalesInvoice: (id: number) =>
    req<SalesInvoice>("PATCH", `/api/sales/sales-invoices/${id}/post`),
};
