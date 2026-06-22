// Shared lightweight UI helpers for the standalone admin screens
// (Task #207). Mirrors the style used by StandaloneUsersAdmin so the
// new screens feel consistent without pulling in a UI framework.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { currencySymbol, CURRENCIES, baseCurrencyCode } from "../lib/currency";
import { getDecimals } from "../lib/appSettings";
import type { DiscType, DiscountResult } from "../lib/discount";
import { exportToExcel, exportToPdf, type ExportColumn } from "../lib/exporters";

export function Page({ title, subtitle, right, children }: {
  title: string; subtitle?: string; right?: ReactNode; children: ReactNode;
}) {
  return (
    <div dir="rtl" style={{ padding: 24, maxWidth: 1280, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>{title}</h2>
          {subtitle && <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>{subtitle}</div>}
        </div>
        <div>{right}</div>
      </div>
      {children}
    </div>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ background: "#fff", borderRadius: 12, overflow: "hidden", border: "1px solid #e2e8f0", ...style }}>{children}</div>;
}

export function Table({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <table style={{ width: "100%", borderCollapse: "collapse", ...style }}>{children}</table>;
}
export function Th({ children, style, colSpan, rowSpan }: { children?: ReactNode; style?: CSSProperties; colSpan?: number; rowSpan?: number }) {
  return <th colSpan={colSpan} rowSpan={rowSpan} style={{ textAlign: "right", padding: "10px 14px", fontSize: 12, color: "#64748b", fontWeight: 600, background: "#f8fafc", ...style }}>{children}</th>;
}
export function Td({ children, mono, num, style, colSpan, rowSpan }: { children?: ReactNode; mono?: boolean; num?: boolean; style?: CSSProperties; colSpan?: number; rowSpan?: number }) {
  return <td colSpan={colSpan} rowSpan={rowSpan} style={{
    padding: "10px 14px", fontSize: 14, borderTop: "1px solid #f1f5f9",
    fontFamily: mono ? "ui-monospace, monospace" : undefined,
    textAlign: num ? "left" : undefined,
    fontVariantNumeric: num ? "tabular-nums" : undefined,
    ...style,
  }}>{children}</td>;
}

export function Modal({ title, children, onCancel, wide }: { title: string; children: ReactNode; onCancel: () => void; wide?: boolean }) {
  return (
    <div dir="rtl" onClick={onCancel}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 12, padding: 24, width: wide ? 880 : 480, maxWidth: "94vw", maxHeight: "92vh", overflowY: "auto" }}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children, style }: { label: string; children: ReactNode; style?: CSSProperties }) {
  return <label style={{ display: "block", marginBottom: 10, ...style }}>
    <div style={{ marginBottom: 4, fontSize: 13, fontWeight: 600 }}>{label}</div>
    {children}
  </label>;
}
export function Row({ children }: { children: ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>{children}</div>;
}
export function ErrorMsg({ text }: { text: string | null }) {
  if (!text) return null;
  return <div style={{ padding: 8, background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 6, fontSize: 13, marginTop: 8 }}>⚠️ {text}</div>;
}

// ── Back-office document validation ────────────────────────────────────────
// Shared, field-by-field required-fields check for the back-office document
// forms (sales/purchase invoices, quotations, sales orders, sales/purchase
// returns). It names EVERY missing header field and, per line row, every
// unfilled column so the cashier knows exactly what to complete.
// NOTE: the POS register (SalesScreen / ReturnsScreen) does NOT use this.
export interface DocLineCheck {
  itemId: number;
  uomId: number | null;
  price: number;
  qty: number;
}
export function collectDocIssues(
  header: { label: string; ok: boolean }[],
  lines: DocLineCheck[],
  priceLabel = "السعر",
): string[] {
  const issues: string[] = [];
  for (const h of header) if (!h.ok) issues.push(`${h.label} مطلوب`);
  let anyLine = false;
  lines.forEach((l, i) => {
    // A row with no item, no price AND no unit-of-measure is treated as an
    // empty/trailing row and skipped, so a stray blank line never blocks the
    // save. Picking a UoM (a deliberate action) marks the row as "started" so
    // a partially-filled row is validated rather than silently dropped.
    const blank = !l.itemId && !(l.price > 0) && !l.uomId;
    if (blank) return;
    anyLine = true;
    const miss: string[] = [];
    if (!l.itemId) miss.push("الصنف");
    if (!l.uomId) miss.push("وحدة القياس");
    if (!(l.price > 0)) miss.push(priceLabel);
    if (!(l.qty > 0)) miss.push("الكمية");
    if (miss.length) issues.push(`السطر ${i + 1}: ${miss.join("، ")}`);
  });
  if (!anyLine) issues.push("أضف صنفاً واحداً على الأقل مع تعبئة بياناته");
  return issues;
}
// Attractive, scannable error card listing each unfilled field.
export function ValidationPanel({ issues }: { issues: string[] }) {
  if (!issues.length) return null;
  return (
    <div style={{ marginTop: 10, border: "1px solid #fecaca", background: "#fff", borderRadius: 10, overflow: "hidden", boxShadow: "0 2px 10px rgba(220,38,38,.12)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", background: "#fee2e2", color: "#991b1b", fontWeight: 800, fontSize: 13 }}>
        <span style={{ fontSize: 16 }}>⚠️</span> تعذّر الحفظ — يرجى إكمال الحقول التالية
      </div>
      <ul style={{ margin: 0, padding: "10px 30px 12px", color: "#b91c1c", fontSize: 13, lineHeight: 2, listStyleType: "disc" }}>
        {issues.map((t, i) => <li key={i}>{t}</li>)}
      </ul>
    </div>
  );
}
export function Actions({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>{children}</div>;
}
export function Empty({ text }: { text: string }) {
  return <div style={{ padding: 48, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>{text}</div>;
}

export const input: CSSProperties = { width: "100%", padding: "8px 10px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 14, boxSizing: "border-box", fontFamily: "inherit" };
export const btnPrimary: CSSProperties = { padding: "8px 16px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600 };
export const btnSecondary: CSSProperties = { padding: "8px 16px", background: "#f1f5f9", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 14 };
export const btnDanger: CSSProperties = { padding: "6px 12px", background: "#fee2e2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 13 };
export const btnLink: CSSProperties = { background: "none", border: "none", color: "#2563eb", cursor: "pointer", fontFamily: "inherit", fontSize: 13, padding: 0 };

// ─── Row-action chips ────────────────────────────────────────────────
// A more attractive, consistent replacement for the bare text `btnLink`
// used inside table row action cells (ترحيل / تعديل / حذف / فك الترحيل …).
// Renders a small tinted pill with a soft border per semantic tone, so the
// invoice grids read as proper buttons rather than plain hyperlinks.
export type ChipTone = "default" | "primary" | "success" | "warn" | "danger" | "purple";
const CHIP_TONES: Record<ChipTone, { bg: string; fg: string; border: string }> = {
  default: { bg: "#f1f5f9", fg: "#334155", border: "#e2e8f0" },
  primary: { bg: "#eff6ff", fg: "#1d4ed8", border: "#bfdbfe" },
  success: { bg: "#ecfdf5", fg: "#15803d", border: "#bbf7d0" },
  warn:    { bg: "#fffbeb", fg: "#b45309", border: "#fde68a" },
  danger:  { bg: "#fef2f2", fg: "#dc2626", border: "#fecaca" },
  purple:  { bg: "#faf5ff", fg: "#7c3aed", border: "#e9d5ff" },
};
export function actionChip(tone: ChipTone = "default", disabled = false): CSSProperties {
  const t = CHIP_TONES[tone];
  return {
    display: "inline-flex", alignItems: "center", gap: 4,
    padding: "4px 11px", background: t.bg, color: t.fg,
    border: `1px solid ${t.border}`, borderRadius: 999,
    cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1,
    fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, lineHeight: 1.4,
    whiteSpace: "nowrap", transition: "filter .12s ease",
  };
}

// ─── Top action bar + single-row selection ───────────────────────────
// Document grids expose their per-row verbs (عرض/طباعة/إرجاع/ترحيل/تعديل/
// حذف/فك الترحيل …) from ONE attractive bar above the table instead of a
// cramped action cell on every row. The user ticks a single row (radio), the
// bar lights up the verbs valid for THAT row's status, and clicking runs the
// existing handler against the selected id. `useRowSelect` also self-clears
// the selection when the chosen row vanishes after a refresh.
export function useRowSelect<T extends { id: number }>(rows: T[]) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  useEffect(() => {
    if (selectedId != null && !rows.some((r) => r.id === selectedId)) setSelectedId(null);
  }, [rows, selectedId]);
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const toggle = (id: number) => setSelectedId((cur) => (cur === id ? null : id));
  return { selectedId, setSelectedId, selected, toggle, clear: () => setSelectedId(null) };
}

// Narrow leading header cell for the selection column.
export function SelectTh() {
  return <Th style={{ width: 36 }}></Th>;
}

// Leading row cell carrying the selection radio. Clicking the row's radio
// (or the cell) selects it; clicking the active one again clears it.
export function SelectCell({ id, selectedId, onToggle }: { id: number; selectedId: number | null; onToggle: (id: number) => void }) {
  const on = selectedId === id;
  return (
    <Td style={{ width: 36, textAlign: "center" }}>
      <input type="radio" name="rowsel" checked={on} onChange={() => onToggle(id)}
        onClick={() => { if (on) onToggle(id); }} aria-label="تحديد الصف"
        style={{ cursor: "pointer", width: 16, height: 16, accentColor: "#2563eb" }} />
    </Td>
  );
}

// The sticky-feeling top bar. `selectedLabel` shows what's currently ticked
// (e.g. the document number) so the user knows what the verbs will act on.
export function ActionBar({ selectedLabel, children }: { selectedLabel?: ReactNode; children: ReactNode }) {
  return (
    <div style={{
      display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center",
      padding: "10px 12px", marginBottom: 12, background: "#f8fafc",
      border: "1px solid #e2e8f0", borderRadius: 10,
    }}>
      <span style={{ fontSize: 12.5, fontWeight: 700, color: "#475569", marginInlineEnd: 4 }}>
        {selectedLabel ? <>المحدّد: <span style={{ color: "#0f172a" }}>{selectedLabel}</span></> : "اختر صفاً من الجدول لتفعيل الإجراءات"}
      </span>
      <div style={{ flex: 1 }} />
      {children}
    </div>
  );
}

// A verb button for the ActionBar. `tone` maps to the same chip palette; the
// button is disabled (greyed) when the verb is invalid for the selection.
export function ActionBtn({ label, icon, tone = "default", onClick, disabled, title }: {
  label: string; icon?: string; tone?: ChipTone; onClick: () => void; disabled?: boolean; title?: string;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title ?? label}
      style={{ ...actionChip(tone, disabled), padding: "7px 14px", fontSize: 13 }}>
      {icon ? <span aria-hidden>{icon}</span> : null} {label}
    </button>
  );
}

// ─── Tauri error text ────────────────────────────────────────────────
// Tauri `Err(String)` rejects `invoke` with a RAW string, so `e.message` is
// undefined and naive `e?.message ?? "fallback"` hides the real cause. Always
// surface the string when present.
export function errText(e: unknown, fallback: string): string {
  if (typeof e === "string" && e.trim()) return e;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m;
  }
  return fallback;
}

// ─── Searchable combobox ─────────────────────────────────────────────
// Drop-in replacement for <select>. Renders a clickable trigger styled
// like an <input>, opens a popover with a search box + filtered list.
// Arrow-keys navigate, Enter selects, Esc/click-outside closes.
//
// API:
//   value      — currently selected option value (matched by ===)
//   onChange   — fires with the picked option's raw value
//   options    — array of { value, label } (also accepts disabled/hint)
//   placeholder— shown when nothing is selected
//   style      — overrides the trigger styling (defaults to `input`)
//   disabled   — disables the trigger entirely
//
// Drop-in usage (replaces a <select>):
//   <SearchCombobox
//     value={warehouseId}
//     onChange={(v) => setWarehouseId(v === "" ? "" : Number(v))}
//     options={[
//       { value: "", label: "— اختر —" },
//       ...warehouses.map(w => ({ value: w.id, label: w.name })),
//     ]}
//   />

export type ComboOption = {
  value: string | number;
  label: string;
  hint?: string;
  disabled?: boolean;
};

type ComboProps = {
  value: string | number | null | undefined;
  onChange: (v: string | number) => void;
  options: ComboOption[];
  placeholder?: string;
  style?: CSSProperties;
  disabled?: boolean;
  autoFocus?: boolean;
  /** When set, the inner input gets a `data-fnav` attribute so a parent
   *  Enter-to-advance handler can include it in the focus order. */
  navAttr?: string;
  /** Optional className forwarded to the inner input (e.g. for a focus ring). */
  inputClassName?: string;
  /** Fires when the user presses Enter to pick a highlighted option (or, when
   *  closed with a value already chosen, to skip ahead). Receives the inner
   *  input element so the parent can move focus to the next field. */
  onEnterNavigate?: (fromEl: HTMLElement | null) => void;
};

export function SearchCombobox({
  value, onChange, options, placeholder = "— اختر —", style, disabled, autoFocus,
  navAttr, inputClassName, onEnterNavigate,
}: ComboProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; openUp: boolean } | null>(null);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return options;
    return options.filter((o) => o.label.toLowerCase().includes(s)
      || (o.hint ?? "").toLowerCase().includes(s)
      || String(o.value).toLowerCase().includes(s));
  }, [options, q]);

  const selected = useMemo(
    () => options.find((o) => o.value === value) ?? null,
    [options, value],
  );

  useEffect(() => {
    if (!open) return;
    function onDocDown(e: MouseEvent) {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      closeAndReset();
    }
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [open]);

  useEffect(() => {
    if (!open) { setPos(null); return; }
    function recompute() {
      const el = inputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const POP_MAX = 300;
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < POP_MAX + 8 && r.top > spaceBelow;
      setPos({
        top: openUp ? r.top : r.bottom,
        left: r.left,
        width: r.width,
        openUp,
      });
    }
    recompute();
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    return () => {
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
    };
  }, [open]);

  useEffect(() => { if (open) setHi(Math.max(0, filtered.findIndex((o) => o.value === value))); }, [open]);
  useEffect(() => { setHi(0); }, [q]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[hi] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [hi, open]);

  function closeAndReset() { setOpen(false); setQ(""); }

  function pick(o: ComboOption) {
    if (o.disabled) return;
    onChange(o.value);
    closeAndReset();
    inputRef.current?.blur();
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); if (!open) { setOpen(true); return; } setHi((h) => Math.min(filtered.length - 1, h + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (!open) {
        // Fast data entry: Enter on a field that already holds a real
        // selection jumps to the next field instead of re-opening the list.
        // Use `selected` (a matching option exists) rather than a value
        // sentinel, so legitimate value 0 (e.g. customerId=0 "بدون عميل")
        // still advances.
        if (onEnterNavigate && selected != null) { onEnterNavigate(inputRef.current); return; }
        setOpen(true); return;
      }
      const o = filtered[hi];
      if (o) { pick(o); if (onEnterNavigate) onEnterNavigate(inputRef.current); }
    }
    else if (e.key === "Escape") { e.preventDefault(); closeAndReset(); inputRef.current?.blur(); }
  }

  // The field itself is the typeable input: closed → shows the selected label,
  // open → shows the live query. Results attach flush beneath it.
  const fieldStyle: CSSProperties = {
    ...(style ?? input),
    background: disabled ? "#f1f5f9" : "#fff",
    cursor: disabled ? "not-allowed" : "text",
    textAlign: "right",
    ...(open && pos ? { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } : null),
  };

  return (
    <div ref={rootRef} style={{ position: "relative", width: "100%" }}>
      <span style={{ position: "absolute", insetInlineStart: 8, top: "50%", transform: "translateY(-50%)", fontSize: 10, color: "#94a3b8", pointerEvents: "none" }}>▾</span>
      <input
        ref={inputRef}
        type="text"
        className={inputClassName}
        {...(navAttr ? { "data-fnav": navAttr } : {})}
        disabled={disabled}
        autoFocus={autoFocus}
        value={open ? q : (selected ? selected.label : "")}
        placeholder={selected ? selected.label : placeholder}
        onChange={(e) => { setQ(e.target.value); if (!open) setOpen(true); }}
        onFocus={() => { if (!disabled) { setOpen(true); setQ(""); } }}
        onMouseDown={() => { if (!disabled && !open) { setOpen(true); setQ(""); } }}
        onBlur={(e) => {
          // Close on focus leaving the field (e.g. Tab), but not when focus
          // moves into the popup (clicking an option fires pick() itself).
          const next = e.relatedTarget as Node | null;
          if (next && (rootRef.current?.contains(next) || popRef.current?.contains(next))) return;
          closeAndReset();
        }}
        onKeyDown={onKey}
        style={{ ...fieldStyle, paddingInlineStart: 22 }}
      />
      {open && pos && (
        <div
          ref={popRef}
          style={{
            position: "fixed",
            top: pos.openUp ? undefined : pos.top,
            bottom: pos.openUp ? window.innerHeight - pos.top : undefined,
            left: pos.left,
            minWidth: pos.width, width: pos.width, maxWidth: "min(420px, 92vw)",
            background: "#fff", border: "1px solid #2563eb",
            borderTop: pos.openUp ? "1px solid #2563eb" : "none",
            borderBottom: pos.openUp ? "none" : "1px solid #2563eb",
            borderRadius: pos.openUp ? "6px 6px 0 0" : "0 0 6px 6px",
            boxShadow: pos.openUp ? "0 -6px 16px rgba(15,23,42,.08)" : "0 6px 16px rgba(15,23,42,.08)",
            zIndex: 9999, overflowY: "auto", maxHeight: 280,
          }}
        >
          <div ref={listRef}>
            {filtered.length === 0 ? (
              <div style={{ padding: 14, textAlign: "center", color: "#94a3b8", fontSize: 13 }}>لا توجد نتائج</div>
            ) : filtered.map((o, idx) => {
              const isSel = o.value === value;
              const isHi = idx === hi;
              return (
                <div
                  key={`${o.value}-${idx}`}
                  onMouseEnter={() => setHi(idx)}
                  onMouseDown={(e) => { e.preventDefault(); pick(o); }}
                  style={{
                    padding: "8px 12px", fontSize: 14, cursor: o.disabled ? "not-allowed" : "pointer",
                    background: isHi ? "#eff6ff" : (isSel ? "#f1f5f9" : "transparent"),
                    color: o.disabled ? "#94a3b8" : "inherit",
                    fontWeight: isSel ? 600 : 400,
                    display: "flex", justifyContent: "space-between", gap: 8,
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{o.label}</span>
                  {o.hint && <span style={{ color: "#94a3b8", fontSize: 12 }}>{o.hint}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Discount controls ───────────────────────────────────────────────
// Compact %/value toggle shared by the per-line discount cell and the
// header (whole-invoice) discount control.
function DiscTypeToggle({ value, onChange, disabled }: {
  value: DiscType; onChange: (t: DiscType) => void; disabled?: boolean;
}) {
  const seg: CSSProperties = {
    border: "none", background: "transparent", cursor: disabled ? "default" : "pointer",
    fontFamily: "inherit", fontSize: 12, fontWeight: 700, padding: "0 8px", color: "#64748b",
  };
  const on: CSSProperties = { background: "#2563eb", color: "#fff", borderRadius: 5 };
  return (
    <div style={{ display: "inline-flex", alignItems: "center", border: "1px solid #cbd5e1", borderRadius: 6, background: "#fff", padding: 2, height: 34 }}>
      <button type="button" disabled={disabled} onClick={() => onChange("percent")} style={{ ...seg, ...(value === "percent" ? on : null) }}>%</button>
      <button type="button" disabled={disabled} onClick={() => onChange("value")} style={{ ...seg, ...(value === "value" ? on : null) }}>{currencySymbol()}</button>
    </div>
  );
}

/** Per-line discount cell: a number input + %/value toggle, plus a live
 *  readout of the converted equivalent. When you type a percent it shows the
 *  resulting value (from `gross` = qty×unit); when you type a value it shows
 *  the equivalent percent. */
export function LineDiscountCell({ amount, type, gross, sym: symOverride, onAmount, onType, navAttr, inputClassName, onEnterNavigate }: {
  amount: number; type: DiscType; gross?: number; sym?: string;
  onAmount: (v: number) => void; onType: (t: DiscType) => void;
  navAttr?: string; inputClassName?: string; onEnterNavigate?: (fromEl: HTMLElement | null) => void;
}) {
  const sym = symOverride ?? currencySymbol();
  const g = Number(gross) || 0;
  const a = Number(amount) || 0;
  // Always surface the *value* of the discount in currency (plus the % it
  // represents) so the cashier clearly sees how much is being deducted on this
  // line — not just the raw % they typed.
  let hint = "";
  if (a > 0 && g > 0) {
    if (type === "percent") {
      const val = g * Math.min(a, 100) / 100;
      hint = `خصم −${fmt(val)} ${sym} (${fmt(Math.min(a, 100))}%)`;
    } else {
      const val = Math.min(a, g);
      const pct = val / g * 100;
      hint = `خصم −${fmt(val)} ${sym} (${fmt(pct)}%)`;
    }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 160 }}>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input
          type="number" step="0.01" min={0} value={amount || ""}
          placeholder="0"
          onChange={(e) => onAmount(Number(e.target.value) || 0)}
          className={inputClassName}
          {...(navAttr ? { "data-fnav": navAttr } : {})}
          onKeyDown={onEnterNavigate ? (e) => { if (e.key === "Enter") { e.preventDefault(); onEnterNavigate(e.currentTarget); } } : undefined}
          style={{ ...input, padding: "8px 8px" }}
        />
        <DiscTypeToggle value={type} onChange={onType} />
      </div>
      {hint && (
        <span style={{ fontSize: 12, fontWeight: 700, color: "#b45309", fontVariantNumeric: "tabular-nums", paddingInlineStart: 2, whiteSpace: "nowrap" }}>
          {hint}
        </span>
      )}
    </div>
  );
}

/** Attractive totals panel; hosts the header (whole-invoice) discount control.
 *  When `rate` ≠ 1 (foreign-currency document) it also shows the grand total
 *  converted to the base currency. */
export function InvoiceTotals({ result, headerDisc, headerType, sym: symOverride, rate, onHeaderDisc, onHeaderType }: {
  result: DiscountResult;
  headerDisc: number; headerType: DiscType; sym?: string; rate?: number;
  onHeaderDisc: (v: number) => void; onHeaderType: (t: DiscType) => void;
}) {
  const sym = symOverride ?? currencySymbol();
  const m = (n: number) => `${fmt(n)} ${sym}`;
  const r = Number(rate) || 1;
  const showBase = r !== 1 && r > 0;
  const baseSym = currencySymbol();
  const hasLineDisc = result.lineDiscountTotal > 0.00001;
  const hasHeaderDisc = result.headerDiscountValue > 0.00001;
  const totalDisc = result.lineDiscountTotal + result.headerDiscountValue;
  const rowS: CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", fontSize: 14 };
  return (
    <div style={{ marginTop: 12, marginInlineStart: "auto", maxWidth: 420, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "12px 16px" }}>
      <div style={{ ...rowS, color: "#475569" }}>
        <span>الإجمالي قبل الخصم</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{m(result.grossSubtotal)}</span>
      </div>
      {hasLineDisc && (
        <div style={{ ...rowS, color: "#b45309" }}>
          <span>خصم الأصناف</span><span style={{ fontVariantNumeric: "tabular-nums" }}>− {m(result.lineDiscountTotal)}</span>
        </div>
      )}
      <div style={{ ...rowS, borderTop: "1px dashed #e2e8f0" }}>
        <span style={{ fontWeight: 600, color: "#0f172a" }}>خصم على الفاتورة</span>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <input
            type="number" step="0.01" min={0} value={headerDisc || ""} placeholder="0"
            onChange={(e) => onHeaderDisc(Number(e.target.value) || 0)}
            style={{ ...input, width: 96, padding: "6px 8px" }}
          />
          <DiscTypeToggle value={headerType} onChange={onHeaderType} />
        </div>
      </div>
      {hasHeaderDisc && (
        <div style={{ ...rowS, color: "#b45309", paddingTop: 0 }}>
          <span>قيمة خصم الفاتورة</span><span style={{ fontVariantNumeric: "tabular-nums" }}>− {m(result.headerDiscountValue)}</span>
        </div>
      )}
      {hasLineDisc && hasHeaderDisc && (
        <div style={{ ...rowS, borderTop: "1px dashed #e2e8f0", color: "#b45309", fontWeight: 700 }}>
          <span>إجمالي الخصم</span><span style={{ fontVariantNumeric: "tabular-nums" }}>− {m(totalDisc)}</span>
        </div>
      )}
      <div style={{ ...rowS, borderTop: "1px solid #e2e8f0", fontWeight: 600 }}>
        <span>الصافي قبل الضريبة</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{m(result.netSubtotal)}</span>
      </div>
      <div style={{ ...rowS, color: "#475569" }}>
        <span>ضريبة القيمة المضافة</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{m(result.vatTotal)}</span>
      </div>
      <div style={{ ...rowS, borderTop: "2px solid #2563eb", marginTop: 2, fontSize: 17, fontWeight: 800, color: "#1e3a8a" }}>
        <span>الإجمالي النهائي</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{m(result.grandTotal)}</span>
      </div>
      {showBase && (
        <div style={{ ...rowS, color: "#475569", fontSize: 13 }}>
          <span>الإجمالي بالعملة الأساسية</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(result.grandTotal * r)} {baseSym}</span>
        </div>
      )}
    </div>
  );
}

/** Header currency picker + exchange-rate input shared by the document forms.
 *  The exchange-rate input is locked to 1 while the base currency is selected;
 *  for a foreign currency the user enters the rate that converts one unit of
 *  the document currency into the base currency. */
export function CurrencyExchangeFields({ currency, exchangeRate, onCurrency, onRate }: {
  currency: string; exchangeRate: number;
  onCurrency: (code: string) => void; onRate: (v: number) => void;
}) {
  const base = baseCurrencyCode();
  const isBase = currency === base;
  return (
    <>
      <Field label="العملة">
        <SearchCombobox
          value={currency}
          onChange={(v) => onCurrency(String(v))}
          style={input}
          options={CURRENCIES.map((c) => ({
            value: c.code,
            label: `${c.nameAr ? c.nameAr + " " : ""}(${c.code})${c.code === base ? " — أساسية" : ""}`,
          }))}
        />
      </Field>
      <Field label="سعر الصرف">
        <input
          type="number" step="0.0001" min={0}
          value={isBase ? 1 : (exchangeRate || "")}
          disabled={isBase}
          placeholder="1"
          onChange={(e) => onRate(Number(e.target.value) || 0)}
          style={{ ...input, background: isBase ? "#f1f5f9" : "#fff", color: isBase ? "#64748b" : undefined }}
        />
      </Field>
    </>
  );
}

// ─── Pagination ──────────────────────────────────────────────────────
// Client-side pager for the admin tables. Caller slices its own rows; this
// component just renders the page-size selector + prev/next controls and a
// "showing X–Y of Z" summary. Page sizes per the user request.
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 500, 1000] as const;

/** Pure helper: given total count + 1-based page + size, return the slice
 *  bounds and a clamped page (so deleting rows never strands you on an empty
 *  page). `end` is exclusive — use rows.slice(start, end). */
export function pageSlice(total: number, page: number, size: number): { start: number; end: number; page: number; pageCount: number } {
  const pageCount = Math.max(1, Math.ceil(total / size));
  const clamped = Math.min(Math.max(1, page), pageCount);
  const start = (clamped - 1) * size;
  const end = Math.min(start + size, total);
  return { start, end, page: clamped, pageCount };
}

export function Pagination({
  total, page, pageSize, onPageChange, onPageSizeChange,
}: {
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
  onPageSizeChange: (s: number) => void;
}) {
  const { start, end, page: cur, pageCount } = pageSlice(total, page, pageSize);
  const from = total === 0 ? 0 : start + 1;
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 12, padding: "10px 14px", borderTop: "1px solid #f1f5f9", flexWrap: "wrap",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#64748b" }}>
        <span>عدد الصفوف:</span>
        <select
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          style={{ ...input, width: "auto", padding: "6px 10px", fontSize: 13 }}
        >
          {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div style={{ fontSize: 13, color: "#64748b", fontVariantNumeric: "tabular-nums" }}>
        عرض {from}–{end} من {total}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          onClick={() => onPageChange(cur - 1)}
          disabled={cur <= 1}
          style={{ ...btnSecondary, padding: "6px 12px", fontSize: 13, opacity: cur <= 1 ? 0.5 : 1, cursor: cur <= 1 ? "not-allowed" : "pointer" }}
        >السابق</button>
        <span style={{ fontSize: 13, color: "#475569", fontVariantNumeric: "tabular-nums", minWidth: 70, textAlign: "center" }}>
          {cur} / {pageCount}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(cur + 1)}
          disabled={cur >= pageCount}
          style={{ ...btnSecondary, padding: "6px 12px", fontSize: 13, opacity: cur >= pageCount ? 0.5 : 1, cursor: cur >= pageCount ? "not-allowed" : "pointer" }}
        >التالي</button>
      </div>
    </div>
  );
}

export function fmt(n: number): string {
  const dp = getDecimals();
  return Number(n || 0).toLocaleString("ar-SA", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
/** Format an amount with its currency code as suffix (defaults to SAR → "ر.س"). */
export function fmtCurrency(n: number, code: string = "SAR", decimals = getDecimals()): string {
  const txt = Number(n || 0).toLocaleString("ar-SA", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const suffix = code === "SAR" ? currencySymbol() : code;
  return `${txt} ${suffix}`;
}
export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────
// Reusable grid search / filter / sort engine (extracted from ItemsAdmin's
// Excel-like grid so every list screen — invoices, vouchers, POS — shares the
// same UX). Generic over the row type T; callers supply a column spec.
// ─────────────────────────────────────────────────────────────────────────

export type GridColType = "text" | "number";

export interface GridColumn<T> {
  key: string;
  label: string;
  type?: GridColType; // defaults to "text"
  /** Sort key + number-filter source. */
  value: (row: T) => string | number | null;
  /** Searchable/text-filter source. Defaults to String(value). */
  text?: (row: T) => string;
}

/** Number column quick-filter: supports >, >=, <, <=, =, a-b range, else substring. */
export function matchNumberExpr(val: number | null, expr: string): boolean {
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

function colText<T>(col: GridColumn<T>, row: T): string {
  if (col.text) return col.text(row);
  const v = col.value(row);
  return v == null ? "" : String(v);
}

export interface GridSort { key: string; dir: "asc" | "desc"; }

export interface GridFilter<T> {
  view: T[];
  search: string;
  setSearch: (s: string) => void;
  columnFilters: Record<string, string>;
  setColumnFilter: (key: string, value: string) => void;
  showFilters: boolean;
  setShowFilters: (v: boolean) => void;
  sort: GridSort | null;
  toggleSort: (key: string) => void;
  clearAll: () => void;
  hasActive: boolean;
}

/** Filter + sort `rows` by a quick global search (across all column text),
 *  optional per-column filters, and a single-column sort. Pure/derived — pair
 *  with Pagination on the returned `view`. */
export function useGridFilter<T>(rows: T[], columns: GridColumn<T>[]): GridFilter<T> {
  const [search, setSearch] = useState("");
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [showFilters, setShowFilters] = useState(false);
  const [sort, setSort] = useState<GridSort | null>(null);

  const setColumnFilter = (key: string, value: string) =>
    setColumnFilters((prev) => ({ ...prev, [key]: value }));

  const toggleSort = (key: string) =>
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });

  const clearAll = () => { setSearch(""); setColumnFilters({}); setSort(null); };

  const view = useMemo(() => {
    let list = rows.slice();
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((row) => columns.some((c) => colText(c, row).toLowerCase().includes(q)));
    }
    const fEntries = Object.entries(columnFilters).filter(([, v]) => (v ?? "").trim() !== "");
    if (fEntries.length) {
      list = list.filter((row) =>
        fEntries.every(([k, v]) => {
          const col = columns.find((c) => c.key === k);
          if (!col) return true;
          if ((col.type ?? "text") === "number") return matchNumberExpr(col.value(row) as number | null, v);
          return colText(col, row).toLowerCase().includes(v.trim().toLowerCase());
        }),
      );
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) {
        list.sort((a, b) => {
          const va = col.value(a); const vb = col.value(b);
          if (va == null && vb == null) return 0;
          if (va == null) return 1;
          if (vb == null) return -1;
          const cmp = (col.type ?? "text") === "number"
            ? (va as number) - (vb as number)
            : String(va).localeCompare(String(vb), "ar");
          return sort.dir === "asc" ? cmp : -cmp;
        });
      }
    }
    return list;
  }, [rows, columns, search, columnFilters, sort]);

  const hasActive = search.trim() !== "" || Object.values(columnFilters).some((v) => (v ?? "").trim() !== "");

  return { view, search, setSearch, columnFilters, setColumnFilter, showFilters, setShowFilters, sort, toggleSort, clearAll, hasActive };
}

/** Quick-search toolbar: search box + column-filter toggle + clear button.
 *  Drop above a <Table>; `extra` renders extra controls inline (e.g. tabs). */
export function GridToolbar<T>({ grid, placeholder, extra }: { grid: GridFilter<T>; placeholder?: string; extra?: ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
      <input
        value={grid.search}
        onChange={(e) => grid.setSearch(e.target.value)}
        placeholder={placeholder ?? "🔍 بحث…"}
        style={{ ...input, flex: 1, minWidth: 220, marginBottom: 0 }}
      />
      <button type="button" onClick={() => grid.setShowFilters(!grid.showFilters)}
        style={{ ...btnSecondary, background: grid.showFilters ? "#2563eb" : "#f1f5f9", color: grid.showFilters ? "#fff" : "#0f172a", border: grid.showFilters ? "1px solid #2563eb" : "1px solid #cbd5e1" }}
        title="إظهار صف فلتر تحت كل عمود">
        ⛃ فلاتر الأعمدة
      </button>
      {(grid.hasActive || grid.sort) && (
        <button type="button" onClick={grid.clearAll} style={{ ...btnSecondary, color: "#b91c1c" }}>✕ مسح الفلاتر</button>
      )}
      {extra}
    </div>
  );
}

/** Adapt the screen's existing GridColumn[] into export columns (header + cell)
 *  so list screens get Excel/PDF export with zero extra column definitions. */
export function gridToExportCols<T>(cols: GridColumn<T>[]): ExportColumn<T>[] {
  return cols.map((c) => ({
    header: c.label,
    cell: (r: T) => (c.text ? c.text(r) : c.value(r)),
  }));
}

/** Excel + PDF export buttons. Drop into a GridToolbar `extra` slot (pass
 *  `gridToExportCols(columns)` + `grid.view`) or any list/report screen with
 *  explicit ExportColumn[]. Both exports are fully offline. */
export function ExportButtons<T>({ columns, rows, filenameBase, title }: {
  columns: ExportColumn<T>[];
  rows: T[];
  filenameBase: string;
  title: string;
}) {
  const disabled = rows.length === 0;
  return (
    <>
      <button type="button" disabled={disabled}
        onClick={() => exportToExcel(filenameBase, columns, rows)}
        style={{ ...btnSecondary, opacity: disabled ? 0.5 : 1, cursor: disabled ? "default" : "pointer" }}
        title="تصدير إلى ملف إكسل (Excel)">⬇️ إكسل</button>
      <button type="button" disabled={disabled}
        onClick={() => exportToPdf(title, columns, rows)}
        style={{ ...btnSecondary, opacity: disabled ? 0.5 : 1, cursor: disabled ? "default" : "pointer" }}
        title="تصدير / طباعة PDF">🖨️ PDF</button>
    </>
  );
}

/** Sortable header cell. Renders the label + a sort arrow; click toggles
 *  asc → desc → off. Use in place of <Th> for sortable columns. */
export function SortableTh<T>({ grid, colKey, children, style }: { grid: GridFilter<T>; colKey: string; children?: ReactNode; style?: CSSProperties }) {
  const active = grid.sort?.key === colKey;
  const arrow = !active ? "↕" : grid.sort!.dir === "asc" ? "▲" : "▼";
  return (
    <Th style={{ ...style, cursor: "pointer", userSelect: "none" }}>
      <span onClick={() => grid.toggleSort(colKey)} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        {children}
        <span style={{ fontSize: 10, color: active ? "#2563eb" : "#cbd5e1" }}>{arrow}</span>
      </span>
    </Th>
  );
}

/** Per-column filter input row. Render inside <thead> below the header row when
 *  `grid.showFilters`. `columns` lists the filterable keys (in column order);
 *  `leading`/`trailing` add empty <th> cells to align with non-filter columns. */
export function GridFilterRow<T>({ grid, columns, leading = 0, trailing = 0 }: { grid: GridFilter<T>; columns: GridColumn<T>[]; leading?: number; trailing?: number }) {
  if (!grid.showFilters) return null;
  return (
    <tr style={{ background: "#f8fafc" }}>
      {Array.from({ length: leading }).map((_, i) => <th key={`l${i}`} />)}
      {columns.map((c) => (
        <th key={c.key} style={{ padding: "4px 6px" }}>
          <input
            value={grid.columnFilters[c.key] ?? ""}
            onChange={(e) => grid.setColumnFilter(c.key, e.target.value)}
            placeholder={(c.type ?? "text") === "number" ? "> 0 ، 1-9…" : "تصفية…"}
            style={{ ...input, marginBottom: 0, padding: "5px 8px", fontSize: 12 }}
          />
        </th>
      ))}
      {Array.from({ length: trailing }).map((_, i) => <th key={`t${i}`} />)}
    </tr>
  );
}
