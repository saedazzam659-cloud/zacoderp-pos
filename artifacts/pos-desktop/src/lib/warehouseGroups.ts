// Client wrapper for warehouse-group master commands.
// Tauri-only: standalone mode is the entry point. Browser-dev preview
// returns empty arrays / throws clear errors.

import { invoke } from "./tauri-shim";

function hasTauri(): boolean {
  return typeof window !== "undefined" &&
    (("__TAURI_INTERNALS__" in window) || ("__TAURI__" in window));
}
function notImpl(): never { throw new Error("هذه الميزة متاحة في تطبيق سطح المكتب فقط"); }

export type WarehouseGroup = {
  id: number; code: string; nameAr: string; nameEn: string | null; isActive: boolean;
};
export type WarehouseGroupInput = {
  code: string; nameAr: string; nameEn: string | null; isActive: boolean;
};

export async function listWarehouseGroups(): Promise<WarehouseGroup[]> {
  if (!hasTauri()) return [];
  return await invoke<WarehouseGroup[]>("warehouse_groups_list");
}
export async function createWarehouseGroup(input: WarehouseGroupInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("warehouse_group_create", { input });
}
export async function updateWarehouseGroup(id: number, input: WarehouseGroupInput): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("warehouse_group_update", { id, input });
}
export async function deleteWarehouseGroup(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("warehouse_group_delete", { id });
}
