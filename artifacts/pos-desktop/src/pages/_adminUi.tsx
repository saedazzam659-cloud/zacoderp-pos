// Shared lightweight UI helpers for the standalone admin screens
// (Task #207). Mirrors the style used by StandaloneUsersAdmin so the
// new screens feel consistent without pulling in a UI framework.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

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

export function Table({ children }: { children: ReactNode }) {
  return <table style={{ width: "100%", borderCollapse: "collapse" }}>{children}</table>;
}
export function Th({ children, style, colSpan }: { children?: ReactNode; style?: CSSProperties; colSpan?: number }) {
  return <th colSpan={colSpan} style={{ textAlign: "right", padding: "10px 14px", fontSize: 12, color: "#64748b", fontWeight: 600, background: "#f8fafc", ...style }}>{children}</th>;
}
export function Td({ children, mono, num, style, colSpan }: { children?: ReactNode; mono?: boolean; num?: boolean; style?: CSSProperties; colSpan?: number }) {
  return <td colSpan={colSpan} style={{
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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
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
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [open]);

  useEffect(() => {
    if (!open) { setPos(null); return; }
    function recompute() {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const POP_MAX = 320;
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < POP_MAX + 8 && r.top > spaceBelow;
      setPos({
        top: openUp ? r.top - 4 : r.bottom + 4,
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

  useEffect(() => {
    if (open) {
      setQ("");
      setHi(Math.max(0, filtered.findIndex((o) => o.value === value)));
      setTimeout(() => inputRef.current?.focus(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => { setHi(0); }, [q]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[hi] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [hi, open]);

  function pick(o: ComboOption) {
    if (o.disabled) return;
    onChange(o.value);
    setOpen(false);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(filtered.length - 1, h + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); const o = filtered[hi]; if (o) pick(o); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
  }

  const triggerStyle: CSSProperties = {
    ...(style ?? input),
    display: "flex", alignItems: "center", justifyContent: "space-between",
    cursor: disabled ? "not-allowed" : "pointer",
    background: disabled ? "#f1f5f9" : "#fff",
    textAlign: "right",
    overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis",
  };

  return (
    <div ref={rootRef} style={{ position: "relative", width: "100%" }}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        autoFocus={autoFocus}
        onClick={() => { if (!disabled) setOpen((o) => !o); }}
        onKeyDown={(e) => {
          if (!open && (e.key === "Enter" || e.key === "ArrowDown" || e.key === " ")) {
            e.preventDefault(); setOpen(true);
          }
        }}
        style={triggerStyle}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", color: selected ? "inherit" : "#94a3b8" }}>
          {selected ? selected.label : placeholder}
        </span>
        <span style={{ fontSize: 10, color: "#64748b", marginInlineStart: 6 }}>▾</span>
      </button>
      {open && pos && (
        <div
          ref={popRef}
          style={{
            position: "fixed",
            top: pos.openUp ? undefined : pos.top,
            bottom: pos.openUp ? window.innerHeight - pos.top : undefined,
            left: pos.left,
            minWidth: pos.width, width: pos.width, maxWidth: "min(420px, 92vw)",
            background: "#fff", border: "1px solid #cbd5e1", borderRadius: 6,
            boxShadow: "0 8px 24px rgba(15,23,42,.12)", zIndex: 9999,
            display: "flex", flexDirection: "column", maxHeight: 320,
          }}
        >
          <div style={{ padding: 8, borderBottom: "1px solid #e2e8f0", background: "#f8fafc" }}>
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKey}
              placeholder="بحث..."
              style={{ ...input, padding: "6px 10px", fontSize: 13 }}
            />
          </div>
          <div ref={listRef} style={{ overflowY: "auto", flex: 1 }}>
            {filtered.length === 0 ? (
              <div style={{ padding: 16, textAlign: "center", color: "#94a3b8", fontSize: 13 }}>لا توجد نتائج</div>
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

export function fmt(n: number): string {
  return Number(n || 0).toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}
