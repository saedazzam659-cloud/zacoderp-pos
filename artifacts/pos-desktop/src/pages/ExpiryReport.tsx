// Expiry report — pharmacy-vertical only (Task #200).
//
// Lists every item whose `expiry_date` is non-null and within the chosen
// horizon (default 90 days). Backed by `list_expiring_items` on Tauri and
// a client-side filter in the browser preview.
//
// Rows are bucketed into 3 severities so the operator can scan visually:
//   • منتهية (red)   — already past expiry
//   • عاجل (orange)  — ≤ 30 days
//   • قريب (amber)   — 31–horizon days
//
// "Print" is intentionally not wired in this first pass — the operator can
// screenshot or copy the table. Receipt printer integration lands later.

import { useEffect, useMemo, useState } from "react";
import { listExpiringItems, daysUntilExpiry, type LocalItem } from "../lib/items";

type Props = { onJumpToItems?: () => void };

function exportCsv(rows: LocalItem[]) {
  const esc = (v: any) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const headers = ["nameAr", "nameEn", "barcode", "expiryDate", "daysLeft", "batchNo", "activeIngredient", "dosageForm", "strength", "manufacturer", "salePrice"];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push([r.nameAr, r.nameEn, r.barcode, r.expiryDate, daysUntilExpiry(r), r.batchNo, r.activeIngredient, r.dosageForm, r.strength, r.manufacturer, r.salePrice].map(esc).join(","));
  }
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `expiry-report-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const HORIZONS = [30, 60, 90, 180, 365];

export default function ExpiryReport({ onJumpToItems }: Props = {}) {
  const [horizon, setHorizon] = useState<number>(90);
  const [rows, setRows] = useState<LocalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true); setErr(null);
      try {
        const r = await listExpiringItems(horizon);
        if (!cancelled) setRows(r);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message ?? "تعذّر تحميل التقرير");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [horizon]);

  // Spec thresholds: < 30 days = critical (red), 30..< 90 = warning (yellow).
  // Expired items fall inside critical and are tagged separately for clarity.
  const buckets = useMemo(() => {
    const expired: LocalItem[] = [];
    const critical: LocalItem[] = [];
    const warning: LocalItem[] = [];
    for (const r of rows) {
      const d = daysUntilExpiry(r);
      if (d === null) continue;
      if (d < 0) { expired.push(r); critical.push(r); }
      else if (d < 30) critical.push(r);
      else if (d < 90) warning.push(r);
    }
    return { expired, critical, warning };
  }, [rows]);

  return (
    <div dir="rtl" style={S.wrap}>
      <div style={S.header}>
        <div>
          <h2 style={S.h2}>تقرير الصلاحية ({rows.length})</h2>
          <div style={S.sub}>أصناف ستنتهي صلاحيتها خلال {horizon} يومًا — مرتبة من الأقرب انتهاءً</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button disabled={rows.length === 0} onClick={() => exportCsv(rows)} style={S.exportBtn} title="تصدير الجدول كملف CSV">
            ⬇️ تصدير CSV
          </button>
          <span style={{ fontSize: 13, color: "#475569" }}>الأفق الزمني:</span>
          <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} style={S.select}>
            {HORIZONS.map((h) => <option key={h} value={h}>{h} يوم</option>)}
          </select>
        </div>
      </div>

      <div style={S.summary}>
        <Card label="منتهية الصلاحية" count={buckets.expired.length} color="#dc2626" bg="#fef2f2" />
        <Card label="حرج (< 30 يوم)" count={buckets.critical.length} color="#dc2626" bg="#fef2f2" />
        <Card label={`تحذير (30 – < 90 يوم)`} count={buckets.warning.length} color="#ca8a04" bg="#fefce8" />
      </div>

      {err && <div style={S.err}>{err}</div>}
      {loading ? (
        <div style={S.empty}>... جاري التحميل</div>
      ) : rows.length === 0 ? (
        <div style={S.empty}>ممتاز! ما فيش أصناف ستنتهي صلاحيتها خلال {horizon} يومًا.</div>
      ) : (
        <table style={S.table}>
          <thead><tr>
            <th style={S.th}>الحالة</th>
            <th style={S.th}>تاريخ الصلاحية</th>
            <th style={S.th}>الأيام المتبقية</th>
            <th style={S.th}>الاسم</th>
            <th style={S.th}>المادة الفعّالة</th>
            <th style={S.th}>الجرعة</th>
            <th style={S.th}>التشغيلة</th>
            <th style={S.th}>الباركود</th>
          </tr></thead>
          <tbody>
            {rows.map((it) => {
              const d = daysUntilExpiry(it);
              const sev = d === null ? "" : d < 0 ? "expired" : d < 30 ? "critical" : "warning";
              const handleJump = () => {
                sessionStorage.setItem("pos_desktop_items_jump_edit_id", String(it.id));
                onJumpToItems?.();
              };
              return (
                <tr key={it.id} style={{ ...S.tr, cursor: onJumpToItems ? "pointer" : "default" }} onClick={onJumpToItems ? handleJump : undefined} title={onJumpToItems ? "افتح في شاشة الأصناف للتعديل" : undefined}>
                  <td style={S.td}><span style={sev === "expired" ? S.badgeExp : sev === "critical" ? S.badgeExp : S.badgeSoon}>
                    {sev === "expired" ? "منتهية" : sev === "critical" ? "حرج" : "تحذير"}
                  </span></td>
                  <td style={S.tdMono}>{it.expiryDate ?? "—"}</td>
                  <td style={S.tdMono}>{d === null ? "—" : d < 0 ? `${Math.abs(d)}- ` : d}</td>
                  <td style={S.td}>
                    <div style={{ fontWeight: 600 }}>{it.nameAr}</div>
                    {it.nameEn && <div style={S.muted}>{it.nameEn}</div>}
                  </td>
                  <td style={S.td}>{it.activeIngredient ?? "—"}</td>
                  <td style={S.td}>{[it.dosageForm, it.strength].filter(Boolean).join(" ") || "—"}</td>
                  <td style={S.tdMono}>{it.batchNo ?? "—"}</td>
                  <td style={S.tdMono}>{it.barcode ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Card({ label, count, color, bg }: { label: string; count: number; color: string; bg: string }) {
  return (
    <div style={{ background: bg, border: `1px solid ${color}33`, borderRadius: 10, padding: 16 }}>
      <div style={{ fontSize: 12, color, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 32, color, fontWeight: 700, marginTop: 4 }}>{count}</div>
    </div>
  );
}

const S = {
  wrap: { maxWidth: 1200, margin: "0 auto", width: "100%" } as const,
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 16 } as const,
  h2: { margin: 0, fontSize: 22, color: "#0f172a" } as const,
  sub: { fontSize: 13, color: "#64748b", marginTop: 4 } as const,
  select: { padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 13, fontFamily: "inherit", background: "#fff" } as const,
  exportBtn: { padding: "8px 14px", background: "#0f766e", color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: "pointer", fontWeight: 600 } as const,
  summary: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 16 } as const,
  empty: { padding: 40, textAlign: "center" as const, color: "#94a3b8", background: "#fff", border: "1px dashed #e2e8f0", borderRadius: 8 } as const,
  err: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 } as const,
  table: { width: "100%", borderCollapse: "collapse" as const, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" } as const,
  th: { textAlign: "right" as const, padding: "10px 12px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: 12, color: "#475569", fontWeight: 600 } as const,
  tr: { borderBottom: "1px solid #f1f5f9" } as const,
  td: { padding: "10px 12px", fontSize: 13, color: "#0f172a" } as const,
  tdMono: { padding: "10px 12px", fontSize: 12, color: "#0f172a", fontFamily: "ui-monospace, monospace" } as const,
  muted: { fontSize: 11, color: "#94a3b8", marginTop: 2 } as const,
  badgeExp: { display: "inline-block", padding: "3px 10px", background: "#fef2f2", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 999, fontSize: 11, fontWeight: 600 } as const,
  badgeUrg: { display: "inline-block", padding: "3px 10px", background: "#fff7ed", color: "#ea580c", border: "1px solid #fed7aa", borderRadius: 999, fontSize: 11, fontWeight: 600 } as const,
  badgeSoon: { display: "inline-block", padding: "3px 10px", background: "#fefce8", color: "#ca8a04", border: "1px solid #fef08a", borderRadius: 999, fontSize: 11, fontWeight: 600 } as const,
};
