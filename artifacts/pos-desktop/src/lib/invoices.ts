// Local invoice persistence shim. Forwards to Rust invoices::* commands in
// Tauri; in browser dev mode generates an in-memory pseudo-record so the UI
// keeps working without a backend. Dev records are NOT persisted across
// page reloads (intentional — only the real SQLite path is durable).

// Task #207: invoice persistence is SHARED data. In a LAN client these
// commands forward to the host (the single SQLite owner) so every device's
// sales land in one ledger and the host can serialize writes. In single/
// host mode `bridgeInvoke` calls the local Tauri command, unchanged.
import { bridgeInvoke as invoke, shouldUseBridge } from "./bridge";

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
  if (!shouldUseBridge()) {
    // Idempotency in browser: if a row with the same uuid already exists,
    // return it. Mirrors the Rust path's INSERT-or-fetch semantics.
    const uuid = idempotencyKey ?? `dev-${++devCounter}-${Math.random().toString(16).slice(2, 8)}`;
    try {
      const raw = localStorage.getItem("pos_desktop_invoices_v1");
      const arr: any[] = raw ? JSON.parse(raw) : [];
      const prev = arr.find((i) => i.localUuid === uuid);
      if (prev) return { localUuid: prev.localUuid, invoiceNo: prev.invoiceNo };
      const id = (arr[arr.length - 1]?.id ?? 0) + 1;
      const ymd = new Date().toISOString().slice(2, 10).replace(/-/g, "");
      const isReturn = (payload as any).kind === "return";
      const prefix = isReturn ? "RET" : "OFF";
      const seq = arr.filter((i) => (i.invoiceNo as string).startsWith(`${prefix}-${ymd}`)).length + 1;
      const invoiceNo = `${prefix}-${ymd}-${String(seq).padStart(4, "0")}`;
      _persistInvoiceInBrowser({
        id, localUuid: uuid, invoiceNo, payloadJson,
        qrBase64: qrBase64 ?? null, signedXml: signedXml ?? null,
        createdAt: new Date().toISOString(), syncStatus: "pending",
      });
      return { localUuid: uuid, invoiceNo };
    } catch {
      devCounter += 1;
      const ymd = new Date().toISOString().slice(2, 10).replace(/-/g, "");
      return {
        localUuid: uuid,
        invoiceNo: `OFF-${ymd}-DEV${String(devCounter).padStart(3, "0")}`,
      };
    }
  }
  const r = await invoke<RustSaved>("save_offline_invoice", {
    payloadJson,
    qrBase64: qrBase64 ?? null,
    signedXml: signedXml ?? null,
    idempotencyKey: idempotencyKey ?? null,
  });
  return { localUuid: r.local_uuid, invoiceNo: r.invoice_no };
}

export interface FullInvoice {
  id: number;
  localUuid: string;
  invoiceNo: string;
  payloadJson: string;
  qrBase64: string | null;
  signedXml: string | null;
  createdAt: string;
  syncStatus: string;
}

interface RustFull {
  id: number;
  local_uuid: string;
  invoice_no: string;
  payload_json: string;
  qr_base64: string | null;
  signed_xml: string | null;
  created_at: string;
  sync_status: string;
}

export async function getOfflineInvoice(id: number): Promise<FullInvoice | null> {
  if (!shouldUseBridge()) return null;
  const r = await invoke<RustFull | null>("get_offline_invoice", { id });
  if (!r) return null;
  return {
    id: r.id,
    localUuid: r.local_uuid,
    invoiceNo: r.invoice_no,
    payloadJson: r.payload_json,
    qrBase64: r.qr_base64,
    signedXml: r.signed_xml,
    createdAt: r.created_at,
    syncStatus: r.sync_status,
  };
}

export async function listPendingInvoices(): Promise<PendingInvoice[]> {
  if (!shouldUseBridge()) return [];
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
  if (!shouldUseBridge()) {
    try {
      const raw = localStorage.getItem("pos_desktop_invoices_v1");
      const arr: any[] = raw ? JSON.parse(raw) : [];
      return arr.filter((i) => i.syncStatus === "pending").length;
    } catch { return 0; }
  }
  return invoke<number>("count_pending_invoices");
}

// All invoices (pending + synced + returns). Used by the Returns screen
// to pick an original sale to refund against.
export async function listAllInvoices(limit = 100): Promise<PendingInvoice[]> {
  if (shouldUseBridge()) {
    try {
      const rows = await invoke<RustPending[]>("list_all_invoices", { limit });
      return rows.map((r) => ({
        id: r.id,
        localUuid: r.local_uuid,
        invoiceNo: r.invoice_no,
        qrBase64: r.qr_base64,
        createdAt: r.created_at,
        syncStatus: r.sync_status,
      }));
    } catch { /* fall through */ }
  }
  // Browser fallback: mirror invoices written by saveOfflineInvoice.
  try {
    const raw = localStorage.getItem("pos_desktop_invoices_v1");
    const arr: any[] = raw ? JSON.parse(raw) : [];
    return arr
      .slice(-limit)
      .reverse()
      .map((i) => ({
        id: i.id,
        localUuid: i.localUuid,
        invoiceNo: i.invoiceNo,
        qrBase64: i.qrBase64 ?? null,
        createdAt: i.createdAt,
        syncStatus: i.syncStatus ?? "pending",
      }));
  } catch { return []; }
}

// Browser-mode persistence used by saveOfflineInvoice when running in Vite
// preview (Tauri-less). Mirrors what Rust would otherwise insert into
// offline_invoices so the Returns + Pending screens have data to read.
export function _persistInvoiceInBrowser(rec: {
  id: number; localUuid: string; invoiceNo: string;
  payloadJson: string; qrBase64?: string | null;
  signedXml?: string | null; createdAt: string; syncStatus: string;
}): void {
  try {
    const raw = localStorage.getItem("pos_desktop_invoices_v1");
    const arr: any[] = raw ? JSON.parse(raw) : [];
    arr.push(rec);
    localStorage.setItem("pos_desktop_invoices_v1", JSON.stringify(arr));
  } catch { /* quota */ }
}
