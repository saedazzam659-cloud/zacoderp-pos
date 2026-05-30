// Client wrapper for cost-center (مراكز التكلفة) commands.
// Tauri-only: browser-dev preview returns empty arrays / throws clear errors.

import { invoke } from "./tauri-shim";

function hasTauri(): boolean {
  return typeof window !== "undefined" &&
    (("__TAURI_INTERNALS__" in window) || ("__TAURI__" in window));
}
function notImpl(): never { throw new Error("هذه الميزة متاحة في تطبيق سطح المكتب فقط"); }

export type CostCenter = {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string | null;
  parentId: number | null;
  isPosting: boolean;
  isActive: boolean;
};
export type CostCenterInput = {
  code: string;
  nameAr: string;
  nameEn: string | null;
  parentId?: number | null;
  isPosting?: boolean;
  isActive?: boolean;
};

export async function listCostCenters(): Promise<CostCenter[]> {
  if (!hasTauri()) return [];
  return await invoke<CostCenter[]>("cost_centers_list");
}
export async function createCostCenter(input: CostCenterInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("cost_center_create", { input });
}
export async function updateCostCenter(id: number, input: CostCenterInput): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("cost_center_update", { id, input });
}
export async function deleteCostCenter(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("cost_center_delete", { id });
}
