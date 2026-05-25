// Customers admin — list + add + edit + delete.
// Read/write via lib/customers.ts; cloud sync is best-effort via pushQueue.

import { useEffect, useState } from "react";
import {
  listCustomers, createCustomer, updateCustomer, deleteCustomer,
  type LocalCustomer, type CreateCustomerInput,
} from "../lib/customers";

export default function CustomersAdmin() {
  const [rows, setRows] = useState<LocalCustomer[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<LocalCustomer | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function refresh() {
    setLoading(true);
    try { setRows(await listCustomers(search || undefined)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, [search]);

  async function handleDelete(c: LocalCustomer) {
    if (!confirm(`حذف العميل «${c.nameAr}»؟`)) return;
    try { await deleteCustomer(c.id); setToast({ kind: "ok", text: "تم الحذف" }); await refresh(); }
    catch (e: any) { setToast({ kind: "err", text: e?.message ?? "فشل الحذف" }); }
  }

  return (
    <div dir="rtl" style={S.wrap}>
      <div style={S.headerRow}>
        <div>
          <h2 style={S.h2}>العملاء ({rows.length})</h2>
          <div style={S.sub}>إدارة قائمة العملاء — يُزامن تلقائيًا مع السحابة عند الاتصال</div>
        </div>
        <button onClick={() => { setEditing(null); setShowForm(true); }} style={S.btnPrimary}>
          + عميل جديد
        </button>
      </div>

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="بحث بالاسم أو الهاتف أو الرقم الضريبي..."
        style={S.search}
      />

      {toast && <div style={toast.kind === "ok" ? S.ok : S.err}>{toast.text}</div>}

      {loading ? <div style={S.empty}>... جاري التحميل</div>
      : rows.length === 0 ? <div style={S.empty}>لا يوجد عملاء بعد — أضف أول عميل</div>
      : (
        <table style={S.table}>
          <thead><tr>
            <th style={S.th}>الاسم</th>
            <th style={S.th}>الهاتف</th>
            <th style={S.th}>الرقم الضريبي</th>
            <th style={S.th}>المصدر</th>
            <th style={S.thRight}>إجراء</th>
          </tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} style={S.tr}>
                <td style={S.td}>
                  <div style={{ fontWeight: 600 }}>{c.nameAr}</div>
                  {c.nameEn && <div style={S.muted}>{c.nameEn}</div>}
                </td>
                <td style={S.td}>{c.phone ?? "—"}</td>
                <td style={S.tdMono}>{c.vatNumber ?? "—"}</td>
                <td style={S.td}>
                  <span style={c.cloudId ? S.badgeCloud : S.badgeLocal}>
                    {c.cloudId ? `☁️ سحابة #${c.cloudId}` : "📱 محلي"}
                  </span>
                </td>
                <td style={S.tdRight}>
                  <button onClick={() => { setEditing(c); setShowForm(true); }} style={S.btnEdit}>تعديل</button>
                  <button onClick={() => handleDelete(c)} style={S.btnDel}>حذف</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showForm && (
        <CustomerForm
          initial={editing}
          onClose={() => setShowForm(false)}
          onSaved={async (msg) => { setShowForm(false); setToast({ kind: "ok", text: msg }); await refresh(); }}
        />
      )}
    </div>
  );
}

function CustomerForm({ initial, onClose, onSaved }: {
  initial: LocalCustomer | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [form, setForm] = useState<CreateCustomerInput>({
    nameAr: initial?.nameAr ?? "",
    nameEn: initial?.nameEn ?? "",
    phone: initial?.phone ?? "",
    vatNumber: initial?.vatNumber ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!form.nameAr.trim()) { setErr("الاسم بالعربية مطلوب"); return; }
    if (form.vatNumber && !/^3\d{13}3$/.test(form.vatNumber)) {
      setErr("الرقم الضريبي يجب أن يكون 15 رقم يبدأ وينتهي بـ3"); return;
    }
    setSaving(true); setErr(null);
    try {
      if (initial) {
        await updateCustomer(initial.id, form);
        onSaved("تم تحديث العميل");
      } else {
        await createCustomer(form);
        onSaved("تم إضافة العميل");
      }
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setSaving(false); }
  }

  return (
    <div style={S.modalBg} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <h3 style={S.modalTitle}>{initial ? "تعديل عميل" : "عميل جديد"}</h3>
        <Field label="الاسم بالعربية *">
          <input value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} style={S.input} autoFocus />
        </Field>
        <Field label="الاسم بالإنجليزية">
          <input value={form.nameEn ?? ""} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} style={S.input} />
        </Field>
        <Field label="الهاتف">
          <input value={form.phone ?? ""} onChange={(e) => setForm({ ...form, phone: e.target.value })} style={S.input} placeholder="05xxxxxxxx" />
        </Field>
        <Field label="الرقم الضريبي (15 رقم)">
          <input value={form.vatNumber ?? ""} onChange={(e) => setForm({ ...form, vatNumber: e.target.value })} style={S.input} placeholder="3xxxxxxxxxxxxx3" />
        </Field>

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
  wrap: { maxWidth: 1000, margin: "0 auto", width: "100%" } as const,
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
  modal: { background: "#fff", borderRadius: 12, padding: 24, maxWidth: 480, width: "100%", boxShadow: "0 20px 50px rgba(0,0,0,.25)" } as const,
  modalTitle: { margin: "0 0 16px", fontSize: 18, color: "#0f172a" } as const,
  input: { width: "100%", padding: "10px 12px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 6, fontFamily: "inherit", boxSizing: "border-box" as const } as const,
};
