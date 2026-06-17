import { useEffect, useState } from "react";
import {
  listWarehouseGroups, createWarehouseGroup, updateWarehouseGroup, deleteWarehouseGroup,
  type WarehouseGroup, type WarehouseGroupInput,
} from "../lib/warehouseGroups";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, btnLink,
} from "./_adminUi";

const emptyInput: WarehouseGroupInput = {
  code: "", nameAr: "", nameEn: null, isActive: true,
};

type EditState =
  | { mode: "new"; data: WarehouseGroupInput }
  | { mode: "edit"; id: number; data: WarehouseGroupInput }
  | null;

export default function WarehouseGroupsAdmin() {
  const [rows, setRows] = useState<WarehouseGroup[]>([]);
  const [edit, setEdit] = useState<EditState>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() { setRows(await listWarehouseGroups()); }
  useEffect(() => { void refresh(); }, []);

  function startNew() { setErr(null); setEdit({ mode: "new", data: { ...emptyInput } }); }
  function startEdit(g: WarehouseGroup) {
    setErr(null);
    setEdit({ mode: "edit", id: g.id, data: {
      code: g.code, nameAr: g.nameAr, nameEn: g.nameEn, isActive: g.isActive,
    } });
  }
  function cancel() { setEdit(null); setErr(null); }
  function setField<K extends keyof WarehouseGroupInput>(k: K, v: WarehouseGroupInput[K]) {
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
      if (edit.mode === "new") await createWarehouseGroup(f);
      else await updateWarehouseGroup(edit.id, f);
      setEdit(null);
      await refresh();
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setBusy(false); }
  }

  async function remove(g: WarehouseGroup) {
    if (!confirm(`حذف مجموعة ${g.nameAr}؟`)) return;
    try { await deleteWarehouseGroup(g.id); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل الحذف"); }
  }

  return (
    <Page
      title="مجموعات المستودعات"
      subtitle={`${rows.length} مجموعة — تصنيف المستودعات`}
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
            <Field label="الحالة">
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 0", fontSize: 14 }}>
                <input type="checkbox" checked={edit.data.isActive} onChange={(e) => setField("isActive", e.target.checked)} style={{ width: 18, height: 18 }} />
                مجموعة نشطة
              </label>
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
              <Th style={{ width: 90 }}>الحالة</Th>
              <Th style={{ width: 150 }}>إجراءات</Th>
            </tr></thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.id} style={{ opacity: edit ? 0.5 : 1 }}>
                  <Td mono>{g.code}</Td>
                  <Td>{g.nameAr}{g.nameEn && <span style={{ color: "#94a3b8", marginInlineStart: 8 }}>{g.nameEn}</span>}</Td>
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
