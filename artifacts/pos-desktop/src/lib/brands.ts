// Brand management (العلامات التجارية) for the offline Windows POS/back-office.
//
// One item can carry SEVERAL brands (الشريف / النيل / المتحدة …), each with its
// own price/cost/barcode/part-number, instead of duplicating the item. Brands
// are fully OPTIONAL and additive: an item with no brands behaves exactly as
// before.
//
// STORAGE: pure localStorage, LOCAL-ONLY (no cloud sync — out of scope). This
// mirrors the item-meta overlay reasoning (see memory pos-desktop-overlay-
// pattern / pos-desktop-standalone-items): local-only catalog fields ride an LS
// overlay rather than needing new SQLite columns + CI-only Rust commands. Both
// keys carry the `pos_desktop_` prefix so the standalone mode-switch wipe clears
// them alongside every other device-local key.
//
// ZATCA SAFETY: the selected brand is a PRINT-ONLY line field. Nothing here ever
// feeds the ZATCA UBL XML, invoice hashing/signing, ICV/PIH chain, or QR. At
// entry time a picked brand only (a) loads its price/barcode/part-number into
// the EXISTING line fields, and (b) is shown on the printed invoice as a
// separate cosmetic field.

import { LS_KEYS, lsRead, lsWrite } from "./localStore";
import { emitData } from "./dataBus";

export type BrandStatus = "active" | "inactive";

/** Brand master record. Mirrors the web core `brands` table field set. */
export interface Brand {
  /** Stable local id. */
  id: number;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  manufacturerName?: string | null;
  supplierName?: string | null;
  countryOfOrigin?: string | null;
  logoUrl?: string | null;
  status: BrandStatus;
  notes?: string | null;
  updatedAt?: string;
}

/**
 * Per-item ↔ brand link. Each brand attached to an item carries its own
 * pricing/identification. Mirrors the web core `item_brands` field set.
 */
export interface ItemBrandLink {
  /** Stable local id (uuid) for the link row. */
  id: string;
  brandId: number;
  barcode?: string | null;
  partNumber?: string | null;
  supplierCode?: string | null;
  purchaseUnit?: string | null;
  purchaseCost?: number | null;
  lastPurchaseCost?: number | null;
  avgCost?: number | null;
  salePrice1?: number | null;
  salePrice2?: number | null;
  salePrice3?: number | null;
  minSalePrice?: number | null;
  profitMargin?: number | null;
  countryOfOrigin?: string | null;
  warrantyPeriod?: string | null;
  status: BrandStatus;
  notes?: string | null;
}

/** An item-brand link joined with its brand names for display. */
export interface ItemBrandView extends ItemBrandLink {
  brandNameAr: string;
  brandNameEn?: string | null;
  brandCode: string;
}

// ─── Brand master CRUD ──────────────────────────────────────────────────

function readBrands(): Brand[] {
  return lsRead<Brand[]>(LS_KEYS.brands, []);
}
function writeBrands(rows: Brand[]): void {
  lsWrite(LS_KEYS.brands, rows);
}

export function listBrands(search?: string): Brand[] {
  const all = readBrands();
  if (!search) return all;
  const q = search.trim().toLowerCase();
  if (!q) return all;
  return all.filter(
    (b) =>
      b.nameAr.includes(search) ||
      (b.nameEn ?? "").toLowerCase().includes(q) ||
      (b.code ?? "").toLowerCase().includes(q) ||
      (b.manufacturerName ?? "").toLowerCase().includes(q),
  );
}

export function getBrand(id: number): Brand | null {
  return readBrands().find((b) => b.id === id) ?? null;
}

export interface BrandInput {
  code?: string | null;
  nameAr: string;
  nameEn?: string | null;
  manufacturerName?: string | null;
  supplierName?: string | null;
  countryOfOrigin?: string | null;
  logoUrl?: string | null;
  status?: BrandStatus;
  notes?: string | null;
}

function nextBrandCode(existing: Brand[]): string {
  let max = 0;
  for (const b of existing) {
    const m = /(\d+)\s*$/.exec(b.code ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `BR-${String(max + 1).padStart(4, "0")}`;
}

export function createBrand(input: BrandInput): Brand {
  const all = readBrands();
  const id = all.reduce((m, b) => Math.max(m, b.id), 0) + 1;
  const code = (input.code ?? "").trim() || nextBrandCode(all);
  const row: Brand = {
    id,
    code,
    nameAr: input.nameAr.trim(),
    nameEn: input.nameEn?.trim() || null,
    manufacturerName: input.manufacturerName?.trim() || null,
    supplierName: input.supplierName?.trim() || null,
    countryOfOrigin: input.countryOfOrigin?.trim() || null,
    logoUrl: input.logoUrl?.trim() || null,
    status: input.status ?? "active",
    notes: input.notes?.trim() || null,
    updatedAt: new Date().toISOString(),
  };
  all.push(row);
  writeBrands(all);
  emitData("brands", "items");
  return row;
}

export function updateBrand(id: number, patch: BrandInput): Brand | null {
  const all = readBrands();
  const idx = all.findIndex((b) => b.id === id);
  if (idx < 0) return null;
  const prev = all[idx];
  const next: Brand = {
    ...prev,
    code: (patch.code ?? prev.code ?? "").trim() || prev.code,
    nameAr: patch.nameAr.trim(),
    nameEn: patch.nameEn?.trim() || null,
    manufacturerName: patch.manufacturerName?.trim() || null,
    supplierName: patch.supplierName?.trim() || null,
    countryOfOrigin: patch.countryOfOrigin?.trim() || null,
    logoUrl: patch.logoUrl?.trim() || null,
    status: patch.status ?? prev.status,
    notes: patch.notes?.trim() || null,
    updatedAt: new Date().toISOString(),
  };
  all[idx] = next;
  writeBrands(all);
  emitData("brands", "items");
  return next;
}

export function deleteBrand(id: number): void {
  const all = readBrands();
  const next = all.filter((b) => b.id !== id);
  if (next.length === all.length) return;
  writeBrands(next);
  // Cascade: drop any item links that referenced this brand so pickers never
  // surface a dangling brandId.
  const map = readItemBrandMap();
  let changed = false;
  for (const key of Object.keys(map)) {
    const itemId = Number(key);
    const links = map[itemId];
    const filtered = links.filter((l) => l.brandId !== id);
    if (filtered.length !== links.length) {
      if (filtered.length) map[itemId] = filtered;
      else delete map[itemId];
      changed = true;
    }
  }
  if (changed) writeItemBrandMap(map);
  emitData("brands", "items");
}

// ─── Item ↔ brand links ─────────────────────────────────────────────────

function readItemBrandMap(): Record<number, ItemBrandLink[]> {
  return lsRead<Record<number, ItemBrandLink[]>>(LS_KEYS.itemBrands, {});
}
function writeItemBrandMap(map: Record<number, ItemBrandLink[]>): void {
  lsWrite(LS_KEYS.itemBrands, map);
}

function uuid(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
  } catch { /* fall through */ }
  return `ib-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Raw links stored for an item (no brand-name join). */
export function listItemBrandLinks(itemId: number): ItemBrandLink[] {
  return readItemBrandMap()[itemId] ?? [];
}

/**
 * Links for an item joined with brand display names, dropping links whose brand
 * no longer exists (defensive — deleteBrand already cascades).
 */
export function listItemBrands(itemId: number): ItemBrandView[] {
  const links = listItemBrandLinks(itemId);
  if (!links.length) return [];
  const brands = readBrands();
  const byId = new Map(brands.map((b) => [b.id, b]));
  const out: ItemBrandView[] = [];
  for (const l of links) {
    const b = byId.get(l.brandId);
    if (!b) continue;
    out.push({
      ...l,
      brandNameAr: b.nameAr,
      brandNameEn: b.nameEn ?? null,
      brandCode: b.code,
    });
  }
  return out;
}

/** True when an item has at least one attached brand (drives picker visibility). */
export function itemHasBrands(itemId: number): boolean {
  return listItemBrandLinks(itemId).length > 0;
}

/** Whole-set replace for an item's brand links (used by the item admin form). */
export function setItemBrands(
  itemId: number,
  links: Array<Omit<ItemBrandLink, "id"> & { id?: string }>,
): void {
  const map = readItemBrandMap();
  if (!links.length) {
    delete map[itemId];
  } else {
    map[itemId] = links.map((l) => ({
      ...l,
      id: l.id ?? uuid(),
      status: l.status ?? "active",
    }));
  }
  writeItemBrandMap(map);
  emitData("brands", "items");
}

/** Drop every brand link for an item (called when the item is deleted). */
export function dropItemBrands(itemId: number): void {
  const map = readItemBrandMap();
  if (itemId in map) {
    delete map[itemId];
    writeItemBrandMap(map);
    emitData("brands", "items");
  }
}

// ─── Sales-invoice brand snapshot overlay (PRINT-ONLY) ──────────────────
// Back-office sales invoice lines round-trip through Rust/SQLite, which has NO
// brand column. So we snapshot the picked brand NAME per line into an LS overlay
// keyed by invoice id, indexed in PERSISTED (cleaned) line order — the same
// order getSalesInvoice returns. This is purely cosmetic for printing; the
// brand name NEVER enters the ZATCA UBL XML / hash / signature / QR / ICV-PIH.

/** One persisted line's brand snapshot (aligned by index to the invoice lines). */
export interface InvoiceLineBrand {
  brandId: number | null;
  brandName: string | null;
}

function readInvoiceBrandMap(): Record<number, InvoiceLineBrand[]> {
  return lsRead<Record<number, InvoiceLineBrand[]>>(LS_KEYS.invoiceBrands, {});
}
function writeInvoiceBrandMap(map: Record<number, InvoiceLineBrand[]>): void {
  lsWrite(LS_KEYS.invoiceBrands, map);
}

/**
 * Whole-set replace of an invoice's per-line brand snapshot. `lineBrands` must
 * be in the SAME order as the persisted invoice lines. An all-empty set clears
 * the overlay row (keeps storage tidy for brand-less invoices).
 */
export function saveInvoiceLineBrands(invoiceId: number, lineBrands: InvoiceLineBrand[]): void {
  const map = readInvoiceBrandMap();
  const hasAny = lineBrands.some((b) => b && b.brandId);
  if (!hasAny) {
    delete map[invoiceId];
  } else {
    map[invoiceId] = lineBrands.map((b) => ({
      brandId: b?.brandId ?? null,
      brandName: b?.brandName ?? null,
    }));
  }
  writeInvoiceBrandMap(map);
}

/** Per-line brand snapshot for an invoice (empty array when none). */
export function getInvoiceLineBrands(invoiceId: number): InvoiceLineBrand[] {
  return readInvoiceBrandMap()[invoiceId] ?? [];
}

/** Drop an invoice's brand snapshot (called when the invoice is deleted). */
export function dropInvoiceLineBrands(invoiceId: number): void {
  const map = readInvoiceBrandMap();
  if (invoiceId in map) {
    delete map[invoiceId];
    writeInvoiceBrandMap(map);
  }
}

/** Count of items each brand is attached to (for the brand admin grid). */
export function brandUsageCounts(): Record<number, number> {
  const map = readItemBrandMap();
  const counts: Record<number, number> = {};
  for (const links of Object.values(map)) {
    const seen = new Set<number>();
    for (const l of links) {
      if (seen.has(l.brandId)) continue;
      seen.add(l.brandId);
      counts[l.brandId] = (counts[l.brandId] ?? 0) + 1;
    }
  }
  return counts;
}
