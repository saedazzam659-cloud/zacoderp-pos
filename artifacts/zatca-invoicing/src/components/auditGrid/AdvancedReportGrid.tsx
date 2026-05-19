/**
 * AdvancedReportGrid — generic, reusable audit-style data grid for any
 * report screen. Carries the same UX as SalesAuditGrid but is decoupled
 * from the sales-invoice domain so it can sit inside customer/supplier
 * statements, trial balance, account statement, sales report, etc.
 *
 * Features (all opt-in via props):
 *   - Global search across stringified row values.
 *   - Per-column advanced filter (AND/OR) via shared <AdvFilterPopover/>.
 *   - 3-state sort on column header (asc → desc → none).
 *   - Column reorder (popover) persisted per (slug, tenant) in LS.
 *   - Header / footer color themes (8 palettes, persisted).
 *   - Pagination (10/25/50/100/250/all).
 *   - Group-by single column with per-group subtotals.
 *   - Conditional formatting (one or more value rules → cell bg color).
 *   - Optional leading/total rows passed as plain JSX (used for the
 *     "opening balance" + "الإجمالي" rows in statement screens).
 *   - Optional toolbar slot for parent-supplied buttons (Excel/PDF export).
 *
 * The grid is screen-only (the toolbar/footer carry `print:hidden`); the
 * parent is expected to keep a static printable table for paper output
 * so the print/PDF layout never depends on grid state.
 *
 * Persistence keys:
 *   `${slug}.layout.v1.c${cid|anon}`           — layout (handled by useAuditGridLayout)
 *   `${slug}.condFormat.v1.c${cid|anon}`       — conditional formatting rules
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Search, Layers, Sparkles, RotateCcw, X, ArrowUp, ArrowDown, ArrowUpDown, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  useAuditGridLayout,
  type ColType,
} from "@/lib/auditGridLayout";
import {
  isAdvActive, matchAdv, describeAdv,
  type AdvFilter,
} from "@/lib/advFilter";
import {
  HeaderColorPicker, FooterColorPicker, ColumnReorderPopover,
  AuditGridPagination,
  type ColumnDescriptor,
} from "./AuditGridControls";
import { AdvFilterPopover } from "./AdvFilterPopover";

/* ─────────────────────────── Column descriptor ─────────────────────────── */
export interface GridColumn<R> {
  key: string;
  label: string;
  /** Drives the advanced-filter operator set + sort comparator. */
  type: ColType;
  align?: "start" | "end" | "center";
  /** Optional default pixel width (overridable by user resize via colWidths). */
  width?: number;
  /** Optional td class (e.g. "font-mono tabular-nums"). */
  className?: string;
  /** Pull the raw value for sort/filter/group/export. Required. */
  value: (row: R) => string | number | null | undefined;
  /** Render JSX for the cell. Defaults to `String(value())`. */
  render?: (row: R) => ReactNode;
  /** True ⇒ this column appears in totals row when caller asks. Numeric only. */
  totalable?: boolean;
}

/* ─────────────────────────── Conditional formatting ───────────────────── */
export type CondOp = "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "between";
export interface CondFormatRule {
  id: string;
  colKey: string;
  op: CondOp;
  v1: string;
  v2?: string;
  bg: string; // tailwind bg class
  label: string; // human label of the palette
}

const COND_PALETTE: { bg: string; label: string }[] = [
  { bg: "bg-rose-100 text-rose-900",       label: "وردي" },
  { bg: "bg-amber-100 text-amber-900",     label: "ذهبي" },
  { bg: "bg-emerald-100 text-emerald-900", label: "أخضر" },
  { bg: "bg-sky-100 text-sky-900",         label: "سماوي" },
  { bg: "bg-purple-100 text-purple-900",   label: "بنفسجي" },
  { bg: "bg-slate-200 text-slate-900",     label: "رمادي" },
];

const COND_OPS: { value: CondOp; label: string; needsV2?: boolean }[] = [
  { value: "gt",      label: "أكبر من" },
  { value: "gte",     label: "أكبر أو يساوي" },
  { value: "lt",      label: "أصغر من" },
  { value: "lte",     label: "أصغر أو يساوي" },
  { value: "eq",      label: "يساوي" },
  { value: "neq",     label: "لا يساوي" },
  { value: "between", label: "بين", needsV2: true },
];

function evalCondRule(raw: unknown, r: CondFormatRule, type: ColType): boolean {
  if (type === "num") {
    const n = Number(raw ?? 0);
    const a = Number(r.v1);
    const b = Number(r.v2 ?? 0);
    if (!Number.isFinite(n) || !Number.isFinite(a)) return false;
    switch (r.op) {
      case "gt":      return n >  a;
      case "gte":     return n >= a;
      case "lt":      return n <  a;
      case "lte":     return n <= a;
      case "eq":      return Math.abs(n - a) < 1e-9;
      case "neq":     return Math.abs(n - a) >= 1e-9;
      case "between": return Number.isFinite(b) && n >= Math.min(a, b) && n <= Math.max(a, b);
    }
  }
  const s = String(raw ?? "").toLowerCase();
  const v = String(r.v1).toLowerCase();
  switch (r.op) {
    case "eq":  return s === v;
    case "neq": return s !== v;
    case "gt":  return s >  v;
    case "gte": return s >= v;
    case "lt":  return s <  v;
    case "lte": return s <= v;
    default:    return false;
  }
}

/** Persisted conditional-formatting rules per (slug, cid).
 *
 *  Re-hydrates whenever (slug, cid) changes, mirroring `useAuditGridLayout`'s
 *  tenant-switch semantics. Without this, a tenant switch would leave the
 *  previous tenant's rules in component state and silently overwrite the
 *  newly-visited tenant's stored rules on the next mutation. */
function useCondFormatRules(slug: string, cid: number | undefined) {
  const KEY = `${slug}.condFormat.v1.c${cid ?? "anon"}`;
  const parse = (raw: string | null): CondFormatRule[] => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((r): r is CondFormatRule =>
        r && typeof r.id === "string" && typeof r.colKey === "string"
          && typeof r.op === "string" && typeof r.bg === "string"
      );
    } catch { return []; }
  };
  const [rules, setRules] = useState<CondFormatRule[]>(() => {
    try { return parse(localStorage.getItem(KEY)); } catch { return []; }
  });
  // Tracks the last persisted KEY so we can distinguish "real change to
  // rules" from "key just changed because tenant switched" — only the former
  // should write to LS.
  const lastKeyRef = useRef(KEY);
  // Re-hydrate state on tenant/slug change BEFORE the persistence effect runs.
  useEffect(() => {
    if (lastKeyRef.current === KEY) return;
    lastKeyRef.current = KEY;
    try { setRules(parse(localStorage.getItem(KEY))); } catch { setRules([]); }
  }, [KEY]);
  // Persist only when (a) the KEY matches what's currently mounted (not
  // mid-rehydration) and (b) the rules actually represent the user's state
  // for that tenant.
  useEffect(() => {
    if (lastKeyRef.current !== KEY) return; // skip the render where key just changed
    try {
      if (rules.length === 0) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, JSON.stringify(rules));
    } catch { /* ignore quota */ }
  }, [KEY, rules]);
  return [rules, setRules] as const;
}

/* ─────────────────────────── Conditional-format popover ───────────────── */
interface CondFormatPopoverProps<R> {
  columns: GridColumn<R>[];
  rules: CondFormatRule[];
  setRules: (next: CondFormatRule[]) => void;
}
function CondFormatPopover<R>({ columns, rules, setRules }: CondFormatPopoverProps<R>) {
  const numericCols = columns.filter(c => c.type !== "none");
  const addRule = () => {
    const firstCol = numericCols[0] ?? columns[0];
    if (!firstCol) return;
    const palette = COND_PALETTE[rules.length % COND_PALETTE.length];
    setRules([
      ...rules,
      {
        id: Math.random().toString(36).slice(2, 9),
        colKey: firstCol.key,
        op: firstCol.type === "num" ? "gt" : "eq",
        v1: "",
        bg: palette.bg,
        label: palette.label,
      },
    ]);
  };
  const updateRule = (id: string, patch: Partial<CondFormatRule>) =>
    setRules(rules.map(r => r.id === id ? { ...r, ...patch } : r));
  const removeRule = (id: string) => setRules(rules.filter(r => r.id !== id));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs gap-1 text-slate-700 hover:bg-slate-100"
          title="تنسيق شرطي"
        >
          <Sparkles className="h-3.5 w-3.5" />
          التنسيق الشرطي
          {rules.length > 0 && (
            <span className="ms-1 inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-purple-500 text-white text-[10px] font-bold">
              {rules.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-96 p-0" dir="rtl">
        <div className="px-3 py-2 border-b bg-gradient-to-l from-purple-50 to-pink-50 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-slate-800 font-semibold text-xs">
            <Sparkles className="h-3.5 w-3.5 text-purple-600" />
            قواعد التنسيق الشرطي
          </div>
          {rules.length > 0 && (
            <Button type="button" size="sm" variant="ghost"
              className="h-6 px-2 text-[11px] text-slate-600 gap-1"
              onClick={() => setRules([])}
              title="مسح كل القواعد">
              <RotateCcw className="h-3 w-3" />
              مسح
            </Button>
          )}
        </div>
        <div className="p-2 max-h-80 overflow-y-auto space-y-2">
          {rules.length === 0 && (
            <p className="text-[11px] text-slate-500 text-center py-6 px-2">
              لا توجد قواعد. أضف قاعدة لتلوين الخلايا التي تطابق شرطاً معيناً (مثلاً: الرصيد &gt; 1000 → أحمر).
            </p>
          )}
          {rules.map(r => {
            const col = columns.find(c => c.key === r.colKey);
            const opMeta = COND_OPS.find(o => o.value === r.op);
            const isNum = (col?.type ?? "text") === "num";
            return (
              <div key={r.id} className={cn("rounded-md border p-2 space-y-1.5", r.bg)}>
                <div className="flex items-center gap-1">
                  <select
                    value={r.colKey}
                    onChange={e => updateRule(r.id, { colKey: e.target.value })}
                    className="h-7 text-[11px] px-1.5 rounded border border-slate-300 bg-white text-slate-800 flex-1 min-w-0"
                  >
                    {columns.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                  <select
                    value={r.op}
                    onChange={e => updateRule(r.id, { op: e.target.value as CondOp })}
                    className="h-7 text-[11px] px-1.5 rounded border border-slate-300 bg-white text-slate-800"
                  >
                    {COND_OPS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <Button type="button" size="icon" variant="ghost"
                    className="h-7 w-7 text-rose-700 hover:bg-rose-100"
                    onClick={() => removeRule(r.id)}
                    title="حذف القاعدة">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="flex items-center gap-1">
                  <Input
                    type={isNum ? "number" : "text"}
                    value={r.v1}
                    onChange={e => updateRule(r.id, { v1: e.target.value })}
                    placeholder="القيمة"
                    className="h-7 text-[11px] flex-1 bg-white"
                  />
                  {opMeta?.needsV2 && (
                    <>
                      <span className="text-[11px] text-slate-600">إلى</span>
                      <Input
                        type={isNum ? "number" : "text"}
                        value={r.v2 ?? ""}
                        onChange={e => updateRule(r.id, { v2: e.target.value })}
                        placeholder="القيمة الثانية"
                        className="h-7 text-[11px] flex-1 bg-white"
                      />
                    </>
                  )}
                </div>
                <div className="flex items-center gap-1 flex-wrap pt-1 border-t border-white/60">
                  <span className="text-[10px] text-slate-700">اللون:</span>
                  {COND_PALETTE.map(p => (
                    <button
                      type="button"
                      key={p.bg}
                      onClick={() => updateRule(r.id, { bg: p.bg, label: p.label })}
                      className={cn(
                        "h-5 px-1.5 rounded text-[10px] border transition-all",
                        p.bg,
                        r.bg === p.bg ? "ring-2 ring-slate-700 ring-offset-1" : "opacity-70 hover:opacity-100",
                      )}
                      title={p.label}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="px-3 py-2 border-t bg-slate-50 flex items-center justify-between">
          <span className="text-[10px] text-slate-500">يحفظ تلقائياً لكل شركة</span>
          <Button type="button" size="sm" onClick={addRule}
            className="h-7 px-2 text-[11px] bg-purple-600 hover:bg-purple-500 text-white gap-1">
            <Plus className="h-3 w-3" />
            إضافة قاعدة
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ─────────────────────────── Group-by select ───────────────────────────── */
interface GroupByProps<R> {
  columns: GridColumn<R>[];
  value: string | "";
  onChange: (v: string | "") => void;
}
function GroupBySelect<R>({ columns, value, onChange }: GroupByProps<R>) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <Layers className="h-3.5 w-3.5 text-slate-500" />
      <span className="text-slate-600 font-medium hidden sm:inline">تجميع حسب:</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value as string | "")}
        className="h-7 text-xs px-2 rounded border border-slate-300 bg-white text-slate-700 cursor-pointer hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
      >
        <option value="">— بدون تجميع —</option>
        {columns.filter(c => c.type !== "none").map(c => (
          <option key={c.key} value={c.key}>{c.label}</option>
        ))}
      </select>
      {value && (
        <Button
          type="button" size="icon" variant="ghost"
          className="h-6 w-6 text-slate-400 hover:text-slate-700"
          onClick={() => onChange("")}
          title="إلغاء التجميع"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

/* ─────────────────────────── Sort cycle helper ─────────────────────────── */
type SortState = { key: string; dir: "asc" | "desc" } | null;
function cycleSort(prev: SortState, key: string): SortState {
  if (!prev || prev.key !== key) return { key, dir: "asc" };
  if (prev.dir === "asc") return { key, dir: "desc" };
  return null;
}

/* ─────────────────────────── Main component ────────────────────────────── */
export interface AdvancedReportGridProps<R> {
  /** Identifier for LS persistence (e.g. "customerStatementGrid"). */
  slug: string;
  /** Active company id; tenants get isolated layouts. */
  cid?: number;
  /** Ordered list of columns. Order can be overridden by user via reorder popover. */
  columns: GridColumn<R>[];
  /** Stable id for each row (used as react key + selection key). */
  rowKey: (row: R, index: number) => number | string;
  /** Source rows. The grid filters/sorts/groups/pages internally. */
  rows: R[];
  /** Optional row(s) rendered above the data (e.g. "opening balance"). Not
   *  filtered/sorted. JSX is rendered inside a <tr> spanning all visible cols
   *  if no per-column map is supplied; supply `leadingCells` for cell-aligned
   *  rendering. */
  leadingRows?: Array<Partial<Record<string, ReactNode>> & { __className?: string }>;
  /** Optional totals row. Same shape as a leading row but rendered in <tfoot>.
   *  `__label` (if present) is placed in the FIRST visible column. */
  totalsRow?: (Partial<Record<string, ReactNode>> & { __label?: ReactNode; __className?: string }) | null;
  /** Pagination unit word, e.g. "حركة", "سجل", "فاتورة". */
  unitLabel?: string;
  /** Empty-state Arabic message. */
  emptyMessage?: string;
  /** Slot for parent buttons (Excel/PDF export, refresh, etc) at the END of the toolbar. */
  toolbarExtras?: ReactNode;
  /** Optional row-level conditional className based on the row itself. */
  rowClassName?: (row: R) => string;
}

export default function AdvancedReportGrid<R>({
  slug, cid, columns, rowKey, rows,
  leadingRows = [],
  totalsRow = null,
  unitLabel = "سجل",
  emptyMessage = "لا توجد بيانات",
  toolbarExtras,
  rowClassName,
}: AdvancedReportGridProps<R>) {
  /* ── Layout (order / colors / page-size) ─────────────────────────────── */
  const allKeys = useMemo(() => columns.map(c => c.key), [columns]);
  const layout = useAuditGridLayout({
    screenSlug: slug,
    cid,
    dataKeys: allKeys,
    allColKeys: allKeys,
  });

  /* ── Local UI state ──────────────────────────────────────────────────── */
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>(null);
  const [colAdv, setColAdv] = useState<Record<string, AdvFilter>>({});
  const [groupBy, setGroupBy] = useState<string | "">("");
  const [rules, setRules] = useCondFormatRules(slug, cid);

  /* ── Resolved columns (in user order, only known keys) ───────────────── */
  const orderedColumns = useMemo(() => {
    const byKey = new Map(columns.map(c => [c.key, c]));
    return layout.dataOrder
      .map(k => byKey.get(k))
      .filter((c): c is GridColumn<R> => Boolean(c));
  }, [columns, layout.dataOrder]);

  const columnDescriptors: ColumnDescriptor[] = useMemo(
    () => columns.map(c => ({ key: c.key, label: c.label })),
    [columns],
  );

  /* ── Reset page on filter/sort/search change to avoid empty pages ────── */
  useEffect(() => { layout.setPage(1); }, [search, sort, colAdv, groupBy]); // eslint-disable-line

  /* ── Filter → sort pipeline ──────────────────────────────────────────── */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      // Global search across all column values.
      if (q) {
        const haystack = orderedColumns
          .map(c => String(c.value(r) ?? "").toLowerCase())
          .join(" ");
        if (!haystack.includes(q)) return false;
      }
      // Per-column advanced filters.
      for (const c of orderedColumns) {
        const adv = colAdv[c.key];
        if (isAdvActive(adv) && !matchAdv(c.value(r), adv, c.type)) return false;
      }
      return true;
    });
  }, [rows, orderedColumns, search, colAdv]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const col = orderedColumns.find(c => c.key === sort.key);
    if (!col) return filtered;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = col.value(a);
      const vb = col.value(b);
      if (col.type === "num") {
        const na = Number(va ?? 0);
        const nb = Number(vb ?? 0);
        return (na - nb) * dir;
      }
      return String(va ?? "").localeCompare(String(vb ?? ""), "ar") * dir;
    });
  }, [filtered, sort, orderedColumns]);

  /* ── Group-by (optional) ─────────────────────────────────────────────── */
  type Group = { key: string; label: string; rows: R[] };
  const groups: Group[] | null = useMemo(() => {
    if (!groupBy) return null;
    const col = orderedColumns.find(c => c.key === groupBy);
    if (!col) return null;
    const byVal = new Map<string, R[]>();
    for (const r of sorted) {
      const v = String(col.value(r) ?? "—");
      if (!byVal.has(v)) byVal.set(v, []);
      byVal.get(v)!.push(r);
    }
    return [...byVal.entries()].map(([k, list]) => ({ key: k, label: k, rows: list }));
  }, [sorted, groupBy, orderedColumns]);

  /* ── Pagination ──────────────────────────────────────────────────────── */
  // When grouping is active we paginate over GROUPS, not rows, so groups
  // don't get split across pages.
  const pageSize = layout.pageSize;
  const totalRows = groups ? groups.length : sorted.length;
  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(totalRows / pageSize));
  const safePage = Math.min(layout.page, totalPages);
  useEffect(() => { if (layout.page !== safePage) layout.setPage(safePage); }, [safePage, layout]);
  const pageStart = totalRows === 0 ? 0 : (pageSize === 0 ? 1 : (safePage - 1) * pageSize + 1);
  const pageEnd = pageSize === 0 ? totalRows : Math.min(totalRows, safePage * pageSize);

  const pagedRows: R[] = useMemo(() => {
    if (groups) return [];
    if (pageSize === 0) return sorted;
    return sorted.slice((safePage - 1) * pageSize, safePage * pageSize);
  }, [sorted, groups, safePage, pageSize]);

  const pagedGroups: Group[] = useMemo(() => {
    if (!groups) return [];
    if (pageSize === 0) return groups;
    return groups.slice((safePage - 1) * pageSize, safePage * pageSize);
  }, [groups, safePage, pageSize]);

  /* ── Conditional formatting per (row, col) ───────────────────────────── */
  const cellBgFor = (row: R, col: GridColumn<R>): string => {
    for (const r of rules) {
      if (r.colKey !== col.key) continue;
      if (evalCondRule(col.value(row), r, col.type)) return r.bg;
    }
    return "";
  };

  /* ── Group subtotals (sum numeric/totalable cols within group) ───────── */
  const groupSubtotals = (rows: R[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const c of orderedColumns) {
      if (!c.totalable || c.type !== "num") continue;
      out[c.key] = rows.reduce((s, r) => s + (Number(c.value(r)) || 0), 0);
    }
    return out;
  };

  /* ── Render helpers ──────────────────────────────────────────────────── */
  const { fmt } = useFmtSafe();
  const visibleCount = orderedColumns.length;
  const sortIconFor = (k: string) => {
    if (!sort || sort.key !== k) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    return sort.dir === "asc"
      ? <ArrowUp className="h-3 w-3 text-amber-300" />
      : <ArrowDown className="h-3 w-3 text-amber-300" />;
  };

  return (
    <div className="rounded-lg border border-slate-200 overflow-hidden bg-white">
      {/* ─── Toolbar ─────────────────────────────────────────────────── */}
      <div className={cn(
        "px-3 py-2 border-b border-slate-200 flex items-center gap-2 flex-wrap print:hidden",
        layout.theme.bar, layout.theme.text,
      )}>
        {/* Search */}
        <div className="relative flex-1 min-w-[180px] max-w-[280px]">
          <Search className={cn("absolute top-1/2 -translate-y-1/2 h-3.5 w-3.5", "end-2 text-slate-400")} />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="بحث في جميع الأعمدة…"
            className="h-7 text-xs pe-7 bg-white text-slate-800 placeholder:text-slate-400 border-slate-300"
            aria-label="بحث"
          />
        </div>

        <GroupBySelect columns={orderedColumns} value={groupBy} onChange={setGroupBy} />

        <ColumnReorderPopover layout={layout} isRtl columns={columnDescriptors} />

        <CondFormatPopover columns={orderedColumns} rules={rules} setRules={setRules} />

        <HeaderColorPicker layout={layout} isRtl />
        <FooterColorPicker layout={layout} isRtl />

        <div className="flex-1" />

        {toolbarExtras}
      </div>

      {/* ─── Active-filter chip strip ────────────────────────────────── */}
      {(Object.keys(colAdv).some(k => isAdvActive(colAdv[k])) || search) && (
        <div className="px-3 py-1.5 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-900 flex items-center gap-2 flex-wrap print:hidden">
          <span className="font-semibold">فلاتر نشطة:</span>
          {search && (
            <span className="px-2 py-0.5 rounded-full bg-white border border-amber-300 inline-flex items-center gap-1">
              بحث: {search}
              <button onClick={() => setSearch("")} className="text-amber-600 hover:text-amber-900" aria-label="مسح البحث">
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          {orderedColumns.map(c => {
            const a = colAdv[c.key];
            if (!isAdvActive(a)) return null;
            return (
              <span key={c.key} className="px-2 py-0.5 rounded-full bg-white border border-amber-300 inline-flex items-center gap-1">
                {c.label}: {describeAdv(a, c.type)}
                <button
                  onClick={() => setColAdv(p => { const n = { ...p }; delete n[c.key]; return n; })}
                  className="text-amber-600 hover:text-amber-900"
                  aria-label={`مسح فلتر ${c.label}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            );
          })}
          <button
            onClick={() => { setSearch(""); setColAdv({}); }}
            className="ms-auto text-amber-700 underline text-[11px] hover:text-amber-900"
          >
            مسح الكل
          </button>
        </div>
      )}

      {/* ─── Table ───────────────────────────────────────────────────── */}
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px] border-collapse min-w-[480px]">
          {/* Column widths via colgroup so resize/auto-fit can apply later. */}
          <colgroup>
            {orderedColumns.map(c => (
              <col key={c.key} style={layout.colWidths[c.key]
                ? { width: layout.colWidths[c.key] }
                : c.width ? { width: c.width } : undefined} />
            ))}
          </colgroup>

          <thead className={cn(layout.theme.bar, layout.theme.text)}>
            <tr>
              {orderedColumns.map(c => {
                const advActive = isAdvActive(colAdv[c.key]);
                const align = c.align === "end" ? "text-end" : c.align === "center" ? "text-center" : "text-start";
                return (
                  <th
                    key={c.key}
                    className={cn("px-3 py-2 font-semibold border-b border-white/20 select-none", align)}
                  >
                    <div className="flex items-center gap-1 justify-between">
                      <button
                        type="button"
                        onClick={() => setSort(p => cycleSort(p, c.key))}
                        className="flex items-center gap-1 hover:underline cursor-pointer min-w-0"
                        title={`ترتيب حسب ${c.label}`}
                      >
                        <span className="truncate">{c.label}</span>
                        {sortIconFor(c.key)}
                      </button>
                      {c.type !== "none" && (
                        <AdvFilterPopover
                          colLabel={c.label}
                          colType={c.type}
                          value={colAdv[c.key]}
                          onApply={v => setColAdv(p => ({ ...p, [c.key]: v }))}
                          onClear={() => setColAdv(p => { const n = { ...p }; delete n[c.key]; return n; })}
                          active={advActive}
                        />
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {/* Leading rows (e.g. opening balance) — always shown first. */}
            {leadingRows.map((row, i) => (
              <tr key={`__lead_${i}`} className={cn("bg-amber-50/40 border-t border-slate-200", row.__className)}>
                {orderedColumns.map(c => (
                  <td key={c.key} className={cn(
                    "px-3 py-2",
                    c.align === "end" ? "text-end" : c.align === "center" ? "text-center" : "text-start",
                    c.className,
                  )}>
                    {row[c.key] ?? "—"}
                  </td>
                ))}
              </tr>
            ))}

            {/* Body */}
            {groups
              ? (pagedGroups.length === 0 ? (
                  <tr>
                    <td colSpan={Math.max(1, visibleCount)} className="py-10 text-center text-slate-400 italic">
                      {emptyMessage}
                    </td>
                  </tr>
                ) : pagedGroups.map(g => {
                  const sub = groupSubtotals(g.rows);
                  return (
                    <GroupBlock
                      key={g.key}
                      group={g}
                      orderedColumns={orderedColumns}
                      subtotals={sub}
                      rowKey={rowKey}
                      rowClassName={rowClassName}
                      cellBgFor={cellBgFor}
                      fmt={fmt}
                    />
                  );
                }))
              : (pagedRows.length === 0 ? (
                  <tr>
                    <td colSpan={Math.max(1, visibleCount)} className="py-10 text-center text-slate-400 italic">
                      {emptyMessage}
                    </td>
                  </tr>
                ) : (
                  pagedRows.map((r, i) => (
                    <tr key={rowKey(r, i) ?? i}
                        className={cn("border-t border-slate-200 even:bg-slate-50/40 hover:bg-sky-50/40 transition-colors",
                                      rowClassName?.(r))}>
                      {orderedColumns.map(c => {
                        const bg = cellBgFor(r, c);
                        return (
                          <td key={c.key} className={cn(
                            "px-3 py-2",
                            c.align === "end" ? "text-end" : c.align === "center" ? "text-center" : "text-start",
                            c.className,
                            bg,
                          )}>
                            {c.render ? c.render(r) : String(c.value(r) ?? "")}
                          </td>
                        );
                      })}
                    </tr>
                  ))
                ))
            }
          </tbody>

          {/* Totals row */}
          {totalsRow && (
            <tfoot>
              <tr className={cn("border-t-2 font-bold", layout.footerTheme.bg, layout.footerTheme.text, layout.footerTheme.border, totalsRow.__className)}>
                {orderedColumns.map((c, idx) => {
                  // First cell gets the label IF totalsRow.__label is set
                  // AND this column doesn't already define an explicit value.
                  if (idx === 0 && totalsRow.__label != null && totalsRow[c.key] == null) {
                    return (
                      <td key={c.key} className={cn(
                        "px-3 py-2",
                        c.align === "end" ? "text-end" : c.align === "center" ? "text-center" : "text-start",
                      )}>
                        {totalsRow.__label}
                      </td>
                    );
                  }
                  return (
                    <td key={c.key} className={cn(
                      "px-3 py-2",
                      c.align === "end" ? "text-end" : c.align === "center" ? "text-center" : "text-start",
                      c.className,
                    )}>
                      {totalsRow[c.key] ?? "—"}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* ─── Pagination strip ────────────────────────────────────────── */}
      <AuditGridPagination
        layout={layout}
        totalRows={totalRows}
        pageStart={pageStart}
        pageEnd={pageEnd}
        totalPages={totalPages}
        unitLabel={unitLabel}
      />
    </div>
  );
}

/* ─────────────────────────── Group block ───────────────────────────────── */
interface GroupBlockProps<R> {
  group: { key: string; label: string; rows: R[] };
  orderedColumns: GridColumn<R>[];
  subtotals: Record<string, number>;
  rowKey: (row: R, index: number) => number | string;
  rowClassName?: (row: R) => string;
  cellBgFor: (row: R, col: GridColumn<R>) => string;
  fmt: (n: number) => string;
}
function GroupBlock<R>({ group, orderedColumns, subtotals, rowKey, rowClassName, cellBgFor, fmt }: GroupBlockProps<R>) {
  return (
    <>
      <tr className="bg-blue-50 border-t-2 border-blue-300 text-blue-900 font-bold">
        <td colSpan={orderedColumns.length} className="px-3 py-1.5 text-start text-[12px]">
          <Layers className="inline h-3.5 w-3.5 ms-0 me-1 align-text-bottom" />
          {group.label}
          <span className="ms-2 text-blue-600 font-normal">({group.rows.length})</span>
        </td>
      </tr>
      {group.rows.map((r, i) => (
        <tr key={rowKey(r, i) ?? `${group.key}_${i}`}
            className={cn("border-t border-slate-200 even:bg-slate-50/40 hover:bg-sky-50/40", rowClassName?.(r))}>
          {orderedColumns.map(c => {
            const bg = cellBgFor(r, c);
            return (
              <td key={c.key} className={cn(
                "px-3 py-2",
                c.align === "end" ? "text-end" : c.align === "center" ? "text-center" : "text-start",
                c.className,
                bg,
              )}>
                {c.render ? c.render(r) : String(c.value(r) ?? "")}
              </td>
            );
          })}
        </tr>
      ))}
      {/* Group subtotal row */}
      <tr className="bg-blue-100/60 border-t border-blue-200 text-blue-900 font-semibold">
        {orderedColumns.map((c, idx) => (
          <td key={c.key} className={cn(
            "px-3 py-1.5 text-[11.5px]",
            c.align === "end" ? "text-end" : c.align === "center" ? "text-center" : "text-start",
            c.className,
          )}>
            {idx === 0
              ? `إجمالي ${group.label}`
              : subtotals[c.key] != null
                ? fmt(subtotals[c.key])
                : ""}
          </td>
        ))}
      </tr>
    </>
  );
}

/* ─────────────────────────── Tiny fmt fallback ─────────────────────────── */
// Avoid coupling the grid to a specific i18n hook — fall back to a simple
// 2-decimal formatter so the grid stays standalone-renderable.
function useFmtSafe(): { fmt: (n: number) => string } {
  return {
    fmt: (n: number) =>
      Number.isFinite(n)
        ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : "0.00",
  };
}
