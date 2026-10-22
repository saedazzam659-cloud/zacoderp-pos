/**
 * Toolbar controls shared by every "audit-grid" screen — header color picker,
 * footer color picker, and column reorder popover. They consume an
 * AuditGridLayout from `useAuditGridLayout` and a `columns` descriptor list so
 * they can render readable Arabic labels in the reorder popover.
 *
 * Keep these visually identical to the originals in SalesAuditGrid so the
 * cross-screen UX stays consistent.
 */
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { ArrowDown, ArrowUp, Check, CheckCircle2, Eye, EyeOff, Palette, RotateCw, Settings2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { localizeUiText } from "@/lib/localizedUiText";
import {
  DEFAULT_FOOTER_COLOR, DEFAULT_HEADER_COLOR,
  FOOTER_COLOR_KEYS, FOOTER_THEMES, HEADER_COLOR_KEYS, HEADER_THEMES,
  PAGE_SIZE_OPTIONS, type AuditGridLayout, type PageSize,
} from "@/lib/auditGridLayout";

/** Minimal column descriptor shape used by the reorder popover. */
export interface ColumnDescriptor {
  key: string;
  label: string;
}

interface CommonProps {
  layout: AuditGridLayout;
  isRtl: boolean;
}

export function HeaderColorPicker({ layout, isRtl }: CommonProps) {
  const { headerColor, setHeaderColor, theme } = layout;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={cn("h-7 px-2 text-xs gap-1", theme.btn)}
          title={`${localizeUiText("لون الرأس الحالي:")} ${localizeUiText(theme.label)}`}
          aria-label={localizeUiText("تغيير لون رأس الجدول")}
        >
          <Palette className="h-3.5 w-3.5" />
          {localizeUiText("لون الرأس")}
          <span className={cn("ms-1 inline-block h-3 w-3 rounded-full", theme.swatch)} />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-64 p-2" dir={isRtl ? "rtl" : "ltr"}>
        <div className="flex items-center justify-between mb-2 pb-2 border-b">
          <div className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
            <Palette className="h-3.5 w-3.5 text-blue-600" />
            {localizeUiText("لون رأس الجدول")}
          </div>
          {headerColor !== DEFAULT_HEADER_COLOR && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px] text-slate-600 gap-1"
              onClick={() => setHeaderColor(DEFAULT_HEADER_COLOR)}
              title={localizeUiText("إعادة لون الرأس الافتراضي (أبيض)")}
            >
              <RotateCw className="h-3 w-3" />
              {localizeUiText("افتراضي")}
            </Button>
          )}
        </div>
        <div className="text-[10.5px] text-slate-500 mb-2 leading-relaxed">
          {localizeUiText("اختر لوناً لرأس شاشة الجرد. يُحفظ لكل شركة على حدة.")}
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {HEADER_COLOR_KEYS.map((c) => {
            const t = HEADER_THEMES[c];
            const active = headerColor === c;
            return (
              <button
                type="button"
                key={c}
                onClick={() => setHeaderColor(c)}
                data-testid={`header-color-${c}`}
                className={cn(
                  "group flex flex-col items-center gap-1 rounded-md p-1.5 border transition-all",
                  active
                    ? "border-blue-500 bg-blue-50 ring-1 ring-blue-300"
                    : "border-slate-200 hover:border-slate-400 hover:bg-slate-50",
                )}
                aria-label={`${localizeUiText("اختر اللون")} ${localizeUiText(t.label)}`}
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
  );
}

export function FooterColorPicker({ layout, isRtl }: CommonProps) {
  const { footerColor, setFooterColor, footerTheme, theme } = layout;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={cn("h-7 px-2 text-xs gap-1", theme.btn)}
          title={`${localizeUiText("لون القدم الحالي:")} ${localizeUiText(footerTheme.label)}`}
          aria-label={localizeUiText("تغيير لون قدم الجدول (الإجمالي)")}
        >
          <Palette className="h-3.5 w-3.5" />
          {localizeUiText("لون القدم")}
          <span className={cn("ms-1 inline-block h-3 w-3 rounded-full", footerTheme.swatch)} />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-64 p-2" dir={isRtl ? "rtl" : "ltr"}>
        <div className="flex items-center justify-between mb-2 pb-2 border-b">
          <div className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
            <Palette className="h-3.5 w-3.5 text-emerald-600" />
            {localizeUiText("لون قدم الجدول (الإجمالي)")}
          </div>
          {footerColor !== DEFAULT_FOOTER_COLOR && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px] text-slate-600 gap-1"
              onClick={() => setFooterColor(DEFAULT_FOOTER_COLOR)}
              title={localizeUiText("إعادة لون القدم الافتراضي (أبيض)")}
            >
              <RotateCw className="h-3 w-3" />
              {localizeUiText("افتراضي")}
            </Button>
          )}
        </div>
        <div className="text-[10.5px] text-slate-500 mb-2 leading-relaxed">
          {localizeUiText("اختر لوناً لقدم شاشة الجرد (سطر الإجماليات). يُحفظ لكل شركة على حدة.")}
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {FOOTER_COLOR_KEYS.map((c) => {
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
                aria-label={`${localizeUiText("اختر اللون")} ${localizeUiText(t.label)}`}
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
  );
}

interface ColumnReorderProps extends CommonProps {
  /** All reorderable column descriptors (excluding fixed lead/tail). */
  columns: ColumnDescriptor[];
}

export function ColumnReorderPopover({ layout, isRtl, columns }: ColumnReorderProps) {
  const { dataOrder, moveCol, hiddenCols, hiddenSet, toggleColHidden, hasCustomLayout, resetLayout, theme, headerColor } = layout;
  return (
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
          title={localizeUiText("إعادة ترتيب الأعمدة")}
        >
          <Settings2 className="h-3.5 w-3.5" />
          {localizeUiText("ترتيب الأعمدة")}
          {hasCustomLayout && <span className="ms-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-400" title={localizeUiText("تخصيص محفوظ")} />}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-72 p-2" dir={isRtl ? "rtl" : "ltr"}>
        <div className="flex items-center justify-between mb-2 pb-2 border-b">
          <div className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
            <Settings2 className="h-3.5 w-3.5 text-blue-600" />
            {localizeUiText("ترتيب الأعمدة")}
          </div>
          {hasCustomLayout && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px] text-slate-600 gap-1"
              onClick={resetLayout}
              title={localizeUiText("إعادة الترتيب الافتراضي")}
            >
              <RotateCw className="h-3 w-3" />
              {localizeUiText("إعادة تعيين")}
            </Button>
          )}
        </div>
        <div className="text-[10.5px] text-slate-500 mb-2 leading-relaxed">
          {localizeUiText("استخدم الأسهم لتغيير ترتيب الأعمدة، وأيقونة العين لإخفاء/إظهار العمود.")}
          {hiddenCols.length > 0 && (
            <span className="text-amber-700 font-medium"> — {localizeUiText("مخفي:")} {hiddenCols.length}</span>
          )}
          {" "}{localizeUiText("التعديلات تُحفظ تلقائياً.")}
        </div>
        <div className="max-h-72 overflow-y-auto space-y-0.5">
          {dataOrder.map((key, i) => {
            const col = columns.find((c) => c.key === key);
            if (!col) return null;
            const isHidden = hiddenSet.has(key);
            return (
              <div
                key={key}
                className={cn(
                  "flex items-center gap-1 px-1.5 py-1 rounded hover:bg-slate-50 border border-transparent hover:border-slate-200",
                  isHidden && "opacity-50",
                )}
              >
                <span className="text-[10px] text-slate-400 font-mono w-5 text-center">{i + 1}</span>
                <span className="flex-1 text-xs text-slate-700 truncate">{col.label}</span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className={cn("h-5 w-5", isHidden ? "text-amber-600" : "text-slate-500")}
                  onClick={() => toggleColHidden(key)}
                  title={localizeUiText(isHidden ? "إظهار العمود" : "إخفاء العمود")}
                  aria-label={`${localizeUiText(isHidden ? "إظهار العمود" : "إخفاء العمود")} ${localizeUiText(col.label)}`}
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
                  title={localizeUiText("نقل لأعلى")}
                  aria-label={`${localizeUiText("نقل العمود")} ${localizeUiText(col.label)} ${localizeUiText("للأعلى")}`}
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
                  title={localizeUiText("نقل لأسفل")}
                  aria-label={`${localizeUiText("نقل العمود")} ${localizeUiText(col.label)} ${localizeUiText("للأسفل")}`}
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
            {localizeUiText("تم حفظ ترتيبك. سيُعرض هكذا في المرة القادمة.")}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

interface PaginationToolbarProps {
  layout: AuditGridLayout;
  totalRows: number;
  pageStart: number;
  pageEnd: number;
  totalPages: number;
  /** Customizes the unit word, e.g. "فاتورة"/"قيد"/"عملية". */
  unitLabel?: string;
  /** Screens with large registers can omit the legacy `0 = show all` choice. */
  pageSizeOptions?: readonly PageSize[];
}

/** Bottom pagination strip (page-size select + nav buttons). */
export function AuditGridPagination({
  layout, totalRows, pageStart, pageEnd, totalPages, unitLabel = "سجل",
  pageSizeOptions = PAGE_SIZE_OPTIONS,
}: PaginationToolbarProps) {
  const { pageSize, setPageSize, page, setPage, sanitizePageSize } = layout;
  // Defense in depth: even a future caller that accidentally passes legacy
  // `0 = show all` cannot put it back into a high-volume grid.
  const boundedPageSizeOptions = pageSizeOptions.filter((size) => size !== 0);
  const effectivePageSizeOptions = boundedPageSizeOptions.length > 0
    ? boundedPageSizeOptions
    : PAGE_SIZE_OPTIONS;
  const displayedPageSize = (effectivePageSizeOptions as readonly PageSize[]).includes(pageSize)
    ? pageSize
    : (effectivePageSizeOptions[0] ?? pageSize);
  return (
    <div className="bg-slate-50 border-t border-slate-200 px-3 py-1.5 flex items-center gap-2 flex-wrap text-xs print:hidden">
      <div className="flex items-center gap-1.5">
        <label className="text-slate-600 font-medium">{localizeUiText("عدد الأسطر:")}</label>
        <select
          value={displayedPageSize}
          onChange={(e) => setPageSize(sanitizePageSize(Number(e.target.value)))}
          className="h-7 text-xs px-2 rounded border border-slate-300 bg-white text-slate-700 font-mono cursor-pointer hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
          aria-label={localizeUiText("عدد الأسطر المعروضة في كل صفحة")}
        >
          {effectivePageSizeOptions.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </div>
      <div className="text-slate-600 font-mono">
        {totalRows === 0 ? localizeUiText("لا يوجد بيانات") : (
          <>
            <span className="text-slate-900 font-bold">{pageStart}</span>
            <span className="text-slate-400 mx-1">–</span>
            <span className="text-slate-900 font-bold">{pageEnd}</span>
            <span className="text-slate-500 mx-1">{localizeUiText("من")}</span>
            <span className="text-slate-900 font-bold">{totalRows}</span>
            <span className="text-slate-500 ms-1">{localizeUiText(unitLabel)}</span>
          </>
        )}
      </div>
      <div className="flex-1" />
      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs"
            onClick={() => setPage(1)} disabled={page === 1} aria-label={localizeUiText("أول صفحة")} title={localizeUiText("أول صفحة")}>«</Button>
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs"
            onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} aria-label={localizeUiText("الصفحة السابقة")}>{localizeUiText("السابق")}</Button>
          <span className="text-slate-700 font-mono px-1.5">
            {localizeUiText("صفحة")} <span className="font-bold text-slate-900">{page}</span>
            <span className="text-slate-400 mx-1">/</span>
            <span className="font-bold text-slate-900">{totalPages}</span>
          </span>
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} aria-label={localizeUiText("الصفحة التالية")}>{localizeUiText("التالي")}</Button>
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs"
            onClick={() => setPage(totalPages)} disabled={page >= totalPages} aria-label={localizeUiText("آخر صفحة")} title={localizeUiText("آخر صفحة")}>»</Button>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────── Selection helpers ────────────────────────── */

interface RowSelectCheckboxProps {
  checked: boolean;
  onToggle: () => void;
  ariaLabel: string;
}

/** Single-row checkbox cell content. Stops click bubbling so clicking the
    checkbox does NOT also fire the row's onClick toggle (which would
    immediately undo the change). */
export function RowSelectCheckbox({ checked, onToggle, ariaLabel }: RowSelectCheckboxProps) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={onToggle}
      onClick={(e) => e.stopPropagation()}
      className="cursor-pointer h-3.5 w-3.5 accent-rose-600"
      aria-label={ariaLabel}
    />
  );
}

interface HeaderSelectCheckboxProps {
  allSelected: boolean;
  someSelected: boolean;
  onToggle: () => void;
  disabled?: boolean;
  ariaLabel?: string;
}

/** Header checkbox supporting the indeterminate "some-selected" state.
    HTMLInputElement.indeterminate is a property — not a React prop — so we
    sync it via a ref every render. */
export function HeaderSelectCheckbox({
  allSelected, someSelected, onToggle, disabled, ariaLabel = "تحديد كل الأسطر",
}: HeaderSelectCheckboxProps) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = someSelected;
  }, [someSelected]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={allSelected}
      onChange={onToggle}
      onClick={(e) => e.stopPropagation()}
      disabled={disabled}
      className="cursor-pointer h-3.5 w-3.5 accent-rose-600"
      aria-label={localizeUiText(ariaLabel)}
      title={localizeUiText(allSelected ? "إلغاء تحديد الكل" : "تحديد الكل")}
    />
  );
}

interface BulkBarProps {
  /** Number of currently selected rows. The bar hides itself when 0. */
  count: number;
  /** Action buttons (post / unpost / delete / etc). Rendered before the spacer. */
  children: ReactNode;
  /** Called when the user clicks "إلغاء التحديد". */
  onClear: () => void;
  /** When true, the clear button is disabled (e.g. mid-bulk-mutation). */
  busy?: boolean;
}

/** Green action bar shown above the grid when one or more rows are selected.
    Mirrors the bar in SalesAuditGrid. Action buttons are passed in by each
    screen so the available operations match what the backend supports. */
export function AuditGridBulkBar({ count, children, onClear, busy }: BulkBarProps) {
  if (count === 0) return null;
  return (
    <div
      className="bg-emerald-50 border-t border-emerald-200 px-3 py-2 flex items-center gap-2 flex-wrap text-xs animate-in fade-in slide-in-from-top-1"
      data-testid="audit-grid-bulk-bar"
    >
      <span className="font-bold text-emerald-900 flex items-center gap-1.5">
        <CheckCircle2 className="h-4 w-4" />
        {count} {localizeUiText("محدَّد")}
      </span>
      <div className="h-5 w-px bg-emerald-300 mx-1" />
      {children}
      <div className="flex-1" />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs text-slate-600 hover:bg-slate-100"
        onClick={onClear}
        disabled={busy}
      >
        <X className="h-3.5 w-3.5 me-1" />
        {localizeUiText("إلغاء التحديد")}
      </Button>
    </div>
  );
}
