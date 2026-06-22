/**
 * SalesAuditGrid
 * ──────────────
 * "الجرد الخارجي لفواتير المبيعات" — wide ERP-style spreadsheet view of all
 * sales invoices for review/audit. Mirrors the dense-grid layout of legacy
 * Saudi accounting software (the second reference screenshot) with many
 * narrow columns visible at once and a sticky dark toolbar at the top.
 *
 * Includes an "AI audit" button that calls POST /api/ai/audit-sales-invoices
 * to surface anomalies (VAT mismatches, missing customers, posted-without-JE,
 * ZATCA rejections, abnormally large totals, old drafts, open receivables)
 * and AI-generated recommendations. The result opens in a side Sheet.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { saveUiPrefs } from "@/lib/uiPrefsApi";
import { useToast } from "@/hooks/use-toast";
import { useFormatters } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  ArrowRight, RefreshCw, Sparkles, Printer, FileSpreadsheet,
  ListChecks, AlertTriangle, AlertCircle, Info, Loader2, Eye,
  CheckCircle2, FileText, Plus, Send, Undo2, RotateCcw, X, Filter,
  Trash2, Settings2, ArrowUp, ArrowDown, RotateCw, EyeOff, Palette, Check,
  Copy, Pencil, FileDown, User, Filter as FilterIcon,
} from "lucide-react";
import { Label } from "@/components/ui/label";
import SalesPrintModal, { type PrintData } from "./SalesPrintModal";
import { exportToExcel, exportToPDF, type ExportColumn } from "@/lib/export";
import MultiBranchFilter from "@/components/MultiBranchFilter";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { inventoryApi } from "@/lib/inventoryApi";
import { useFieldPolicy } from "@/hooks/useInvoiceFieldPolicy";

// ── Header color theme palette ────────────────────────────────────────────
// Default is "white" (light header with dark text). Selecting any other color
// switches to a dark gradient toolbar. Theme is persisted per-tenant in
// localStorage alongside the column order.
type HeaderColor = "white" | "rose" | "blue" | "emerald" | "amber" | "purple" | "slate" | "teal";
const HEADER_THEMES: Record<HeaderColor, {
  label: string;
  swatch: string;       // small preview swatch (used in picker)
  bar: string;          // <div> classes for the top bar
  text: string;         // text/heading color on bar
  btn: string;          // ghost button text+hover on bar
  border: string;       // outer border around the toolbar wrapper
}> = {
  white:   { label: "أبيض",  swatch: "bg-white border border-slate-300",          bar: "bg-white",                                                              text: "text-slate-800", btn: "text-slate-700 hover:bg-slate-100 hover:text-slate-900", border: "border-slate-300" },
  rose:    { label: "وردي",  swatch: "bg-gradient-to-br from-rose-700 to-rose-900",     bar: "bg-gradient-to-l from-rose-900 via-rose-800 to-rose-900",         text: "text-white",     btn: "text-white hover:bg-white/15 hover:text-white",          border: "border-rose-900/30" },
  blue:    { label: "أزرق",  swatch: "bg-gradient-to-br from-blue-700 to-blue-900",     bar: "bg-gradient-to-l from-blue-900 via-blue-800 to-blue-900",         text: "text-white",     btn: "text-white hover:bg-white/15 hover:text-white",          border: "border-blue-900/30" },
  emerald: { label: "أخضر",  swatch: "bg-gradient-to-br from-emerald-700 to-emerald-900", bar: "bg-gradient-to-l from-emerald-900 via-emerald-800 to-emerald-900", text: "text-white",     btn: "text-white hover:bg-white/15 hover:text-white",          border: "border-emerald-900/30" },
  amber:   { label: "ذهبي",  swatch: "bg-gradient-to-br from-amber-500 to-amber-700",   bar: "bg-gradient-to-l from-amber-700 via-amber-600 to-amber-700",      text: "text-white",     btn: "text-white hover:bg-white/15 hover:text-white",          border: "border-amber-700/30" },
  purple:  { label: "بنفسجي", swatch: "bg-gradient-to-br from-purple-700 to-purple-900", bar: "bg-gradient-to-l from-purple-900 via-purple-800 to-purple-900",   text: "text-white",     btn: "text-white hover:bg-white/15 hover:text-white",          border: "border-purple-900/30" },
  slate:   { label: "رمادي", swatch: "bg-gradient-to-br from-slate-700 to-slate-900",   bar: "bg-gradient-to-l from-slate-900 via-slate-800 to-slate-900",      text: "text-white",     btn: "text-white hover:bg-white/15 hover:text-white",          border: "border-slate-900/30" },
  teal:    { label: "تركواز", swatch: "bg-gradient-to-br from-teal-700 to-teal-900",     bar: "bg-gradient-to-l from-teal-900 via-teal-800 to-teal-900",         text: "text-white",     btn: "text-white hover:bg-white/15 hover:text-white",          border: "border-teal-900/30" },
};
const HEADER_COLOR_KEYS: HeaderColor[] = ["white", "rose", "blue", "emerald", "amber", "purple", "slate", "teal"];
const DEFAULT_HEADER_COLOR: HeaderColor = "white";

// ── Footer (totals row) palette ───────────────────────────────────────────
// Independent from the header palette so the user can mix-and-match (e.g.
// white header + dark slate footer, or matching colors). Each entry styles
// the sticky <tfoot> row at the bottom of the grid: background, text color,
// border between cells, and the per-metric "tones" used to highlight
// discount / VAT / commission totals.
type FooterColor = "slate" | "white" | "rose" | "blue" | "emerald" | "amber" | "purple" | "teal";
const FOOTER_THEMES: Record<FooterColor, {
  label: string;
  swatch: string;        // small preview swatch (used in picker)
  bg: string;            // <tfoot tr> background classes
  text: string;          // base text color on the row
  border: string;        // border classes between cells
  toneDiscount: string;  // accent color for the "خصم" total
  toneVat: string;       // accent color for the "ضريبة" total
  toneCommission: string;// accent color for the "عمولة" total
}> = {
  slate:   { label: "رمادي", swatch: "bg-slate-800",                              bg: "bg-slate-800",   text: "text-white",       border: "border-slate-700",   toneDiscount: "text-orange-300", toneVat: "text-amber-300",  toneCommission: "text-purple-300" },
  white:   { label: "أبيض",  swatch: "bg-white border border-slate-300",          bg: "bg-white",       text: "text-slate-900",   border: "border-slate-300",   toneDiscount: "text-orange-700", toneVat: "text-amber-800",  toneCommission: "text-purple-800" },
  rose:    { label: "وردي",  swatch: "bg-rose-800",                               bg: "bg-rose-800",    text: "text-white",       border: "border-rose-700",    toneDiscount: "text-orange-200", toneVat: "text-amber-200",  toneCommission: "text-pink-200" },
  blue:    { label: "أزرق",  swatch: "bg-blue-800",                               bg: "bg-blue-800",    text: "text-white",       border: "border-blue-700",    toneDiscount: "text-orange-200", toneVat: "text-amber-200",  toneCommission: "text-purple-200" },
  emerald: { label: "أخضر",  swatch: "bg-emerald-800",                            bg: "bg-emerald-800", text: "text-white",       border: "border-emerald-700", toneDiscount: "text-orange-200", toneVat: "text-amber-200",  toneCommission: "text-purple-200" },
  amber:   { label: "ذهبي",  swatch: "bg-amber-700",                              bg: "bg-amber-700",   text: "text-white",       border: "border-amber-600", toneDiscount: "text-orange-100", toneVat: "text-yellow-100", toneCommission: "text-purple-200" },
  purple:  { label: "بنفسجي", swatch: "bg-purple-800",                            bg: "bg-purple-800",  text: "text-white",       border: "border-purple-700",  toneDiscount: "text-orange-200", toneVat: "text-amber-200",  toneCommission: "text-pink-200" },
  teal:    { label: "تركواز", swatch: "bg-teal-800",                              bg: "bg-teal-800",    text: "text-white",       border: "border-teal-700",    toneDiscount: "text-orange-200", toneVat: "text-amber-200",  toneCommission: "text-purple-200" },
};
const FOOTER_COLOR_KEYS: FooterColor[] = ["slate", "white", "rose", "blue", "emerald", "amber", "purple", "teal"];
const DEFAULT_FOOTER_COLOR: FooterColor = "slate";

// ── Page-size options for the audit grid ──────────────────────────────────
// `0` means "show all" — useful when the user wants to scan/audit everything
// at once or print without paging. Default is 25 — large enough to be useful,
// small enough to keep the DOM responsive on slow devices.
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 250, 0] as const;
type PageSize = typeof PAGE_SIZE_OPTIONS[number];
const DEFAULT_PAGE_SIZE: PageSize = 25;
import { cn } from "@/lib/utils";
import {
  rowToneFor,
  SEL_TONE,
  DocColorLegend,
  buildToneTooltip,
  type LegendItem,
} from "@/lib/docRowTone";
import { DateField } from "@/components/ui/date-field";

// ── Column descriptor ─────────────────────────────────────────────────────
// Drives header, per-column filter row, and footer alignment. Keys match the
// `colFilters` state and the `matchCol()` matcher below.
type ColType = "text" | "num" | "none";
const COLUMNS: ReadonlyArray<{ key: string; label: string; type: ColType; align?: "start" | "center" | "end" }> = [
  { key: "_sel",       label: "",           type: "none",   align: "center" },
  { key: "_idx",       label: "#",          type: "none",   align: "center" },
  { key: "doc",        label: "رقم الفاتورة", type: "text",  align: "center" },
  { key: "date",       label: "التاريخ",    type: "text",   align: "center" },
  { key: "customer",   label: "العميل",     type: "text",   align: "start"  },
  { key: "vat",        label: "الرقم الضريبي", type: "text", align: "center" },
  { key: "phone",      label: "هاتف العميل", type: "text",  align: "center" },
  { key: "branch",     label: "الفرع",      type: "text",   align: "center" },
  { key: "rep",        label: "المندوب",    type: "text",   align: "center" },
  { key: "payment",    label: "نوع الدفع",  type: "text",   align: "center" },
  { key: "currency",   label: "العملة",     type: "text",   align: "center" },
  { key: "freeQty",    label: "الكمية المجانية", type: "num", align: "end"    },
  { key: "subtotal",   label: "المجموع",    type: "num",    align: "end"    },
  { key: "discount",   label: "الخصم",      type: "num",    align: "end"    },
  { key: "vatAmt",     label: "الضريبة",    type: "num",    align: "end"    },
  { key: "total",      label: "الإجمالي",   type: "num",    align: "end"    },
  { key: "netAfterDiscount", label: "الإجمالي بعد الخصم", type: "num", align: "end" },
  { key: "commission", label: "العمولة",    type: "num",    align: "end"    },
  { key: "settle",     label: "حالة السداد", type: "text",  align: "center" },
  { key: "je",         label: "القيد",      type: "text",   align: "center" },
  { key: "zatca",      label: "ZATCA",      type: "text",   align: "center" },
  { key: "status",     label: "الحالة",     type: "text",   align: "center" },
  { key: "createdBy",  label: "أنشأه",       type: "text",   align: "center" },
  { key: "postedBy",   label: "رحّله",       type: "text",   align: "center" },
  { key: "notes",      label: "ملاحظات",    type: "text",   align: "start"  },
  { key: "_act",       label: "",           type: "none",   align: "center" },
];

// ── Advanced per-column filter ────────────────────────────────────────────
// Excel-style two-condition filter with AND/OR connector. Replaces the
// legacy quick-input row. Operators differ per column type (text vs num).
type AdvOp =
  | "contains" | "ncontains" | "eq" | "neq" | "starts" | "ends"
  | "empty" | "nempty"
  | "gt" | "gte" | "lt" | "lte" | "between";
type AdvCond = { op: AdvOp; v: string; v2?: string };
type AdvFilter = { c1: AdvCond; conn: "and" | "or"; c2: AdvCond };
const DEFAULT_TEXT_COND: AdvCond = { op: "contains", v: "" };
const DEFAULT_NUM_COND: AdvCond = { op: "eq", v: "" };
const defaultAdv = (type: ColType): AdvFilter => {
  const c = type === "num" ? DEFAULT_NUM_COND : DEFAULT_TEXT_COND;
  return { c1: { ...c }, conn: "and", c2: { ...c } };
};
const TEXT_OPS: ReadonlyArray<{ value: AdvOp; label: string; needsValue: boolean }> = [
  { value: "contains",  label: "يحتوي على",    needsValue: true  },
  { value: "ncontains", label: "لا يحتوي على", needsValue: true  },
  { value: "eq",        label: "يساوي",        needsValue: true  },
  { value: "neq",       label: "لا يساوي",     needsValue: true  },
  { value: "starts",    label: "يبدأ بـ",      needsValue: true  },
  { value: "ends",      label: "ينتهي بـ",     needsValue: true  },
  { value: "empty",     label: "فارغ",         needsValue: false },
  { value: "nempty",    label: "غير فارغ",     needsValue: false },
];
const NUM_OPS: ReadonlyArray<{ value: AdvOp; label: string; needsValue: boolean; needsV2?: boolean }> = [
  { value: "eq",      label: "يساوي",        needsValue: true  },
  { value: "neq",     label: "لا يساوي",     needsValue: true  },
  { value: "gt",      label: "أكبر من",      needsValue: true  },
  { value: "gte",     label: "أكبر أو يساوي", needsValue: true },
  { value: "lt",      label: "أصغر من",      needsValue: true  },
  { value: "lte",     label: "أصغر أو يساوي", needsValue: true },
  { value: "between", label: "بين",          needsValue: true, needsV2: true },
  { value: "empty",   label: "فارغ",         needsValue: false },
  { value: "nempty",  label: "غير فارغ",     needsValue: false },
];
const OPS_FOR = (t: ColType) => (t === "num" ? NUM_OPS : TEXT_OPS);
// "Is this single condition meaningful enough to filter?" — empty/nempty
// always count, between needs both endpoints, others need a non-empty value.
const isCondActive = (c: AdvCond | undefined): boolean => {
  if (!c?.op) return false;
  if (c.op === "empty" || c.op === "nempty") return true;
  if (c.op === "between") return c.v !== "" && (c.v2 ?? "") !== "";
  return c.v !== "";
};
const isAdvActive = (a: AdvFilter | undefined): boolean =>
  !!a && (isCondActive(a.c1) || isCondActive(a.c2));
// Returns true/false if the condition applies, or null when it should be
// skipped (no value entered) so the rest of the expression decides.
function evalCond(raw: any, c: AdvCond | undefined, type: ColType): boolean | null {
  if (!c?.op) return null;
  if (c.op === "empty")  return raw == null || String(raw).trim() === "";
  if (c.op === "nempty") return !(raw == null || String(raw).trim() === "");
  if (type === "num") {
    if (c.op === "between") {
      if (c.v === "" || (c.v2 ?? "") === "") return null;
      const num = Number(raw ?? 0);
      const a = Number(c.v); const b = Number(c.v2);
      if (!Number.isFinite(num) || !Number.isFinite(a) || !Number.isFinite(b)) return false;
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      return num >= lo && num <= hi;
    }
    if (c.v === "") return null;
    const num = Number(raw ?? 0);
    const v = Number(c.v);
    if (!Number.isFinite(num) || !Number.isFinite(v)) return false;
    switch (c.op) {
      case "eq":  return Math.abs(num - v) < 1e-9;
      case "neq": return Math.abs(num - v) >= 1e-9;
      case "gt":  return num >  v;
      case "gte": return num >= v;
      case "lt":  return num <  v;
      case "lte": return num <= v;
      default:    return null;
    }
  }
  if (c.v === "") return null;
  const s = String(raw ?? "").toLowerCase();
  const q = c.v.toLowerCase();
  switch (c.op) {
    case "contains":  return s.includes(q);
    case "ncontains": return !s.includes(q);
    case "eq":        return s === q;
    case "neq":       return s !== q;
    case "starts":    return s.startsWith(q);
    case "ends":      return s.endsWith(q);
    default:          return null;
  }
}
// Build a one-line human summary of an active condition, used in the
// header tooltip when a filter is applied so the user can recall what
// they set without opening the popover.
function describeCond(c: AdvCond, type: ColType): string {
  const ops = OPS_FOR(type);
  const lbl = ops.find(o => o.value === c.op)?.label ?? c.op;
  if (c.op === "empty" || c.op === "nempty") return lbl;
  if (c.op === "between") return `${lbl} ${c.v} - ${c.v2 ?? ""}`;
  return `${lbl} "${c.v}"`;
}
function describeAdv(adv: AdvFilter | undefined, type: ColType): string {
  if (!isAdvActive(adv)) return "";
  const a1 = isCondActive(adv!.c1) ? describeCond(adv!.c1, type) : "";
  const a2 = isCondActive(adv!.c2) ? describeCond(adv!.c2, type) : "";
  if (a1 && a2) return `${a1}  ${adv!.conn === "or" ? "أو" : "و"}  ${a2}`;
  return a1 || a2;
}

function matchAdv(raw: any, adv: AdvFilter | undefined, type: ColType): boolean {
  if (!adv) return true;
  const r1 = evalCond(raw, adv.c1, type);
  const r2 = evalCond(raw, adv.c2, type);
  if (r1 == null && r2 == null) return true;
  if (r1 == null) return r2!;
  if (r2 == null) return r1;
  return adv.conn === "or" ? (r1 || r2) : (r1 && r2);
}

// Numeric filter: supports `>=N`, `<=N`, `>N`, `<N`, `=N`, or plain substring.
// (Legacy — kept for any callers that still pass a raw string filter.)
function matchCol(raw: any, q: string, type: ColType): boolean {
  const filter = q.trim();
  if (!filter) return true;
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

// ── AdvFilterPopover — the per-column "attractive filter" dialog ─────────
// Excel-style two-condition filter with AND/OR connector. Triggered from
// the funnel icon in each column header.
function AdvFilterPopover(props: {
  colKey: string;
  colLabel: string;
  colType: ColType;
  value: AdvFilter | undefined;
  onApply: (v: AdvFilter) => void;
  onClear: () => void;
  active: boolean;
}) {
  const { colKey, colLabel, colType, value, onApply, onClear, active } = props;
  const [open, setOpen] = useState(false);
  // Local draft so the user can tweak without instantly re-filtering the
  // grid on every keystroke — only "تطبيق" commits the change.
  const [draft, setDraft] = useState<AdvFilter>(() => value ?? defaultAdv(colType));
  // Re-seed the draft each time the popover opens so it reflects the most
  // recently-applied state (or the column-type default if cleared).
  useEffect(() => {
    if (open) setDraft(value ?? defaultAdv(colType));
  }, [open, value, colType]);

  const ops = OPS_FOR(colType);
  const cond1Meta = ops.find(o => o.value === draft.c1.op);
  const cond2Meta = ops.find(o => o.value === draft.c2.op);
  const updateC1 = (patch: Partial<AdvCond>) => setDraft(d => ({ ...d, c1: { ...d.c1, ...patch } }));
  const updateC2 = (patch: Partial<AdvCond>) => setDraft(d => ({ ...d, c2: { ...d.c2, ...patch } }));

  const renderCondInputs = (
    cond: AdvCond,
    meta: typeof cond1Meta,
    update: (p: Partial<AdvCond>) => void,
  ) => {
    if (!meta?.needsValue) return null;
    if ((meta as any).needsV2) {
      return (
        <div className="flex items-center gap-1.5">
          <Input
            value={cond.v}
            onChange={e => update({ v: e.target.value })}
            placeholder="من"
            type={colType === "num" ? "number" : "text"}
            className="h-8 text-xs flex-1"
          />
          <span className="text-slate-400 text-xs">-</span>
          <Input
            value={cond.v2 ?? ""}
            onChange={e => update({ v2: e.target.value })}
            placeholder="إلى"
            type={colType === "num" ? "number" : "text"}
            className="h-8 text-xs flex-1"
          />
        </div>
      );
    }
    return (
      <Input
        value={cond.v}
        onChange={e => update({ v: e.target.value })}
        placeholder="القيمة…"
        type={colType === "num" ? "number" : "text"}
        className="h-8 text-xs"
      />
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={e => e.stopPropagation()}
          aria-label={`فلتر العمود: ${colLabel}`}
          title={active ? `فلتر مفعل` : "فتح فلتر العمود"}
          className={cn(
            "ms-0.5 inline-flex items-center justify-center w-5 h-5 rounded-md border transition-all",
            active
              ? "bg-rose-600 text-white border-rose-700 shadow ring-2 ring-rose-200"
              : "bg-white/70 text-slate-500 border-slate-300 opacity-60 hover:opacity-100 hover:bg-amber-50 hover:text-amber-700 hover:border-amber-400",
          )}
        >
          <FilterIcon className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        side="bottom"
        sideOffset={6}
        className="w-80 p-0 overflow-hidden shadow-2xl border-slate-300"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 bg-gradient-to-l from-rose-50 to-amber-50 border-b border-slate-200">
          <div className="flex items-center gap-1.5 text-slate-800 font-semibold text-xs">
            <FilterIcon className="h-3.5 w-3.5 text-rose-600" />
            <span>فلتر: {colLabel}</span>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="إغلاق"
            className="text-slate-400 hover:text-slate-700 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-3 space-y-3 bg-white">
          {/* Condition 1 */}
          <div className="space-y-1.5">
            <Label className="text-[10.5px] text-slate-500 font-normal">شرط 1</Label>
            <select
              value={draft.c1.op}
              onChange={e => updateC1({ op: e.target.value as AdvOp, v: "", v2: "" })}
              className="w-full h-8 text-xs px-2 rounded-md border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-rose-200 focus:border-rose-400"
            >
              {ops.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {renderCondInputs(draft.c1, cond1Meta, updateC1)}
          </div>

          {/* Connector */}
          <div className="flex items-center gap-2">
            <div className="flex-1 h-px bg-slate-200" />
            <select
              value={draft.conn}
              onChange={e => setDraft(d => ({ ...d, conn: e.target.value as "and" | "or" }))}
              className={cn(
                "h-7 text-[11px] px-2 rounded-full border font-semibold cursor-pointer transition-colors",
                draft.conn === "or"
                  ? "bg-amber-50 text-amber-800 border-amber-300"
                  : "bg-emerald-50 text-emerald-800 border-emerald-300",
              )}
            >
              <option value="and">و</option>
              <option value="or">أو</option>
            </select>
            <div className="flex-1 h-px bg-slate-200" />
          </div>

          {/* Condition 2 */}
          <div className="space-y-1.5">
            <Label className="text-[10.5px] text-slate-500 font-normal">شرط 2</Label>
            <select
              value={draft.c2.op}
              onChange={e => updateC2({ op: e.target.value as AdvOp, v: "", v2: "" })}
              className="w-full h-8 text-xs px-2 rounded-md border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-rose-200 focus:border-rose-400"
            >
              {ops.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {renderCondInputs(draft.c2, cond2Meta, updateC2)}
          </div>
        </div>

        {/* Footer — Clear / Close / Apply */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-50 border-t border-slate-200">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 px-3 text-xs text-slate-600 hover:bg-slate-200"
            onClick={() => { onClear(); setOpen(false); }}
          >
            مسح
          </Button>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 px-3 text-xs"
              onClick={() => setOpen(false)}
            >
              إغلاق
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8 px-4 text-xs bg-rose-600 hover:bg-rose-500 text-white"
              onClick={() => { onApply(draft); setOpen(false); }}
            >
              تطبيق
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Finding = {
  level: "error" | "warning" | "info";
  code: string;
  invoiceId?: number;
  docNumber?: string;
  message: string;
  fix?: string;
};

type AuditResponse = {
  findings: Finding[];
  metrics: {
    totalInvoices: number;
    totalPosted: number;
    totalDrafts: number;
    totalCancelled: number;
    sumPosted: number;
    sumDraft: number;
    sumVat: number;
    median: number;
    issuesCount: number;
    warningsCount: number;
  };
  recommendations: string[];
  source: "ai+rules" | "rules";
};

// ── Print helpers ──────────────────────────────────────────────────────────
// Lightweight HTML escaper for user-supplied strings interpolated into the
// print template (customer names, notes, etc.). Avoids any XSS surface in the
// new window we open with document.write().
function escHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function fmtNum(n: unknown, dp = 2): string {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v.toFixed(dp) : "0.00";
}
// ── Discount-aware totals ─────────────────────────────────────────────────
// Line-level discounts are folded into the stored NET `subtotal` and never
// surface on the header `discountAmount` (document-level only). The list
// endpoint ships `lineDiscountTotal` (Σ effective per-line discount) so the
// grid can show the REAL total discount and reconstruct the GROSS subtotal:
//   grossSubtotal − totalDiscount + vat = total  (reconciles).
function invLineDisc(inv: any): number { return Number(inv?.lineDiscountTotal ?? 0); }
function invGrossSubtotal(inv: any): number { return Number(inv?.subtotal ?? 0) + invLineDisc(inv); }
function invTotalDiscount(inv: any): number { return Number(inv?.discountAmount ?? 0) + invLineDisc(inv); }
type LookupMaps = {
  cusMap: Record<string | number, { name?: string; vat?: string; phone?: string } | undefined>;
  branchMap: Record<string | number, string | undefined>;
  repMap: Record<string | number, string | undefined>;
};

// Build a self-contained printable HTML document for the selected invoices.
// Each invoice fits on its own page (page-break-after: always) and shows the
// header info (number/date/customer/branch/rep/payment) plus a line-items
// table and totals block — the actual INVOICE CONTENTS, not the grid view.
function buildBulkPrintHtml(invoices: any[], maps: LookupMaps): string {
  const { cusMap, branchMap, repMap } = maps;
  const today = new Date().toLocaleString("ar-SA");
  const sections = invoices.map((inv: any, idx: number) => {
    const cus = cusMap[inv.customerId] ?? {};
    const branch = branchMap[inv.branchId] ?? "";
    const rep = repMap[inv.salesRepId] ?? "";
    const lines: any[] = Array.isArray(inv.lines) ? inv.lines : [];
    // Line discounts are baked into the stored NET subtotal — add them back so
    // the printed "المجموع" is GROSS and "الخصم" shows the full discount
    // (header document-level + per-line), keeping subtotal − discount + vat = total.
    const lineDiscSum = lines.reduce((s: number, l: any) => {
      // Detail endpoint returns raw schema columns → quantity is `qty`.
      const gross = (Number(l.qty ?? l.quantity) || 0) * (Number(l.unitPrice) || 0);
      const amt = Math.max(0, Number(l.discountAmount) || 0);
      return s + (amt > 0 ? Math.min(amt, gross) : (gross * Math.max(0, Math.min(100, Number(l.discount) || 0))) / 100);
    }, 0);
    const printGrossSubtotal = (Number(inv.subtotal) || 0) + lineDiscSum;
    const printTotalDiscount = (Number(inv.discountAmount) || 0) + lineDiscSum;
    const payment =
      inv.paymentType === "cash" ? "نقدي" :
      inv.paymentType === "bank" ? "بنكي" : "آجل";
    const status =
      inv.status === "draft" ? "مسودة" :
      inv.status === "posted" ? "مُرحَّلة" :
      inv.status === "cancelled" ? "ملغاة" : escHtml(inv.status);
    const linesHtml = lines.length === 0
      ? `<tr><td colspan="7" class="empty">لا توجد بنود في هذه الفاتورة</td></tr>`
      : lines.map((l: any, i: number) => `
        <tr>
          <td class="c">${i + 1}</td>
          <td>${escHtml(l.descriptionAr ?? l.descriptionEn ?? l.itemName ?? l.itemCode ?? "—")}</td>
          <td class="c">${escHtml(l.itemCode ?? "—")}</td>
          <td class="c">${fmtNum(l.qty ?? l.quantity, 3)}</td>
          <td class="c">${fmtNum(l.unitPrice)}</td>
          <td class="c">${fmtNum(l.discountAmount ?? 0)}</td>
          <td class="c">${fmtNum(l.lineTotal ?? l.totalAmount ?? 0)}</td>
        </tr>`).join("");
    return `
      <section class="invoice ${idx === invoices.length - 1 ? "last" : ""}">
        <header class="head">
          <div class="title">
            <h1>فاتورة مبيعات</h1>
            <div class="docno">${escHtml(inv.docNumber ?? `SI-${inv.id}`)}</div>
          </div>
          <div class="meta">
            <div><span>التاريخ:</span> ${escHtml(inv.invoiceDate ?? "")}</div>
            <div><span>الحالة:</span> ${status}</div>
            <div><span>طريقة الدفع:</span> ${payment}</div>
            <div><span>العملة:</span> ${escHtml(inv.currencyCode ?? "SAR")}</div>
          </div>
        </header>
        <div class="parties">
          <div class="party">
            <div class="ph">العميل</div>
            <div class="pname">${escHtml(cus.name ?? "—")}</div>
            <div class="pmeta">الرقم الضريبي: ${escHtml(cus.vat ?? "—")}</div>
            <div class="pmeta">الهاتف: ${escHtml(cus.phone ?? "—")}</div>
          </div>
          <div class="party">
            <div class="ph">الفرع / المندوب</div>
            <div class="pname">${escHtml(branch || "—")}</div>
            <div class="pmeta">المندوب: ${escHtml(rep || "—")}</div>
            ${inv.journalEntryId ? `<div class="pmeta">رقم القيد: JE-${escHtml(inv.journalEntryId)}</div>` : ""}
          </div>
        </div>
        <table class="lines">
          <thead>
            <tr>
              <th style="width:40px">#</th>
              <th>الوصف</th>
              <th style="width:90px">الكود</th>
              <th style="width:70px">الكمية</th>
              <th style="width:80px">السعر</th>
              <th style="width:80px">الخصم</th>
              <th style="width:90px">الإجمالي</th>
            </tr>
          </thead>
          <tbody>${linesHtml}</tbody>
        </table>
        <div class="totals">
          <table>
            <tr><th>المجموع</th><td>${fmtNum(printGrossSubtotal)}</td></tr>
            <tr><th>الخصم</th><td>${fmtNum(printTotalDiscount)}</td></tr>
            <tr><th>ضريبة القيمة المضافة</th><td>${fmtNum(inv.vatAmount)}</td></tr>
            <tr class="grand"><th>الإجمالي النهائي</th><td>${fmtNum(inv.totalAmount)} ${escHtml(inv.currencyCode ?? "SAR")}</td></tr>
          </table>
        </div>
        ${inv.notes ? `<div class="notes"><strong>ملاحظات:</strong> ${escHtml(inv.notes)}</div>` : ""}
        <footer class="foot">طُبع بواسطة "زاكود المحاسبي" — ${escHtml(today)} — صفحة ${idx + 1} / ${invoices.length}</footer>
      </section>`;
  }).join("\n");

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>طباعة الفواتير المحدَّدة (${invoices.length})</title>
  <style>
    @page { size: A4; margin: 12mm; }
    * { box-sizing: border-box; }
    body { font-family: "Tahoma", "Arial", sans-serif; color: #1f2937; margin: 0; padding: 0; font-size: 12px; }
    .invoice { padding: 6mm 0; page-break-after: always; }
    .invoice.last { page-break-after: auto; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0f172a; padding-bottom: 6px; margin-bottom: 10px; }
    .title h1 { margin: 0; font-size: 20px; color: #0f172a; }
    .title .docno { font-size: 14px; font-weight: 700; color: #0369a1; margin-top: 2px; }
    .meta { font-size: 11px; line-height: 1.6; text-align: left; }
    .meta span { color: #64748b; margin-inline-end: 4px; }
    .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }
    .party { border: 1px solid #cbd5e1; border-radius: 6px; padding: 6px 8px; background: #f8fafc; }
    .party .ph { font-size: 10px; color: #64748b; margin-bottom: 2px; }
    .party .pname { font-weight: 700; font-size: 13px; color: #0f172a; }
    .party .pmeta { font-size: 11px; color: #475569; }
    table.lines { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
    table.lines th, table.lines td { border: 1px solid #cbd5e1; padding: 4px 6px; font-size: 11px; }
    table.lines th { background: #e2e8f0; color: #0f172a; font-weight: 700; }
    table.lines td.c { text-align: center; }
    table.lines td.empty { text-align: center; color: #94a3b8; padding: 12px; }
    .totals { display: flex; justify-content: flex-start; }
    .totals table { border-collapse: collapse; min-width: 240px; }
    .totals th, .totals td { border: 1px solid #cbd5e1; padding: 4px 8px; font-size: 12px; }
    .totals th { background: #f1f5f9; text-align: start; color: #334155; font-weight: 600; }
    .totals td { text-align: end; font-family: "Courier New", monospace; }
    .totals tr.grand th, .totals tr.grand td { background: #0f172a; color: #fff; font-weight: 800; font-size: 13px; }
    .notes { margin-top: 8px; padding: 6px 8px; border: 1px dashed #cbd5e1; border-radius: 6px; background: #fffbeb; font-size: 11px; }
    .foot { margin-top: 8px; padding-top: 6px; border-top: 1px solid #e2e8f0; font-size: 10px; color: #94a3b8; text-align: center; }
    @media print {
      .no-print { display: none !important; }
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  ${sections}
</body>
</html>`;
}

export default function SalesAuditGrid({ source = "manual", titleOverride }: { source?: "manual" | "pos" | "all"; titleOverride?: string } = {}) {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const { fmt, isRtl } = useFormatters();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const isAdmin = user?.role === "admin" || user?.role === "superadmin";
  const authH = { Authorization: `Bearer ${token}` };
  const headers = { ...authH, "Content-Type": "application/json" };

  // ── Field-policy governance (الجرد الخارجي scope) ──────────────────────
  // SuperAdmin can hide individual toolbar buttons + filters per user-profile
  // via /admin/invoice-field-policies. Admins/superadmins bypass automatically.
  const fp = useFieldPolicy("sales_audit");

  // ── Filters ────────────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "posted" | "cancelled">("all");
  // Multi-branch filter (managers only — auto-hidden for single-branch users
  // by MultiBranchFilter itself). Empty array = "all allowed branches".
  const [branchIds, setBranchIds] = useState<number[]>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // فلتر المخزن — يعرض فقط الفواتير التي تحتوي على بند واحد على الأقل
  // من المخزن المختار. "" = الكل.
  const [warehouseFilter, setWarehouseFilter] = useState<string>("");
  const [colFilters, setColFilters] = useState<Record<string, string>>({});
  // Advanced per-column filter state (two-condition with AND/OR).
  // Driven by the column-header Popover; replaces the old inline input row.
  const [colAdv, setColAdv] = useState<Record<string, AdvFilter>>({});
  // 3-state column sort: null → "asc" → "desc" → null. Only one column at
  // a time. Numeric columns sort numerically, others lexicographically.
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  const cycleSort = (key: string) => {
    setSort(prev => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null; // third click clears the sort
    });
  };

  // ── Column layout (order + visibility) — persisted in localStorage ────
  // Only "data" columns can be reordered/hidden; _sel/_idx/_act stay fixed.
  const FIXED_LEAD = ["_sel", "_idx"] as const;
  const FIXED_TAIL = ["_act"] as const;
  const DATA_KEYS = COLUMNS.filter(c => !FIXED_LEAD.includes(c.key as any) && !FIXED_TAIL.includes(c.key as any)).map(c => c.key);
  // Scope per-company so a shared browser doesn't leak layouts across tenants.
  const LS_KEY = `salesAuditGrid.layout.v1.c${cid ?? "anon"}`;
  // Stable screen slug for the durable server-side mirror (users.ui_preferences).
  // localStorage is the fast local cache; the server copy survives a cache wipe.
  const SCREEN_SLUG = "salesAuditGrid";

  // Helper — sanitize a stored dataOrder against the current column set
  // (drop unknown keys, dedupe, append missing). Forward-compatible.
  const sanitizeOrder = (input: unknown): string[] => {
    if (!Array.isArray(input)) return [...DATA_KEYS];
    const seen = new Set<string>();
    const valid = (input as string[]).filter(
      k => typeof k === "string" && DATA_KEYS.includes(k) && !seen.has(k) && (seen.add(k), true)
    );
    for (const k of DATA_KEYS) if (!seen.has(k)) valid.push(k);
    return valid;
  };
  const sanitizeColor = (c: unknown): HeaderColor =>
    HEADER_COLOR_KEYS.includes(c as HeaderColor) ? (c as HeaderColor) : DEFAULT_HEADER_COLOR;
  const sanitizeFooterColor = (c: unknown): FooterColor =>
    FOOTER_COLOR_KEYS.includes(c as FooterColor) ? (c as FooterColor) : DEFAULT_FOOTER_COLOR;
  const sanitizePageSize = (n: unknown): PageSize =>
    (PAGE_SIZE_OPTIONS as readonly number[]).includes(n as number) ? (n as PageSize) : DEFAULT_PAGE_SIZE;
  // Per-column widths (Excel-style). Keep only known column keys + sane numeric
  // bounds, so a corrupt/forward-incompatible LS payload can't blow up layout.
  const ALL_COL_KEYS = useMemo(() => COLUMNS.map(c => c.key), []);
  const sanitizeColWidths = (w: unknown): Record<string, number> => {
    if (!w || typeof w !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(w as Record<string, unknown>)) {
      if (!ALL_COL_KEYS.includes(k)) continue;
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) continue;
      out[k] = Math.max(36, Math.min(800, Math.round(n)));
    }
    return out;
  };
  // Hidden columns — only DATA_KEYS may be hidden (fixed _sel/_idx/_act never).
  // Deduped + filtered against the current column set so a stale/corrupt payload
  // can never hide a column that no longer exists.
  const sanitizeHidden = (input: unknown): string[] => {
    if (!Array.isArray(input)) return [];
    const seen = new Set<string>();
    return (input as unknown[]).filter(
      (k): k is string => typeof k === "string" && DATA_KEYS.includes(k) && !seen.has(k) && (seen.add(k), true)
    );
  };

  const [dataOrder, setDataOrder] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return sanitizeOrder(parsed?.dataOrder);
      }
    } catch { /* ignore corrupt LS */ }
    return [...DATA_KEYS];
  });

  // Hidden data columns (view-only — exports still include every column).
  const [hiddenCols, setHiddenCols] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return sanitizeHidden(parsed?.hiddenCols);
      }
    } catch { /* ignore corrupt LS */ }
    return [];
  });
  const hiddenSet = useMemo(() => new Set(hiddenCols), [hiddenCols]);

  const [headerColor, setHeaderColor] = useState<HeaderColor>(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return sanitizeColor(parsed?.headerColor);
      }
    } catch { /* ignore corrupt LS */ }
    return DEFAULT_HEADER_COLOR;
  });

  // Independent footer (totals row) color, persisted alongside the rest of the
  // layout. Backwards-compatible: missing field in LS → DEFAULT_FOOTER_COLOR.
  const [footerColor, setFooterColor] = useState<FooterColor>(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return sanitizeFooterColor(parsed?.footerColor);
      }
    } catch { /* ignore corrupt LS */ }
    return DEFAULT_FOOTER_COLOR;
  });

  const [pageSize, setPageSize] = useState<PageSize>(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return sanitizePageSize(parsed?.pageSize);
      }
    } catch { /* ignore corrupt LS */ }
    return DEFAULT_PAGE_SIZE;
  });

  // Per-column pixel widths set by the user via drag/double-click. Only keys
  // present here override the column's natural width; everything else stays
  // auto-sized. Hydrated from LS on mount and on tenant switch.
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return sanitizeColWidths(parsed?.colWidths);
      }
    } catch { /* ignore corrupt LS */ }
    return {};
  });

  // Current page is ephemeral (not persisted) — always start at 1 on mount.
  const [page, setPage] = useState(1);

  const theme = HEADER_THEMES[headerColor];
  const footerTheme = FOOTER_THEMES[footerColor];

  // True when user has any non-default customization saved.
  const hasCustomLayout = useMemo(() => {
    if (headerColor !== DEFAULT_HEADER_COLOR) return true;
    if (footerColor !== DEFAULT_FOOTER_COLOR) return true;
    if (pageSize !== DEFAULT_PAGE_SIZE) return true;
    if (dataOrder.length !== DATA_KEYS.length) return true;
    if (Object.keys(colWidths).length > 0) return true;
    if (hiddenCols.length > 0) return true;
    return dataOrder.some((k, i) => k !== DATA_KEYS[i]);
  }, [dataOrder, hiddenCols, headerColor, footerColor, pageSize, colWidths]);

  // Persist layout on change.
  useEffect(() => {
    try {
      if (hasCustomLayout) {
        localStorage.setItem(LS_KEY, JSON.stringify({ dataOrder, hiddenCols, headerColor, footerColor, pageSize, colWidths }));
      } else {
        localStorage.removeItem(LS_KEY);
      }
    } catch { /* ignore quota errors */ }
  }, [dataOrder, hiddenCols, headerColor, footerColor, pageSize, colWidths, hasCustomLayout, LS_KEY]);

  // Re-hydrate layout + colors + pageSize + colWidths when the active company
  // changes (e.g. user logs into a different tenant in the same browser tab).
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
        setPage(1);
        // Fall through (no early return): still re-arm the server-sync gate
        // below so the durable copy can override this LS cache once /me lands.
      } else {
        setDataOrder([...DATA_KEYS]);
        setHiddenCols([]);
        setHeaderColor(DEFAULT_HEADER_COLOR);
        setFooterColor(DEFAULT_FOOTER_COLOR);
        setPageSize(DEFAULT_PAGE_SIZE);
        setColWidths({});
        setPage(1);
      }
      // Re-arm server hydration for the (new) tenant: the durable server copy
      // is the source of truth and must be allowed to override the LS cache
      // above once the /me payload (user.uiPreferences) is available. Clearing
      // hydratedKey also structurally disarms the save effect below — it only
      // fires when hydratedKey === the CURRENT tenant key, so it can never PUT
      // the previous tenant's stale layout during a context switch.
      setHydratedKey(null);
    } catch { /* ignore corrupt LS */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid]);

  // ── Durable server-side layout (survives a browser cache/localStorage wipe) ──
  // The LS cache above gives an instant first paint; this effect then lets the
  // per-user server copy (users.ui_preferences, delivered on /api/auth/me) win.
  // `hydratedKey` holds the tenant key we have already applied the server copy
  // for; the save effect refuses to run until it equals the current tenant key,
  // so a SuperAdmin acting-company switch can never echo stale state upstream.
  const lastSavedRef = useRef<string | null>(null);
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;                 // wait for /me to resolve
    const key = String(cid ?? "anon");
    if (hydratedKey === key) return;   // already applied for this tenant
    const blob = (user?.uiPreferences ?? {})[SCREEN_SLUG];
    if (blob && typeof blob === "object" && !Array.isArray(blob)) {
      const order   = sanitizeOrder((blob as any).dataOrder);
      const hidden  = sanitizeHidden((blob as any).hiddenCols);
      const hColor  = sanitizeColor((blob as any).headerColor);
      const fColor  = sanitizeFooterColor((blob as any).footerColor);
      const pSize   = sanitizePageSize((blob as any).pageSize);
      const widths  = sanitizeColWidths((blob as any).colWidths);
      setDataOrder(order);
      setHiddenCols(hidden);
      setHeaderColor(hColor);
      setFooterColor(fColor);
      setPageSize(pSize);
      setColWidths(widths);
      setPage(1);
      // Seed "last saved" with what we just applied so we don't immediately
      // echo the same blob straight back to the server.
      lastSavedRef.current = JSON.stringify({ dataOrder: order, hiddenCols: hidden, headerColor: hColor, footerColor: fColor, pageSize: pSize, colWidths: widths });
    } else {
      // No durable copy yet. Seed "last saved" with the DEFAULT layout so an
      // untouched grid never writes a row, but an existing LS-only custom
      // layout (feature just shipped) still gets pushed up on first change.
      lastSavedRef.current = JSON.stringify({ dataOrder: [...DATA_KEYS], hiddenCols: [], headerColor: DEFAULT_HEADER_COLOR, footerColor: DEFAULT_FOOTER_COLOR, pageSize: DEFAULT_PAGE_SIZE, colWidths: {} });
    }
    setHydratedKey(key);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, cid, hydratedKey]);

  // Debounced durable save. Gated on `hydratedKey === current tenant key` so we
  // never clobber the server copy with stale local state before hydration for
  // THIS tenant has run (the gate is compared, not captured-then-flipped, so a
  // pre-hydration render cannot slip a PUT through during a context switch).
  useEffect(() => {
    if (!user) return;
    const key = String(cid ?? "anon");
    if (hydratedKey !== key) return;   // not yet hydrated for the current tenant
    const payload = { dataOrder, hiddenCols, headerColor, footerColor, pageSize, colWidths };
    const serialized = JSON.stringify(payload);
    if (serialized === lastSavedRef.current) return; // nothing changed
    const h = setTimeout(() => {
      void saveUiPrefs(SCREEN_SLUG, payload)
        .then(() => { lastSavedRef.current = serialized; })
        .catch(() => { /* best-effort — LS still holds the layout locally */ });
    }, 800);
    return () => clearTimeout(h);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydratedKey, user, cid, dataOrder, hiddenCols, headerColor, footerColor, pageSize, colWidths]);

  // Visible columns in render order: fixed lead + user-ordered data (minus any
  // hidden) + fixed tail. Fixed columns are never hideable.
  const visibleColumns = useMemo(() => {
    const byKey = Object.fromEntries(COLUMNS.map(c => [c.key, c]));
    return [...FIXED_LEAD, ...dataOrder.filter(k => !hiddenSet.has(k)), ...FIXED_TAIL]
      .map(k => byKey[k])
      .filter(Boolean);
  }, [dataOrder, hiddenSet]);

  function moveCol(key: string, dir: -1 | 1) {
    setDataOrder(prev => {
      const i = prev.indexOf(key);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  function toggleColVisibility(key: string) {
    // Fixed columns are never hideable.
    if (!DATA_KEYS.includes(key)) return;
    setHiddenCols(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  }
  function resetLayout() {
    setDataOrder([...DATA_KEYS]);
    setHiddenCols([]);
    setHeaderColor(DEFAULT_HEADER_COLOR);
    setFooterColor(DEFAULT_FOOTER_COLOR);
    setPageSize(DEFAULT_PAGE_SIZE);
    setColWidths({});
    setPage(1);
  }

  // ── Excel-style column resize ─────────────────────────────────────────
  // The user can drag the inline-end edge of any column header to resize it,
  // or double-click that edge to auto-fit the column to the widest cell in
  // the column. Widths persist in `colWidths` (and therefore in localStorage).
  const tableRef = useRef<HTMLTableElement | null>(null);

  // Defensive teardown — if the component unmounts mid-drag (e.g. user
  // navigates away while still dragging), make sure we don't leave the page
  // body cursor stuck on `col-resize` or text selection disabled.
  useEffect(() => () => {
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  // Drag-resize: use Pointer Events with setPointerCapture so subsequent
  // pointermove / pointerup events go to the grip element regardless of where
  // the cursor travels. This works reliably under both real users and
  // automation (Playwright dispatches real DOM pointer events).
  // RTL-aware: in RTL the inline-end edge is visually on the LEFT, so
  // dragging LEFT increases width.
  function startColResize(e: React.PointerEvent, colKey: string) {
    e.preventDefault();
    e.stopPropagation();
    const grip = e.currentTarget as HTMLElement;
    const th = grip.closest("th") as HTMLElement | null;
    const startWidth = th?.getBoundingClientRect().width ?? 80;
    const startX = e.clientX;
    const isRtl = (document.documentElement.dir || "ltr").toLowerCase() === "rtl";
    try { grip.setPointerCapture(e.pointerId); } catch { /* older browsers */ }

    const onMove = (ev: PointerEvent) => {
      const delta = isRtl ? (startX - ev.clientX) : (ev.clientX - startX);
      const next = Math.max(36, Math.min(800, Math.round(startWidth + delta)));
      setColWidths(prev => (prev[colKey] === next ? prev : { ...prev, [colKey]: next }));
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

  // Double-click auto-fit: scan all rendered rows in this column index, find
  // the widest content (using scrollWidth on a temporary nowrap clone), then
  // set that as the column's stored width.
  function autoFitColumn(colIndex: number, colKey: string) {
    const table = tableRef.current;
    if (!table) return;
    const cells = table.querySelectorAll<HTMLTableCellElement>(`tr > *:nth-child(${colIndex + 1})`);
    let max = 36;
    cells.forEach(cell => {
      // Temporarily allow the cell's content to expand to its natural width.
      const prevWhite = cell.style.whiteSpace;
      const prevMax = cell.style.maxWidth;
      cell.style.whiteSpace = "nowrap";
      cell.style.maxWidth = "none";
      // scrollWidth includes children's natural width even when truncated.
      const w = cell.scrollWidth;
      cell.style.whiteSpace = prevWhite;
      cell.style.maxWidth = prevMax;
      if (w > max) max = w;
    });
    // Add a small visual padding so content doesn't kiss the right border.
    const next = Math.max(36, Math.min(800, Math.ceil(max + 18)));
    setColWidths(prev => ({ ...prev, [colKey]: next }));
  }

  // ── Selection ─────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Defers a single-click row-select so a double-click (open in edit mode)
  // can cancel it — otherwise the two clicks composing a double-click toggle
  // selection and make it feel like the action "jumps to other rows".
  const rowClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (rowClickTimer.current) clearTimeout(rowClickTimer.current); }, []);
  const [bulkBusy, setBulkBusy] = useState(false);

  // ── AI audit state ─────────────────────────────────────────────────────
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [findingFilter, setFindingFilter] = useState<"all" | "error" | "warning" | "info">("all");

  // ── Data ───────────────────────────────────────────────────────────────
  // Helper: GET that always returns an array, never throws on bad shape.
  // The API may return an error object on auth/permission failure; without this
  // guard the UI would crash on `.filter`/`.map` further down.
  async function getList(url: string): Promise<any[]> {
    try {
      const r = await fetch(url, { headers: authH });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      return Array.isArray(data) ? data : [];
    } catch (e: any) {
      throw new Error(e?.message || "فشل تحميل البيانات");
    }
  }

  // Sorted CSV so equivalent selections share a cache slot. Empty when "all".
  const branchKey = branchIds.length
    ? branchIds.slice().sort((a, b) => a - b).join(",")
    : "all";
  const { data: invoices = [], isLoading, refetch, isFetching, error: invoicesError } = useQuery<any[]>({
    queryKey: ["sales-invoices", cid, "audit-grid", source, branchKey],
    queryFn: () => {
      const params = new URLSearchParams();
      if (cid) params.set("companyId", String(cid));
      params.set("source", source);
      if (branchIds.length) params.set("branchIds", branchIds.join(","));
      return getList(`${API}/api/sales/sales-invoices?${params.toString()}`);
    },
    enabled: !!user,
  });

  const { data: customers = [], isFetched: customersFetched } = useQuery<any[]>({
    queryKey: ["customers", cid],
    queryFn: () => getList(cid ? `${API}/api/customers?companyId=${cid}` : `${API}/api/customers`),
    enabled: !!user,
  });

  const { data: salesReps = [] } = useQuery<any[]>({
    queryKey: ["sales-reps-audit", cid],
    queryFn: () => getList(cid ? `${API}/api/sales-reps?companyId=${cid}` : `${API}/api/sales-reps`),
    enabled: !!user,
  });

  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["branches-audit", cid],
    queryFn: () => getList(cid ? `${API}/api/org/branches?companyId=${cid}` : `${API}/api/org/branches`).catch(() => []),
    enabled: !!user,
  });

  // Sales returns are fetched separately so we can highlight any invoice that
  // has at least one return — a critical audit signal that wasn't visible in
  // the previous row design. We don't need amounts here, just the set of
  // invoiceIds, so a lightweight Set keeps the per-row check O(1).
  const { data: warehousesList = [] } = useQuery<any[]>({
    queryKey: ["warehouses", cid],
    queryFn: () => inventoryApi.getWarehouses(cid),
    enabled: !!user,
  });

  const { data: salesReturns = [] } = useQuery<any[]>({
    queryKey: ["sales-returns-audit", cid],
    queryFn: () => getList(cid ? `${API}/api/sales/sales-returns?companyId=${cid}` : `${API}/api/sales/sales-returns`).catch(() => []),
    enabled: !!user,
  });
  const returnedInvoiceIds = useMemo(
    () => new Set<number>(salesReturns.map((r: any) => Number(r.invoiceId)).filter((n) => Number.isFinite(n))),
    [salesReturns],
  );

  // ── Lookup maps ───────────────────────────────────────────────────────
  const cusMap = useMemo(() => Object.fromEntries(customers.map((c: any) => [c.id, {
    id: c.id,
    code: c.code ?? `CUS-${String(c.id).padStart(6, "0")}`,
    name: c.nameAr ?? c.nameEn,
    vat: c.vatNumber,
    phone: c.phone,
    city: c.city,
    district: c.district,
  }])), [customers]);
  const repMap = useMemo(() => Object.fromEntries(salesReps.map((r: any) => [r.id, r.nameAr ?? r.nameEn])), [salesReps]);
  const branchMap = useMemo(() => Object.fromEntries(branches.map((b: any) => [b.id, b.nameAr ?? b.nameEn ?? b.name])), [branches]);

  // ── Filtering ─────────────────────────────────────────────────────────
  // Two layers: top-bar (search/status/date) AND per-column filters (Excel-like).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    // Pre-compute the digit-only form of the query once, not once per row —
    // the quick-search now also matches phone numbers ignoring formatting
    // (spaces, dashes, "+966" prefix etc.), so we strip non-digits.
    const qDigits = q.replace(/\D/g, "");
    const PAY_AR: Record<string, string> = { cash: "نقدي", bank: "بنكي", credit: "آجل" };
    const STATUS_AR: Record<string, string> = { draft: "مسودة", posted: "مُرحَّل", cancelled: "ملغاة" };

    return invoices.filter((inv: any) => {
      const cus = cusMap[inv.customerId];
      const cusName = cus?.name ?? "";
      const cusPhone = cus?.phone ?? "";
      const cusCode = cus?.code ?? "";
      const cusCity = cus?.city ?? "";
      const cusDistrict = cus?.district ?? "";
      const branchName = branchMap[inv.branchId] ?? "";
      const phoneDigits = cusPhone.replace(/\D/g, "");

      // top-bar filters — quick search looks up phone in two ways:
      //   1. case-insensitive substring on the raw phone string
      //      (handy if user pastes "+966 555 …")
      //   2. digit-only substring (handy for "5555" → "+966 555 5555")
      // Also matches customer code/id, branch name, and city/district
      // so users can locate invoices by customer number, branch, or region.
      const matchText = !q
        || (inv.docNumber ?? "").toLowerCase().includes(q)
        || cusName.toLowerCase().includes(q)
        || cusCode.toLowerCase().includes(q)
        || String(inv.customerId ?? "").includes(q)
        || branchName.toLowerCase().includes(q)
        || cusCity.toLowerCase().includes(q)
        || cusDistrict.toLowerCase().includes(q)
        || cusPhone.toLowerCase().includes(q)
        || (qDigits.length > 0 && phoneDigits.includes(qDigits))
        || (inv.notes ?? "").toLowerCase().includes(q);
      const matchStatus = statusFilter === "all" || inv.status === statusFilter;
      const matchFrom = !dateFrom || (inv.invoiceDate >= dateFrom);
      const matchTo   = !dateTo   || (inv.invoiceDate <= dateTo);
      // فلتر المخزن — يعتمد على الحقل `warehouseIds` المضاف في استجابة
      // GET /api/sales/sales-invoices (مجموع كل المخازن المستخدمة في بنود
      // الفاتورة). list endpoint لا يُرجع البنود كاملةً لتقليل حجم الاستجابة.
      let matchWarehouse = true;
      if (warehouseFilter) {
        const ids: any[] = Array.isArray(inv.warehouseIds) ? inv.warehouseIds : [];
        matchWarehouse = ids.some((wid: any) => String(wid) === warehouseFilter);
      }
      if (!(matchText && matchStatus && matchFrom && matchTo && matchWarehouse)) return false;

      // column filters (advanced two-condition popover)
      for (const col of COLUMNS) {
        const adv = colAdv[col.key];
        if (!isAdvActive(adv)) continue;
        let cellValue: any = "";
        switch (col.key) {
          case "doc":        cellValue = inv.docNumber ?? `SI-${inv.id}`; break;
          case "date":       cellValue = inv.invoiceDate; break;
          case "customer":   cellValue = cusName; break;
          case "vat":        cellValue = cusMap[inv.customerId]?.vat ?? ""; break;
          case "phone":      cellValue = cusMap[inv.customerId]?.phone ?? ""; break;
          case "branch":     cellValue = branchMap[inv.branchId] ?? ""; break;
          case "rep":        cellValue = repMap[inv.salesRepId] ?? ""; break;
          case "payment":    cellValue = PAY_AR[inv.paymentType] ?? inv.paymentType ?? ""; break;
          case "currency":   cellValue = inv.currencyCode ?? ""; break;
          case "freeQty":    cellValue = Number(inv.totalFreeQty ?? 0); break;
          case "subtotal":   cellValue = invGrossSubtotal(inv); break;
          case "discount":   cellValue = invTotalDiscount(inv); break;
          case "vatAmt":     cellValue = inv.vatAmount; break;
          case "total":      cellValue = inv.totalAmount; break;
          case "netAfterDiscount": cellValue = Number(inv.totalAmount ?? 0) - Number(inv.vatAmount ?? 0); break;
          case "commission": cellValue = inv.commissionAmount ?? 0; break;
          case "settle":     cellValue = inv.paymentSettlement?.code ?? ""; break;
          case "je":         cellValue = inv.journalEntryId ? `JE-${inv.journalEntryId}` : ""; break;
          case "zatca":      cellValue = inv.zatcaStatus ?? ""; break;
          case "status":     cellValue = STATUS_AR[inv.status] ?? inv.status ?? ""; break;
          case "notes":      cellValue = inv.notes ?? ""; break;
          case "createdBy":  cellValue = inv.createdByName ?? ""; break;
          case "postedBy":   cellValue = inv.postedByName ?? ""; break;
        }
        if (!matchAdv(cellValue, adv, col.type)) return false;
      }
      return true;
    });
  }, [invoices, search, statusFilter, dateFrom, dateTo, warehouseFilter, cusMap, branchMap, repMap, colAdv]);

  // ── Sorting ───────────────────────────────────────────────────────────
  // Resolves the sortable value for a given invoice + column key. Mirrors
  // the cell rendering so what the user sees on the screen is what gets
  // sorted. Returns `{ v, isNum }` so the comparator can pick the right
  // ordering (numeric vs string with Arabic-aware locale).
  const sortValue = (inv: any, key: string): { v: any; isNum: boolean } => {
    switch (key) {
      case "doc":        return { v: inv.docNumber ?? `SI-${inv.id}`,                isNum: false };
      case "date":       return { v: inv.invoiceDate ?? "",                          isNum: false };
      case "customer":   return { v: cusMap[inv.customerId]?.name ?? "",             isNum: false };
      case "vat":        return { v: cusMap[inv.customerId]?.vat ?? "",              isNum: false };
      case "phone":      return { v: cusMap[inv.customerId]?.phone ?? "",            isNum: false };
      case "branch":     return { v: branchMap[inv.branchId] ?? "",                  isNum: false };
      case "rep":        return { v: repMap[inv.salesRepId] ?? "",                   isNum: false };
      case "payment":    return { v: inv.paymentType ?? "",                          isNum: false };
      case "currency":   return { v: inv.currencyCode ?? "",                         isNum: false };
      case "freeQty":    return { v: Number(inv.totalFreeQty ?? 0),                  isNum: true  };
      case "subtotal":   return { v: invGrossSubtotal(inv),                          isNum: true  };
      case "discount":   return { v: invTotalDiscount(inv),                          isNum: true  };
      case "vatAmt":     return { v: Number(inv.vatAmount ?? 0),                     isNum: true  };
      case "total":      return { v: Number(inv.totalAmount ?? 0),                   isNum: true  };
      case "netAfterDiscount": return { v: Number(inv.totalAmount ?? 0) - Number(inv.vatAmount ?? 0), isNum: true };
      case "commission": return { v: Number(inv.commissionAmount ?? 0),              isNum: true  };
      case "settle":     return { v: inv.paymentSettlement?.code ?? "",              isNum: false };
      case "je":         return { v: Number(inv.journalEntryId ?? 0),                isNum: true  };
      case "zatca":      return { v: inv.zatcaStatus ?? "",                          isNum: false };
      case "status":     return { v: inv.status ?? "",                               isNum: false };
      case "createdBy":  return { v: inv.createdByName ?? "",                        isNum: false };
      case "postedBy":   return { v: inv.postedByName ?? "",                         isNum: false };
      case "notes":      return { v: inv.notes ?? "",                                isNum: false };
      default:           return { v: "",                                             isNum: false };
    }
  };
  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const { key, dir } = sort;
    const factor = dir === "asc" ? 1 : -1;
    const arr = [...filtered];
    arr.sort((a, b) => {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      if (av.isNum) return factor * ((Number(av.v) || 0) - (Number(bv.v) || 0));
      return factor * String(av.v).localeCompare(String(bv.v), "ar", { numeric: true, sensitivity: "base" });
    });
    return arr;
  }, [filtered, sort, cusMap, branchMap, repMap]);

  // ── Pagination ────────────────────────────────────────────────────────
  // pageSize === 0 means "show all" — we still keep `page` at 1 in that mode
  // so toggling back to a finite size lands on a sane page. Totals (footer)
  // are intentionally computed from `filtered`, not `paged`, so they always
  // reflect the entire filtered result regardless of which page is shown.
  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filtered.length / pageSize));
  // Clamp `page` if filters shrunk the result set below the current page.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
  // Reset to page 1 whenever filters/search change so users don't see an
  // empty middle-page after typing in a filter.
  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, dateFrom, dateTo, colAdv, pageSize]);

  // `printAllOverride` lets us briefly render the entire filtered set so
  // window.print() captures every row, not just the current page. It is
  // toggled on right before printSelected() falls back to window.print() and
  // toggled off again once the print dialog is dismissed.
  const [printAllOverride, setPrintAllOverride] = useState(false);
  const paged = useMemo(() => {
    if (pageSize === 0 || printAllOverride) return sorted;
    const start = (page - 1) * pageSize;
    return sorted.slice(start, start + pageSize);
  }, [sorted, page, pageSize, printAllOverride]);
  // When the override flips on, wait one frame for React to flush the full
  // table to the DOM, fire window.print() (which blocks until the user
  // dismisses the dialog), then drop the override.
  useEffect(() => {
    if (!printAllOverride) return;
    const id = window.requestAnimationFrame(() => {
      try { window.print(); } finally { setPrintAllOverride(false); }
    });
    return () => window.cancelAnimationFrame(id);
  }, [printAllOverride]);

  const pageStart = filtered.length === 0 ? 0 : (pageSize === 0 ? 1 : (page - 1) * pageSize + 1);
  const pageEnd = pageSize === 0 ? filtered.length : Math.min(page * pageSize, filtered.length);

  // ── Selection helpers ─────────────────────────────────────────────────
  const allFilteredIds = useMemo(() => filtered.map((i: any) => i.id), [filtered]);
  const allSelected = allFilteredIds.length > 0 && allFilteredIds.every((id: number) => selected.has(id));
  const someSelected = allFilteredIds.some((id: number) => selected.has(id)) && !allSelected;

  function toggleRow(id: number) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    if (allSelected) {
      setSelected(prev => {
        const next = new Set(prev);
        for (const id of allFilteredIds) next.delete(id);
        return next;
      });
    } else {
      setSelected(prev => {
        const next = new Set(prev);
        for (const id of allFilteredIds) next.add(id);
        return next;
      });
    }
  }
  function clearSelection() { setSelected(new Set()); }
  function clearColFilters() { setColFilters({}); setColAdv({}); }
  function clearColAdv(key: string) {
    setColAdv(prev => { const n = { ...prev }; delete n[key]; return n; });
  }
  function setColFilter(key: string, value: string) {
    setColFilters(prev => ({ ...prev, [key]: value }));
  }

  // Selected invoices, partitioned by status for the bulk actions
  const selectedInvoices = useMemo(
    () => invoices.filter((i: any) => selected.has(i.id)),
    [invoices, selected],
  );
  const selectedDrafts = selectedInvoices.filter((i: any) => i.status === "draft");
  const selectedPosted = selectedInvoices.filter((i: any) => i.status === "posted");

  // ── Bulk actions ──────────────────────────────────────────────────────
  async function bulkPatch(ids: number[], path: "post" | "unpost"): Promise<{ ok: number; failed: Array<{ id: number; error: string }> }> {
    const results = await Promise.allSettled(
      ids.map(async id => {
        const r = await fetch(`${API}/api/sales/sales-invoices/${id}/${path}`, { method: "PATCH", headers });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${r.status}`);
        }
      })
    );
    const failed = results
      .map((res, i) => ({ res, id: ids[i] }))
      .filter(x => x.res.status === "rejected")
      .map(x => ({ id: x.id, error: (x.res as PromiseRejectedResult).reason?.message ?? "خطأ" }));
    return { ok: ids.length - failed.length, failed };
  }

  async function bulkPost() {
    const ids = selectedDrafts.map((i: any) => i.id);
    if (ids.length === 0) {
      toast({ title: "لا توجد فواتير مسوّدة ضمن المحدَّد", variant: "destructive" });
      return;
    }
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkPatch(ids, "post");
      if (failed.length === 0) {
        toast({ title: `تم ترحيل ${ok} فاتورة بنجاح` });
        clearSelection();
      } else {
        toast({
          title: `ترحيل: ${ok} نجح، ${failed.length} فشل`,
          description: failed.slice(0, 3).map(f => `#${f.id}: ${f.error}`).join(" • "),
          variant: "destructive",
        });
      }
      qc.invalidateQueries({ queryKey: ["sales-invoices", cid, "audit-grid"] });
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkUnpost() {
    const ids = selectedPosted.map((i: any) => i.id);
    if (ids.length === 0) {
      toast({ title: "لا توجد فواتير مرحَّلة ضمن المحدَّد", variant: "destructive" });
      return;
    }
    if (!window.confirm(`فك ترحيل ${ids.length} فاتورة؟ سيتم حذف القيود المحاسبية المرتبطة.`)) return;
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkPatch(ids, "unpost");
      if (failed.length === 0) {
        toast({ title: `تم فك ترحيل ${ok} فاتورة` });
        clearSelection();
      } else {
        toast({
          title: `فك الترحيل: ${ok} نجح، ${failed.length} فشل`,
          description: failed.slice(0, 3).map(f => `#${f.id}: ${f.error}`).join(" • "),
          variant: "destructive",
        });
      }
      qc.invalidateQueries({ queryKey: ["sales-invoices", cid, "audit-grid"] });
    } finally {
      setBulkBusy(false);
    }
  }

  function goReturn() {
    if (selected.size !== 1) {
      toast({ title: "يجب تحديد فاتورة واحدة فقط لإنشاء مرتجع", variant: "destructive" });
      return;
    }
    const inv = selectedInvoices[0];
    navigate(`/sales/returns?fromInvoice=${inv.id}`);
  }

  // Bulk delete — only drafts/cancelled (server rejects posted invoices).
  // حذف فاتورة مع فك ربط عرض السعر تلقائياً عند رفض الحذف بسبب التحويل (409).
  async function deleteSalesInvoiceWithUnlink(id: number): Promise<void> {
    let r = await fetch(`${API}/api/sales/sales-invoices/${id}`, { method: "DELETE", headers: authH });
    if (r.status === 409) {
      const j = await r.json().catch(() => ({}));
      const msg = String(j.error || "");
      if (msg.includes("عرض")) {
        const ur = await fetch(`${API}/api/sales/sales-invoices/${id}/unlink-quotation`, { method: "POST", headers: authH });
        if (!ur.ok) { const uj = await ur.json().catch(() => ({})); throw new Error(uj.error || "فشل فك ربط عرض السعر"); }
        r = await fetch(`${API}/api/sales/sales-invoices/${id}`, { method: "DELETE", headers: authH });
      } else {
        throw new Error(msg || `HTTP 409`);
      }
    }
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
  }

  async function bulkDelete() {
    const deletable = selectedInvoices.filter((i: any) => i.status !== "posted");
    if (deletable.length === 0) {
      toast({ title: "لا يمكن حذف الفواتير المرحَّلة. فك الترحيل أولاً.", variant: "destructive" });
      return;
    }
    const ids = deletable.map((i: any) => i.id);
    if (!window.confirm(`حذف ${ids.length} فاتورة نهائياً؟ سيتم فك ربط أي عرض سعر مرتبط تلقائياً. لا يمكن التراجع عن هذا الإجراء.`)) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(
        ids.map((id: number) => deleteSalesInvoiceWithUnlink(id))
      );
      const failed = results
        .map((res, i) => ({ res, id: ids[i] }))
        .filter(x => x.res.status === "rejected")
        .map(x => ({ id: x.id, error: (x.res as PromiseRejectedResult).reason?.message ?? "خطأ" }));
      const ok = ids.length - failed.length;
      if (failed.length === 0) {
        toast({ title: `تم حذف ${ok} فاتورة` });
        clearSelection();
      } else {
        toast({
          title: `حذف: ${ok} نجح، ${failed.length} فشل`,
          description: failed.slice(0, 3).map(f => `#${f.id}: ${f.error}`).join(" • "),
          variant: "destructive",
        });
      }
      qc.invalidateQueries({ queryKey: ["sales-invoices", cid, "audit-grid"] });
    } finally {
      setBulkBusy(false);
    }
  }

  // Single-row delete (used in the row actions cell, only for non-posted).
  async function deleteOne(inv: any) {
    if (inv.status === "posted") {
      toast({ title: "لا يمكن حذف فاتورة مرحَّلة. فك الترحيل أولاً.", variant: "destructive" });
      return;
    }
    if (!window.confirm(`حذف الفاتورة ${inv.docNumber ?? `SI-${inv.id}`} نهائياً؟`)) return;
    setBulkBusy(true);
    try {
      let r = await fetch(`${API}/api/sales/sales-invoices/${inv.id}`, { method: "DELETE", headers: authH });
      if (r.status === 409) {
        const j = await r.json().catch(() => ({}));
        const msg = String(j.error || "");
        if (msg.includes("عرض")) {
          if (!window.confirm(`${msg}\n\nهل تريد فك ربط عرض السعر تلقائياً ثم حذف الفاتورة؟`)) { setBulkBusy(false); return; }
          const ur = await fetch(`${API}/api/sales/sales-invoices/${inv.id}/unlink-quotation`, { method: "POST", headers: authH });
          if (!ur.ok) { const uj = await ur.json().catch(() => ({})); throw new Error(uj.error || "فشل فك ربط عرض السعر"); }
          r = await fetch(`${API}/api/sales/sales-invoices/${inv.id}`, { method: "DELETE", headers: authH });
        }
      }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      toast({ title: "تم حذف الفاتورة" });
      setSelected(prev => { const n = new Set(prev); n.delete(inv.id); return n; });
      qc.invalidateQueries({ queryKey: ["sales-invoices", cid, "audit-grid"] });
    } catch (e: any) {
      toast({ title: e?.message ?? "فشل الحذف", variant: "destructive" });
    } finally {
      setBulkBusy(false);
    }
  }

  const selectedDeletable = selectedInvoices.filter((i: any) => i.status !== "posted");

  // ── Footer totals ─────────────────────────────────────────────────────
  const totals = useMemo(() => {
    return filtered.reduce((acc, inv: any) => {
      acc.subtotal += invGrossSubtotal(inv);
      acc.discount += invTotalDiscount(inv);
      acc.vat      += Number(inv.vatAmount ?? 0);
      acc.total    += Number(inv.totalAmount ?? 0);
      acc.netAfterDiscount += Number(inv.totalAmount ?? 0) - Number(inv.vatAmount ?? 0);
      acc.commission += Number(inv.commissionAmount ?? 0);
      acc.freeQty  += Number(inv.totalFreeQty ?? 0);
      return acc;
    }, { subtotal: 0, discount: 0, vat: 0, total: 0, netAfterDiscount: 0, commission: 0, freeQty: 0 });
  }, [filtered]);

  // ── AI audit trigger ──────────────────────────────────────────────────
  async function runAudit() {
    if (filtered.length === 0) {
      toast({ title: "لا توجد فواتير ضمن التصفية الحالية", variant: "destructive" });
      return;
    }
    try {
      setAuditing(true);
      setAuditOpen(true);
      const payload = filtered.map((inv: any) => ({
        id: inv.id,
        docNumber: inv.docNumber,
        invoiceDate: inv.invoiceDate,
        customerId: inv.customerId,
        customerName: cusMap[inv.customerId]?.name,
        paymentType: inv.paymentType,
        subtotal: inv.subtotal,
        discountAmount: inv.discountAmount,
        vatAmount: inv.vatAmount,
        totalAmount: inv.totalAmount,
        status: inv.status,
        zatcaStatus: inv.zatcaStatus,
        zatcaResponseCode: inv.zatcaResponseCode,
        journalEntryId: inv.journalEntryId,
        paymentSettlement: inv.paymentSettlement ? { code: inv.paymentSettlement.code } : null,
      }));
      const r = await fetch(`${API}/api/ai/audit-sales-invoices`, {
        method: "POST",
        headers,
        body: JSON.stringify({ invoices: payload, currencyCode: "SAR" }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const data: AuditResponse = await r.json();
      setAudit(data);
    } catch (e: any) {
      toast({ title: e?.message ?? "فشل تشغيل التدقيق الذكي", variant: "destructive" });
      setAuditOpen(false);
    } finally {
      setAuditing(false);
    }
  }

  // ── CSV Export ────────────────────────────────────────────────────────
  function exportCsv() {
    if (filtered.length === 0) {
      toast({ title: "لا يوجد بيانات للتصدير", variant: "destructive" });
      return;
    }
    const header = [
      "#","رقم الفاتورة","التاريخ","العميل","الرقم الضريبي","هاتف العميل","الفرع","المندوب",
      "نوع الدفع","العملة","الكمية المجانية","المجموع","الخصم","الضريبة","الإجمالي","العمولة",
      "حالة السداد","القيد","ZATCA","الحالة","ملاحظات",
    ];
    const rows = filtered.map((inv: any, idx: number) => [
      idx + 1,
      inv.docNumber ?? `SI-${inv.id}`,
      inv.invoiceDate ?? "",
      cusMap[inv.customerId]?.name ?? "",
      cusMap[inv.customerId]?.vat ?? "",
      cusMap[inv.customerId]?.phone ?? "",
      branchMap[inv.branchId] ?? "",
      repMap[inv.salesRepId] ?? "",
      inv.paymentType === "cash" ? "نقدي" : inv.paymentType === "bank" ? "بنكي" : "آجل",
      inv.currencyCode ?? "SAR",
      Number(inv.totalFreeQty ?? 0).toString(),
      invGrossSubtotal(inv).toFixed(2),
      invTotalDiscount(inv).toFixed(2),
      Number(inv.vatAmount ?? 0).toFixed(2),
      Number(inv.totalAmount ?? 0).toFixed(2),
      Number(inv.commissionAmount ?? 0).toFixed(2),
      inv.paymentSettlement ? `سُدِّد (${inv.paymentSettlement.code})` : "—",
      inv.journalEntryId ? `JE-${inv.journalEntryId}` : "—",
      inv.zatcaStatus ?? "—",
      inv.status,
      (inv.notes ?? "").replace(/[\r\n,]/g, " "),
    ]);
    const csv = [header, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `sales-audit-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast({ title: "تم تصدير ملف CSV بنجاح" });
  }

  // ── Per-invoice print modal (uses SalesPrintModal w/ 12 templates) ───
  // Single source of truth for "print one invoice" used by:
  //   1. The per-row Printer icon in the row actions.
  //   2. The toolbar "طباعة" button when exactly one row is selected.
  //   3. The auto-print-after-save flow (sessionStorage handoff from the
  //      sales-invoice form). When the form sets the `autoPrintSalesInvoice`
  //      flag, we read it on mount, fetch the invoice, and immediately open
  //      the modal with `autoPrintOnOpen=true` so it fires the print dialog
  //      without an extra click.
  const [printData, setPrintData]   = useState<PrintData | null>(null);
  const [printOpen, setPrintOpen]   = useState(false);
  const [printAuto, setPrintAuto]   = useState(false);
  const [printDefault, setPrintDefault] =
    useState<"a4" | "thermal">(((user as any)?.company?.printTemplateSales === "thermal") ? "thermal" : "a4");

  async function openPrintFor(invId: number, opts?: { autoPrint?: boolean; template?: "a4" | "thermal" }) {
    try {
      const r = await fetch(`${API}/api/sales/sales-invoices/${invId}`, { headers: authH });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const full = await r.json();
      // The grid's customers list holds the full customer object — pass
      // that to the print modal so templates render full address/VAT/etc.
      // If the user clicked print before the customers query resolved, or
      // the customer is missing from the list (deleted/different tenant
      // cache), fall back to fetching the single customer directly so the
      // template still has VAT / address / phone instead of "—".
      let customer: any = null;
      if (full.customerId) {
        customer = customers.find((c: any) => c.id === full.customerId) ?? null;
        if (!customer) {
          try {
            const cr = await fetch(`${API}/api/customers/${full.customerId}`, { headers: authH });
            if (cr.ok) customer = await cr.json();
          } catch { /* keep customer=null; modal renders "—" gracefully */ }
        }
      }
      setPrintData({
        type: "invoice",
        doc: full,
        lines: full.lines ?? [],
        customer,
        company: (user as any)?.company ?? null,
      });
      if (opts?.template) setPrintDefault(opts.template);
      setPrintAuto(!!opts?.autoPrint);
      setPrintOpen(true);
    } catch (err: any) {
      toast({
        title: "تعذَّر تحميل الفاتورة للطباعة",
        description: err?.message ?? String(err),
        variant: "destructive",
      });
    }
  }

  // ── Auto-print after save handoff ───────────────────────────────────
  // When the sales-invoice form saves with the company's
  // `printAutoAfterSaveSales` toggle on, it sets `autoPrintSalesInvoice` in
  // sessionStorage and navigates back here. We pick that up exactly once
  // per mount, wait for the customers query to *settle* (success OR error
  // — NOT for it to be non-empty: a tenant may legitimately have zero
  // customers, and `openPrintFor` falls back to fetching the customer
  // directly anyway), then open the print modal with `autoPrint=true`.
  // A stale flag (e.g. a leftover key from a tab the user closed mid-flow)
  // is also cleared here so it cannot fire on a later unrelated mount.
  const autoPrintConsumed = useRef(false);
  useEffect(() => {
    if (autoPrintConsumed.current) return;
    if (!user || !customersFetched) return;
    let raw: string | null = null;
    try { raw = sessionStorage.getItem("autoPrintSalesInvoice"); } catch { /* ignore */ }
    if (!raw) return;
    autoPrintConsumed.current = true;
    try { sessionStorage.removeItem("autoPrintSalesInvoice"); } catch { /* ignore */ }
    let parsed: { id?: number; template?: "a4" | "thermal"; ts?: number } = {};
    try { parsed = JSON.parse(raw); } catch { /* ignore */ }
    if (!parsed?.id) return;
    // Discard hints older than 5 minutes — if the user lingered on another
    // page or tab before navigating back, we don't want a surprise print
    // dialog firing for an invoice they finished saving long ago.
    if (parsed.ts && Date.now() - parsed.ts > 5 * 60 * 1000) return;
    void openPrintFor(parsed.id, { autoPrint: true, template: parsed.template });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, customersFetched]);

  // ── Bulk print (selected invoices' CONTENTS) ─────────────────────────
  // When user has selected one or more rows and clicks "طباعة", we fetch the
  // full invoice + line items for each selection and render them as a
  // print-friendly Arabic/RTL document via a hidden same-origin iframe
  // (NOT window.open — Chrome's popup blocker silently kills that path).
  // For a single selection, we hand off to the SalesPrintModal so the user
  // gets the 12-template picker; for multi-selection we keep the existing
  // bulk-printing layout (`buildBulkPrintHtml`) since the picker doesn't
  // support multi-document mode.
  // When no rows are selected, fall back to printing the audit screen itself.
  const [printing, setPrinting] = useState(false);

  async function printSelected() {
    if (selected.size === 0) {
      // No row selection → fall back to printing the audit screen. We must
      // first expand to ALL filtered rows (not just the current page),
      // otherwise pagination would silently truncate the printout. The
      // useEffect below handles the actual window.print() call after React
      // has flushed the expanded view to the DOM.
      setPrintAllOverride(true);
      return;
    }
    if (selected.size === 1) {
      // Single selection → use the rich SalesPrintModal with the 12-template
      // picker so the user can pick a design (classic, gold, ocean, …).
      const id = Array.from(selected)[0];
      void openPrintFor(id);
      return;
    }
    setPrinting(true);
    try {
      const ids = Array.from(selected);
      const results = await Promise.all(
        ids.map(async id => {
          try {
            const r = await fetch(`${API}/api/sales/sales-invoices/${id}`, { headers: authH });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return await r.json();
          } catch (err) {
            return { __error: true, id, message: (err as Error).message };
          }
        })
      );
      const ok = results.filter((x: any) => !x?.__error);
      const failed = results.filter((x: any) => x?.__error);
      if (ok.length === 0) {
        toast({
          title: "تعذَّر تحميل الفواتير المحدَّدة للطباعة",
          description: failed.map((f: any) => `#${f.id}: ${f.message}`).join("، "),
          variant: "destructive",
        });
        return;
      }
      if (failed.length > 0) {
        toast({
          title: `طباعة جزئية: ${ok.length} من ${ids.length}`,
          description: `تعذَّر تحميل ${failed.length} فاتورة.`,
        });
      }
      const html = buildBulkPrintHtml(ok, { cusMap, branchMap, repMap });
      // Hidden same-origin iframe — Chrome popup-blocker safe (no
      // user-gesture required, no separate window). We tear the iframe
      // down ~2s after firing print() so the engine has time to capture
      // the queued job before the document is removed.
      const iframe = document.createElement("iframe");
      iframe.setAttribute("aria-hidden", "true");
      iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
      iframe.srcdoc = html;
      iframe.onload = () => {
        try {
          const win = iframe.contentWindow;
          if (!win) {
            toast({ title: "تعذَّر فتح معاينة الطباعة", variant: "destructive" });
            return;
          }
          win.focus();
          win.print();
        } catch (err: any) {
          toast({
            title: "تعذَّر بدء الطباعة",
            description: err?.message ?? String(err),
            variant: "destructive",
          });
        } finally {
          setTimeout(() => { try { iframe.remove(); } catch { /* noop */ } }, 2000);
        }
      };
      document.body.appendChild(iframe);
    } finally {
      setPrinting(false);
    }
  }

  // ── Excel / PDF export of the currently filtered list ─────────────────
  // Mirrors `exportCsv`'s column set but routes through the shared
  // `exportToExcel` / `exportToPDF` helpers so we get matching xlsx/PDF
  // output across the app. Both export the FILTERED list (search +
  // status + date + per-column filters honoured). Totals row sums the
  // numeric columns so the file is self-describing.
  function buildExportColumns(): ExportColumn[] {
    return [
      { header: "#",                 key: "_idx",         width: 5  },
      { header: "رقم الفاتورة",      key: "docNumber",    width: 14 },
      { header: "التاريخ",           key: "invoiceDate",  width: 12 },
      { header: "العميل",            key: "customerName", width: 26 },
      { header: "الرقم الضريبي",     key: "vat",          width: 16 },
      { header: "هاتف العميل",       key: "phone",        width: 14 },
      { header: "الفرع",             key: "branch",       width: 14 },
      { header: "المندوب",           key: "rep",          width: 14 },
      { header: "نوع الدفع",         key: "paymentLabel", width: 10 },
      { header: "العملة",            key: "currencyCode", width: 8  },
      { header: "الكمية المجانية",   key: "freeQty",      width: 12 },
      { header: "المجموع",           key: "subtotal",     width: 12 },
      { header: "الخصم",             key: "discount",     width: 10 },
      { header: "الضريبة",           key: "vatAmount",    width: 12 },
      { header: "الإجمالي",          key: "totalAmount",  width: 14 },
      { header: "الإجمالي بعد الخصم", key: "netAfterDiscount", width: 16 },
      { header: "الحالة",            key: "statusLabel",  width: 10 },
      { header: "أنشأه",              key: "createdByName", width: 14 },
      { header: "رحّله",              key: "postedByName",  width: 14 },
    ];
  }
  function buildExportRows() {
    return filtered.map((inv: any, idx: number) => ({
      _idx:         idx + 1,
      docNumber:    inv.docNumber ?? `SI-${inv.id}`,
      invoiceDate:  inv.invoiceDate ?? "",
      customerName: cusMap[inv.customerId]?.name ?? "—",
      vat:          cusMap[inv.customerId]?.vat ?? "",
      phone:        cusMap[inv.customerId]?.phone ?? "",
      branch:       branchMap[inv.branchId] ?? "",
      rep:          repMap[inv.salesRepId] ?? "",
      paymentLabel: inv.paymentType === "cash" ? "نقدي" : inv.paymentType === "bank" ? "بنكي" : "آجل",
      currencyCode: inv.currencyCode ?? "SAR",
      freeQty:      Number(inv.totalFreeQty ?? 0),
      subtotal:     fmt(invGrossSubtotal(inv)),
      discount:     fmt(invTotalDiscount(inv)),
      vatAmount:    fmt(inv.vatAmount),
      totalAmount:  fmt(inv.totalAmount),
      netAfterDiscount: fmt(Number(inv.totalAmount ?? 0) - Number(inv.vatAmount ?? 0)),
      statusLabel:  STATUS[inv.status]?.label ?? inv.status,
      createdByName: inv.createdByName ?? "",
      postedByName:  inv.postedByName ?? "",
    }));
  }
  function buildExportTotals() {
    const sumSub = filtered.reduce((s: number, i: any) => s + invGrossSubtotal(i), 0);
    const sumDis = filtered.reduce((s: number, i: any) => s + invTotalDiscount(i), 0);
    const sumVat = filtered.reduce((s: number, i: any) => s + Number(i.vatAmount      || 0), 0);
    const sumTot = filtered.reduce((s: number, i: any) => s + Number(i.totalAmount    || 0), 0);
    const sumFreeQty = filtered.reduce((s: number, i: any) => s + Number(i.totalFreeQty || 0), 0);
    return {
      _idx:         "",
      docNumber:    "الإجمالي",
      invoiceDate:  "",
      customerName: `${filtered.length} فاتورة`,
      vat:          "",
      phone:        "",
      branch:       "",
      rep:          "",
      paymentLabel: "",
      currencyCode: "",
      freeQty:      sumFreeQty,
      subtotal:     fmt(sumSub),
      discount:     fmt(sumDis),
      vatAmount:    fmt(sumVat),
      totalAmount:  fmt(sumTot),
      netAfterDiscount: fmt(sumTot - sumVat),
      statusLabel:  "",
      createdByName: "",
      postedByName:  "",
    };
  }
  function exportFilenameBase() {
    return `sales-audit-${new Date().toISOString().slice(0, 10)}`;
  }
  function exportXlsx() {
    if (filtered.length === 0) {
      toast({ title: "لا يوجد بيانات للتصدير", variant: "destructive" });
      return;
    }
    exportToExcel(buildExportRows(), buildExportColumns(), exportFilenameBase(), "جرد فواتير المبيعات", buildExportTotals());
    toast({ title: `تم تصدير ${filtered.length} فاتورة إلى Excel` });
  }
  function exportPdf() {
    if (filtered.length === 0) {
      toast({ title: "لا يوجد بيانات للتصدير", variant: "destructive" });
      return;
    }
    exportToPDF(
      buildExportRows(),
      buildExportColumns(),
      exportFilenameBase(),
      "الجرد الخارجي لفواتير المبيعات",
      `إجمالي السجلات: ${filtered.length}`,
      true,
      buildExportTotals(),
      null,
      (user as any)?.company?.logo ?? null,
    );
    toast({ title: `جارٍ فتح ${filtered.length} فاتورة بصيغة PDF` });
  }

  // ── Status & ZATCA pills ──────────────────────────────────────────────
  const STATUS: Record<string, { label: string; cls: string }> = {
    draft:     { label: "مسودة",   cls: "bg-amber-100 text-amber-800 border-amber-300" },
    posted:    { label: "مُرحَّل", cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
    cancelled: { label: "ملغاة",   cls: "bg-slate-200 text-slate-700 border-slate-300" },
  };
  const ZATCA: Record<string, { label: string; cls: string }> = {
    pending:  { label: "بانتظار", cls: "bg-slate-100 text-slate-600 border-slate-300" },
    approved: { label: "مقبول",   cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
    rejected: { label: "مرفوض",  cls: "bg-rose-100 text-rose-800 border-rose-300" },
  };

  const filteredFindings = audit?.findings.filter(f =>
    findingFilter === "all" ? true : f.level === findingFilter
  ) ?? [];

  return (
    <div className="space-y-3" dir={isRtl ? "rtl" : "ltr"}>
      {/* ─── Top toolbar — theme-driven (default white, palette swatches) ── */}
      <div className={cn(
        "rounded-t-lg overflow-hidden border shadow-sm transition-colors",
        theme.border,
      )}>
        <div className={cn(
          "px-3 py-2 flex items-center gap-2 flex-wrap transition-colors",
          theme.bar,
          theme.text,
        )}>
          {fp.isVisible("back_link") && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={cn("h-7 px-2 text-xs gap-1", theme.btn)}
            onClick={() => navigate("/sales/invoices")}
          >
            <ArrowRight className="h-3.5 w-3.5" />
            رجوع
          </Button>
          )}
          {fp.isVisible("new_invoice") && (
          <Button
            type="button"
            size="sm"
            className="h-7 px-3 text-xs gap-1 bg-emerald-500 hover:bg-emerald-400 text-white border border-emerald-300/60 font-bold shadow-sm"
            onClick={() => navigate("/sales/invoices/new")}
            title="إنشاء فاتورة مبيعات جديدة"
          >
            <Plus className="h-3.5 w-3.5" />
            فاتورة جديدة
          </Button>
          )}
          <div className={cn("flex-1 text-center text-sm font-bold tracking-wide flex items-center justify-center gap-2", theme.text)}>
            <FileSpreadsheet className="h-4 w-4 opacity-90" />
            الجرد الخارجي لفواتير المبيعات — مراجعة وتدقيق شامل
          </div>
          <div className="flex items-center gap-1.5">
            {/* ─── Color palette picker ─────────────────────────────── */}
            {fp.isVisible("header_color") && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={cn("h-7 px-2 text-xs gap-1", theme.btn)}
                  title={`لون الرأس الحالي: ${theme.label}`}
                  aria-label="تغيير لون رأس الجدول"
                >
                  <Palette className="h-3.5 w-3.5" />
                  لون الرأس
                  <span className={cn("ms-1 inline-block h-3 w-3 rounded-full", theme.swatch)} />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                side="bottom"
                align="end"
                className="w-64 p-2"
                dir={isRtl ? "rtl" : "ltr"}
              >
                <div className="flex items-center justify-between mb-2 pb-2 border-b">
                  <div className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                    <Palette className="h-3.5 w-3.5 text-blue-600" />
                    لون رأس الجدول
                  </div>
                  {headerColor !== DEFAULT_HEADER_COLOR && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px] text-slate-600 gap-1"
                      onClick={() => setHeaderColor(DEFAULT_HEADER_COLOR)}
                      title="إعادة لون الرأس الافتراضي (أبيض)"
                    >
                      <RotateCw className="h-3 w-3" />
                      افتراضي
                    </Button>
                  )}
                </div>
                <div className="text-[10.5px] text-slate-500 mb-2 leading-relaxed">
                  اختر لوناً لرأس شاشة الجرد. يُحفظ لكل شركة على حدة.
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {HEADER_COLOR_KEYS.map(c => {
                    const t = HEADER_THEMES[c];
                    const active = headerColor === c;
                    return (
                      <button
                        type="button"
                        key={c}
                        onClick={() => setHeaderColor(c)}
                        className={cn(
                          "group flex flex-col items-center gap-1 rounded-md p-1.5 border transition-all",
                          active
                            ? "border-blue-500 bg-blue-50 ring-1 ring-blue-300"
                            : "border-slate-200 hover:border-slate-400 hover:bg-slate-50",
                        )}
                        aria-label={`اختر اللون ${t.label}`}
                        aria-pressed={active}
                        title={t.label}
                      >
                        <span className={cn("relative h-7 w-7 rounded-full shadow-sm", t.swatch)}>
                          {active && (
                            <Check className={cn(
                              "absolute inset-0 m-auto h-4 w-4",
                              c === "white" || c === "amber" ? "text-slate-700" : "text-white",
                            )} />
                          )}
                        </span>
                        <span className={cn("text-[10px]", active ? "text-blue-700 font-bold" : "text-slate-600")}>
                          {t.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
            )}
            {/* ─── Footer (totals row) color picker ───────────────────── */}
            {/* Sits next to "لون الرأس" so the user can independently style
                the bottom totals strip ("الإجمالي"). Same Popover/swatch
                pattern as the header picker for consistency. */}
            {fp.isVisible("footer_color") && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={cn("h-7 px-2 text-xs gap-1", theme.btn)}
                  title={`لون القدم الحالي: ${footerTheme.label}`}
                  aria-label="تغيير لون قدم الجدول (الإجمالي)"
                >
                  <Palette className="h-3.5 w-3.5" />
                  لون القدم
                  <span className={cn("ms-1 inline-block h-3 w-3 rounded-full", footerTheme.swatch)} />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                side="bottom"
                align="end"
                className="w-64 p-2"
                dir={isRtl ? "rtl" : "ltr"}
              >
                <div className="flex items-center justify-between mb-2 pb-2 border-b">
                  <div className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                    <Palette className="h-3.5 w-3.5 text-emerald-600" />
                    لون قدم الجدول (الإجمالي)
                  </div>
                  {footerColor !== DEFAULT_FOOTER_COLOR && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px] text-slate-600 gap-1"
                      onClick={() => setFooterColor(DEFAULT_FOOTER_COLOR)}
                      title="إعادة لون القدم الافتراضي (رمادي)"
                    >
                      <RotateCw className="h-3 w-3" />
                      افتراضي
                    </Button>
                  )}
                </div>
                <div className="text-[10.5px] text-slate-500 mb-2 leading-relaxed">
                  اختر لوناً لقدم شاشة الجرد (سطر الإجماليات). يُحفظ لكل شركة على حدة.
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {FOOTER_COLOR_KEYS.map(c => {
                    const t = FOOTER_THEMES[c];
                    const active = footerColor === c;
                    return (
                      <button
                        type="button"
                        key={c}
                        onClick={() => setFooterColor(c)}
                        data-testid={`footer-color-${c}`}
                        className={cn(
                          "group flex flex-col items-center gap-1 rounded-md p-1.5 border transition-all",
                          active
                            ? "border-emerald-500 bg-emerald-50 ring-1 ring-emerald-300"
                            : "border-slate-200 hover:border-slate-400 hover:bg-slate-50",
                        )}
                        aria-label={`اختر اللون ${t.label}`}
                        aria-pressed={active}
                        title={t.label}
                      >
                        <span className={cn("relative h-7 w-7 rounded-full shadow-sm", t.swatch)}>
                          {active && (
                            <Check className={cn(
                              "absolute inset-0 m-auto h-4 w-4",
                              c === "white" || c === "amber" ? "text-slate-700" : "text-white",
                            )} />
                          )}
                        </span>
                        <span className={cn("text-[10px]", active ? "text-emerald-700 font-bold" : "text-slate-600")}>
                          {t.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
            )}
            {/* ─── Column reorder ─────────────────────────────────────── */}
            {fp.isVisible("column_sort") && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={cn(
                    "h-7 px-2 text-xs gap-1",
                    theme.btn,
                    hasCustomLayout && (headerColor === "white" ? "bg-blue-50 ring-1 ring-blue-200" : "bg-white/20"),
                  )}
                  title="إعادة ترتيب الأعمدة"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  ترتيب الأعمدة
                  {hasCustomLayout && <span className="ms-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-400" title="تخصيص محفوظ" />}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                side="bottom"
                align="end"
                className="w-72 p-2"
                dir={isRtl ? "rtl" : "ltr"}
              >
                <div className="flex items-center justify-between mb-2 pb-2 border-b">
                  <div className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                    <Settings2 className="h-3.5 w-3.5 text-blue-600" />
                    ترتيب الأعمدة
                  </div>
                  {hasCustomLayout && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px] text-slate-600 gap-1"
                      onClick={resetLayout}
                      title="إعادة الترتيب الافتراضي"
                    >
                      <RotateCw className="h-3 w-3" />
                      إعادة تعيين
                    </Button>
                  )}
                </div>
                <div className="text-[10.5px] text-slate-500 mb-2 leading-relaxed">
                  استخدم الأسهم لتغيير ترتيب الأعمدة، وأيقونة العين لإخفاء/إظهار العمود.
                  {hiddenCols.length > 0 && (
                    <span className="text-amber-700 font-medium"> — مخفي: {hiddenCols.length}</span>
                  )}
                  {" "}التعديلات تُحفظ تلقائياً.
                </div>
                <div className="max-h-72 overflow-y-auto space-y-0.5">
                  {dataOrder.map((key, i) => {
                    const col = COLUMNS.find(c => c.key === key);
                    if (!col) return null;
                    const isHidden = hiddenSet.has(key);
                    return (
                      <div
                        key={key}
                        className={`flex items-center gap-1 px-1.5 py-1 rounded hover:bg-slate-50 border border-transparent hover:border-slate-200 ${isHidden ? "opacity-50" : ""}`}
                      >
                        <span className="text-[10px] text-slate-400 font-mono w-5 text-center">{i + 1}</span>
                        <span className="flex-1 text-xs text-slate-700 truncate">{col.label}</span>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className={`h-5 w-5 ${isHidden ? "text-amber-600" : "text-slate-500"}`}
                          onClick={() => toggleColVisibility(key)}
                          title={isHidden ? "إظهار العمود" : "إخفاء العمود"}
                          aria-label={isHidden ? `إظهار العمود ${col.label}` : `إخفاء العمود ${col.label}`}
                          aria-pressed={isHidden}
                        >
                          {isHidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-5 w-5"
                          onClick={() => moveCol(key, -1)}
                          disabled={i === 0}
                          title="نقل لأعلى"
                          aria-label={`نقل العمود ${col.label} للأعلى`}
                        >
                          <ArrowUp className="h-3 w-3" />
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-5 w-5"
                          onClick={() => moveCol(key, +1)}
                          disabled={i === dataOrder.length - 1}
                          title="نقل لأسفل"
                          aria-label={`نقل العمود ${col.label} للأسفل`}
                        >
                          <ArrowDown className="h-3 w-3" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
                {hasCustomLayout && (
                  <div className="mt-2 pt-2 border-t text-[10.5px] text-blue-700 bg-blue-50 -mx-2 -mb-2 px-2 py-1.5 rounded-b flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" />
                    تم حفظ ترتيبك. سيُعرض هكذا في المرة القادمة.
                  </div>
                )}
              </PopoverContent>
            </Popover>
            )}
            {fp.isVisible("refresh") && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn("h-7 px-2 text-xs gap-1", theme.btn)}
              onClick={() => refetch()}
              disabled={isFetching}
            >
              {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              تحديث
            </Button>
            )}
            {fp.isVisible("export_csv") && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn("h-7 px-2 text-xs gap-1", theme.btn)}
              onClick={exportCsv}
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              تصدير CSV
            </Button>
            )}
            {fp.isVisible("export_excel") && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn("h-7 px-2 text-xs gap-1", theme.btn)}
              onClick={exportXlsx}
              disabled={filtered.length === 0}
              title="تصدير الجرد الحالي إلى ملف Excel (xlsx)"
              data-testid="button-audit-export-excel"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              تصدير Excel
            </Button>
            )}
            {fp.isVisible("export_pdf") && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn("h-7 px-2 text-xs gap-1", theme.btn)}
              onClick={exportPdf}
              disabled={filtered.length === 0}
              title="تصدير الجرد الحالي إلى PDF"
              data-testid="button-audit-export-pdf"
            >
              <FileDown className="h-3.5 w-3.5" />
              تصدير PDF
            </Button>
            )}
            {fp.isVisible("print") && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn("h-7 px-2 text-xs gap-1", theme.btn)}
              onClick={printSelected}
              disabled={printing}
              title={selected.size > 0
                ? `طباعة محتوى ${selected.size} فاتورة محدَّدة`
                : "طباعة شاشة الجرد كاملةً (حدِّد سطوراً لطباعة محتوى الفواتير)"}
            >
              {printing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
              طباعة{selected.size > 0 ? ` (${selected.size})` : ""}
            </Button>
            )}
            {fp.isVisible("ai_audit") && (
            <Button
              type="button"
              size="sm"
              className="h-7 px-3 text-xs gap-1 bg-purple-600 hover:bg-purple-500 text-white border border-purple-300/50"
              onClick={runAudit}
              disabled={auditing || filtered.length === 0}
            >
              {auditing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              تدقيق بالذكاء الاصطناعي
            </Button>
            )}
          </div>
        </div>

        {/* ─── Filter strip ────────────────────────────────────────────── */}
        <div className="bg-slate-50 border-t border-slate-200 px-3 py-2 flex items-center gap-2 flex-wrap text-xs">
          {fp.isVisible("search") && (
          <Input
            placeholder="بحث (رقم فاتورة، رقم/اسم العميل، الفرع، المنطقة، هاتف، ملاحظات)…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-7 text-xs w-56"
          />
          )}
          {/* Multi-branch filter — auto-hides when the user has access to a
              single branch only (legacy single-branch UX is preserved). */}
          {fp.isVisible("branch_filter") && (
            <MultiBranchFilter value={branchIds} onChange={setBranchIds} size="sm" />
          )}
          {fp.isVisible("status_filter") && (
          <div className="flex gap-1">
            {(["all","draft","posted","cancelled"] as const).map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={cn(
                  "px-2 py-1 rounded text-[11px] font-medium border transition-colors",
                  statusFilter === s
                    ? "bg-rose-700 text-white border-rose-800"
                    : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100",
                )}
              >
                {s === "all" ? "الكل" : STATUS[s]?.label}
              </button>
            ))}
          </div>
          )}
          {/* فلتر المخزن — اختر مخزناً لتصفية الفواتير التي تحتوي على بند منه */}
          {warehousesList.length > 0 && (
            <div className="flex items-center gap-1">
              <span className="text-slate-600 text-xs">المخزن:</span>
              <div className="w-48">
                <SearchCombobox
                  items={[
                    { value: "", label: "كل المخازن" },
                    ...warehousesList.map((w: any) => ({ value: String(w.id), code: w.code, label: w.nameAr, labelEn: w.nameEn })),
                  ]}
                  value={warehouseFilter}
                  onValueChange={setWarehouseFilter}
                  placeholder="كل المخازن"
                  searchPlaceholder="ابحث بالكود أو الاسم..."
                  className="h-7 text-xs"
                />
              </div>
              {warehouseFilter && (
                <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setWarehouseFilter("")}>
                  مسح
                </Button>
              )}
            </div>
          )}
          {fp.isVisible("date_range") && (
          <div className="flex items-center gap-1">
            <span className="text-slate-600">من:</span>
            <DateField value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-7 text-xs w-32" />
            <span className="text-slate-600">إلى:</span>
            <DateField value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-7 text-xs w-32" />
            {(dateFrom || dateTo) && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => { setDateFrom(""); setDateTo(""); }}
              >
                مسح
              </Button>
            )}
          </div>
          )}
          {fp.isVisible("clear_col_filters") && (Object.values(colFilters).some(v => v) || Object.values(colAdv).some(isAdvActive)) && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-rose-700 hover:bg-rose-50"
              onClick={clearColFilters}
              title="مسح فلاتر الأعمدة"
            >
              <X className="h-3.5 w-3.5 me-1" />
              مسح فلاتر الأعمدة
            </Button>
          )}
          <div className="flex-1" />
          <span className="text-slate-700 font-medium">
            {filtered.length} فاتورة
            {filtered.length !== invoices.length && <span className="text-slate-400"> / {invoices.length}</span>}
          </span>
        </div>

        {/* ─── Bulk action bar (visible when any row selected) ─────────── */}
        {selected.size > 0 && (
          <div className="bg-emerald-50 border-t border-emerald-200 px-3 py-2 flex items-center gap-2 flex-wrap text-xs animate-in fade-in slide-in-from-top-1">
            <span className="font-bold text-emerald-900 flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4" />
              {selected.size} محدَّد
            </span>
            <div className="h-5 w-px bg-emerald-300 mx-1" />
            {fp.isVisible("bulk_post") && (
            <Button
              type="button"
              size="sm"
              className="h-7 px-3 text-xs gap-1 bg-emerald-700 hover:bg-emerald-600 text-white"
              onClick={bulkPost}
              disabled={bulkBusy || selectedDrafts.length === 0}
              title={selectedDrafts.length === 0 ? "لا توجد مسوّدات ضمن المحدَّد" : `ترحيل ${selectedDrafts.length} مسوّدة`}
            >
              {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              ترحيل ({selectedDrafts.length})
            </Button>
            )}
            {fp.isVisible("bulk_edit") && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-3 text-xs gap-1 border-blue-400 text-blue-800 hover:bg-blue-50"
              onClick={() => {
                if (selected.size !== 1) {
                  toast({ title: "يجب تحديد فاتورة واحدة فقط للتعديل", variant: "destructive" });
                  return;
                }
                navigate(`/sales/invoices/${selectedInvoices[0].id}`);
              }}
              disabled={bulkBusy || selected.size !== 1}
              title={selected.size === 1 ? "فتح/تعديل الفاتورة المحدَّدة" : "حدِّد فاتورة واحدة فقط"}
            >
              <Pencil className="h-3.5 w-3.5" />
              تعديل
            </Button>
            )}
            {fp.isVisible("bulk_duplicate") && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-3 text-xs gap-1 border-blue-400 text-blue-800 hover:bg-blue-50"
              onClick={() => {
                if (selected.size !== 1) {
                  toast({ title: "يجب تحديد فاتورة واحدة فقط للنسخ", variant: "destructive" });
                  return;
                }
                navigate(`/sales/invoices/new?from=${selectedInvoices[0].id}`);
              }}
              disabled={bulkBusy || selected.size !== 1}
              title={selected.size === 1 ? "إنشاء نسخة مماثلة من الفاتورة المحدَّدة" : "حدِّد فاتورة واحدة فقط"}
            >
              <Copy className="h-3.5 w-3.5" />
              نسخة مماثلة
            </Button>
            )}
            {fp.isVisible("bulk_unpost") && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-3 text-xs gap-1 border-amber-400 text-amber-800 hover:bg-amber-50"
              onClick={bulkUnpost}
              disabled={bulkBusy || selectedPosted.length === 0 || !isAdmin}
              title={
                !isAdmin
                  ? "فك الترحيل متاح للمدير فقط"
                  : selectedPosted.length === 0
                    ? "لا توجد فواتير مُرحَّلة ضمن المحدَّد"
                    : `فك ترحيل ${selectedPosted.length} فاتورة`
              }
            >
              <Undo2 className="h-3.5 w-3.5" />
              فك الترحيل ({selectedPosted.length})
            </Button>
            )}
            {fp.isVisible("bulk_return") && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-3 text-xs gap-1 border-rose-400 text-rose-800 hover:bg-rose-50"
              onClick={goReturn}
              disabled={bulkBusy || selected.size !== 1}
              title={selected.size === 1 ? "إنشاء مرتجع من الفاتورة المحدَّدة" : "حدِّد فاتورة واحدة فقط"}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              ارتجاع
            </Button>
            )}
            {fp.isVisible("bulk_delete") && (
            <Button
              type="button"
              size="sm"
              className="h-7 px-3 text-xs gap-1 bg-rose-600 hover:bg-rose-500 text-white"
              onClick={bulkDelete}
              disabled={bulkBusy || selectedDeletable.length === 0}
              title={selectedDeletable.length === 0
                ? "لا يمكن حذف الفواتير المرحَّلة. فك الترحيل أولاً."
                : `حذف ${selectedDeletable.length} فاتورة (مسوّدة/ملغاة)`}
            >
              <Trash2 className="h-3.5 w-3.5" />
              حذف ({selectedDeletable.length})
            </Button>
            )}
            <div className="flex-1" />
            {fp.isVisible("clear_selection") && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-slate-600 hover:bg-slate-100"
              onClick={clearSelection}
              disabled={bulkBusy}
            >
              <X className="h-3.5 w-3.5 me-1" />
              إلغاء التحديد
            </Button>
            )}
          </div>
        )}
      </div>

      {/* ─── Color legend — explains what each row tint means ─────────────
          Counts are derived from the FILTERED set so users immediately see
          how many drafts / postings / returns survive their current filter.
          ──────────────────────────────────────────────────────────────── */}
      {fp.isVisible("color_legend") && (() => {
        const counts = {
          draft:     filtered.filter((i: any) => i.status === "draft").length,
          posted:    filtered.filter((i: any) => i.status === "posted").length,
          cancelled: filtered.filter((i: any) => i.status === "cancelled").length,
          returned:  filtered.filter((i: any) => returnedInvoiceIds.has(Number(i.id))).length,
          zatcaOk:   filtered.filter((i: any) => i.zatcaStatus === "approved").length,
          zatcaBad:  filtered.filter((i: any) => i.zatcaStatus === "rejected").length,
        };
        // Legend now reuses the shared DocColorLegend so colors/labels/tooltips
        // stay in lockstep with every other audit grid in the app. The vertical
        // separator after the 4th chip groups status chips visually apart from
        // the ZATCA acknowledgement chips (which mark the row's trailing edge).
        // Each chip can be individually hidden via the governance scope; the
        // visual separator is recomputed so it always sits after the last
        // visible *status* chip (before any ZATCA chip), preserving grouping.
        const allItems: Array<{ key: string; item: LegendItem; isZatca: boolean }> = [
          { key: "legend_draft",     item: { kind: "draft",     count: counts.draft     }, isZatca: false },
          { key: "legend_posted",    item: { kind: "posted",    count: counts.posted    }, isZatca: false },
          { key: "legend_cancelled", item: { kind: "cancelled", count: counts.cancelled }, isZatca: false },
          { key: "legend_returned",  item: { kind: "returned",  count: counts.returned  }, isZatca: false },
          { key: "legend_zatca_ok",  item: { kind: "zatca-ok",  count: counts.zatcaOk   }, isZatca: true  },
          { key: "legend_zatca_bad", item: { kind: "zatca-bad", count: counts.zatcaBad  }, isZatca: true  },
        ];
        const visible = allItems.filter(x => fp.isVisible(x.key));
        if (visible.length === 0) return null;
        const items: LegendItem[] = visible.map(x => x.item);
        const lastStatusIdx = visible.reduce((acc, x, i) => (x.isZatca ? acc : i), -1);
        const sepAfter = lastStatusIdx >= 0 && lastStatusIdx < visible.length - 1 ? [lastStatusIdx] : [];
        return <DocColorLegend items={items} separatorAfter={sepAfter} />;
      })()}

      {/* ─── Wide spreadsheet grid ─────────────────────────────────────── */}
      <div className="border border-slate-300 rounded-b-lg bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto" style={{ maxHeight: "calc(100vh - 240px)" }}>
          {invoicesError ? (
            <div className="p-12 text-center">
              <AlertCircle className="h-10 w-10 text-rose-500 mx-auto mb-3" />
              <p className="text-rose-700 text-sm font-medium mb-1">تعذّر تحميل الفواتير</p>
              <p className="text-muted-foreground text-xs">{(invoicesError as Error)?.message ?? "خطأ غير معروف"}</p>
              <Button size="sm" variant="outline" className="mt-4 gap-2" onClick={() => refetch()}>
                <RefreshCw className="h-3.5 w-3.5" />
                إعادة المحاولة
              </Button>
            </div>
          ) : isLoading ? (
            <div className="p-12 text-center text-muted-foreground text-sm">جاري التحميل…</div>
          ) : filtered.length === 0 ? (
            <div className="p-12 text-center">
              <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
              <p className="text-muted-foreground text-sm">لا توجد فواتير ضمن التصفية الحالية</p>
            </div>
          ) : (
            <table ref={tableRef} className="w-full text-[11px] border-collapse" dir={isRtl ? "rtl" : "ltr"}>
              {/* Per-column widths drive Excel-style column resizing. A <col>
                  is emitted for every visible column; only those the user has
                  resized get an explicit width — the rest stay browser-auto. */}
              <colgroup>
                {visibleColumns.map(col => (
                  <col
                    key={col.key}
                    data-col-key={col.key}
                    style={colWidths[col.key] ? { width: `${colWidths[col.key]}px` } : undefined}
                  />
                ))}
              </colgroup>
              <thead className="sticky top-0 z-10">
                <tr className="bg-gradient-to-b from-slate-100 to-slate-200 text-slate-700">
                  {visibleColumns.map((col, colIdx) => {
                    const isSortable = col.type !== "none";
                    const isFilterable = col.type !== "none";
                    const isSorted = sort?.key === col.key;
                    const advValue = colAdv[col.key];
                    const isFiltered = isAdvActive(advValue);
                    const advSummary = describeAdv(advValue, col.type);
                    return (
                    <th
                      key={col.key}
                      data-col-key={col.key}
                      style={colWidths[col.key] ? { width: `${colWidths[col.key]}px`, minWidth: `${colWidths[col.key]}px` } : undefined}
                      className={cn(
                        "group relative px-2 py-1.5 border border-slate-300 text-center font-semibold whitespace-nowrap text-[10.5px]",
                        isSortable && "cursor-pointer select-none hover:bg-slate-200/70 transition-colors",
                        isSorted && "bg-amber-100/80 text-slate-900",
                        isFiltered && "bg-rose-50 ring-1 ring-rose-300/70",
                      )}
                      onClick={isSortable ? () => cycleSort(col.key) : undefined}
                      title={
                        isFiltered
                          ? `فلتر: ${advSummary}`
                          : (isSortable ? "اضغط لترتيب العمود (تصاعدي / تنازلي)" : undefined)
                      }
                      aria-sort={
                        isSortable
                          ? (isSorted ? (sort!.dir === "asc" ? "ascending" : "descending") : "none")
                          : undefined
                      }
                    >
                      {col.key === "_sel" ? (
                        <input
                          type="checkbox"
                          aria-label="تحديد كل النتائج المفلترة (عبر جميع الصفحات)"
                          checked={allSelected}
                          ref={el => { if (el) el.indeterminate = someSelected; }}
                          onChange={toggleAll}
                          className="cursor-pointer h-3.5 w-3.5 accent-rose-600"
                        />
                      ) : (
                        <span className="inline-flex items-center justify-center gap-1">
                          <span>{col.label}</span>
                          {isSortable && (
                            isSorted ? (
                              sort!.dir === "asc"
                                ? <ArrowUp className="h-3 w-3 text-amber-700" />
                                : <ArrowDown className="h-3 w-3 text-amber-700" />
                            ) : (
                              <span className="inline-flex flex-col leading-none text-slate-400/70 group-hover:text-slate-600">
                                <ArrowUp className="h-2 w-2 -mb-0.5" />
                                <ArrowDown className="h-2 w-2" />
                              </span>
                            )
                          )}
                          {isFilterable && (
                            <AdvFilterPopover
                              colKey={col.key}
                              colLabel={col.label || col.key}
                              colType={col.type}
                              value={advValue}
                              active={isFiltered}
                              onApply={v => setColAdv(prev => ({ ...prev, [col.key]: v }))}
                              onClear={() => clearColAdv(col.key)}
                            />
                          )}
                        </span>
                      )}
                      {/* Resize grip — sits on the column's trailing edge.
                          Drag to resize, double-click to auto-fit. Hidden in
                          print so it doesn't show up on paper. We use Pointer
                          Events + setPointerCapture inside startColResize so
                          the drag tracks even when the cursor leaves the grip. */}
                      <span
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`تغيير عرض العمود: ${col.label || col.key}`}
                        title="اسحب لتغيير العرض، أو ضغطة مزدوجة للضبط التلقائي"
                        data-testid={`col-resize-${col.key}`}
                        onPointerDown={e => startColResize(e, col.key)}
                        onDoubleClick={e => { e.preventDefault(); e.stopPropagation(); autoFitColumn(colIdx, col.key); }}
                        className="print:hidden absolute top-0 bottom-0 w-2 cursor-col-resize select-none touch-none hover:bg-blue-400/60 active:bg-blue-500/80 z-20"
                        style={{ insetInlineEnd: -4 }}
                        onClick={e => e.stopPropagation()}
                      />
                    </th>
                  );
                  })}
                </tr>
                {/* (Legacy per-column input row removed — filtering is now
                    fully driven by the AdvFilterPopover in each header.) */}
              </thead>
              <tbody>
                {paged.map((inv: any, idx: number) => {
                  // Absolute row number across the FILTERED set (not just the
                  // current page) so users can read row 27 on page 2 of 25.
                  const absIdx = pageSize === 0 ? idx : (page - 1) * pageSize + idx;
                  const cus = cusMap[inv.customerId];
                  const st = STATUS[inv.status] ?? STATUS.draft;
                  const z = ZATCA[String(inv.zatcaStatus ?? "pending")] ?? null;
                  const payLabel = inv.paymentType === "cash" ? "نقدي" : inv.paymentType === "bank" ? "بنكي" : "آجل";
                  const isSel = selected.has(inv.id);
                  const canDelete = inv.status !== "posted";
                  const hasReturn = returnedInvoiceIds.has(Number(inv.id));
                  // Per-column body cell renderer — keyed off the column descriptor.
                  const renderBodyCell = (col: typeof COLUMNS[number]) => {
                    switch (col.key) {
                      case "_sel":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <input
                              type="checkbox"
                              checked={isSel}
                              onChange={() => toggleRow(inv.id)}
                              onClick={e => e.stopPropagation()}
                              className="cursor-pointer h-3.5 w-3.5 accent-rose-600"
                              aria-label={`تحديد الفاتورة ${inv.docNumber ?? inv.id}`}
                            />
                          </td>
                        );
                      case "_idx":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-500 font-mono">{absIdx + 1}</td>;
                      case "doc":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 font-mono font-semibold text-rose-700 text-center">{inv.docNumber ?? `SI-${inv.id}`}</td>;
                      case "date":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center whitespace-nowrap">{inv.invoiceDate}</td>;
                      case "customer":
                        return <td key={col.key} className={cn("px-2 py-1 border border-slate-200 truncate", colWidths.customer ? "" : "max-w-[180px]")} title={cus?.name ?? ""}>{cus?.name ?? "—"}</td>;
                      case "vat":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 font-mono text-[10px] text-slate-600 text-center">{cus?.vat ?? "—"}</td>;
                      case "phone": {
                        // Build a safe `tel:` href: keep only characters that
                        // are valid in dialable strings per RFC 3966 (digits,
                        // "+", and a few separators). The phone comes from
                        // our own DB, but it's still user-entered text — this
                        // sanitizer guards against odd characters slipping
                        // into the URL scheme.
                        const telHref = cus?.phone
                          ? `tel:${cus.phone.replace(/[^0-9+*#(),;\-\s]/g, "")}`
                          : "";
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 font-mono text-[10px] text-center whitespace-nowrap">
                            {cus?.phone ? (
                              <a
                                href={telHref}
                                className="text-blue-700 hover:underline"
                                title={`اتصل بالعميل: ${cus.phone}`}
                                dir="ltr"
                                onClick={e => e.stopPropagation()}
                              >
                                {cus.phone}
                              </a>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                        );
                      }
                      case "branch":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-600">{branchMap[inv.branchId] ?? "—"}</td>;
                      case "rep":
                        return <td key={col.key} className={cn("px-2 py-1 border border-slate-200 text-center text-slate-600 truncate", colWidths.rep ? "" : "max-w-[120px]")} title={repMap[inv.salesRepId] ?? ""}>{repMap[inv.salesRepId] ?? "—"}</td>;
                      case "payment":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-600">{payLabel}</td>;
                      case "currency":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-500 font-mono">{inv.currencyCode}</td>;
                      case "freeQty": {
                        const fq = Number(inv.totalFreeQty ?? 0);
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono text-green-700">{fq ? fq.toLocaleString("en-US", { maximumFractionDigits: 3 }) : "—"}</td>;
                      }
                      case "subtotal":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono">{fmt(invGrossSubtotal(inv))}</td>;
                      case "discount":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono text-orange-700">{fmt(invTotalDiscount(inv))}</td>;
                      case "vatAmt":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono text-amber-700">{fmt(inv.vatAmount)}</td>;
                      case "total":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono font-bold text-slate-900">{fmt(inv.totalAmount)}</td>;
                      case "netAfterDiscount":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono">{fmt(Number(inv.totalAmount ?? 0) - Number(inv.vatAmount ?? 0))}</td>;
                      case "commission":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono text-purple-700">{fmt(inv.commissionAmount ?? 0)}</td>;
                      case "settle":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            {inv.paymentSettlement ? (
                              <span className="inline-flex items-center text-[10px] rounded px-1.5 py-0.5 font-medium border bg-blue-50 text-blue-700 border-blue-200" title={inv.paymentSettlement.code}>
                                ✓ {inv.paymentSettlement.code}
                              </span>
                            ) : <span className="text-slate-400">—</span>}
                          </td>
                        );
                      case "je":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            {inv.journalEntryId ? (
                              <button onClick={() => navigate(`/accounting/journals/${inv.journalEntryId}?tab=lines`)} className="font-mono text-[10px] text-blue-600 hover:underline">
                                JE-{inv.journalEntryId}
                              </button>
                            ) : <span className="text-slate-400">—</span>}
                          </td>
                        );
                      case "zatca":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            {z ? <span className={cn("inline-flex items-center text-[10px] rounded px-1.5 py-0.5 font-medium border", z.cls)}>{z.label}</span> : <span className="text-slate-400">—</span>}
                          </td>
                        );
                      case "status":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <span className={cn("inline-flex items-center text-[10px] rounded px-1.5 py-0.5 font-medium border", st.cls)}>{st.label}</span>
                          </td>
                        );
                      case "createdBy":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            {inv.createdByName ? (
                              <span className="inline-flex items-center gap-1 text-[10px] rounded-full px-1.5 py-0.5 font-medium border bg-emerald-50 text-emerald-700 border-emerald-200">
                                <User className="h-2.5 w-2.5" />{inv.createdByName}
                              </span>
                            ) : <span className="text-slate-400">—</span>}
                          </td>
                        );
                      case "postedBy":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            {inv.postedByName ? (
                              <span className="inline-flex items-center gap-1 text-[10px] rounded-full px-1.5 py-0.5 font-medium border bg-blue-50 text-blue-700 border-blue-200">
                                <User className="h-2.5 w-2.5" />{inv.postedByName}
                              </span>
                            ) : <span className="text-slate-400">—</span>}
                          </td>
                        );
                      case "notes":
                        return <td key={col.key} className={cn("px-2 py-1 border border-slate-200 text-slate-600 truncate", colWidths.notes ? "" : "max-w-[140px]")} title={inv.notes ?? ""}>{inv.notes ?? "—"}</td>;
                      case "_act":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <div className="flex items-center justify-center gap-0.5">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                                title="فتح"
                                aria-label={`فتح الفاتورة ${inv.docNumber ?? inv.id}`}
                                onClick={(e) => { e.stopPropagation(); navigate(`/sales/invoices/${inv.id}`); }}
                              >
                                <Eye className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-slate-700 hover:text-primary hover:bg-muted"
                                title="طباعة الفاتورة (اختر النموذج)"
                                aria-label={`طباعة الفاتورة ${inv.docNumber ?? inv.id}`}
                                data-testid={`button-print-invoice-${inv.id}`}
                                onClick={(e) => { e.stopPropagation(); void openPrintFor(inv.id); }}
                              >
                                <Printer className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className={cn("h-6 w-6", canDelete ? "text-rose-600 hover:bg-rose-50 hover:text-rose-700" : "text-slate-300 cursor-not-allowed")}
                                title={canDelete ? "حذف الفاتورة" : "لا يمكن حذف فاتورة مرحَّلة"}
                                aria-label={canDelete ? `حذف الفاتورة ${inv.docNumber ?? inv.id}` : `لا يمكن حذف الفاتورة المرحَّلة ${inv.docNumber ?? inv.id}`}
                                disabled={!canDelete || bulkBusy}
                                onClick={(e) => { e.stopPropagation(); deleteOne(inv); }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </td>
                        );
                      default:
                        return <td key={col.key} className="px-2 py-1 border border-slate-200" />;
                    }
                  };
                  // Build a human-readable "why is this row tinted" tooltip,
                  // stitched together from the active flags so the user
                  // instantly knows what each color means.
                  // Hand the same row signals to the shared tooltip builder
                  // so audit grids across the app phrase "why is this row
                  // tinted?" identically.
                  const rowTitle = buildToneTooltip({
                    status: inv.status,
                    hasReturn,
                    zatcaStatus: inv.zatcaStatus,
                  });
                  return (
                    <tr
                      key={inv.id}
                      data-testid={`row-invoice-${inv.id}`}
                      data-status={inv.status}
                      data-has-return={hasReturn ? "1" : "0"}
                      data-zatca={inv.zatcaStatus ?? "pending"}
                      className={cn(
                        "transition-colors cursor-pointer select-none",
                        // Selection wins — preserves the previous bulk-select feel.
                        isSel
                          ? SEL_TONE
                          : rowToneFor({
                              status: inv.status,
                              hasReturn,
                              zatcaStatus: inv.zatcaStatus,
                            }),
                      )}
                      onClick={(e) => {
                        // Don't toggle when clicking interactive children (links, buttons, inputs).
                        const tag = (e.target as HTMLElement).tagName;
                        if (tag === "BUTTON" || tag === "INPUT" || tag === "A" || (e.target as HTMLElement).closest("button,a,input")) return;
                        // Defer the select-toggle ~220ms; a double-click cancels it
                        // and opens the invoice in edit mode instead.
                        if (rowClickTimer.current) clearTimeout(rowClickTimer.current);
                        rowClickTimer.current = setTimeout(() => {
                          rowClickTimer.current = null;
                          toggleRow(inv.id);
                        }, 220);
                      }}
                      onDoubleClick={(e) => {
                        const tag = (e.target as HTMLElement).tagName;
                        if (tag === "BUTTON" || tag === "INPUT" || tag === "A" || (e.target as HTMLElement).closest("button,a,input")) return;
                        // Cancel the pending single-click select and clear any
                        // accidental text selection before navigating to edit.
                        if (rowClickTimer.current) { clearTimeout(rowClickTimer.current); rowClickTimer.current = null; }
                        window.getSelection()?.removeAllRanges();
                        navigate(`/sales/invoices/${inv.id}`);
                      }}
                      title={rowTitle}
                    >
                      {visibleColumns.map(renderBodyCell)}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="sticky bottom-0">
                <tr className={cn("text-[11px] font-semibold", footerTheme.bg, footerTheme.text)}>
                  {visibleColumns.map((col, i) => {
                    // Numeric columns get their total; the very first cell holds the "الإجمالي:" label.
                    const totalByKey: Record<string, number | undefined> = {
                      freeQty: totals.freeQty,
                      subtotal: totals.subtotal,
                      discount: totals.discount,
                      vatAmt: totals.vat,
                      total: totals.total,
                      netAfterDiscount: totals.netAfterDiscount,
                      commission: totals.commission,
                    };
                    if (i === 0) {
                      return (
                        <td key={col.key} className={cn("px-2 py-2 border text-end whitespace-nowrap", footerTheme.border)}>
                          الإجمالي:
                        </td>
                      );
                    }
                    if (col.key in totalByKey) {
                      const tone =
                        col.key === "discount"   ? footerTheme.toneDiscount   :
                        col.key === "vatAmt"     ? footerTheme.toneVat        :
                        col.key === "commission" ? footerTheme.toneCommission :
                        "";
                      return (
                        <td key={col.key} className={cn("px-2 py-2 border text-end font-mono", footerTheme.border, tone)}>
                          {fmt(totalByKey[col.key]!)}
                        </td>
                      );
                    }
                    return <td key={col.key} className={cn("px-2 py-2 border", footerTheme.border)} />;
                  })}
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        {/* ─── Pagination toolbar ────────────────────────────────────────── */}
        {/* Sits inside the same bordered card as the grid so it visually
            belongs to the table rather than to the page. Hidden in print so
            page navigation chrome doesn't appear in printed audits. */}
        <div className="bg-slate-50 border-t border-slate-200 px-3 py-1.5 flex items-center gap-2 flex-wrap text-xs print:hidden">
          <div className="flex items-center gap-1.5">
            <label htmlFor="audit-page-size" className="text-slate-600 font-medium">عدد الأسطر:</label>
            <select
              id="audit-page-size"
              value={pageSize}
              onChange={e => setPageSize(sanitizePageSize(Number(e.target.value)))}
              className="h-7 text-xs px-2 rounded border border-slate-300 bg-white text-slate-700 font-mono cursor-pointer hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
              aria-label="عدد الأسطر المعروضة في كل صفحة"
              title="عدد الفواتير المعروضة في كل صفحة"
            >
              {PAGE_SIZE_OPTIONS.map(n => (
                <option key={n} value={n}>{n === 0 ? "الكل" : n}</option>
              ))}
            </select>
          </div>

          <div className="text-slate-600 font-mono">
            {filtered.length === 0
              ? "لا يوجد بيانات"
              : (
                <>
                  <span className="text-slate-900 font-bold">{pageStart}</span>
                  <span className="text-slate-400 mx-1">–</span>
                  <span className="text-slate-900 font-bold">{pageEnd}</span>
                  <span className="text-slate-500 mx-1">من</span>
                  <span className="text-slate-900 font-bold">{filtered.length}</span>
                  <span className="text-slate-500 ms-1">فاتورة</span>
                </>
              )}
          </div>

          {/* Spacer pushes nav to the opposite edge in RTL/LTR */}
          <div className="flex-1" />

          {pageSize !== 0 && totalPages > 1 && (
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => setPage(1)}
                disabled={page === 1}
                aria-label="أول صفحة"
                title="أول صفحة"
              >
                «
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                aria-label="الصفحة السابقة"
              >
                السابق
              </Button>
              <span className="text-slate-700 font-mono px-1.5">
                صفحة <span className="font-bold text-slate-900">{page}</span>
                <span className="text-slate-400 mx-1">/</span>
                <span className="font-bold text-slate-900">{totalPages}</span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                aria-label="الصفحة التالية"
              >
                التالي
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => setPage(totalPages)}
                disabled={page >= totalPages}
                aria-label="آخر صفحة"
                title="آخر صفحة"
              >
                »
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* ─── AI Audit Sheet (slide-out drawer) ───────────────────────────── */}
      <Sheet open={auditOpen} onOpenChange={setAuditOpen}>
        <SheetContent
          side={isRtl ? "left" : "right"}
          className="w-full sm:max-w-xl overflow-y-auto p-0"
        >
          <div className="bg-gradient-to-l from-purple-700 to-purple-600 text-white p-4">
            <SheetHeader>
              <SheetTitle className="text-white flex items-center gap-2">
                <Sparkles className="h-5 w-5" />
                التدقيق الذكي للفواتير
              </SheetTitle>
              <SheetDescription className="text-white/80">
                {auditing
                  ? "يقوم الذكاء الاصطناعي الآن بفحص فواتيرك..."
                  : audit
                    ? `${audit.findings.length} ملاحظة (${audit.metrics.issuesCount} حرجة + ${audit.metrics.warningsCount} تحذير)`
                    : "ابدأ التدقيق لاكتشاف الأخطاء والشذوذ في فواتيرك"}
              </SheetDescription>
            </SheetHeader>
          </div>

          <div className="p-4 space-y-4">
            {auditing && (
              <div className="p-8 text-center">
                <Loader2 className="h-8 w-8 animate-spin text-purple-600 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">يحلّل الذكاء الاصطناعي {filtered.length} فاتورة…</p>
              </div>
            )}

            {audit && !auditing && (
              <>
                {/* Metric tiles */}
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-center">
                    <div className="text-2xl font-bold text-rose-700 font-mono">{audit.metrics.issuesCount}</div>
                    <div className="text-[10px] text-rose-700 font-medium">مشاكل حرجة</div>
                  </div>
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-center">
                    <div className="text-2xl font-bold text-amber-700 font-mono">{audit.metrics.warningsCount}</div>
                    <div className="text-[10px] text-amber-700 font-medium">تحذيرات</div>
                  </div>
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-center">
                    <div className="text-2xl font-bold text-emerald-700 font-mono">{audit.metrics.totalPosted}</div>
                    <div className="text-[10px] text-emerald-700 font-medium">فواتير مُرحَّلة</div>
                  </div>
                </div>

                {/* Recommendations */}
                {audit.recommendations.length > 0 && (
                  <div className="rounded-lg border border-purple-200 bg-purple-50 p-3">
                    <div className="flex items-center gap-2 mb-2 text-purple-900 font-semibold text-sm">
                      <Sparkles className="h-4 w-4" />
                      توصيات
                    </div>
                    <ul className="space-y-1.5 text-xs text-purple-900/90 leading-relaxed list-disc pe-5">
                      {audit.recommendations.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Findings filter pills */}
                {audit.findings.length > 0 && (
                  <>
                    <div className="flex gap-1 flex-wrap items-center">
                      <span className="text-xs text-muted-foreground me-2 flex items-center gap-1">
                        <ListChecks className="h-3.5 w-3.5" />
                        الملاحظات:
                      </span>
                      {[
                        { v: "all" as const,     label: "الكل",     n: audit.findings.length, cls: "bg-slate-700 text-white" },
                        { v: "error" as const,   label: "حرجة",    n: audit.metrics.issuesCount, cls: "bg-rose-600 text-white" },
                        { v: "warning" as const, label: "تحذير",   n: audit.metrics.warningsCount, cls: "bg-amber-600 text-white" },
                        { v: "info" as const,    label: "معلومات", n: audit.findings.filter(f => f.level === "info").length, cls: "bg-blue-600 text-white" },
                      ].map(b => (
                        <button
                          key={b.v}
                          onClick={() => setFindingFilter(b.v)}
                          className={cn(
                            "text-[11px] rounded-full px-2.5 py-0.5 border font-medium",
                            findingFilter === b.v ? b.cls : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50",
                          )}
                        >
                          {b.label} ({b.n})
                        </button>
                      ))}
                    </div>

                    <div className="space-y-2">
                      {filteredFindings.length === 0 ? (
                        <div className="text-center py-8">
                          <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto mb-2" />
                          <p className="text-sm text-muted-foreground">لا توجد ملاحظات في هذه الفئة</p>
                        </div>
                      ) : (
                        filteredFindings.map((f, i) => {
                          const Icon = f.level === "error" ? AlertCircle : f.level === "warning" ? AlertTriangle : Info;
                          const cls = f.level === "error"
                            ? "border-rose-200 bg-rose-50"
                            : f.level === "warning"
                              ? "border-amber-200 bg-amber-50"
                              : "border-blue-200 bg-blue-50";
                          const iconCls = f.level === "error"
                            ? "text-rose-600"
                            : f.level === "warning"
                              ? "text-amber-600"
                              : "text-blue-600";
                          return (
                            <div key={i} className={cn("rounded-lg border p-2.5 text-xs", cls)}>
                              <div className="flex items-start gap-2">
                                <Icon className={cn("h-4 w-4 flex-shrink-0 mt-0.5", iconCls)} />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                                    {f.docNumber && f.invoiceId && (
                                      <button
                                        onClick={() => { setAuditOpen(false); navigate(`/sales/invoices/${f.invoiceId}`); }}
                                        className="font-mono font-semibold text-rose-700 hover:underline"
                                      >
                                        {f.docNumber}
                                      </button>
                                    )}
                                    <span className="text-[9px] font-mono text-slate-500 bg-white border border-slate-200 px-1 py-0.5 rounded">{f.code}</span>
                                  </div>
                                  <div className="text-slate-800 leading-relaxed">{f.message}</div>
                                  {f.fix && (
                                    <div className="mt-1.5 text-[11px] text-slate-600 bg-white/60 border border-slate-200 rounded p-1.5">
                                      <span className="font-semibold text-slate-700">الإصلاح:</span> {f.fix}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </>
                )}

                {audit.findings.length === 0 && (
                  <div className="text-center py-8 rounded-lg border border-emerald-200 bg-emerald-50">
                    <CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto mb-2" />
                    <p className="text-sm font-semibold text-emerald-800">ممتاز! لم نجد أي ملاحظات</p>
                    <p className="text-xs text-emerald-700 mt-1">كل فواتيرك تبدو سليمة محاسبياً وضريبياً.</p>
                  </div>
                )}

                <div className="text-[10px] text-slate-400 text-center pt-2 border-t border-slate-100">
                  مصدر التحليل: {audit.source === "ai+rules" ? "ذكاء اصطناعي + قواعد محاسبية" : "قواعد محاسبية"}
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
      <SalesPrintModal
        open={printOpen}
        onClose={() => { setPrintOpen(false); setPrintAuto(false); }}
        data={printData}
        defaultTemplate={printDefault}
        autoPrintOnOpen={printAuto}
      />
    </div>
  );
}
