import { useEffect, useState } from "react";
import {
  listSuppliers, createSupplier, updateSupplier, deleteSupplier, listCurrencies,
  type Supplier, type SupplierInput, type Currency,
} from "../lib/accounting";
import {
  Page, Card, Table, Th, Td, Empty,
  input, btnPrimary, btnSecondary, btnLink, fmtCurrency, SearchCombobox,
} from "./_adminUi";

const emptyInput: SupplierInput = {
  code: null, nameAr: "", nameEn: null, phone: null, vatNumber: null, notes: null,
  currencyCode: "SAR", openingBalance: 0, openingNature: "credit",
};

type EditState =
  | { mode: "new"; data: SupplierInput }
  | { mode: "edit"; id: number; data: SupplierInput }
  | null;

// Supplier balance follows AP convention: positive = we owe (دائن).
function balanceNature(bal: number): { label: string; color: string } {
  if (Math.abs(bal) < 0.001) return { label: "—", color: "#94a3b8" };
  return bal > 0 ? { label: "دائن", color: "#dc2626" } : { label: "مدين", color: "#16a34a" };
}

export default function SuppliersAdmin() {
  const [rows, setRows] = useState<Supplier[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [edit, setEdit] = useState<EditState>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    const [s, cur] = await Promise.all([listSuppliers(), listCurrencies(true)]);
    setRows(s); setCurrencies(cur);
  }
  useEffect(() => { void refresh(); }, []);

  function startNew() { setErr(null); setEdit({ mode: "new", data: { ...emptyInput } }); }
  function startEdit(s: Supplier) {
    setErr(null);
    setEdit({ mode: "edit", id: s.id, data: {
      code: s.code, nameAr: s.nameAr, nameEn: s.nameEn,
      phone: s.phone, vatNumber: s.vatNumber, notes: s.notes,
      currencyCode: s.currencyCode || "SAR",
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
      if (edit.mode === "new") {
        await createSupplier({
          ...f,
          openingDate: new Date().toISOString().slice(0, 10),
        });
      } else {
        // currencyCode only; opening balance is create-only.
        await updateSupplier(edit.id, {
          code: f.code, nameAr: f.nameAr, nameEn: f.nameEn,
          phone: f.phone, vatNumber: f.vatNumber, notes: f.notes,
          currencyCode: f.currencyCode,
        });
      }
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

  const currencyOpts = currencies.length > 0
    ? currencies.map(c => ({ value: c.code, label: `${c.code} — ${c.nameAr}`, hint: c.symbol ?? undefined }))
    : [{ value: "SAR", label: "SAR — ريال سعودي" }];

  return (
    <Page
      title="الموردون"
      subtitle={`${rows.length} مورد — يمكن تحديد العملة والرصيد الافتتاحي عند الإضافة`}
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
              <Th style={{ width: 90 }}>العملة</Th>
              <Th style={{ textAlign: "left" }}>الرصيد</Th><Th style={{ width: 90 }}>النوع</Th>
              <Th style={{ width: 200 }}>إجراءات</Th>
            </tr></thead>
            <tbody>
              {edit?.mode === "new" && (
                <EditRow data={edit.data} setField={setField} onSave={save} onCancel={cancel} busy={busy} err={err} isNew currencyOpts={currencyOpts} />
              )}
              {rows.map((s) => (
                edit?.mode === "edit" && edit.id === s.id ? (
                  <EditRow key={s.id} data={edit.data} setField={setField} onSave={save} onCancel={cancel} busy={busy} err={err} balance={s.balance} currencyOpts={currencyOpts} />
                ) : (
                  <tr key={s.id} style={{ opacity: edit ? 0.6 : 1 }}>
                    <Td mono>{s.code ?? "—"}</Td>
                    <Td>{s.nameAr}{s.nameEn && <span style={{ color: "#94a3b8", marginInlineStart: 8 }}>{s.nameEn}</span>}</Td>
                    <Td>{s.phone ?? "—"}</Td>
                    <Td mono>{s.vatNumber ?? "—"}</Td>
                    <Td><span style={{ background: "#eff6ff", color: "#1e40af", padding: "2px 8px", borderRadius: 4, fontSize: 12, fontWeight: 600 }}>{s.currencyCode || "SAR"}</span></Td>
                    <Td num style={{ color: balanceNature(s.balance).color, fontWeight: 600 }}>{fmtCurrency(Math.abs(s.balance), "SAR")}</Td>
                    <Td style={{ color: balanceNature(s.balance).color, fontWeight: 600 }}>{balanceNature(s.balance).label}</Td>
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

function EditRow({ data, setField, onSave, onCancel, busy, err, isNew, balance, currencyOpts }: {
  data: SupplierInput;
  setField: <K extends keyof SupplierInput>(k: K, v: SupplierInput[K]) => void;
  onSave: () => void; onCancel: () => void;
  busy: boolean; err: string | null; isNew?: boolean; balance?: number;
  currencyOpts: { value: string | number; label: string; hint?: string }[];
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
        <Td>
          <SearchCombobox value={data.currencyCode ?? "SAR"} onChange={(v) => setField("currencyCode", String(v))} options={currencyOpts} style={ci} />
        </Td>
        <Td num colSpan={2}>{balance !== undefined ? fmtCurrency(Math.abs(balance), "SAR") : "—"}</Td>
        <Td>
          <button onClick={onSave} disabled={busy} style={{ ...btnPrimary, padding: "4px 10px", fontSize: 12 }}>{busy ? "..." : "حفظ"}</button>
          {" "}
          <button onClick={onCancel} disabled={busy} style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12 }}>إلغاء</button>
        </Td>
      </tr>
      {isNew && (
        <tr style={{ background: "#f0fdf4" }}>
          <Td colSpan={8}>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, color: "#475569", fontWeight: 600 }}>رصيد افتتاحي:</span>
              <input
                type="number" step="0.01" min="0"
                value={data.openingBalance ?? 0}
                onChange={(e) => setField("openingBalance", Number(e.target.value) || 0)}
                style={{ ...ci, width: 140 }} placeholder="0.00"
              />
              <select
                value={data.openingNature ?? "credit"}
                onChange={(e) => setField("openingNature", e.target.value as "debit" | "credit")}
                style={{ ...ci, width: 130 }}
              >
                <option value="credit">دائن (له علينا)</option>
                <option value="debit">مدين (لنا عليه)</option>
              </select>
              <span style={{ fontSize: 12, color: "#94a3b8" }}>يُرحَّل قيد افتتاحي مقابل حقوق الملكية عند الحفظ.</span>
            </div>
          </Td>
        </tr>
      )}
      <tr style={{ background: isNew ? "#f0fdf4" : "#eff6ff" }}>
        <Td colSpan={8}>
          <textarea value={data.notes ?? ""} onChange={(e) => setField("notes", e.target.value || null)}
            style={{ ...ci, minHeight: 40, width: "100%" }} placeholder="ملاحظات" />
        </Td>
      </tr>
      {err && (
        <tr><Td colSpan={8} style={{ background: "#fef2f2", color: "#991b1b", fontSize: 13 }}>⚠️ {err}</Td></tr>
      )}
    </>
  );
}
