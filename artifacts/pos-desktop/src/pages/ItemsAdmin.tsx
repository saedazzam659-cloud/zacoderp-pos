// Items admin — list + add + edit + delete.
// Uses lib/items.ts + lib/uom.ts.

import { useEffect, useState } from "react";
import {
  listItems, createItem, updateItem, deleteItem,
  type LocalItem, type CreateItemInput,
} from "../lib/items";
import { listUom, getDefaultUom } from "../lib/uom";

export default function ItemsAdmin() {
  const [rows, setRows] = useState<LocalItem[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<LocalItem | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function refresh() {
    setLoading(true);
    try { setRows(await listItems(search || undefined)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, [search]);

  async function handleDelete(it: LocalItem) {
    if (!confirm(`حذف الصنف «${it.nameAr}»؟`)) return;
    try { await deleteItem(it.id); setToast({ kind: "ok", text: "تم الحذف" }); await refresh(); }
    catch (e: any) { setToast({ kind: "err", text: e?.message ?? "فشل الحذف" }); }
  }

  return (
    <div dir="rtl" style={S.wrap}>
      <div style={S.headerRow}>
        <div>
          <h2 style={S.h2}>الأصناف ({rows.length})</h2>
          <div style={S.sub}>إدارة قائمة الأصناف وأسعار البيع — السحب من السحابة يُحدّث القائمة تلقائيًا</div>
        </div>
        <button onClick={() => { setEditing(null); setShowForm(true); }} style={S.btnPrimary}>
          + صنف جديد
        </button>
      </div>

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="بحث بالاسم أو الكود أو الباركود..."
        style={S.search}
      />

      {toast && <div style={toast.kind === "ok" ? S.ok : S.err}>{toast.text}</div>}

      {loading ? <div style={S.empty}>... جاري التحميل</div>
      : rows.length === 0 ? <div style={S.empty}>لا توجد أصناف — أضف صنف جديد أو اسحب من السحابة</div>
      : (
        <table style={S.table}>
          <thead><tr>
            <th style={S.th}>الاسم</th>
            <th style={S.th}>الباركود</th>
            <th style={S.th}>الكود</th>
            <th style={S.th}>السعر</th>
            <th style={S.th}>الضريبة</th>
            <th style={S.th}>المصدر</th>
            <th style={S.thRight}>إجراء</th>
          </tr></thead>
          <tbody>
            {rows.map((it) => (
              <tr key={it.id} style={S.tr}>
                <td style={S.td}>
                  <div style={{ fontWeight: 600 }}>{it.nameAr}</div>
                  {it.nameEn && <div style={S.muted}>{it.nameEn}</div>}
                </td>
                <td style={S.tdMono}>{it.barcode ?? "—"}</td>
                <td style={S.tdMono}>{it.code ?? "—"}</td>
                <td style={S.td}><strong>{it.salePrice.toFixed(2)}</strong> ر.س</td>
                <td style={S.td}>{it.vatRate}%</td>
                <td style={S.td}>
                  <span style={it.cloudId ? S.badgeCloud : S.badgeLocal}>
                    {it.cloudId ? `☁️ #${it.cloudId}` : "📱 محلي"}
                  </span>
                </td>
                <td style={S.tdRight}>
                  <button onClick={() => { setEditing(it); setShowForm(true); }} style={S.btnEdit}>تعديل</button>
                  <button onClick={() => handleDelete(it)} style={S.btnDel}>حذف</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showForm && (
        <ItemForm
          initial={editing}
          onClose={() => setShowForm(false)}
          onSaved={async (msg) => { setShowForm(false); setToast({ kind: "ok", text: msg }); await refresh(); }}
        />
      )}
    </div>
  );
}

function ItemForm({ initial, onClose, onSaved }: {
  initial: LocalItem | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const uoms = listUom();
  const [form, setForm] = useState<CreateItemInput>({
    code: initial?.code ?? "",
    nameAr: initial?.nameAr ?? "",
    nameEn: initial?.nameEn ?? "",
    barcode: initial?.barcode ?? "",
    salePrice: initial?.salePrice ?? 0,
    vatRate: initial?.vatRate ?? 15,
    uomId: initial?.uomId ?? getDefaultUom()?.id ?? null,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!form.nameAr.trim()) { setErr("الاسم بالعربية مطلوب"); return; }
    if (form.salePrice <= 0) { setErr("السعر يجب أن يكون أكبر من صفر"); return; }
    if (form.vatRate < 0 || form.vatRate > 100) { setErr("نسبة الضريبة بين 0 و 100"); return; }
    setSaving(true); setErr(null);
    try {
      if (initial) { await updateItem(initial.id, form); onSaved("تم تحديث الصنف"); }
      else { await createItem(form); onSaved("تم إضافة الصنف"); }
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setSaving(false); }
  }

  return (
    <div style={S.modalBg} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <h3 style={S.modalTitle}>{initial ? "تعديل صنف" : "صنف جديد"}</h3>

        <Field label="الاسم بالعربية *">
          <input value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} style={S.input} autoFocus />
        </Field>
        <Field label="الاسم بالإنجليزية">
          <input value={form.nameEn ?? ""} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} style={S.input} />
        </Field>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="الكود الداخلي">
            <input value={form.code ?? ""} onChange={(e) => setForm({ ...form, code: e.target.value })} style={S.input} placeholder="مثلاً: ITEM-001" />
          </Field>
          <Field label="الباركود">
            <input value={form.barcode ?? ""} onChange={(e) => setForm({ ...form, barcode: e.target.value })} style={S.input} placeholder="EAN-13" />
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <Field label="سعر البيع *">
            <input type="number" step="0.01" min="0" value={form.salePrice} onChange={(e) => setForm({ ...form, salePrice: Number(e.target.value) })} style={S.input} />
          </Field>
          <Field label="نسبة الضريبة %">
            <input type="number" step="0.5" min="0" max="100" value={form.vatRate} onChange={(e) => setForm({ ...form, vatRate: Number(e.target.value) })} style={S.input} />
          </Field>
          <Field label="وحدة القياس">
            <select value={form.uomId ?? ""} onChange={(e) => setForm({ ...form, uomId: e.target.value ? Number(e.target.value) : null })} style={S.input}>
              {uoms.map((u) => <option key={u.id} value={u.id}>{u.nameAr}{u.shortCode ? ` (${u.shortCode})` : ""}</option>)}
            </select>
          </Field>
        </div>

        {err && <div style={S.err}>{err}</div>}

        <div style={S.btnRow}>
          <button onClick={submit} disabled={saving} style={S.btnPrimary}>
            {saving ? "..." : initial ? "💾 حفظ التعديلات" : "✅ إضافة"}
          </button>
          <button onClick={onClose} style={S.btnGhost}>إلغاء</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: "block", marginBottom: 12 }}>
    <div style={{ fontSize: 13, color: "#475569", marginBottom: 4 }}>{label}</div>
    {children}
  </label>;
}

const S = {
  wrap: { maxWidth: 1100, margin: "0 auto", width: "100%" } as const,
  headerRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 16 } as const,
  h2: { margin: 0, fontSize: 22, color: "#0f172a" } as const,
  sub: { fontSize: 13, color: "#64748b", marginTop: 4 } as const,
  search: { width: "100%", padding: "10px 14px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 8, marginBottom: 16, fontFamily: "inherit" } as const,
  empty: { padding: 40, textAlign: "center" as const, color: "#94a3b8", background: "#fff", border: "1px dashed #e2e8f0", borderRadius: 8 } as const,
  table: { width: "100%", borderCollapse: "collapse" as const, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" } as const,
  th: { textAlign: "right" as const, padding: "12px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: 13, color: "#475569", fontWeight: 600 } as const,
  thRight: { textAlign: "left" as const, padding: "12px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: 13, color: "#475569", fontWeight: 600 } as const,
  tr: { borderBottom: "1px solid #f1f5f9" } as const,
  td: { padding: "12px 14px", fontSize: 14, color: "#0f172a" } as const,
  tdMono: { padding: "12px 14px", fontSize: 13, color: "#0f172a", fontFamily: "ui-monospace, monospace" } as const,
  tdRight: { padding: "12px 14px", textAlign: "left" as const } as const,
  muted: { fontSize: 12, color: "#94a3b8", marginTop: 2 } as const,
  badgeCloud: { display: "inline-block", padding: "2px 8px", background: "#eff6ff", color: "#1d4ed8", border: "1px solid #dbeafe", borderRadius: 999, fontSize: 11 } as const,
  badgeLocal: { display: "inline-block", padding: "2px 8px", background: "#fefce8", color: "#854d0e", border: "1px solid #fef9c3", borderRadius: 999, fontSize: 11 } as const,
  btnPrimary: { padding: "10px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600 } as const,
  btnGhost: { padding: "10px 18px", background: "#fff", color: "#475569", border: "1px solid #cbd5e1", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600 } as const,
  btnEdit: { padding: "6px 12px", background: "#f1f5f9", color: "#0f172a", border: "1px solid #e2e8f0", borderRadius: 6, cursor: "pointer", fontSize: 12, marginInlineEnd: 6 } as const,
  btnDel: { padding: "6px 12px", background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 6, cursor: "pointer", fontSize: 12 } as const,
  btnRow: { display: "flex", gap: 8, marginTop: 16 } as const,
  ok: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 } as const,
  err: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 } as const,
  modalBg: { position: "fixed" as const, inset: 0, background: "rgba(15,23,42,.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 16 } as const,
  modal: { background: "#fff", borderRadius: 12, padding: 24, maxWidth: 560, width: "100%", boxShadow: "0 20px 50px rgba(0,0,0,.25)" } as const,
  modalTitle: { margin: "0 0 16px", fontSize: 18, color: "#0f172a" } as const,
  input: { width: "100%", padding: "10px 12px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 6, fontFamily: "inherit", boxSizing: "border-box" as const } as const,
};
