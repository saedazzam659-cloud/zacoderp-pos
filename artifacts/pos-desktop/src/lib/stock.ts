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

const LS_KEY = "pos_desktop_stock_v1";

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
