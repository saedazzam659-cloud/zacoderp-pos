// Tiny key/value JSON store backed by localStorage.
// Used as the BROWSER fallback for entity lists (items, customers, UoM, etc.)
// so the UI works end-to-end in the Vite preview without a Tauri SQLite layer.
//
// In Tauri/Windows mode, each lib (items.ts, customers.ts) prefers the
// native invoke() path and only touches this file as a tertiary cache.

export const LS_KEYS = {
  items: "pos_desktop_items_v1",
  /** LOCAL-ONLY field overlay for SQLite-backed items in standalone mode
   * (units / groupId / nature / itemType), keyed by SQLite item id. */
  itemMeta: "pos_desktop_item_meta_v1",
  customers: "pos_desktop_customers_v1",
  /** Opening-balance overlay for customers (keyed by id). The customer
   * statement reads documents, not GL, so the opening JE never shows there —
   * this overlay is what seeds the statement's opening row. */
  customerOpening: "pos_desktop_customer_opening_v1",
  uom: "pos_desktop_uom_v1",
  itemGroups: "pos_desktop_item_groups_v1",
  /** Brand master list (العلامات التجارية). LOCAL-ONLY, no cloud sync. */
  brands: "pos_desktop_brands_v1",
  /** Per-item brand links keyed by item id — each brand carries its own
   * price/cost/barcode/part-number. LOCAL-ONLY overlay, mirrors itemMeta. */
  itemBrands: "pos_desktop_item_brands_v1",
  /** Print-only per-line brand snapshot for back-office sales invoices, keyed
   * by invoice id, indexed in persisted-line order. NEVER enters ZATCA. */
  invoiceBrands: "pos_desktop_invoice_brands_v1",
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
