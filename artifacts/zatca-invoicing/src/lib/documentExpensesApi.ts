// Client for internal document expenses (see .local/invoice-expense-contract.md).
// GET/PUT /api/document-expenses/:documentType/:documentId
const API = import.meta.env.VITE_API_URL ?? "";

export type DocumentExpenseType = "sales_invoice" | "sales_return" | "purchase_invoice" | "purchase_return";
export type ExpenseTreatment = "period" | "capitalized";
export type AllocationMethod = "value" | "quantity" | "manual";

export interface ExpenseAllocation { lineId: number; amount: number }
export interface DocumentExpenseRow {
  description: string;
  amount: number;
  treatment: ExpenseTreatment;
  allocationMethod: AllocationMethod;
  allocations: ExpenseAllocation[];
  costCenterId: number | null;
  reference: string;
}
export interface DocumentExpenseLine { lineId: number; itemId: number | null; description: string; quantity: number; value: number }
export interface DocumentExpensesResponse {
  version: number;
  status: string;
  editable: boolean;
  rows: DocumentExpenseRow[];
  options: {
    canCapitalize: boolean;
    lines: DocumentExpenseLine[];
    costCenters: { id: number; code: string; name: string }[];
  };
  allocationPreviews: { rowIndex: number; allocations: ExpenseAllocation[] }[];
}

export class DocumentExpensesError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

function headers(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

async function handle(r: Response): Promise<DocumentExpensesResponse> {
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new DocumentExpensesError((j as any)?.error || `HTTP ${r.status}`, r.status);
  return j as DocumentExpensesResponse;
}

export const documentExpensesApi = {
  get: (type: DocumentExpenseType, id: number) =>
    fetch(`${API}/api/document-expenses/${type}/${id}`, { headers: headers(), credentials: "include" }).then(handle),
  put: (type: DocumentExpenseType, id: number, version: number, rows: DocumentExpenseRow[]) =>
    fetch(`${API}/api/document-expenses/${type}/${id}`, {
      method: "PUT", headers: headers(), credentials: "include", body: JSON.stringify({ version, rows }),
    }).then(handle),
};

// ── Unsaved-edit registry ────────────────────────────────────────────────
// The expense tab registers dirty state here; document pages call
// guardDocumentExpensesBeforePost() before any post request so stale
// (unsaved) expense edits are never silently skipped at posting time.
const dirty = new Set<string>();
const key = (t: DocumentExpenseType, id: number) => `${t}:${id}`;
export function setDocumentExpensesDirty(t: DocumentExpenseType, id: number, isDirty: boolean) {
  if (isDirty) dirty.add(key(t, id)); else dirty.delete(key(t, id));
}
export function hasUnsavedDocumentExpenses(t: DocumentExpenseType, id: number | null | undefined) {
  return id != null && dirty.has(key(t, Number(id)));
}
export function guardDocumentExpensesBeforePost(t: DocumentExpenseType, id: number | null | undefined) {
  if (hasUnsavedDocumentExpenses(t, id)) {
    const ar = (typeof document !== "undefined" ? document.documentElement.lang : "ar") !== "en";
    throw new Error(ar
      ? "توجد تعديلات غير محفوظة في تبويب المصروفات والتكاليف. احفظها أو تجاهلها قبل الترحيل."
      : "Unsaved changes in the Expenses & Costs tab. Save or discard them before posting.");
  }
}
