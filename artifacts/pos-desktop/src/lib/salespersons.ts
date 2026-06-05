// Client wrapper for salesperson / sales-rep (مندوبو المبيعات) commands.
// Tauri-only: browser-dev preview returns empty arrays / throws clear errors.

import { invoke } from "./tauri-shim";

function hasTauri(): boolean {
  return typeof window !== "undefined" &&
    (("__TAURI_INTERNALS__" in window) || ("__TAURI__" in window));
}
function notImpl(): never { throw new Error("هذه الميزة متاحة في تطبيق سطح المكتب فقط"); }

export type Salesperson = {
  id: number;
  code: string | null;
  nameAr: string;
  nameEn: string | null;
  phone: string | null;
  email: string | null;
  commissionPct: number;
  isActive: boolean;
  notes: string | null;
};

export type SalespersonInput = {
  code?: string | null;
  nameAr: string;
  nameEn?: string | null;
  phone?: string | null;
  email?: string | null;
  commissionPct?: number;
  isActive?: boolean;
  notes?: string | null;
};

export async function listSalespersons(includeInactive = true): Promise<Salesperson[]> {
  if (!hasTauri()) return [];
  return await invoke<Salesperson[]>("list_salespersons", { includeInactive });
}

export async function createSalesperson(input: SalespersonInput): Promise<Salesperson> {
  if (!hasTauri()) notImpl();
  return await invoke<Salesperson>("create_salesperson_local", { input });
}

export async function updateSalesperson(id: number, input: SalespersonInput): Promise<Salesperson> {
  if (!hasTauri()) notImpl();
  return await invoke<Salesperson>("update_salesperson_local", { id, input });
}

export async function deleteSalesperson(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("delete_salesperson_local", { id });
}
