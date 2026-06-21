// Inventory & warehouses (Task #208) — TS bridge over Tauri commands.
//
// All functions are standalone-mode-only: cloud mode bypasses local SQLite
// and uses the existing online inventory APIs. The `hasTauri` guard makes
// every helper a safe no-op in the web preview / cloud build.

import { invoke } from "./tauri-shim";
import { emitData } from "./dataBus";

function hasTauri(): boolean {
  return typeof window !== "undefined" &&
    (("__TAURI_INTERNALS__" in window) || ("__TAURI__" in window));
}

// ─── Warehouses ────────────────────────────────────────────────────

export interface Warehouse {
  id: number;
  code: string;
  /** Arabic name (the single base `name` column doubles as nameAr). */
  name: string;
  nameEn: string | null;
  address: string | null;
  groupId: number | null;
  branchId: number | null;
  city: string | null;
  region: string | null;
  allowNegative: boolean;
  negativeLimit: number | null;
  accountId: number | null;
  is_default: boolean;
  is_active: boolean;
}
export interface WarehouseInput {
  code: string;
  name: string;
  nameEn?: string | null;
  address?: string | null;
  groupId?: number | null;
  branchId?: number | null;
  city?: string | null;
  region?: string | null;
  allowNegative?: boolean;
  negativeLimit?: number | null;
  accountId?: number | null;
  is_default?: boolean;
  is_active?: boolean;
}

export async function listWarehouses(): Promise<Warehouse[]> {
  if (!hasTauri()) return [];
  return await invoke<Warehouse[]>("warehouses_list");
}
export async function createWarehouse(input: WarehouseInput): Promise<number> {
  const id = await invoke<number>("warehouses_create", { input });
  emitData("warehouses");
  return id;
}
export async function updateWarehouse(id: number, input: WarehouseInput): Promise<void> {
  await invoke("warehouses_update", { id, input });
  emitData("warehouses");
}
export async function deleteWarehouse(id: number): Promise<void> {
  await invoke("warehouses_delete", { id });
  emitData("warehouses");
}

// ─── Stock on-hand ─────────────────────────────────────────────────

export interface StockOnHand {
  item_id: number;
  item_name: string;
  item_code: string | null;
  warehouse_id: number;
  warehouse_name: string;
  qty: number;
  last_cost: number;
}

export async function listStockOnHand(warehouseId?: number | null): Promise<StockOnHand[]> {
  if (!hasTauri()) return [];
  return await invoke<StockOnHand[]>("stock_on_hand_list", { warehouseId: warehouseId ?? null });
}

// ─── Stock movements ───────────────────────────────────────────────

export interface StockMovement {
  id: number;
  item_id: number;
  item_name: string;
  warehouse_id: number;
  warehouse_name: string;
  qty_delta: number;
  unit_cost: number;
  balance_after: number;
  ref_type: string;
  ref_id: number | null;
  entry_date: string;
  created_at: string;
}

export async function listStockMovements(opts?: {
  warehouseId?: number | null;
  itemId?: number | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  limit?: number;
}): Promise<StockMovement[]> {
  if (!hasTauri()) return [];
  return await invoke<StockMovement[]>("stock_movements_list", {
    warehouseId: opts?.warehouseId ?? null,
    itemId: opts?.itemId ?? null,
    dateFrom: opts?.dateFrom ?? null,
    dateTo: opts?.dateTo ?? null,
    limit: opts?.limit ?? 500,
  });
}

// ─── Stock adjustments ─────────────────────────────────────────────

export interface AdjustmentLineInput {
  item_id: number;
  qty_diff: number;
  unit_cost: number;
}
export interface AdjustmentInput {
  adj_date: string;
  warehouse_id: number;
  reason?: string | null;
  lines: AdjustmentLineInput[];
}
export interface AdjustmentSummary {
  id: number;
  adj_no: string;
  adj_date: string;
  warehouse_id: number;
  warehouse_name: string;
  reason: string | null;
  je_id: number | null;
  lines_count: number;
  total_value: number;
}

export async function listStockAdjustments(): Promise<AdjustmentSummary[]> {
  if (!hasTauri()) return [];
  return await invoke<AdjustmentSummary[]>("stock_adjustments_list");
}
export async function createStockAdjustment(input: AdjustmentInput): Promise<number> {
  return await invoke<number>("stock_adjustment_create", { input });
}

// ─── Stock transfers ───────────────────────────────────────────────

export interface TransferLineInput {
  item_id: number;
  qty: number;
  unit_cost: number;
}
export interface TransferInput {
  transfer_date: string;
  from_warehouse_id: number;
  to_warehouse_id: number;
  notes?: string | null;
  lines: TransferLineInput[];
}
export interface TransferSummary {
  id: number;
  transfer_no: string;
  transfer_date: string;
  from_warehouse_id: number;
  from_warehouse_name: string;
  to_warehouse_id: number;
  to_warehouse_name: string;
  lines_count: number;
  total_qty: number;
}

export async function listStockTransfers(): Promise<TransferSummary[]> {
  if (!hasTauri()) return [];
  return await invoke<TransferSummary[]>("stock_transfers_list");
}
export async function createStockTransfer(input: TransferInput): Promise<number> {
  return await invoke<number>("stock_transfer_create", { input });
}

// ─── Stocktakes ────────────────────────────────────────────────────

export interface StocktakeLineInput {
  item_id: number;
  counted_qty: number;
  unit_cost: number;
}
export interface StocktakeInput {
  stocktake_date: string;
  warehouse_id: number;
  notes?: string | null;
  lines: StocktakeLineInput[];
}
export interface StocktakeSummary {
  id: number;
  stocktake_no: string;
  stocktake_date: string;
  warehouse_id: number;
  warehouse_name: string;
  status: "draft" | "posted";
  adjustment_id: number | null;
  lines_count: number;
}

export async function listStocktakes(): Promise<StocktakeSummary[]> {
  if (!hasTauri()) return [];
  return await invoke<StocktakeSummary[]>("stocktakes_list");
}
export async function createStocktake(input: StocktakeInput): Promise<number> {
  return await invoke<number>("stocktake_create", { input });
}
export async function postStocktake(id: number): Promise<number> {
  return await invoke<number>("stocktake_post", { id });
}
