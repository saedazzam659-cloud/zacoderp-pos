// Parked carts list — Task #175.
//
// Shows every cart the current cashier has parked in this session, with
// "استئناف" (resume → load back into SalesScreen) and "حذف" actions. The
// list is scoped to the current pos_session_id, so logging out / closing
// the shift clears it (handled by clearSessionParkedCarts on logout).

import { useCallback, useEffect, useState } from "react";
import {
  listParkedCarts, deleteParkedCart, setResumeCartId,
  type ParkedCart,
} from "../lib/parkedCarts";

type Props = {
  posSessionId: number;
  onResume: () => void;   // tells PosShell to switch view to "sales"
};

export default function ParkedCarts({ posSessionId, onResume }: Props) {
  const [rows, setRows] = useState<ParkedCart[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listParkedCarts(posSessionId));
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? "تعذّر تحميل السلال المعلّقة");
    } finally { setLoading(false); }
  }, [posSessionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function resume(c: ParkedCart) {
    setResumeCartId(c.id);
    onResume();
  }

  async function remove(c: ParkedCart) {
    if (!confirm(`حذف السلة "${c.label}"؟ لا يمكن التراجع.`)) return;
    try {
      await deleteParkedCart(c.id);
      await refresh();
    } catch (e: any) {
      setErr(e?.message ?? "تعذّر الحذف");
    }
  }

  return (
    <div dir="rtl" style={S.wrap}>
      <div style={S.headerRow}>
        <h2 style={S.h2}>السلال المعلّقة ({rows.length})</h2>
        <button onClick={refresh} style={S.refresh} disabled={loading}>
          {loading ? "..." : "🔄 تحديث"}
        </button>
      </div>

      {err && <div style={S.err}>⚠️ {err}</div>}

      {!loading && rows.length === 0 && !err && (
        <div style={S.empty}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>📭</div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>لا توجد سلال معلّقة</div>
          <div style={{ fontSize: 13, color: "#94a3b8" }}>اضغط "تعليق السلة" في شاشة البيع لحفظ سلة جانباً والعودة إليها لاحقاً.</div>
        </div>
      )}

      {rows.length > 0 && (
        <div style={S.list}>
          {rows.map(c => (
            <div key={c.id} style={S.card}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={S.cardLabel}>{c.label}</div>
                <div style={S.cardMeta}>
                  {c.lines.length} صنف · {c.grandTotal.toFixed(2)} ر.س ·{" "}
                  {new Date(c.updatedAt).toLocaleString("ar-SA")}
                </div>
                {c.customerNote && (
                  <div style={S.cardNote}>📝 {c.customerNote}</div>
                )}
                <div style={S.itemsPreview}>
                  {c.lines.slice(0, 3).map(l => (
                    <span key={l.itemId} style={S.itemChip}>
                      {l.nameAr} ×{l.qty}
                    </span>
                  ))}
                  {c.lines.length > 3 && (
                    <span style={S.moreChip}>+{c.lines.length - 3} أخرى</span>
                  )}
                </div>
              </div>
              <div style={S.actions}>
                <button onClick={() => resume(c)} style={S.btnResume}>▶️ استئناف</button>
                <button onClick={() => remove(c)} style={S.btnDelete}>🗑️ حذف</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const S = {
  wrap: { maxWidth: 980, margin: "0 auto", width: "100%" } as const,
  headerRow: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 } as const,
  h2: { margin: 0, fontSize: 18, color: "#0f172a" } as const,
  refresh: { padding: "6px 12px", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 6, cursor: "pointer", fontSize: 13 } as const,
  err: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 12, borderRadius: 6, marginBottom: 12, fontSize: 14 } as const,
  empty: { padding: 60, textAlign: "center" as const, color: "#475569", background: "#fff", border: "1px dashed #e2e8f0", borderRadius: 12 } as const,
  list: { display: "flex", flexDirection: "column" as const, gap: 12 } as const,
  card: {
    display: "flex", gap: 14, padding: 16,
    background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10,
    boxShadow: "0 1px 3px rgba(0,0,0,.04)",
    alignItems: "center" as const,
  } as const,
  cardLabel: { fontSize: 16, fontWeight: 700, color: "#0f172a" } as const,
  cardMeta:  { fontSize: 12, color: "#64748b", marginTop: 4 } as const,
  cardNote:  { fontSize: 12, color: "#92400e", background: "#fffbeb", padding: "4px 8px", borderRadius: 4, marginTop: 6, display: "inline-block" } as const,
  itemsPreview: { display: "flex", flexWrap: "wrap" as const, gap: 6, marginTop: 8 } as const,
  itemChip: { fontSize: 11, padding: "2px 8px", background: "#f1f5f9", color: "#475569", borderRadius: 999 } as const,
  moreChip: { fontSize: 11, padding: "2px 8px", background: "#e0f2fe", color: "#075985", borderRadius: 999 } as const,
  actions: { display: "flex", gap: 8, flexShrink: 0 } as const,
  btnResume: { padding: "10px 16px", background: "#16a34a", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600, fontFamily: "inherit" } as const,
  btnDelete: { padding: "10px 14px", background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 8, cursor: "pointer", fontSize: 14, fontFamily: "inherit" } as const,
};
