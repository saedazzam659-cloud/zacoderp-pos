import { useEffect, useState } from "react";
import { listCurrencies, createCurrency, updateCurrency, deleteCurrency, type Currency } from "../lib/accounting";
import { Page, Card, Table, Th, Td, Empty, input, btnPrimary, btnSecondary, btnLink, fmt } from "./_adminUi";

type EditData = { code: string; nameAr: string; nameEn: string; symbol: string; decimals: number; isActive: boolean };
type EditState =
  | { mode: "new"; data: EditData }
  | { mode: "edit"; code: string; data: EditData; isBase: boolean }
  | null;

const EMPTY: EditData = { code: "", nameAr: "", nameEn: "", symbol: "", decimals: 2, isActive: true };

export default function CurrenciesAdmin() {
  const [rows, setRows] = useState<Currency[]>([]);
  const [edit, setEdit] = useState<EditState>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() { setRows(await listCurrencies(false)); }
  useEffect(() => { void refresh(); }, []);

  function startNew() { setErr(null); setEdit({ mode: "new", data: { ...EMPTY } }); }
  function startEdit(c: Currency) {
    setErr(null);
    setEdit({ mode: "edit", code: c.code, isBase: c.isBase, data: {
      code: c.code, nameAr: c.nameAr, nameEn: c.nameEn ?? "", symbol: c.symbol ?? "",
      decimals: c.decimals, isActive: c.isActive,
    }});
  }
  function cancel() { setEdit(null); setErr(null); }
  function setField<K extends keyof EditData>(k: K, v: EditData[K]) { if (edit) setEdit({ ...edit, data: { ...edit.data, [k]: v } }); }
  async function save() {
    if (!edit) return;
    const d = edit.data;
    if (!d.code.trim() || !d.nameAr.trim()) { setErr("الرمز والاسم مطلوبان"); return; }
    setBusy(true); setErr(null);
    try {
      const input = {
        code: d.code.trim().toUpperCase(), nameAr: d.nameAr.trim(),
        nameEn: d.nameEn.trim() || null, symbol: d.symbol.trim() || null,
        decimals: d.decimals, isActive: d.isActive,
      };
      if (edit.mode === "new") await createCurrency(input);
      else await updateCurrency(edit.code, input);
      setEdit(null); await refresh();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }
  async function remove(c: Currency) {
    if (c.isBase) { alert("لا يمكن حذف العملة الأساسية"); return; }
    if (!confirm(`حذف العملة ${c.code}؟ سيتم حذف كل أسعار الصرف الخاصة بها.`)) return;
    try { await deleteCurrency(c.code); await refresh(); } catch (e: any) { alert(e?.message ?? "فشل"); }
  }

  return (
    <Page
      title="العملات"
      subtitle={`${rows.length} عملة — العملة الأساسية ثابتة. أدخل أسعار الصرف من شاشة «أسعار الصرف».`}
      right={<button onClick={startNew} disabled={!!edit} style={{ ...btnPrimary, opacity: edit ? 0.5 : 1 }}>+ إضافة عملة</button>}
    >
      <Card>
        {rows.length === 0 && !edit ? <Empty text="لا توجد عملات" /> : (
          <Table>
            <thead><tr>
              <Th style={{ width: 80 }}>الرمز</Th>
              <Th>الاسم</Th>
              <Th style={{ width: 80 }}>الرمز</Th>
              <Th style={{ width: 80, textAlign: "center" }}>الكسور</Th>
              <Th style={{ width: 140, textAlign: "left" }}>السعر الحالي</Th>
              <Th style={{ width: 100 }}>الحالة</Th>
              <Th style={{ width: 200 }}>إجراءات</Th>
            </tr></thead>
            <tbody>
              {edit?.mode === "new" && (
                <EditRow data={edit.data} setField={setField} onSave={save} onCancel={cancel} busy={busy} err={err} isNew />
              )}
              {rows.map((c) => (
                edit?.mode === "edit" && edit.code === c.code ? (
                  <EditRow key={c.code} data={edit.data} setField={setField} onSave={save} onCancel={cancel} busy={busy} err={err} isBase={edit.isBase} />
                ) : (
                  <tr key={c.code} style={{ opacity: edit ? 0.6 : 1 }}>
                    <Td mono style={{ fontWeight: 700 }}>{c.code}</Td>
                    <Td>{c.nameAr}{c.nameEn && <span style={{ color: "#94a3b8", fontSize: 12, marginInlineStart: 6 }}>({c.nameEn})</span>}</Td>
                    <Td>{c.symbol ?? "—"}</Td>
                    <Td num style={{ textAlign: "center" }}>{c.decimals}</Td>
                    <Td num style={{ fontWeight: 600 }}>{c.isBase ? "1.0000 (أساسية)" : (c.currentRate != null ? fmt(c.currentRate) : <span style={{ color: "#dc2626" }}>لا يوجد</span>)}</Td>
                    <Td>{c.isActive
                      ? <span style={{ color: "#059669", fontSize: 12, fontWeight: 600 }}>● نشطة</span>
                      : <span style={{ color: "#94a3b8", fontSize: 12 }}>● موقوفة</span>}</Td>
                    <Td>
                      <button onClick={() => startEdit(c)} disabled={!!edit} style={btnLink}>تعديل</button>
                      {!c.isBase && <>{" · "}<button onClick={() => remove(c)} disabled={!!edit} style={{ ...btnLink, color: "#dc2626" }}>حذف</button></>}
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

function EditRow({ data, setField, onSave, onCancel, busy, err, isNew, isBase }: {
  data: EditData; setField: <K extends keyof EditData>(k: K, v: EditData[K]) => void;
  onSave: () => void; onCancel: () => void; busy: boolean; err: string | null;
  isNew?: boolean; isBase?: boolean;
}) {
  const ci: React.CSSProperties = { ...input, padding: "6px 8px", fontSize: 13 };
  return (
    <>
      <tr style={{ background: isNew ? "#f0fdf4" : "#eff6ff" }}>
        <Td><input autoFocus={isNew} value={data.code} onChange={(e) => setField("code", e.target.value.toUpperCase())} style={{ ...ci, fontFamily: "ui-monospace, monospace", fontWeight: 700 }} placeholder="USD" maxLength={5} disabled={!isNew} /></Td>
        <Td><input value={data.nameAr} onChange={(e) => setField("nameAr", e.target.value)} style={ci} placeholder="الاسم بالعربية *" /></Td>
        <Td><input value={data.symbol} onChange={(e) => setField("symbol", e.target.value)} style={ci} placeholder="$" maxLength={4} /></Td>
        <Td num><input type="number" min={0} max={4} value={data.decimals} onChange={(e) => setField("decimals", Number(e.target.value) || 0)} style={{ ...ci, textAlign: "center" }} /></Td>
        <Td num style={{ color: "#94a3b8", fontSize: 12 }}>—</Td>
        <Td><label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}><input type="checkbox" checked={data.isActive} onChange={(e) => setField("isActive", e.target.checked)} disabled={isBase} />نشطة</label></Td>
        <Td>
          <button onClick={onSave} disabled={busy} style={{ ...btnPrimary, padding: "4px 10px", fontSize: 12 }}>{busy ? "..." : "حفظ"}</button>
          {" "}<button onClick={onCancel} disabled={busy} style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12 }}>إلغاء</button>
        </Td>
      </tr>
      {isBase && <tr><Td colSpan={7} style={{ background: "#fffbeb", color: "#92400e", fontSize: 12 }}>ℹ️ هذه هي العملة الأساسية. لا يمكن إيقافها ولا تحرير رمزها.</Td></tr>}
      <tr><Td colSpan={7} style={{ background: "#f8fafc" }}>
        <input value={data.nameEn} onChange={(e) => setField("nameEn", e.target.value)} style={{ ...ci, maxWidth: 360 }} placeholder="English name (optional)" />
      </Td></tr>
      {err && <tr><Td colSpan={7} style={{ background: "#fef2f2", color: "#991b1b", fontSize: 13 }}>⚠️ {err}</Td></tr>}
    </>
  );
}
