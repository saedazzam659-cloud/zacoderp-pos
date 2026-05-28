// Shared lightweight UI helpers for the standalone admin screens
// (Task #207). Mirrors the style used by StandaloneUsersAdmin so the
// new screens feel consistent without pulling in a UI framework.

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

export function fmt(n: number): string {
  return Number(n || 0).toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}
