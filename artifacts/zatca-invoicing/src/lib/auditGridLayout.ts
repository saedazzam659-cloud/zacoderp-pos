/**
 * Shared "audit-grid" layout primitives — the same dense ERP-style spreadsheet
 * UX used by SalesAuditGrid: per-tenant column order, Excel-style column
 * resize, header/footer color theme, page size, and per-column filters, all
 * persisted in localStorage and rehydrated on tenant switch.
 *
 * Screens opt-in by:
 *   1. Importing THEMES + types from here.
 *   2. Calling `useAuditGridLayout({ screenSlug, cid, dataKeys, allColKeys })`.
 *   3. Rendering toolbar controls from `components/auditGrid/AuditGridControls`.
 *   4. Wiring the returned `tableRef` + `makeGrip(colKey)` into their <th>.
 *
 * Keep ALL palette + persistence logic here so tweaks (new color, new page
 * size, format change) ripple to every audit-style screen at once.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/* ────────────────────────────── Header palette ─────────────────────────── */
export type HeaderColor =
  | "white" | "rose" | "blue" | "emerald" | "amber" | "purple" | "slate" | "teal";

export const HEADER_THEMES: Record<HeaderColor, {
  label: string;
  swatch: string;
  bar: string;
  text: string;
  btn: string;
  border: string;
}> = {
  white:   { label: "أبيض",  swatch: "bg-white border border-slate-300",                 bar: "bg-white",                                                              text: "text-slate-800", btn: "text-slate-700 hover:bg-slate-100 hover:text-slate-900", border: "border-slate-300" },
  rose:    { label: "وردي",  swatch: "bg-gradient-to-br from-rose-700 to-rose-900",      bar: "bg-gradient-to-l from-rose-900 via-rose-800 to-rose-900",               text: "text-white",     btn: "text-white hover:bg-white/15 hover:text-white",          border: "border-rose-900/30" },
  blue:    { label: "أزرق",  swatch: "bg-gradient-to-br from-blue-700 to-blue-900",      bar: "bg-gradient-to-l from-blue-900 via-blue-800 to-blue-900",               text: "text-white",     btn: "text-white hover:bg-white/15 hover:text-white",          border: "border-blue-900/30" },
  emerald: { label: "أخضر",  swatch: "bg-gradient-to-br from-emerald-700 to-emerald-900", bar: "bg-gradient-to-l from-emerald-900 via-emerald-800 to-emerald-900",     text: "text-white",     btn: "text-white hover:bg-white/15 hover:text-white",          border: "border-emerald-900/30" },
  amber:   { label: "ذهبي",  swatch: "bg-gradient-to-br from-amber-500 to-amber-700",    bar: "bg-gradient-to-l from-amber-700 via-amber-600 to-amber-700",            text: "text-white",     btn: "text-white hover:bg-white/15 hover:text-white",          border: "border-amber-700/30" },
  purple:  { label: "بنفسجي", swatch: "bg-gradient-to-br from-purple-700 to-purple-900", bar: "bg-gradient-to-l from-purple-900 via-purple-800 to-purple-900",         text: "text-white",     btn: "text-white hover:bg-white/15 hover:text-white",          border: "border-purple-900/30" },
  slate:   { label: "رمادي", swatch: "bg-gradient-to-br from-slate-700 to-slate-900",    bar: "bg-gradient-to-l from-slate-900 via-slate-800 to-slate-900",            text: "text-white",     btn: "text-white hover:bg-white/15 hover:text-white",          border: "border-slate-900/30" },
  teal:    { label: "تركواز", swatch: "bg-gradient-to-br from-teal-700 to-teal-900",     bar: "bg-gradient-to-l from-teal-900 via-teal-800 to-teal-900",               text: "text-white",     btn: "text-white hover:bg-white/15 hover:text-white",          border: "border-teal-900/30" },
};
export const HEADER_COLOR_KEYS: HeaderColor[] =
  ["white", "rose", "blue", "emerald", "amber", "purple", "slate", "teal"];
export const DEFAULT_HEADER_COLOR: HeaderColor = "white";

/* ────────────────────────────── Footer palette ─────────────────────────── */
export type FooterColor =
  | "slate" | "white" | "rose" | "blue" | "emerald" | "amber" | "purple" | "teal";

export const FOOTER_THEMES: Record<FooterColor, {
  label: string;
  swatch: string;
  bg: string;
  text: string;
  border: string;
  toneDiscount: string;
  toneVat: string;
  toneCommission: string;
}> = {
  slate:   { label: "رمادي", swatch: "bg-slate-800",                              bg: "bg-slate-800",   text: "text-white",     border: "border-slate-700",   toneDiscount: "text-orange-300", toneVat: "text-amber-300",  toneCommission: "text-purple-300" },
  white:   { label: "أبيض",  swatch: "bg-white border border-slate-300",          bg: "bg-white",       text: "text-slate-900", border: "border-slate-300",   toneDiscount: "text-orange-700", toneVat: "text-amber-800",  toneCommission: "text-purple-800" },
  rose:    { label: "وردي",  swatch: "bg-rose-800",                               bg: "bg-rose-800",    text: "text-white",     border: "border-rose-700",    toneDiscount: "text-orange-200", toneVat: "text-amber-200",  toneCommission: "text-pink-200" },
  blue:    { label: "أزرق",  swatch: "bg-blue-800",                               bg: "bg-blue-800",    text: "text-white",     border: "border-blue-700",    toneDiscount: "text-orange-200", toneVat: "text-amber-200",  toneCommission: "text-purple-200" },
  emerald: { label: "أخضر",  swatch: "bg-emerald-800",                            bg: "bg-emerald-800", text: "text-white",     border: "border-emerald-700", toneDiscount: "text-orange-200", toneVat: "text-amber-200",  toneCommission: "text-purple-200" },
  amber:   { label: "ذهبي",  swatch: "bg-amber-700",                              bg: "bg-amber-700",   text: "text-white",     border: "border-amber-600",   toneDiscount: "text-orange-100", toneVat: "text-yellow-100", toneCommission: "text-purple-200" },
  purple:  { label: "بنفسجي", swatch: "bg-purple-800",                            bg: "bg-purple-800",  text: "text-white",     border: "border-purple-700",  toneDiscount: "text-orange-200", toneVat: "text-amber-200",  toneCommission: "text-pink-200" },
  teal:    { label: "تركواز", swatch: "bg-teal-800",                              bg: "bg-teal-800",    text: "text-white",     border: "border-teal-700",    toneDiscount: "text-orange-200", toneVat: "text-amber-200",  toneCommission: "text-purple-200" },
};
export const FOOTER_COLOR_KEYS: FooterColor[] =
  ["slate", "white", "rose", "blue", "emerald", "amber", "purple", "teal"];
export const DEFAULT_FOOTER_COLOR: FooterColor = "slate";

/* ─────────────────────────── Pagination options ────────────────────────── */
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 250, 0] as const;
export type PageSize = typeof PAGE_SIZE_OPTIONS[number];
export const DEFAULT_PAGE_SIZE: PageSize = 25;

/* ─────────────────────────── Per-column filter ─────────────────────────── */
export type ColType = "text" | "num" | "none";

/**
 * Match a single cell value against a per-column query.
 * `num` columns understand `>=N`, `<=N`, `>N`, `<N`, `=N`, or substring.
 */
export function matchCol(raw: unknown, q: string, type: ColType): boolean {
  const filter = q.trim();
  if (!filter) return true;
  if (type === "none") return true;
  if (type === "num") {
    const m = filter.match(/^\s*(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)\s*$/);
    const num = Number(raw ?? 0);
    if (m) {
      const op = m[1]; const v = Number(m[2]);
      if (Number.isNaN(num) || Number.isNaN(v)) return false;
      switch (op) {
        case ">=": return num >= v;
        case "<=": return num <= v;
        case ">":  return num >  v;
        case "<":  return num <  v;
        case "=":  return Math.abs(num - v) < 1e-9;
      }
    }
    return String(num).includes(filter);
  }
  return String(raw ?? "").toLowerCase().includes(filter.toLowerCase());
}

/* ─────────────────────────── CSV helpers ───────────────────────────────── */
/**
 * Defang a single CSV cell to prevent CSV-formula injection (a.k.a. CSV
 * injection / DDE). Spreadsheet apps execute cells whose first non-whitespace
 * character is one of `= + - @ TAB CR`, which lets attacker-controlled
 * fields (notes, customer names from imports, etc.) run arbitrary
 * formulas — and in some configurations even shell out via DDE.
 *
 * We prefix offending cells with a single quote so Excel / Numbers / LibreOffice
 * treat them as literal text. Numbers are re-emitted as numerals (the leading
 * `-` of a negative number is also a formula trigger, so they get prefixed too,
 * which is the OWASP-recommended treatment).
 */
function safeCsvCell(c: string | number | null | undefined): string {
  const s = c == null ? "" : String(c);
  const trimmed = s.replace(/^[\s\uFEFF\u200B-\u200D]+/, "");
  const first = trimmed.charAt(0);
  const needsDefang = first === "=" || first === "+" || first === "-"
    || first === "@" || first === "\t" || first === "\r";
  const safe = needsDefang ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function downloadCsv(filename: string, header: string[], rows: (string | number)[][]) {
  const csv = [header, ...rows]
    .map(r => r.map(safeCsvCell).join(","))
    .join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ─────────────────────────── Layout hook ───────────────────────────────── */
/** A row id we'll track for selection. Numeric or string PKs both work. */
export type RowId = number | string;

export interface AuditGridLayout {
  /** Ordered list of "data" column keys (excluding fixed lead/tail). */
  dataOrder: string[];
  setDataOrder: (next: string[]) => void;
  moveCol: (key: string, dir: -1 | 1) => void;
  /** Hidden data column keys (view-only — exports still include them). */
  hiddenCols: string[];
  hiddenSet: Set<string>;
  setHiddenCols: (next: string[] | ((prev: string[]) => string[])) => void;
  /** Toggle a single data column's visibility (fixed lead/tail never hide). */
  toggleColHidden: (key: string) => void;
  /** Un-hide every column. */
  showAllCols: () => void;
  /** Header theme (palette + classes). */
  headerColor: HeaderColor;
  setHeaderColor: (c: HeaderColor) => void;
  theme: typeof HEADER_THEMES[HeaderColor];
  /** Footer (totals row) theme. */
  footerColor: FooterColor;
  setFooterColor: (c: FooterColor) => void;
  footerTheme: typeof FOOTER_THEMES[FooterColor];
  /** Pagination state. `pageSize === 0` means "show all". */
  pageSize: PageSize;
  setPageSize: (n: PageSize) => void;
  page: number;
  setPage: (n: number | ((p: number) => number)) => void;
  /** Per-column pixel widths set via the resize grip. */
  colWidths: Record<string, number>;
  setColWidths: (next: Record<string, number> | ((prev: Record<string, number>) => Record<string, number>)) => void;
  /** Per-column filter strings (excel-style row under the header). */
  colFilters: Record<string, string>;
  setColFilter: (key: string, value: string) => void;
  clearColFilters: () => void;
  /** True when the user has any non-default customization saved. */
  hasCustomLayout: boolean;
  /** Reset everything (order/colors/page-size/widths/filters) to defaults. */
  resetLayout: () => void;
  /** Coerce an arbitrary number to the closest valid PageSize. */
  sanitizePageSize: (n: unknown) => PageSize;
  /* ── Row selection (non-persistent) ──
     Tracked as a Set so toggle/has() are O(1). NOT persisted to LS — a fresh
     visit (or tenant switch) starts with an empty selection, matching how
     SalesAuditGrid behaves. */
  selected: Set<RowId>;
  setSelected: (next: Set<RowId> | ((prev: Set<RowId>) => Set<RowId>)) => void;
  isSelected: (id: RowId) => boolean;
  toggleRow: (id: RowId) => void;
  /** Toggle every id in `ids` (typically the FILTERED set). */
  toggleAll: (ids: readonly RowId[]) => void;
  /** True iff every id in `ids` is currently selected (and `ids` is non-empty). */
  isAllSelected: (ids: readonly RowId[]) => boolean;
  /** True iff some-but-not-all of `ids` are selected (indeterminate state). */
  isSomeSelected: (ids: readonly RowId[]) => boolean;
  clearSelection: () => void;
}

export interface AuditGridLayoutOpts {
  /** Identifies the screen, e.g. `"customerSettlement"`. Mixed into LS key. */
  screenSlug: string;
  /** Active company id (per-tenant). `undefined` for superadmin → "anon". */
  cid: number | undefined;
  /** Reorderable data column keys (excludes fixed lead/tail like _sel/_act). */
  dataKeys: readonly string[];
  /** All column keys including fixed lead/tail — used to validate widths LS. */
  allColKeys: readonly string[];
}

/**
 * Per-screen, per-tenant audit-grid layout state with localStorage persistence.
 * Mirrors the SalesAuditGrid behaviour bit-for-bit so every screen using this
 * hook gets identical UX: same defaults, same sanitizers, same rehydrate
 * semantics on tenant switch.
 */
export function useAuditGridLayout(opts: AuditGridLayoutOpts): AuditGridLayout {
  const { screenSlug, cid, dataKeys, allColKeys } = opts;
  const LS_KEY = `${screenSlug}.layout.v1.c${cid ?? "anon"}`;

  const dataKeysArr = useMemo(() => [...dataKeys], [dataKeys]);
  const allColKeysSet = useMemo(() => new Set(allColKeys), [allColKeys]);

  /* ── Sanitizers ── */
  const sanitizeOrder = (input: unknown): string[] => {
    if (!Array.isArray(input)) return [...dataKeysArr];
    const seen = new Set<string>();
    const valid = (input as unknown[]).filter(
      (k): k is string => typeof k === "string" && dataKeysArr.includes(k) && !seen.has(k) && (seen.add(k), true)
    );
    for (const k of dataKeysArr) if (!seen.has(k)) valid.push(k);
    return valid;
  };
  const sanitizeColor = (c: unknown): HeaderColor =>
    HEADER_COLOR_KEYS.includes(c as HeaderColor) ? (c as HeaderColor) : DEFAULT_HEADER_COLOR;
  const sanitizeFooterColor = (c: unknown): FooterColor =>
    FOOTER_COLOR_KEYS.includes(c as FooterColor) ? (c as FooterColor) : DEFAULT_FOOTER_COLOR;
  const sanitizePageSize = (n: unknown): PageSize =>
    (PAGE_SIZE_OPTIONS as readonly number[]).includes(n as number) ? (n as PageSize) : DEFAULT_PAGE_SIZE;
  const sanitizeColWidths = (w: unknown): Record<string, number> => {
    if (!w || typeof w !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(w as Record<string, unknown>)) {
      if (!allColKeysSet.has(k)) continue;
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) continue;
      out[k] = Math.max(36, Math.min(800, Math.round(n)));
    }
    return out;
  };
  // Hidden columns — only data keys may be hidden; dedupe + drop unknown keys.
  const sanitizeHidden = (input: unknown): string[] => {
    if (!Array.isArray(input)) return [];
    const seen = new Set<string>();
    return (input as unknown[]).filter(
      (k): k is string => typeof k === "string" && dataKeysArr.includes(k) && !seen.has(k) && (seen.add(k), true)
    );
  };

  /* ── State (hydrated lazily from LS) ── */
  const [dataOrder, setDataOrder] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return sanitizeOrder(JSON.parse(raw)?.dataOrder);
    } catch { /* ignore */ }
    return [...dataKeysArr];
  });
  const [hiddenCols, setHiddenCols] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return sanitizeHidden(JSON.parse(raw)?.hiddenCols);
    } catch { /* ignore */ }
    return [];
  });
  const hiddenSet = useMemo(() => new Set(hiddenCols), [hiddenCols]);
  const [headerColor, setHeaderColor] = useState<HeaderColor>(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return sanitizeColor(JSON.parse(raw)?.headerColor);
    } catch { /* ignore */ }
    return DEFAULT_HEADER_COLOR;
  });
  const [footerColor, setFooterColor] = useState<FooterColor>(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return sanitizeFooterColor(JSON.parse(raw)?.footerColor);
    } catch { /* ignore */ }
    return DEFAULT_FOOTER_COLOR;
  });
  const [pageSize, setPageSize] = useState<PageSize>(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return sanitizePageSize(JSON.parse(raw)?.pageSize);
    } catch { /* ignore */ }
    return DEFAULT_PAGE_SIZE;
  });
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return sanitizeColWidths(JSON.parse(raw)?.colWidths);
    } catch { /* ignore */ }
    return {};
  });
  /** colFilters are intentionally NOT persisted — they reset every visit. */
  const [colFilters, setColFilters] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  /** Selection: non-persistent, cleared on tenant switch. */
  const [selected, setSelected] = useState<Set<RowId>>(() => new Set());

  const theme = HEADER_THEMES[headerColor];
  const footerTheme = FOOTER_THEMES[footerColor];

  const hasCustomLayout = useMemo(() => {
    if (headerColor !== DEFAULT_HEADER_COLOR) return true;
    if (footerColor !== DEFAULT_FOOTER_COLOR) return true;
    if (pageSize !== DEFAULT_PAGE_SIZE) return true;
    if (dataOrder.length !== dataKeysArr.length) return true;
    if (Object.keys(colWidths).length > 0) return true;
    if (hiddenCols.length > 0) return true;
    return dataOrder.some((k, i) => k !== dataKeysArr[i]);
  }, [dataOrder, hiddenCols, headerColor, footerColor, pageSize, colWidths, dataKeysArr]);

  /* ── Persist on change ── */
  useEffect(() => {
    try {
      if (hasCustomLayout) {
        localStorage.setItem(LS_KEY, JSON.stringify({ dataOrder, hiddenCols, headerColor, footerColor, pageSize, colWidths }));
      } else {
        localStorage.removeItem(LS_KEY);
      }
    } catch { /* ignore quota */ }
  }, [dataOrder, hiddenCols, headerColor, footerColor, pageSize, colWidths, hasCustomLayout, LS_KEY]);

  /* ── Re-hydrate when tenant changes ──
     `colFilters` is non-persistent UI state; we MUST clear it on tenant
     switch so a previous tenant's active filters don't silently hide rows
     in the new tenant's view. */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        setDataOrder(sanitizeOrder(parsed?.dataOrder));
        setHiddenCols(sanitizeHidden(parsed?.hiddenCols));
        setHeaderColor(sanitizeColor(parsed?.headerColor));
        setFooterColor(sanitizeFooterColor(parsed?.footerColor));
        setPageSize(sanitizePageSize(parsed?.pageSize));
        setColWidths(sanitizeColWidths(parsed?.colWidths));
        setColFilters({});
        setSelected(new Set());
        setPage(1);
        return;
      }
      setDataOrder([...dataKeysArr]);
      setHiddenCols([]);
      setHeaderColor(DEFAULT_HEADER_COLOR);
      setFooterColor(DEFAULT_FOOTER_COLOR);
      setPageSize(DEFAULT_PAGE_SIZE);
      setColWidths({});
      setColFilters({});
      setSelected(new Set());
      setPage(1);
    } catch { /* ignore corrupt LS */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid]);

  function moveCol(key: string, dir: -1 | 1) {
    setDataOrder((prev) => {
      const i = prev.indexOf(key);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  function toggleColHidden(key: string) {
    if (!dataKeysArr.includes(key)) return; // fixed lead/tail never hide
    setHiddenCols((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);
  }
  function showAllCols() { setHiddenCols([]); }
  function setColFilter(key: string, value: string) {
    setColFilters((prev) => ({ ...prev, [key]: value }));
  }
  function clearColFilters() { setColFilters({}); }
  function resetLayout() {
    setDataOrder([...dataKeysArr]);
    setHiddenCols([]);
    setHeaderColor(DEFAULT_HEADER_COLOR);
    setFooterColor(DEFAULT_FOOTER_COLOR);
    setPageSize(DEFAULT_PAGE_SIZE);
    setColWidths({});
    setColFilters({});
    setSelected(new Set());
    setPage(1);
  }

  /* ── Selection helpers ── */
  const isSelected = (id: RowId) => selected.has(id);
  function toggleRow(id: RowId) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  /** Toggle a *batch* of ids: if every id is already selected, deselect them
      all; otherwise add the missing ones. Mirrors Excel-style "select-all". */
  function toggleAll(ids: readonly RowId[]) {
    if (ids.length === 0) return;
    setSelected((prev) => {
      const allHave = ids.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allHave) {
        for (const id of ids) next.delete(id);
      } else {
        for (const id of ids) next.add(id);
      }
      return next;
    });
  }
  const isAllSelected = (ids: readonly RowId[]) =>
    ids.length > 0 && ids.every((id) => selected.has(id));
  const isSomeSelected = (ids: readonly RowId[]) =>
    ids.some((id) => selected.has(id)) && !isAllSelected(ids);
  function clearSelection() { setSelected(new Set()); }

  return {
    dataOrder, setDataOrder, moveCol,
    hiddenCols, hiddenSet, setHiddenCols, toggleColHidden, showAllCols,
    headerColor, setHeaderColor, theme,
    footerColor, setFooterColor, footerTheme,
    pageSize, setPageSize, page, setPage,
    colWidths, setColWidths,
    colFilters, setColFilter, clearColFilters,
    hasCustomLayout, resetLayout,
    sanitizePageSize,
    selected, setSelected, isSelected, toggleRow, toggleAll,
    isAllSelected, isSomeSelected, clearSelection,
  };
}

/* ─────────────────────────── Column-resize hook ────────────────────────── */
export interface ColumnResize {
  tableRef: React.RefObject<HTMLTableElement | null>;
  /** Returns props for a `<span>` resize-grip placed inside a `<th>`. */
  gripProps: (colKey: string, colIndex: number) => {
    role: string;
    "aria-orientation": "vertical";
    "aria-label": string;
    title: string;
    "data-testid": string;
    onPointerDown: (e: ReactPointerEvent<HTMLSpanElement>) => void;
    onDoubleClick: (e: React.MouseEvent<HTMLSpanElement>) => void;
  };
}

/**
 * Excel-style column resize: drag the trailing edge of any header cell, or
 * double-click it to auto-fit. Returns props you spread onto a `<span>` inside
 * the `<th>`. RTL-aware (drag LEFT in RTL increases width).
 *
 * Pass the same `setColWidths` you got from `useAuditGridLayout`.
 */
export function useColumnResize(
  setColWidths: AuditGridLayout["setColWidths"],
): ColumnResize {
  const tableRef = useRef<HTMLTableElement | null>(null);

  // Defensive teardown: if unmounted mid-drag, clear body cursor/select.
  useEffect(() => () => {
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  function startColResize(e: ReactPointerEvent<HTMLSpanElement>, colKey: string) {
    e.preventDefault();
    e.stopPropagation();
    const grip = e.currentTarget;
    const th = grip.closest("th") as HTMLElement | null;
    const startWidth = th?.getBoundingClientRect().width ?? 80;
    const startX = e.clientX;
    const isRtl = (document.documentElement.dir || "ltr").toLowerCase() === "rtl";
    try { grip.setPointerCapture(e.pointerId); } catch { /* older browsers */ }

    const onMove = (ev: PointerEvent) => {
      const delta = isRtl ? (startX - ev.clientX) : (ev.clientX - startX);
      const next = Math.max(36, Math.min(800, Math.round(startWidth + delta)));
      setColWidths((prev) => (prev[colKey] === next ? prev : { ...prev, [colKey]: next }));
    };
    const onUp = (ev: PointerEvent) => {
      try { grip.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function autoFitColumn(colIndex: number, colKey: string) {
    const table = tableRef.current;
    if (!table) return;
    const cells = table.querySelectorAll<HTMLTableCellElement>(`tr > *:nth-child(${colIndex + 1})`);
    let max = 36;
    cells.forEach((cell) => {
      const prevWhite = cell.style.whiteSpace;
      const prevMax = cell.style.maxWidth;
      cell.style.whiteSpace = "nowrap";
      cell.style.maxWidth = "none";
      const w = cell.scrollWidth;
      cell.style.whiteSpace = prevWhite;
      cell.style.maxWidth = prevMax;
      if (w > max) max = w;
    });
    const next = Math.max(36, Math.min(800, Math.ceil(max + 18)));
    setColWidths((prev) => ({ ...prev, [colKey]: next }));
  }

  function gripProps(colKey: string, colIndex: number) {
    return {
      role: "separator" as const,
      "aria-orientation": "vertical" as const,
      "aria-label": `تغيير عرض العمود: ${colKey}`,
      title: "اسحب لتغيير العرض، أو ضغطة مزدوجة للضبط التلقائي",
      "data-testid": `col-resize-${colKey}`,
      onPointerDown: (e: ReactPointerEvent<HTMLSpanElement>) => startColResize(e, colKey),
      onDoubleClick: (e: React.MouseEvent<HTMLSpanElement>) => {
        e.preventDefault(); e.stopPropagation();
        autoFitColumn(colIndex, colKey);
      },
    };
  }

  return { tableRef, gripProps };
}
