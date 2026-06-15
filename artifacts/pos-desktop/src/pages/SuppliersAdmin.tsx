import { useEffect, useState } from "react";
import {
  listSuppliers, createSupplier, updateSupplier, deleteSupplier, listCurrencies, listAccounts,
  listSupplierGroups,
  type Supplier, type SupplierInput, type Currency, type Account, type SupplierGroup,
} from "../lib/accounting";
import {
  Page, Card, Table, Th, Td, Empty, SearchCombobox,
  btnPrimary, btnLink, fmtCurrency,
} from "./_adminUi";

const emptyInput: SupplierInput = {
  code: null, nameAr: "", nameEn: null, phone: null, vatNumber: null, notes: null,
  currencyCode: "SAR", openingBalance: 0, openingNature: "credit",
  email: null, crNumber: null, city: null, district: null, street: null,
  buildingNumber: null, postalCode: null, country: "SA", nationalAddressShort: null,
  includeInStatements: true, apAccountId: null, groupId: null,
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
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [groups, setGroups] = useState<SupplierGroup[]>([]);
  const [edit, setEdit] = useState<EditState>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    const [s, cur, acc, grp] = await Promise.all([listSuppliers(), listCurrencies(true), listAccounts(), listSupplierGroups()]);
    setRows(s); setCurrencies(cur); setAccounts(acc); setGroups(grp);
  }
  useEffect(() => { void refresh(); }, []);

  function startNew() { setErr(null); setEdit({ mode: "new", data: { ...emptyInput } }); }
  function startEdit(s: Supplier) {
    setErr(null);
    setEdit({ mode: "edit", id: s.id, data: {
      code: s.code, nameAr: s.nameAr, nameEn: s.nameEn,
      phone: s.phone, vatNumber: s.vatNumber, notes: s.notes,
      currencyCode: s.currencyCode || "SAR",
      email: s.email, crNumber: s.crNumber, city: s.city, district: s.district,
      street: s.street, buildingNumber: s.buildingNumber, postalCode: s.postalCode,
      country: s.country || "SA", nationalAddressShort: s.nationalAddressShort,
      includeInStatements: s.includeInStatements, apAccountId: s.apAccountId,
      groupId: s.groupId,
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
        await createSupplier({ ...f, openingDate: new Date().toISOString().slice(0, 10) });
      } else {
        await updateSupplier(edit.id, {
          code: f.code, nameAr: f.nameAr, nameEn: f.nameEn,
          phone: f.phone, vatNumber: f.vatNumber, notes: f.notes,
          currencyCode: f.currencyCode,
          email: f.email, crNumber: f.crNumber, city: f.city, district: f.district,
          street: f.street, buildingNumber: f.buildingNumber, postalCode: f.postalCode,
          country: f.country, nationalAddressShort: f.nationalAddressShort,
          includeInStatements: f.includeInStatements, apAccountId: f.apAccountId,
          groupId: f.groupId,
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

  const currencyOpts = currencies.length > 0 ? currencies.map(c => c.code) : ["SAR"];

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
      {edit && (
        <SupplierForm
          mode={edit.mode}
          data={edit.data}
          setField={setField}
          onSave={save}
          onCancel={cancel}
          busy={busy}
          err={err}
          currencyOpts={currencyOpts}
          accounts={accounts}
          groups={groups}
        />
      )}

      <Card>
        {rows.length === 0 ? <Empty text="لا يوجد موردون بعد" /> : (
          <Table>
            <thead><tr>
              <Th>الكود</Th><Th>الاسم</Th><Th>هاتف</Th><Th>الرقم الضريبي</Th>
              <Th style={{ width: 90 }}>العملة</Th>
              <Th style={{ textAlign: "left" }}>الرصيد</Th><Th style={{ width: 90 }}>النوع</Th>
              <Th style={{ width: 160 }}>إجراءات</Th>
            </tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} style={{ opacity: edit ? 0.5 : 1 }}>
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
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}

function SupplierForm({ mode, data, setField, onSave, onCancel, busy, err, currencyOpts, accounts, groups }: {
  mode: "new" | "edit";
  data: SupplierInput;
  setField: <K extends keyof SupplierInput>(k: K, v: SupplierInput[K]) => void;
  onSave: () => void; onCancel: () => void;
  busy: boolean; err: string | null;
  currencyOpts: string[];
  accounts: Account[];
  groups: SupplierGroup[];
}) {
  // Payables control accounts: liability type only (mirrors the web AP picker).
  const apAccounts = accounts.filter((a) => a.type === "liability" && a.isActive);
  return (
    <div style={F.formCard}>
      <div style={F.formTitle}>{mode === "new" ? "مورد جديد" : "تعديل بيانات المورد"}</div>

      <div style={F.section}>المعلومات الأساسية</div>
      <div style={F.grid}>
        <Field label="الكود">
          <input value={data.code ?? ""} onChange={(e) => setField("code", e.target.value || null)} style={F.bigInput} placeholder="كود المورد" />
        </Field>
        <Field label="الاسم بالعربي *">
          <input autoFocus value={data.nameAr} onChange={(e) => setField("nameAr", e.target.value)} style={F.bigInput} placeholder="اسم المورد" />
        </Field>
        <Field label="الاسم بالإنجليزي">
          <input value={data.nameEn ?? ""} onChange={(e) => setField("nameEn", e.target.value || null)} style={F.bigInput} placeholder="Supplier name" />
        </Field>
        <Field label="رقم الهاتف">
          <input value={data.phone ?? ""} onChange={(e) => setField("phone", e.target.value || null)} style={F.bigInput} placeholder="هاتف" />
        </Field>
        <Field label="البريد الإلكتروني">
          <input value={data.email ?? ""} onChange={(e) => setField("email", e.target.value || null)} style={F.bigInput} placeholder="email@example.com" />
        </Field>
        <Field label="الرقم الضريبي">
          <input value={data.vatNumber ?? ""} onChange={(e) => setField("vatNumber", e.target.value || null)} style={{ ...F.bigInput, fontFamily: "ui-monospace, monospace" }} placeholder="الرقم الضريبي" />
        </Field>
        <Field label="السجل التجاري">
          <input value={data.crNumber ?? ""} onChange={(e) => setField("crNumber", e.target.value || null)} style={{ ...F.bigInput, fontFamily: "ui-monospace, monospace" }} placeholder="رقم السجل التجاري" />
        </Field>
        <Field label="العملة">
          <select value={data.currencyCode ?? "SAR"} onChange={(e) => setField("currencyCode", e.target.value)} style={F.bigInput}>
            {currencyOpts.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="مجموعة الموردين">
          <SearchCombobox
            value={data.groupId ?? ""}
            onChange={(v) => setField("groupId", v === "" ? null : Number(v))}
            options={[{ value: "", label: "— بدون —" }, ...groups.map((g) => ({ value: g.id, label: g.nameAr }))]}
            placeholder="— بدون —"
          />
        </Field>
      </div>

      <div style={F.section}>العنوان الوطني</div>
      <div style={F.grid}>
        <Field label="المدينة">
          <input value={data.city ?? ""} onChange={(e) => setField("city", e.target.value || null)} style={F.bigInput} placeholder="المدينة" />
        </Field>
        <Field label="الحي">
          <input value={data.district ?? ""} onChange={(e) => setField("district", e.target.value || null)} style={F.bigInput} placeholder="الحي" />
        </Field>
        <Field label="الشارع">
          <input value={data.street ?? ""} onChange={(e) => setField("street", e.target.value || null)} style={F.bigInput} placeholder="الشارع" />
        </Field>
        <Field label="رقم المبنى">
          <input value={data.buildingNumber ?? ""} onChange={(e) => setField("buildingNumber", e.target.value || null)} style={F.bigInput} placeholder="رقم المبنى" />
        </Field>
        <Field label="الرمز البريدي">
          <input value={data.postalCode ?? ""} onChange={(e) => setField("postalCode", e.target.value || null)} style={F.bigInput} placeholder="الرمز البريدي" />
        </Field>
        <Field label="الدولة">
          <input value={data.country ?? ""} onChange={(e) => setField("country", e.target.value || null)} style={F.bigInput} placeholder="SA" />
        </Field>
        <Field label="العنوان الوطني المختصر">
          <input value={data.nationalAddressShort ?? ""} onChange={(e) => setField("nationalAddressShort", e.target.value || null)} style={{ ...F.bigInput, fontFamily: "ui-monospace, monospace" }} placeholder="مثال: RIYD2929" />
        </Field>
      </div>

      <div style={F.section}>الإعدادات المحاسبية</div>
      <div style={F.grid}>
        <Field label="حساب الذمم الدائنة (المورد)">
          <select value={data.apAccountId ?? 0} onChange={(e) => setField("apAccountId", Number(e.target.value) || null)} style={F.bigInput}>
            <option value={0}>الافتراضي (الدائنون 2100)</option>
            {apAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.nameAr}</option>)}
          </select>
        </Field>
        <Field label="إظهار في كشوف الحسابات">
          <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "13px 0", fontSize: 15, color: "#0f172a" }}>
            <input type="checkbox" checked={data.includeInStatements ?? true} onChange={(e) => setField("includeInStatements", e.target.checked)} style={{ width: 18, height: 18 }} />
            تضمين المورد في كشف الحساب
          </label>
        </Field>
      </div>

      <div style={F.section}>ملاحظات</div>
      <textarea value={data.notes ?? ""} onChange={(e) => setField("notes", e.target.value || null)}
        style={{ ...F.bigInput, minHeight: 70, resize: "vertical" }} placeholder="ملاحظات إضافية" />

      {mode === "new" && (
        <>
          <div style={F.section}>الرصيد الافتتاحي (عند الإضافة فقط)</div>
          <div style={F.grid}>
            <Field label="المبلغ">
              <input type="number" step="0.01" min="0" value={data.openingBalance ?? 0}
                onChange={(e) => setField("openingBalance", Number(e.target.value) || 0)}
                style={F.bigInput} placeholder="0.00" />
            </Field>
            <Field label="الطبيعة">
              <select value={data.openingNature ?? "credit"}
                onChange={(e) => setField("openingNature", e.target.value as "debit" | "credit")}
                style={F.bigInput}>
                <option value="credit">دائن (له علينا)</option>
                <option value="debit">مدين (لنا عليه)</option>
              </select>
            </Field>
          </div>
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8 }}>يُرحَّل قيد افتتاحي مقابل حقوق الملكية عند الحفظ.</div>
        </>
      )}

      {err && <div style={F.formErr}>⚠️ {err}</div>}

      <div style={F.formActions}>
        <button onClick={onSave} disabled={busy} style={F.btnSave}>{busy ? "جاري الحفظ..." : "حفظ"}</button>
        <button onClick={onCancel} disabled={busy} style={F.btnCancel}>إلغاء</button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={F.field}>
      <label style={F.label}>{label}</label>
      {children}
    </div>
  );
}

const F = {
  formCard: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 24, marginBottom: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" } as const,
  formTitle: { fontSize: 18, fontWeight: 700, color: "#0f172a", marginBottom: 8 } as const,
  section: { fontSize: 13, fontWeight: 700, color: "#2563eb", marginTop: 18, marginBottom: 10, paddingBottom: 6, borderBottom: "1px solid #eff6ff" } as const,
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 } as const,
  field: { display: "flex", flexDirection: "column" as const, gap: 6 } as const,
  label: { fontSize: 13, color: "#475569", fontWeight: 600 } as const,
  bigInput: { width: "100%", padding: "13px 14px", fontSize: 16, border: "1px solid #cbd5e1", borderRadius: 8, fontFamily: "inherit", boxSizing: "border-box" as const, background: "#fff" } as const,
  formErr: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: "12px 14px", borderRadius: 8, marginTop: 16, fontSize: 14 } as const,
  formActions: { display: "flex", gap: 12, marginTop: 22 } as const,
  btnSave: { padding: "12px 28px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 15, fontWeight: 700 } as const,
  btnCancel: { padding: "12px 28px", background: "#f1f5f9", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: 8, cursor: "pointer", fontSize: 15, fontWeight: 600 } as const,
};
