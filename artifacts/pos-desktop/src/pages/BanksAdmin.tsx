import { useEffect, useState } from "react";
import { listBanks, createBank, updateBank, deleteBank, type Bank } from "../lib/accounting";
import { Page, Card, Table, Th, Td, Modal, Field, ErrorMsg, Actions, Empty, input, btnPrimary, btnSecondary, btnLink, fmt } from "./_adminUi";

export default function BanksAdmin() {
  const [rows, setRows] = useState<Bank[]>([]);
  const [edit, setEdit] = useState<null | { row: Bank | null }>(null);

  async function refresh() { setRows(await listBanks()); }
  useEffect(() => { void refresh(); }, []);

  async function remove(b: Bank) {
    if (!confirm(`حذف البنك ${b.name}؟`)) return;
    try { await deleteBank(b.id); await refresh(); } catch (e: any) { alert(e?.message ?? "فشل"); }
  }

  return (
    <Page
      title="البنوك"
      subtitle={`${rows.length} حساب بنكي — يتم إنشاء حساب فرعي تحت 1200 تلقائياً`}
      right={<button onClick={() => setEdit({ row: null })} style={btnPrimary}>+ إضافة بنك</button>}
    >
      <Card>
        {rows.length === 0 ? <Empty text="لا توجد بنوك" /> : (
          <Table>
            <thead><tr><Th>اسم البنك</Th><Th>رقم الحساب</Th><Th style={{ textAlign: "left" }}>الرصيد</Th><Th style={{ width: 200 }}>إجراءات</Th></tr></thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id}>
                  <Td>{b.name}</Td>
                  <Td mono>{b.accountNo ?? "—"}</Td>
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
      {edit && <BankForm row={edit.row} onCancel={() => setEdit(null)} onDone={() => { setEdit(null); void refresh(); }} />}
    </Page>
  );
}

function BankForm({ row, onCancel, onDone }: { row: Bank | null; onCancel: () => void; onDone: () => void }) {
  const [name, setName] = useState(row?.name ?? "");
  const [accountNo, setAccountNo] = useState(row?.accountNo ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr(null);
    try {
      if (row) await updateBank(row.id, name, accountNo || null);
      else await createBank(name, accountNo || null);
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={row ? "تعديل بنك" : "إضافة بنك"} onCancel={onCancel}>
      <Field label="اسم البنك"><input value={name} onChange={(e) => setName(e.target.value)} style={input} autoFocus /></Field>
      <Field label="رقم الحساب / IBAN"><input value={accountNo} onChange={(e) => setAccountNo(e.target.value)} style={input} /></Field>
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy || !name.trim()} style={btnPrimary}>{busy ? "..." : "حفظ"}</button>
      </Actions>
    </Modal>
  );
}
