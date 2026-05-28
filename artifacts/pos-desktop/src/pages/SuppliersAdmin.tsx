import { useEffect, useState } from "react";
import {
  listSuppliers, createSupplier, updateSupplier, deleteSupplier,
  type Supplier, type SupplierInput,
} from "../lib/accounting";
import {
  Page, Card, Table, Th, Td, Empty,
  input, btnPrimary, btnSecondary, btnLink, fmt,
} from "./_adminUi";

const emptyInput: SupplierInput = { code: null, nameAr: "", nameEn: null, phone: null, vatNumber: null, notes: null };

type EditState =
  | { mode: "new"; data: SupplierInput }
  | { mode: "edit"; id: number; data: SupplierInput }
  | null;

export default function SuppliersAdmin() {
  const [rows, setRows] = useState<Supplier[]>([]);
  const [edit, setEdit] = useState<EditState>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() { setRows(await listSuppliers()); }
  useEffect(() => { void refresh(); }, []);

  function startNew() { setErr(null); setEdit({ mode: "new", data: { ...emptyInput } }); }
  function startEdit(s: Supplier) {
    setErr(null);
    setEdit({ mode: "edit", id: s.id, data: {
      code: s.code, nameAr: s.nameAr, nameEn: s.nameEn,
      phone: s.phone, vatNumber: s.vatNumber, notes: s.notes,
    } });
  }
  function cancel() { setEdit(null); setErr(null); }
  function setField<K extends keyof SupplierInput>(k: K, v: SupplierInput[K]) {
    if (!edit) return;
    setEdit({ ...edit, data: { ...edit.data, [k]: v } });
  }

  async function save() {
    if (!edit) return;
    const f = edit.data;
    if (!f.nameAr.trim()) { setErr("الاسم بالعربي مطلوب"); return; }
    setBusy(true); setErr(null);
    try {
      if (edit.mode === "new") await createSupplier(f);
      else await updateSupplier(edit.id, f);
      setEdit(null);
      await refresh();
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setBusy(false); }
  }

  async function remove(s: Supplier) {
    if (!confirm(`حذف المورد ${s.nameAr}؟`)) return;
    try { await deleteSupplier(s.id); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل الحذف"); }
  }

  return (
    <Page
      title="الموردون"
      subtitle={`${rows.length} مورد`}
      right={
        <button onClick={startNew} disabled={!!edit}
          style={{ ...btnPrimary, opacity: edit ? 0.5 : 1, cursor: edit ? "not-allowed" : "pointer" }}>
          + إضافة مورد
        </button>
      }
    >
      <Card>
        {rows.length === 0 && !edit ? <Empty text="لا يوجد موردون بعد" /> : (
          <Table>
            <thead><tr>
              <Th>الكود</Th><Th>الاسم</Th><Th>هاتف</Th><Th>الرقم الضريبي</Th>
              <Th style={{ textAlign: "left" }}>الرصيد</Th><Th style={{ width: 220 }}>إجراءات</Th>
            </tr></thead>
            <tbody>
              {edit?.mode === "new" && (
                <EditRow data={edit.data} setField={setField} onSave={save} onCancel={cancel} busy={busy} err={err} isNew />
              )}
              {rows.map((s) => (
                edit?.mode === "edit" && edit.id === s.id ? (
                  <EditRow key={s.id} data={edit.data} setField={setField} onSave={save} onCancel={cancel} busy={busy} err={err} balance={s.balance} />
                ) : (
                  <tr key={s.id} style={{ opacity: edit ? 0.6 : 1 }}>
                    <Td mono>{s.code ?? "—"}</Td>
                    <Td>{s.nameAr}{s.nameEn && <span style={{ color: "#94a3b8", marginInlineStart: 8 }}>{s.nameEn}</span>}</Td>
                    <Td>{s.phone ?? "—"}</Td>
                    <Td mono>{s.vatNumber ?? "—"}</Td>
                    <Td num style={{ color: s.balance > 0 ? "#dc2626" : "#16a34a", fontWeight: 600 }}>{fmt(s.balance)}</Td>
                    <Td>
                      <button onClick={() => startEdit(s)} disabled={!!edit} style={btnLink}>تعديل</button>
                      {" · "}
                      <button onClick={() => remove(s)} disabled={!!edit} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
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

function EditRow({ data, setField, onSave, onCancel, busy, err, isNew, balance }: {
  data: SupplierInput;
  setField: <K extends keyof SupplierInput>(k: K, v: SupplierInput[K]) => void;
  onSave: () => void; onCancel: () => void;
  busy: boolean; err: string | null; isNew?: boolean; balance?: number;
}) {
  const ci: React.CSSProperties = { ...input, padding: "6px 8px", fontSize: 13 };
  return (
    <>
      <tr style={{ background: isNew ? "#f0fdf4" : "#eff6ff" }}>
        <Td><input value={data.code ?? ""} onChange={(e) => setField("code", e.target.value || null)} style={ci} placeholder="الكود" /></Td>
        <Td>
          <input autoFocus value={data.nameAr} onChange={(e) => setField("nameAr", e.target.value)} style={ci} placeholder="الاسم بالعربي *" />
          <input value={data.nameEn ?? ""} onChange={(e) => setField("nameEn", e.target.value || null)} style={{ ...ci, marginTop: 4 }} placeholder="الاسم بالإنجليزي" />
        </Td>
        <Td><input value={data.phone ?? ""} onChange={(e) => setField("phone", e.target.value || null)} style={ci} placeholder="هاتف" /></Td>
        <Td><input value={data.vatNumber ?? ""} onChange={(e) => setField("vatNumber", e.target.value || null)} style={ci} placeholder="الرقم الضريبي" /></Td>
        <Td num>{balance !== undefined ? fmt(balance) : "—"}</Td>
        <Td>
          <button onClick={onSave} disabled={busy} style={{ ...btnPrimary, padding: "4px 10px", fontSize: 12 }}>{busy ? "..." : "حفظ"}</button>
          {" "}
          <button onClick={onCancel} disabled={busy} style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12 }}>إلغاء</button>
        </Td>
      </tr>
      <tr style={{ background: isNew ? "#f0fdf4" : "#eff6ff" }}>
        <Td colSpan={6}>
          <textarea value={data.notes ?? ""} onChange={(e) => setField("notes", e.target.value || null)}
            style={{ ...ci, minHeight: 40, width: "100%" }} placeholder="ملاحظات" />
        </Td>
      </tr>
      {err && (
        <tr><Td colSpan={6} style={{ background: "#fef2f2", color: "#991b1b", fontSize: 13 }}>⚠️ {err}</Td></tr>
      )}
    </>
  );
}
