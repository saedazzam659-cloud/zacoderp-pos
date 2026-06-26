// Low-stock report — items whose on-hand is ≤ reorderPoint.
// Counts shown live update on mount (no realtime — refresh on view-switch).
//
// Only items with `reorderPoint > 0` are considered "tracked for reorder"
// so untracked items (reorderPoint = 0) never appear here.

import { useEffect, useMemo, useState } from "react";
import { useDataRefresh } from "../lib/dataBus";
import { listItems, type LocalItem } from "../lib/items";
import {
  getStock,
  getAllStockShared,
  setStockShared,
  setReorderPointShared,
  countLowStockInMap,
  type StockMap,
} from "../lib/stock";
import { SearchCombobox } from "./_adminUi";

type Row = {
  item: LocalItem;
  qty: number;
  reorderPoint: number;
  shortfall: number;
};

export default function LowStockReport({ onGoToImport }: { onGoToImport?: () => void }) {
  const [items, setItems] = useState<LocalItem[]>([]);
  const [stockMap, setStockMap] = useState<StockMap>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"below" | "below_or_equal" | "all_tracked">("below_or_equal");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editQty, setEditQty] = useState("");
  const [editRp, setEditRp] = useState("");
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const all = await listItems();
      setItems(all);
      setStockMap(await getAllStockShared());
    } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  useDataRefresh(["stock", "items"], () => { void refresh(); });

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const it of items) {
      const s = stockMap[it.id];
      if (!s) continue;
      if (s.reorderPoint <= 0) continue; // not tracked for reorder
      const include = filter === "all_tracked" ? true
                    : filter === "below" ? s.qty < s.reorderPoint
                    : s.qty <= s.reorderPoint;
      if (!include) continue;
      out.push({
        item: it,
        qty: s.qty,
        reorderPoint: s.reorderPoint,
        shortfall: Math.max(0, s.reorderPoint - s.qty),
      });
    }
    out.sort((a, b) => b.shortfall - a.shortfall);
    const q = search.trim().toLowerCase();
    if (!q) return out;
    return out.filter((r) =>
      r.item.nameAr.includes(search) ||
      (r.item.nameEn ?? "").toLowerCase().includes(q) ||
      (r.item.barcode ?? "").includes(search) ||
      (r.item.code ?? "").toLowerCase().includes(q),
    );
  }, [items, stockMap, search, filter]);

  function startEdit(r: Row) {
    setEditingId(r.item.id);
    setEditQty(String(r.qty));
    setEditRp(String(r.reorderPoint));
  }
  function cancelEdit() { setEditingId(null); }
  async function saveEdit(id: number) {
    const q = Number(editQty);
    const rp = Number(editRp);
    if (!Number.isFinite(q) || q < 0) { setToast({ kind: "err", text: "الرصيد غير صالح" }); return; }
    if (!Number.isFinite(rp) || rp < 0) { setToast({ kind: "err", text: "حد الطلب غير صالح" }); return; }
    try {
      await setStockShared(id, q, rp);
      setEditingId(null);
      setStockMap(await getAllStockShared());
      setToast({ kind: "ok", text: "تم الحفظ" });
    } catch (e: any) {
      setToast({ kind: "err", text: e?.message ?? "فشل الحفظ — تعذّر الوصول للجهاز المضيف" });
    }
  }
  async function untrack(id: number, name: string) {
    if (!confirm(`إيقاف تتبّع الرصيد للصنف «${name}»؟ (سيتم تصفير حد الطلب)`)) return;
    try {
      await setReorderPointShared(id, 0);
      setStockMap(await getAllStockShared());
      setToast({ kind: "ok", text: "تم إيقاف التتبّع" });
    } catch (e: any) {
      setToast({ kind: "err", text: e?.message ?? "فشل — تعذّر الوصول للجهاز المضيف" });
    }
  }

  return (
    <div dir="rtl" style={S.wrap}>
      <div style={S.header}>
        <div>
          <h2 style={S.h2}>الأصناف تحت الحد الأدنى</h2>
          <div style={S.sub}>الأصناف التي وصلت أو نزلت عن حد إعادة الطلب — رتّبت حسب أكبر نقص</div>
        </div>
        {onGoToImport && (
          <button onClick={onGoToImport} style={S.btnGhost}>📥 استيراد أرصدة جديدة</button>
        )}
      </div>

      <div style={S.controls}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 بحث بالاسم أو الباركود..."
          style={S.search}
        />
        <div style={{ minWidth: 220 }}>
          <SearchCombobox
            value={filter}
            onChange={(v) => setFilter(v as any)}
            options={[
              { value: "below", label: "أقل من الحد الأدنى فقط" },
              { value: "below_or_equal", label: "عند الحد الأدنى أو أقل" },
              { value: "all_tracked", label: "كل الأصناف المتتبَّعة" },
            ]}
            style={S.select}
          />
        </div>
      </div>

      {toast && <div style={toast.kind === "ok" ? S.ok : S.err}>{toast.text}</div>}

      {loading ? <div style={S.empty}>... جاري التحميل</div>
      : rows.length === 0 ? (
        <div style={S.empty}>
          <div style={{ fontSize: 40 }}>✅</div>
          <div style={{ fontSize: 16, fontWeight: 600, marginTop: 8 }}>لا توجد أصناف تحت الحد الأدنى</div>
          <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>
            كل الأصناف المتتبَّعة فوق حد الطلب — أو لم يتم تحديد حد طلب لأي صنف بعد
          </div>
        </div>
      ) : (
        <div style={S.tableBox}>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>الاسم</th>
                <th style={S.th}>الباركود</th>
                <th style={S.th}>الرصيد الحالي</th>
                <th style={S.th}>حد الطلب</th>
                <th style={S.th}>النقص</th>
                <th style={S.thRight}>إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const editing = editingId === r.item.id;
                const critical = r.qty === 0;
                return (
                  <tr key={r.item.id} style={critical ? S.rowCritical : S.row}>
                    <td style={S.td}>
                      <div style={{ fontWeight: 600 }}>{r.item.nameAr}</div>
                      {r.item.nameEn && <div style={S.muted}>{r.item.nameEn}</div>}
                    </td>
                    <td style={S.tdMono}>{r.item.barcode ?? "—"}</td>
                    <td style={S.td}>
                      {editing ? (
                        <input value={editQty} onChange={(e) => setEditQty(e.target.value)} style={S.editInput} />
                      ) : (
                        <span style={critical ? S.qtyZero : S.qty}>{r.qty}</span>
                      )}
                    </td>
                    <td style={S.td}>
                      {editing ? (
                        <input value={editRp} onChange={(e) => setEditRp(e.target.value)} style={S.editInput} />
                      ) : (
                        <span>{r.reorderPoint}</span>
                      )}
                    </td>
                    <td style={S.td}>
                      <span style={S.shortfall}>−{r.shortfall}</span>
                    </td>
                    <td style={S.tdRight}>
                      {editing ? (
                        <>
                          <button onClick={() => saveEdit(r.item.id)} style={S.btnSave}>حفظ</button>
                          <button onClick={cancelEdit} style={S.btnCancel}>إلغاء</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => startEdit(r)} style={S.btnEdit}>تعديل</button>
                          <button onClick={() => untrack(r.item.id, r.item.nameAr)} style={S.btnUntrack}>إيقاف التتبّع</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Util re-export so PosShell can compute the badge without importing stock.ts
 * twice. LAN-aware: reads the host's shared stock map in host/client mode.
 */
export async function countLowStockTracked(items: LocalItem[]): Promise<number> {
  const m = await getAllStockShared();
  return countLowStockInMap(m, new Set(items.map((it) => it.id)));
}

// Re-export for convenience.
export { getStock };

const S = {
  wrap: { padding: 24, maxWidth: 1280, margin: "0 auto", display: "flex", flexDirection: "column" as const, gap: 16 } as const,
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end" } as const,
  h2: { fontSize: 22, fontWeight: 700, color: "#0f172a", margin: 0 } as const,
  sub: { fontSize: 13, color: "#64748b", marginTop: 4 } as const,
  controls: { display: "flex", gap: 12 } as const,
  search: { flex: 1, padding: "10px 14px", border: "1px solid #cbd5e1", borderRadius: 8, fontFamily: "inherit", fontSize: 14 } as const,
  select: { padding: "10px 14px", border: "1px solid #cbd5e1", borderRadius: 8, fontFamily: "inherit", fontSize: 13, background: "#fff" } as const,
  btnGhost: {
    padding: "8px 14px", background: "#fff", color: "#0ea5e9",
    border: "1px solid #bae6fd", borderRadius: 8, cursor: "pointer",
    fontFamily: "inherit", fontSize: 13, fontWeight: 600,
  } as const,
  ok: { padding: 10, background: "#f0fdf4", color: "#166534", border: "1px solid #bbf7d0", borderRadius: 8, fontSize: 13 } as const,
  err: { padding: 10, background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 8, fontSize: 13 } as const,
  empty: { textAlign: "center" as const, padding: 60, color: "#475569", background: "#fff", border: "1px dashed #cbd5e1", borderRadius: 12 } as const,
  tableBox: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, overflow: "hidden" } as const,
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 13 } as const,
  th: { padding: "12px 14px", background: "#f8fafc", textAlign: "right" as const, borderBottom: "1px solid #e2e8f0", fontWeight: 700, color: "#475569" } as const,
  thRight: { padding: "12px 14px", background: "#f8fafc", textAlign: "left" as const, borderBottom: "1px solid #e2e8f0", fontWeight: 700, color: "#475569" } as const,
  row: {} as const,
  rowCritical: { background: "#fef2f2" } as const,
  td: { padding: "12px 14px", borderBottom: "1px solid #f1f5f9" } as const,
  tdMono: { padding: "12px 14px", borderBottom: "1px solid #f1f5f9", fontFamily: "ui-monospace, monospace", fontSize: 12, color: "#64748b" } as const,
  tdRight: { padding: "12px 14px", borderBottom: "1px solid #f1f5f9", textAlign: "left" as const } as const,
  muted: { fontSize: 11, color: "#94a3b8", marginTop: 2 } as const,
  qty: { fontSize: 16, fontWeight: 700, color: "#dc2626" } as const,
  qtyZero: { fontSize: 16, fontWeight: 800, color: "#fff", background: "#dc2626", padding: "2px 10px", borderRadius: 6 } as const,
  shortfall: { fontSize: 14, fontWeight: 700, color: "#dc2626" } as const,
  editInput: { width: 80, padding: "6px 10px", border: "1px solid #2563eb", borderRadius: 6, fontFamily: "inherit", fontSize: 13 } as const,
  btnEdit: { padding: "6px 12px", background: "#f1f5f9", color: "#0f172a", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 12, marginInlineEnd: 6 } as const,
  btnUntrack: { padding: "6px 12px", background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 12 } as const,
  btnSave: { padding: "6px 12px", background: "#16a34a", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700, marginInlineEnd: 6 } as const,
  btnCancel: { padding: "6px 12px", background: "#fff", color: "#475569", border: "1px solid #cbd5e1", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 12 } as const,
};
