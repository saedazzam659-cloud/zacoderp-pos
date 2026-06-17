// Client wrapper for unit-of-measure master commands.
// Tauri-only: standalone mode is the entry point. Browser-dev preview
// returns empty arrays / throws clear errors.

import { invoke } from "./tauri-shim";

function hasTauri(): boolean {
  return typeof window !== "undefined" &&
    (("__TAURI_INTERNALS__" in window) || ("__TAURI__" in window));
}
function notImpl(): never { throw new Error("هذه الميزة متاحة في تطبيق سطح المكتب فقط"); }

export type UnitRow = {
  id: number; code: string; nameAr: string; nameEn: string | null;
  conversionFactor: number; isActive: boolean;
};
export type UnitInput = {
  code: string; nameAr: string; nameEn: string | null;
  conversionFactor: number; isActive: boolean;
};

export async function listUnits(): Promise<UnitRow[]> {
  if (!hasTauri()) return [];
  return await invoke<UnitRow[]>("units_list");
}
export async function createUnit(input: UnitInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("unit_create", { input });
}
export async function updateUnit(id: number, input: UnitInput): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("unit_update", { id, input });
}
export async function deleteUnit(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("unit_delete", { id });
}
