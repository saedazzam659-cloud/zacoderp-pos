/**
 * docRowTone — Shared row coloring + color legend for every list/audit screen.
 *
 * Modeled on SalesAuditGrid: cancelled→draft→posted/confirmed/converted/completed
 * cascade, returned overlay (rose), and an end-edge ZATCA acknowledgement marker.
 *
 * RTL-aware: uses logical `border-s-*` / `border-e-*` so the colored side bar
 * sits at the row's leading edge in both Arabic and English layouts.
 *
 * Usage:
 *   const tone = rowToneFor({
 *     status: doc.status,
 *     hasReturn: returnedIds.has(doc.id),
 *     hasConverted: !!doc.convertedToInvoiceId,
 *     zatcaStatus: doc.zatcaStatus,
 *     statusMap: TX_TONES,
 *   });
 *   <tr className={cn("transition-colors cursor-pointer", isSel ? SEL_TONE : tone)}>
 *
 *   <DocColorLegend
 *     items={[
 *       { kind: "draft", count: drafts },
 *       { kind: "posted", count: posted },
 *       ...
 *     ]}
 *   />
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/* ───────────────────────── Status tone descriptor ─────────────────────── */

/**
 * Visual styling for a single status:
 * - `tone`     classes for the <tr> background/text (hover variant included).
 * - `bar`      logical leading-edge `border-s-*` classes for the colored side bar.
 * - `chipCls`  classes for a legend chip (border + bg + text) representing this state.
 * - `label`    short Arabic label for the legend.
 * - `hint`     longer Arabic tooltip explaining what this color means.
 */
export interface StatusTone {
  tone: string;
  bar: string;
  chipCls: string;
  label: string;
  hint: string;
}

/** Selection tint — always wins over any status tone. */
export const SEL_TONE =
  "bg-emerald-100/70 hover:bg-emerald-100 border-s-[3px] border-s-emerald-600";

/* ────────────────────── Transactional document statuses ────────────────── */

/**
 * Tones for every status used by transactional documents in the system
 * (sales/purchasing/inventory/cash/production/journal). Each screen passes a
 * subset to `rowToneFor` via `statusMap`, so adding a new status here ripples
 * to every screen that opts into it.
 */
export const TX_TONES: Record<string, StatusTone> = {
  draft: {
    tone: "bg-amber-50/70 hover:bg-amber-100/80",
    bar: "border-s-[3px] border-s-amber-400",
    chipCls: "border-amber-300 bg-amber-50/70 text-amber-800",
    label: "مسودة",
    hint: "لم تُرحَّل بعد — قابلة للتعديل والحذف",
  },
  posted: {
    tone: "bg-emerald-50/50 hover:bg-emerald-100/70",
    bar: "border-s-[3px] border-s-emerald-400",
    chipCls: "border-emerald-300 bg-emerald-50/60 text-emerald-800",
    label: "مُرحَّلة",
    hint: "تم ترحيلها في القيود — لا يمكن حذفها",
  },
  cancelled: {
    tone: "bg-slate-100 hover:bg-slate-200/70 text-slate-500 line-through decoration-slate-400/60",
    bar: "border-s-2 border-s-slate-400",
    chipCls: "border-slate-300 bg-slate-100 text-slate-600",
    label: "ملغاة",
    hint: "ألغيت — تظهر بخط داخلي ولا تدخل في الإجماليات",
  },
  confirmed: {
    tone: "bg-sky-50/60 hover:bg-sky-100/70",
    bar: "border-s-[3px] border-s-sky-400",
    chipCls: "border-sky-300 bg-sky-50/70 text-sky-800",
    label: "مؤكَّدة",
    hint: "وثيقة مؤكَّدة وجاهزة للتنفيذ",
  },
  converted: {
    tone: "bg-violet-50/60 hover:bg-violet-100/70",
    bar: "border-s-[3px] border-s-violet-400",
    chipCls: "border-violet-300 bg-violet-50/70 text-violet-800",
    label: "محوَّلة",
    hint: "تم تحويلها إلى مستند آخر (فاتورة/أمر بيع)",
  },
  sent: {
    tone: "bg-blue-50/60 hover:bg-blue-100/70",
    bar: "border-s-[3px] border-s-blue-400",
    chipCls: "border-blue-300 bg-blue-50/70 text-blue-800",
    label: "مُرسَلة",
    hint: "تم إرسالها للعميل/المورد",
  },
  accepted: {
    tone: "bg-emerald-50/50 hover:bg-emerald-100/70",
    bar: "border-s-[3px] border-s-emerald-500",
    chipCls: "border-emerald-300 bg-emerald-50/70 text-emerald-800",
    label: "مقبولة",
    hint: "وافق عليها العميل/المورد",
  },
  rejected: {
    tone: "bg-rose-50/60 hover:bg-rose-100/70 text-rose-700",
    bar: "border-s-[3px] border-s-rose-400",
    chipCls: "border-rose-300 bg-rose-50/70 text-rose-700",
    label: "مرفوضة",
    hint: "رفضها العميل/المورد",
  },
  approved: {
    tone: "bg-sky-50/60 hover:bg-sky-100/70",
    bar: "border-s-[3px] border-s-sky-500",
    chipCls: "border-sky-300 bg-sky-50/70 text-sky-800",
    label: "معتمدة",
    hint: "تمت الموافقة عليها",
  },
  completed: {
    tone: "bg-violet-50/50 hover:bg-violet-100/70",
    bar: "border-s-[3px] border-s-violet-500",
    chipCls: "border-violet-300 bg-violet-50/70 text-violet-800",
    label: "مكتملة",
    hint: "تم الانتهاء من تنفيذها",
  },
  in_progress: {
    tone: "bg-amber-50/60 hover:bg-amber-100/70",
    bar: "border-s-[3px] border-s-amber-500",
    chipCls: "border-amber-300 bg-amber-50/70 text-amber-800",
    label: "قيد التنفيذ",
    hint: "قيد التنفيذ — لم تكتمل بعد",
  },
  in_production: {
    tone: "bg-amber-50/60 hover:bg-amber-100/70",
    bar: "border-s-[3px] border-s-amber-500",
    chipCls: "border-amber-300 bg-amber-50/70 text-amber-800",
    label: "قيد التصنيع",
    hint: "أمر تصنيع جارٍ تنفيذه على خط الإنتاج",
  },
  quality_check: {
    tone: "bg-violet-50/60 hover:bg-violet-100/70",
    bar: "border-s-[3px] border-s-violet-400",
    chipCls: "border-violet-300 bg-violet-50/70 text-violet-800",
    label: "فحص الجودة",
    hint: "بانتظار اعتماد الجودة قبل الإغلاق",
  },
  closed: {
    tone: "bg-slate-50 hover:bg-slate-100 text-slate-600",
    bar: "border-s-2 border-s-slate-400",
    chipCls: "border-slate-300 bg-slate-100 text-slate-600",
    label: "مغلقة",
    hint: "أُغلقت بعد التنفيذ",
  },
  // Special overlays — not real statuses but rendered the same way in the legend.
  returned: {
    tone: "bg-rose-50/70 hover:bg-rose-100/80",
    bar: "border-s-[3px] border-s-rose-500",
    chipCls: "border-rose-300 bg-rose-50/70 text-rose-700",
    label: "بها مرتجع",
    hint: "صدر لها مستند مرتجع كلي أو جزئي",
  },
};

/* ────────────────── Dictionary (active/inactive) statuses ─────────────── */

/**
 * Tones for "dictionary" screens (Customers/Suppliers/SalesReps) where the
 * meaningful state is active/inactive plus optional balance/VAT signals.
 */
export const DICT_TONES: Record<string, StatusTone> = {
  active: {
    tone: "bg-emerald-50/40 hover:bg-emerald-100/60",
    bar: "border-s-[3px] border-s-emerald-400",
    chipCls: "border-emerald-300 bg-emerald-50/60 text-emerald-800",
    label: "نشط",
    hint: "حساب نشط — يظهر في القوائم المنسدلة وفي شاشات الإدخال",
  },
  inactive: {
    tone: "bg-slate-100 hover:bg-slate-200/70 text-slate-500",
    bar: "border-s-2 border-s-slate-400",
    chipCls: "border-slate-300 bg-slate-100 text-slate-600",
    label: "غير نشط",
    hint: "حساب موقوف — لا يظهر في الإدخال",
  },
  debit: {
    tone: "bg-amber-50/60 hover:bg-amber-100/70",
    bar: "border-s-[3px] border-s-amber-400",
    chipCls: "border-amber-300 bg-amber-50/70 text-amber-800",
    label: "مدين",
    hint: "عليه رصيد مدين (مستحق علينا أو لنا حسب نوع الحساب)",
  },
  credit: {
    tone: "bg-blue-50/60 hover:bg-blue-100/70",
    bar: "border-s-[3px] border-s-blue-400",
    chipCls: "border-blue-300 bg-blue-50/70 text-blue-800",
    label: "دائن",
    hint: "له رصيد دائن",
  },
  overLimit: {
    tone: "bg-rose-50/70 hover:bg-rose-100/80",
    bar: "border-s-[3px] border-s-rose-500",
    chipCls: "border-rose-300 bg-rose-50/70 text-rose-700",
    label: "تجاوز الائتمان",
    hint: "تجاوز حد الائتمان المسموح به",
  },
  hasVat: {
    tone: "",
    bar: "",
    chipCls: "border-blue-300 bg-white text-blue-700 border-e-4 border-e-blue-400",
    label: "مسجل ضريبياً",
    hint: "لديه رقم تسجيل ضريبي (VAT)",
  },
  hasSales: {
    tone: "",
    bar: "",
    chipCls: "border-emerald-300 bg-emerald-50/40 text-emerald-700",
    label: "له مبيعات",
    hint: "حقَّق مبيعات خلال الفترة",
  },
  noSales: {
    tone: "",
    bar: "",
    chipCls: "border-slate-300 bg-slate-50 text-slate-600",
    label: "بدون مبيعات",
    hint: "لم يحقق أي مبيعات بعد",
  },
};

/* ─────────────────────── ZATCA acknowledgement chips ──────────────────── */

/** ZATCA acknowledgement: rendered as an end-edge marker on the row. */
export const ZATCA_TONES = {
  approved: {
    bar: "border-e-2 border-e-emerald-400",
    chipCls: "border-emerald-300 bg-white text-emerald-700 border-e-4 border-e-emerald-400",
    label: "مؤكَّدة زاتكا",
    hint: "تأكدت من زاتكا — شريط أخضر في طرف السطر",
  },
  rejected: {
    bar: "border-e-2 border-e-rose-500",
    chipCls: "border-rose-300 bg-white text-rose-700 border-e-4 border-e-rose-500",
    label: "مرفوضة زاتكا",
    hint: "رفضت من زاتكا — شريط أحمر في طرف السطر",
  },
} as const;

/* ──────────────────────────── rowToneFor() ─────────────────────────────── */

export interface RowToneInput {
  status: string | undefined | null;
  /** True if this row has a related return doc (rose overlay). */
  hasReturn?: boolean;
  /**
   * True if this row has been converted to another doc (e.g. quote → order
   * → invoice). Adds a violet end-edge marker without overriding the status
   * tone background.
   */
  hasConverted?: boolean;
  /** ZATCA acknowledgement state; only "approved" and "rejected" render. */
  zatcaStatus?: string | undefined | null;
  /**
   * Map of status keys this screen recognises. Defaults to TX_TONES; pass
   * DICT_TONES for dictionary screens, or a custom subset.
   */
  statusMap?: Record<string, StatusTone>;
}

/**
 * Returns the combined Tailwind class string for a single row.
 * Caller is expected to gate this behind `isSel ? SEL_TONE : rowToneFor(...)`
 * so the bulk-select tint always wins.
 */
export function rowToneFor(input: RowToneInput): string {
  const { status, hasReturn, hasConverted, zatcaStatus, statusMap = TX_TONES } = input;
  const st = (status && statusMap[status]) || undefined;

  let tone = "";
  let bar = "";
  if (st) {
    tone = st.tone;
    bar = st.bar;
  } else {
    tone = "hover:bg-amber-50/60";
  }

  // "Returned" overlay replaces the base tone (instead of stacking) so the
  // rose really stands out instead of muddying with the status color. We
  // never overlay on cancelled rows — those stay muted.
  if (hasReturn && status !== "cancelled") {
    tone = TX_TONES.returned.tone;
    bar = TX_TONES.returned.bar;
  }

  // End-edge marker: ZATCA wins over "converted" if both are present, since
  // ZATCA is the audit-critical signal. Skipped on cancelled rows.
  let endBar = "";
  if (status !== "cancelled") {
    const z = String(zatcaStatus ?? "");
    if (z === "approved") endBar = ZATCA_TONES.approved.bar;
    else if (z === "rejected") endBar = ZATCA_TONES.rejected.bar;
    else if (hasConverted) endBar = "border-e-2 border-e-violet-400";
  }

  return cn(tone, bar, endBar);
}

/* ──────────────────────────── <DocColorLegend> ─────────────────────────── */

/**
 * One entry in the legend strip. `kind` references a known tone (TX_TONES,
 * DICT_TONES, or ZATCA). `count` is rendered as the trailing chip number
 * — typically derived from the FILTERED row set, not the raw data.
 *
 * Use `kind: "zatca-ok"` / `"zatca-bad"` for the ZATCA acknowledgement chips
 * (they get a special end-edge mark so the user understands it's an end-bar
 * marker, not a row-bg color).
 */
export type LegendKind =
  | keyof typeof TX_TONES
  | keyof typeof DICT_TONES
  | "zatca-ok"
  | "zatca-bad";

export interface LegendItem {
  kind: LegendKind;
  count: number;
  /** Override the default Arabic label for this chip. */
  labelOverride?: string;
  /** Override the default Arabic hint/tooltip for this chip. */
  hintOverride?: string;
}

interface DocColorLegendProps {
  items: LegendItem[];
  /** Optional leading caption — defaults to "دلالة الألوان:". */
  caption?: string;
  /**
   * Optional separator indices (0-based). A vertical "|" is drawn after each
   * listed index to group related chips (e.g. ZATCA chips after status chips).
   */
  separatorAfter?: number[];
  /** Extra classes to merge into the wrapper. */
  className?: string;
}

function lookupTone(kind: LegendKind): { chipCls: string; label: string; hint: string } {
  if (kind === "zatca-ok")  return ZATCA_TONES.approved;
  if (kind === "zatca-bad") return ZATCA_TONES.rejected;
  if (kind in TX_TONES)   return TX_TONES[kind as keyof typeof TX_TONES];
  if (kind in DICT_TONES) return DICT_TONES[kind as keyof typeof DICT_TONES];
  // Fallback (unknown) — render as neutral slate so we don't crash on typos.
  return {
    chipCls: "border-slate-300 bg-slate-100 text-slate-600",
    label: String(kind),
    hint: "",
  };
}

export function DocColorLegend({
  items,
  caption = "دلالة الألوان:",
  separatorAfter = [],
  className,
}: DocColorLegendProps): ReactNode {
  if (items.length === 0) return null;
  const sepSet = new Set(separatorAfter);
  return (
    <div
      data-testid="row-color-legend"
      className={cn(
        "flex items-center gap-1.5 flex-wrap px-3 py-1.5 bg-gradient-to-l from-slate-50 to-white border-x border-t border-slate-300 text-slate-600",
        className,
      )}
    >
      <span className="text-[10.5px] font-semibold text-slate-500 me-1">{caption}</span>
      {items.map((item, idx) => {
        const tone = lookupTone(item.kind);
        const label = item.labelOverride ?? tone.label;
        const hint = item.hintOverride ?? tone.hint;
        return (
          <span key={`${item.kind}-${idx}`} className="contents">
            <button
              type="button"
              title={hint}
              data-testid={`legend-${label}`}
              className={cn(
                "group inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10.5px] font-medium transition-all hover:scale-[1.02] hover:shadow-sm cursor-help",
                tone.chipCls,
              )}
            >
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm shadow-inner shrink-0"
                style={{ background: "currentColor", opacity: 0.65 }}
              />
              <span>{label}</span>
              <span className="font-mono text-[10px] tabular-nums opacity-80 group-hover:opacity-100">
                ({item.count})
              </span>
            </button>
            {sepSet.has(idx) && <span className="mx-1 text-slate-300">|</span>}
          </span>
        );
      })}
    </div>
  );
}

/* ─────────────────── Status pill (in-cell) helpers ─────────────────────── */

/**
 * Inline status pill for the "الحالة" column. Same vocabulary and color
 * palette as the row tone, but rendered as a compact rounded badge.
 */
export interface StatusPillSpec {
  label: string;
  cls: string;
}

export const STATUS_PILLS: Record<string, StatusPillSpec> = {
  draft:       { label: "مسودة",    cls: "bg-amber-100 text-amber-800 border-amber-300" },
  posted:      { label: "مُرحَّلة", cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  cancelled:   { label: "ملغاة",    cls: "bg-slate-200 text-slate-700 border-slate-300" },
  confirmed:   { label: "مؤكَّدة",  cls: "bg-sky-100 text-sky-800 border-sky-300" },
  converted:   { label: "محوَّلة",  cls: "bg-violet-100 text-violet-800 border-violet-300" },
  sent:        { label: "مُرسَلة",  cls: "bg-blue-100 text-blue-800 border-blue-300" },
  accepted:    { label: "مقبولة",   cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  rejected:    { label: "مرفوضة",   cls: "bg-rose-100 text-rose-800 border-rose-300" },
  approved:    { label: "معتمدة",   cls: "bg-sky-100 text-sky-800 border-sky-300" },
  completed:   { label: "مكتملة",   cls: "bg-violet-100 text-violet-800 border-violet-300" },
  in_progress: { label: "قيد التنفيذ", cls: "bg-amber-100 text-amber-800 border-amber-300" },
  closed:      { label: "مغلقة",    cls: "bg-slate-200 text-slate-700 border-slate-300" },
  active:      { label: "نشط",      cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  inactive:    { label: "غير نشط", cls: "bg-slate-200 text-slate-600 border-slate-300" },
};

export const ZATCA_PILLS: Record<string, StatusPillSpec> = {
  pending:  { label: "بانتظار", cls: "bg-slate-100 text-slate-600 border-slate-300" },
  approved: { label: "مقبول",   cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  rejected: { label: "مرفوض",  cls: "bg-rose-100 text-rose-800 border-rose-300" },
};

/**
 * Build the row's "why is it tinted" tooltip from the active flags so the
 * user instantly knows what each color means.
 */
export function buildToneTooltip(input: {
  status?: string | null;
  hasReturn?: boolean;
  hasConverted?: boolean;
  zatcaStatus?: string | null;
  statusMap?: Record<string, StatusTone>;
}): string {
  const reasons: string[] = [];
  const map = input.statusMap ?? TX_TONES;
  const st = input.status ? map[input.status] : undefined;
  if (st) reasons.push(st.hint || st.label);
  if (input.hasReturn && input.status !== "cancelled") reasons.push("بها مرتجع");
  if (input.hasConverted && input.status !== "cancelled") reasons.push("محوَّلة إلى مستند آخر");
  if (input.zatcaStatus === "approved") reasons.push("مؤكَّدة من زاتكا ✓");
  if (input.zatcaStatus === "rejected") reasons.push("مرفوضة من زاتكا ✗");
  return reasons.length
    ? `${reasons.join(" · ")} — اضغط للتحديد، مرتين للفتح`
    : "اضغط لتحديد الصف، أو مرتين للفتح";
}
