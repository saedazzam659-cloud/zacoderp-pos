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

import { LS_KEYS, lsRead, lsWrite, IS_TAURI } from "./localStore";
// Task #207: shared-data Rust commands route through the bridge so a LAN
// client forwards them to the host. In single/host mode `bridgeInvoke`
// calls the LOCAL Tauri command — identical to the previous `tauriInvoke`.
import { bridgeInvoke as tauriInvoke, shouldUseBridge } from "./bridge";
import { enqueuePush } from "./pushQueue";
import { getAppMode } from "./standalone";

// ─── Standalone mode (offline) ───────────────────────────────────────
// In standalone mode there is NO cloud: items must live authoritatively in
// SQLite (create/update/delete go straight to Rust) and the push queue is a
// no-op. Cloud mode keeps its existing LS-overlay + push behaviour untouched.
// Cached because the mode only changes on an app reload (the mode-switch wipe
// reloads the window), so a module-level memo is always fresh.
let _standalone: boolean | null = null;
async function isStandalone(): Promise<boolean> {
  if (_standalone === null) {
    try { _standalone = (await getAppMode()) === "standalone"; }
    catch { _standalone = false; }
  }
  return _standalone;
}

// LOCAL-ONLY field overlay for SQLite-backed items (units / classification).
// Keyed by SQLite item id. Mirrors the LS-overlay reasoning in
// memory pos-desktop-overlay-pattern, but scoped to the columns SQLite has no
// home for instead of superseding the whole row.
interface ItemMeta {
  units?: ItemUnit[] | null;
  groupId?: number | null;
  nature?: "service" | "stock" | null;
  itemType?: "finished" | "semi" | "raw" | "other" | null;
}
function readMeta(): Record<number, ItemMeta> {
  return lsRead<Record<number, ItemMeta>>(LS_KEYS.itemMeta, {});
}
function writeMetaFor(id: number, m: ItemMeta): void {
  const all = readMeta();
  all[id] = { ...all[id], ...m };
  lsWrite(LS_KEYS.itemMeta, all);
}
function dropMeta(id: number): void {
  const all = readMeta();
  if (id in all) { delete all[id]; lsWrite(LS_KEYS.itemMeta, all); }
}
function metaFrom(input: { units?: ItemUnit[] | null; groupId?: number | null;
  nature?: ItemMeta["nature"]; itemType?: ItemMeta["itemType"]; }): ItemMeta {
  return {
    units: input.units ?? null,
    groupId: input.groupId ?? null,
    nature: input.nature ?? null,
    itemType: input.itemType ?? null,
  };
}

const MIGRATED_FLAG = "pos_desktop_items_migrated_v1";

/**
 * One-time migration of legacy localStorage-only items (created by the old
 * LS-only `createItem`) into SQLite, so standalone create/update/delete — which
 * key off the SQLite rowid — can actually find and mutate them. Idempotent via
 * a flag. Pure-LS rows are inserted; rows that are overlays of an existing
 * SQLite row (same id) are folded into the meta overlay; cloud-linked rows are
 * left alone. Best-effort: a row that fails to insert is skipped, not fatal.
 */
async function migrateLegacyItems(): Promise<void> {
  if (lsRead<boolean>(MIGRATED_FLAG, false)) return;
  const ls = readLocal();
  if (ls.length === 0) { lsWrite(MIGRATED_FLAG, true); return; }
  let sqliteIds = new Set<number>();
  try {
    const rows = await tauriInvoke<RustItem[]>("list_items", { search: null });
    sqliteIds = new Set(rows.map((r) => r.id));
  } catch { return; /* SQLite unavailable — retry next list */ }

  const keep: LocalItem[] = [];
  let failed = 0;
  for (const r of ls) {
    if (r.cloudId) { keep.push(r); continue; }       // cloud-linked: leave as-is
    if (r.deleted) continue;                           // drop stale tombstones
    if (sqliteIds.has(r.id)) {                         // overlay of a SQLite row
      writeMetaFor(r.id, metaFrom(r));
      continue;
    }
    if (!r.nameAr) continue;                           // malformed — discard
    try {
      const id = await tauriInvoke<number>("insert_local_item", {
        code: r.code ?? null, nameAr: r.nameAr, nameEn: r.nameEn ?? null,
        barcode: r.barcode ?? null, salePrice: r.salePrice, vatRate: r.vatRate,
        uomId: r.uomId ?? null,
        activeIngredient: r.activeIngredient ?? null, dosageForm: r.dosageForm ?? null,
        strength: r.strength ?? null, manufacturer: r.manufacturer ?? null,
        requiresPrescription: r.requiresPrescription ?? null, controlled: r.controlled ?? null,
        expiryDate: r.expiryDate ?? null, batchNo: r.batchNo ?? null,
        isWeighed: r.isWeighed ?? null, pricePerKg: r.pricePerKg ?? null, plu: r.plu ?? null,
      });
      writeMetaFor(id, metaFrom(r));
    } catch { keep.push(r); failed++; /* keep so a later run can retry */ }
  }
  lsWrite(LS_KEYS.items, keep);
  // Only mark migration done when EVERY pure-LS row landed in SQLite. If any
  // insert failed those rows stay in LS and the flag stays unset so the next
  // listItems retries them (an LS row whose id isn't in SQLite can't be edited,
  // since standalone update writes to SQLite by id).
  if (failed === 0) lsWrite(MIGRATED_FLAG, true);
}

/**
 * A non-base sale unit (e.g. كرتونة, نص كرتونة). Multi-unit pricing is
 * LOCAL-ONLY: it lives in the localStorage overlay, never in SQLite/cloud —
 * exactly like the stock map and the LS overlay edits (see memory
 * pos-desktop-overlay-pattern). Each unit has a conversion factor expressed in
 * BASE units (pieces) and its own price + optional barcode for one-scan sell.
 */
export interface ItemUnit {
  /** Stable local id (uuid) — used as the cart-line unit key. */
  id: string;
  /** Display name, e.g. "كرتونة", "نص كرتونة". */
  name: string;
  /** How many base units (pieces) make up ONE of this unit. Must be > 0. */
  factor: number;
  /** Sale price for ONE of this unit (same gross/net basis as salePrice). */
  price: number;
  /** Optional unique barcode — scanning it sells one of this unit. */
  barcode?: string | null;
}

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
  // Classification (LOCAL-ONLY — LS overlay, no SQLite/cloud column).
  /** FK to itemGroups.id (مجموعة الصنف). */
  groupId?: number | null;
  /** طبيعة الصنف: "service" = خدمي، "stock" = مخزني. */
  nature?: "service" | "stock" | null;
  /** نوع الصنف: تام / نصف مصنع / مواد خام / أخرى. */
  itemType?: "finished" | "semi" | "raw" | "other" | null;
  // Pharmacy vertical (Task #200) — populated when the store's vertical is
  // "pharmacy". Mapped from snake_case Rust columns by fromRust().
  activeIngredient?: string | null;
  dosageForm?: string | null;
  strength?: string | null;
  manufacturer?: string | null;
  requiresPrescription?: boolean | null;
  controlled?: boolean | null;
  /** ISO date 'YYYY-MM-DD'. Drives the expiry badges + report. */
  expiryDate?: string | null;
  batchNo?: string | null;
  // Scale (Task #201) — weighed items charged per-kg at sale time.
  isWeighed?: boolean | null;
  pricePerKg?: number | null;
  /** 4–5 digit PLU. Matches the digits embedded in scale-printed barcodes. */
  plu?: string | null;
  /** Multi-unit sale pricing (carton / half-carton / piece). LOCAL-ONLY —
   * stored in the LS overlay, never written to SQLite/cloud. The item's own
   * salePrice/barcode are the BASE unit (factor 1); these are ADDITIONAL units. */
  units?: ItemUnit[] | null;
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
  uom_id?: number | null;
  active_ingredient?: string | null;
  dosage_form?: string | null;
  strength?: string | null;
  manufacturer?: string | null;
  requires_prescription?: boolean | null;
  controlled?: boolean | null;
  expiry_date?: string | null;
  batch_no?: string | null;
  is_weighed?: boolean | null;
  price_per_kg?: number | null;
  plu?: string | null;
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
    uomId: r.uom_id ?? null,
    activeIngredient: r.active_ingredient ?? null,
    dosageForm: r.dosage_form ?? null,
    strength: r.strength ?? null,
    manufacturer: r.manufacturer ?? null,
    requiresPrescription: r.requires_prescription ?? null,
    controlled: r.controlled ?? null,
    expiryDate: r.expiry_date ?? null,
    batchNo: r.batch_no ?? null,
    isWeighed: r.is_weighed ?? null,
    pricePerKg: r.price_per_kg ?? null,
    plu: r.plu ?? null,
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
  // Standalone: one-time pull legacy LS-only items into SQLite so they become
  // editable/deletable (those paths key off the SQLite rowid).
  if (shouldUseBridge() && await isStandalone()) {
    try { await migrateLegacyItems(); } catch { /* best-effort */ }
  }

  const fromTauri: LocalItem[] = [];
  if (shouldUseBridge()) {
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

  // Apply the LOCAL-ONLY field overlay (units / classification) onto
  // SQLite-backed rows. The map is keyed by SQLite id and is only populated in
  // standalone mode, so this is a no-op in cloud/browser mode.
  const meta = readMeta();
  const withMeta = merged.map((i) => (meta[i.id] ? { ...i, ...meta[i.id] } : i));

  // Hide tombstones (deleted overlays).
  const visible = withMeta.filter((i) => !i.deleted);

  // If still empty AND no search, fall back to demo so the screen isn't blank.
  // Gated to NON-Tauri (browser preview) only — a real install (cloud or
  // standalone) must never show fake demo rows that can't be sold or synced.
  let all = visible;
  if (all.length === 0 && !search && !IS_TAURI) all = DEV_DEMO;
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
  if (shouldUseBridge()) {
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

export interface SaleUnitMatch {
  item: LocalItem;
  /** The matched additional unit, or null when the BASE unit matched. */
  unit: ItemUnit | null;
}

/**
 * Resolve a scanned barcode to an item AND the specific sale-unit it maps to.
 * Unit barcodes win over the base barcode (more specific). `unit: null` means
 * the base unit (qty 1 = 1 base unit at salePrice). Returns null when nothing
 * matches.
 *
 * Unlike findItemByBarcode this is OVERLAY-AWARE (reads listItems) because unit
 * definitions live only in the LS overlay — the Rust find_item_by_barcode
 * command only knows the SQLite `barcode` column and can't see units.
 */
export async function findItemUnitByBarcode(barcode: string): Promise<SaleUnitMatch | null> {
  const code = barcode.trim();
  if (!code) return null;
  const all = await listItems();
  for (const it of all) {
    const u = it.units?.find((x) => (x.barcode ?? "").trim() === code);
    if (u) return { item: it, unit: u };
  }
  const base = all.find((it) => (it.barcode ?? "").trim() === code);
  if (base) return { item: base, unit: null };
  return null;
}

export async function seedDemoItems(): Promise<number> {
  if (shouldUseBridge()) {
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

  if (shouldUseBridge()) {
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
  // Pharmacy extension (Task #200) — always optional. Generic-vertical
  // catalogs simply leave them undefined.
  activeIngredient?: string | null;
  dosageForm?: string | null;
  strength?: string | null;
  manufacturer?: string | null;
  requiresPrescription?: boolean | null;
  controlled?: boolean | null;
  expiryDate?: string | null;
  batchNo?: string | null;
  // Scale (Task #201)
  isWeighed?: boolean | null;
  pricePerKg?: number | null;
  plu?: string | null;
  // Multi-unit pricing — LOCAL-ONLY (LS overlay).
  units?: ItemUnit[] | null;
  // Classification — LOCAL-ONLY (LS overlay).
  groupId?: number | null;
  nature?: "service" | "stock" | null;
  itemType?: "finished" | "semi" | "raw" | "other" | null;
}

export async function createItem(input: CreateItemInput): Promise<LocalItem> {
  // Blank code/barcode → null (mirrors the Rust normalisation): the SQLite
  // partial UNIQUE index on `code` treats "" as a real, collidable value, so a
  // blank code field — the common case — must persist as NULL.
  input = {
    ...input,
    code: (input.code ?? "").trim() || null,
    barcode: (input.barcode ?? "").trim() || null,
  };
  // Standalone: SQLite is authoritative. Core + pharmacy + scale columns go in
  // via insert_local_item (returns the real rowid the form needs for the
  // follow-up updateItemWeighed/Extended calls); local-only fields (units /
  // classification) go to the meta overlay. No push queue (there is no cloud).
  if (shouldUseBridge() && await isStandalone()) {
    const id = await tauriInvoke<number>("insert_local_item", {
      code: input.code ?? null, nameAr: input.nameAr, nameEn: input.nameEn ?? null,
      barcode: input.barcode ?? null, salePrice: input.salePrice, vatRate: input.vatRate,
      uomId: input.uomId ?? null,
      activeIngredient: input.activeIngredient ?? null, dosageForm: input.dosageForm ?? null,
      strength: input.strength ?? null, manufacturer: input.manufacturer ?? null,
      requiresPrescription: input.requiresPrescription ?? null, controlled: input.controlled ?? null,
      expiryDate: input.expiryDate ?? null, batchNo: input.batchNo ?? null,
      isWeighed: input.isWeighed ?? null, pricePerKg: input.pricePerKg ?? null, plu: input.plu ?? null,
    });
    writeMetaFor(id, metaFrom(input));
    return {
      id, cloudId: null,
      code: input.code ?? null, nameAr: input.nameAr, nameEn: input.nameEn ?? null,
      barcode: input.barcode ?? null, salePrice: input.salePrice, vatRate: input.vatRate,
      uomId: input.uomId ?? null,
      activeIngredient: input.activeIngredient ?? null, dosageForm: input.dosageForm ?? null,
      strength: input.strength ?? null, manufacturer: input.manufacturer ?? null,
      requiresPrescription: input.requiresPrescription ?? null, controlled: input.controlled ?? null,
      expiryDate: input.expiryDate ?? null, batchNo: input.batchNo ?? null,
      isWeighed: input.isWeighed ?? null, pricePerKg: input.pricePerKg ?? null, plu: input.plu ?? null,
      units: input.units ?? null, groupId: input.groupId ?? null,
      nature: input.nature ?? null, itemType: input.itemType ?? null,
      updatedAt: new Date().toISOString(),
    };
  }

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
    activeIngredient: input.activeIngredient ?? null,
    dosageForm: input.dosageForm ?? null,
    strength: input.strength ?? null,
    manufacturer: input.manufacturer ?? null,
    requiresPrescription: input.requiresPrescription ?? null,
    controlled: input.controlled ?? null,
    expiryDate: input.expiryDate ?? null,
    batchNo: input.batchNo ?? null,
    isWeighed: input.isWeighed ?? null,
    pricePerKg: input.pricePerKg ?? null,
    plu: input.plu ?? null,
    units: input.units ?? null,
    groupId: input.groupId ?? null,
    nature: input.nature ?? null,
    itemType: input.itemType ?? null,
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

/**
 * Bulk-import a pre-validated catalog (Task #200 EDA pharmacy import).
 * In Tauri we write straight to SQLite via `insert_local_item` (one fsync
 * per row but no push-queue noise — these are seed rows, not user creations).
 * Browser fallback uses localStorage (same dedup contract as createItem).
 *
 * Returns { inserted, skippedDup } so the UI can show a meaningful toast.
 */
export async function bulkImportLocalItems(
  rows: CreateItemInput[],
  opts: { dedupBy?: "barcode" | "code" | "none" } = {},
): Promise<{ inserted: number; skippedDup: number }> {
  const dedupBy = opts.dedupBy ?? "barcode";
  // Build the "already exists" sets from the merged catalog so we dedup
  // against both SQLite-pulled and locally-created rows.
  const existing = await listItems();
  const seenBc = new Set(existing.map((r) => r.barcode).filter((b): b is string => !!b));
  const seenCode = new Set(existing.map((r) => r.code).filter((c): c is string => !!c));
  let inserted = 0;
  let skippedDup = 0;
  if (shouldUseBridge()) {
    for (const r of rows) {
      if (dedupBy === "barcode" && r.barcode && seenBc.has(r.barcode)) { skippedDup++; continue; }
      if (dedupBy === "code" && r.code && seenCode.has(r.code)) { skippedDup++; continue; }
      try {
        await tauriInvoke<number>("insert_local_item", {
          code: r.code ?? null,
          nameAr: r.nameAr,
          nameEn: r.nameEn ?? null,
          barcode: r.barcode ?? null,
          salePrice: r.salePrice,
          vatRate: r.vatRate,
          activeIngredient: r.activeIngredient ?? null,
          dosageForm: r.dosageForm ?? null,
          strength: r.strength ?? null,
          manufacturer: r.manufacturer ?? null,
          requiresPrescription: r.requiresPrescription ?? null,
          controlled: r.controlled ?? null,
          expiryDate: r.expiryDate ?? null,
          batchNo: r.batchNo ?? null,
          isWeighed: r.isWeighed ?? null,
          pricePerKg: r.pricePerKg ?? null,
          plu: r.plu ?? null,
        });
        inserted++;
        if (r.barcode) seenBc.add(r.barcode);
        if (r.code) seenCode.add(r.code);
      } catch { /* skip on row-level failure (e.g. UNIQUE conflict) */ }
    }
    return { inserted, skippedDup };
  }
  // Browser fallback — write via createItem (LS only).
  for (const r of rows) {
    if (dedupBy === "barcode" && r.barcode && seenBc.has(r.barcode)) { skippedDup++; continue; }
    if (dedupBy === "code" && r.code && seenCode.has(r.code)) { skippedDup++; continue; }
    try {
      await createItem(r);
      inserted++;
      if (r.barcode) seenBc.add(r.barcode);
      if (r.code) seenCode.add(r.code);
    } catch { /* skip */ }
  }
  return { inserted, skippedDup };
}

/**
 * Items whose `expiryDate` is non-null and within `withinDays` days of today
 * (or already expired when the difference is ≤ 0). Sorted soonest-first.
 * Backed by `list_expiring_items` on Tauri; computes client-side otherwise.
 */
export async function listExpiringItems(withinDays = 90): Promise<LocalItem[]> {
  if (shouldUseBridge()) {
    try {
      const rows = await tauriInvoke<RustItem[]>("list_expiring_items", { withinDays });
      return rows.map(fromRust);
    } catch { /* fall through */ }
  }
  const all = await listItems();
  const now = Date.now();
  const horizon = now + withinDays * 86_400_000;
  return all
    .filter((i) => !!i.expiryDate)
    .filter((i) => {
      const t = new Date(i.expiryDate!).getTime();
      return Number.isFinite(t) && t <= horizon;
    })
    .sort((a, b) => (a.expiryDate ?? "").localeCompare(b.expiryDate ?? ""));
}

/**
 * Persist pharmacy-extended fields on a row (Task #200). In Tauri this hits
 * SQLite directly so SQLite-backed rows (EDA imports, cloud pulls) get the
 * update — without this, edits to those fields would land in the LS overlay
 * and silently vanish on the next listItems (see memory pos-desktop-overlay-pattern).
 * Browser fallback is a no-op since the regular updateItem() already wrote
 * the LS overlay for us.
 */
export async function updateItemExtended(
  id: number,
  fields: {
    activeIngredient?: string | null;
    dosageForm?: string | null;
    strength?: string | null;
    manufacturer?: string | null;
    requiresPrescription?: boolean | null;
    controlled?: boolean | null;
    expiryDate?: string | null;
    batchNo?: string | null;
  },
): Promise<void> {
  if (!shouldUseBridge()) {
    // Browser-preview persistence (dev mode). Patch the LS row so edits don't
    // silently disappear when the operator is testing the form without Tauri.
    const all = readLocal();
    const idx = all.findIndex((r) => r.id === id);
    if (idx >= 0) {
      all[idx] = { ...all[idx], ...fields, updatedAt: new Date().toISOString() };
      lsWrite(LS_KEYS.items, all);
    }
    return;
  }
  try {
    await tauriInvoke("update_local_item_extended", {
      id,
      activeIngredient: fields.activeIngredient ?? null,
      dosageForm: fields.dosageForm ?? null,
      strength: fields.strength ?? null,
      manufacturer: fields.manufacturer ?? null,
      requiresPrescription: fields.requiresPrescription ?? null,
      controlled: fields.controlled ?? null,
      expiryDate: fields.expiryDate ?? null,
      batchNo: fields.batchNo ?? null,
    });
  } catch (e) {
    // Surface as a thrown error so the form can show it; pharma fields are
    // user-visible and silent failure here would be very confusing.
    throw new Error(`فشل حفظ بيانات الدواء: ${e}`);
  }
}

/**
 * Persist Task-#201 weighed fields on a row. Same overlay-pattern reasoning
 * as `updateItemExtended` — cloud-pulled / EDA-imported rows have no LS
 * overlay row, so the dedicated Tauri command writes straight to SQLite.
 */
export async function updateItemWeighed(
  id: number,
  fields: { isWeighed?: boolean | null; pricePerKg?: number | null; plu?: string | null },
): Promise<void> {
  if (!shouldUseBridge()) {
    const all = readLocal();
    const idx = all.findIndex((r) => r.id === id);
    if (idx >= 0) {
      all[idx] = { ...all[idx], ...fields, updatedAt: new Date().toISOString() };
      lsWrite(LS_KEYS.items, all);
    }
    return;
  }
  try {
    await tauriInvoke("update_local_item_weighed", {
      id,
      isWeighed: fields.isWeighed ?? null,
      pricePerKg: fields.pricePerKg ?? null,
      plu: fields.plu ?? null,
    });
  } catch (e: any) {
    // The Rust side already translates the SQLITE UNIQUE constraint
    // into an Arabic message — bubble that through unchanged when we
    // detect it, otherwise wrap in the generic header.
    const msg = e?.message ?? String(e);
    if (msg.includes("PLU")) throw new Error(msg);
    throw new Error(`فشل حفظ بيانات الميزان: ${msg}`);
  }
}

/**
 * Resolve a PLU (4–5 digit code) to its catalog row. Used by the
 * embedded-weight barcode path on SalesScreen. Browser fallback scans
 * the merged catalog client-side.
 */
export async function findItemByPlu(plu: string): Promise<LocalItem | null> {
  if (shouldUseBridge()) {
    try {
      const r = await tauriInvoke<RustItem | null>("find_item_by_plu", { plu });
      if (r) return fromRust(r);
    } catch { /* fall through */ }
  }
  const all = await listItems();
  return all.find((i) => (i.plu ?? "") === plu) ?? null;
}

/** Days until expiry for an item, or null if no expiry date. Negative = already expired. */
export function daysUntilExpiry(it: { expiryDate?: string | null }): number | null {
  if (!it.expiryDate) return null;
  const t = new Date(it.expiryDate).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((t - Date.now()) / 86_400_000);
}

export async function updateItem(id: number, patch: Partial<CreateItemInput>): Promise<LocalItem | null> {
  // Blank code/barcode → null (mirrors createItem + the Rust normalisation) so
  // re-saving a row with an empty code can't collide on the partial UNIQUE index.
  if (patch.code !== undefined) patch = { ...patch, code: (patch.code ?? "").trim() || null };
  if (patch.barcode !== undefined) patch = { ...patch, barcode: (patch.barcode ?? "").trim() || null };
  // Standalone: core columns are written straight to SQLite (a FULL-row update,
  // so we merge the patch over the current row first); local-only fields go to
  // the meta overlay. Pharmacy/scale columns are owned by updateItemExtended/
  // _weighed and are intentionally untouched here. No push queue.
  if (shouldUseBridge() && await isStandalone()) {
    const current = (await listItems()).find((i) => i.id === id);
    if (!current) return null;
    const merged: LocalItem = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await tauriInvoke("update_local_item", {
      id,
      code: merged.code ?? null, nameAr: merged.nameAr, nameEn: merged.nameEn ?? null,
      barcode: merged.barcode ?? null, salePrice: merged.salePrice, vatRate: merged.vatRate,
      uomId: merged.uomId ?? null,
    });
    writeMetaFor(id, metaFrom(merged));
    return merged;
  }

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
  // Standalone: hard-delete from SQLite (no cloud to resurrect it), drop the
  // meta overlay, and clear any stray legacy LS row for this id. No push queue.
  if (shouldUseBridge() && await isStandalone()) {
    await tauriInvoke("delete_local_item", { id });
    dropMeta(id);
    const ls = readLocal();
    const idx = ls.findIndex((i) => i.id === id);
    if (idx >= 0) { ls.splice(idx, 1); lsWrite(LS_KEYS.items, ls); }
    return;
  }

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
