// Local items catalog. Mirrors customers.ts pattern.
//
// Read precedence:
//   1. Tauri SQLite (items_local) via Rust `list_items`
//   2. localStorage cache (browser dev mode, or Tauri fallback)
//   3. DEV_DEMO seed (so a brand-new install isn't an empty screen)
//
// `upsertItemsFromCloud` is what makes the dashboard's Pull button
// actually populate the sales grid — previously Pull only set a counter
// on screen; the items themselves were dropped on the floor.

import { LS_KEYS, lsRead, lsWrite, IS_TAURI, tauriInvoke } from "./localStore";
import { enqueuePush } from "./pushQueue";

export interface LocalItem {
  id: number;
  cloudId?: number | null;
  code?: string | null;
  nameAr: string;
  nameEn?: string | null;
  barcode?: string | null;
  salePrice: number;
  vatRate: number;
  uomId?: number | null;
  updatedAt?: string;
  /** Soft-delete tombstone (overlay). When true, listItems filters this row out. */
  deleted?: boolean;
}

interface RustItem {
  id: number;
  cloud_id: number | null;
  code: string | null;
  name_ar: string;
  name_en: string | null;
  barcode: string | null;
  sale_price: number;
  vat_rate: number;
}

function fromRust(r: RustItem): LocalItem {
  return {
    id: r.id,
    cloudId: r.cloud_id,
    code: r.code,
    nameAr: r.name_ar,
    nameEn: r.name_en,
    barcode: r.barcode,
    salePrice: r.sale_price,
    vatRate: r.vat_rate,
  };
}

// ─── Demo seed (used only when both SQLite and localStorage are empty) ──
const DEV_DEMO: LocalItem[] = [
  { id: 1, nameAr: "ماء معدني 500مل", barcode: "6281007123456", salePrice: 1.5, vatRate: 15 },
  { id: 2, nameAr: "شيبس صغير",       barcode: "6281007123457", salePrice: 3.0, vatRate: 15 },
  { id: 3, nameAr: "علبة عصير",       barcode: "6281007123458", salePrice: 5.0, vatRate: 15 },
  { id: 4, nameAr: "بسكويت",          barcode: "6281007123459", salePrice: 4.5, vatRate: 15 },
  { id: 5, nameAr: "شوكولاتة",        barcode: "6281007123460", salePrice: 7.0, vatRate: 15 },
  { id: 6, nameAr: "لبن طازج 1لتر",   barcode: "6281007123461", salePrice: 8.5, vatRate: 15 },
];

function readLocal(): LocalItem[] {
  const stored = lsRead<LocalItem[] | null>(LS_KEYS.items, null);
  return stored ?? [];
}

export async function listItems(search?: string): Promise<LocalItem[]> {
  // MERGE strategy: read BOTH SQLite (Tauri) and localStorage and union them.
  // Previous behavior was Tauri-OR-localStorage which silently hid
  // locally-created items because createItem only writes to localStorage
  // (there is no SQLite write command yet) while listItems preferred SQLite —
  // so the user added a row and it never appeared. Dedup keys:
  //   • Tauri rows are keyed by `id` (SQLite rowid)
  //   • LocalStorage rows that have a cloudId match a Tauri row via cloud_id
  //   • LocalStorage rows without cloudId are always-additive (locally-created)
  const fromTauri: LocalItem[] = [];
  if (IS_TAURI) {
    try {
      const rows = await tauriInvoke<RustItem[]>("list_items", { search: search ?? null });
      fromTauri.push(...rows.map(fromRust));
    } catch { /* fall through to localStorage-only */ }
  }
  const fromLs = readLocal();

  // OVERLAY strategy: LS rows that match a Tauri row (by id OR cloudId)
  // SUPERSEDE the Tauri version — this is how updateItem/deleteItem can
  // mutate cloud-pulled rows without Rust write commands. Pure-Tauri rows
  // (no LS overlay) pass through unchanged; pure-LS rows (no SQLite peer)
  // are additive (locally-created).
  const lsById = new Map<number, LocalItem>();
  const lsByCloud = new Map<number, LocalItem>();
  for (const r of fromLs) {
    lsById.set(r.id, r);
    if (r.cloudId) lsByCloud.set(r.cloudId, r);
  }
  const usedLs = new Set<number>();
  const merged: LocalItem[] = [];
  for (const t of fromTauri) {
    const overlay = lsById.get(t.id) ?? (t.cloudId ? lsByCloud.get(t.cloudId) : undefined);
    if (overlay) {
      merged.push(overlay);
      usedLs.add(overlay.id);
    } else {
      merged.push(t);
    }
  }
  for (const r of fromLs) {
    if (usedLs.has(r.id)) continue;
    merged.push(r);
  }

  // Hide tombstones (deleted overlays).
  const visible = merged.filter((i) => !i.deleted);

  // If still empty AND no search, fall back to demo so the screen isn't blank
  let all = visible;
  if (all.length === 0 && !search) all = DEV_DEMO;
  if (!search) return all;
  const q = search.toLowerCase();
  return all.filter((i) =>
    i.nameAr.includes(search) ||
    (i.nameEn ?? "").toLowerCase().includes(q) ||
    (i.barcode ?? "").includes(search) ||
    (i.code ?? "").toLowerCase().includes(q),
  );
}

export async function findItemByBarcode(barcode: string): Promise<LocalItem | null> {
  if (IS_TAURI) {
    try {
      const r = await tauriInvoke<RustItem | null>("find_item_by_barcode", { barcode });
      if (r) return fromRust(r);
    } catch { /* fall through */ }
  }
  const all = readLocal();
  return all.find((i) => i.barcode === barcode)
      ?? DEV_DEMO.find((i) => i.barcode === barcode)
      ?? null;
}

export async function seedDemoItems(): Promise<number> {
  if (IS_TAURI) {
    try { return await tauriInvoke<number>("seed_demo_items"); }
    catch { /* fall through */ }
  }
  // No-op in browser — listItems() already falls back to DEV_DEMO.
  return 0;
}

// Bulk upsert from the cloud Pull response. Returns the count actually written.
export async function upsertItemsFromCloud(remote: Array<{
  id: number; code: string; nameAr: string; nameEn: string | null;
  barcode: string | null; salePrice: string; vatRate: string; updatedAt?: string;
}>): Promise<number> {
  // Coerce string prices/rates → number once at the boundary.
  const normalized = remote.map((r) => ({
    cloudId: r.id,
    code: r.code,
    nameAr: r.nameAr,
    nameEn: r.nameEn,
    barcode: r.barcode,
    salePrice: Number(r.salePrice),
    vatRate: Number(r.vatRate),
  }));

  if (IS_TAURI) {
    try {
      return await tauriInvoke<number>("upsert_items_from_cloud", {
        rows: normalized.map((r) => ({
          cloud_id: r.cloudId,
          code: r.code,
          name_ar: r.nameAr,
          name_en: r.nameEn,
          barcode: r.barcode,
          sale_price: r.salePrice,
          vat_rate: r.vatRate,
        })),
      });
    } catch { /* fall through to localStorage */ }
  }

  const existing = readLocal();
  const byCloud = new Map<number, LocalItem>();
  for (const i of existing) if (i.cloudId) byCloud.set(i.cloudId, i);
  let maxId = existing.reduce((m, i) => Math.max(m, i.id), 0);

  for (const r of normalized) {
    const prev = byCloud.get(r.cloudId);
    if (prev) {
      Object.assign(prev, {
        code: r.code,
        nameAr: r.nameAr,
        nameEn: r.nameEn,
        barcode: r.barcode,
        salePrice: r.salePrice,
        vatRate: r.vatRate,
        updatedAt: new Date().toISOString(),
      });
    } else {
      maxId += 1;
      existing.push({
        id: maxId,
        cloudId: r.cloudId,
        code: r.code,
        nameAr: r.nameAr,
        nameEn: r.nameEn,
        barcode: r.barcode,
        salePrice: r.salePrice,
        vatRate: r.vatRate,
        updatedAt: new Date().toISOString(),
      });
    }
  }
  lsWrite(LS_KEYS.items, existing);
  return normalized.length;
}

export interface CreateItemInput {
  code?: string | null;
  nameAr: string;
  nameEn?: string | null;
  barcode?: string | null;
  salePrice: number;
  vatRate: number;
  uomId?: number | null;
}

export async function createItem(input: CreateItemInput): Promise<LocalItem> {
  const all = readLocal();
  const id = all.reduce((m, i) => Math.max(m, i.id), 0) + 1;
  const row: LocalItem = {
    id,
    cloudId: null,
    code: input.code ?? null,
    nameAr: input.nameAr,
    nameEn: input.nameEn ?? null,
    barcode: input.barcode ?? null,
    salePrice: input.salePrice,
    vatRate: input.vatRate,
    uomId: input.uomId ?? null,
    updatedAt: new Date().toISOString(),
  };
  all.push(row);
  lsWrite(LS_KEYS.items, all);
  enqueuePush({
    clientId: `item-${id}-${Date.now()}`,
    entityType: "item",
    operation: "create",
    payload: { localId: id, ...input },
  });
  return row;
}

export async function updateItem(id: number, patch: Partial<CreateItemInput>): Promise<LocalItem | null> {
  const all = readLocal();
  const idx = all.findIndex((i) => i.id === id);
  let updated: LocalItem;
  if (idx >= 0) {
    updated = { ...all[idx], ...patch, updatedAt: new Date().toISOString() };
    all[idx] = updated;
  } else {
    // Row originates from SQLite (no LS peer yet) — fetch the current
    // state from the merged list and write a full overlay to LS so the
    // edit becomes visible and the next update can find it.
    const merged = await listItems();
    const base = merged.find((i) => i.id === id);
    if (!base) return null;
    updated = { ...base, ...patch, updatedAt: new Date().toISOString() };
    all.push(updated);
  }
  lsWrite(LS_KEYS.items, all);
  enqueuePush({
    clientId: `item-upd-${id}-${Date.now()}`,
    entityType: "item",
    operation: "update",
    payload: { localId: id, cloudId: updated.cloudId, ...patch },
  });
  return updated;
}

export async function deleteItem(id: number): Promise<void> {
  // Tombstone strategy: write a soft-deleted overlay row so the merged
  // listItems hides it even when SQLite still has the original. The
  // overlay carries `deleted:true` and listItems filters it out.
  const all = readLocal();
  const idx = all.findIndex((i) => i.id === id);
  let cloudId: number | null = null;
  if (idx >= 0) {
    cloudId = all[idx].cloudId ?? null;
    if (cloudId) {
      // Cloud-backed row: keep a tombstone so the merged list hides it.
      all[idx] = { ...all[idx], deleted: true, updatedAt: new Date().toISOString() };
    } else {
      // Pure local row: drop it outright (nothing on the server to delete).
      all.splice(idx, 1);
    }
  } else {
    // Row lives in SQLite only — create a tombstone overlay.
    const merged = await listItems();
    const base = merged.find((i) => i.id === id);
    if (!base) return;
    cloudId = base.cloudId ?? null;
    all.push({ ...base, deleted: true, updatedAt: new Date().toISOString() });
  }
  lsWrite(LS_KEYS.items, all);
  enqueuePush({
    clientId: `item-del-${id}-${Date.now()}`,
    entityType: "item",
    operation: "delete",
    payload: { localId: id, cloudId },
  });
}

export async function countItems(): Promise<number> {
  return (await listItems()).length;
}
