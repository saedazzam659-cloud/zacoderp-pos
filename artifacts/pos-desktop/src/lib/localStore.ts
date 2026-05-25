// Tiny key/value JSON store backed by localStorage.
// Used as the BROWSER fallback for entity lists (items, customers, UoM, etc.)
// so the UI works end-to-end in the Vite preview without a Tauri SQLite layer.
//
// In Tauri/Windows mode, each lib (items.ts, customers.ts) prefers the
// native invoke() path and only touches this file as a tertiary cache.

export const LS_KEYS = {
  items: "pos_desktop_items_v1",
  customers: "pos_desktop_customers_v1",
  uom: "pos_desktop_uom_v1",
  invoices: "pos_desktop_invoices_v1",
  pushQueue: "pos_desktop_push_queue_v1",
  lastPullAt: "pos_desktop_last_pull_at",
} as const;

export function lsRead<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function lsWrite<T>(key: string, value: T): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
}

export const IS_TAURI =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!_invoke) {
    const mod = await import(/* @vite-ignore */ "@tauri-apps/api/core");
    _invoke = mod.invoke;
  }
  return (await _invoke!(cmd, args)) as T;
}
