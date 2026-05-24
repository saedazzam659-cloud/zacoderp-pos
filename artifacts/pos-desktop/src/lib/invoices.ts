// Local invoice persistence shim. Forwards to Rust invoices::* commands in
// Tauri; in browser dev mode generates an in-memory pseudo-record so the UI
// keeps working without a backend. Dev records are NOT persisted across
// page reloads (intentional — only the real SQLite path is durable).

const IS_TAURI =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!_invoke) {
    const mod = await import(/* @vite-ignore */ "@tauri-apps/api/core");
    _invoke = mod.invoke;
  }
  return (await _invoke!(cmd, args)) as T;
}

export interface SavedInvoice {
  localUuid: string;
  invoiceNo: string;
}

export interface PendingInvoice {
  id: number;
  localUuid: string;
  invoiceNo: string;
  qrBase64: string | null;
  createdAt: string;
  syncStatus: string;
}

interface RustSaved { local_uuid: string; invoice_no: string; }
interface RustPending {
  id: number;
  local_uuid: string;
  invoice_no: string;
  qr_base64: string | null;
  created_at: string;
  sync_status: string;
}

export interface OfflineInvoicePayload {
  customerName?: string;
  vatNumber?: string;
  paymentMethod: "cash" | "card";
  lines: { itemId: number; nameAr: string; qty: number; unitPrice: number; vatRate: number; }[];
  subtotal: number;
  vat: number;
  grandTotal: number;
  timestamp: string;
}

let devCounter = 0;

export async function saveOfflineInvoice(
  payload: OfflineInvoicePayload,
  qrBase64?: string,
  signedXml?: string,
  // Caller-supplied idempotency key. When the user clicks "checkout" the UI
  // generates a key once per cart and passes it on every retry — the Rust
  // side returns the originally-saved row instead of inserting a duplicate.
  idempotencyKey?: string,
): Promise<SavedInvoice> {
  const payloadJson = JSON.stringify(payload);
  if (!IS_TAURI) {
    devCounter += 1;
    const ymd = new Date().toISOString().slice(2, 10).replace(/-/g, "");
    return {
      localUuid: idempotencyKey ?? `dev-${devCounter}-${Math.random().toString(16).slice(2, 8)}`,
      invoiceNo: `OFF-${ymd}-DEV${String(devCounter).padStart(3, "0")}`,
    };
  }
  const r = await invoke<RustSaved>("save_offline_invoice", {
    payloadJson,
    qrBase64: qrBase64 ?? null,
    signedXml: signedXml ?? null,
    idempotencyKey: idempotencyKey ?? null,
  });
  return { localUuid: r.local_uuid, invoiceNo: r.invoice_no };
}

export async function listPendingInvoices(): Promise<PendingInvoice[]> {
  if (!IS_TAURI) return [];
  const rows = await invoke<RustPending[]>("list_pending_invoices");
  return rows.map((r) => ({
    id: r.id,
    localUuid: r.local_uuid,
    invoiceNo: r.invoice_no,
    qrBase64: r.qr_base64,
    createdAt: r.created_at,
    syncStatus: r.sync_status,
  }));
}

export async function countPendingInvoices(): Promise<number> {
  if (!IS_TAURI) return 0;
  return invoke<number>("count_pending_invoices");
}
