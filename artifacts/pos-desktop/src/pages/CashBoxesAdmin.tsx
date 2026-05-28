import { useEffect, useState } from "react";
import { listCashBoxes, createCashBox, updateCashBox, deleteCashBox, listCurrencies, type CashBox, type Currency } from "../lib/accounting";
import { Page, Card, Table, Th, Td, Empty, input, btnPrimary, btnSecondary, btnLink, fmtCurrency, SearchCombobox } from "./_adminUi";

type EditData = { name: string; currencyCode: string };
type EditState =
  | { mode: "new"; data: EditData }
  | { mode: "edit"; id: number; data: EditData; lockedCurrency: boolean }
  | null;

export default function CashBoxesAdmin() {
  const [rows, setRows] = useState<CashBox[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [edit, setEdit] = useState<EditState>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    const [cb, cur] = await Promise.all([listCashBoxes(), listCurrencies(true)]);
    setRows(cb); setCurrencies(cur);
  }
  useEffect(() => { void refresh(); }, []);

  function startNew() { setErr(null); setEdit({ mode: "new", data: { name: "", currencyCode: "SAR" } }); }
  function startEdit(b: CashBox) {
    setErr(null);
    setEdit({ mode: "edit", id: b.id, data: { name: b.name, currencyCode: b.currencyCode || "SAR" }, lockedCurrency: Math.abs(b.balance) > 0.001 });
  }
  function cancel() { setEdit(null); setErr(null); }
  function setField<K extends keyof EditData>(k: K, v: EditData[K]) { if (edit) setEdit({ ...edit, data: { ...edit.data, [k]: v } }); }
  async function save() {
    if (!edit) return;
    if (!edit.data.name.trim()) { setErr("الاسم مطلوب"); return; }
    setBusy(true); setErr(null);
    try {
      if (edit.mode === "new") await createCashBox(edit.data.name, edit.data.currencyCode);
      else await updateCashBox(edit.id, edit.data.name, edit.data.currencyCode);
      setEdit(null); await refresh();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }
  async function remove(b: CashBox) {
    if (!confirm(`حذف الخزينة ${b.name}؟`)) return;
    try { await deleteCashBox(b.id); await refresh(); } catch (e: any) { alert(e?.message ?? "فشل"); }
  }

  const currencyOpts = currencies.length > 0
    ? currencies.map(c => ({ value: c.code, label: `${c.code} — ${c.nameAr}`, hint: c.symbol ?? undefined }))
    : [{ value: "SAR", label: "SAR — ريال سعودي" }];

  return (
    <Page
      title="الخزن"
      subtitle={`${rows.length} خزينة — يتم إنشاء حساب فرعي تحت 1100 تلقائياً. لا يمكن تغيير العملة بعد دخول الرصيد.`}
      right={<button onClick={startNew} disabled={!!edit} style={{ ...btnPrimary, opacity: edit ? 0.5 : 1, cursor: edit ? "not-allowed" : "pointer" }}>+ إضافة خزينة</button>}
    >
      <Card>
        {rows.length === 0 && !edit ? <Empty text="لا توجد خزن" /> : (
          <Table>
            <thead><tr><Th>اسم الخزينة</Th><Th style={{ width: 160 }}>العملة</Th><Th style={{ textAlign: "left" }}>الرصيد</Th><Th style={{ width: 220 }}>إجراءات</Th></tr></thead>
            <tbody>
              {edit?.mode === "new" && (
                <EditRow data={edit.data} setField={setField} onSave={save} onCancel={cancel} busy={busy} err={err} isNew currencyOpts={currencyOpts} currencyLocked={false} />
              )}
              {rows.map((b) => (
                edit?.mode === "edit" && edit.id === b.id ? (
                  <EditRow key={b.id} data={edit.data} setField={setField} onSave={save} onCancel={cancel} busy={busy} err={err} balance={b.balance} currency={b.currencyCode} currencyOpts={currencyOpts} currencyLocked={edit.lockedCurrency} />
                ) : (
                  <tr key={b.id} style={{ opacity: edit ? 0.6 : 1 }}>
                    <Td>{b.name}</Td>
                    <Td><span style={{ background: "#eff6ff", color: "#1e40af", padding: "2px 8px", borderRadius: 4, fontSize: 12, fontWeight: 600 }}>{b.currencyCode || "SAR"}</span></Td>
                    <Td num style={{ fontWeight: 600 }}>{fmtCurrency(b.balance, b.currencyCode || "SAR")}</Td>
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

function EditRow({ data, setField, onSave, onCancel, busy, err, isNew, balance, currency, currencyOpts, currencyLocked }: {
  data: EditData; setField: <K extends keyof EditData>(k: K, v: EditData[K]) => void;
  onSave: () => void; onCancel: () => void; busy: boolean; err: string | null;
  isNew?: boolean; balance?: number; currency?: string;
  currencyOpts: { value: string | number; label: string; hint?: string }[]; currencyLocked: boolean;
}) {
  const ci: React.CSSProperties = { ...input, padding: "6px 8px", fontSize: 13 };
  return (
    <>
      <tr style={{ background: isNew ? "#f0fdf4" : "#eff6ff" }}>
        <Td><input autoFocus value={data.name} onChange={(e) => setField("name", e.target.value)} style={ci} placeholder="اسم الخزينة *" /></Td>
        <Td>
          <SearchCombobox
            value={data.currencyCode}
            onChange={(v) => setField("currencyCode", String(v))}
            options={currencyOpts}
            disabled={currencyLocked}
            style={ci}
          />
        </Td>
        <Td num>{balance !== undefined ? fmtCurrency(balance, currency || "SAR") : "—"}</Td>
        <Td>
          <button onClick={onSave} disabled={busy} style={{ ...btnPrimary, padding: "4px 10px", fontSize: 12 }}>{busy ? "..." : "حفظ"}</button>
          {" "}
          <button onClick={onCancel} disabled={busy} style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12 }}>إلغاء</button>
        </Td>
      </tr>
      {currencyLocked && <tr><Td colSpan={4} style={{ background: "#fffbeb", color: "#92400e", fontSize: 12 }}>⚠️ لا يمكن تغيير عملة خزينة لديها رصيد. أصدر تحويل خزينة لتفريغها أولاً.</Td></tr>}
      {err && <tr><Td colSpan={4} style={{ background: "#fef2f2", color: "#991b1b", fontSize: 13 }}>⚠️ {err}</Td></tr>}
    </>
  );
}
