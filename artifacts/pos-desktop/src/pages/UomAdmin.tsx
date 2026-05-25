// Units of Measure admin — local-only list (no cloud sync for v1).

import { useState } from "react";
import { listUom, createUom, updateUom, deleteUom, type Uom, type CreateUomInput } from "../lib/uom";

export default function UomAdmin() {
  const [rows, setRows] = useState<Uom[]>(() => listUom());
  const [editing, setEditing] = useState<Uom | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  function refresh() { setRows(listUom()); }

  function handleDelete(u: Uom) {
    if (u.isDefault) { setToast({ kind: "err", text: "لا يمكن حذف الوحدة الافتراضية" }); return; }
    if (!confirm(`حذف وحدة «${u.nameAr}»؟`)) return;
    deleteUom(u.id); refresh(); setToast({ kind: "ok", text: "تم الحذف" });
  }

  return (
    <div dir="rtl" style={S.wrap}>
      <div style={S.headerRow}>
        <div>
          <h2 style={S.h2}>وحدات القياس ({rows.length})</h2>
          <div style={S.sub}>تستخدم في الأصناف — قطعة، كرتون، علبة، كيلو…</div>
        </div>
        <button onClick={() => { setEditing(null); setShowForm(true); }} style={S.btnPrimary}>
          + وحدة جديدة
        </button>
      </div>

      {toast && <div style={toast.kind === "ok" ? S.ok : S.err}>{toast.text}</div>}

      <table style={S.table}>
        <thead><tr>
          <th style={S.th}>الاسم</th>
          <th style={S.th}>الإنجليزية</th>
          <th style={S.th}>الرمز</th>
          <th style={S.th}>المعامل</th>
          <th style={S.th}>افتراضي</th>
          <th style={S.thRight}>إجراء</th>
        </tr></thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id} style={S.tr}>
              <td style={S.td}><strong>{u.nameAr}</strong></td>
              <td style={S.td}>{u.nameEn ?? "—"}</td>
              <td style={S.tdMono}>{u.shortCode ?? "—"}</td>
              <td style={S.tdMono}>×{u.baseQty}</td>
              <td style={S.td}>{u.isDefault ? "⭐" : ""}</td>
              <td style={S.tdRight}>
                <button onClick={() => { setEditing(u); setShowForm(true); }} style={S.btnEdit}>تعديل</button>
                <button onClick={() => handleDelete(u)} style={S.btnDel}>حذف</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {showForm && (
        <UomForm
          initial={editing}
          onClose={() => setShowForm(false)}
          onSaved={(msg) => { setShowForm(false); setToast({ kind: "ok", text: msg }); refresh(); }}
        />
      )}
    </div>
  );
}

function UomForm({ initial, onClose, onSaved }: {
  initial: Uom | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [form, setForm] = useState<CreateUomInput>({
    nameAr: initial?.nameAr ?? "",
    nameEn: initial?.nameEn ?? "",
    shortCode: initial?.shortCode ?? "",
    baseQty: initial?.baseQty ?? 1,
    isDefault: initial?.isDefault ?? false,
  });
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    if (!form.nameAr.trim()) { setErr("الاسم بالعربية مطلوب"); return; }
    if (form.baseQty <= 0) { setErr("المعامل يجب أن يكون أكبر من صفر"); return; }
    if (initial) updateUom(initial.id, form); else createUom(form);
    onSaved(initial ? "تم التعديل" : "تمت الإضافة");
  }

  return (
    <div style={S.modalBg} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <h3 style={S.modalTitle}>{initial ? "تعديل وحدة" : "وحدة قياس جديدة"}</h3>
        <Field label="الاسم بالعربية *">
          <input value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} style={S.input} autoFocus />
        </Field>
        <Field label="الاسم بالإنجليزية">
          <input value={form.nameEn ?? ""} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} style={S.input} />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="الرمز">
            <input value={form.shortCode ?? ""} onChange={(e) => setForm({ ...form, shortCode: e.target.value })} style={S.input} placeholder="PCS, KG…" />
          </Field>
          <Field label="المعامل مقابل الوحدة الأساسية">
            <input type="number" step="0.001" min="0.001" value={form.baseQty} onChange={(e) => setForm({ ...form, baseQty: Number(e.target.value) })} style={S.input} />
          </Field>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#475569", marginBottom: 8 }}>
          <input type="checkbox" checked={form.isDefault ?? false} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} />
          تعيين كوحدة افتراضية للأصناف الجديدة
        </label>

        {err && <div style={S.err}>{err}</div>}

        <div style={S.btnRow}>
          <button onClick={submit} style={S.btnPrimary}>{initial ? "💾 حفظ" : "✅ إضافة"}</button>
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
  wrap: { maxWidth: 900, margin: "0 auto", width: "100%" } as const,
  headerRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 16 } as const,
  h2: { margin: 0, fontSize: 22, color: "#0f172a" } as const,
  sub: { fontSize: 13, color: "#64748b", marginTop: 4 } as const,
  table: { width: "100%", borderCollapse: "collapse" as const, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" } as const,
  th: { textAlign: "right" as const, padding: "12px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: 13, color: "#475569", fontWeight: 600 } as const,
  thRight: { textAlign: "left" as const, padding: "12px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: 13, color: "#475569", fontWeight: 600 } as const,
  tr: { borderBottom: "1px solid #f1f5f9" } as const,
  td: { padding: "12px 14px", fontSize: 14, color: "#0f172a" } as const,
  tdMono: { padding: "12px 14px", fontSize: 13, color: "#0f172a", fontFamily: "ui-monospace, monospace" } as const,
  tdRight: { padding: "12px 14px", textAlign: "left" as const } as const,
  btnPrimary: { padding: "10px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600 } as const,
  btnGhost: { padding: "10px 18px", background: "#fff", color: "#475569", border: "1px solid #cbd5e1", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600 } as const,
  btnEdit: { padding: "6px 12px", background: "#f1f5f9", color: "#0f172a", border: "1px solid #e2e8f0", borderRadius: 6, cursor: "pointer", fontSize: 12, marginInlineEnd: 6 } as const,
  btnDel: { padding: "6px 12px", background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 6, cursor: "pointer", fontSize: 12 } as const,
  btnRow: { display: "flex", gap: 8, marginTop: 16 } as const,
  ok: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 } as const,
  err: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 } as const,
  modalBg: { position: "fixed" as const, inset: 0, background: "rgba(15,23,42,.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 16 } as const,
  modal: { background: "#fff", borderRadius: 12, padding: 24, maxWidth: 480, width: "100%", boxShadow: "0 20px 50px rgba(0,0,0,.25)" } as const,
  modalTitle: { margin: "0 0 16px", fontSize: 18, color: "#0f172a" } as const,
  input: { width: "100%", padding: "10px 12px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 6, fontFamily: "inherit", boxSizing: "border-box" as const } as const,
};
