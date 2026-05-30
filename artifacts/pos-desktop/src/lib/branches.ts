// Client wrapper for branch (الفروع) commands.
// Tauri-only: browser-dev preview returns empty arrays / throws clear errors.

import { invoke } from "./tauri-shim";

function hasTauri(): boolean {
  return typeof window !== "undefined" &&
    (("__TAURI_INTERNALS__" in window) || ("__TAURI__" in window));
}
function notImpl(): never { throw new Error("هذه الميزة متاحة في تطبيق سطح المكتب فقط"); }

export type Branch = {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string | null;
  isActive: boolean;
};
export type BranchInput = {
  code: string;
  nameAr: string;
  nameEn: string | null;
  isActive?: boolean;
};

export async function listBranches(): Promise<Branch[]> {
  if (!hasTauri()) return [];
  return await invoke<Branch[]>("branches_list");
}
export async function createBranch(input: BranchInput): Promise<number> {
  if (!hasTauri()) notImpl();
  return await invoke<number>("branch_create", { input });
}
export async function updateBranch(id: number, input: BranchInput): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("branch_update", { id, input });
}
export async function deleteBranch(id: number): Promise<void> {
  if (!hasTauri()) notImpl();
  await invoke("branch_delete", { id });
}
