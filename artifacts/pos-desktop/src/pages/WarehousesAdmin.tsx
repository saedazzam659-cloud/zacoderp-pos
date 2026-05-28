import { useEffect, useState } from "react";
import {
  listWarehouses, createWarehouse, updateWarehouse, deleteWarehouse,
  type Warehouse, type WarehouseInput,
} from "../lib/inventory";
import {
  Page, Card, Table, Th, Td, Modal, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, btnLink,
} from "./_adminUi";

const emptyInput: WarehouseInput = { code: "", name: "", address: null, is_default: false, is_active: true };

export default function WarehousesAdmin() {
  const [rows, setRows] = useState<Warehouse[]>([]);
  const [showForm, setShowForm] = useState<null | { editing: Warehouse | null }>(null);

  async function refresh() { setRows(await listWarehouses()); }
  useEffect(() => { void refresh(); }, []);

  async function remove(w: Warehouse) {
    if (!confirm(`حذف المخزن "${w.name}"؟`)) return;
    try { await deleteWarehouse(w.id); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل الحذف"); }
  }

  return (
    <Page
      title="المخازن"
      subtitle={`${rows.length} مخزن`}
      right={<button onClick={() => setShowForm({ editing: null })} style={btnPrimary}>+ إضافة مخزن</button>}
    >
      <Card>
        {rows.length === 0 ? <Empty text="لا توجد مخازن بعد" /> : (
          <Table>
            <thead><tr>
              <Th>الكود</Th><Th>الاسم</Th><Th>العنوان</Th>
              <Th>افتراضي</Th><Th>نشط</Th>
              <Th style={{ width: 180 }}>إجراءات</Th>
            </tr></thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id}>
                  <Td mono>{w.code}</Td>
                  <Td>{w.name}</Td>
                  <Td>{w.address ?? "—"}</Td>
                  <Td>{w.is_default ? "✓" : ""}</Td>
                  <Td>{w.is_active ? "نشط" : <span style={{ color: "#94a3b8" }}>موقوف</span>}</Td>
                  <Td>
                    <button onClick={() => setShowForm({ editing: w })} style={btnLink}>تعديل</button>
                    {!w.is_default && (<>
                      {" · "}
                      <button onClick={() => remove(w)} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
                    </>)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {showForm && (
        <WarehouseForm
          editing={showForm.editing}
          onCancel={() => setShowForm(null)}
          onDone={() => { setShowForm(null); void refresh(); }}
        />
      )}
    </Page>
  );
}

function WarehouseForm({ editing, onCancel, onDone }: { editing: Warehouse | null; onCancel: () => void; onDone: () => void }) {
  const [f, setF] = useState<WarehouseInput>(editing
    ? { code: editing.code, name: editing.name, address: editing.address, is_default: editing.is_default, is_active: editing.is_active }
    : emptyInput);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); setErr(null);
    try {
      if (editing) await updateWarehouse(editing.id, f);
      else await createWarehouse(f);
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={editing ? `تعديل المخزن ${editing.name}` : "إضافة مخزن"} onCancel={onCancel}>
      <Field label="الكود *"><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} style={input} autoFocus /></Field>
      <Field label="الاسم *"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} style={input} /></Field>
      <Field label="العنوان"><input value={f.address ?? ""} onChange={(e) => setF({ ...f, address: e.target.value || null })} style={input} /></Field>
      <div style={{ display: "flex", gap: 20, margin: "8px 0" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={!!f.is_default} onChange={(e) => setF({ ...f, is_default: e.target.checked })} />
          مخزن افتراضي
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={f.is_active !== false} onChange={(e) => setF({ ...f, is_active: e.target.checked })} />
          نشط
        </label>
      </div>
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy || !f.code.trim() || !f.name.trim()} style={btnPrimary}>{busy ? "..." : "حفظ"}</button>
      </Actions>
    </Modal>
  );
}
