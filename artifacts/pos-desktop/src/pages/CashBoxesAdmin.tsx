import { useEffect, useState } from "react";
import { listCashBoxes, createCashBox, updateCashBox, deleteCashBox, type CashBox } from "../lib/accounting";
import { Page, Card, Table, Th, Td, Modal, Field, ErrorMsg, Actions, Empty, input, btnPrimary, btnSecondary, btnLink, fmt } from "./_adminUi";

export default function CashBoxesAdmin() {
  const [rows, setRows] = useState<CashBox[]>([]);
  const [edit, setEdit] = useState<null | { row: CashBox | null }>(null);

  async function refresh() { setRows(await listCashBoxes()); }
  useEffect(() => { void refresh(); }, []);

  async function remove(b: CashBox) {
    if (!confirm(`حذف الخزينة ${b.name}؟`)) return;
    try { await deleteCashBox(b.id); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل"); }
  }

  return (
    <Page
      title="الخزن"
      subtitle={`${rows.length} خزينة — يتم إنشاء حساب فرعي تحت 1100 تلقائياً`}
      right={<button onClick={() => setEdit({ row: null })} style={btnPrimary}>+ إضافة خزينة</button>}
    >
      <Card>
        {rows.length === 0 ? <Empty text="لا توجد خزن" /> : (
          <Table>
            <thead><tr><Th>اسم الخزينة</Th><Th style={{ textAlign: "left" }}>الرصيد</Th><Th style={{ width: 200 }}>إجراءات</Th></tr></thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id}>
                  <Td>{b.name}</Td>
                  <Td num style={{ fontWeight: 600 }}>{fmt(b.balance)} ر.س</Td>
                  <Td>
                    <button onClick={() => setEdit({ row: b })} style={btnLink}>تعديل</button>
                    {" · "}
                    <button onClick={() => remove(b)} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {edit && <CashBoxForm row={edit.row} onCancel={() => setEdit(null)} onDone={() => { setEdit(null); void refresh(); }} />}
    </Page>
  );
}

function CashBoxForm({ row, onCancel, onDone }: { row: CashBox | null; onCancel: () => void; onDone: () => void }) {
  const [name, setName] = useState(row?.name ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr(null);
    try {
      if (row) await updateCashBox(row.id, name);
      else await createCashBox(name);
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={row ? "تعديل خزينة" : "إضافة خزينة"} onCancel={onCancel}>
      <Field label="اسم الخزينة"><input value={name} onChange={(e) => setName(e.target.value)} style={input} autoFocus /></Field>
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy || !name.trim()} style={btnPrimary}>{busy ? "..." : "حفظ"}</button>
      </Actions>
    </Modal>
  );
}
