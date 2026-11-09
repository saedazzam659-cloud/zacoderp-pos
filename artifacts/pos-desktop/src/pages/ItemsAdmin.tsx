import { saveText } from "../lib/saveFile";
// Items admin — list + add + edit + delete.
// Uses lib/items.ts + lib/uom.ts.

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import QRCode from "qrcode";
import {
  listItems, createItem, updateItem, deleteItem, bulkImportLocalItems, updateItemExtended, updateItemWeighed,
  type LocalItem, type CreateItemInput, type ItemUnit, type ItemWebProfile, type ItemAuditEntry,
  type ItemUsageMode, type RestaurantModifierGroup,
} from "../lib/items";
import { listUom, getDefaultUom } from "../lib/uom";
import { listItemGroups } from "../lib/itemGroups";
import { listBrands, listItemBrandLinks, setItemBrands, dropItemBrands, type ItemBrandLink } from "../lib/brands";
import { listAccounts, type Account } from "../lib/accounting";
import { getAllStockShared, type StockMap } from "../lib/stock";
import { getVertical, type Vertical } from "../lib/standalone";
import { currencySymbol } from "../lib/currency";
import { SearchCombobox, Pagination, pageSlice } from "./_adminUi";
import { exportToExcel, exportToPdf, type ExportColumn } from "../lib/exporters";
import { useDataRefresh, emitData } from "../lib/dataBus";
import { useHideZeros, blankIfZero, uiText, useUiLanguage, type UiLanguage } from "../lib/appSettings";

// ─── Excel-like grid: column defs, filtering, sorting, export ───────
type ColKey = "name" | "qty" | "barcode" | "code" | "price" | "vat" | "source";
type ColType = "text" | "number";
interface ColDef {
  key: ColKey;
  label: string;
  type: ColType;
  width: number;
  value: (it: LocalItem, s: StockMap) => string | number | null;
  text: (it: LocalItem, s: StockMap) => string;
}

const ITEM_COLS: ColDef[] = [
  { key: "name", label: "الاسم", type: "text", width: 240,
    value: (it) => it.nameAr,
    text: (it) => (it.nameEn ? `${it.nameAr} ${it.nameEn}` : it.nameAr) },
  { key: "qty", label: "الكمية المتاحة", type: "number", width: 130,
    value: (it, s) => s[it.id]?.qty ?? null,
    text: (it, s) => { const v = s[it.id]; return v ? String(v.qty) : "—"; } },
  { key: "barcode", label: "الباركود", type: "text", width: 160,
    value: (it) => it.barcode ?? "",
    text: (it) => it.barcode ?? "—" },
  { key: "code", label: "الكود", type: "text", width: 130,
    value: (it) => it.code ?? "",
    text: (it) => it.code ?? "—" },
  { key: "price", label: "السعر", type: "number", width: 110,
    value: (it) => it.salePrice,
    text: (it) => it.salePrice.toFixed(2) },
  { key: "vat", label: "الضريبة", type: "number", width: 95,
    value: (it) => it.vatRate,
    text: (it) => `${it.vatRate}%` },
  { key: "source", label: "المصدر", type: "text", width: 110,
    value: (it) => (it.cloudId ? "سحابي" : "محلي"),
    text: (it) => (it.cloudId ? "سحابي" : "محلي") },
];

type FilterOp = "contains" | "starts" | "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
interface AdvCond { id: number; field: ColKey; op: FilterOp; value: string; }

const OP_LABELS: Record<FilterOp, string> = {
  contains: "يحتوي", starts: "يبدأ بـ", eq: "يساوي", neq: "لا يساوي",
  gt: "أكبر من", gte: "أكبر أو يساوي", lt: "أصغر من", lte: "أصغر أو يساوي",
};
function opsForType(t: ColType): FilterOp[] {
  return t === "number" ? ["eq", "neq", "gt", "gte", "lt", "lte"] : ["contains", "starts", "eq", "neq"];
}
const OP_LABELS_EN: Record<FilterOp, string> = {
  contains: "Contains", starts: "Starts with", eq: "Equals", neq: "Does not equal",
  gt: "Greater than", gte: "Greater than or equal", lt: "Less than", lte: "Less than or equal",
};
const ITEM_COL_LABELS_EN: Record<ColKey, string> = {
  name: "Name", qty: "Available quantity", barcode: "Barcode", code: "Code",
  price: "Price", vat: "Tax", source: "Source",
};
function itemColLabel(col: ColDef, language: UiLanguage): string {
  return language === "en" ? ITEM_COL_LABELS_EN[col.key] : col.label;
}

/** Number column quick-filter: supports >, >=, <, <=, =, a-b range, else substring. */
function matchNumberExpr(val: number | null, expr: string): boolean {
  const e = expr.trim();
  if (!e) return true;
  if (val == null) return false;
  const range = e.match(/^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)$/);
  if (range) { const a = +range[1], b = +range[2]; return val >= Math.min(a, b) && val <= Math.max(a, b); }
  const m = e.match(/^(>=|<=|>|<|=)?\s*(-?\d+(?:\.\d+)?)$/);
  if (m) {
    const op = m[1] || "="; const n = +m[2];
    switch (op) { case ">": return val > n; case ">=": return val >= n; case "<": return val < n; case "<=": return val <= n; default: return val === n; }
  }
  return String(val).includes(e);
}

function matchColumnFilter(col: ColDef, it: LocalItem, s: StockMap, expr: string): boolean {
  if (col.type === "number") return matchNumberExpr(col.value(it, s) as number | null, expr);
  return col.text(it, s).toLowerCase().includes(expr.trim().toLowerCase());
}

function evalAdvCond(c: AdvCond, it: LocalItem, s: StockMap): boolean {
  const col = ITEM_COLS.find((x) => x.key === c.field);
  if (!col) return true;
  const v = c.value.trim();
  if (!v) return true;
  if (c.op === "contains") return col.text(it, s).toLowerCase().includes(v.toLowerCase());
  if (c.op === "starts") return col.text(it, s).toLowerCase().startsWith(v.toLowerCase());
  if (col.type === "number") {
    const raw = col.value(it, s) as number | null;
    const n = Number(v);
    if (raw == null || !Number.isFinite(n)) return false;
    switch (c.op) {
      case "eq": return raw === n;
      case "neq": return raw !== n;
      case "gt": return raw > n;
      case "gte": return raw >= n;
      case "lt": return raw < n;
      case "lte": return raw <= n;
      default: return true;
    }
  }
  const t = col.text(it, s).toLowerCase();
  const vv = v.toLowerCase();
  if (c.op === "eq") return t === vv;
  if (c.op === "neq") return t !== vv;
  return true;
}

function itemsToCsv(list: LocalItem[], s: StockMap, language: UiLanguage): string {
  const headers = language === "en"
    ? ["Name", "English name", "Available quantity", "Barcode", "Code", "Price", "Tax %", "Source"]
    : ["الاسم", "الاسم بالإنجليزية", "الكمية المتاحة", "الباركود", "الكود", "السعر", "الضريبة %", "المصدر"];
  const esc = (x: string) => (/[",\n\r]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x);
  const lines = [headers.map(esc).join(",")];
  for (const it of list) {
    const q = s[it.id];
    lines.push([
      it.nameAr ?? "",
      it.nameEn ?? "",
      q ? String(q.qty) : "",
      it.barcode ?? "",
      it.code ?? "",
      it.salePrice.toFixed(2),
      String(it.vatRate),
      it.cloudId ? uiText("سحابي", "Cloud", language) : uiText("محلي", "Local", language),
    ].map((c) => esc(String(c))).join(","));
  }
  return "\uFEFF" + lines.join("\r\n");
}

function downloadCsv(content: string, filename: string): void {
  void saveText(content, filename);
}

export default function ItemsAdmin() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [rows, setRows] = useState<LocalItem[]>([]);
  const [stockMap, setStockMap] = useState<StockMap>({});
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<LocalItem | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [vertical, setVertical] = useState<Vertical>("general");
  const [showEda, setShowEda] = useState(false);
  const [importingEda, setImportingEda] = useState(false);
  useEffect(() => { void getVertical().then((v) => v && setVertical(v)); }, []);
  const isPharmacy = vertical === "pharmacy";

  // ── Excel-like grid state (sort / per-column filters / advanced / widths) ──
  const [sort, setSort] = useState<{ key: ColKey; dir: "asc" | "desc" } | null>(null);
  const [columnFilters, setColumnFilters] = useState<Partial<Record<ColKey, string>>>({});
  const [showFilters, setShowFilters] = useState(false);
  const [conditions, setConditions] = useState<AdvCond[]>([]);
  const [logic, setLogic] = useState<"and" | "or">("and");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    const m: Record<string, number> = { actions: 150 };
    for (const c of ITEM_COLS) m[c.key] = c.width;
    return m;
  });
  const measureCanvas = useRef<HTMLCanvasElement | null>(null);
  const resizeState = useRef<{ key: string; startX: number; startW: number } | null>(null);

  // Click-to-edit from ExpiryReport — that page writes the item id into
  // sessionStorage and switches view; we read+consume it on mount so the
  // operator lands directly on the edit modal for the row they tapped.
  useEffect(() => {
    const id = sessionStorage.getItem("pos_desktop_items_jump_edit_id");
    if (!id) return;
    sessionStorage.removeItem("pos_desktop_items_jump_edit_id");
    const numId = Number(id);
    if (!Number.isFinite(numId)) return;
    void (async () => {
      const all = await listItems();
      const row = all.find((r) => r.id === numId);
      if (row) { setEditing(row); setShowForm(true); }
    })();
  }, []);

  /**
   * Pharmacy-only: fetch the bundled EDA catalog (public/catalogs/eda_pharmacy_2026.csv),
   * apply the chosen preset filter, then bulk-insert via insert_local_item.
   * Dedups by barcode so re-running any preset is safe.
   *
   * Presets (the bundled catalog has ~500 rows — a larger curated EDA dump
   * is a follow-up; "top sellers" approximates by lowest price under 50 EGP):
   *   - "all"    : every row
   *   - "top"    : the most affordable / commonly-dispensed ~150 rows
   *   - "otc"    : items where requiresPrescription is false (OTC only)
   */
  async function importEdaCatalog(preset: "all" | "top" | "otc" | "category", category?: string) {
    const label = preset === "all" ? text("الكامل", "Full catalog") : preset === "top" ? text("الأكثر مبيعًا", "Top sellers") : preset === "otc" ? text("اللي بدون روشتة", "Over-the-counter only") : `${text("فئة", "Category")} ${category}`;
    if (!confirm(text(`سيتم استيراد كتالوج EDA — ${label}. متابعة؟`, `Import EDA catalog — ${label}?`))) return;
    setImportingEda(true);
    try {
      const baseUrl = (import.meta as any).env?.BASE_URL ?? "/";
      const res = await fetch(`${baseUrl}catalogs/eda_pharmacy_2026.csv`);
      if (!res.ok) throw new Error(text(`فشل تحميل الكتالوج (${res.status})`, `Could not load catalog (${res.status}).`));
      const csvText = await res.text();
      const grid = parseCsv(csvText);
      if (grid.length < 2) throw new Error(text("الكتالوج فارغ", "The catalog is empty."));
      const header = grid[0].map((h) => h.trim().toLowerCase());
      const idx = (n: string) => header.indexOf(n);
      const cols = {
        code: idx("code"), ar: idx("namear"), en: idx("nameen"),
        bc: idx("barcode"), price: idx("saleprice"), vat: idx("vatrate"),
        ai: idx("activeingredient"), dform: idx("dosageform"),
        str: idx("strength"), mfr: idx("manufacturer"),
        rx: idx("requiresprescription"),
      };
      // CSV stores boolean as "0"/"1"; also accept "true"/"yes" for robustness.
      const truthy = (s: string) => { const v = s.trim().toLowerCase(); return v === "1" || v === "true" || v === "yes" || v === "y"; };
      let rows: CreateItemInput[] = [];
      for (let r = 1; r < grid.length; r++) {
        const row = grid[r];
        if (row.every((c) => !c.trim())) continue;
        const get = (i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");
        const nameAr = get(cols.ar);
        const price = Number(get(cols.price));
        if (!nameAr || !Number.isFinite(price) || price <= 0) continue;
        rows.push({
          code: get(cols.code) || null,
          nameAr,
          nameEn: get(cols.en) || null,
          barcode: get(cols.bc) || null,
          salePrice: price,
          vatRate: Number(get(cols.vat)) || 14,
          activeIngredient: get(cols.ai) || null,
          dosageForm: get(cols.dform) || null,
          strength: get(cols.str) || null,
          manufacturer: get(cols.mfr) || null,
          requiresPrescription: truthy(get(cols.rx)),
        });
      }
      if (preset === "top") {
        rows = [...rows].sort((a, b) => a.salePrice - b.salePrice).slice(0, 150);
      } else if (preset === "otc") {
        rows = rows.filter((r) => !r.requiresPrescription);
      } else if (preset === "category") {
        if (!category) throw new Error(text("لم يتم تحديد الفئة", "No category was selected."));
        rows = rows.filter((r) => (r.dosageForm ?? "").toLowerCase() === category.toLowerCase());
      }
      const { inserted, skippedDup } = await bulkImportLocalItems(rows, { dedupBy: "barcode" });
      setToast({ kind: "ok", text: language === "en" ? `Imported ${inserted} medicines${skippedDup ? ` — skipped ${skippedDup} duplicates` : ""}.` : `تم استيراد ${inserted} دواء${skippedDup ? ` — تم تجاهل ${skippedDup} مكرر` : ""}` });
      setShowEda(false);
      await refresh();
    } catch (e: any) {
      setToast({ kind: "err", text: e?.message ?? text("فشل استيراد كتالوج EDA", "Could not import EDA catalog.") });
    } finally {
      setImportingEda(false);
    }
  }

  async function refresh() {
    setLoading(true);
    try {
      const [items, stock] = await Promise.all([
        listItems(search || undefined),
        getAllStockShared(),
      ]);
      setRows(items);
      setStockMap(stock);
    }
    finally { setLoading(false); }
  }
  useEffect(() => { setPage(1); void refresh(); /* eslint-disable-next-line */ }, [search]);
  // Live-refresh when items or stock change anywhere (a sale/purchase/return/
  // adjustment on another keep-alive tab updates the on-hand qty column).
  useDataRefresh(["items", "stock"], refresh);

  const processed = useMemo(() => {
    let list = rows.slice();
    const fEntries = Object.entries(columnFilters).filter(([, v]) => (v ?? "").trim() !== "");
    if (fEntries.length) {
      list = list.filter((it) =>
        fEntries.every(([k, v]) => {
          const col = ITEM_COLS.find((c) => c.key === (k as ColKey));
          return col ? matchColumnFilter(col, it, stockMap, v as string) : true;
        }),
      );
    }
    const active = conditions.filter((c) => c.value.trim() !== "");
    if (active.length) {
      list = list.filter((it) => {
        const res = active.map((c) => evalAdvCond(c, it, stockMap));
        return logic === "and" ? res.every(Boolean) : res.some(Boolean);
      });
    }
    if (sort) {
      const col = ITEM_COLS.find((c) => c.key === sort.key);
      if (col) {
        list.sort((a, b) => {
          const va = col.value(a, stockMap);
          const vb = col.value(b, stockMap);
          if (va == null && vb == null) return 0;
          if (va == null) return 1;
          if (vb == null) return -1;
          const cmp = col.type === "number" ? (va as number) - (vb as number) : String(va).localeCompare(String(vb), "ar");
          return sort.dir === "asc" ? cmp : -cmp;
        });
      }
    }
    return list;
  }, [rows, stockMap, columnFilters, conditions, logic, sort]);

  const { start, end, page: clampedPage } = pageSlice(processed.length, page, pageSize);
  const pageRows = processed.slice(start, end);
  useEffect(() => { if (clampedPage !== page) setPage(clampedPage); }, [clampedPage, page]);
  useEffect(() => { setPage(1); }, [columnFilters, conditions, logic, sort]);

  const toggleSort = useCallback((key: ColKey) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  }, []);

  const onResizeMove = useCallback((e: MouseEvent) => {
    const r = resizeState.current;
    if (!r) return;
    const delta = r.startX - e.clientX;
    setColWidths((prev) => ({ ...prev, [r.key]: Math.max(60, Math.min(700, r.startW + delta)) }));
  }, []);
  const onResizeEnd = useCallback(() => {
    resizeState.current = null;
    window.removeEventListener("mousemove", onResizeMove);
    window.removeEventListener("mouseup", onResizeEnd);
    document.body.style.cursor = "";
  }, [onResizeMove]);
  const onResizeStart = useCallback((e: React.MouseEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    resizeState.current = { key, startX: e.clientX, startW: colWidths[key] ?? 120 };
    window.addEventListener("mousemove", onResizeMove);
    window.addEventListener("mouseup", onResizeEnd);
    document.body.style.cursor = "col-resize";
  }, [colWidths, onResizeMove, onResizeEnd]);

  // Always tear down drag listeners on unmount — a mid-drag navigation away
  // would otherwise leak global mousemove/mouseup handlers and leave the
  // body cursor stuck on "col-resize".
  useEffect(() => () => {
    window.removeEventListener("mousemove", onResizeMove);
    window.removeEventListener("mouseup", onResizeEnd);
    document.body.style.cursor = "";
  }, [onResizeMove, onResizeEnd]);

  const autoFit = useCallback((key: ColKey) => {
    const col = ITEM_COLS.find((c) => c.key === key);
    if (!col) return;
    if (!measureCanvas.current) measureCanvas.current = document.createElement("canvas");
    const ctx = measureCanvas.current.getContext("2d");
    if (!ctx) return;
    ctx.font = "600 13px system-ui, -apple-system, sans-serif";
    let max = ctx.measureText(itemColLabel(col, language)).width + 28;
    ctx.font = "14px system-ui, -apple-system, sans-serif";
    for (const it of processed) {
      const w = ctx.measureText(col.text(it, stockMap)).width;
      if (w > max) max = w;
    }
    setColWidths((prev) => ({ ...prev, [key]: Math.max(60, Math.min(700, Math.ceil(max) + 32)) }));
  }, [processed, stockMap, language]);

  const hasActiveView = !!sort
    || Object.values(columnFilters).some((v) => (v ?? "").trim() !== "")
    || conditions.some((c) => c.value.trim() !== "");
  function clearAllViews() {
    setSort(null);
    setColumnFilters({});
    setConditions([]);
    setLogic("and");
  }
  function exportCsv() {
    const csv = itemsToCsv(processed, stockMap, language);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(csv, `items_${stamp}.csv`);
    setToast({ kind: "ok", text: text(`تم تصدير ${processed.length} صنف إلى ملف Excel/CSV`, `Exported ${processed.length} items to Excel/CSV.`) });
  }
  const exportColumns: ExportColumn<LocalItem>[] = [
    { header: text("الاسم", "Name"), cell: (it) => it.nameAr ?? "" },
    { header: text("الاسم بالإنجليزية", "English name"), cell: (it) => it.nameEn ?? "" },
    { header: text("الكمية المتاحة", "Available quantity"), cell: (it) => stockMap[it.id]?.qty ?? 0 },
    { header: text("الباركود", "Barcode"), cell: (it) => it.barcode ?? "" },
    { header: text("الكود", "Code"), cell: (it) => it.code ?? "" },
    { header: text("السعر", "Price"), cell: (it) => it.salePrice },
    { header: text("الضريبة %", "Tax %"), cell: (it) => it.vatRate },
    { header: text("المصدر", "Source"), cell: (it) => (it.cloudId ? text("سحابي", "Cloud") : text("محلي", "Local")) },
  ];
  function exportExcel() {
    exportToExcel("items", exportColumns, processed);
  }
  function exportPdf() {
    exportToPdf(text("قائمة الأصناف", "Item list"), exportColumns, processed);
  }

  async function handleDelete(it: LocalItem) {
    if (!confirm(`${text("حذف الصنف", "Delete item")} «${it.nameAr}»?`)) return;
    try { await deleteItem(it.id); dropItemBrands(it.id); emitData("items"); setToast({ kind: "ok", text: text("تم الحذف", "Item deleted.") }); await refresh(); }
    catch (e: any) { setToast({ kind: "err", text: e?.message ?? text("فشل الحذف", "Could not delete item.") }); }
  }

  return (
    <div dir={language === "en" ? "ltr" : "rtl"} style={S.wrap}>
      <div style={S.headerRow}>
        <div>
          <h2 style={S.h2}>{text("الأصناف", "Items")} ({rows.length})</h2>
          <div style={S.sub}>{text("إدارة قائمة الأصناف وأسعار البيع — السحب من السحابة يُحدّث القائمة تلقائيًا", "Manage item catalog and sales prices. Cloud pulls refresh the list automatically.")}</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {isPharmacy && (
            <button onClick={() => setShowEda(true)} disabled={importingEda} style={S.btnEda}>
              {importingEda ? text("... جاري الاستيراد", "Importing…") : `💊 ${text("استيراد كتالوج EDA", "Import EDA catalog")}`}
            </button>
          )}
          <button onClick={() => setShowImport(true)} style={S.btnImport}>
            📥 {text("استيراد من CSV", "Import CSV")}
          </button>
          <button onClick={() => { setEditing(null); setShowForm(true); }} disabled={showForm}
            style={{ ...S.btnPrimary, opacity: showForm ? 0.5 : 1, cursor: showForm ? "not-allowed" : "pointer" }}>
            + {text("صنف جديد", "New item")}
          </button>
        </div>
      </div>

      {/* ── Toolbar: quick search + Excel-like toggles + export ── */}
      <div style={S.toolbar}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={text("بحث سريع بالاسم أو الكود أو الباركود...", "Search by name, code, or barcode…")}
          style={{ ...S.search, marginBottom: 0, flex: 1, minWidth: 220 }}
        />
        <button onClick={() => setShowFilters((v) => !v)} style={showFilters ? S.btnToolActive : S.btnTool} title={text("إظهار صف فلتر تحت كل عمود", "Show a filter row under each column")}>
          ⛃ {text("فلاتر الأعمدة", "Column filters")}
        </button>
        <button onClick={() => setShowAdvanced((v) => !v)} style={showAdvanced ? S.btnToolActive : S.btnTool} title={text("بحث متقدم بأكثر من شرط", "Advanced search with multiple conditions")}>
          🔍 {text("بحث متقدم", "Advanced search")}
        </button>
        <button onClick={exportCsv} style={S.btnTool} title={text("تصدير القائمة المفلترة إلى CSV", "Export filtered items to CSV")}>
          📊 CSV
        </button>
        <button onClick={exportExcel} style={S.btnTool} title={text("تصدير القائمة المفلترة إلى ملف إكسل", "Export filtered items to Excel")}>
          ⬇️ {text("إكسل", "Excel")}
        </button>
        <button onClick={exportPdf} style={S.btnTool} title={text("تصدير / طباعة PDF", "Export / print PDF")}>
          🖨️ PDF
        </button>
        {hasActiveView && (
          <button onClick={clearAllViews} style={S.btnClear} title={text("إلغاء كل الفلاتر والترتيب", "Clear all filters and sorting")}>
            🧹 {text("مسح الكل", "Clear all")}
          </button>
        )}
      </div>

      <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>
        {text("عدد النتائج:", "Results:")} {processed.length}{processed.length !== rows.length ? ` ${text("من أصل", "of")} ${rows.length}` : ""}
      </div>

      {/* ── Advanced multi-condition search ── */}
      {showAdvanced && (
        <div style={S.advPanel}>
          <div style={S.advHeader}>
            <strong style={{ fontSize: 14, color: "#0f172a" }}>🔍 {text("بحث متقدم", "Advanced search")}</strong>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <span style={{ color: "#64748b" }}>{text("دمج الشروط:", "Combine conditions:")}</span>
              <button onClick={() => setLogic("and")} style={logic === "and" ? S.logicActive : S.logicBtn}>{text("تحقّق الكل (و)", "Match all (AND)")}</button>
              <button onClick={() => setLogic("or")} style={logic === "or" ? S.logicActive : S.logicBtn}>{text("تحقّق أي (أو)", "Match any (OR)")}</button>
            </div>
          </div>
          {conditions.length === 0 && (
            <div style={{ fontSize: 13, color: "#94a3b8", padding: "6px 0" }}>
              {text("لا توجد شروط — اضغط «➕ إضافة شرط». مثال: السعر «أكبر من» 30 و الكمية المتاحة «أصغر من» 5.", "No conditions — select “Add condition”. Example: price greater than 30 and available quantity less than 5.")}
            </div>
          )}
          {conditions.map((c) => {
            const col = ITEM_COLS.find((x) => x.key === c.field)!;
            const ops = opsForType(col.type);
            return (
              <div key={c.id} style={S.condRow}>
                <select
                  value={c.field}
                  onChange={(e) => {
                    const field = e.target.value as ColKey;
                    const nextCol = ITEM_COLS.find((x) => x.key === field)!;
                    const validOps = opsForType(nextCol.type);
                    setConditions((prev) => prev.map((p) => (p.id === c.id ? { ...p, field, op: validOps.includes(p.op) ? p.op : validOps[0] } : p)));
                  }}
                  style={S.condSelect}
                >
                  {ITEM_COLS.map((x) => <option key={x.key} value={x.key}>{itemColLabel(x, language)}</option>)}
                </select>
                <select
                  value={c.op}
                  onChange={(e) => { const op = e.target.value as FilterOp; setConditions((prev) => prev.map((p) => (p.id === c.id ? { ...p, op } : p))); }}
                  style={S.condSelect}
                >
                  {ops.map((o) => <option key={o} value={o}>{text(OP_LABELS[o], OP_LABELS_EN[o])}</option>)}
                </select>
                <input
                  value={c.value}
                  type={col.type === "number" ? "number" : "text"}
                  onChange={(e) => { const value = e.target.value; setConditions((prev) => prev.map((p) => (p.id === c.id ? { ...p, value } : p))); }}
                  placeholder={text("القيمة", "Value")}
                  style={S.condInput}
                />
                <button onClick={() => setConditions((prev) => prev.filter((p) => p.id !== c.id))} style={S.condDel} title={text("حذف الشرط", "Remove condition")}>🗑</button>
              </div>
            );
          })}
          <button onClick={() => setConditions((prev) => [...prev, { id: Date.now() + prev.length, field: "name", op: "contains", value: "" }])} style={S.btnAddCond}>
            ➕ {text("إضافة شرط", "Add condition")}
          </button>
        </div>
      )}

      {toast && <div style={toast.kind === "ok" ? S.ok : S.err}>{toast.text}</div>}

      {showForm && (
        <ItemForm
          initial={editing}
          isPharmacy={isPharmacy}
          canRetailVariants={vertical === "retail"}
          onClose={() => setShowForm(false)}
          onSaved={async (msg) => { setShowForm(false); setToast({ kind: "ok", text: msg }); await refresh(); }}
        />
      )}

      {loading ? <div style={S.empty}>{text("... جاري التحميل", "Loading…")}</div>
      : rows.length === 0 ? <div style={S.empty}>{text("لا توجد أصناف — أضف صنف جديد أو اسحب من السحابة", "No items yet — add an item or sync from the cloud.")}</div>
      : processed.length === 0 ? <div style={S.empty}>{text("لا توجد نتائج مطابقة — جرّب تعديل الفلاتر أو «🧹 مسح الكل»", "No matching results — adjust filters or select “Clear all”.")}</div>
      : (
        <div style={{ overflowX: "auto", border: "1px solid #e2e8f0", borderRadius: 8, background: "#fff" }}>
          <style>{`
            .z-items-grid { border-collapse: collapse; color: #233044; }
            .z-items-grid thead th { border-bottom: 1px solid #d9e0e8 !important; border-inline-start: 1px solid #e3e8ee; background: #f2f5f8 !important; color: #44536a !important; }
            .z-items-grid tbody td { border-bottom: 1px solid #e7ebf0; border-inline-start: 1px solid #edf0f3; }
            .z-items-grid tbody tr:nth-child(even) { background: #f8fafc; }
            .z-items-grid tbody tr:hover { background: #eef4f8; }
            @media (max-width: 900px) {
              .z-items-grid thead th, .z-items-grid tbody td { padding: 7px 9px !important; font-size: 12px !important; }
            }
          `}</style>
          <table className="z-items-grid" style={S.tableFixed}>
            <colgroup>
              {ITEM_COLS.map((c) => <col key={c.key} style={{ width: colWidths[c.key] }} />)}
              <col style={{ width: colWidths.actions }} />
            </colgroup>
            <thead>
              <tr>
                {ITEM_COLS.map((c) => {
                  const active = sort?.key === c.key;
                  return (
                    <th key={c.key} style={{ ...S.thSort, textAlign: language === "en" ? "left" : "right" }} onClick={() => toggleSort(c.key)} title={text("اضغط للترتيب تصاعدي/تنازلي", "Click to sort ascending or descending")}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        {itemColLabel(c, language)}
                        <span style={S.sortArrow}>{active ? (sort!.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
                      </span>
                      <span
                        onMouseDown={(e) => onResizeStart(e, c.key)}
                        onDoubleClick={(e) => { e.stopPropagation(); autoFit(c.key); }}
                        onClick={(e) => e.stopPropagation()}
                        style={S.resizeHandle}
                        title={text("اسحب لتغيير العرض — دبل كليك للضبط التلقائي", "Drag to resize; double-click to auto-fit")}
                      />
                    </th>
                  );
                })}
                <th style={{ ...S.thRight, textAlign: language === "en" ? "right" : "left" }}>{text("إجراء", "Actions")}</th>
              </tr>
              {showFilters && (
                <tr>
                  {ITEM_COLS.map((c) => (
                    <th key={c.key} style={S.thFilter}>
                      {c.key === "source" ? (
                        <select value={columnFilters[c.key] ?? ""} onChange={(e) => setColumnFilters((prev) => ({ ...prev, [c.key]: e.target.value }))} style={S.filterInput}>
                          <option value="">{text("الكل", "All")}</option>
                          <option value="سحابي">{text("سحابي", "Cloud")}</option>
                          <option value="محلي">{text("محلي", "Local")}</option>
                        </select>
                      ) : (
                        <input
                          value={columnFilters[c.key] ?? ""}
                          onChange={(e) => setColumnFilters((prev) => ({ ...prev, [c.key]: e.target.value }))}
                          placeholder={c.type === "number" ? text("مثال: >30 أو 10-20", "e.g. >30 or 10-20") : text("بحث...", "Search…")}
                          style={S.filterInput}
                        />
                      )}
                    </th>
                  ))}
                  <th style={S.thFilter} />
                </tr>
              )}
            </thead>
            <tbody>
              {pageRows.map((it) => (
                <tr
                  key={it.id}
                  style={{ ...S.tr, cursor: showForm ? "default" : "pointer" }}
                  onClick={(e) => {
                    if (showForm) return;
                    // Don't hijack clicks on interactive cell children (buttons,
                    // future inputs/links) — only a click on the row body edits.
                    if ((e.target as HTMLElement).closest('button,input,select,textarea,a,[role="button"]')) return;
                    setEditing(it);
                    setShowForm(true);
                  }}
                  title={showForm ? text("أغلق النموذج الحالي أولاً", "Close the current form first") : text("اضغط على السطر للتعديل", "Click the row to edit")}
                >
                  <td style={S.tdClip}>
                    <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {it.nameAr}
                      {it.units && it.units.length > 0 && (
                        <span style={S.badgeUnits} title={it.units.map((u) => `${u.name} (${u.factor})`).join("، ")}>
                          📦 {it.units.length} {text("وحدة", "units")}
                        </span>
                      )}
                    </div>
                    {it.nameEn && <div style={{ ...S.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.nameEn}</div>}
                  </td>
                  <td style={S.td}>{renderQty(stockMap[it.id], language)}</td>
                  <td style={S.tdMonoClip}>{it.barcode ?? "—"}</td>
                  <td style={S.tdMonoClip}>{it.code ?? "—"}</td>
                  <td style={S.td}><strong>{it.salePrice.toFixed(2)}</strong> {currencySymbol()}</td>
                  <td style={S.td}>{it.vatRate}%</td>
                  <td style={S.td}>
                    <span style={it.cloudId ? S.badgeCloud : S.badgeLocal}>
                      {it.cloudId ? `☁️ #${it.cloudId}` : `📱 ${text("محلي", "Local")}`}
                    </span>
                  </td>
                  <td style={S.tdRight} onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => { setEditing(it); setShowForm(true); }} disabled={showForm} style={{ ...S.btnEdit, opacity: showForm ? 0.5 : 1, cursor: showForm ? "not-allowed" : "pointer" }}>{text("تعديل", "Edit")}</button>
                    <button onClick={() => handleDelete(it)} disabled={showForm} style={{ ...S.btnDel, opacity: showForm ? 0.5 : 1, cursor: showForm ? "not-allowed" : "pointer" }}>{text("حذف", "Delete")}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && processed.length > 0 && (
        <Pagination total={processed.length} page={page} pageSize={pageSize}
          onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }} />
      )}

      {showEda && (
        <EdaImportModal
          importing={importingEda}
          onClose={() => setShowEda(false)}
          onImport={(preset, category) => void importEdaCatalog(preset, category)}
        />
      )}

      {showImport && (
        <ImportCsvModal
          existingBarcodes={new Set(rows.map((r) => r.barcode).filter((b): b is string => !!b))}
          existingCodes={new Set(rows.map((r) => r.code).filter((c): c is string => !!c))}
          onClose={() => setShowImport(false)}
          onDone={async (msg) => { setShowImport(false); setToast({ kind: "ok", text: msg }); await refresh(); }}
        />
      )}
    </div>
  );
}

// ─── CSV Import ────────────────────────────────────────────────────
type ParsedRow = {
  rowNum: number;
  code: string;
  nameAr: string;
  nameEn: string;
  barcode: string;
  salePrice: number;
  vatRate: number;
  error?: string;
};

/** Tiny CSV parser: handles UTF-8 BOM, quoted cells, escaped quotes, \r\n. */
function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(cell); cell = ""; i++; continue; }
    if (c === '\n' || c === '\r') {
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") out.push(row);
      row = [];
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++; continue;
    }
    cell += c; i++;
  }
  if (cell !== "" || row.length) { row.push(cell); out.push(row); }
  return out;
}

/**
 * EDA catalog import modal — 4 presets:
 *   - all      : every row in the bundled CSV
 *   - top      : the 150 cheapest rows (proxy for fast-movers)
 *   - otc      : rows where requiresPrescription is false
 *   - category : filter by dosageForm. Distinct values are loaded from the
 *                bundled CSV on demand so the picker stays in sync with the
 *                catalog file without hard-coding categories here.
 */
function EdaImportModal({
  importing, onClose, onImport,
}: {
  importing: boolean;
  onClose: () => void;
  onImport: (preset: "all" | "top" | "otc" | "category", category?: string) => void;
}) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [showCategoryPicker, setShowCategoryPicker] = useState(false);
  const [categories, setCategories] = useState<{ name: string; count: number }[] | null>(null);
  const [catErr, setCatErr] = useState<string | null>(null);
  const [loadingCats, setLoadingCats] = useState(false);

  async function loadCategories() {
    setLoadingCats(true); setCatErr(null);
    try {
      const baseUrl = (import.meta as any).env?.BASE_URL ?? "/";
      const res = await fetch(`${baseUrl}catalogs/eda_pharmacy_2026.csv`);
      if (!res.ok) throw new Error(text(`فشل تحميل الكتالوج (${res.status})`, `Could not load catalog (${res.status}).`));
      const csvText = await res.text();
      const grid = parseCsv(csvText);
      if (grid.length < 2) throw new Error(text("الكتالوج فاضي", "The catalog is empty."));
      const header = grid[0].map((h) => h.trim().toLowerCase());
      const iDf = header.indexOf("dosageform");
      if (iDf < 0) throw new Error(text("عمود dosageForm غير موجود في الكتالوج", "The catalog is missing the dosageForm column."));
      const counts = new Map<string, number>();
      for (let i = 1; i < grid.length; i++) {
        const v = (grid[i][iDf] ?? "").trim();
        if (!v) continue;
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      const arr = Array.from(counts.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
      setCategories(arr);
      setShowCategoryPicker(true);
    } catch (e) {
      setCatErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingCats(false);
    }
  }

  return (
    <div style={S.modalBg} onClick={() => !importing && onClose()}>
      <div style={{ ...S.modal, maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0, color: "#86198f" }}>💊 {text("استيراد كتالوج EDA", "Import EDA catalog")}</h3>
        {!showCategoryPicker ? (
          <>
            <p style={{ fontSize: 13, color: "#475569" }}>{text("اختر النطاق المناسب — التكرارات هتتجاهل تلقائيًا حسب الباركود.", "Choose a scope. Duplicate barcodes will be skipped automatically.")}</p>
            <div style={{ display: "grid", gap: 10 }}>
              <button disabled={importing} onClick={() => onImport("all")} style={S.btnPrimary}>
                📦 {text("كل الأدوية", "All medicines")} (~500 {text("صنف", "items")})
              </button>
              <button disabled={importing} onClick={() => onImport("top")} style={S.btnEda}>
                ⭐ {text("الأكثر مبيعًا", "Top sellers")} (~150 {text("صنف بأسعار اقتصادية", "budget-priced items")})
              </button>
              <button disabled={importing} onClick={() => onImport("otc")} style={S.btnEda}>
                💊 {text("بدون روشتة فقط", "Over-the-counter only")} (OTC)
              </button>
              <button disabled={importing || loadingCats} onClick={() => void loadCategories()} style={S.btnEda}>
                {loadingCats ? text("... جاري قراءة الفئات", "Loading categories…") : `🏷️ ${text("حسب الفئة (شكل الجرعة)", "By category (dosage form)")}`}
              </button>
              {catErr && <div style={{ color: "#dc2626", fontSize: 12 }}>{catErr}</div>}
              <button disabled={importing} onClick={onClose} style={S.btnGhost}>{text("إلغاء", "Cancel")}</button>
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, color: "#475569" }}>{text("اختر الفئة المراد استيرادها — الرقم بين قوسين عدد الأصناف.", "Choose a category to import. The number in parentheses is the item count.")}</p>
            <div style={{ display: "grid", gap: 6, maxHeight: 360, overflowY: "auto", padding: 4 }}>
              {(categories ?? []).map((c) => (
                <button
                  key={c.name}
                  disabled={importing}
                  onClick={() => onImport("category", c.name)}
                  style={{ ...S.btnEda, textAlign: "start", display: "flex", justifyContent: "space-between" }}
                >
                  <span>{c.name}</span>
                  <span style={{ color: "#64748b", fontWeight: 400 }}>({c.count})</span>
                </button>
              ))}
              {categories?.length === 0 && (
                <div style={{ color: "#64748b", fontSize: 13, textAlign: "center" }}>{text("لا توجد فئات معرّفة في الكتالوج", "No categories are defined in the catalog.")}</div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button disabled={importing} onClick={() => setShowCategoryPicker(false)} style={{ ...S.btnGhost, flex: 1 }}>← {text("رجوع", "Back")}</button>
              <button disabled={importing} onClick={onClose} style={{ ...S.btnGhost, flex: 1 }}>{text("إلغاء", "Cancel")}</button>
            </div>
          </>
        )}
        {importing && <div style={{ marginTop: 12, fontSize: 13, color: "#64748b", textAlign: "center" }}>{text("... جاري الاستيراد، لا تغلق النافذة", "Importing… Do not close this window.")}</div>}
      </div>
    </div>
  );
}

function ImportCsvModal({
  existingBarcodes, existingCodes, onClose, onDone,
}: {
  existingBarcodes: Set<string>;
  existingCodes: Set<string>;
  onClose: () => void;
  onDone: (msg: string) => Promise<void> | void;
}) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string>("");
  const [parsed, setParsed] = useState<ParsedRow[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [defaultVat, setDefaultVat] = useState<number>(15);
  const [skipDupes, setSkipDupes] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  async function onFile(f: File) {
    setError(null); setParsed(null); setFileName(f.name);
    try {
      const csvText = await f.text();
      const grid = parseCsv(csvText);
      if (grid.length < 2) { setError(text("الملف فاضي أو ما فيش صفوف بيانات", "The file is empty or has no data rows.")); return; }
      const header = grid[0].map((h) => h.trim().toLowerCase());
      const idx = (name: string) => header.indexOf(name);
      const iCode = idx("code");
      const iAr = idx("namear");
      const iEn = idx("nameen");
      const iBc = idx("barcode");
      const iPr = idx("saleprice");
      const iVat = idx("vatrate");
      if (iAr < 0 || iPr < 0) {
        setError(text("الأعمدة المطلوبة: nameAr و salePrice على الأقل (الترويسة الأولى).", "Required columns: at least nameAr and salePrice in the first row."));
        return;
      }
      const out: ParsedRow[] = [];
      for (let r = 1; r < grid.length; r++) {
        const row = grid[r];
        if (row.every((c) => !c.trim())) continue;
        const get = (i: number) => (i >= 0 && row[i] !== undefined ? row[i].trim() : "");
        const nameAr = get(iAr);
        const priceStr = get(iPr);
        const price = Number(priceStr);
        const vatStr = get(iVat);
        const vat = vatStr === "" ? defaultVat : Number(vatStr);
        const parsedRow: ParsedRow = {
          rowNum: r + 1,
          code: get(iCode),
          nameAr,
          nameEn: get(iEn),
          barcode: get(iBc),
          salePrice: price,
          vatRate: vat,
        };
        if (!nameAr) parsedRow.error = text("الاسم بالعربية فاضي", "Arabic name is blank.");
        else if (!Number.isFinite(price) || price <= 0) parsedRow.error = text("السعر غير صالح", "Invalid price.");
        else if (!Number.isFinite(vat) || vat < 0 || vat > 100) parsedRow.error = text("الضريبة غير صالحة", "Invalid tax rate.");
        out.push(parsedRow);
      }
      setParsed(out);
    } catch (e: any) {
      setError(e?.message ?? text("تعذّر قراءة الملف", "Could not read file."));
    }
  }

  async function doImport() {
    if (!parsed) return;
    setImporting(true); setError(null);
    const valid = parsed.filter((r) => !r.error);
    const toCreate: ParsedRow[] = [];
    const skippedDup: ParsedRow[] = [];
    const seenBc = new Set<string>();
    const seenCode = new Set<string>();
    for (const r of valid) {
      if (skipDupes) {
        if (r.barcode && (existingBarcodes.has(r.barcode) || seenBc.has(r.barcode))) {
          skippedDup.push(r); continue;
        }
        if (r.code && (existingCodes.has(r.code) || seenCode.has(r.code))) {
          skippedDup.push(r); continue;
        }
      }
      if (r.barcode) seenBc.add(r.barcode);
      if (r.code) seenCode.add(r.code);
      toCreate.push(r);
    }
    setProgress({ done: 0, total: toCreate.length });
    let created = 0;
    let failed = 0;
    for (let i = 0; i < toCreate.length; i++) {
      const r = toCreate[i];
      try {
        const input: CreateItemInput = {
          code: r.code || null,
          nameAr: r.nameAr,
          nameEn: r.nameEn || null,
          barcode: r.barcode || null,
          salePrice: r.salePrice,
          vatRate: r.vatRate,
        };
        await createItem(input);
        created++;
      } catch {
        failed++;
      }
      if (i % 25 === 0 || i === toCreate.length - 1) {
        setProgress({ done: i + 1, total: toCreate.length });
        await new Promise((res) => setTimeout(res, 0));
      }
    }
    setImporting(false);
    if (created > 0) emitData("items");
    const parts = language === "en" ? [`Imported ${created} items`] : [`تم استيراد ${created} صنف`];
    if (skippedDup.length) parts.push(language === "en" ? `Skipped ${skippedDup.length} duplicates` : `تم تجاهل ${skippedDup.length} مكرر`);
    if (failed) parts.push(language === "en" ? `Failed ${failed}` : `فشل ${failed}`);
    await onDone(parts.join(" — "));
  }

  const validCount = parsed?.filter((r) => !r.error).length ?? 0;
  const errorCount = parsed?.filter((r) => r.error).length ?? 0;
  const previewBad = parsed?.filter((r) => r.error).slice(0, 5) ?? [];

  return (
    <div style={S.modalBg} onClick={onClose}>
      <div style={{ ...S.modal, maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={S.modalTitle}>📥 {text("استيراد أصناف من ملف CSV", "Import items from CSV")}</h3>

        <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 12, fontSize: 13, color: "#475569", marginBottom: 12, lineHeight: 1.7 }}>
          <strong>{text("الأعمدة المطلوبة:", "Columns:")}</strong> <code>code, nameAr, nameEn, barcode, salePrice, vatRate</code>
          <br />
          <strong>{text("إلزامي:", "Required:")}</strong> nameAr + salePrice. <strong>{text("اختياري:", "Optional:")}</strong> {text("الباقي.", "all others.")}
          <br />
          {text("الترميز: UTF-8 (مدعوم BOM للفتح من Excel).", "Encoding: UTF-8 (Excel BOM supported).")}
        </div>

        {!parsed && (
          <>
            <button onClick={() => fileRef.current?.click()} style={{ ...S.btnPrimary, width: "100%", padding: "16px" }}>
              {text("اختر ملف CSV...", "Choose CSV file…")}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }}
            />
          </>
        )}

        {fileName && <div style={{ fontSize: 13, color: "#64748b", marginTop: 8 }}>📄 {fileName}</div>}
        {error && <div style={S.err}>{error}</div>}

        {parsed && !importing && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, margin: "12px 0" }}>
              <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", padding: 12, borderRadius: 8 }}>
                <div style={{ fontSize: 12, color: "#166534" }}>{text("صالح للاستيراد", "Ready to import")}</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: "#166534" }}>{validCount}</div>
              </div>
              <div style={{ background: errorCount ? "#fef2f2" : "#f8fafc", border: `1px solid ${errorCount ? "#fecaca" : "#e2e8f0"}`, padding: 12, borderRadius: 8 }}>
                <div style={{ fontSize: 12, color: errorCount ? "#991b1b" : "#64748b" }}>{text("صفوف بها أخطاء", "Rows with errors")}</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: errorCount ? "#991b1b" : "#64748b" }}>{errorCount}</div>
              </div>
            </div>

            {previewBad.length > 0 && (
              <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: 10, marginBottom: 12, fontSize: 12, color: "#991b1b" }}>
                <strong>{text("أمثلة على الأخطاء:", "Error examples:")}</strong>
                {previewBad.map((r) => (
                  <div key={r.rowNum}>{text("صف", "Row")} {r.rowNum}: {r.error}</div>
                ))}
              </div>
            )}

            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 13 }}>
              <input type="checkbox" checked={skipDupes} onChange={(e) => setSkipDupes(e.target.checked)} />
              {text("تجاهل الأصناف المكررة (نفس الباركود أو الكود)", "Skip duplicate items (same barcode or code)")}
            </label>

            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, fontSize: 13 }}>
              <span>{text("الضريبة الافتراضية لو الخانة فاضية:", "Default tax when blank:")}</span>
              <input type="number" min={0} max={100} step={1} value={defaultVat} onChange={(e) => setDefaultVat(Number(e.target.value))} style={{ ...S.input, width: 80 }} />
              <span>%</span>
            </div>

            <div style={S.btnRow}>
              <button onClick={doImport} disabled={validCount === 0} style={S.btnPrimary}>
                ✅ {text("استيراد", "Import")} {validCount} {text("صنف", "items")}
              </button>
              <button onClick={() => { setParsed(null); setFileName(""); }} style={S.btnGhost}>
                {text("اختيار ملف آخر", "Choose another file")}
              </button>
              <button onClick={onClose} style={S.btnGhost}>{text("إلغاء", "Cancel")}</button>
            </div>
          </>
        )}

        {importing && progress && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 14, marginBottom: 8 }}>
              {text("جاري الاستيراد...", "Importing…")} {progress.done} / {progress.total}
            </div>
            <div style={{ background: "#e2e8f0", borderRadius: 999, overflow: "hidden", height: 10 }}>
              <div style={{ background: "#2563eb", height: "100%", width: `${(progress.done / Math.max(1, progress.total)) * 100}%`, transition: "width .15s" }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ItemForm({ initial, isPharmacy, canRetailVariants, onClose, onSaved }: {
  initial: LocalItem | null;
  isPharmacy: boolean;
  canRetailVariants: boolean;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const uoms = listUom();
  const itemGroups = listItemGroups();
  const hideZeros = useHideZeros();
  const [form, setForm] = useState<CreateItemInput>({
    code: initial?.code ?? "",
    nameAr: initial?.nameAr ?? "",
    nameEn: initial?.nameEn ?? "",
    barcode: initial?.barcode ?? "",
    costPrice: initial?.costPrice ?? 0,
    salePrice: initial?.salePrice ?? 0,
    vatRate: initial?.vatRate ?? (isPharmacy ? 14 : 0),
    uomId: initial?.uomId ?? getDefaultUom()?.id ?? null,
    groupId: initial?.groupId ?? null,
    nature: initial?.nature ?? "stock",
    itemType: initial?.itemType ?? "finished",
    // Pharmacy extension — only sent on submit when isPharmacy is true.
    activeIngredient: initial?.activeIngredient ?? "",
    dosageForm: initial?.dosageForm ?? "",
    strength: initial?.strength ?? "",
    manufacturer: initial?.manufacturer ?? "",
    requiresPrescription: initial?.requiresPrescription ?? false,
    controlled: initial?.controlled ?? false,
    expiryDate: initial?.expiryDate ?? "",
    batchNo: initial?.batchNo ?? "",
    // Scale (Task #201)
    isWeighed: initial?.isWeighed ?? false,
    pricePerKg: initial?.pricePerKg ?? 0,
    plu: initial?.plu ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"basic" | "pricing" | "units" | "accounts" | "inventory" | "restaurant-modifiers" | "additional" | "usage" | "notes" | "retail">("basic");
  const [profile, setProfile] = useState<ItemWebProfile>(() => {
    const saved = initial?.metadata ?? {};
    const oldNature = initial?.itemType;
    const businessNature = saved.businessNature
      ?? (oldNature === "raw" || oldNature === "semi" || oldNature === "finished" ? oldNature : "merchandise");
    return {
      businessType: saved.businessType ?? (initial?.nature === "service" ? "service" : "stock"),
      businessNature,
      subgroupName: saved.subgroupName ?? "",
      posGroupName: saved.posGroupName ?? "",
      posSubgroupName: saved.posSubgroupName ?? "",
      reorderLevel: saved.reorderLevel ?? 0,
      maxLevel: saved.maxLevel ?? null,
      costMethod: saved.costMethod ?? "weighted_avg",
      discountType: saved.discountType ?? "none",
      discountValue: saved.discountValue ?? 0,
      status: saved.status ?? "active",
      costAccountId: saved.costAccountId ?? null,
      revenueAccountId: saved.revenueAccountId ?? null,
      description: saved.description ?? "",
      imageUrl: saved.imageUrl ?? "",
      tags: saved.tags ?? "",
      isBundle: saved.isBundle ?? false,
      showInPos: saved.showInPos ?? true,
      batchTrackingMode: saved.batchTrackingMode ?? "none",
      salePriceOptions: saved.salePriceOptions ?? [],
      restaurantModifierGroups: saved.restaurantModifierGroups ?? [],
      usageControls: saved.usageControls ?? [],
      retailEnabled: saved.retailEnabled ?? false,
      retailCategory: saved.retailCategory ?? "apparel",
      retailColor: saved.retailColor ?? "",
      retailSize: saved.retailSize ?? "",
      auditHistory: saved.auditHistory ?? [],
    };
  });
  const [showQr, setShowQr] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [availableItems, setAvailableItems] = useState<LocalItem[]>([]);
  const [usageModes, setUsageModes] = useState<Record<string, { mode: ItemUsageMode; reason: string }>>(
    () => Object.fromEntries((initial?.metadata?.usageControls ?? []).map((rule) => [rule.screenKey, { mode: rule.mode, reason: rule.reason ?? "" }])),
  );
  useEffect(() => {
    let active = true;
    Promise.all([listAccounts(), listItems()])
      .then(([accountRows, itemRows]) => {
        if (!active) return;
        setAccounts(accountRows);
        setAvailableItems(itemRows);
      })
      .catch((e) => {
        if (active) setErr(typeof e === "string" ? e : (e?.message ?? text("تعذر تحميل الحسابات والأصناف المرتبطة", "Could not load accounts and linked items.")));
      });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!showQr || !initial) { setQrDataUrl(null); return; }
    let active = true;
    const qrValue = String(form.barcode || form.code || initial.id);
    QRCode.toDataURL(qrValue, { width: 220, margin: 2, errorCorrectionLevel: "M" })
      .then((data) => { if (active) setQrDataUrl(data); })
      .catch(() => { if (active) setErr(text("تعذر إنشاء رمز QR", "Could not generate the QR code.")); });
    return () => { active = false; };
  }, [showQr, form.barcode, form.code, initial?.id]);
  const patchProfile = (patch: Partial<ItemWebProfile>) => setProfile((prev) => ({ ...prev, ...patch }));
  // Multi-unit pricing — additional sale units (نص كرتونة / كرتونة …). Stored
  // in the LS overlay only (via create/updateItem), never in SQLite.
  const [units, setUnits] = useState<ItemUnit[]>(initial?.units ?? []);

  // Brand links — additive/optional. One item may carry many brands, each with
  // its own price/cost/barcode/part-number. Pure LS overlay (lib/brands.ts);
  // brandName is PRINT-ONLY at sale time and never enters ZATCA UBL/hash/QR.
  const allBrands = useMemo(() => listBrands().filter((b) => b.status === "active"), []);
  const [brandLinks, setBrandLinks] = useState<ItemBrandLink[]>(
    () => (initial ? listItemBrandLinks(initial.id) : []),
  );

  function newLinkId(): string {
    return (crypto as any).randomUUID?.() ?? `bl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
  function addBrandLink() {
    setBrandLinks((prev) => [
      ...prev,
      { id: newLinkId(), brandId: 0, barcode: "", partNumber: "", purchaseCost: 0, salePrice1: 0, status: "active" },
    ]);
  }
  function updateBrandLink(id: string, patch: Partial<ItemBrandLink>) {
    setBrandLinks((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }
  function removeBrandLink(id: string) {
    setBrandLinks((prev) => prev.filter((l) => l.id !== id));
  }

  function newUnitId(): string {
    return (crypto as any).randomUUID?.() ?? `u_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
  function addUnit() {
    setUnits((prev) => [...prev, { id: newUnitId(), name: "", factor: 1, price: 0, barcode: "" }]);
  }
  function updateUnit(id: string, patch: Partial<ItemUnit>) {
    setUnits((prev) => prev.map((u) => u.id === id ? { ...u, ...patch } : u));
  }
  function removeUnit(id: string) {
    setUnits((prev) => prev.filter((u) => u.id !== id));
  }

  async function submit() {
    if (!form.nameAr.trim()) { setErr(text("الاسم بالعربية مطلوب", "Arabic name is required.")); return; }
    // Task #201: weighed items are priced per-kg, not per-unit, so the
    // "sale price" field is meaningless and validation must switch over
    // to pricePerKg.
    if (form.isWeighed) {
      if (!form.pricePerKg || form.pricePerKg <= 0) { setErr(text("السعر للكيلو يجب أن يكون أكبر من صفر", "Price per kilogram must be greater than zero.")); return; }
    } else {
      if (form.salePrice <= 0) { setErr(text("السعر يجب أن يكون أكبر من صفر", "Price must be greater than zero.")); return; }
    }
    if (form.vatRate < 0 || form.vatRate > 100) { setErr(text("نسبة الضريبة بين 0 و 100", "Tax rate must be between 0 and 100.")); return; }
    if (!form.uomId) { setActiveTab("basic"); setErr(text("وحدة القياس الأساسية مطلوبة", "A base unit of measure is required.")); return; }
    if ((profile.discountValue ?? 0) < 0 || (profile.discountType === "percent" && (profile.discountValue ?? 0) > 100)) {
      setActiveTab("pricing"); setErr(text("قيمة الخصم غير صالحة", "The discount value is invalid.")); return;
    }
    if ((profile.reorderLevel ?? 0) < 0 || (profile.maxLevel != null && profile.maxLevel < 0)) {
      setActiveTab("pricing"); setErr(text("تحقق من حد إعادة الطلب والحد الأقصى للمخزون", "Check the reorder and maximum stock levels.")); return;
    }
    const tags = (profile.tags ?? "").split(",").map((tag) => tag.trim()).filter(Boolean);
    if (tags.length > 20 || tags.some((tag) => tag.length > 40)) {
      setActiveTab("additional"); setErr(text("الحد الأقصى 20 وسمًا، وبحد أقصى 40 حرفًا للوسم الواحد.", "Use at most 20 tags, with no more than 40 characters per tag.")); return;
    }
    const saleOptions = profile.salePriceOptions ?? [];
    if (saleOptions.some((option) => !option.nameAr.trim() || !Number.isFinite(option.salePrice) || option.salePrice < 0)) {
      setActiveTab("pricing");
      setErr(text("أكمل الاسم العربي وسعر كل خيار بيع أو احذفه", "Complete the Arabic name and price for each sales option, or remove it."));
      return;
    }
    const modifierGroups = profile.restaurantModifierGroups ?? [];
    if (modifierGroups.some((group) =>
      !group.nameAr.trim() || group.options.length === 0
      || group.options.some((option) => !option.itemId || !Number.isFinite(option.extraPrice) || option.extraPrice < 0
        || !/^\d+(?:\.\d{1,4})?$/.test(String(option.consumptionQtyPerSelection).trim())
        || !Number.isFinite(option.consumptionQtyPerSelection) || option.consumptionQtyPerSelection <= 0 || option.consumptionQtyPerSelection > 1_000_000)
      || group.minSelect < (group.required ? 1 : 0) || group.maxSelect < 1
      || group.minSelect > group.maxSelect || group.maxSelect > group.options.length
      || (group.selectionMode === "single" && group.maxSelect !== 1))) {
      setActiveTab("restaurant-modifiers");
      setErr(text("أكمل مجموعات المطعم واربط كل اختيار بصنف صالح", "Complete each modifier group and link every option to a valid item."));
      return;
    }
    if (profile.businessType === "service" && !profile.revenueAccountId) {
      setActiveTab("accounts"); setErr(text("الحساب الإيرادي مطلوب للأصناف الخدمية", "A revenue account is required for service items.")); return;
    }
    if (profile.businessType === "prepaid_expense" && !profile.costAccountId) {
      setActiveTab("accounts"); setErr(text("حساب التكلفة مطلوب للمصروفات المقدمة", "A cost account is required for prepaid expenses.")); return;
    }
    // Multi-unit validation — only for non-weighed items (units are hidden for
    // weighed). Each unit needs a name, a factor > 0, and a price > 0.
    const cleanUnits: ItemUnit[] = form.isWeighed ? [] : units
      .map((u) => ({ ...u, name: u.name.trim(), barcode: (u.barcode ?? "").trim() || undefined }))
      .filter((u) => u.name || u.factor !== 1 || u.price > 0);
    if (!form.isWeighed) {
      const seenBarcodes = new Set<string>();
      const base = (form.barcode ?? "").trim();
      if (base) seenBarcodes.add(base);
      for (const u of cleanUnits) {
        if (!u.name) { setErr(text("اسم وحدة البيع الإضافية مطلوب", "Additional sales unit name is required.")); return; }
        if (!u.factor || u.factor <= 0) { setErr(text(`معامل التحويل للوحدة "${u.name}" يجب أن يكون أكبر من صفر`, `Conversion factor for unit "${u.name}" must be greater than zero.`)); return; }
        if (u.price <= 0) { setErr(text(`سعر الوحدة "${u.name}" يجب أن يكون أكبر من صفر`, `Price for unit "${u.name}" must be greater than zero.`)); return; }
        // Reject barcodes that collide with the base barcode or a sibling unit —
        // the scanner resolves the first match, so duplicates are ambiguous.
        const bc = (u.barcode ?? "").trim();
        if (bc) {
          if (seenBarcodes.has(bc)) { setErr(text(`الباركود "${bc}" مكرر — يجب أن يكون باركود كل وحدة فريداً`, `Barcode "${bc}" is duplicated. Each unit must have a unique barcode.`)); return; }
          seenBarcodes.add(bc);
        }
      }
    }
    if (isPharmacy) {
      if (!(form.activeIngredient ?? "").trim()) { setErr(text("المادة الفعّالة مطلوبة في وضع الصيدلية", "Active ingredient is required in pharmacy mode.")); return; }
      if (!(form.dosageForm ?? "").trim()) { setErr(text("الشكل الصيدلي مطلوب في وضع الصيدلية", "Dosage form is required in pharmacy mode.")); return; }
      if (!(form.strength ?? "").trim()) { setErr(text("التركيز مطلوب في وضع الصيدلية", "Strength is required in pharmacy mode.")); return; }
    }
    // Brand links — additive/optional. Drop empty rows (no brand chosen), then
    // validate: every kept row needs a brand, and no brand may repeat.
    const cleanBrandLinks: ItemBrandLink[] = brandLinks
      .filter((l) => l.brandId && l.brandId > 0)
      .map((l) => ({
        ...l,
        barcode: (l.barcode ?? "").trim() || null,
        partNumber: (l.partNumber ?? "").trim() || null,
        purchaseCost: l.purchaseCost || null,
        salePrice1: l.salePrice1 || null,
        status: l.status ?? "active",
      }));
    const seenBrands = new Set<number>();
    for (const l of cleanBrandLinks) {
      if (seenBrands.has(l.brandId)) { setErr(text("لا يمكن تكرار نفس العلامة التجارية على نفس الصنف", "The same brand cannot be linked to an item more than once.")); return; }
      seenBrands.add(l.brandId);
    }
    setSaving(true); setErr(null);
    try {
      let id: number;
      // Units live in the LS overlay only — they flow through create/updateItem
      // (NOT updateItemWeighed/Extended, which are SQLite-only).
      const savedUsageRules = Object.entries(usageModes)
        .filter(([, value]) => value.mode !== "allowed" || value.reason.trim())
        .map(([screenKey, value]) => ({ screenKey, mode: value.mode, reason: value.reason.trim() || null }));
      const metadata: ItemWebProfile = {
        ...profile,
        salePriceOptions: saleOptions.map((option) => ({ ...option, nameAr: option.nameAr.trim(), nameEn: option.nameEn.trim() })),
        restaurantModifierGroups: modifierGroups.map((group) => ({
          ...group,
          nameAr: group.nameAr.trim(),
          nameEn: (group.nameEn ?? "").trim() || null,
        })),
        usageControls: savedUsageRules,
        tags: (profile.tags ?? "").split(",").map((tag) => tag.trim()).filter(Boolean).join(", "),
      };
      const auditFields: { field: string; before: unknown; after: unknown }[] = initial ? [
        { field: "nameAr", before: initial.nameAr, after: form.nameAr },
        { field: "nameEn", before: initial.nameEn, after: form.nameEn },
        { field: "code", before: initial.code, after: form.code },
        { field: "barcode", before: initial.barcode, after: form.barcode },
        { field: "costPrice", before: initial.costPrice, after: form.costPrice },
        { field: "salePrice", before: initial.salePrice, after: form.salePrice },
        { field: "vatRate", before: initial.vatRate, after: form.vatRate },
        { field: "uomId", before: initial.uomId, after: form.uomId },
        { field: "groupId", before: initial.groupId, after: form.groupId },
        { field: "businessType", before: initial.metadata?.businessType, after: profile.businessType },
        { field: "businessNature", before: initial.metadata?.businessNature ?? initial.itemType, after: profile.businessNature },
        { field: "subgroupName", before: initial.metadata?.subgroupName, after: profile.subgroupName },
        { field: "posGroupName", before: initial.metadata?.posGroupName, after: profile.posGroupName },
        { field: "posSubgroupName", before: initial.metadata?.posSubgroupName, after: profile.posSubgroupName },
        { field: "costMethod", before: initial.metadata?.costMethod, after: profile.costMethod },
        { field: "discountType", before: initial.metadata?.discountType, after: profile.discountType },
        { field: "discountValue", before: initial.metadata?.discountValue, after: profile.discountValue },
        { field: "status", before: initial.metadata?.status, after: profile.status },
        { field: "reorderLevel", before: initial.metadata?.reorderLevel, after: profile.reorderLevel },
        { field: "maxLevel", before: initial.metadata?.maxLevel, after: profile.maxLevel },
        { field: "costAccountId", before: initial.metadata?.costAccountId, after: profile.costAccountId },
        { field: "revenueAccountId", before: initial.metadata?.revenueAccountId, after: profile.revenueAccountId },
        { field: "salePriceOptions", before: initial.metadata?.salePriceOptions, after: metadata.salePriceOptions },
        { field: "restaurantModifierGroups", before: initial.metadata?.restaurantModifierGroups, after: metadata.restaurantModifierGroups },
        { field: "usageControls", before: initial.metadata?.usageControls, after: metadata.usageControls },
        { field: "tags", before: initial.metadata?.tags, after: metadata.tags },
        { field: "description", before: initial.metadata?.description, after: profile.description },
        { field: "showInPos", before: initial.metadata?.showInPos, after: profile.showInPos },
        { field: "batchTrackingMode", before: initial.metadata?.batchTrackingMode, after: profile.batchTrackingMode },
        { field: "retailEnabled", before: initial.metadata?.retailEnabled, after: profile.retailEnabled },
        { field: "retailCategory", before: initial.metadata?.retailCategory, after: profile.retailCategory },
        { field: "retailColor", before: initial.metadata?.retailColor, after: profile.retailColor },
        { field: "retailSize", before: initial.metadata?.retailSize, after: profile.retailSize },
        { field: "expiryDate", before: initial.expiryDate, after: form.expiryDate },
        { field: "batchNo", before: initial.batchNo, after: form.batchNo },
        { field: "isWeighed", before: initial.isWeighed, after: form.isWeighed },
        { field: "pricePerKg", before: initial.pricePerKg, after: form.pricePerKg },
        { field: "plu", before: initial.plu, after: form.plu },
      ] : [];
      const auditValue = (value: unknown): string => {
        if (value === undefined || value === null || value === "") return "—";
        if (typeof value === "boolean") return value ? text("نعم", "Yes") : text("لا", "No");
        if (typeof value === "string" && value.startsWith("data:image/")) return text("[صورة]", "[image]");
        if (typeof value === "object") {
          try { return JSON.stringify(value).slice(0, 180); } catch { return "[object]"; }
        }
        return String(value).slice(0, 180);
      };
      const auditChanges = auditFields
        .filter(({ before, after }) => JSON.stringify(before) !== JSON.stringify(after))
        .map(({ field, before, after }) => ({ field, before: auditValue(before), after: auditValue(after) }));
      const auditEntry: ItemAuditEntry = {
        id: newUnitId(),
        action: initial ? "edit" : "create",
        occurredAt: new Date().toISOString(),
        changes: auditChanges,
      };
      const auditHistory = [...(initial?.metadata?.auditHistory ?? profile.auditHistory ?? []), auditEntry].slice(-100);
      const payload: CreateItemInput = {
        ...form,
        costPrice: Number(form.costPrice) || 0,
        nature: profile.businessType === "stock" ? "stock" : "service",
        itemType: profile.businessNature ?? "merchandise",
        metadata: { ...metadata, auditHistory },
        units: cleanUnits.length ? cleanUnits : null,
      };
      if (initial) {
        await updateItem(initial.id, payload);
        id = initial.id;
      } else {
        const created = await createItem(payload);
        id = created.id;
      }
      // Pharmacy extended fields go straight to SQLite via the dedicated
      // Tauri command — required for rows that have no LS overlay row.
      // Scale (Task #201) — persist weighed fields straight to SQLite for the
      // same overlay-pattern reason as the pharmacy block.
      await updateItemWeighed(id, {
        isWeighed: !!form.isWeighed,
        pricePerKg: form.isWeighed ? (form.pricePerKg ?? null) : null,
        plu: (form.plu ?? "").trim() || null,
      });
      await updateItemExtended(id, {
        activeIngredient: form.activeIngredient || null,
        dosageForm: form.dosageForm || null,
        strength: form.strength || null,
        manufacturer: form.manufacturer || null,
        requiresPrescription: form.requiresPrescription ?? null,
        controlled: form.controlled ?? null,
        expiryDate: form.expiryDate || null,
        batchNo: form.batchNo || null,
      });
      // Persist brand links (whole-set replace) — LS overlay only, keyed by
      // the resolved item id. Empty set clears the item's links.
      setItemBrands(id, cleanBrandLinks);
      emitData("items");
      onSaved(initial ? text("تم تحديث الصنف", "Item updated.") : text("تم إضافة الصنف", "Item added."));
    } catch (e: any) {
      // Tauri commands reject with a bare STRING; collapsing it into a generic
      // "فشل الحفظ" hid the real cause. Show the string (or Error.message) as-is.
      setErr(typeof e === "string" ? e : (e?.message ?? text("فشل الحفظ", "Could not save item.")));
    }
    finally { setSaving(false); }
  }

  function updateModifierGroup(index: number, patch: Partial<RestaurantModifierGroup>) {
    setProfile((prev) => ({
      ...prev,
      restaurantModifierGroups: (prev.restaurantModifierGroups ?? []).map((group, i) => i === index ? { ...group, ...patch } : group),
    }));
  }
  function addModifierGroup() {
    const id = newUnitId();
    patchProfile({
      restaurantModifierGroups: [...(profile.restaurantModifierGroups ?? []), {
        id, nameAr: "", nameEn: "", required: false, selectionMode: "single", minSelect: 0, maxSelect: 1,
        options: [{ id: newUnitId(), itemId: 0, extraPrice: 0, consumptionQtyPerSelection: 1 }],
      }],
    });
  }
  function updateModifierOption(groupIndex: number, optionIndex: number, patch: Partial<RestaurantModifierGroup["options"][number]>) {
    setProfile((prev) => ({
      ...prev,
      restaurantModifierGroups: (prev.restaurantModifierGroups ?? []).map((group, gi) => gi !== groupIndex ? group : ({
        ...group, options: group.options.map((option, oi) => oi === optionIndex ? { ...option, ...patch } : option),
      })),
    }));
  }
  function addSalePriceOption() {
    const option = { id: newUnitId(), nameAr: "", nameEn: "", salePrice: Number(form.salePrice) || 0 };
    patchProfile({ salePriceOptions: [...(profile.salePriceOptions ?? []), option] });
  }
  function handleImageFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setErr(text("اختر ملف صورة صالحاً", "Choose a valid image file."));
      event.target.value = "";
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setErr(text("حجم الصورة يجب ألا يتجاوز 2 ميجابايت", "Image size must not exceed 2 MB."));
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") patchProfile({ imageUrl: reader.result });
    };
    reader.onerror = () => setErr(text("تعذر قراءة الصورة", "Could not read the image."));
    reader.readAsDataURL(file);
    event.target.value = "";
  }
  function printQr() {
    if (!qrDataUrl) return;
    const printWindow = window.open("", "_blank", "width=420,height=620");
    if (!printWindow) { setErr(text("اسمح بفتح نافذة الطباعة", "Allow the print window to open.")); return; }
    printWindow.opener = null;
    const doc = printWindow.document;
    doc.open();
    doc.write("<!doctype html><html><head></head><body></body></html>");
    doc.close();
    const style = doc.createElement("style");
    style.textContent = "body{font-family:system-ui,sans-serif;text-align:center;padding:20px}.sticker{display:inline-block;padding:16px;border:1px dashed #ccc;border-radius:12px}img{width:220px;height:220px}h2{font-size:16px}.code{font-family:monospace;color:#555;font-size:12px}.barcode{font-family:monospace;color:#888;font-size:11px}@media print{.sticker{border:0}}";
    doc.head.appendChild(style);
    const sticker = doc.createElement("div");
    sticker.className = "sticker";
    const image = doc.createElement("img");
    image.src = qrDataUrl;
    sticker.appendChild(image);
    const title = doc.createElement("h2");
    title.textContent = language === "en" ? form.nameEn || form.nameAr || form.code || "" : form.nameAr || form.nameEn || form.code || "";
    sticker.appendChild(title);
    if (form.code) { const code = doc.createElement("div"); code.className = "code"; code.textContent = form.code; sticker.appendChild(code); }
    if (form.barcode) { const barcode = doc.createElement("div"); barcode.className = "barcode"; barcode.textContent = `🔖 ${form.barcode}`; sticker.appendChild(barcode); }
    doc.body.appendChild(sticker);
    image.onload = () => { printWindow.focus(); printWindow.print(); };
  }
  function historyFieldLabel(field: string) {
    const labels: Record<string, [string, string]> = {
      nameAr: ["الاسم بالعربية", "Arabic name"], nameEn: ["الاسم بالإنجليزية", "English name"],
      code: ["الكود", "Code"], barcode: ["الباركود", "Barcode"], costPrice: ["سعر التكلفة", "Cost price"],
      salePrice: ["سعر البيع", "Sales price"], vatRate: ["الضريبة", "Tax rate"], uomId: ["وحدة القياس", "Unit of measure"],
      groupId: ["مجموعة الصنف", "Item group"], businessType: ["نوع الصنف", "Item type"],
      businessNature: ["طبيعة الصنف", "Item nature"], subgroupName: ["المجموعة الفرعية", "Subgroup"],
      posGroupName: ["مجموعة نقاط البيع", "POS group"], posSubgroupName: ["مجموعة نقاط البيع الفرعية", "POS subgroup"],
      costMethod: ["طريقة احتساب التكلفة", "Costing method"], discountType: ["نوع الخصم", "Discount type"],
      discountValue: ["قيمة الخصم", "Discount value"], status: ["الحالة", "Status"],
      reorderLevel: ["حد إعادة الطلب", "Reorder level"], maxLevel: ["الحد الأقصى للمخزون", "Maximum stock"],
      costAccountId: ["حساب التكلفة", "Cost account"], revenueAccountId: ["حساب الإيراد", "Revenue account"],
      salePriceOptions: ["خيارات سعر البيع", "Sales price options"], restaurantModifierGroups: ["خيارات المطعم", "Restaurant modifiers"],
      usageControls: ["قواعد الاستخدام", "Usage rules"], tags: ["الوسوم", "Tags"], description: ["الوصف", "Description"],
      showInPos: ["الظهور في نقاط البيع", "Show in POS"], batchTrackingMode: ["تتبع التشغيلات", "Batch tracking"],
      retailEnabled: ["متغيرات التجزئة", "Retail attributes"], retailCategory: ["تصنيف التجزئة", "Retail category"],
      retailColor: ["اللون", "Color"], retailSize: ["المقاس", "Size"], expiryDate: ["تاريخ الصلاحية", "Expiry date"],
      batchNo: ["رقم التشغيلة", "Batch number"], isWeighed: ["البيع بالوزن", "Sold by weight"],
      pricePerKg: ["السعر للكيلو", "Price per kilogram"], plu: ["رقم PLU", "PLU"],
    };
    const pair = labels[field];
    return pair ? text(pair[0], pair[1]) : field;
  }

  const usageScreenGroups: { key: string; ar: string; en: string; screens: [string, string, string][] }[] = [
    { key: "purchases", ar: "المشتريات", en: "Purchases", screens: [
      ["purchase_invoices", "فواتير المشتريات", "Purchase invoices"], ["purchase_returns", "مرتجعات المشتريات", "Purchase returns"],
      ["purchase_orders", "أوامر الشراء", "Purchase orders"], ["purchase_requests", "طلبات الشراء", "Purchase requests"],
      ["supplier_quotes", "عروض أسعار الموردين", "Supplier quotations"],
    ]},
    { key: "sales", ar: "المبيعات", en: "Sales", screens: [
      ["sales_quotations", "عروض الأسعار", "Quotations"], ["sales_orders", "أوامر البيع", "Sales orders"],
      ["sales_invoices", "فواتير المبيعات", "Sales invoices"], ["sales_returns", "مرتجعات المبيعات", "Sales returns"],
      ["pos", "نقاط البيع", "POS"], ["customer_requests", "طلبات العملاء", "Customer requests"],
    ]},
    { key: "warehouses", ar: "المخازن", en: "Warehouses", screens: [
      ["stock_in", "إذن إضافة", "Goods receipt"], ["stock_out", "إذن صرف", "Goods issue"],
      ["stock_transfer", "تحويل المخازن", "Stock transfer"], ["stock_count", "الجرد", "Stock count"],
      ["stock_adjust", "التسويات", "Adjustments"], ["assembly", "التجميع", "Assembly"], ["disassembly", "التفكيك", "Disassembly"],
    ]},
    { key: "manufacturing", ar: "التصنيع", en: "Manufacturing", screens: [
      ["production_orders", "أوامر الإنتاج", "Production orders"], ["raw_consumption", "استهلاك المواد الخام", "Raw consumption"],
      ["finished_goods", "المنتجات النهائية", "Finished goods"],
    ]},
    { key: "maintenance", ar: "الصيانة", en: "Maintenance", screens: [
      ["maintenance_orders", "أوامر الصيانة", "Maintenance orders"], ["spare_parts", "قطع الغيار", "Spare parts"],
    ]},
    { key: "rental", ar: "التأجير", en: "Rental", screens: [
      ["rental_contracts", "عقود التأجير", "Rental contracts"], ["rental_delivery", "تسليم الأصناف", "Item delivery"],
      ["rental_return", "استرجاع الأصناف", "Item return"],
    ]},
    { key: "projects", ar: "المشاريع", en: "Projects", screens: [
      ["project_issue", "صرف مواد المشروع", "Project issue"], ["project_return", "مرتجع المشروع", "Project return"],
    ]},
    { key: "ecommerce", ar: "التجارة الإلكترونية", en: "E-commerce", screens: [
      ["online_store", "المتجر الإلكتروني", "Online store"], ["mobile_app", "تطبيق الهاتف", "Mobile app"],
      ["online_sales", "البيع عبر الإنترنت", "Online sales"],
    ]},
    { key: "customer_service", ar: "خدمة العملاء", en: "Customer Service", screens: [
      ["warranty", "الضمان", "Warranty"], ["after_sales", "خدمات ما بعد البيع", "After-sales services"],
    ]},
  ];
  const usageModeOptions: { value: ItemUsageMode; ar: string; en: string }[] = [
    { value: "allowed", ar: "مسموح", en: "Allowed" },
    { value: "hidden", ar: "مخفي", en: "Hidden" },
    { value: "readonly", ar: "للقراءة فقط", en: "Read-only" },
    { value: "requires_approval", ar: "يتطلب موافقة", en: "Requires approval" },
    { value: "requires_permission", ar: "يتطلب صلاحية خاصة", en: "Requires special permission" },
  ];
  const usageReasonPresets = [
    { ar: "شراء فقط", en: "Purchase only" },
    { ar: "بيع فقط", en: "Sale only" },
    { ar: "مادة خام", en: "Raw material" },
    { ar: "منتج نهائي", en: "Finished product" },
    { ar: "موقوف مؤقتاً", en: "Temporarily suspended" },
    { ar: "خاص بالمشروعات", en: "Projects only" },
    { ar: "خاص بالصيانة", en: "Maintenance only" },
  ];
  const tabDefinitions = [
    { id: "basic" as const, icon: "📦", ar: "البيانات الأساسية", en: "Basic data" },
    { id: "pricing" as const, icon: "💲", ar: "الأسعار والكميات", en: "Pricing & quantities" },
    { id: "units" as const, icon: "📏", ar: "الوحدات", en: "Units" },
    ...(profile.businessType !== "stock" ? [{ id: "accounts" as const, icon: "📘", ar: "الربط المحاسبي", en: "Accounting links" }] : []),
    { id: "inventory" as const, icon: "🏬", ar: "المخزون والمستودعات", en: "Inventory & warehouses" },
    ...(profile.showInPos !== false ? [{ id: "restaurant-modifiers" as const, icon: "🍽️", ar: "إضافات وخيارات المطعم", en: "Restaurant modifiers" }] : []),
    { id: "additional" as const, icon: "🧩", ar: "بيانات إضافية", en: "Additional data" },
    { id: "usage" as const, icon: "⚙️", ar: "التحكم في الاستخدام", en: "Usage control" },
    { id: "notes" as const, icon: "📝", ar: "ملاحظات", en: "Notes" },
    ...(canRetailVariants ? [{ id: "retail" as const, icon: "🏷️", ar: "متغيرات التجزئة", en: "Retail variants" }] : []),
  ];
  const modifierItems = availableItems.filter((item) =>
    item.id !== initial?.id
    && item.metadata?.status !== "inactive"
    && ["stock", "service"].includes(item.metadata?.businessType ?? (item.nature === "service" ? "service" : "stock")),
  );
  const subgroupSuggestions = Array.from(new Set(availableItems.map((item) => item.metadata?.subgroupName?.trim()).filter((value): value is string => !!value)));
  const posGroupSuggestions = Array.from(new Set(availableItems.map((item) => item.metadata?.posGroupName?.trim()).filter((value): value is string => !!value)));
  const posSubgroupSuggestions = Array.from(new Set(availableItems.map((item) => item.metadata?.posSubgroupName?.trim()).filter((value): value is string => !!value)));

  return (
    <div style={{ background: "#fff", border: "1px solid #d9e0e8", borderRadius: 10, padding: 20, marginBottom: 16 }}>
      <h3 style={{ ...S.modalTitle, color: initial ? "#1e40af" : "#15803d" }}>{initial ? `✏️ ${text("تعديل صنف", "Edit item")}` : `➕ ${text("صنف جديد", "New item")}`}</h3>
      <div role="tablist" aria-label={text("أقسام بيانات الصنف", "Item data sections")} style={S.formTabs}>
        {tabDefinitions.map((tab) => (
          <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)} style={activeTab === tab.id ? S.formTabActive : S.formTab}>
            <span>{tab.icon}</span> {text(tab.ar, tab.en)}
          </button>
        ))}
      </div>
      <div style={{ minHeight: 260, paddingTop: 16 }}>
        {activeTab === "basic" && (
          <>
          <div style={S.formGrid4}>
            <Field label={text("الاسم بالعربية *", "Arabic name *")}>
              <input value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} style={S.input} autoFocus />
            </Field>
            <Field label={text("الاسم بالإنجليزية", "English name")}>
              <input value={form.nameEn ?? ""} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} style={S.input} dir={language === "en" ? "ltr" : undefined} />
            </Field>
            <Field label={text("الكود الداخلي", "Internal code")}>
              <input value={form.code ?? ""} onChange={(e) => setForm({ ...form, code: e.target.value })} style={S.input} placeholder={text("مثلاً: ITEM-001", "e.g. ITEM-001")} dir="ltr" />
            </Field>
            <Field label={text("الباركود", "Barcode")}>
              <input value={form.barcode ?? ""} onChange={(e) => setForm({ ...form, barcode: e.target.value })} style={S.input} placeholder="EAN-13" dir="ltr" />
            </Field>
            <Field label={text("نوع الصنف", "Item type")} hint={text("يحدد ما إذا كان الصنف مخزوناً أو خدمة أو أصلاً أو مصروفاً مقدماً.", "Choose whether this is stock, a service, a fixed asset, or a prepaid expense.")}>
              <select value={profile.businessType} style={S.input} onChange={(e) => {
                const businessType = e.target.value as ItemWebProfile["businessType"];
                const noStock = businessType === "service" || businessType === "prepaid_expense";
                patchProfile({
                  businessType,
                  ...(noStock ? { businessNature: "merchandise", batchTrackingMode: "none", reorderLevel: 0, maxLevel: null } : {}),
                });
                if (noStock) setForm((prev) => ({ ...prev, expiryDate: "", batchNo: "" }));
                setActiveTab("basic");
              }}>
                <option value="stock">{text("مخزني", "Stock item")}</option>
                <option value="service">{text("خدمي", "Service")}</option>
                <option value="fixed_asset">{text("أصل ثابت", "Fixed asset")}</option>
                <option value="prepaid_expense">{text("مصروف مقدم", "Prepaid expense")}</option>
              </select>
            </Field>
            {profile.businessType === "stock" && (
              <Field label={text("طبيعة الصنف", "Item nature")}>
                <select value={profile.businessNature ?? "merchandise"} style={S.input}
                  onChange={(e) => patchProfile({ businessNature: e.target.value as ItemWebProfile["businessNature"] })}>
                  <option value="raw">{text("مواد خام", "Raw material")}</option>
                  <option value="semi">{text("نصف مصنع", "Semi-finished")}</option>
                  <option value="finished">{text("تام الصنع", "Finished product")}</option>
                  <option value="consumable">{text("مستهلك", "Consumable")}</option>
                  <option value="merchandise">{text("بضاعة", "Merchandise")}</option>
                  <option value="other">{text("أخرى", "Other")}</option>
                </select>
              </Field>
            )}
            <Field label={text("مجموعة الصنف", "Item group")}>
              <SearchCombobox value={form.groupId ?? ""}
                onChange={(v) => setForm({ ...form, groupId: v === "" ? null : Number(v) })}
                style={S.input} options={[
                  { value: "", label: text("— بدون —", "— None —") },
                  ...itemGroups.map((g) => ({ value: g.id, label: `${language === "en" ? (g.nameEn || g.nameAr) : g.nameAr}${g.code ? ` (${g.code})` : ""}` })),
                ]} />
            </Field>
            <Field label={text("المجموعة الفرعية", "Subgroup")}>
              <input list="item-subgroup-suggestions" value={profile.subgroupName ?? ""} onChange={(e) => patchProfile({ subgroupName: e.target.value })} style={S.input} />
            </Field>
            <Field label={text("مجموعة نقاط البيع", "POS group")}>
              <input list="item-pos-group-suggestions" value={profile.posGroupName ?? ""} onChange={(e) => patchProfile({ posGroupName: e.target.value })} style={S.input} />
            </Field>
            <Field label={text("المجموعة الفرعية لنقاط البيع", "POS subgroup")}>
              <input list="item-pos-subgroup-suggestions" value={profile.posSubgroupName ?? ""} onChange={(e) => patchProfile({ posSubgroupName: e.target.value })} style={S.input} />
            </Field>
            <Field label={`${text("وحدة القياس الأساسية", "Base unit of measure")} *`}>
              <SearchCombobox value={form.uomId ?? ""}
                onChange={(v) => setForm({ ...form, uomId: v === "" ? null : Number(v) })} style={S.input}
                options={uoms.map((u) => ({ value: u.id, label: `${language === "en" ? (u.nameEn || u.nameAr) : u.nameAr}${u.shortCode ? ` (${u.shortCode})` : ""}` }))} />
            </Field>
            <Field label={text("الحالة", "Status")}>
              <select value={profile.status ?? "active"} onChange={(e) => patchProfile({ status: e.target.value as "active" | "inactive" })} style={S.input}>
                <option value="active">{text("نشط", "Active")}</option><option value="inactive">{text("غير نشط", "Inactive")}</option>
              </select>
            </Field>
          </div>
          <datalist id="item-subgroup-suggestions">{subgroupSuggestions.map((name) => <option key={name} value={name} />)}</datalist>
          <datalist id="item-pos-group-suggestions">{posGroupSuggestions.map((name) => <option key={name} value={name} />)}</datalist>
          <datalist id="item-pos-subgroup-suggestions">{posSubgroupSuggestions.map((name) => <option key={name} value={name} />)}</datalist>
          </>
        )}

        {activeTab === "pricing" && (
          <div style={{ display: "grid", gap: 14 }}>
            <div style={S.formGrid4}>
              <Field label={text("سعر التكلفة", "Cost price")}>
                <input type="number" min="0" step="any" value={form.costPrice ?? 0} onChange={(e) => setForm({ ...form, costPrice: Number(e.target.value) || 0 })} style={S.input} dir="ltr" />
              </Field>
              <Field label={form.isWeighed ? text("سعر البيع (يُستخدم سعر الكيلو)", "Sales price (price/kg is used)") : text("سعر البيع", "Sales price")}>
                <input type="number" min="0" step="any" value={blankIfZero(form.salePrice, hideZeros)} disabled={!!form.isWeighed}
                  onChange={(e) => setForm({ ...form, salePrice: Number(e.target.value) || 0 })} style={{ ...S.input, opacity: form.isWeighed ? 0.5 : 1 }} dir="ltr" />
              </Field>
              <Field label={text("نسبة الضريبة %", "Tax rate %")}>
                <input type="number" min="0" max="100" step="any" value={form.vatRate ?? 0} onChange={(e) => setForm({ ...form, vatRate: Number(e.target.value) || 0 })} style={S.input} dir="ltr" />
              </Field>
              {profile.businessType !== "service" && profile.businessType !== "prepaid_expense" && (
                <Field label={text("طريقة احتساب التكلفة", "Costing method")}>
                  <select value={profile.costMethod ?? "weighted_avg"} onChange={(e) => patchProfile({ costMethod: e.target.value as ItemWebProfile["costMethod"] })} style={S.input}>
                    <option value="weighted_avg">{text("متوسط مرجح", "Weighted average")}</option>
                    <option value="last_cost">{text("آخر تكلفة", "Last cost")}</option>
                  </select>
                </Field>
              )}
              <Field label={text("نوع الخصم الافتراضي", "Default discount type")}>
                <select value={profile.discountType ?? "none"} onChange={(e) => patchProfile({ discountType: e.target.value as ItemWebProfile["discountType"], discountValue: e.target.value === "none" ? 0 : profile.discountValue ?? 0 })} style={S.input}>
                  <option value="none">{text("بدون", "None")}</option><option value="percent">{text("نسبة مئوية", "Percent")}</option><option value="amount">{text("مبلغ", "Amount")}</option>
                </select>
              </Field>
              <Field label={text("قيمة الخصم الافتراضي", "Default discount value")}>
                <input type="number" min="0" max={profile.discountType === "percent" ? 100 : undefined} step="any" disabled={!profile.discountType || profile.discountType === "none"}
                  value={profile.discountValue ?? 0} onChange={(e) => patchProfile({ discountValue: Number(e.target.value) || 0 })} style={S.input} dir="ltr" />
              </Field>
              {profile.businessType !== "service" && profile.businessType !== "prepaid_expense" && (
                <>
                  <Field label={text("حد إعادة الطلب", "Reorder level")}>
                    <input type="number" min="0" step="any" value={profile.reorderLevel ?? 0} onChange={(e) => patchProfile({ reorderLevel: Number(e.target.value) || 0 })} style={S.input} dir="ltr" />
                  </Field>
                  <Field label={text("الحد الأقصى للمخزون", "Maximum stock level")}>
                    <input type="number" min="0" step="any" value={profile.maxLevel ?? ""} onChange={(e) => patchProfile({ maxLevel: e.target.value === "" ? null : Number(e.target.value) })} style={S.input} dir="ltr" />
                  </Field>
                </>
              )}
            </div>
            <div style={S.sectionCard}>
              <div style={S.sectionHead}>
                <div><strong>{text("خيارات سعر البيع", "Sales price options")}</strong>
                  <div style={S.muted}>{text("تتيح اختيار سعر مختلف للصنف نفسه دون تغيير مخزونه.", "Choose an alternate price without changing the item or its stock.")}</div>
                </div>
                <button type="button" onClick={addSalePriceOption} style={S.btnAddCond}>+ {text("إضافة خيار", "Add option")}</button>
              </div>
              {(profile.salePriceOptions ?? []).map((option, index) => (
                <div key={option.id} style={S.optionGrid}>
                  <Field label={text("الاسم بالعربية", "Arabic name")}>
                    <input value={option.nameAr} onChange={(e) => patchProfile({ salePriceOptions: (profile.salePriceOptions ?? []).map((x, i) => i === index ? { ...x, nameAr: e.target.value } : x) })} style={S.input} />
                  </Field>
                  <Field label={text("الاسم بالإنجليزية", "English name")}>
                    <input value={option.nameEn} onChange={(e) => patchProfile({ salePriceOptions: (profile.salePriceOptions ?? []).map((x, i) => i === index ? { ...x, nameEn: e.target.value } : x) })} style={S.input} dir="ltr" />
                  </Field>
                  <Field label={text("السعر", "Price")}>
                    <input type="number" min="0" step="any" value={option.salePrice} onChange={(e) => patchProfile({ salePriceOptions: (profile.salePriceOptions ?? []).map((x, i) => i === index ? { ...x, salePrice: Number(e.target.value) || 0 } : x) })} style={S.input} dir="ltr" />
                  </Field>
                  <button type="button" onClick={() => patchProfile({ salePriceOptions: (profile.salePriceOptions ?? []).filter((_, i) => i !== index) })} style={{ ...S.btnDel, alignSelf: "end", marginBottom: 12 }} aria-label={text("حذف خيار السعر", "Remove price option")}>×</button>
                </div>
              ))}
            </div>
            <div style={S.sectionCard}>
              <strong>⚖️ {text("بيانات الميزان", "Scale details")}</strong>
              <label style={S.checkRow}><input type="checkbox" checked={!!form.isWeighed} onChange={(e) => setForm({ ...form, isWeighed: e.target.checked })} />{text("صنف يُباع بالوزن", "Item is sold by weight")}</label>
              {form.isWeighed && <div style={S.formGrid4}>
                <Field label={`${text("السعر للكيلو", "Price per kilogram")} (${currencySymbol()} / ${text("كجم", "kg")}) *`}>
                  <input type="number" min="0" step="any" value={blankIfZero(form.pricePerKg ?? 0, hideZeros)} onChange={(e) => setForm({ ...form, pricePerKg: Number(e.target.value) || 0 })} style={S.input} dir="ltr" />
                </Field>
                <Field label="PLU"><input value={form.plu ?? ""} maxLength={6} onChange={(e) => setForm({ ...form, plu: e.target.value.replace(/\D/g, "") })} style={S.input} dir="ltr" /></Field>
              </div>}
            </div>
          </div>
        )}

        {activeTab === "units" && (
          <div>
            <div style={S.muted}>{text("الوحدة الأساسية هي وحدة القياس المحددة في البيانات الأساسية. أضف وحدات بيع إضافية بمعامل تحويل وسعر وباركود اختياري.", "The base unit is the unit selected in Basic data. Add sale units with conversion factors, prices, and optional barcodes.")}</div>
            {!form.isWeighed ? (
              <>
                {(units ?? []).map((u) => (
                  <div key={u.id} style={S.unitGrid}>
                    <Field label={text("اسم الوحدة", "Unit name")}><input list="pos-uom-suggestions-new" value={u.name} onChange={(e) => updateUnit(u.id, { name: e.target.value })} style={S.input} /></Field>
                    <Field label={text("عدد الوحدات الأساسية", "Base-unit factor")}><input type="number" min="1" step="any" value={u.factor} onChange={(e) => updateUnit(u.id, { factor: Number(e.target.value) })} style={S.input} dir="ltr" /></Field>
                    <Field label={text("السعر", "Price")}><input type="number" min="0" step="any" value={u.price} onChange={(e) => updateUnit(u.id, { price: Number(e.target.value) })} style={S.input} dir="ltr" /></Field>
                    <Field label={text("الباركود الاختياري", "Optional barcode")}><input value={u.barcode ?? ""} onChange={(e) => updateUnit(u.id, { barcode: e.target.value })} style={S.input} dir="ltr" /></Field>
                    <button type="button" onClick={() => removeUnit(u.id)} style={{ ...S.btnDel, alignSelf: "end", marginBottom: 12 }}>{text("حذف", "Remove")}</button>
                  </div>
                ))}
                <datalist id="pos-uom-suggestions-new">{uoms.map((u) => <option key={u.id} value={u.nameAr} />)}</datalist>
                <button type="button" onClick={addUnit} style={S.btnAddCond}>+ {text("إضافة وحدة بيع", "Add sales unit")}</button>
              </>
            ) : <div style={S.infoBox}>{text("الوحدات الإضافية غير متاحة للصنف المباع بالوزن.", "Additional sale units are unavailable for weighed items.")}</div>}
          </div>
        )}

        {activeTab === "accounts" && profile.businessType !== "stock" && (
          <div style={S.formGrid4}>
            <Field label={text("حساب التكلفة", "Cost account")} >
              <select value={profile.costAccountId ?? ""} onChange={(e) => patchProfile({ costAccountId: e.target.value ? Number(e.target.value) : null })} style={S.input}>
                <option value="">{text("— اختر حساباً —", "— Select an account —")}</option>
                {accounts.filter((a) => a.isActive && a.isLeaf && (a.type === "expense" || a.type === "asset")).map((a) => (
                  <option key={a.id} value={a.id}>{a.code} — {language === "en" ? a.nameEn || a.nameAr : a.nameAr}</option>
                ))}
              </select>
            </Field>
            <Field label={text("حساب الإيراد", "Revenue account")}>
              <select value={profile.revenueAccountId ?? ""} onChange={(e) => patchProfile({ revenueAccountId: e.target.value ? Number(e.target.value) : null })} style={S.input}>
                <option value="">{text("— اختر حساباً —", "— Select an account —")}</option>
                {accounts.filter((a) => a.isActive && a.isLeaf && a.type === "revenue").map((a) => (
                  <option key={a.id} value={a.id}>{a.code} — {language === "en" ? a.nameEn || a.nameAr : a.nameAr}</option>
                ))}
              </select>
            </Field>
            {accounts.length === 0 && <div style={S.infoBox}>{text("لا توجد حسابات محلية متاحة. أضف الحسابات من شاشة دليل الحسابات أولاً.", "No local accounts are available. Add accounts in Chart of Accounts first.")}</div>}
            {profile.businessType === "service" && <div style={S.infoBox}>{text("يتطلب الصنف الخدمي حساب إيراد.", "Service items require a revenue account.")}</div>}
            {profile.businessType === "prepaid_expense" && <div style={S.infoBox}>{text("يتطلب المصروف المقدم حساب تكلفة.", "Prepaid expenses require a cost account.")}</div>}
          </div>
        )}

        {activeTab === "inventory" && (
          <div style={{ display: "grid", gap: 14 }}>
            <div style={S.sectionCard}>
              <label style={S.checkRow}>
                <input type="checkbox" checked={profile.showInPos !== false} onChange={(e) => {
                  patchProfile({ showInPos: e.target.checked });
                  if (!e.target.checked) setActiveTab("inventory");
                }} />
                <span><strong>{text("إظهار الصنف في نقاط البيع", "Show item in POS")}</strong><div style={S.muted}>{text("عند إيقافه يبقى الصنف في المخزون والمستندات لكنه لا يظهر في نقاط البيع.", "When disabled, the item remains available in inventory and documents but is hidden from POS.")}</div></span>
              </label>
            </div>
            {profile.businessType !== "service" && profile.businessType !== "prepaid_expense" && (
              <div style={S.formGrid4}>
                <Field label={text("تاريخ الصلاحية", "Expiry date")}><input type="date" value={form.expiryDate ?? ""} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} style={S.input} dir="ltr" /></Field>
                <Field label={text("رقم التشغيلة", "Batch number")}><input value={form.batchNo ?? ""} onChange={(e) => setForm({ ...form, batchNo: e.target.value })} style={S.input} /></Field>
                <Field label={text("تتبع التشغيلات", "Batch tracking")}>
                <select value={profile.batchTrackingMode ?? "none"} onChange={(e) => patchProfile({ batchTrackingMode: e.target.value as ItemWebProfile["batchTrackingMode"] })} style={S.input}>
                  <option value="none">{text("بدون", "None")}</option><option value="fifo">FIFO</option><option value="fefo">FEFO</option>
                </select>
                </Field>
              </div>
            )}
            {isPharmacy && (
              <div style={S.sectionCard}>
                <strong>💊 {text("بيانات الدواء (صيدلية)", "Medicine details (pharmacy)")}</strong>
                <div style={{ ...S.formGrid4, marginTop: 12 }}>
                  <Field label={text("المادة الفعّالة", "Active ingredient")}><input value={form.activeIngredient ?? ""} onChange={(e) => setForm({ ...form, activeIngredient: e.target.value })} style={S.input} /></Field>
                  <Field label={text("الشركة المصنّعة", "Manufacturer")}><input value={form.manufacturer ?? ""} onChange={(e) => setForm({ ...form, manufacturer: e.target.value })} style={S.input} /></Field>
                  <Field label={text("الشكل الصيدلي", "Dosage form")}><input value={form.dosageForm ?? ""} onChange={(e) => setForm({ ...form, dosageForm: e.target.value })} style={S.input} /></Field>
                  <Field label={text("التركيز", "Strength")}><input value={form.strength ?? ""} onChange={(e) => setForm({ ...form, strength: e.target.value })} style={S.input} /></Field>
                </div>
                <label style={S.checkRow}><input type="checkbox" checked={!!form.requiresPrescription} onChange={(e) => setForm({ ...form, requiresPrescription: e.target.checked })} />{text("يتطلّب وصفة طبية", "Prescription required")}</label>
                <label style={{ ...S.checkRow, color: "#b91c1c" }}><input type="checkbox" checked={!!form.controlled} onChange={(e) => setForm({ ...form, controlled: e.target.checked })} />{text("دواء مخدّر أو خاضع للرقابة", "Controlled substance")}</label>
              </div>
            )}
          </div>
        )}

        {activeTab === "restaurant-modifiers" && profile.showInPos !== false && (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={S.infoBox}>{text("اربط كل اختيار بصنف موجود. السعر الإضافي يضاف لسعر البيع، وتُحفظ كمية الاستهلاك لكل اختيار.", "Link each option to an existing item. The extra price is added to the sales price, and consumption quantity is saved per selection.")}</div>
            {(profile.restaurantModifierGroups ?? []).map((group, gi) => (
              <section key={group.id} style={S.sectionCard}>
                <div style={S.formGrid4}>
                  <Field label={text("اسم المجموعة بالعربية", "Group name in Arabic")}><input maxLength={100} value={group.nameAr} onChange={(e) => updateModifierGroup(gi, { nameAr: e.target.value })} style={S.input} /></Field>
                  <Field label={text("اسم المجموعة بالإنجليزية", "Group name in English")}><input maxLength={100} value={group.nameEn ?? ""} onChange={(e) => updateModifierGroup(gi, { nameEn: e.target.value })} style={S.input} dir="ltr" /></Field>
                  <label style={S.checkRow}><input type="checkbox" checked={group.required} onChange={(e) => updateModifierGroup(gi, { required: e.target.checked, minSelect: e.target.checked ? Math.max(1, group.minSelect) : 0 })} />{text("اختيار إجباري", "Required selection")}</label>
                  <Field label={text("نوع الاختيار", "Selection type")}><select value={group.selectionMode} onChange={(e) => updateModifierGroup(gi, { selectionMode: e.target.value as "single" | "multiple", maxSelect: e.target.value === "single" ? 1 : Math.max(2, group.maxSelect) })} style={S.input}><option value="single">{text("اختيار واحد", "Single choice")}</option><option value="multiple">{text("اختيارات متعددة", "Multiple choices")}</option></select></Field>
                  <Field label={text("الحد الأدنى", "Minimum selections")}><input type="number" min={group.required ? 1 : 0} max={group.maxSelect} disabled={!group.required} value={group.minSelect} onChange={(e) => updateModifierGroup(gi, { minSelect: Number(e.target.value) })} style={S.input} dir="ltr" /></Field>
                  <Field label={text("الحد الأعلى", "Maximum selections")}><input type="number" min={1} max={group.options.length} disabled={group.selectionMode === "single"} value={group.selectionMode === "single" ? 1 : group.maxSelect} onChange={(e) => updateModifierGroup(gi, { maxSelect: Number(e.target.value) })} style={S.input} dir="ltr" /></Field>
                </div>
                {(group.options ?? []).map((option, oi) => (
                  <div key={option.id} style={S.modifierGrid}>
                    <Field label={text("الصنف المرتبط", "Linked item")}>
                      <select value={option.itemId || ""} onChange={(e) => updateModifierOption(gi, oi, { itemId: Number(e.target.value) || 0 })} style={S.input}>
                        <option value="">{text("— اختر صنفاً —", "— Select an item —")}</option>
                        {modifierItems.map((item) => <option key={item.id} value={item.id}>{item.code ? `${item.code} — ` : ""}{language === "en" ? item.nameEn || item.nameAr : item.nameAr}</option>)}
                      </select>
                    </Field>
                    <Field label={text("السعر الإضافي", "Extra price")}><input type="number" min="0" step="any" value={option.extraPrice} onChange={(e) => updateModifierOption(gi, oi, { extraPrice: Number(e.target.value) || 0 })} style={S.input} dir="ltr" /></Field>
                    <Field label={text("كمية الاستهلاك لكل اختيار", "Consumption per selection")}><input type="number" min="0.0001" max="1000000" step="0.0001" value={option.consumptionQtyPerSelection} onChange={(e) => updateModifierOption(gi, oi, { consumptionQtyPerSelection: Number(e.target.value) || 0 })} style={S.input} dir="ltr" /></Field>
                    <button type="button" onClick={() => updateModifierGroup(gi, { options: group.options.filter((_, i) => i !== oi) })} style={{ ...S.btnDel, alignSelf: "end", marginBottom: 12 }}>{text("حذف", "Remove")}</button>
                  </div>
                ))}
                <div style={S.btnRow}>
                  <button type="button" onClick={() => updateModifierGroup(gi, { options: [...group.options, { id: newUnitId(), itemId: 0, extraPrice: 0, consumptionQtyPerSelection: 1 }] })} style={S.btnAddCond}>+ {text("إضافة اختيار", "Add option")}</button>
                  <button type="button" onClick={() => patchProfile({ restaurantModifierGroups: (profile.restaurantModifierGroups ?? []).filter((_, i) => i !== gi) })} style={S.btnGhost}>{text("حذف المجموعة", "Remove group")}</button>
                </div>
              </section>
            ))}
            <button type="button" onClick={addModifierGroup} style={S.btnAddCond}>+ {text("إضافة مجموعة خيارات", "Add modifier group")}</button>
          </div>
        )}

        {activeTab === "additional" && (
          <div style={{ display: "grid", gap: 14 }}>
            <div style={S.formGrid4}>
              <Field label={text("الوسوم", "Tags")} hint={text("افصل بين الوسوم بفواصل، بحد أقصى 20 وسمًا.", "Separate tags with commas; up to 20 tags.")}>
                <input value={profile.tags ?? ""} onChange={(e) => patchProfile({ tags: e.target.value })} style={S.input} />
              </Field>
              <Field label={text("صورة الصنف", "Item image")} hint={text("ارفع صورة حتى 2 ميجابايت أو أدخل رابطًا. تُحفظ الصورة محليًا على هذا الجهاز.", "Upload an image up to 2 MB or enter a URL. Uploaded images are stored locally on this device.")}>
                <div style={{ display: "grid", gap: 7 }}>
                  <input type="file" accept="image/*" onChange={handleImageFile} style={S.input} />
                  <input value={profile.imageUrl ?? ""} onChange={(e) => patchProfile({ imageUrl: e.target.value })} style={S.input} dir="ltr" placeholder="https://…" />
                </div>
              </Field>
            </div>
            {profile.imageUrl && (
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                <img src={profile.imageUrl} alt={text("صورة الصنف", "Item image")} style={{ width: 88, height: 88, objectFit: "cover", borderRadius: 8, border: "1px solid #e2e8f0" }} />
                <button type="button" onClick={() => patchProfile({ imageUrl: "" })} style={S.btnGhost}>{text("إزالة الصورة", "Remove image")}</button>
              </div>
            )}
            <div style={S.sectionCard}><label style={S.checkRow}><input type="checkbox" checked={!!profile.isBundle} onChange={(e) => patchProfile({ isBundle: e.target.checked })} /><span><strong>{text("صنف مركّب", "Bundle item")}</strong><div style={S.muted}>{text("يُستخدم لتمييز الأصناف التي تتكون من عدة أصناف أخرى.", "Mark items composed of multiple component items.")}</div></span></label></div>
            <div style={S.sectionCard}>
              <div style={S.sectionHead}><strong>🏷️ {text("العلامات التجارية", "Brands")}</strong><span style={S.muted}>{text("اربط الصنف بعلامة أو أكثر مع السعر والتكلفة والباركود.", "Link one or more brands with their price, cost, and barcode.")}</span></div>
              {allBrands.length === 0 ? <div style={S.infoBox}>{text("لا توجد علامات تجارية معرّفة. أضفها من شاشة العلامات التجارية أولاً.", "No brands are defined. Add them in the Brands screen first.")}</div> : (
                <>
                  {brandLinks.map((l) => (
                    <div key={l.id} style={S.brandGrid}>
                      <Field label={text("العلامة التجارية", "Brand")}><SearchCombobox value={l.brandId || ""} onChange={(v) => updateBrandLink(l.id, { brandId: v === "" ? 0 : Number(v) })} style={S.input} options={[{ value: "", label: text("— اختر —", "— Select —") }, ...allBrands.map((b) => ({ value: b.id, label: `${language === "en" ? b.nameEn || b.nameAr : b.nameAr}${b.code ? ` (${b.code})` : ""}` }))]} /></Field>
                      <Field label={text("الباركود", "Barcode")}><input value={l.barcode ?? ""} onChange={(e) => updateBrandLink(l.id, { barcode: e.target.value })} style={S.input} dir="ltr" /></Field>
                      <Field label={text("رقم القطعة", "Part number")}><input value={l.partNumber ?? ""} onChange={(e) => updateBrandLink(l.id, { partNumber: e.target.value })} style={S.input} dir="ltr" /></Field>
                      <Field label={text("التكلفة", "Cost")}><input type="number" min="0" step="any" value={blankIfZero(l.purchaseCost ?? 0, hideZeros)} onChange={(e) => updateBrandLink(l.id, { purchaseCost: Number(e.target.value) || 0 })} style={S.input} dir="ltr" /></Field>
                      <Field label={text("سعر البيع", "Sales price")}><input type="number" min="0" step="any" value={blankIfZero(l.salePrice1 ?? 0, hideZeros)} onChange={(e) => updateBrandLink(l.id, { salePrice1: Number(e.target.value) || 0 })} style={S.input} dir="ltr" /></Field>
                      <button type="button" onClick={() => removeBrandLink(l.id)} style={{ ...S.btnDel, alignSelf: "end", marginBottom: 12 }}>×</button>
                    </div>
                  ))}
                  <button type="button" onClick={addBrandLink} style={S.btnAddCond}>+ {text("إضافة علامة تجارية", "Add brand")}</button>
                </>
              )}
            </div>
            {initial && (
              <div style={S.sectionCard}>
                <div style={S.sectionHead}>
                  <div><strong>{text("رمز الصنف وسجل التعديلات", "Item QR and edit history")}</strong><div style={S.muted}>{text("تعرض الأدوات الرمز الشريطي وسجل تغييرات هذا الجهاز.", "These tools show the item QR code and changes saved on this device.")}</div></div>
                  <div style={S.btnRow}>
                    <button type="button" onClick={() => setShowQr(true)} style={S.btnGhost}>{text("عرض رمز QR", "Show QR code")}</button>
                    <button type="button" onClick={() => setShowHistory(true)} style={S.btnGhost}>{text("سجل التعديلات", "Edit history")}</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "usage" && (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={S.sectionCard}>
              <div style={S.sectionHead}><div><strong>{text("التحكم في استخدام الصنف", "Item usage control")}</strong><div style={S.muted}>{text("حدد الشاشات التي تسمح باستخدام الصنف أو تقيده.", "Choose where this item can be used or restricted.")}</div></div>
                <strong>{Object.values(usageModes).filter((rule) => rule.mode !== "allowed").length} {text("قيود", "rules")}</strong>
              </div>
              <div style={S.btnRow}>
                <button type="button" style={S.btnGhost} onClick={() => setUsageModes({})}>{text("السماح للجميع", "Allow all")}</button>
                <button type="button" style={S.btnGhost} onClick={() => {
                  const all: Record<string, { mode: ItemUsageMode; reason: string }> = {};
                  usageScreenGroups.flatMap((group) => group.screens).forEach(([key]) => {
                    all[key] = { mode: "hidden", reason: usageModes[key]?.reason ?? "" };
                  });
                  setUsageModes(all);
                }}>{text("حظر الجميع", "Block all")}</button>
                <button type="button" style={S.btnGhost} onClick={() => setUsageModes({})}>{text("إعادة الافتراضي", "Reset defaults")}</button>
                <select defaultValue="" style={{ ...S.input, width: 220 }} onChange={(e) => {
                  const presets: Record<string, { hide: string[]; ar: string; en: string }> = {
                    purchase_only: { hide: ["sales", "ecommerce"], ar: "شراء فقط", en: "Purchase only" },
                    sale_only: { hide: ["purchases", "manufacturing"], ar: "بيع فقط", en: "Sale only" },
                    raw_material: { hide: ["sales", "ecommerce"], ar: "مادة خام", en: "Raw material" },
                    finished_product: { hide: ["purchases", "manufacturing"], ar: "منتج نهائي", en: "Finished product" },
                    maintenance: { hide: ["sales", "purchases", "ecommerce", "manufacturing", "projects", "rental"], ar: "خاص بالصيانة", en: "Maintenance only" },
                    service: { hide: ["warehouses", "manufacturing"], ar: "صنف خدمي", en: "Service item" },
                  };
                  const preset = presets[e.target.value];
                  if (!preset) return;
                  const next: Record<string, { mode: ItemUsageMode; reason: string }> = {};
                  usageScreenGroups.filter((group) => preset.hide.includes(group.key)).flatMap((group) => group.screens).forEach(([key]) => {
                    next[key] = { mode: "hidden", reason: text(preset.ar, preset.en) };
                  });
                  setUsageModes(next);
                  e.target.value = "";
                }}>
                  <option value="">{text("تطبيق قالب", "Apply template")}</option>
                  <option value="purchase_only">{text("شراء فقط", "Purchase only")}</option><option value="sale_only">{text("بيع فقط", "Sale only")}</option>
                  <option value="raw_material">{text("مادة خام", "Raw material")}</option><option value="finished_product">{text("منتج نهائي", "Finished product")}</option>
                  <option value="maintenance">{text("صيانة", "Maintenance")}</option><option value="service">{text("خدمي", "Service")}</option>
                </select>
              </div>
            </div>
            {usageScreenGroups.map((group) => (
              <section key={group.en} style={S.sectionCard}>
                <strong>{text(group.ar, group.en)}</strong>
                {group.screens.map(([key, ar, en]) => {
                  const current = usageModes[key] ?? { mode: "allowed" as ItemUsageMode, reason: "" };
                  return (
                    <div key={key} style={S.usageRow}>
                      <span>{text(ar, en)}</span>
                      <select value={current.mode} onChange={(e) => setUsageModes((prev) => ({ ...prev, [key]: { ...current, mode: e.target.value as ItemUsageMode } }))} style={S.input}>
                        {usageModeOptions.map((mode) => <option key={mode.value} value={mode.value}>{text(mode.ar, mode.en)}</option>)}
                      </select>
                      <input value={current.reason} disabled={current.mode === "allowed"} list="usage-reason-presets-desktop" onChange={(e) => setUsageModes((prev) => ({ ...prev, [key]: { ...current, reason: e.target.value } }))} style={S.input} placeholder={text("سبب اختياري", "Optional reason")} />
                    </div>
                  );
                })}
              </section>
            ))}
            <datalist id="usage-reason-presets-desktop">
              {usageReasonPresets.map((reason) => <option key={reason.en} value={text(reason.ar, reason.en)} />)}
            </datalist>
          </div>
        )}

        {activeTab === "notes" && (
          <Field label={text("وصف الصنف وملاحظاته", "Item description and notes")}>
            <textarea value={profile.description ?? ""} onChange={(e) => patchProfile({ description: e.target.value })} style={{ ...S.input, minHeight: 150, resize: "vertical" }} placeholder={text("اكتب ملاحظات الصنف هنا…", "Enter item notes here…")} />
          </Field>
        )}

        {activeTab === "retail" && canRetailVariants && (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={S.sectionCard}><label style={S.checkRow}><input type="checkbox" checked={!!profile.retailEnabled} onChange={(e) => patchProfile({ retailEnabled: e.target.checked, retailCategory: e.target.checked ? profile.retailCategory || "apparel" : profile.retailCategory })} /><span><strong>{text("تفعيل بيانات الملابس والأحذية", "Enable clothing and footwear attributes")}</strong><div style={S.muted}>{text("أضف التصنيف واللون والمقاس لهذا الصنف.", "Set category, color, and size for this item.")}</div></span></label></div>
            {profile.retailEnabled && <div style={S.formGrid4}>
              <Field label={text("التصنيف", "Category")}><select value={profile.retailCategory ?? "apparel"} onChange={(e) => patchProfile({ retailCategory: e.target.value })} style={S.input}><option value="apparel">{text("ملابس", "Apparel")}</option><option value="footwear">{text("أحذية", "Footwear")}</option><option value="bags">{text("حقائب", "Bags")}</option><option value="accessories">{text("إكسسوارات", "Accessories")}</option><option value="other">{text("أخرى", "Other")}</option></select></Field>
              <Field label={text("اللون", "Color")}><input value={profile.retailColor ?? ""} onChange={(e) => patchProfile({ retailColor: e.target.value })} style={S.input} /></Field>
              <Field label={text("المقاس", "Size")}><input value={profile.retailSize ?? ""} onChange={(e) => patchProfile({ retailSize: e.target.value })} style={S.input} /></Field>
            </div>}
          </div>
        )}
      </div>
      {err && <div style={S.err}>{err}</div>}
      <div style={S.btnRow}>
        <button onClick={submit} disabled={saving} style={S.btnPrimary}>{saving ? "..." : initial ? `💾 ${text("حفظ التعديلات", "Save changes")}` : `✅ ${text("إضافة", "Add item")}`}</button>
        <button onClick={onClose} style={S.btnGhost}>{text("إلغاء", "Cancel")}</button>
      </div>
      {showQr && initial && (
        <div role="dialog" aria-modal="true" dir={language === "en" ? "ltr" : "rtl"} style={S.modalBg} onClick={(event) => { if (event.target === event.currentTarget) setShowQr(false); }}>
          <div style={{ ...S.modal, maxWidth: 420, textAlign: "center" }}>
            <h3 style={S.modalTitle}>{text("رمز QR للصنف", "Item QR code")}</h3>
            <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 12, display: "inline-flex", minWidth: 244, minHeight: 244, alignItems: "center", justifyContent: "center" }}>
              {qrDataUrl ? <img src={qrDataUrl} alt={text("رمز QR", "QR code")} width={220} height={220} /> : <span style={S.muted}>{text("جارٍ إنشاء الرمز…", "Generating code…")}</span>}
            </div>
            <div style={{ marginTop: 10, fontWeight: 700 }}>{language === "en" ? form.nameEn || form.nameAr : form.nameAr || form.nameEn}</div>
            {form.code && <div style={S.muted}>{form.code}</div>}
            {form.barcode && <div style={S.muted}>🔖 {form.barcode}</div>}
            <div style={{ ...S.btnRow, justifyContent: "center" }}>
              <button type="button" onClick={() => setShowQr(false)} style={S.btnGhost}>{text("إغلاق", "Close")}</button>
              <button type="button" disabled={!qrDataUrl} onClick={printQr} style={S.btnPrimary}>{text("طباعة الرمز", "Print code")}</button>
            </div>
          </div>
        </div>
      )}
      {showHistory && initial && (
        <div role="dialog" aria-modal="true" dir={language === "en" ? "ltr" : "rtl"} style={S.modalBg} onClick={(event) => { if (event.target === event.currentTarget) setShowHistory(false); }}>
          <div style={{ ...S.modal, maxWidth: 760, maxHeight: "85vh", overflowY: "auto" }}>
            <h3 style={S.modalTitle}>{text("سجل تعديلات الصنف", "Item edit history")} — {language === "en" ? form.nameEn || form.nameAr : form.nameAr || form.nameEn}</h3>
            <div style={S.muted}>{text("السجل محلي على هذا الجهاز ويحتفظ بآخر 100 عملية إنشاء أو تعديل.", "This device-local log keeps the latest 100 item creates and edits.")}</div>
            {(initial.metadata?.auditHistory ?? []).length === 0 ? (
              <div style={{ ...S.infoBox, textAlign: "center", marginTop: 14 }}>{text("لا توجد تعديلات مسجلة بعد.", "No edits have been recorded yet.")}</div>
            ) : (
              [...(initial.metadata?.auditHistory ?? [])].reverse().map((entry) => (
                <section key={entry.id} style={{ ...S.sectionCard, marginTop: 12 }}>
                  <div style={S.sectionHead}>
                    <strong>{entry.action === "create" ? text("إنشاء الصنف", "Item created") : entry.action === "delete" ? text("حذف الصنف", "Item deleted") : text("تعديل الصنف", "Item edited")}</strong>
                    <span style={S.muted}>{new Date(entry.occurredAt).toLocaleString(language === "en" ? "en-GB" : "ar-EG")}</span>
                  </div>
                  {entry.changes.length === 0
                    ? <div style={S.muted}>{entry.action === "create" ? text("تم إنشاء الصنف.", "Item created.") : text("لا توجد فروق محفوظة.", "No field differences were saved.")}</div>
                    : <div style={{ display: "grid", gap: 6 }}>
                      {entry.changes.map((change, index) => (
                        <div key={`${entry.id}-${change.field}-${index}`} style={{ fontSize: 12, padding: "6px 8px", background: "#f8fafc", borderRadius: 6 }}>
                          <strong>{historyFieldLabel(change.field)}:</strong> {change.before} → {change.after}
                        </div>
                      ))}
                    </div>}
                </section>
              ))
            )}
            <div style={{ ...S.btnRow, justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setShowHistory(false)} style={S.btnGhost}>{text("إغلاق", "Close")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Render the available-quantity cell for the items list.
 * Stock is opt-in per item (see lib/stock.ts): an item absent from the map is
 * "غير متتبَّع" (—). Tracked items are colour-coded: out-of-stock (نفد) in red,
 * at/below reorder point in amber, otherwise green.
 */
function renderQty(s: StockMap[number] | undefined, language: UiLanguage) {
  if (!s) return <span style={S.qtyUntracked}>—</span>;
  if (s.qty <= 0) return <span style={S.qtyZero}>{uiText("نفد", "Out of stock", language)}</span>;
  const low = s.reorderPoint > 0 && s.qty <= s.reorderPoint;
  return <span style={low ? S.qtyLow : S.qtyOk}>{s.qty}</span>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label style={{ display: "block", marginBottom: 12 }}>
    <div style={{ fontSize: 13, color: "#475569", marginBottom: 4 }}>{label}</div>
    {hint && <div style={{ fontSize: 11, color: "#94a3b8", margin: "0 0 5px", lineHeight: 1.5 }}>{hint}</div>}
    {children}
  </label>;
}

const S = {
  wrap: { width: "100%", minWidth: 0, margin: 0, boxSizing: "border-box" as const } as const,
  headerRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 16 } as const,
  h2: { margin: 0, fontSize: 22, color: "#0f172a" } as const,
  sub: { fontSize: 13, color: "#64748b", marginTop: 4 } as const,
  search: { width: "100%", padding: "10px 14px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 8, marginBottom: 16, fontFamily: "inherit" } as const,
  empty: { padding: 40, textAlign: "center" as const, color: "#94a3b8", background: "#fff", border: "1px dashed #e2e8f0", borderRadius: 8 } as const,
  table: { width: "100%", borderCollapse: "collapse" as const, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" } as const,
  th: { textAlign: "right" as const, padding: "12px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: 13, color: "#475569", fontWeight: 600 } as const,
  thRight: { textAlign: "left" as const, padding: "9px 11px", background: "#f2f5f8", borderBottom: "1px solid #d9e0e8", fontSize: 12, color: "#44536a", fontWeight: 700 } as const,
  tr: { borderBottom: "1px solid #e7ebf0" } as const,
  td: { padding: "8px 11px", fontSize: 13, color: "#233044" } as const,
  tdMono: { padding: "12px 14px", fontSize: 13, color: "#0f172a", fontFamily: "ui-monospace, monospace" } as const,
  tdRight: { padding: "12px 14px", textAlign: "left" as const } as const,
  muted: { fontSize: 12, color: "#94a3b8", marginTop: 2 } as const,
  qtyOk: { fontWeight: 700, fontSize: 15, color: "#16a34a" } as const,
  qtyLow: { fontWeight: 700, fontSize: 15, color: "#d97706" } as const,
  qtyZero: { display: "inline-block", padding: "2px 10px", background: "#dc2626", color: "#fff", borderRadius: 6, fontSize: 12, fontWeight: 700 } as const,
  qtyUntracked: { color: "#cbd5e1" } as const,
  badgeCloud: { display: "inline-block", padding: "2px 8px", background: "#eff6ff", color: "#1d4ed8", border: "1px solid #dbeafe", borderRadius: 999, fontSize: 11 } as const,
  badgeLocal: { display: "inline-block", padding: "2px 8px", background: "#fefce8", color: "#854d0e", border: "1px solid #fef9c3", borderRadius: 999, fontSize: 11 } as const,
  badgeUnits: { display: "inline-block", marginInlineStart: 6, padding: "1px 7px", background: "#f5f3ff", color: "#7c3aed", border: "1px solid #ddd6fe", borderRadius: 999, fontSize: 11, fontWeight: 600 } as const,
  btnPrimary: { padding: "10px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600 } as const,
  btnImport: { padding: "10px 18px", background: "#fff", color: "#0f766e", border: "1px solid #5eead4", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600 } as const,
  btnEda: { padding: "10px 18px", background: "#fdf4ff", color: "#86198f", border: "1px solid #f0abfc", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600 } as const,
  btnGhost: { padding: "10px 18px", background: "#fff", color: "#475569", border: "1px solid #cbd5e1", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600 } as const,
  btnEdit: { padding: "6px 12px", background: "#f1f5f9", color: "#0f172a", border: "1px solid #e2e8f0", borderRadius: 6, cursor: "pointer", fontSize: 12, marginInlineEnd: 6 } as const,
  btnDel: { padding: "6px 12px", background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 6, cursor: "pointer", fontSize: 12 } as const,
  btnRow: { display: "flex", gap: 8, marginTop: 16 } as const,
  formTabs: { display: "flex", alignItems: "center", flexWrap: "wrap" as const, gap: 5, padding: 5, marginBottom: 4, background: "#f1f5f9", borderRadius: 9 } as const,
  formTab: { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 11px", border: "1px solid transparent", background: "transparent", color: "#475569", borderRadius: 7, cursor: "pointer", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" as const } as const,
  formTabActive: { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 11px", border: "1px solid #bfdbfe", background: "#fff", color: "#1d4ed8", borderRadius: 7, cursor: "pointer", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" as const, boxShadow: "0 1px 2px rgba(15,23,42,.08)" } as const,
  sectionCard: { border: "1px solid #e2e8f0", borderRadius: 9, padding: 14, background: "#fff", marginBottom: 10 } as const,
  sectionHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10, flexWrap: "wrap" as const } as const,
  checkRow: { display: "flex", alignItems: "flex-start", gap: 9, margin: "9px 0", fontSize: 13, color: "#475569", cursor: "pointer" } as const,
  infoBox: { background: "#f8fafc", border: "1px solid #e2e8f0", color: "#475569", borderRadius: 8, padding: 11, fontSize: 12, lineHeight: 1.6, margin: "6px 0" } as const,
  optionGrid: { display: "grid", gridTemplateColumns: "minmax(150px,1fr) minmax(150px,1fr) 130px auto", gap: 8, alignItems: "end" } as const,
  unitGrid: { display: "grid", gridTemplateColumns: "minmax(120px,1.2fr) minmax(110px,.9fr) minmax(110px,.9fr) minmax(130px,1fr) auto", gap: 8, alignItems: "end" } as const,
  brandGrid: { display: "grid", gridTemplateColumns: "minmax(150px,1.3fr) minmax(120px,1fr) minmax(110px,1fr) minmax(100px,.8fr) minmax(100px,.8fr) auto", gap: 8, alignItems: "end" } as const,
  modifierGrid: { display: "grid", gridTemplateColumns: "minmax(180px,1.5fr) minmax(120px,.8fr) minmax(180px,1.2fr) auto", gap: 8, alignItems: "end" } as const,
  usageRow: { display: "grid", gridTemplateColumns: "minmax(180px,1fr) minmax(160px,.8fr) minmax(180px,1fr)", gap: 8, alignItems: "center", padding: "8px 0", borderTop: "1px solid #f1f5f9", fontSize: 12 } as const,
  ok: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 } as const,
  err: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 } as const,
  modalBg: { position: "fixed" as const, inset: 0, background: "rgba(15,23,42,.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 16 } as const,
  modal: { background: "#fff", borderRadius: 12, padding: 24, maxWidth: 560, width: "100%", boxShadow: "0 20px 50px rgba(0,0,0,.25)" } as const,
  modalTitle: { margin: "0 0 16px", fontSize: 18, color: "#0f172a" } as const,
  formGrid4: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 } as const,
  input: { width: "100%", padding: "10px 12px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 6, fontFamily: "inherit", boxSizing: "border-box" as const } as const,
  toolbar: { display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" as const } as const,
  btnTool: { padding: "9px 14px", background: "#fff", color: "#334155", border: "1px solid #cbd5e1", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" as const } as const,
  btnToolActive: { padding: "9px 14px", background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" as const } as const,
  btnClear: { padding: "9px 14px", background: "#fff", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" as const } as const,
  advPanel: { background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: 14, marginBottom: 16 } as const,
  advHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap" as const, gap: 8 } as const,
  logicBtn: { padding: "5px 10px", background: "#fff", color: "#475569", border: "1px solid #cbd5e1", borderRadius: 6, cursor: "pointer", fontSize: 12 } as const,
  logicActive: { padding: "5px 10px", background: "#1d4ed8", color: "#fff", border: "1px solid #1d4ed8", borderRadius: 6, cursor: "pointer", fontSize: 12 } as const,
  condRow: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" as const } as const,
  condSelect: { padding: "8px 10px", fontSize: 13, border: "1px solid #cbd5e1", borderRadius: 6, fontFamily: "inherit", background: "#fff", minWidth: 130 } as const,
  condInput: { padding: "8px 10px", fontSize: 13, border: "1px solid #cbd5e1", borderRadius: 6, fontFamily: "inherit", flex: 1, minWidth: 120, boxSizing: "border-box" as const } as const,
  condDel: { padding: "7px 11px", background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 6, cursor: "pointer", fontSize: 14 } as const,
  btnAddCond: { marginTop: 4, padding: "8px 14px", background: "#fff", color: "#1d4ed8", border: "1px dashed #93c5fd", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600 } as const,
  tableFixed: { borderCollapse: "collapse" as const, tableLayout: "fixed" as const, width: "max-content", minWidth: "100%" } as const,
  thSort: { position: "relative" as const, textAlign: "right" as const, padding: "9px 11px", background: "#f2f5f8", borderBottom: "1px solid #d9e0e8", fontSize: 12, color: "#44536a", fontWeight: 700, cursor: "pointer", userSelect: "none" as const, whiteSpace: "nowrap" as const } as const,
  sortArrow: { fontSize: 10, color: "#94a3b8" } as const,
  resizeHandle: { position: "absolute" as const, insetInlineStart: 0, top: 0, bottom: 0, width: 7, cursor: "col-resize", userSelect: "none" as const } as const,
  thFilter: { padding: "6px 8px", background: "#f1f5f9", borderBottom: "1px solid #e2e8f0" } as const,
  filterInput: { width: "100%", padding: "5px 8px", fontSize: 12, border: "1px solid #cbd5e1", borderRadius: 5, fontFamily: "inherit", boxSizing: "border-box" as const, background: "#fff" } as const,
  tdClip: { padding: "8px 11px", fontSize: 13, color: "#233044", overflow: "hidden" as const, textOverflow: "ellipsis" as const, whiteSpace: "nowrap" as const } as const,
  tdMonoClip: { padding: "8px 11px", fontSize: 12, color: "#233044", fontFamily: "ui-monospace, monospace", overflow: "hidden" as const, textOverflow: "ellipsis" as const, whiteSpace: "nowrap" as const } as const,
};
