import { useEffect, useState } from "react";
import {
  listSupplierGroups, createSupplierGroup, updateSupplierGroup, deleteSupplierGroup,
  type SupplierGroup, type SupplierGroupInput,
} from "../lib/accounting";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, btnLink,
} from "./_adminUi";

const emptyInput: SupplierGroupInput = {
  code: "", nameAr: "", nameEn: null, discountPercent: 0, notes: null, isActive: true,
};

type EditState =
  | { mode: "new"; data: SupplierGroupInput }
  | { mode: "edit"; id: number; data: SupplierGroupInput }
  | null;

export default function SupplierGroupsAdmin() {
  const [rows, setRows] = useState<SupplierGroup[]>([]);
  const [edit, setEdit] = useState<EditState>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() { setRows(await listSupplierGroups()); }
  useEffect(() => { void refresh(); }, []);

  function startNew() { setErr(null); setEdit({ mode: "new", data: { ...emptyInput } }); }
  function startEdit(g: SupplierGroup) {
    setErr(null);
    setEdit({ mode: "edit", id: g.id, data: {
      code: g.code, nameAr: g.nameAr, nameEn: g.nameEn,
      discountPercent: g.discountPercent, notes: g.notes, isActive: g.isActive,
    } });
  }
  function cancel() { setEdit(null); setErr(null); }
  function setField<K extends keyof SupplierGroupInput>(k: K, v: SupplierGroupInput[K]) {
    if (!edit) return;
    setEdit({ ...edit, data: { ...edit.data, [k]: v } });
  }

  async function save() {
    if (!edit) return;
    const f = edit.data;
    if (!f.code.trim()) { setErr("الكود مطلوب"); return; }
    if (!f.nameAr.trim()) { setErr("الاسم بالعربي مطلوب"); return; }
    setBusy(true); setErr(null);
    try {
      if (edit.mode === "new") await createSupplierGroup(f);
      else await updateSupplierGroup(edit.id, f);
      setEdit(null);
      await refresh();
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setBusy(false); }
  }

  async function remove(g: SupplierGroup) {
    if (!confirm(`حذف مجموعة ${g.nameAr}؟`)) return;
    try { await deleteSupplierGroup(g.id); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل الحذف"); }
  }

  return (
    <Page
      title="مجموعات الموردين"
      subtitle={`${rows.length} مجموعة — تصنيف الموردين مع نسبة خصم افتراضية`}
      right={
        <button onClick={startNew} disabled={!!edit}
          style={{ ...btnPrimary, opacity: edit ? 0.5 : 1, cursor: edit ? "not-allowed" : "pointer" }}>
          + إضافة مجموعة
        </button>
      }
    >
      {edit && (
        <Card style={{ marginBottom: 12 }}>
          <div style={{ padding: 16 }}>
            <h3 style={{ marginTop: 0 }}>{edit.mode === "new" ? "مجموعة جديدة" : "تعديل المجموعة"}</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <Field label="الكود *">
                <input value={edit.data.code} onChange={(e) => setField("code", e.target.value)} style={input} autoFocus placeholder="كود المجموعة" />
              </Field>
              <Field label="الاسم بالعربي *">
                <input value={edit.data.nameAr} onChange={(e) => setField("nameAr", e.target.value)} style={input} placeholder="اسم المجموعة" />
              </Field>
              <Field label="الاسم بالإنجليزي">
                <input value={edit.data.nameEn ?? ""} onChange={(e) => setField("nameEn", e.target.value || null)} style={input} placeholder="Group name" />
              </Field>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="نسبة الخصم الافتراضية (%)">
                <input type="number" step="0.01" min={0} max={100} value={edit.data.discountPercent ?? 0}
                  onChange={(e) => setField("discountPercent", Number(e.target.value) || 0)} style={input} placeholder="0" />
              </Field>
              <Field label="الحالة">
                <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 0", fontSize: 14 }}>
                  <input type="checkbox" checked={edit.data.isActive ?? true} onChange={(e) => setField("isActive", e.target.checked)} style={{ width: 18, height: 18 }} />
                  مجموعة نشطة
                </label>
              </Field>
            </div>
            <Field label="ملاحظات">
              <textarea value={edit.data.notes ?? ""} onChange={(e) => setField("notes", e.target.value || null)} style={{ ...input, minHeight: 50 }} />
            </Field>
            <ErrorMsg text={err} />
            <Actions>
              <button onClick={cancel} type="button" disabled={busy} style={btnSecondary}>إلغاء</button>
              <button onClick={save} type="button" disabled={busy} style={btnPrimary}>{busy ? "..." : "حفظ"}</button>
            </Actions>
          </div>
        </Card>
      )}

      <Card>
        {rows.length === 0 ? <Empty text="لا توجد مجموعات بعد" /> : (
          <Table>
            <thead><tr>
              <Th>الكود</Th><Th>الاسم</Th>
              <Th style={{ textAlign: "left", width: 130 }}>نسبة الخصم</Th>
              <Th style={{ width: 90 }}>الحالة</Th>
              <Th style={{ width: 150 }}>إجراءات</Th>
            </tr></thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.id} style={{ opacity: edit ? 0.5 : 1 }}>
                  <Td mono>{g.code}</Td>
                  <Td>{g.nameAr}{g.nameEn && <span style={{ color: "#94a3b8", marginInlineStart: 8 }}>{g.nameEn}</span>}</Td>
                  <Td num>{g.discountPercent.toFixed(2)}%</Td>
                  <Td>
                    <span style={{ background: g.isActive ? "#dcfce7" : "#f1f5f9", color: g.isActive ? "#15803d" : "#64748b", padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
                      {g.isActive ? "نشط" : "متوقف"}
                    </span>
                  </Td>
                  <Td>
                    <button onClick={() => startEdit(g)} disabled={!!edit} style={btnLink}>تعديل</button>
                    {" · "}
                    <button onClick={() => remove(g)} disabled={!!edit} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}
