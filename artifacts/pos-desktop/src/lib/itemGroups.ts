// Item-groups catalog (مجموعات الأصناف) — local-only, no cloud sync.
// Same pattern as uom.ts: a small list stored in localStorage. Used to
// classify items (e.g. مشروبات، منظفات، أدوية…). Adding cloud sync later
// means: add an `item_groups_local` SQLite table + extend pushQueue.

import { LS_KEYS, lsRead, lsWrite } from "./localStore";

export interface ItemGroup {
  id: number;
  code?: string | null;
  nameAr: string;
  nameEn?: string | null;
}

const DEFAULTS: ItemGroup[] = [
  { id: 1, code: "GEN", nameAr: "عام", nameEn: "General" },
];

export function listItemGroups(): ItemGroup[] {
  const stored = lsRead<ItemGroup[] | null>(LS_KEYS.itemGroups, null);
  if (!stored) { lsWrite(LS_KEYS.itemGroups, DEFAULTS); return DEFAULTS; }
  return stored;
}

export interface CreateItemGroupInput {
  code?: string | null;
  nameAr: string;
  nameEn?: string | null;
}

export function createItemGroup(input: CreateItemGroupInput): ItemGroup {
  const all = listItemGroups();
  const id = all.reduce((m, g) => Math.max(m, g.id), 0) + 1;
  const row: ItemGroup = {
    id,
    code: input.code ?? null,
    nameAr: input.nameAr,
    nameEn: input.nameEn ?? null,
  };
  all.push(row);
  lsWrite(LS_KEYS.itemGroups, all);
  return row;
}

export function updateItemGroup(id: number, patch: Partial<CreateItemGroupInput>): ItemGroup | null {
  const all = listItemGroups();
  const idx = all.findIndex((g) => g.id === id);
  if (idx < 0) return null;
  all[idx] = { ...all[idx], ...patch };
  lsWrite(LS_KEYS.itemGroups, all);
  return all[idx];
}

export function deleteItemGroup(id: number): boolean {
  const all = listItemGroups();
  const next = all.filter((g) => g.id !== id);
  if (next.length === all.length) return false;
  lsWrite(LS_KEYS.itemGroups, next);
  return true;
}

export function itemGroupName(id: number | null | undefined): string | null {
  if (id == null) return null;
  return listItemGroups().find((g) => g.id === id)?.nameAr ?? null;
}
