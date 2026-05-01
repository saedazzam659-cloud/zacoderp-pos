/**
 * Toolbar controls shared by every "audit-grid" screen — header color picker,
 * footer color picker, and column reorder popover. They consume an
 * AuditGridLayout from `useAuditGridLayout` and a `columns` descriptor list so
 * they can render readable Arabic labels in the reorder popover.
 *
 * Keep these visually identical to the originals in SalesAuditGrid so the
 * cross-screen UX stays consistent.
 */
import { ArrowDown, ArrowUp, Check, CheckCircle2, Palette, RotateCw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  DEFAULT_FOOTER_COLOR, DEFAULT_HEADER_COLOR,
  FOOTER_COLOR_KEYS, FOOTER_THEMES, HEADER_COLOR_KEYS, HEADER_THEMES,
  type AuditGridLayout,
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
          title={`لون الرأس الحالي: ${theme.label}`}
          aria-label="تغيير لون رأس الجدول"
        >
          <Palette className="h-3.5 w-3.5" />
          لون الرأس
          <span className={cn("ms-1 inline-block h-3 w-3 rounded-full", theme.swatch)} />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-64 p-2" dir={isRtl ? "rtl" : "ltr"}>
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
          title={`لون القدم الحالي: ${footerTheme.label}`}
          aria-label="تغيير لون قدم الجدول (الإجمالي)"
        >
          <Palette className="h-3.5 w-3.5" />
          لون القدم
          <span className={cn("ms-1 inline-block h-3 w-3 rounded-full", footerTheme.swatch)} />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-64 p-2" dir={isRtl ? "rtl" : "ltr"}>
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
  );
}

interface ColumnReorderProps extends CommonProps {
  /** All reorderable column descriptors (excluding fixed lead/tail). */
  columns: ColumnDescriptor[];
}

export function ColumnReorderPopover({ layout, isRtl, columns }: ColumnReorderProps) {
  const { dataOrder, moveCol, hasCustomLayout, resetLayout, theme, headerColor } = layout;
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
          title="إعادة ترتيب الأعمدة"
        >
          <Settings2 className="h-3.5 w-3.5" />
          ترتيب الأعمدة
          {hasCustomLayout && <span className="ms-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-400" title="تخصيص محفوظ" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-72 p-2" dir={isRtl ? "rtl" : "ltr"}>
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
          استخدم الأسهم لتغيير ترتيب الأعمدة. التعديلات تُحفظ تلقائياً.
        </div>
        <div className="max-h-72 overflow-y-auto space-y-0.5">
          {dataOrder.map((key, i) => {
            const col = columns.find((c) => c.key === key);
            if (!col) return null;
            return (
              <div
                key={key}
                className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-slate-50 border border-transparent hover:border-slate-200"
              >
                <span className="text-[10px] text-slate-400 font-mono w-5 text-center">{i + 1}</span>
                <span className="flex-1 text-xs text-slate-700 truncate">{col.label}</span>
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
}

/** Bottom pagination strip (page-size select + nav buttons). */
export function AuditGridPagination({
  layout, totalRows, pageStart, pageEnd, totalPages, unitLabel = "سجل",
}: PaginationToolbarProps) {
  const { pageSize, setPageSize, page, setPage, sanitizePageSize } = layout;
  return (
    <div className="bg-slate-50 border-t border-slate-200 px-3 py-1.5 flex items-center gap-2 flex-wrap text-xs print:hidden">
      <div className="flex items-center gap-1.5">
        <label className="text-slate-600 font-medium">عدد الأسطر:</label>
        <select
          value={pageSize}
          onChange={(e) => setPageSize(sanitizePageSize(Number(e.target.value)))}
          className="h-7 text-xs px-2 rounded border border-slate-300 bg-white text-slate-700 font-mono cursor-pointer hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
          aria-label="عدد الأسطر المعروضة في كل صفحة"
        >
          {[10, 25, 50, 100, 250, 0].map((n) => (
            <option key={n} value={n}>{n === 0 ? "الكل" : n}</option>
          ))}
        </select>
      </div>
      <div className="text-slate-600 font-mono">
        {totalRows === 0 ? "لا يوجد بيانات" : (
          <>
            <span className="text-slate-900 font-bold">{pageStart}</span>
            <span className="text-slate-400 mx-1">–</span>
            <span className="text-slate-900 font-bold">{pageEnd}</span>
            <span className="text-slate-500 mx-1">من</span>
            <span className="text-slate-900 font-bold">{totalRows}</span>
            <span className="text-slate-500 ms-1">{unitLabel}</span>
          </>
        )}
      </div>
      <div className="flex-1" />
      {pageSize !== 0 && totalPages > 1 && (
        <div className="flex items-center gap-1">
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs"
            onClick={() => setPage(1)} disabled={page === 1} aria-label="أول صفحة" title="أول صفحة">«</Button>
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs"
            onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} aria-label="الصفحة السابقة">السابق</Button>
          <span className="text-slate-700 font-mono px-1.5">
            صفحة <span className="font-bold text-slate-900">{page}</span>
            <span className="text-slate-400 mx-1">/</span>
            <span className="font-bold text-slate-900">{totalPages}</span>
          </span>
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} aria-label="الصفحة التالية">التالي</Button>
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs"
            onClick={() => setPage(totalPages)} disabled={page >= totalPages} aria-label="آخر صفحة" title="آخر صفحة">»</Button>
        </div>
      )}
    </div>
  );
}
