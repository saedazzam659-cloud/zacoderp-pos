// Items admin — list + add + edit + delete.
// Uses lib/items.ts + lib/uom.ts.

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import {
  listItems, createItem, updateItem, deleteItem, bulkImportLocalItems, updateItemExtended, updateItemWeighed,
  type LocalItem, type CreateItemInput, type ItemUnit,
} from "../lib/items";
import { listUom, getDefaultUom } from "../lib/uom";
import { listItemGroups } from "../lib/itemGroups";
import { getAllStockShared, type StockMap } from "../lib/stock";
import { getVertical, type Vertical } from "../lib/standalone";
import { currencySymbol } from "../lib/currency";
import { SearchCombobox, Pagination, pageSlice } from "./_adminUi";

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

function itemsToCsv(list: LocalItem[], s: StockMap): string {
  const headers = ["الاسم", "الاسم بالإنجليزية", "الكمية المتاحة", "الباركود", "الكود", "السعر", "الضريبة %", "المصدر"];
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
      it.cloudId ? "سحابي" : "محلي",
    ].map((c) => esc(String(c))).join(","));
  }
  return "\uFEFF" + lines.join("\r\n");
}

function downloadCsv(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ItemsAdmin() {
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
    const label = preset === "all" ? "الكامل" : preset === "top" ? "الأكثر مبيعًا" : preset === "otc" ? "اللي بدون روشتة" : `فئة ${category}`;
    if (!confirm(`سيتم استيراد كتالوج EDA — ${label}. متابعة؟`)) return;
    setImportingEda(true);
    try {
      const baseUrl = (import.meta as any).env?.BASE_URL ?? "/";
      const res = await fetch(`${baseUrl}catalogs/eda_pharmacy_2026.csv`);
      if (!res.ok) throw new Error(`فشل تحميل الكتالوج (${res.status})`);
      const text = await res.text();
      const grid = parseCsv(text);
      if (grid.length < 2) throw new Error("الكتالوج فارغ");
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
        if (!category) throw new Error("لم يتم تحديد الفئة");
        rows = rows.filter((r) => (r.dosageForm ?? "").toLowerCase() === category.toLowerCase());
      }
      const { inserted, skippedDup } = await bulkImportLocalItems(rows, { dedupBy: "barcode" });
      setToast({ kind: "ok", text: `تم استيراد ${inserted} دواء${skippedDup ? ` — تم تجاهل ${skippedDup} مكرر` : ""}` });
      setShowEda(false);
      await refresh();
    } catch (e: any) {
      setToast({ kind: "err", text: e?.message ?? "فشل استيراد كتالوج EDA" });
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
    let max = ctx.measureText(col.label).width + 28;
    ctx.font = "14px system-ui, -apple-system, sans-serif";
    for (const it of processed) {
      const w = ctx.measureText(col.text(it, stockMap)).width;
      if (w > max) max = w;
    }
    setColWidths((prev) => ({ ...prev, [key]: Math.max(60, Math.min(700, Math.ceil(max) + 32)) }));
  }, [processed, stockMap]);

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
    const csv = itemsToCsv(processed, stockMap);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(csv, `items_${stamp}.csv`);
    setToast({ kind: "ok", text: `تم تصدير ${processed.length} صنف إلى ملف Excel/CSV` });
  }

  async function handleDelete(it: LocalItem) {
    if (!confirm(`حذف الصنف «${it.nameAr}»؟`)) return;
    try { await deleteItem(it.id); setToast({ kind: "ok", text: "تم الحذف" }); await refresh(); }
    catch (e: any) { setToast({ kind: "err", text: e?.message ?? "فشل الحذف" }); }
  }

  return (
    <div dir="rtl" style={S.wrap}>
      <div style={S.headerRow}>
        <div>
          <h2 style={S.h2}>الأصناف ({rows.length})</h2>
          <div style={S.sub}>إدارة قائمة الأصناف وأسعار البيع — السحب من السحابة يُحدّث القائمة تلقائيًا</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {isPharmacy && (
            <button onClick={() => setShowEda(true)} disabled={importingEda} style={S.btnEda}>
              {importingEda ? "... جاري الاستيراد" : "💊 استيراد كتالوج EDA"}
            </button>
          )}
          <button onClick={() => setShowImport(true)} style={S.btnImport}>
            📥 استيراد من CSV
          </button>
          <button onClick={() => { setEditing(null); setShowForm(true); }} disabled={showForm}
            style={{ ...S.btnPrimary, opacity: showForm ? 0.5 : 1, cursor: showForm ? "not-allowed" : "pointer" }}>
            + صنف جديد
          </button>
        </div>
      </div>

      {/* ── Toolbar: quick search + Excel-like toggles + export ── */}
      <div style={S.toolbar}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="بحث سريع بالاسم أو الكود أو الباركود..."
          style={{ ...S.search, marginBottom: 0, flex: 1, minWidth: 220 }}
        />
        <button onClick={() => setShowFilters((v) => !v)} style={showFilters ? S.btnToolActive : S.btnTool} title="إظهار صف فلتر تحت كل عمود">
          ⛃ فلاتر الأعمدة
        </button>
        <button onClick={() => setShowAdvanced((v) => !v)} style={showAdvanced ? S.btnToolActive : S.btnTool} title="بحث متقدم بأكثر من شرط">
          🔍 بحث متقدم
        </button>
        <button onClick={exportCsv} style={S.btnTool} title="تصدير القائمة المفلترة إلى Excel/CSV">
          📊 تصدير Excel
        </button>
        {hasActiveView && (
          <button onClick={clearAllViews} style={S.btnClear} title="إلغاء كل الفلاتر والترتيب">
            🧹 مسح الكل
          </button>
        )}
      </div>

      <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>
        عدد النتائج: {processed.length}{processed.length !== rows.length ? ` من أصل ${rows.length}` : ""}
      </div>

      {/* ── Advanced multi-condition search ── */}
      {showAdvanced && (
        <div style={S.advPanel}>
          <div style={S.advHeader}>
            <strong style={{ fontSize: 14, color: "#0f172a" }}>🔍 بحث متقدم</strong>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <span style={{ color: "#64748b" }}>دمج الشروط:</span>
              <button onClick={() => setLogic("and")} style={logic === "and" ? S.logicActive : S.logicBtn}>تحقّق الكل (و)</button>
              <button onClick={() => setLogic("or")} style={logic === "or" ? S.logicActive : S.logicBtn}>تحقّق أي (أو)</button>
            </div>
          </div>
          {conditions.length === 0 && (
            <div style={{ fontSize: 13, color: "#94a3b8", padding: "6px 0" }}>
              لا توجد شروط — اضغط «➕ إضافة شرط». مثال: السعر «أكبر من» 30 و الكمية المتاحة «أصغر من» 5.
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
                  {ITEM_COLS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select>
                <select
                  value={c.op}
                  onChange={(e) => { const op = e.target.value as FilterOp; setConditions((prev) => prev.map((p) => (p.id === c.id ? { ...p, op } : p))); }}
                  style={S.condSelect}
                >
                  {ops.map((o) => <option key={o} value={o}>{OP_LABELS[o]}</option>)}
                </select>
                <input
                  value={c.value}
                  type={col.type === "number" ? "number" : "text"}
                  onChange={(e) => { const value = e.target.value; setConditions((prev) => prev.map((p) => (p.id === c.id ? { ...p, value } : p))); }}
                  placeholder="القيمة"
                  style={S.condInput}
                />
                <button onClick={() => setConditions((prev) => prev.filter((p) => p.id !== c.id))} style={S.condDel} title="حذف الشرط">🗑</button>
              </div>
            );
          })}
          <button onClick={() => setConditions((prev) => [...prev, { id: Date.now() + prev.length, field: "name", op: "contains", value: "" }])} style={S.btnAddCond}>
            ➕ إضافة شرط
          </button>
        </div>
      )}

      {toast && <div style={toast.kind === "ok" ? S.ok : S.err}>{toast.text}</div>}

      {showForm && (
        <ItemForm
          initial={editing}
          isPharmacy={isPharmacy}
          onClose={() => setShowForm(false)}
          onSaved={async (msg) => { setShowForm(false); setToast({ kind: "ok", text: msg }); await refresh(); }}
        />
      )}

      {loading ? <div style={S.empty}>... جاري التحميل</div>
      : rows.length === 0 ? <div style={S.empty}>لا توجد أصناف — أضف صنف جديد أو اسحب من السحابة</div>
      : processed.length === 0 ? <div style={S.empty}>لا توجد نتائج مطابقة — جرّب تعديل الفلاتر أو «🧹 مسح الكل»</div>
      : (
        <div style={{ overflowX: "auto", border: "1px solid #e2e8f0", borderRadius: 8, background: "#fff" }}>
          <table style={S.tableFixed}>
            <colgroup>
              {ITEM_COLS.map((c) => <col key={c.key} style={{ width: colWidths[c.key] }} />)}
              <col style={{ width: colWidths.actions }} />
            </colgroup>
            <thead>
              <tr>
                {ITEM_COLS.map((c) => {
                  const active = sort?.key === c.key;
                  return (
                    <th key={c.key} style={S.thSort} onClick={() => toggleSort(c.key)} title="اضغط للترتيب تصاعدي/تنازلي">
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        {c.label}
                        <span style={S.sortArrow}>{active ? (sort!.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
                      </span>
                      <span
                        onMouseDown={(e) => onResizeStart(e, c.key)}
                        onDoubleClick={(e) => { e.stopPropagation(); autoFit(c.key); }}
                        onClick={(e) => e.stopPropagation()}
                        style={S.resizeHandle}
                        title="اسحب لتغيير العرض — دبل كليك للضبط التلقائي"
                      />
                    </th>
                  );
                })}
                <th style={S.thRight}>إجراء</th>
              </tr>
              {showFilters && (
                <tr>
                  {ITEM_COLS.map((c) => (
                    <th key={c.key} style={S.thFilter}>
                      {c.key === "source" ? (
                        <select value={columnFilters[c.key] ?? ""} onChange={(e) => setColumnFilters((prev) => ({ ...prev, [c.key]: e.target.value }))} style={S.filterInput}>
                          <option value="">الكل</option>
                          <option value="سحابي">سحابي</option>
                          <option value="محلي">محلي</option>
                        </select>
                      ) : (
                        <input
                          value={columnFilters[c.key] ?? ""}
                          onChange={(e) => setColumnFilters((prev) => ({ ...prev, [c.key]: e.target.value }))}
                          placeholder={c.type === "number" ? "مثال: >30 أو 10-20" : "بحث..."}
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
                  title={showForm ? "أغلق النموذج الحالي أولاً" : "اضغط على السطر للتعديل"}
                >
                  <td style={S.tdClip}>
                    <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {it.nameAr}
                      {it.units && it.units.length > 0 && (
                        <span style={S.badgeUnits} title={it.units.map((u) => `${u.name} (${u.factor})`).join("، ")}>
                          📦 {it.units.length} وحدة
                        </span>
                      )}
                    </div>
                    {it.nameEn && <div style={{ ...S.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.nameEn}</div>}
                  </td>
                  <td style={S.td}>{renderQty(stockMap[it.id])}</td>
                  <td style={S.tdMonoClip}>{it.barcode ?? "—"}</td>
                  <td style={S.tdMonoClip}>{it.code ?? "—"}</td>
                  <td style={S.td}><strong>{it.salePrice.toFixed(2)}</strong> {currencySymbol()}</td>
                  <td style={S.td}>{it.vatRate}%</td>
                  <td style={S.td}>
                    <span style={it.cloudId ? S.badgeCloud : S.badgeLocal}>
                      {it.cloudId ? `☁️ #${it.cloudId}` : "📱 محلي"}
                    </span>
                  </td>
                  <td style={S.tdRight} onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => { setEditing(it); setShowForm(true); }} disabled={showForm} style={{ ...S.btnEdit, opacity: showForm ? 0.5 : 1, cursor: showForm ? "not-allowed" : "pointer" }}>تعديل</button>
                    <button onClick={() => handleDelete(it)} disabled={showForm} style={{ ...S.btnDel, opacity: showForm ? 0.5 : 1, cursor: showForm ? "not-allowed" : "pointer" }}>حذف</button>
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
  const [showCategoryPicker, setShowCategoryPicker] = useState(false);
  const [categories, setCategories] = useState<{ name: string; count: number }[] | null>(null);
  const [catErr, setCatErr] = useState<string | null>(null);
  const [loadingCats, setLoadingCats] = useState(false);

  async function loadCategories() {
    setLoadingCats(true); setCatErr(null);
    try {
      const baseUrl = (import.meta as any).env?.BASE_URL ?? "/";
      const res = await fetch(`${baseUrl}catalogs/eda_pharmacy_2026.csv`);
      if (!res.ok) throw new Error(`فشل تحميل الكتالوج (${res.status})`);
      const text = await res.text();
      const grid = parseCsv(text);
      if (grid.length < 2) throw new Error("الكتالوج فاضي");
      const header = grid[0].map((h) => h.trim().toLowerCase());
      const iDf = header.indexOf("dosageform");
      if (iDf < 0) throw new Error("عمود dosageForm غير موجود في الكتالوج");
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
        <h3 style={{ marginTop: 0, color: "#86198f" }}>💊 استيراد كتالوج EDA</h3>
        {!showCategoryPicker ? (
          <>
            <p style={{ fontSize: 13, color: "#475569" }}>اختر النطاق المناسب — التكرارات هتتجاهل تلقائيًا حسب الباركود.</p>
            <div style={{ display: "grid", gap: 10 }}>
              <button disabled={importing} onClick={() => onImport("all")} style={S.btnPrimary}>
                📦 كل الأدوية (~500 صنف)
              </button>
              <button disabled={importing} onClick={() => onImport("top")} style={S.btnEda}>
                ⭐ الأكثر مبيعًا (~150 صنف بأسعار اقتصادية)
              </button>
              <button disabled={importing} onClick={() => onImport("otc")} style={S.btnEda}>
                💊 بدون روشتة فقط (OTC)
              </button>
              <button disabled={importing || loadingCats} onClick={() => void loadCategories()} style={S.btnEda}>
                {loadingCats ? "... جاري قراءة الفئات" : "🏷️ حسب الفئة (شكل الجرعة)"}
              </button>
              {catErr && <div style={{ color: "#dc2626", fontSize: 12 }}>{catErr}</div>}
              <button disabled={importing} onClick={onClose} style={S.btnGhost}>إلغاء</button>
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, color: "#475569" }}>اختر الفئة المراد استيرادها — الرقم بين قوسين عدد الأصناف.</p>
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
                <div style={{ color: "#64748b", fontSize: 13, textAlign: "center" }}>لا توجد فئات معرّفة في الكتالوج</div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button disabled={importing} onClick={() => setShowCategoryPicker(false)} style={{ ...S.btnGhost, flex: 1 }}>← رجوع</button>
              <button disabled={importing} onClick={onClose} style={{ ...S.btnGhost, flex: 1 }}>إلغاء</button>
            </div>
          </>
        )}
        {importing && <div style={{ marginTop: 12, fontSize: 13, color: "#64748b", textAlign: "center" }}>... جاري الاستيراد، لا تغلق النافذة</div>}
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
      const text = await f.text();
      const grid = parseCsv(text);
      if (grid.length < 2) { setError("الملف فاضي أو ما فيش صفوف بيانات"); return; }
      const header = grid[0].map((h) => h.trim().toLowerCase());
      const idx = (name: string) => header.indexOf(name);
      const iCode = idx("code");
      const iAr = idx("namear");
      const iEn = idx("nameen");
      const iBc = idx("barcode");
      const iPr = idx("saleprice");
      const iVat = idx("vatrate");
      if (iAr < 0 || iPr < 0) {
        setError("الأعمدة المطلوبة: nameAr و salePrice على الأقل (الترويسة الأولى).");
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
        if (!nameAr) parsedRow.error = "الاسم بالعربية فاضي";
        else if (!Number.isFinite(price) || price <= 0) parsedRow.error = "السعر غير صالح";
        else if (!Number.isFinite(vat) || vat < 0 || vat > 100) parsedRow.error = "الضريبة غير صالحة";
        out.push(parsedRow);
      }
      setParsed(out);
    } catch (e: any) {
      setError(e?.message ?? "تعذّر قراءة الملف");
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
    const parts = [`تم استيراد ${created} صنف`];
    if (skippedDup.length) parts.push(`تم تجاهل ${skippedDup.length} مكرر`);
    if (failed) parts.push(`فشل ${failed}`);
    await onDone(parts.join(" — "));
  }

  const validCount = parsed?.filter((r) => !r.error).length ?? 0;
  const errorCount = parsed?.filter((r) => r.error).length ?? 0;
  const previewBad = parsed?.filter((r) => r.error).slice(0, 5) ?? [];

  return (
    <div style={S.modalBg} onClick={onClose}>
      <div style={{ ...S.modal, maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={S.modalTitle}>📥 استيراد أصناف من ملف CSV</h3>

        <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 12, fontSize: 13, color: "#475569", marginBottom: 12, lineHeight: 1.7 }}>
          <strong>الأعمدة المطلوبة:</strong> <code>code, nameAr, nameEn, barcode, salePrice, vatRate</code>
          <br />
          <strong>إلزامي:</strong> nameAr + salePrice. <strong>اختياري:</strong> الباقي.
          <br />
          الترميز: UTF-8 (مدعوم BOM للفتح من Excel).
        </div>

        {!parsed && (
          <>
            <button onClick={() => fileRef.current?.click()} style={{ ...S.btnPrimary, width: "100%", padding: "16px" }}>
              اختر ملف CSV...
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
                <div style={{ fontSize: 12, color: "#166534" }}>صالح للاستيراد</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: "#166534" }}>{validCount}</div>
              </div>
              <div style={{ background: errorCount ? "#fef2f2" : "#f8fafc", border: `1px solid ${errorCount ? "#fecaca" : "#e2e8f0"}`, padding: 12, borderRadius: 8 }}>
                <div style={{ fontSize: 12, color: errorCount ? "#991b1b" : "#64748b" }}>صفوف بها أخطاء</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: errorCount ? "#991b1b" : "#64748b" }}>{errorCount}</div>
              </div>
            </div>

            {previewBad.length > 0 && (
              <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: 10, marginBottom: 12, fontSize: 12, color: "#991b1b" }}>
                <strong>أمثلة على الأخطاء:</strong>
                {previewBad.map((r) => (
                  <div key={r.rowNum}>صف {r.rowNum}: {r.error}</div>
                ))}
              </div>
            )}

            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 13 }}>
              <input type="checkbox" checked={skipDupes} onChange={(e) => setSkipDupes(e.target.checked)} />
              تجاهل الأصناف المكررة (نفس الباركود أو الكود)
            </label>

            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, fontSize: 13 }}>
              <span>الضريبة الافتراضية لو الخانة فاضية:</span>
              <input type="number" min={0} max={100} step={1} value={defaultVat} onChange={(e) => setDefaultVat(Number(e.target.value))} style={{ ...S.input, width: 80 }} />
              <span>%</span>
            </div>

            <div style={S.btnRow}>
              <button onClick={doImport} disabled={validCount === 0} style={S.btnPrimary}>
                ✅ استيراد {validCount} صنف
              </button>
              <button onClick={() => { setParsed(null); setFileName(""); }} style={S.btnGhost}>
                اختيار ملف آخر
              </button>
              <button onClick={onClose} style={S.btnGhost}>إلغاء</button>
            </div>
          </>
        )}

        {importing && progress && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 14, marginBottom: 8 }}>
              جاري الاستيراد... {progress.done} / {progress.total}
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

function ItemForm({ initial, isPharmacy, onClose, onSaved }: {
  initial: LocalItem | null;
  isPharmacy: boolean;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const uoms = listUom();
  const itemGroups = listItemGroups();
  const [form, setForm] = useState<CreateItemInput>({
    code: initial?.code ?? "",
    nameAr: initial?.nameAr ?? "",
    nameEn: initial?.nameEn ?? "",
    barcode: initial?.barcode ?? "",
    salePrice: initial?.salePrice ?? 0,
    vatRate: initial?.vatRate ?? (isPharmacy ? 14 : 15),
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
  // Multi-unit pricing — additional sale units (نص كرتونة / كرتونة …). Stored
  // in the LS overlay only (via create/updateItem), never in SQLite.
  const [units, setUnits] = useState<ItemUnit[]>(initial?.units ?? []);

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
    if (!form.nameAr.trim()) { setErr("الاسم بالعربية مطلوب"); return; }
    // Task #201: weighed items are priced per-kg, not per-unit, so the
    // "sale price" field is meaningless and validation must switch over
    // to pricePerKg.
    if (form.isWeighed) {
      if (!form.pricePerKg || form.pricePerKg <= 0) { setErr("السعر للكيلو يجب أن يكون أكبر من صفر"); return; }
    } else {
      if (form.salePrice <= 0) { setErr("السعر يجب أن يكون أكبر من صفر"); return; }
    }
    if (form.vatRate < 0 || form.vatRate > 100) { setErr("نسبة الضريبة بين 0 و 100"); return; }
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
        if (!u.name) { setErr("اسم وحدة البيع الإضافية مطلوب"); return; }
        if (!u.factor || u.factor <= 0) { setErr(`معامل التحويل للوحدة "${u.name}" يجب أن يكون أكبر من صفر`); return; }
        if (u.price <= 0) { setErr(`سعر الوحدة "${u.name}" يجب أن يكون أكبر من صفر`); return; }
        // Reject barcodes that collide with the base barcode or a sibling unit —
        // the scanner resolves the first match, so duplicates are ambiguous.
        const bc = (u.barcode ?? "").trim();
        if (bc) {
          if (seenBarcodes.has(bc)) { setErr(`الباركود "${bc}" مكرر — يجب أن يكون باركود كل وحدة فريداً`); return; }
          seenBarcodes.add(bc);
        }
      }
    }
    if (isPharmacy) {
      if (!(form.activeIngredient ?? "").trim()) { setErr("المادة الفعّالة مطلوبة في وضع الصيدلية"); return; }
      if (!(form.dosageForm ?? "").trim()) { setErr("الشكل الصيدلي مطلوب في وضع الصيدلية"); return; }
      if (!(form.strength ?? "").trim()) { setErr("التركيز مطلوب في وضع الصيدلية"); return; }
    }
    setSaving(true); setErr(null);
    try {
      let id: number;
      // Units live in the LS overlay only — they flow through create/updateItem
      // (NOT updateItemWeighed/Extended, which are SQLite-only).
      const payload = { ...form, units: cleanUnits.length ? cleanUnits : null };
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
      if (isPharmacy) {
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
      }
      onSaved(initial ? "تم تحديث الصنف" : "تم إضافة الصنف");
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ background: "#fff", border: `2px solid ${initial ? "#2563eb" : "#16a34a"}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
      <h3 style={{ ...S.modalTitle, color: initial ? "#1e40af" : "#15803d" }}>{initial ? "✏️ تعديل صنف" : "➕ صنف جديد"}</h3>

        {/* Core data — 4 fields per row for a denser, tidier layout. */}
        <div style={S.formGrid4}>
          <Field label="الاسم بالعربية *">
            <input value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} style={S.input} autoFocus />
          </Field>
          <Field label="الاسم بالإنجليزية">
            <input value={form.nameEn ?? ""} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} style={S.input} />
          </Field>
          <Field label="الكود الداخلي">
            <input value={form.code ?? ""} onChange={(e) => setForm({ ...form, code: e.target.value })} style={S.input} placeholder="مثلاً: ITEM-001" />
          </Field>
          <Field label="الباركود">
            <input value={form.barcode ?? ""} onChange={(e) => setForm({ ...form, barcode: e.target.value })} style={S.input} placeholder="EAN-13" />
          </Field>

          <Field label="مجموعة الصنف">
            <SearchCombobox
              value={form.groupId ?? ""}
              onChange={(v) => setForm({ ...form, groupId: v === "" ? null : Number(v) })}
              style={S.input}
              options={[
                { value: "", label: "— بدون —" },
                ...itemGroups.map((g) => ({
                  value: g.id,
                  label: `${g.nameAr}${g.code ? ` (${g.code})` : ""}`,
                })),
              ]}
            />
          </Field>
          <Field label="طبيعة الصنف">
            <select value={form.nature ?? "stock"}
                    onChange={(e) => setForm({ ...form, nature: e.target.value as CreateItemInput["nature"] })}
                    style={S.input}>
              <option value="stock">مخزني</option>
              <option value="service">خدمي</option>
            </select>
          </Field>
          <Field label="نوع الصنف">
            <select value={form.itemType ?? "finished"}
                    onChange={(e) => setForm({ ...form, itemType: e.target.value as CreateItemInput["itemType"] })}
                    style={S.input}>
              <option value="finished">تام</option>
              <option value="semi">نصف مصنع</option>
              <option value="raw">مواد خام</option>
              <option value="other">أخرى</option>
            </select>
          </Field>
          <Field label="وحدة القياس">
            <SearchCombobox
              value={form.uomId ?? ""}
              onChange={(v) => setForm({ ...form, uomId: v === "" ? null : Number(v) })}
              style={S.input}
              options={uoms.map((u) => ({
                value: u.id,
                label: `${u.nameAr}${u.shortCode ? ` (${u.shortCode})` : ""}`,
              }))}
            />
          </Field>

          <Field label={form.isWeighed ? "سعر البيع (يُستبدل بـ السعر/كجم)" : "سعر البيع *"}>
            <input type="number" step="0.01" min="0" value={form.salePrice}
                   disabled={!!form.isWeighed}
                   onChange={(e) => setForm({ ...form, salePrice: Number(e.target.value) })}
                   style={{ ...S.input, opacity: form.isWeighed ? 0.5 : 1 }} />
          </Field>
          <Field label="نسبة الضريبة %">
            <input type="number" step="0.5" min="0" max="100" value={form.vatRate} onChange={(e) => setForm({ ...form, vatRate: Number(e.target.value) })} style={S.input} />
          </Field>
        </div>

        {/* Scale (Task #201) — applies to all verticals. */}
        <div style={{ marginTop: 16, marginBottom: 8, paddingTop: 12, borderTop: "1px dashed #e2e8f0", fontSize: 13, fontWeight: 600, color: "#1d4ed8" }}>
          ⚖️ بيانات الميزان
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 13, color: "#475569" }}>
          <input type="checkbox" checked={!!form.isWeighed}
                 onChange={(e) => setForm({ ...form, isWeighed: e.target.checked })} />
          صنف يُباع بالوزن (يفتح نافذة وزن عند الإضافة، أو يُقرأ من باركود الميزان)
        </label>
        {form.isWeighed && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label={`السعر للكيلو (${currencySymbol()} / كجم) *`}>
              <input type="number" step="0.01" min="0" value={form.pricePerKg ?? 0}
                     onChange={(e) => setForm({ ...form, pricePerKg: Number(e.target.value) })}
                     style={S.input} />
            </Field>
            <Field label="رقم PLU (للميزان)">
              <input value={form.plu ?? ""} maxLength={6}
                     onChange={(e) => setForm({ ...form, plu: e.target.value.replace(/\D/g, "") })}
                     style={S.input} placeholder="مثلاً: 12345" />
            </Field>
          </div>
        )}

        {/* Multi-unit pricing — hidden for weighed items (priced per-kg). */}
        {!form.isWeighed && (
          <>
            <div style={{ marginTop: 16, marginBottom: 4, paddingTop: 12, borderTop: "1px dashed #e2e8f0", fontSize: 13, fontWeight: 600, color: "#7c3aed" }}>
              📦 وحدات بيع إضافية
            </div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 8 }}>
              الوحدة الأساسية = قطعة بسعر البيع أعلاه. أضف وحدات أكبر (نص كرتونة / كرتونة …) لكل منها سعر، ومعامل التحويل = عدد القطع، وباركود اختياري. المخزون يُخصم بالقطعة.
            </div>
            {units.map((u) => (
              <div key={u.id} style={{ display: "grid", gridTemplateColumns: "1.4fr 0.8fr 0.9fr 1.2fr auto", gap: 8, marginBottom: 8, alignItems: "end" }}>
                <Field label="اسم الوحدة">
                  <input list="pos-uom-suggestions" value={u.name}
                         onChange={(e) => updateUnit(u.id, { name: e.target.value })}
                         style={S.input} placeholder="كرتونة" />
                </Field>
                <Field label="عدد القطع">
                  <input type="number" step="1" min="1" value={u.factor}
                         onChange={(e) => updateUnit(u.id, { factor: Number(e.target.value) })}
                         style={S.input} />
                </Field>
                <Field label="السعر">
                  <input type="number" step="0.01" min="0" value={u.price}
                         onChange={(e) => updateUnit(u.id, { price: Number(e.target.value) })}
                         style={S.input} />
                </Field>
                <Field label="باركود (اختياري)">
                  <input value={u.barcode ?? ""}
                         onChange={(e) => updateUnit(u.id, { barcode: e.target.value })}
                         style={S.input} placeholder="EAN-13" />
                </Field>
                <button type="button" onClick={() => removeUnit(u.id)} style={{ ...S.btnDel, marginBottom: 12 }}>×</button>
              </div>
            ))}
            <datalist id="pos-uom-suggestions">
              {uoms.map((u) => <option key={u.id} value={u.nameAr} />)}
            </datalist>
            <button type="button" onClick={addUnit} style={S.btnAddCond}>+ إضافة وحدة بيع</button>
          </>
        )}

        {isPharmacy && (
          <>
            <div style={{ marginTop: 16, marginBottom: 8, paddingTop: 12, borderTop: "1px dashed #e2e8f0", fontSize: 13, fontWeight: 600, color: "#86198f" }} key="pharma-header">
              💊 بيانات الدواء (صيدلية)
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="المادة الفعّالة">
                <input value={form.activeIngredient ?? ""} onChange={(e) => setForm({ ...form, activeIngredient: e.target.value })} style={S.input} placeholder="Paracetamol" />
              </Field>
              <Field label="الشركة المصنّعة">
                <input value={form.manufacturer ?? ""} onChange={(e) => setForm({ ...form, manufacturer: e.target.value })} style={S.input} />
              </Field>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="الشكل الصيدلي">
                <input value={form.dosageForm ?? ""} onChange={(e) => setForm({ ...form, dosageForm: e.target.value })} style={S.input} placeholder="أقراص / شراب / كبسولات" />
              </Field>
              <Field label="التركيز">
                <input value={form.strength ?? ""} onChange={(e) => setForm({ ...form, strength: e.target.value })} style={S.input} placeholder="500 ملجم" />
              </Field>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="تاريخ الصلاحية">
                <input type="date" value={form.expiryDate ?? ""} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} style={S.input} />
              </Field>
              <Field label="رقم التشغيلة">
                <input value={form.batchNo ?? ""} onChange={(e) => setForm({ ...form, batchNo: e.target.value })} style={S.input} />
              </Field>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 13, color: "#475569" }}>
              <input type="checkbox" checked={!!form.requiresPrescription} onChange={(e) => setForm({ ...form, requiresPrescription: e.target.checked })} />
              يتطلّب وصفة طبية (روشتة)
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 13, color: "#dc2626", fontWeight: 600 }}>
              <input type="checkbox" checked={!!form.controlled} onChange={(e) => setForm({ ...form, controlled: e.target.checked })} />
              ⚠️ دواء مخدّر / خاضع للرقابة (controlled substance)
            </label>
          </>
        )}

        {err && <div style={S.err}>{err}</div>}

        <div style={S.btnRow}>
          <button onClick={submit} disabled={saving} style={S.btnPrimary}>
            {saving ? "..." : initial ? "💾 حفظ التعديلات" : "✅ إضافة"}
          </button>
          <button onClick={onClose} style={S.btnGhost}>إلغاء</button>
        </div>
    </div>
  );
}

/**
 * Render the available-quantity cell for the items list.
 * Stock is opt-in per item (see lib/stock.ts): an item absent from the map is
 * "غير متتبَّع" (—). Tracked items are colour-coded: out-of-stock (نفد) in red,
 * at/below reorder point in amber, otherwise green.
 */
function renderQty(s: StockMap[number] | undefined) {
  if (!s) return <span style={S.qtyUntracked}>—</span>;
  if (s.qty <= 0) return <span style={S.qtyZero}>نفد</span>;
  const low = s.reorderPoint > 0 && s.qty <= s.reorderPoint;
  return <span style={low ? S.qtyLow : S.qtyOk}>{s.qty}</span>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: "block", marginBottom: 12 }}>
    <div style={{ fontSize: 13, color: "#475569", marginBottom: 4 }}>{label}</div>
    {children}
  </label>;
}

const S = {
  wrap: { maxWidth: 1100, margin: "0 auto", width: "100%" } as const,
  headerRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 16 } as const,
  h2: { margin: 0, fontSize: 22, color: "#0f172a" } as const,
  sub: { fontSize: 13, color: "#64748b", marginTop: 4 } as const,
  search: { width: "100%", padding: "10px 14px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 8, marginBottom: 16, fontFamily: "inherit" } as const,
  empty: { padding: 40, textAlign: "center" as const, color: "#94a3b8", background: "#fff", border: "1px dashed #e2e8f0", borderRadius: 8 } as const,
  table: { width: "100%", borderCollapse: "collapse" as const, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" } as const,
  th: { textAlign: "right" as const, padding: "12px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: 13, color: "#475569", fontWeight: 600 } as const,
  thRight: { textAlign: "left" as const, padding: "12px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: 13, color: "#475569", fontWeight: 600 } as const,
  tr: { borderBottom: "1px solid #f1f5f9" } as const,
  td: { padding: "12px 14px", fontSize: 14, color: "#0f172a" } as const,
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
  ok: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 } as const,
  err: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 } as const,
  modalBg: { position: "fixed" as const, inset: 0, background: "rgba(15,23,42,.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 16 } as const,
  modal: { background: "#fff", borderRadius: 12, padding: 24, maxWidth: 560, width: "100%", boxShadow: "0 20px 50px rgba(0,0,0,.25)" } as const,
  modalTitle: { margin: "0 0 16px", fontSize: 18, color: "#0f172a" } as const,
  formGrid4: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 } as const,
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
  thSort: { position: "relative" as const, textAlign: "right" as const, padding: "12px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: 13, color: "#475569", fontWeight: 600, cursor: "pointer", userSelect: "none" as const, whiteSpace: "nowrap" as const } as const,
  sortArrow: { fontSize: 10, color: "#94a3b8" } as const,
  resizeHandle: { position: "absolute" as const, insetInlineStart: 0, top: 0, bottom: 0, width: 7, cursor: "col-resize", userSelect: "none" as const } as const,
  thFilter: { padding: "6px 8px", background: "#f1f5f9", borderBottom: "1px solid #e2e8f0" } as const,
  filterInput: { width: "100%", padding: "5px 8px", fontSize: 12, border: "1px solid #cbd5e1", borderRadius: 5, fontFamily: "inherit", boxSizing: "border-box" as const, background: "#fff" } as const,
  tdClip: { padding: "12px 14px", fontSize: 14, color: "#0f172a", overflow: "hidden" as const, textOverflow: "ellipsis" as const, whiteSpace: "nowrap" as const } as const,
  tdMonoClip: { padding: "12px 14px", fontSize: 13, color: "#0f172a", fontFamily: "ui-monospace, monospace", overflow: "hidden" as const, textOverflow: "ellipsis" as const, whiteSpace: "nowrap" as const } as const,
};
