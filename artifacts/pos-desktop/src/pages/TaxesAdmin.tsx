import { useEffect, useMemo, useState } from "react";
import {
  listTaxes, createTax, updateTax, deleteTax, setDefaultTax,
  type Tax, type TaxInput, type TaxRateType, type TaxNature,
} from "../lib/taxes";
import { listAccounts, listCurrencies, type Account, type Currency } from "../lib/accounting";
import { listBranches, type Branch } from "../lib/branches";
import {
  Page, Card, Table, Th, Td, Empty, Modal, Field, Row, ErrorMsg, Actions,
  SearchCombobox, input, btnPrimary, btnSecondary, btnLink, fmt,
} from "./_adminUi";
import { uiText, useUiLanguage } from "../lib/appSettings";

type Tab = "basic" | "account" | "direction";

type EditData = {
  code: string; nameAr: string; nameEn: string;
  currencyCode: string; branchId: number | "";
  rateType: TaxRateType; rateValue: string;
  accountId: number | "";
  salesEnabled: boolean; salesNature: TaxNature;
  salesReturnEnabled: boolean; salesReturnNature: TaxNature;
  purchaseEnabled: boolean; purchaseNature: TaxNature;
  purchaseReturnEnabled: boolean; purchaseReturnNature: TaxNature;
  isDefault: boolean; isActive: boolean;
};

type EditState =
  | { mode: "new"; data: EditData }
  | { mode: "edit"; id: number; data: EditData }
  | null;

const emptyData = (): EditData => ({
  code: "", nameAr: "", nameEn: "",
  currencyCode: "", branchId: "",
  rateType: "percent", rateValue: "",
  accountId: "",
  salesEnabled: true, salesNature: "credit",
  salesReturnEnabled: true, salesReturnNature: "debit",
  purchaseEnabled: true, purchaseNature: "debit",
  purchaseReturnEnabled: true, purchaseReturnNature: "credit",
  isDefault: false, isActive: true,
});

const fromTax = (t: Tax): EditData => ({
  code: t.code, nameAr: t.nameAr, nameEn: t.nameEn ?? "",
  currencyCode: t.currencyCode ?? "", branchId: t.branchId ?? "",
  rateType: t.rateType, rateValue: String(t.rateValue),
  accountId: t.accountId ?? "",
  salesEnabled: t.salesEnabled, salesNature: t.salesNature,
  salesReturnEnabled: t.salesReturnEnabled, salesReturnNature: t.salesReturnNature,
  purchaseEnabled: t.purchaseEnabled, purchaseNature: t.purchaseNature,
  purchaseReturnEnabled: t.purchaseReturnEnabled, purchaseReturnNature: t.purchaseReturnNature,
  isDefault: t.isDefault, isActive: t.isActive,
});

export default function TaxesAdmin() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [rows, setRows] = useState<Tax[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [edit, setEdit] = useState<EditState>(null);
  const [tab, setTab] = useState<Tab>("basic");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const natureOptions = [
    { value: "debit", label: text("مدين", "Debit") },
    { value: "credit", label: text("دائن", "Credit") },
  ];

  async function refresh() { setRows(await listTaxes()); }
  useEffect(() => {
    void (async () => {
      const [t, a, c, b] = await Promise.all([
        listTaxes(), listAccounts(), listCurrencies(true), listBranches(),
      ]);
      setRows(t); setAccounts(a); setCurrencies(c); setBranches(b);
    })();
  }, []);

  const accountById = useMemo(() => {
    const m = new Map<number, Account>();
    for (const a of accounts) m.set(a.id, a);
    return m;
  }, [accounts]);

  const accountOptions = useMemo(() => [
    { value: "", label: text("— اختر حساب —", "— Select account —") },
    ...accounts.filter((a) => a.isLeaf).map((a) => ({ value: a.id, label: `${a.code} — ${a.nameAr}` })),
  ], [accounts, language]);

  const currencyOptions = useMemo(() => [
    { value: "", label: text("— العملة الأساسية —", "— Base currency —") },
    ...currencies.map((c) => ({ value: c.code, label: `${c.code} — ${language === "en" ? c.nameEn || c.code : c.nameAr}` })),
  ], [currencies, language]);

  const branchOptions = useMemo(() => [
    { value: "", label: text("— بدون فرع —", "— No branch —") },
    ...branches.filter((b) => b.isActive).map((b) => ({ value: b.id, label: `${b.code} — ${b.nameAr}` })),
  ], [branches, language]);

  function startNew() { setErr(null); setTab("basic"); setEdit({ mode: "new", data: emptyData() }); }
  function startEdit(t: Tax) { setErr(null); setTab("basic"); setEdit({ mode: "edit", id: t.id, data: fromTax(t) }); }
  function cancel() { setEdit(null); setErr(null); }
  function setField<K extends keyof EditData>(k: K, v: EditData[K]) {
    if (edit) setEdit({ ...edit, data: { ...edit.data, [k]: v } });
  }

  async function save() {
    if (!edit) return;
    const d = edit.data;
    if (!d.code.trim()) { setTab("basic"); setErr(text("كود الضريبة مطلوب", "Tax code is required.")); return; }
    if (!d.nameAr.trim()) { setTab("basic"); setErr(text("اسم الضريبة مطلوب", "Tax name in Arabic is required.")); return; }
    const rate = Number(d.rateValue);
    if (!Number.isFinite(rate) || rate < 0) { setTab("basic"); setErr(text("قيمة الضريبة غير صحيحة", "Enter a valid tax amount.")); return; }
    if (d.rateType === "percent" && rate > 100) { setTab("basic"); setErr(text("النسبة لا تتجاوز 100%", "The percentage cannot exceed 100%.")); return; }
    if (d.accountId === "") { setTab("account"); setErr(text("اختر حساب الضريبة من شجرة الحسابات", "Select the tax account from the chart of accounts.")); return; }
    setBusy(true); setErr(null);
    try {
      const payload: TaxInput = {
        code: d.code.trim(), nameAr: d.nameAr.trim(), nameEn: d.nameEn.trim() || null,
        currencyCode: d.currencyCode || null,
        branchId: d.branchId === "" ? null : d.branchId,
        rateType: d.rateType, rateValue: rate,
        accountId: d.accountId,
        salesEnabled: d.salesEnabled, salesNature: d.salesNature,
        salesReturnEnabled: d.salesReturnEnabled, salesReturnNature: d.salesReturnNature,
        purchaseEnabled: d.purchaseEnabled, purchaseNature: d.purchaseNature,
        purchaseReturnEnabled: d.purchaseReturnEnabled, purchaseReturnNature: d.purchaseReturnNature,
        isDefault: d.isDefault, isActive: d.isActive,
      };
      if (edit.mode === "new") await createTax(payload);
      else await updateTax(edit.id, payload);
      setEdit(null); await refresh();
    } catch (e: any) { setErr(e?.message ?? text("فشل الحفظ", "Could not save tax.")); }
    finally { setBusy(false); }
  }

  async function remove(t: Tax) {
    const taxName = language === "en" ? t.nameEn || t.nameAr : t.nameAr;
    if (!confirm(text(`حذف الضريبة «${taxName}»؟`, `Delete tax “${taxName}”?`))) return;
    try { await deleteTax(t.id); await refresh(); } catch (e: any) { alert(e?.message ?? text("فشل الحذف", "Could not delete tax.")); }
  }
  async function makeDefault(t: Tax) {
    try { await setDefaultTax(t.id); await refresh(); } catch (e: any) { alert(e?.message ?? text("فشل", "Could not set default tax.")); }
  }

  const rateLabel = (t: Tax): string =>
    t.rateType === "percent" ? `${fmt(t.rateValue)}%` : `${fmt(t.rateValue)} (${text("قيمة ثابتة", "fixed amount")})`;
  function accountLabel(t: Tax): string {
    if (t.accountId == null) return "—";
    const a = accountById.get(t.accountId);
    return a ? `${a.code} — ${a.nameAr}` : `#${t.accountId}`;
  }

  return (
    <Page
      title={text("الضرائب", "Taxes")}
      subtitle={text(`${rows.length} ضريبة — أضف ضرائب متعددة (مدخلات/مخرجات)، كل ضريبة بحسابها ونسبتها. الضريبة الافتراضية تتحكم في نسبة شاشة القيود اليومية.`, `${rows.length} taxes — configure input and output taxes with their own accounts and rates. The default tax sets the rate used on journal entries.`)}
      right={<button onClick={startNew} style={btnPrimary}>+ {text("إضافة ضريبة", "Add tax")}</button>}
    >
      <Card>
        {rows.length === 0 ? <Empty text={text("لا توجد ضرائب — اضغط «إضافة ضريبة» للبدء", "No taxes yet — select “Add tax” to get started.")} /> : (
          <Table>
            <thead><tr>
              <Th style={{ width: 110 }}>{text("الكود", "Code")}</Th>
              <Th>{text("الاسم", "Name")}</Th>
              <Th style={{ width: 130 }}>{text("النسبة/القيمة", "Rate / amount")}</Th>
              <Th>{text("الحساب", "Account")}</Th>
              <Th style={{ width: 90 }}>{text("افتراضية", "Default")}</Th>
              <Th style={{ width: 90 }}>{text("الحالة", "Status")}</Th>
              <Th style={{ width: 230 }}>{text("إجراءات", "Actions")}</Th>
            </tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <Td mono>{t.code}</Td>
                  <Td style={{ fontWeight: 600 }}>{language === "en" ? t.nameEn || t.nameAr : t.nameAr}{(language === "en" ? t.nameEn && t.nameAr : t.nameEn) ? <span style={{ color: "#94a3b8", fontWeight: 400 }}> · {language === "en" ? t.nameAr : t.nameEn}</span> : null}</Td>
                  <Td num>{rateLabel(t)}</Td>
                  <Td style={{ color: "#475569", fontSize: 13 }}>{accountLabel(t)}</Td>
                  <Td>
                    {t.isDefault
                      ? <span style={{ background: "#1d4ed820", color: "#1d4ed8", padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 700 }}>★ {text("افتراضية", "Default")}</span>
                      : <span style={{ color: "#cbd5e1" }}>—</span>}
                  </Td>
                  <Td>
                    <span style={{ background: (t.isActive ? "#15803d" : "#b91c1c") + "20", color: t.isActive ? "#15803d" : "#b91c1c", padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
                      {t.isActive ? text("نشطة", "Active") : text("متوقفة", "Inactive")}
                    </span>
                  </Td>
                  <Td>
                    <button onClick={() => startEdit(t)} style={btnLink}>{text("تعديل", "Edit")}</button>
                    {!t.isDefault && <>{" · "}<button onClick={() => makeDefault(t)} style={btnLink}>{text("تعيين كافتراضية", "Set as default")}</button></>}
                    {" · "}
                    <button onClick={() => remove(t)} style={{ ...btnLink, color: "#dc2626" }}>{text("حذف", "Delete")}</button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {edit && (
        <Modal title={edit.mode === "new" ? text("إضافة ضريبة", "Add tax") : text("تعديل ضريبة", "Edit tax")} onCancel={cancel} wide>
          <div style={{ display: "flex", gap: 6, borderBottom: "1px solid #e2e8f0", marginBottom: 16 }}>
            {([["basic", text("1 · أساسي", "1 · Basics")], ["account", text("2 · الحساب", "2 · Account")], ["direction", text("3 · التوجيه", "3 · Directions")]] as [Tab, string][]).map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)}
                style={{
                  padding: "8px 16px", border: "none", background: "none", cursor: "pointer",
                  fontFamily: "inherit", fontSize: 14, fontWeight: tab === k ? 700 : 500,
                  color: tab === k ? "#2563eb" : "#64748b",
                  borderBottom: tab === k ? "2px solid #2563eb" : "2px solid transparent",
                }}>{label}</button>
            ))}
          </div>

          {tab === "basic" && (
            <div>
              <Row>
                <Field label={text("كود الضريبة *", "Tax code *")}><input autoFocus value={edit.data.code} onChange={(e) => setField("code", e.target.value)} style={input} placeholder="VAT15" /></Field>
                <Field label={text("نوع الضريبة", "Tax type")}>
                  <SearchCombobox
                    value={edit.data.rateType}
                    onChange={(v) => setField("rateType", v as TaxRateType)}
                    options={[{ value: "percent", label: text("نسبة مئوية %", "Percentage %") }, { value: "value", label: text("قيمة ثابتة", "Fixed amount") }]}
                    style={input}
                  />
                </Field>
              </Row>
              <Row>
                <Field label={text("الاسم بالعربية *", "Arabic name *")}><input value={edit.data.nameAr} onChange={(e) => setField("nameAr", e.target.value)} style={input} placeholder={text("ضريبة القيمة المضافة", "Arabic tax name")} /></Field>
                <Field label={text("الاسم بالإنجليزية", "English name")}><input value={edit.data.nameEn} onChange={(e) => setField("nameEn", e.target.value)} style={input} placeholder={text("VAT (اختياري)", "VAT (optional)")} /></Field>
              </Row>
              <Row>
                <Field label={edit.data.rateType === "percent" ? text("النسبة (%)", "Rate (%)") : text("القيمة الثابتة", "Fixed amount")}>
                  <input type="number" step="0.01" min={0} value={edit.data.rateValue} onChange={(e) => setField("rateValue", e.target.value)} style={input} placeholder={edit.data.rateType === "percent" ? "15" : "0.00"} />
                </Field>
                <Field label={text("العملة", "Currency")}>
                  <SearchCombobox value={edit.data.currencyCode} onChange={(v) => setField("currencyCode", String(v))} options={currencyOptions} style={input} />
                </Field>
              </Row>
              <Row>
                <Field label={text("الفرع", "Branch")}>
                  <SearchCombobox value={edit.data.branchId} onChange={(v) => setField("branchId", v === "" ? "" : Number(v))} options={branchOptions} style={input} />
                </Field>
                <Field label={text("الحالة", "Status")}>
                  <SearchCombobox value={edit.data.isActive ? "1" : "0"} onChange={(v) => setField("isActive", v === "1")} options={[{ value: "1", label: text("نشطة", "Active") }, { value: "0", label: text("متوقفة", "Inactive") }]} style={input} />
                </Field>
              </Row>
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, fontSize: 14, cursor: "pointer" }}>
                <input type="checkbox" checked={edit.data.isDefault} onChange={(e) => setField("isDefault", e.target.checked)} />
                <span>{text("اجعلها الضريبة الافتراضية للنظام (نسبتها تتحكم في شاشة القيود اليومية وتُختار تلقائياً في الفواتير)", "Set as the system default tax. Its rate is used on journal entries and selected automatically on invoices.")}</span>
              </label>
            </div>
          )}

          {tab === "account" && (
            <div>
              <Field label={text("حساب الضريبة (من شجرة الحسابات) *", "Tax account (from chart of accounts) *")}>
                <SearchCombobox value={edit.data.accountId} onChange={(v) => setField("accountId", v === "" ? "" : Number(v))} options={accountOptions} style={input} />
              </Field>
              <div style={{ fontSize: 13, color: "#64748b", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "10px 14px", marginTop: 8 }}>
                {text("هذا الحساب الوحيد يُستخدم لكل اتجاهات الضريبة. لفصل ضريبة المدخلات عن المخرجات، أنشئ ضريبتين منفصلتين — كل واحدة بحسابها الخاص (مثلاً ضريبة مخرجات على حساب التزام، وضريبة مدخلات على حساب أصل).", "This account is used for all tax directions. To separate input and output tax, create two taxes and assign separate accounts—for example, an output-tax liability account and an input-tax asset account.")}
              </div>
            </div>
          )}

          {tab === "direction" && (
            <div>
              <div style={{ fontSize: 13, color: "#64748b", marginBottom: 12 }}>
                {text("حدّد في أي أنواع الفواتير تظهر هذه الضريبة، وطبيعتها (مدين/دائن) في القيد المحاسبي لكل نوع.", "Choose which invoice types use this tax and whether each posting is a debit or credit.")}
              </div>
              <DirectionRow label={text("فواتير المبيعات", "Sales invoices")} natureOptions={natureOptions} enabled={edit.data.salesEnabled} nature={edit.data.salesNature}
                onEnabled={(v) => setField("salesEnabled", v)} onNature={(v) => setField("salesNature", v)} />
              <DirectionRow label={text("مرتجع المبيعات", "Sales returns")} natureOptions={natureOptions} enabled={edit.data.salesReturnEnabled} nature={edit.data.salesReturnNature}
                onEnabled={(v) => setField("salesReturnEnabled", v)} onNature={(v) => setField("salesReturnNature", v)} />
              <DirectionRow label={text("فواتير المشتريات", "Purchase invoices")} natureOptions={natureOptions} enabled={edit.data.purchaseEnabled} nature={edit.data.purchaseNature}
                onEnabled={(v) => setField("purchaseEnabled", v)} onNature={(v) => setField("purchaseNature", v)} />
              <DirectionRow label={text("مرتجع المشتريات", "Purchase returns")} natureOptions={natureOptions} enabled={edit.data.purchaseReturnEnabled} nature={edit.data.purchaseReturnNature}
                onEnabled={(v) => setField("purchaseReturnEnabled", v)} onNature={(v) => setField("purchaseReturnNature", v)} />
            </div>
          )}

          <ErrorMsg text={err} />
          <Actions>
            <button onClick={cancel} disabled={busy} style={btnSecondary}>{text("إلغاء", "Cancel")}</button>
            <button onClick={save} disabled={busy} style={btnPrimary}>{busy ? "..." : text("حفظ", "Save")}</button>
          </Actions>
        </Modal>
      )}
    </Page>
  );
}

function DirectionRow({ label, enabled, nature, natureOptions, onEnabled, onNature }: {
  label: string; enabled: boolean; nature: TaxNature; natureOptions: { value: string; label: string }[];
  onEnabled: (v: boolean) => void; onNature: (v: TaxNature) => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: 12, alignItems: "center", padding: "10px 0", borderBottom: "1px solid #f1f5f9" }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
        <input type="checkbox" checked={enabled} onChange={(e) => onEnabled(e.target.checked)} />
        <span>{label}</span>
      </label>
      <SearchCombobox
        value={nature}
        onChange={(v) => onNature(v as TaxNature)}
        options={natureOptions}
        disabled={!enabled}
        style={{ ...input, opacity: enabled ? 1 : 0.5 }}
      />
    </div>
  );
}
