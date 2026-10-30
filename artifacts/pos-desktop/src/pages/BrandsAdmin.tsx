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
import { uiText, useUiLanguage } from "../lib/appSettings";

const emptyInput: BrandInput = {
  code: "", nameAr: "", nameEn: "", manufacturerName: "", supplierName: "",
  countryOfOrigin: "", logoUrl: "", status: "active", notes: "",
};

type EditState =
  | { mode: "new"; data: BrandInput }
  | { mode: "edit"; id: number; data: BrandInput }
  | null;

export default function BrandsAdmin() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
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
    if (!f.nameAr.trim()) { setErr(text("الاسم بالعربية مطلوب", "Arabic name is required.")); return; }
    if (edit.mode === "new") createBrand(f); else updateBrand(edit.id, f);
    setEdit(null); setErr(null); refresh();
    setToast({ kind: "ok", text: edit.mode === "new" ? text("تمت إضافة العلامة", "Brand added.") : text("تم تعديل العلامة", "Brand updated.") });
  }

  function handleDelete(b: Brand) {
    const used = usage[b.id] ?? 0;
    const extra = used > 0 ? `\n${text("مربوطة بـ", "Linked to")} ${used} ${text("صنف — سيتم فك الارتباط.", "items; these links will be removed.")}` : "";
    if (!confirm(`${text("حذف العلامة", "Delete brand")} «${b.nameAr}»?${extra}`)) return;
    deleteBrand(b.id); refresh(); setToast({ kind: "ok", text: text("تم حذف العلامة", "Brand deleted.") });
  }

  return (
    <div dir={language === "en" ? "ltr" : "rtl"} style={S.wrap}>
      <div style={S.headerRow}>
        <div>
          <h2 style={S.h2}>{text("العلامات التجارية", "Brands")} ({rows.length})</h2>
          <div style={S.sub}>{text("علامة واحدة لعدة أصناف — كل علامة لها سعرها وباركودها ورقم قطعتها الخاص", "A brand can be linked to multiple items, each with its own price, barcode, and part number.")}</div>
        </div>
        <button onClick={startNew} disabled={!!edit}
          style={{ ...S.btnPrimary, opacity: edit ? 0.5 : 1, cursor: edit ? "not-allowed" : "pointer" }}>
          + {text("علامة جديدة", "New brand")}
        </button>
      </div>

      {toast && <div style={toast.kind === "ok" ? S.ok : S.err}>{toast.text}</div>}

      <input
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder={text("بحث بالاسم / الكود / الشركة المصنّعة…", "Search name, code, or manufacturer…")}
        style={{ ...S.input, maxWidth: 360, marginBottom: 12 }}
      />

      <table style={S.table}>
        <thead><tr>
          <th style={{ ...S.th, textAlign: language === "en" ? "left" : "right" }}>{text("الكود", "Code")}</th>
          <th style={{ ...S.th, textAlign: language === "en" ? "left" : "right" }}>{text("الاسم بالعربية", "Arabic name")}</th>
          <th style={{ ...S.th, textAlign: language === "en" ? "left" : "right" }}>{text("بالإنجليزية", "English name")}</th>
          <th style={{ ...S.th, textAlign: language === "en" ? "left" : "right" }}>{text("الشركة المصنّعة", "Manufacturer")}</th>
          <th style={{ ...S.th, textAlign: language === "en" ? "left" : "right" }}>{text("بلد المنشأ", "Country of origin")}</th>
          <th style={S.thCenter}>{text("الأصناف", "Items")}</th>
          <th style={S.thCenter}>{text("الحالة", "Status")}</th>
          <th style={{ ...S.thRight, textAlign: language === "en" ? "right" : "left" }}>{text("إجراء", "Actions")}</th>
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
                  {b.status === "active" ? text("نشطة", "Active") : text("غير نشطة", "Inactive")}
                </span>
              </td>
              <td style={S.tdRight}>
                <button onClick={() => startEdit(b)} disabled={!!edit} style={S.btnEdit}>{text("تعديل", "Edit")}</button>
                <button onClick={() => handleDelete(b)} disabled={!!edit} style={S.btnDel}>{text("حذف", "Delete")}</button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={8} style={S.empty}>{text("لا توجد علامات تجارية بعد — أضف أول علامة.", "No brands yet — add the first one.")}</td></tr>
          )}
        </tbody>
      </table>

      {edit && (
        <div style={S.modalOverlay} onClick={cancel}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>
            <h3 style={S.modalH3}>{edit.mode === "new" ? text("علامة تجارية جديدة", "New brand") : text("تعديل العلامة", "Edit brand")}</h3>
            {err && <div style={S.err}>⚠️ {err}</div>}
            <div style={S.grid2}>
              <Field label={text("الكود", "Code")}>
                <input value={edit.data.code ?? ""} onChange={(e) => setField("code", e.target.value)} style={S.input} placeholder={text("تلقائي BR-0001", "Auto-generated BR-0001")} />
              </Field>
              <Field label={text("الحالة", "Status")}>
                <select value={edit.data.status ?? "active"} onChange={(e) => setField("status", e.target.value as BrandStatus)} style={S.input}>
                  <option value="active">{text("نشطة", "Active")}</option>
                  <option value="inactive">{text("غير نشطة", "Inactive")}</option>
                </select>
              </Field>
              <Field label={text("الاسم بالعربية *", "Arabic name *")}>
                <input autoFocus value={edit.data.nameAr} onChange={(e) => setField("nameAr", e.target.value)} style={S.input} placeholder={text("مثال: الشريف", "e.g. Al Sharif")} />
              </Field>
              <Field label={text("الاسم بالإنجليزية", "English name")}>
                <input value={edit.data.nameEn ?? ""} onChange={(e) => setField("nameEn", e.target.value)} style={S.input} placeholder="Al Sharif" />
              </Field>
              <Field label={text("الشركة المصنّعة", "Manufacturer")}>
                <input value={edit.data.manufacturerName ?? ""} onChange={(e) => setField("manufacturerName", e.target.value)} style={S.input} />
              </Field>
              <Field label={text("المورّد (اختياري)", "Supplier (optional)")}>
                <input value={edit.data.supplierName ?? ""} onChange={(e) => setField("supplierName", e.target.value)} style={S.input} />
              </Field>
              <Field label={text("بلد المنشأ", "Country of origin")}>
                <input value={edit.data.countryOfOrigin ?? ""} onChange={(e) => setField("countryOfOrigin", e.target.value)} style={S.input} placeholder={text("السعودية", "Saudi Arabia")} />
              </Field>
              <Field label={text("رابط الشعار (اختياري)", "Logo URL (optional)")}>
                <input value={edit.data.logoUrl ?? ""} onChange={(e) => setField("logoUrl", e.target.value)} style={S.input} placeholder="https://…" />
              </Field>
            </div>
            <Field label={text("ملاحظات", "Notes")}>
              <textarea value={edit.data.notes ?? ""} onChange={(e) => setField("notes", e.target.value)} style={{ ...S.input, minHeight: 60, resize: "vertical" }} />
            </Field>
            <div style={S.modalActions}>
              <button onClick={save} style={S.btnPrimary}>{text("حفظ", "Save")}</button>
              <button onClick={cancel} style={S.btnCancel}>{text("إلغاء", "Cancel")}</button>
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
  wrap: { width: "100%", maxWidth: "none", minWidth: 0, boxSizing: "border-box" as const } as const,
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
