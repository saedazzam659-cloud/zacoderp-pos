// Item price-list import engine (OFFLINE-ONLY, no AI / no OCR).
//
// Takes a raw grid (string[][]) parsed from an Excel sheet, a text-PDF, or a
// manual paste, plus a column mapping, and:
//   • matches every row against the existing catalog (code → barcode → name),
//   • AUTO-UPDATES the sale price of matched items (no duplicate created),
//   • INSERTS genuinely new items once,
//   • optionally links the whole list to ONE brand (each brand carries its own
//     price/barcode/cost on the same item — an item can hold MANY brands).
//
// Pure, side-effect-free planning (`guessMapping` / `parseRows` / `buildPlan`)
// is separated from the mutating `applyPlan`, so the screen can preview counts
// before touching anything. Nothing here talks to Rust directly — it reuses
// lib/items (createItem/updateItem) and lib/brands (listItemBrandLinks/
// setItemBrands), both of which already handle SQLite vs LS internally.

import { createItem, updateItem, type LocalItem, type CreateItemInput } from "./items";
import { listItemBrandLinks, setItemBrands, type ItemBrandLink } from "./brands";

// ─── Field model ────────────────────────────────────────────────────────

/** Logical destination fields a source column can map onto. */
export type ImportField =
  | "code"
  | "nameAr"
  | "nameEn"
  | "barcode"
  | "salePrice"
  | "vatRate"
  | "cost"
  | "partNumber";

export const IMPORT_FIELDS: { key: ImportField; label: string; numeric: boolean }[] = [
  { key: "nameAr", label: "اسم الصنف", numeric: false },
  { key: "code", label: "الكود", numeric: false },
  { key: "barcode", label: "الباركود", numeric: false },
  { key: "salePrice", label: "سعر البيع", numeric: true },
  { key: "cost", label: "التكلفة / سعر الشراء", numeric: true },
  { key: "vatRate", label: "نسبة الضريبة %", numeric: true },
  { key: "partNumber", label: "رقم القطعة / الموديل", numeric: false },
  { key: "nameEn", label: "الاسم بالإنجليزية", numeric: false },
];

/** field → source-column index (undefined = not mapped). */
export type ColMapping = Partial<Record<ImportField, number>>;

/** One data row after applying the mapping. */
export interface ParsedRow {
  code: string;
  nameAr: string;
  nameEn: string;
  barcode: string;
  salePrice: number | null;
  cost: number | null;
  vatRate: number | null;
  partNumber: string;
  rowIndex: number;
}

export type RowKind = "new" | "price_update" | "unchanged" | "invalid";

export interface RowPlan {
  row: ParsedRow;
  kind: RowKind;
  matchedItemId: number | null;
  matchedBy: "code" | "barcode" | "name" | null;
  oldPrice: number | null;
  newPrice: number | null;
  /** Reason a row is `invalid` (Arabic, user-facing). */
  reason?: string;
}

export interface PlanSummary {
  plans: RowPlan[];
  counts: { total: number; new: number; priceUpdate: number; unchanged: number; invalid: number };
}

export interface ApplyResult {
  inserted: number;
  priceUpdated: number;
  brandLinked: number;
  skipped: number;
}

// ─── Normalisation helpers ──────────────────────────────────────────────

/** Trim + collapse internal whitespace. Used for name matching. */
export function normName(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

const AR_INDIC = "٠١٢٣٤٥٦٧٨٩";
const AR_INDIC_EXT = "۰۱۲۳۴۵۶۷۸۹";

/** Convert Arabic-Indic digits to ASCII, strip thousands separators/currency. */
export function parseNum(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let out = "";
  for (const ch of s) {
    const ai = AR_INDIC.indexOf(ch);
    if (ai >= 0) { out += String(ai); continue; }
    const ae = AR_INDIC_EXT.indexOf(ch);
    if (ae >= 0) { out += String(ae); continue; }
    out += ch;
  }
  // Keep digits, dot, minus. Drop commas, spaces, currency glyphs, %, etc.
  out = out.replace(/[,\u066c\u066b]/g, (m) => (m === "\u066b" ? "." : "")); // Arabic decimal sep → dot, thousands → drop
  out = out.replace(/[^0-9.\-]/g, "");
  if (!out || out === "-" || out === "." || out === "-.") return null;
  const n = Number(out);
  return Number.isFinite(n) ? n : null;
}

// ─── Header auto-detection ──────────────────────────────────────────────

const FIELD_KEYWORDS: Record<ImportField, string[]> = {
  nameAr: ["اسم", "الاسم", "الصنف", "البيان", "المنتج", "الوصف", "name", "item", "product", "description", "desc"],
  code: ["كود", "الكود", "رقم الصنف", "رمز", "code", "sku", "item no", "itemno", "ref"],
  barcode: ["باركود", "الباركود", "barcode", "ean", "upc", "bar code"],
  salePrice: ["سعر البيع", "سعر", "السعر", "بيع", "price", "sale", "selling", "unit price"],
  cost: ["تكلفة", "التكلفة", "سعر الشراء", "الشراء", "cost", "purchase", "buy"],
  vatRate: ["ضريبة", "الضريبة", "القيمة المضافة", "vat", "tax"],
  partNumber: ["رقم القطعة", "القطعة", "موديل", "الموديل", "part", "part no", "partnumber", "model"],
  nameEn: ["english", "الانجليزي", "الإنجليزي", "بالانجليزية", "name en", "english name", "en"],
};

/**
 * Best-effort header → field guess. A column is claimed by at most one field
 * (first match wins) so "سعر البيع" doesn't also grab the plain "سعر" column.
 * Priority order below biases the most specific / important fields first.
 */
export function guessMapping(header: string[]): ColMapping {
  const norm = header.map((h) => normName(h).toLowerCase());
  const used = new Set<number>();
  const map: ColMapping = {};
  const order: ImportField[] = ["nameAr", "barcode", "code", "salePrice", "cost", "vatRate", "partNumber", "nameEn"];
  for (const field of order) {
    const kws = FIELD_KEYWORDS[field];
    let best = -1;
    for (let c = 0; c < norm.length; c++) {
      if (used.has(c)) continue;
      const cell = norm[c];
      if (!cell) continue;
      if (kws.some((k) => cell.includes(k.toLowerCase()))) { best = c; break; }
    }
    if (best >= 0) { map[field] = best; used.add(best); }
  }
  return map;
}

// ─── Row parsing ────────────────────────────────────────────────────────

function cellAt(row: string[], idx: number | undefined): string {
  if (idx == null || idx < 0 || idx >= row.length) return "";
  return (row[idx] ?? "").toString().trim();
}

/**
 * Apply the mapping to the data rows (grid MINUS the header row when
 * `hasHeader`). Completely blank rows are dropped.
 */
export function parseRows(grid: string[][], mapping: ColMapping, hasHeader: boolean): ParsedRow[] {
  const start = hasHeader ? 1 : 0;
  const out: ParsedRow[] = [];
  for (let r = start; r < grid.length; r++) {
    const row = grid[r];
    if (!row || row.every((c) => !(c ?? "").toString().trim())) continue;
    out.push({
      code: cellAt(row, mapping.code),
      nameAr: normName(cellAt(row, mapping.nameAr)),
      nameEn: cellAt(row, mapping.nameEn),
      barcode: cellAt(row, mapping.barcode),
      salePrice: parseNum(cellAt(row, mapping.salePrice)),
      cost: parseNum(cellAt(row, mapping.cost)),
      vatRate: parseNum(cellAt(row, mapping.vatRate)),
      partNumber: cellAt(row, mapping.partNumber),
      rowIndex: r,
    });
  }
  return out;
}

// ─── Planning (dedup + classify) ────────────────────────────────────────

export interface BuildPlanOpts {
  /** When true, matched items whose price differs get a `price_update`. */
  updatePrices: boolean;
}

/**
 * Classify each parsed row against the existing catalog. Match precedence:
 * code → barcode → name (normalised). Matched rows never create a duplicate.
 */
export function buildPlan(rows: ParsedRow[], existing: LocalItem[], opts: BuildPlanOpts): PlanSummary {
  const byCode = new Map<string, LocalItem>();
  const byBarcode = new Map<string, LocalItem>();
  const byName = new Map<string, LocalItem>();
  for (const it of existing) {
    if (it.code) byCode.set(it.code.trim().toLowerCase(), it);
    if (it.barcode) byBarcode.set(it.barcode.trim().toLowerCase(), it);
    const nk = normName(it.nameAr).toLowerCase();
    if (nk && !byName.has(nk)) byName.set(nk, it);
  }

  const plans: RowPlan[] = [];
  const counts = { total: rows.length, new: 0, priceUpdate: 0, unchanged: 0, invalid: 0 };

  // In-batch dedup: keys already claimed by a planned "new" row in THIS file, so
  // the same new item appearing twice is inserted ONCE (second occurrence is
  // skipped). Existing-match duplicates are harmless (updateItem/setItemBrands
  // are idempotent) so we only guard the new-insert path here.
  const plannedCode = new Set<string>();
  const plannedBarcode = new Set<string>();
  const plannedName = new Set<string>();

  for (const row of rows) {
    if (!row.nameAr && !row.code && !row.barcode) {
      plans.push({ row, kind: "invalid", matchedItemId: null, matchedBy: null, oldPrice: null, newPrice: null, reason: "لا يوجد اسم أو كود أو باركود" });
      counts.invalid++;
      continue;
    }

    const kCode = row.code ? row.code.trim().toLowerCase() : "";
    const kBarcode = row.barcode ? row.barcode.trim().toLowerCase() : "";
    const kName = row.nameAr ? row.nameAr.toLowerCase() : "";

    // Resolve every identifier independently to detect conflicts (one row whose
    // code points at item A but barcode/name points at a DIFFERENT item B — a
    // dirty-list hazard that would otherwise silently mutate the wrong item).
    const mCode = kCode ? byCode.get(kCode) : undefined;
    const mBarcode = kBarcode ? byBarcode.get(kBarcode) : undefined;
    const mName = kName ? byName.get(kName) : undefined;
    const distinctIds = new Set([mCode, mBarcode, mName].filter((m): m is LocalItem => !!m).map((m) => m.id));
    if (distinctIds.size > 1) {
      plans.push({ row, kind: "invalid", matchedItemId: null, matchedBy: null, oldPrice: null, newPrice: row.salePrice, reason: "تعارض: الكود/الباركود/الاسم يخصّون أصنافًا مختلفة" });
      counts.invalid++;
      continue;
    }

    let match: LocalItem | undefined;
    let matchedBy: RowPlan["matchedBy"] = null;
    if (mCode) { match = mCode; matchedBy = "code"; }
    else if (mBarcode) { match = mBarcode; matchedBy = "barcode"; }
    else if (mName) { match = mName; matchedBy = "name"; }

    if (!match) {
      if (!row.nameAr) {
        plans.push({ row, kind: "invalid", matchedItemId: null, matchedBy: null, oldPrice: null, newPrice: row.salePrice, reason: "صنف جديد بدون اسم" });
        counts.invalid++;
        continue;
      }
      // Already planned as a new insert earlier in this same file → skip the dup.
      if ((kCode && plannedCode.has(kCode)) || (kBarcode && plannedBarcode.has(kBarcode)) || (kName && plannedName.has(kName))) {
        plans.push({ row, kind: "invalid", matchedItemId: null, matchedBy: null, oldPrice: null, newPrice: row.salePrice, reason: "مكرر داخل نفس الملف" });
        counts.invalid++;
        continue;
      }
      if (kCode) plannedCode.add(kCode);
      if (kBarcode) plannedBarcode.add(kBarcode);
      if (kName) plannedName.add(kName);
      plans.push({ row, kind: "new", matchedItemId: null, matchedBy: null, oldPrice: null, newPrice: row.salePrice });
      counts.new++;
      continue;
    }

    const oldPrice = match.salePrice;
    const newPrice = row.salePrice;
    const priceChanged = opts.updatePrices && newPrice != null && Math.abs(newPrice - oldPrice) > 1e-6;
    plans.push({
      row,
      kind: priceChanged ? "price_update" : "unchanged",
      matchedItemId: match.id,
      matchedBy,
      oldPrice,
      newPrice: newPrice ?? oldPrice,
    });
    if (priceChanged) counts.priceUpdate++; else counts.unchanged++;
  }

  return { plans, counts };
}

// ─── Apply (mutating) ───────────────────────────────────────────────────

export interface ApplyOpts {
  /** When set, every processed row is linked to this brand on its item. */
  brandId?: number | null;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Execute a plan. New rows are created, price_update rows are patched
 * (price only — other item fields are preserved by updateItem's merge), and
 * when `brandId` is set EVERY new/matched row gets/refreshes a brand link
 * (dedup by brandId; the link carries this list's barcode/cost/price so the
 * same item can hold many brands each with its own pricing). `invalid` rows
 * are skipped.
 */
export async function applyPlan(plans: RowPlan[], opts: ApplyOpts = {}): Promise<ApplyResult> {
  const brandId = opts.brandId ?? null;
  const res: ApplyResult = { inserted: 0, priceUpdated: 0, brandLinked: 0, skipped: 0 };
  const total = plans.length;
  let done = 0;

  for (const p of plans) {
    done++;
    opts.onProgress?.(done, total);

    if (p.kind === "invalid") { res.skipped++; continue; }

    let itemId: number | null = p.matchedItemId;

    if (p.kind === "new") {
      const input: CreateItemInput = {
        code: p.row.code || null,
        nameAr: p.row.nameAr,
        nameEn: p.row.nameEn || null,
        barcode: p.row.barcode || null,
        salePrice: p.row.salePrice ?? 0,
        vatRate: p.row.vatRate ?? 0,
      };
      try {
        const created = await createItem(input);
        itemId = created.id;
        res.inserted++;
      } catch {
        res.skipped++;
        continue;
      }
    } else if (p.kind === "price_update" && itemId != null && p.newPrice != null) {
      try {
        await updateItem(itemId, { salePrice: p.newPrice });
        res.priceUpdated++;
      } catch {
        // Price write failed; still attempt the brand link below.
      }
    }

    if (brandId != null && itemId != null) {
      try {
        const links = listItemBrandLinks(itemId);
        const idx = links.findIndex((l) => l.brandId === brandId);
        type LinkInput = Omit<ItemBrandLink, "id"> & { id?: string };
        let next: LinkInput[];
        if (idx >= 0) {
          const merged = { ...links[idx] };
          // Only overwrite a field when this list actually carried a value.
          if (p.row.barcode) merged.barcode = p.row.barcode;
          if (p.row.partNumber) merged.partNumber = p.row.partNumber;
          if (p.row.cost != null) merged.purchaseCost = p.row.cost;
          if (p.row.salePrice != null) merged.salePrice1 = p.row.salePrice;
          next = links.map((l, i) => (i === idx ? merged : l));
        } else {
          next = [
            ...links,
            {
              brandId,
              status: "active",
              barcode: p.row.barcode || null,
              partNumber: p.row.partNumber || null,
              purchaseCost: p.row.cost ?? null,
              salePrice1: p.row.salePrice ?? null,
            },
          ];
        }
        setItemBrands(itemId, next);
        res.brandLinked++;
      } catch {
        /* brand link is best-effort; item price/insert already succeeded */
      }
    }
  }

  return res;
}
