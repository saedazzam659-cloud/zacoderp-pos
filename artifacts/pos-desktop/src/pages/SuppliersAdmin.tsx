import { useEffect, useState } from "react";
import {
  listSuppliers, createSupplier, updateSupplier, deleteSupplier,
  type Supplier, type SupplierInput,
} from "../lib/accounting";
import {
  Page, Card, Table, Th, Td, Modal, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, btnLink, btnDanger, fmt,
} from "./_adminUi";

const emptyInput: SupplierInput = { code: null, nameAr: "", nameEn: null, phone: null, vatNumber: null, notes: null };

export default function SuppliersAdmin() {
  const [rows, setRows] = useState<Supplier[]>([]);
  const [showForm, setShowForm] = useState<null | { editing: Supplier | null }>(null);

  async function refresh() { setRows(await listSuppliers()); }
  useEffect(() => { void refresh(); }, []);

  async function remove(s: Supplier) {
    if (!confirm(`حذف المورد ${s.nameAr}؟`)) return;
    try { await deleteSupplier(s.id); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل الحذف"); }
  }

  return (
    <Page
      title="الموردون"
      subtitle={`${rows.length} مورد`}
      right={<button onClick={() => setShowForm({ editing: null })} style={btnPrimary}>+ إضافة مورد</button>}
    >
      <Card>
        {rows.length === 0 ? <Empty text="لا يوجد موردون بعد" /> : (
          <Table>
            <thead><tr>
              <Th>الكود</Th><Th>الاسم</Th><Th>هاتف</Th><Th>الرقم الضريبي</Th>
              <Th style={{ textAlign: "left" }}>الرصيد</Th><Th style={{ width: 180 }}>إجراءات</Th>
            </tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <Td mono>{s.code ?? "—"}</Td>
                  <Td>{s.nameAr}{s.nameEn && <span style={{ color: "#94a3b8", marginInlineStart: 8 }}>{s.nameEn}</span>}</Td>
                  <Td>{s.phone ?? "—"}</Td>
                  <Td mono>{s.vatNumber ?? "—"}</Td>
                  <Td num style={{ color: s.balance > 0 ? "#dc2626" : "#16a34a", fontWeight: 600 }}>{fmt(s.balance)}</Td>
                  <Td>
                    <button onClick={() => setShowForm({ editing: s })} style={btnLink}>تعديل</button>
                    {" · "}
                    <button onClick={() => remove(s)} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {showForm && (
        <SupplierForm
          editing={showForm.editing}
          onCancel={() => setShowForm(null)}
          onDone={() => { setShowForm(null); void refresh(); }}
        />
      )}
    </Page>
  );
}

function SupplierForm({ editing, onCancel, onDone }: { editing: Supplier | null; onCancel: () => void; onDone: () => void }) {
  const [f, setF] = useState<SupplierInput>(editing
    ? { code: editing.code, nameAr: editing.nameAr, nameEn: editing.nameEn, phone: editing.phone, vatNumber: editing.vatNumber, notes: editing.notes }
    : emptyInput);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); setErr(null);
    try {
      if (editing) await updateSupplier(editing.id, f);
      else await createSupplier(f);
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={editing ? `تعديل المورد ${editing.nameAr}` : "إضافة مورد"} onCancel={onCancel}>
      <Field label="الاسم بالعربي *"><input value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} style={input} autoFocus /></Field>
      <Field label="الاسم بالإنجليزي"><input value={f.nameEn ?? ""} onChange={(e) => setF({ ...f, nameEn: e.target.value || null })} style={input} /></Field>
      <Field label="الكود"><input value={f.code ?? ""} onChange={(e) => setF({ ...f, code: e.target.value || null })} style={input} /></Field>
      <Field label="رقم الهاتف"><input value={f.phone ?? ""} onChange={(e) => setF({ ...f, phone: e.target.value || null })} style={input} /></Field>
      <Field label="الرقم الضريبي"><input value={f.vatNumber ?? ""} onChange={(e) => setF({ ...f, vatNumber: e.target.value || null })} style={input} /></Field>
      <Field label="ملاحظات"><textarea value={f.notes ?? ""} onChange={(e) => setF({ ...f, notes: e.target.value || null })} style={{ ...input, minHeight: 60 }} /></Field>
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy || !f.nameAr.trim()} style={btnPrimary}>{busy ? "..." : "حفظ"}</button>
      </Actions>
    </Modal>
  );
}

void btnDanger;
