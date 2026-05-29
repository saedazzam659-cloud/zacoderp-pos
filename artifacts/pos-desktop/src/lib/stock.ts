// Stock module — opening balances, reorder points, auto-decrement on sale.
//
// DESIGN: Stock is intentionally LS-only (no SQLite/Rust changes). Rationale:
//   • Quantity-on-hand is device-local by nature in standalone POS.
//   • Avoids a Rust migration on installed devices (which would require an
//     MSI re-deploy + manual upgrade).
//   • Easy to extend later by adding `quantity` + `reorder_point` columns
//     to `items_local` and writing this map into them as a one-shot copy.
//
// Storage shape: { [itemId: number]: { qty: number; reorderPoint: number; updatedAt: string } }
// Items absent from the map are treated as "stock not tracked" (qty = null,
// reorderPoint = 0). They never appear in the low-stock report and never
// trigger out-of-stock alerts — opt-in by setting an opening balance via
// the import screen or the per-item edit form.

import { lsRead, lsWrite } from "./localStore";
// Task #207: in LAN mode (host/client) on-hand quantity is HOST-authoritative —
// a single shared SQLite table (`lan_stock`) so all 3 devices see one truth and
// the host serializes decrements (can't sell the last unit twice). In single
// mode stock stays LS-only exactly as before. The async `*Shared` helpers are
// the LAN-aware entry points; the original sync functions remain the
// single-mode / LS implementation and are reused by them.
import { bridgeInvoke, isHost, isClient } from "./bridge";

const LS_KEY = "pos_desktop_stock_v1";

/** True when this device participates in a LAN shared DB (host or client). */
function lanMode(): boolean {
  return isHost() || isClient();
}

export interface StockRow {
  qty: number;
  reorderPoint: number;
  updatedAt: string;
}

export type StockMap = Record<number, StockRow>;

function readMap(): StockMap {
  return lsRead<StockMap>(LS_KEY, {});
}
function writeMap(m: StockMap): void {
  lsWrite(LS_KEY, m);
}

export function getStock(itemId: number): StockRow | null {
  return readMap()[itemId] ?? null;
}

export function getAllStock(): StockMap {
  return readMap();
}

function safeQty(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n * 1000) / 1000);
}
function safeRp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

export function setStock(itemId: number, qty: number, reorderPoint?: number): void {
  const m = readMap();
  const prev = m[itemId];
  m[itemId] = {
    qty: safeQty(qty),
    reorderPoint: reorderPoint !== undefined ? safeRp(reorderPoint) : (prev?.reorderPoint ?? 0),
    updatedAt: new Date().toISOString(),
  };
  writeMap(m);
}

export function setReorderPoint(itemId: number, n: number): void {
  const m = readMap();
  const prev = m[itemId];
  m[itemId] = {
    qty: prev?.qty ?? 0,
    reorderPoint: safeRp(n),
    updatedAt: new Date().toISOString(),
  };
  writeMap(m);
}

/**
 * Adjust on-hand by delta (negative for a sale, positive for a return/import).
 * No-op if the item is not yet tracked — operator chose not to track it.
 * Returns the new on-hand, or null if untracked.
 */
export function adjustStock(itemId: number, delta: number): number | null {
  if (!Number.isFinite(delta)) return null;
  const m = readMap();
  const prev = m[itemId];
  if (!prev) return null;
  const next = safeQty(prev.qty + delta);
  m[itemId] = { ...prev, qty: next, updatedAt: new Date().toISOString() };
  writeMap(m);
  return next;
}

/**
 * Bulk apply { itemId, qty?, reorderPoint? } rows.
 * Used by the CSV import screen — `qty` and `reorderPoint` are both
 * optional; absent fields preserve the previous value.
 */
export function bulkSetStock(
  rows: Array<{ itemId: number; qty?: number | null; reorderPoint?: number | null }>,
): number {
  const m = readMap();
  let count = 0;
  for (const r of rows) {
    const prev = m[r.itemId];
    const nextQty = r.qty !== null && r.qty !== undefined ? safeQty(r.qty) : (prev?.qty ?? 0);
    const nextRp = r.reorderPoint !== null && r.reorderPoint !== undefined ? safeRp(r.reorderPoint) : (prev?.reorderPoint ?? 0);
    m[r.itemId] = { qty: nextQty, reorderPoint: nextRp, updatedAt: new Date().toISOString() };
    count++;
  }
  writeMap(m);
  return count;
}

/**
 * Count of tracked items whose on-hand is ≤ reorderPoint (and reorder > 0).
 * Drives the sidebar badge in PosShell.
 */
export function countLowStock(itemIds?: Set<number>): number {
  const m = readMap();
  let n = 0;
  for (const [id, s] of Object.entries(m)) {
    if (itemIds && !itemIds.has(Number(id))) continue;
    if (s.reorderPoint > 0 && s.qty <= s.reorderPoint) n++;
  }
  return n;
}

export function clearStock(): void {
  writeMap({});
}

// ─────────────────────────────────────────────────────────────────────────
// Task #207 — LAN-aware shared-stock API
//
// In single mode these delegate to the sync LS functions above (zero change).
// In host/client mode they route through the bridge to the host's `lan_stock`
// SQLite table. On the host `bridgeInvoke` calls the LOCAL Rust command; on a
// client it POSTs to the host over LAN. The host serializes every write, so a
// sale decrement is atomic and the last unit can't be sold twice.
// ─────────────────────────────────────────────────────────────────────────

// Mirrors Rust `StockRow` in src-tauri/src/lan.rs — that struct serializes
// camelCase via #[serde(rename)]. Keep these two shapes in lockstep.
interface RustStockRow {
  itemId: number;
  qty: number;
  reorderPoint: number;
  updatedAt: string;
}

function fromRustStock(rows: RustStockRow[]): StockMap {
  const m: StockMap = {};
  for (const r of rows) {
    m[r.itemId] = { qty: r.qty, reorderPoint: r.reorderPoint, updatedAt: r.updatedAt };
  }
  return m;
}

export async function getAllStockShared(): Promise<StockMap> {
  if (lanMode()) {
    try {
      const rows = await bridgeInvoke<RustStockRow[]>("lan_stock_get_all", {});
      return fromRustStock(rows);
    } catch {
      // Host unreachable — fall back to the last-known LS snapshot so the UI
      // still renders something instead of throwing. Callers that need
      // strict freshness (e.g. a sale) use adjustStockShared which surfaces
      // the error instead.
      return readMap();
    }
  }
  return readMap();
}

export async function getStockShared(itemId: number): Promise<StockRow | null> {
  if (lanMode()) {
    const all = await getAllStockShared();
    return all[itemId] ?? null;
  }
  return getStock(itemId);
}

export async function setStockShared(
  itemId: number,
  qty: number,
  reorderPoint?: number,
): Promise<void> {
  if (lanMode()) {
    await bridgeInvoke("lan_stock_set", {
      itemId,
      qty,
      reorderPoint: reorderPoint ?? null,
    });
    return;
  }
  setStock(itemId, qty, reorderPoint);
}

export async function setReorderPointShared(itemId: number, n: number): Promise<void> {
  if (lanMode()) {
    await bridgeInvoke("lan_stock_set_reorder", { itemId, reorderPoint: n });
    return;
  }
  setReorderPoint(itemId, n);
}

/**
 * Atomic on-hand adjustment. Negative delta = sale, positive = return/import.
 * In LAN mode the HOST applies it under a transaction and REJECTS a sale that
 * would drive a tracked item below zero — throwing an Arabic error the caller
 * surfaces. Untracked items return null (no tracking → sale allowed). Single
 * mode keeps the old clamp-to-zero LS behavior.
 */
export async function adjustStockShared(itemId: number, delta: number): Promise<number | null> {
  if (lanMode()) {
    return await bridgeInvoke<number | null>("lan_stock_adjust", { itemId, delta });
  }
  return adjustStock(itemId, delta);
}

export async function bulkSetStockShared(
  rows: Array<{ itemId: number; qty?: number | null; reorderPoint?: number | null }>,
): Promise<number> {
  if (lanMode()) {
    return await bridgeInvoke<number>("lan_stock_bulk_set", {
      rows: rows.map((r) => ({
        itemId: r.itemId,
        qty: r.qty ?? null,
        reorderPoint: r.reorderPoint ?? null,
      })),
    });
  }
  return bulkSetStock(rows);
}

export async function clearStockShared(): Promise<void> {
  if (lanMode()) {
    await bridgeInvoke("lan_stock_clear", {});
    return;
  }
  clearStock();
}

/** Pure low-stock count over an already-fetched map (works for both modes). */
export function countLowStockInMap(m: StockMap, itemIds?: Set<number>): number {
  let n = 0;
  for (const [id, s] of Object.entries(m)) {
    if (itemIds && !itemIds.has(Number(id))) continue;
    if (s.reorderPoint > 0 && s.qty <= s.reorderPoint) n++;
  }
  return n;
}
