import { useEffect, useState } from "react";
import { listCashBoxes, createCashBox, updateCashBox, deleteCashBox, type CashBox } from "../lib/accounting";
import { Page, Card, Table, Th, Td, Empty, input, btnPrimary, btnSecondary, btnLink, fmt } from "./_adminUi";

type EditState =
  | { mode: "new"; name: string }
  | { mode: "edit"; id: number; name: string }
  | null;

export default function CashBoxesAdmin() {
  const [rows, setRows] = useState<CashBox[]>([]);
  const [edit, setEdit] = useState<EditState>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() { setRows(await listCashBoxes()); }
  useEffect(() => { void refresh(); }, []);

  function startNew() { setErr(null); setEdit({ mode: "new", name: "" }); }
  function startEdit(b: CashBox) { setErr(null); setEdit({ mode: "edit", id: b.id, name: b.name }); }
  function cancel() { setEdit(null); setErr(null); }
  function setName(v: string) { if (edit) setEdit({ ...edit, name: v }); }
  async function save() {
    if (!edit) return;
    if (!edit.name.trim()) { setErr("الاسم مطلوب"); return; }
    setBusy(true); setErr(null);
    try {
      if (edit.mode === "new") await createCashBox(edit.name);
      else await updateCashBox(edit.id, edit.name);
      setEdit(null); await refresh();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }
  async function remove(b: CashBox) {
    if (!confirm(`حذف الخزينة ${b.name}؟`)) return;
    try { await deleteCashBox(b.id); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل"); }
  }

  return (
    <Page
      title="الخزن"
      subtitle={`${rows.length} خزينة — يتم إنشاء حساب فرعي تحت 1100 تلقائياً`}
      right={<button onClick={startNew} disabled={!!edit} style={{ ...btnPrimary, opacity: edit ? 0.5 : 1, cursor: edit ? "not-allowed" : "pointer" }}>+ إضافة خزينة</button>}
    >
      <Card>
        {rows.length === 0 && !edit ? <Empty text="لا توجد خزن" /> : (
          <Table>
            <thead><tr><Th>اسم الخزينة</Th><Th style={{ textAlign: "left" }}>الرصيد</Th><Th style={{ width: 220 }}>إجراءات</Th></tr></thead>
            <tbody>
              {edit?.mode === "new" && (
                <EditRow name={edit.name} setName={setName} onSave={save} onCancel={cancel} busy={busy} err={err} isNew />
              )}
              {rows.map((b) => (
                edit?.mode === "edit" && edit.id === b.id ? (
                  <EditRow key={b.id} name={edit.name} setName={setName} onSave={save} onCancel={cancel} busy={busy} err={err} balance={b.balance} />
                ) : (
                  <tr key={b.id} style={{ opacity: edit ? 0.6 : 1 }}>
                    <Td>{b.name}</Td>
                    <Td num style={{ fontWeight: 600 }}>{fmt(b.balance)} ر.س</Td>
                    <Td>
                      <button onClick={() => startEdit(b)} disabled={!!edit} style={btnLink}>تعديل</button>
                      {" · "}
                      <button onClick={() => remove(b)} disabled={!!edit} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
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

function EditRow({ name, setName, onSave, onCancel, busy, err, isNew, balance }: {
  name: string; setName: (v: string) => void;
  onSave: () => void; onCancel: () => void; busy: boolean; err: string | null;
  isNew?: boolean; balance?: number;
}) {
  const ci: React.CSSProperties = { ...input, padding: "6px 8px", fontSize: 13 };
  return (
    <>
      <tr style={{ background: isNew ? "#f0fdf4" : "#eff6ff" }}>
        <Td><input autoFocus value={name} onChange={(e) => setName(e.target.value)} style={ci} placeholder="اسم الخزينة *" /></Td>
        <Td num>{balance !== undefined ? `${fmt(balance)} ر.س` : "—"}</Td>
        <Td>
          <button onClick={onSave} disabled={busy} style={{ ...btnPrimary, padding: "4px 10px", fontSize: 12 }}>{busy ? "..." : "حفظ"}</button>
          {" "}
          <button onClick={onCancel} disabled={busy} style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12 }}>إلغاء</button>
        </Td>
      </tr>
      {err && <tr><Td colSpan={3} style={{ background: "#fef2f2", color: "#991b1b", fontSize: 13 }}>⚠️ {err}</Td></tr>}
    </>
  );
}
