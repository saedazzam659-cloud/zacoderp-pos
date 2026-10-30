import { useEffect, useState } from "react";
import { listBanks, createBank, updateBank, deleteBank, listCurrencies, type Bank, type Currency } from "../lib/accounting";
import { Page, Card, Table, Th, Td, Empty, input, btnPrimary, btnSecondary, btnLink, fmtCurrency, SearchCombobox } from "./_adminUi";
import { uiText, useUiLanguage } from "../lib/appSettings";

type EditData = { name: string; accountNo: string; currencyCode: string };
type EditState =
  | { mode: "new"; data: EditData }
  | { mode: "edit"; id: number; data: EditData; lockedCurrency: boolean }
  | null;

export default function BanksAdmin() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [rows, setRows] = useState<Bank[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [edit, setEdit] = useState<EditState>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    const [bk, cur] = await Promise.all([listBanks(), listCurrencies(true)]);
    setRows(bk); setCurrencies(cur);
  }
  useEffect(() => { void refresh(); }, []);

  function startNew() { setErr(null); setEdit({ mode: "new", data: { name: "", accountNo: "", currencyCode: "SAR" } }); }
  function startEdit(b: Bank) {
    setErr(null);
    setEdit({ mode: "edit", id: b.id, data: { name: b.name, accountNo: b.accountNo ?? "", currencyCode: b.currencyCode || "SAR" }, lockedCurrency: Math.abs(b.balance) > 0.001 });
  }
  function cancel() { setEdit(null); setErr(null); }
  function setField<K extends keyof EditData>(k: K, v: EditData[K]) { if (edit) setEdit({ ...edit, data: { ...edit.data, [k]: v } }); }
  async function save() {
    if (!edit) return;
    const { name, accountNo, currencyCode } = edit.data;
    if (!name.trim()) { setErr(text("اسم البنك مطلوب", "Bank name is required.")); return; }
    setBusy(true); setErr(null);
    try {
      if (edit.mode === "new") await createBank(name, accountNo || null, currencyCode);
      else await updateBank(edit.id, name, accountNo || null, currencyCode);
      setEdit(null); await refresh();
    } catch (e: any) { setErr(e?.message ?? text("فشل", "Could not save bank.")); }
    finally { setBusy(false); }
  }
  async function remove(b: Bank) {
    if (!confirm(text(`حذف البنك ${b.name}؟`, `Delete bank “${b.name}”?`))) return;
    try { await deleteBank(b.id); await refresh(); } catch (e: any) { alert(e?.message ?? text("فشل", "Could not delete bank.")); }
  }

  const currencyOpts = currencies.length > 0
    ? currencies.map(c => ({ value: c.code, label: `${c.code} — ${language === "en" ? c.nameEn || c.code : c.nameAr}`, hint: c.symbol ?? undefined }))
    : [{ value: "SAR", label: text("SAR — ريال سعودي", "SAR — Saudi riyal") }];

  return (
    <div dir={language === "en" ? "ltr" : "rtl"}>
    <Page
      title={text("البنوك", "Banks")}
      subtitle={text(`${rows.length} حساب بنكي — يتم إنشاء حساب فرعي تحت 1200 تلقائياً. لا يمكن تغيير العملة بعد دخول الرصيد.`, `${rows.length} bank accounts — a subaccount under 1200 is created automatically. Currency cannot be changed after the account has a balance.`)}
      right={<button onClick={startNew} disabled={!!edit} style={{ ...btnPrimary, opacity: edit ? 0.5 : 1, cursor: edit ? "not-allowed" : "pointer" }}>+ {text("إضافة بنك", "Add bank")}</button>}
    >
      <Card>
        {rows.length === 0 && !edit ? <Empty text={text("لا توجد بنوك", "No banks yet")} /> : (
          <Table>
            <thead><tr><Th>{text("اسم البنك", "Bank name")}</Th><Th>{text("رقم الحساب", "Account number")}</Th><Th style={{ width: 130 }}>{text("العملة", "Currency")}</Th><Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الرصيد", "Balance")}</Th><Th style={{ width: 220 }}>{text("إجراءات", "Actions")}</Th></tr></thead>
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
                    <Td mono>{b.accountNo ?? "—"}</Td>
                    <Td><span style={{ background: "#eff6ff", color: "#1e40af", padding: "2px 8px", borderRadius: 4, fontSize: 12, fontWeight: 600 }}>{b.currencyCode || "SAR"}</span></Td>
                    <Td num style={{ fontWeight: 600 }}>{fmtCurrency(b.balance, b.currencyCode || "SAR")}</Td>
                    <Td>
                      <button onClick={() => startEdit(b)} disabled={!!edit} style={btnLink}>{text("تعديل", "Edit")}</button>
                      {" · "}
                      <button onClick={() => remove(b)} disabled={!!edit} style={{ ...btnLink, color: "#dc2626" }}>{text("حذف", "Delete")}</button>
                    </Td>
                  </tr>
                )
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
    </div>
  );
}

function EditRow({ data, setField, onSave, onCancel, busy, err, isNew, balance, currency, currencyOpts, currencyLocked }: {
  data: EditData; setField: <K extends keyof EditData>(k: K, v: EditData[K]) => void;
  onSave: () => void; onCancel: () => void; busy: boolean; err: string | null;
  isNew?: boolean; balance?: number; currency?: string;
  currencyOpts: { value: string | number; label: string; hint?: string }[]; currencyLocked: boolean;
}) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const ci: React.CSSProperties = { ...input, padding: "6px 8px", fontSize: 13 };
  return (
    <>
      <tr style={{ background: isNew ? "#f0fdf4" : "#eff6ff" }}>
        <Td><input autoFocus value={data.name} onChange={(e) => setField("name", e.target.value)} style={ci} placeholder={text("اسم البنك *", "Bank name *")} /></Td>
        <Td><input value={data.accountNo} onChange={(e) => setField("accountNo", e.target.value)} style={ci} placeholder={text("رقم الحساب / IBAN", "Account number / IBAN")} /></Td>
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
          <button onClick={onSave} disabled={busy} style={{ ...btnPrimary, padding: "4px 10px", fontSize: 12 }}>{busy ? "..." : text("حفظ", "Save")}</button>
          {" "}
          <button onClick={onCancel} disabled={busy} style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12 }}>{text("إلغاء", "Cancel")}</button>
        </Td>
      </tr>
      {currencyLocked && <tr><Td colSpan={5} style={{ background: "#fffbeb", color: "#92400e", fontSize: 12 }}>⚠️ {text("لا يمكن تغيير عملة بنك لديه رصيد. أصدر تحويل خزينة لتفريغه أولاً.", "The currency cannot be changed while the bank has a balance. Transfer the funds out first.")}</Td></tr>}
      {err && <tr><Td colSpan={5} style={{ background: "#fef2f2", color: "#991b1b", fontSize: 13 }}>⚠️ {err}</Td></tr>}
    </>
  );
}
