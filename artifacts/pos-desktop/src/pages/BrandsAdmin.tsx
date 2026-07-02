// Brands admin (العلامات التجارية) — local-only master list (no cloud sync).
// One item can carry several brands, each with its own price/cost/barcode/
// part-number (managed on the item screen). This screen manages the brand
// MASTER records. Mirrors ItemGroupsAdmin styling with a modal form for the
// larger field set.

import { useState } from "react";
import {
  listBrands, createBrand, updateBrand, deleteBrand, brandUsageCounts,
  type Brand, type BrandInput, type BrandStatus,
} from "../lib/brands";
import { useDataRefresh } from "../lib/dataBus";

const emptyInput: BrandInput = {
  code: "", nameAr: "", nameEn: "", manufacturerName: "", supplierName: "",
  countryOfOrigin: "", logoUrl: "", status: "active", notes: "",
};

type EditState =
  | { mode: "new"; data: BrandInput }
  | { mode: "edit"; id: number; data: BrandInput }
  | null;

export default function BrandsAdmin() {
  const [rows, setRows] = useState<Brand[]>(() => listBrands());
  const [usage, setUsage] = useState<Record<number, number>>(() => brandUsageCounts());
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<EditState>(null);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  function refresh() {
    setRows(listBrands(search));
    setUsage(brandUsageCounts());
  }
  useDataRefresh(["brands", "items"], refresh);

  function onSearch(v: string) { setSearch(v); setRows(listBrands(v)); }

  function startNew() { setErr(null); setEdit({ mode: "new", data: { ...emptyInput } }); }
  function startEdit(b: Brand) {
    setErr(null);
    setEdit({ mode: "edit", id: b.id, data: {
      code: b.code ?? "", nameAr: b.nameAr, nameEn: b.nameEn ?? "",
      manufacturerName: b.manufacturerName ?? "", supplierName: b.supplierName ?? "",
      countryOfOrigin: b.countryOfOrigin ?? "", logoUrl: b.logoUrl ?? "",
      status: b.status, notes: b.notes ?? "",
    } });
  }
  function cancel() { setEdit(null); setErr(null); }
  function setField<K extends keyof BrandInput>(k: K, v: BrandInput[K]) {
    if (!edit) return; setEdit({ ...edit, data: { ...edit.data, [k]: v } });
  }

  function save() {
    if (!edit) return;
    const f = edit.data;
    if (!f.nameAr.trim()) { setErr("الاسم بالعربية مطلوب"); return; }
    if (edit.mode === "new") createBrand(f); else updateBrand(edit.id, f);
    setEdit(null); setErr(null); refresh();
    setToast({ kind: "ok", text: edit.mode === "new" ? "تمت إضافة العلامة" : "تم تعديل العلامة" });
  }

  function handleDelete(b: Brand) {
    const used = usage[b.id] ?? 0;
    const extra = used > 0 ? `\nمربوطة بـ ${used} صنف — سيتم فك الارتباط.` : "";
    if (!confirm(`حذف العلامة «${b.nameAr}»؟${extra}`)) return;
    deleteBrand(b.id); refresh(); setToast({ kind: "ok", text: "تم حذف العلامة" });
  }

  return (
    <div dir="rtl" style={S.wrap}>
      <div style={S.headerRow}>
        <div>
          <h2 style={S.h2}>العلامات التجارية ({rows.length})</h2>
          <div style={S.sub}>علامة واحدة لعدة أصناف — كل علامة لها سعرها وباركودها ورقم قطعتها الخاص</div>
        </div>
        <button onClick={startNew} disabled={!!edit}
          style={{ ...S.btnPrimary, opacity: edit ? 0.5 : 1, cursor: edit ? "not-allowed" : "pointer" }}>
          + علامة جديدة
        </button>
      </div>

      {toast && <div style={toast.kind === "ok" ? S.ok : S.err}>{toast.text}</div>}

      <input
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="بحث بالاسم / الكود / الشركة المصنّعة…"
        style={{ ...S.input, maxWidth: 360, marginBottom: 12 }}
      />

      <table style={S.table}>
        <thead><tr>
          <th style={S.th}>الكود</th>
          <th style={S.th}>الاسم بالعربية</th>
          <th style={S.th}>بالإنجليزية</th>
          <th style={S.th}>الشركة المصنّعة</th>
          <th style={S.th}>بلد المنشأ</th>
          <th style={S.thCenter}>الأصناف</th>
          <th style={S.thCenter}>الحالة</th>
          <th style={S.thRight}>إجراء</th>
        </tr></thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.id} style={{ ...S.tr, opacity: edit ? 0.6 : 1 }}>
              <td style={S.tdMono}>{b.code || "—"}</td>
              <td style={S.td}><strong>{b.nameAr}</strong></td>
              <td style={S.td}>{b.nameEn || "—"}</td>
              <td style={S.td}>{b.manufacturerName || "—"}</td>
              <td style={S.td}>{b.countryOfOrigin || "—"}</td>
              <td style={S.tdCenter}>{usage[b.id] ?? 0}</td>
              <td style={S.tdCenter}>
                <span style={b.status === "active" ? S.badgeOn : S.badgeOff}>
                  {b.status === "active" ? "نشطة" : "غير نشطة"}
                </span>
              </td>
              <td style={S.tdRight}>
                <button onClick={() => startEdit(b)} disabled={!!edit} style={S.btnEdit}>تعديل</button>
                <button onClick={() => handleDelete(b)} disabled={!!edit} style={S.btnDel}>حذف</button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={8} style={S.empty}>لا توجد علامات تجارية بعد — أضف أول علامة.</td></tr>
          )}
        </tbody>
      </table>

      {edit && (
        <div style={S.modalOverlay} onClick={cancel}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>
            <h3 style={S.modalH3}>{edit.mode === "new" ? "علامة تجارية جديدة" : "تعديل العلامة"}</h3>
            {err && <div style={S.err}>⚠️ {err}</div>}
            <div style={S.grid2}>
              <Field label="الكود">
                <input value={edit.data.code ?? ""} onChange={(e) => setField("code", e.target.value)} style={S.input} placeholder="تلقائي BR-0001" />
              </Field>
              <Field label="الحالة">
                <select value={edit.data.status ?? "active"} onChange={(e) => setField("status", e.target.value as BrandStatus)} style={S.input}>
                  <option value="active">نشطة</option>
                  <option value="inactive">غير نشطة</option>
                </select>
              </Field>
              <Field label="الاسم بالعربية *">
                <input autoFocus value={edit.data.nameAr} onChange={(e) => setField("nameAr", e.target.value)} style={S.input} placeholder="مثال: الشريف" />
              </Field>
              <Field label="الاسم بالإنجليزية">
                <input value={edit.data.nameEn ?? ""} onChange={(e) => setField("nameEn", e.target.value)} style={S.input} placeholder="Al Sharif" />
              </Field>
              <Field label="الشركة المصنّعة">
                <input value={edit.data.manufacturerName ?? ""} onChange={(e) => setField("manufacturerName", e.target.value)} style={S.input} />
              </Field>
              <Field label="المورّد (اختياري)">
                <input value={edit.data.supplierName ?? ""} onChange={(e) => setField("supplierName", e.target.value)} style={S.input} />
              </Field>
              <Field label="بلد المنشأ">
                <input value={edit.data.countryOfOrigin ?? ""} onChange={(e) => setField("countryOfOrigin", e.target.value)} style={S.input} placeholder="السعودية" />
              </Field>
              <Field label="رابط الشعار (اختياري)">
                <input value={edit.data.logoUrl ?? ""} onChange={(e) => setField("logoUrl", e.target.value)} style={S.input} placeholder="https://…" />
              </Field>
            </div>
            <Field label="ملاحظات">
              <textarea value={edit.data.notes ?? ""} onChange={(e) => setField("notes", e.target.value)} style={{ ...S.input, minHeight: 60, resize: "vertical" }} />
            </Field>
            <div style={S.modalActions}>
              <button onClick={save} style={S.btnPrimary}>حفظ</button>
              <button onClick={cancel} style={S.btnCancel}>إلغاء</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={S.field}>
      <span style={S.fieldLabel}>{label}</span>
      {children}
    </label>
  );
}

const S = {
  wrap: { maxWidth: 1080, margin: "0 auto", width: "100%" } as const,
  headerRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 16 } as const,
  h2: { margin: 0, fontSize: 22, color: "#0f172a" } as const,
  sub: { fontSize: 13, color: "#64748b", marginTop: 4 } as const,
  table: { width: "100%", borderCollapse: "collapse" as const, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" } as const,
  th: { textAlign: "right" as const, padding: "12px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: 13, color: "#475569", fontWeight: 600 } as const,
  thCenter: { textAlign: "center" as const, padding: "12px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: 13, color: "#475569", fontWeight: 600 } as const,
  thRight: { textAlign: "left" as const, padding: "12px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: 13, color: "#475569", fontWeight: 600 } as const,
  tr: { borderBottom: "1px solid #f1f5f9" } as const,
  td: { padding: "10px 14px", fontSize: 14, color: "#0f172a" } as const,
  tdMono: { padding: "10px 14px", fontSize: 13, color: "#0f172a", fontFamily: "ui-monospace, monospace" } as const,
  tdCenter: { padding: "10px 14px", fontSize: 14, color: "#0f172a", textAlign: "center" as const } as const,
  tdRight: { padding: "10px 14px", textAlign: "left" as const } as const,
  empty: { padding: "24px 14px", textAlign: "center" as const, color: "#94a3b8", fontSize: 14 } as const,
  badgeOn: { padding: "3px 10px", borderRadius: 999, background: "#f0fdf4", color: "#166534", border: "1px solid #bbf7d0", fontSize: 12 } as const,
  badgeOff: { padding: "3px 10px", borderRadius: 999, background: "#f8fafc", color: "#64748b", border: "1px solid #e2e8f0", fontSize: 12 } as const,
  btnPrimary: { padding: "10px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600 } as const,
  btnCancel: { padding: "10px 18px", background: "#f1f5f9", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: 8, cursor: "pointer", fontSize: 14 } as const,
  btnEdit: { padding: "6px 12px", background: "#f1f5f9", color: "#0f172a", border: "1px solid #e2e8f0", borderRadius: 6, cursor: "pointer", fontSize: 12, marginInlineEnd: 6 } as const,
  btnDel: { padding: "6px 12px", background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 6, cursor: "pointer", fontSize: 12 } as const,
  ok: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 } as const,
  err: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 } as const,
  input: { width: "100%", padding: "10px 12px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 6, fontFamily: "inherit", boxSizing: "border-box" as const } as const,
  modalOverlay: { position: "fixed" as const, inset: 0, background: "rgba(15,23,42,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 } as const,
  modal: { background: "#fff", borderRadius: 12, padding: 24, width: "100%", maxWidth: 640, maxHeight: "90vh", overflowY: "auto" as const, boxShadow: "0 20px 60px rgba(0,0,0,0.25)" } as const,
  modalH3: { margin: "0 0 16px", fontSize: 18, color: "#0f172a" } as const,
  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } as const,
  field: { display: "flex", flexDirection: "column" as const, gap: 4, marginBottom: 12 } as const,
  fieldLabel: { fontSize: 12, color: "#475569", fontWeight: 600 } as const,
  modalActions: { display: "flex", gap: 10, marginTop: 8 } as const,
};
