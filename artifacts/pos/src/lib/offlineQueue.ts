// IndexedDB-backed offline queue for POS operations.
// Operations are stored locally when the network is offline (or any
// network error happens) and re-played via /api/pos/sync when online.

import type { CreateInvoiceBody } from "./api";

const DB_NAME = "zatca_pos_offline";
const DB_VERSION = 1;
const STORE = "operations";

export type QueuedOp = {
  clientId: string;       // uuid generated locally — used for idempotency
  kind: "invoice";
  payload: CreateInvoiceBody;
  createdAt: string;
  attempts: number;
  lastError?: string | null;
};

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `op_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB غير مدعوم في هذا المتصفح"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "clientId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | Promise<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result: any;
    Promise.resolve(fn(store)).then((r: any) => {
      if (r && typeof r === "object" && "onsuccess" in r) {
        (r as IDBRequest).onsuccess = () => { result = (r as IDBRequest).result; };
        (r as IDBRequest).onerror = () => reject((r as IDBRequest).error);
      } else {
        result = r;
      }
    });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function enqueueInvoice(payload: CreateInvoiceBody): Promise<QueuedOp> {
  const op: QueuedOp = {
    clientId: uuid(),
    kind: "invoice",
    payload,
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
  };
  await tx("readwrite", (s) => s.put(op));
  return op;
}

export async function listQueued(): Promise<QueuedOp[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, "readonly");
    const req = t.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result as QueuedOp[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function countQueued(): Promise<number> {
  try {
    const all = await listQueued();
    return all.length;
  } catch { return 0; }
}

export async function removeOp(clientId: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(clientId));
}

export async function markFailed(clientId: string, error: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    const store = t.objectStore(STORE);
    const g = store.get(clientId);
    g.onsuccess = () => {
      const op = g.result as QueuedOp | undefined;
      if (!op) { resolve(); return; }
      op.attempts = (op.attempts || 0) + 1;
      op.lastError = error;
      store.put(op);
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// Re-play all queued operations against the server.
export async function syncNow(authToken: string | null, apiBase = ""): Promise<{
  attempted: number; ok: number; failed: number; results: any[];
}> {
  const ops = await listQueued();
  if (!ops.length) return { attempted: 0, ok: 0, failed: 0, results: [] };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const r = await fetch(`${apiBase}/api/pos/sync`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      operations: ops.map((o) => ({ clientId: o.clientId, kind: o.kind, payload: o.payload })),
    }),
  });
  if (!r.ok) throw new Error(`فشل المزامنة (${r.status})`);
  const data = await r.json();
  let ok = 0, failed = 0;
  for (const res of data.results ?? []) {
    if (res.ok) { await removeOp(res.clientId); ok++; }
    else { await markFailed(res.clientId, res.error || "خطأ غير معروف"); failed++; }
  }
  return { attempted: ops.length, ok, failed, results: data.results ?? [] };
}
