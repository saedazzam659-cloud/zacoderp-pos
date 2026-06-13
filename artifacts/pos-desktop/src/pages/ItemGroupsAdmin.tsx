// Item Groups admin (مجموعات الأصناف) — local-only list (no cloud sync for v1).
// Inline editing inside the grid (no modal). Mirrors UomAdmin.

import { useState } from "react";
import {
  listItemGroups, createItemGroup, updateItemGroup, deleteItemGroup,
  type ItemGroup, type CreateItemGroupInput,
} from "../lib/itemGroups";

const emptyInput: CreateItemGroupInput = { code: "", nameAr: "", nameEn: "" };

type EditState =
  | { mode: "new"; data: CreateItemGroupInput }
  | { mode: "edit"; id: ItemGroup["id"]; data: CreateItemGroupInput }
  | null;

export default function ItemGroupsAdmin() {
  const [rows, setRows] = useState<ItemGroup[]>(() => listItemGroups());
  const [edit, setEdit] = useState<EditState>(null);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  function refresh() { setRows(listItemGroups()); }

  function startNew() { setErr(null); setEdit({ mode: "new", data: { ...emptyInput } }); }
  function startEdit(g: ItemGroup) {
    setErr(null);
    setEdit({ mode: "edit", id: g.id, data: {
      code: g.code ?? "", nameAr: g.nameAr, nameEn: g.nameEn ?? "",
    } });
  }
  function cancel() { setEdit(null); setErr(null); }
  function setField<K extends keyof CreateItemGroupInput>(k: K, v: CreateItemGroupInput[K]) {
    if (!edit) return; setEdit({ ...edit, data: { ...edit.data, [k]: v } });
  }

  function save() {
    if (!edit) return;
    const f = edit.data;
    if (!f.nameAr.trim()) { setErr("الاسم بالعربية مطلوب"); return; }
    if (edit.mode === "new") createItemGroup(f); else updateItemGroup(edit.id, f);
    setEdit(null); setErr(null); refresh();
    setToast({ kind: "ok", text: edit.mode === "new" ? "تمت الإضافة" : "تم التعديل" });
  }

  function handleDelete(g: ItemGroup) {
    if (!confirm(`حذف مجموعة «${g.nameAr}»؟`)) return;
    deleteItemGroup(g.id); refresh(); setToast({ kind: "ok", text: "تم الحذف" });
  }

  return (
    <div dir="rtl" style={S.wrap}>
      <div style={S.headerRow}>
        <div>
          <h2 style={S.h2}>مجموعات الأصناف ({rows.length})</h2>
          <div style={S.sub}>تصنيف الأصناف — مشروبات، منظفات، أدوية…</div>
        </div>
        <button onClick={startNew} disabled={!!edit}
          style={{ ...S.btnPrimary, opacity: edit ? 0.5 : 1, cursor: edit ? "not-allowed" : "pointer" }}>
          + مجموعة جديدة
        </button>
      </div>

      {toast && <div style={toast.kind === "ok" ? S.ok : S.err}>{toast.text}</div>}

      <table style={S.table}>
        <thead><tr>
          <th style={S.th}>الكود</th>
          <th style={S.th}>الاسم بالعربية</th>
          <th style={S.th}>الاسم بالإنجليزية</th>
          <th style={S.thRight}>إجراء</th>
        </tr></thead>
        <tbody>
          {edit?.mode === "new" && (
            <EditRow data={edit.data} setField={setField} onSave={save} onCancel={cancel} err={err} isNew />
          )}
          {rows.map((g) => (
            edit?.mode === "edit" && edit.id === g.id ? (
              <EditRow key={g.id} data={edit.data} setField={setField} onSave={save} onCancel={cancel} err={err} />
            ) : (
              <tr key={g.id} style={{ ...S.tr, opacity: edit ? 0.6 : 1 }}>
                <td style={S.tdMono}>{g.code || "—"}</td>
                <td style={S.td}><strong>{g.nameAr}</strong></td>
                <td style={S.td}>{g.nameEn ?? "—"}</td>
                <td style={S.tdRight}>
                  <button onClick={() => startEdit(g)} disabled={!!edit} style={S.btnEdit}>تعديل</button>
                  <button onClick={() => handleDelete(g)} disabled={!!edit} style={S.btnDel}>حذف</button>
                </td>
              </tr>
            )
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EditRow({ data, setField, onSave, onCancel, err, isNew }: {
  data: CreateItemGroupInput;
  setField: <K extends keyof CreateItemGroupInput>(k: K, v: CreateItemGroupInput[K]) => void;
  onSave: () => void; onCancel: () => void; err: string | null; isNew?: boolean;
}) {
  const ci: React.CSSProperties = { ...S.input, padding: "6px 8px", fontSize: 13 };
  return (
    <>
      <tr style={{ ...S.tr, background: isNew ? "#f0fdf4" : "#eff6ff" }}>
        <td style={S.td}><input value={data.code ?? ""} onChange={(e) => setField("code", e.target.value)} style={ci} placeholder="GEN" /></td>
        <td style={S.td}><input autoFocus value={data.nameAr} onChange={(e) => setField("nameAr", e.target.value)} style={ci} placeholder="الاسم بالعربية *" /></td>
        <td style={S.td}><input value={data.nameEn ?? ""} onChange={(e) => setField("nameEn", e.target.value)} style={ci} placeholder="الإنجليزية" /></td>
        <td style={S.tdRight}>
          <button onClick={onSave} style={S.btnSaveSm}>حفظ</button>
          <button onClick={onCancel} style={S.btnCancelSm}>إلغاء</button>
        </td>
      </tr>
      {err && (
        <tr><td colSpan={4} style={{ ...S.td, background: "#fef2f2", color: "#991b1b" }}>⚠️ {err}</td></tr>
      )}
    </>
  );
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
  td: { padding: "10px 14px", fontSize: 14, color: "#0f172a" } as const,
  tdMono: { padding: "10px 14px", fontSize: 13, color: "#0f172a", fontFamily: "ui-monospace, monospace" } as const,
  tdRight: { padding: "10px 14px", textAlign: "left" as const } as const,
  btnPrimary: { padding: "10px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600 } as const,
  btnEdit: { padding: "6px 12px", background: "#f1f5f9", color: "#0f172a", border: "1px solid #e2e8f0", borderRadius: 6, cursor: "pointer", fontSize: 12, marginInlineEnd: 6 } as const,
  btnDel: { padding: "6px 12px", background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 6, cursor: "pointer", fontSize: 12 } as const,
  btnSaveSm: { padding: "5px 12px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, marginInlineEnd: 6 } as const,
  btnCancelSm: { padding: "5px 12px", background: "#f1f5f9", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: 6, cursor: "pointer", fontSize: 12 } as const,
  ok: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 } as const,
  err: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 } as const,
  input: { width: "100%", padding: "10px 12px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 6, fontFamily: "inherit", boxSizing: "border-box" as const } as const,
};
