import { useEffect, useState } from "react";
import {
  listWarehouses, createWarehouse, updateWarehouse, deleteWarehouse,
  type Warehouse, type WarehouseInput,
} from "../lib/inventory";
import {
  Page, Card, Table, Th, Td, Empty,
  input, btnPrimary, btnSecondary, btnLink,
} from "./_adminUi";

const emptyInput: WarehouseInput = { code: "", name: "", address: null, is_default: false, is_active: true };

type EditState =
  | { mode: "new"; data: WarehouseInput }
  | { mode: "edit"; id: number; data: WarehouseInput }
  | null;

export default function WarehousesAdmin() {
  const [rows, setRows] = useState<Warehouse[]>([]);
  const [edit, setEdit] = useState<EditState>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() { setRows(await listWarehouses()); }
  useEffect(() => { void refresh(); }, []);

  function startNew() {
    setErr(null);
    setEdit({ mode: "new", data: { ...emptyInput } });
  }
  function startEdit(w: Warehouse) {
    setErr(null);
    setEdit({
      mode: "edit",
      id: w.id,
      data: { code: w.code, name: w.name, address: w.address, is_default: w.is_default, is_active: w.is_active },
    });
  }
  function cancel() { setEdit(null); setErr(null); }

  async function save() {
    if (!edit) return;
    const f = edit.data;
    if (!f.code.trim() || !f.name.trim()) { setErr("الكود والاسم مطلوبان"); return; }
    setBusy(true); setErr(null);
    try {
      if (edit.mode === "new") await createWarehouse(f);
      else await updateWarehouse(edit.id, f);
      setEdit(null);
      await refresh();
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setBusy(false); }
  }

  async function remove(w: Warehouse) {
    if (!confirm(`حذف المخزن "${w.name}"؟`)) return;
    try { await deleteWarehouse(w.id); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل الحذف"); }
  }

  function setField<K extends keyof WarehouseInput>(k: K, v: WarehouseInput[K]) {
    if (!edit) return;
    setEdit({ ...edit, data: { ...edit.data, [k]: v } });
  }

  return (
    <Page
      title="المخازن"
      subtitle={`${rows.length} مخزن`}
      right={
        <button
          onClick={startNew}
          disabled={!!edit}
          style={{ ...btnPrimary, opacity: edit ? 0.5 : 1, cursor: edit ? "not-allowed" : "pointer" }}
        >+ إضافة مخزن</button>
      }
    >
      <Card>
        {rows.length === 0 && !edit ? <Empty text="لا توجد مخازن بعد" /> : (
          <Table>
            <thead><tr>
              <Th>الكود</Th><Th>الاسم</Th><Th>العنوان</Th>
              <Th>افتراضي</Th><Th>نشط</Th>
              <Th style={{ width: 200 }}>إجراءات</Th>
            </tr></thead>
            <tbody>
              {edit?.mode === "new" && (
                <EditRow data={edit.data} setField={setField} onSave={save} onCancel={cancel} busy={busy} err={err} isNew />
              )}
              {rows.map((w) => (
                edit?.mode === "edit" && edit.id === w.id ? (
                  <EditRow key={w.id} data={edit.data} setField={setField} onSave={save} onCancel={cancel} busy={busy} err={err} />
                ) : (
                  <tr key={w.id} style={{ opacity: edit ? 0.6 : 1 }}>
                    <Td mono>{w.code}</Td>
                    <Td>{w.name}</Td>
                    <Td>{w.address ?? "—"}</Td>
                    <Td>{w.is_default ? "✓" : ""}</Td>
                    <Td>{w.is_active ? "نشط" : <span style={{ color: "#94a3b8" }}>موقوف</span>}</Td>
                    <Td>
                      <button onClick={() => startEdit(w)} disabled={!!edit} style={btnLink}>تعديل</button>
                      {!w.is_default && (<>
                        {" · "}
                        <button onClick={() => remove(w)} disabled={!!edit} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
                      </>)}
                    </Td>
                  </tr>
                )
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}

function EditRow({ data, setField, onSave, onCancel, busy, err, isNew }: {
  data: WarehouseInput;
  setField: <K extends keyof WarehouseInput>(k: K, v: WarehouseInput[K]) => void;
  onSave: () => void; onCancel: () => void;
  busy: boolean; err: string | null; isNew?: boolean;
}) {
  const cellInput: React.CSSProperties = { ...input, padding: "6px 8px", fontSize: 13 };
  return (
    <>
      <tr style={{ background: isNew ? "#f0fdf4" : "#eff6ff" }}>
        <Td><input autoFocus value={data.code} onChange={(e) => setField("code", e.target.value)} style={cellInput} placeholder="الكود" /></Td>
        <Td><input value={data.name} onChange={(e) => setField("name", e.target.value)} style={cellInput} placeholder="الاسم" /></Td>
        <Td><input value={data.address ?? ""} onChange={(e) => setField("address", e.target.value || null)} style={cellInput} placeholder="—" /></Td>
        <Td><input type="checkbox" checked={!!data.is_default} onChange={(e) => setField("is_default", e.target.checked)} /></Td>
        <Td><input type="checkbox" checked={data.is_active !== false} onChange={(e) => setField("is_active", e.target.checked)} /></Td>
        <Td>
          <button onClick={onSave} disabled={busy} style={{ ...btnPrimary, padding: "4px 10px", fontSize: 12 }}>{busy ? "..." : "حفظ"}</button>
          {" "}
          <button onClick={onCancel} disabled={busy} style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12 }}>إلغاء</button>
        </Td>
      </tr>
      {err && (
        <tr>
          <Td colSpan={6} style={{ background: "#fef2f2", color: "#991b1b", fontSize: 13 }}>⚠️ {err}</Td>
        </tr>
      )}
    </>
  );
}
