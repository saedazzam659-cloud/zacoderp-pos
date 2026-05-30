// Shared lightweight UI helpers for the standalone admin screens
// (Task #207). Mirrors the style used by StandaloneUsersAdmin so the
// new screens feel consistent without pulling in a UI framework.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { currencySymbol, CURRENCIES, baseCurrencyCode } from "../lib/currency";
import type { DiscType, DiscountResult } from "../lib/discount";

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
};

export function SearchCombobox({
  value, onChange, options, placeholder = "— اختر —", style, disabled, autoFocus,
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
    else if (e.key === "Enter") { e.preventDefault(); if (!open) { setOpen(true); return; } const o = filtered[hi]; if (o) pick(o); }
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
export function LineDiscountCell({ amount, type, gross, sym: symOverride, onAmount, onType }: {
  amount: number; type: DiscType; gross?: number; sym?: string;
  onAmount: (v: number) => void; onType: (t: DiscType) => void;
}) {
  const sym = symOverride ?? currencySymbol();
  const g = Number(gross) || 0;
  const a = Number(amount) || 0;
  let hint = "";
  if (a > 0 && g > 0) {
    if (type === "percent") {
      const val = g * Math.min(a, 100) / 100;
      hint = `= ${fmt(val)} ${sym}`;
    } else {
      const pct = Math.min(a, g) / g * 100;
      hint = `= ${fmt(pct)} %`;
    }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 150 }}>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input
          type="number" step="0.01" min={0} value={amount || ""}
          placeholder="0"
          onChange={(e) => onAmount(Number(e.target.value) || 0)}
          style={{ ...input, padding: "8px 8px" }}
        />
        <DiscTypeToggle value={type} onChange={onType} />
      </div>
      {hint && (
        <span style={{ fontSize: 11, fontWeight: 600, color: "#2563eb", fontVariantNumeric: "tabular-nums", paddingInlineStart: 2 }}>
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
  return Number(n || 0).toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
/** Format an amount with its currency code as suffix (defaults to SAR → "ر.س"). */
export function fmtCurrency(n: number, code: string = "SAR", decimals = 2): string {
  const txt = Number(n || 0).toLocaleString("ar-SA", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const suffix = code === "SAR" ? currencySymbol() : code;
  return `${txt} ${suffix}`;
}
export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}
