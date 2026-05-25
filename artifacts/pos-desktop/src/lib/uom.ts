// Units-of-measure catalog — local-only for v1 (no cloud sync).
// Browser + Tauri both use localStorage; the list is small (rarely > 20 rows)
// and doesn't impact ZATCA submission, so syncing it to the cloud is
// deferred. Adding cloud sync later means: add a `uom_local` SQLite table
// + extend pushQueue.entityType.

import { LS_KEYS, lsRead, lsWrite } from "./localStore";

export interface Uom {
  id: number;
  nameAr: string;
  nameEn?: string | null;
  shortCode?: string | null;
  baseQty: number; // multiplier vs base unit (1 = base, 12 for a dozen, etc.)
  isDefault?: boolean;
}

const DEFAULTS: Uom[] = [
  { id: 1, nameAr: "قطعة",  nameEn: "Piece",  shortCode: "PCS", baseQty: 1, isDefault: true },
  { id: 2, nameAr: "كرتون", nameEn: "Carton", shortCode: "CTN", baseQty: 12 },
  { id: 3, nameAr: "علبة",  nameEn: "Box",    shortCode: "BOX", baseQty: 6 },
  { id: 4, nameAr: "كيلو",  nameEn: "Kg",     shortCode: "KG",  baseQty: 1 },
  { id: 5, nameAr: "جرام",  nameEn: "Gram",   shortCode: "G",   baseQty: 0.001 },
  { id: 6, nameAr: "لتر",   nameEn: "Litre",  shortCode: "L",   baseQty: 1 },
  { id: 7, nameAr: "متر",   nameEn: "Meter",  shortCode: "M",   baseQty: 1 },
];

export function listUom(): Uom[] {
  const stored = lsRead<Uom[] | null>(LS_KEYS.uom, null);
  if (!stored) { lsWrite(LS_KEYS.uom, DEFAULTS); return DEFAULTS; }
  return stored;
}

export interface CreateUomInput {
  nameAr: string;
  nameEn?: string | null;
  shortCode?: string | null;
  baseQty: number;
  isDefault?: boolean;
}

export function createUom(input: CreateUomInput): Uom {
  const all = listUom();
  const id = all.reduce((m, u) => Math.max(m, u.id), 0) + 1;
  // Only one default allowed.
  if (input.isDefault) all.forEach((u) => { u.isDefault = false; });
  const row: Uom = {
    id,
    nameAr: input.nameAr,
    nameEn: input.nameEn ?? null,
    shortCode: input.shortCode ?? null,
    baseQty: input.baseQty,
    isDefault: input.isDefault ?? false,
  };
  all.push(row);
  lsWrite(LS_KEYS.uom, all);
  return row;
}

export function updateUom(id: number, patch: Partial<CreateUomInput>): Uom | null {
  const all = listUom();
  const idx = all.findIndex((u) => u.id === id);
  if (idx < 0) return null;
  if (patch.isDefault) all.forEach((u) => { u.isDefault = false; });
  all[idx] = { ...all[idx], ...patch };
  lsWrite(LS_KEYS.uom, all);
  return all[idx];
}

export function deleteUom(id: number): boolean {
  const all = listUom();
  const next = all.filter((u) => u.id !== id);
  if (next.length === all.length) return false;
  lsWrite(LS_KEYS.uom, next);
  return true;
}

export function getDefaultUom(): Uom {
  const all = listUom();
  return all.find((u) => u.isDefault) ?? all[0];
}
