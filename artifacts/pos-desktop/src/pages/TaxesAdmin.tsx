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

const NATURE_OPTS = [
  { value: "debit", label: "مدين" },
  { value: "credit", label: "دائن" },
];

export default function TaxesAdmin() {
  const [rows, setRows] = useState<Tax[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [edit, setEdit] = useState<EditState>(null);
  const [tab, setTab] = useState<Tab>("basic");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
    { value: "", label: "— اختر حساب —" },
    ...accounts.filter((a) => a.isLeaf).map((a) => ({ value: a.id, label: `${a.code} — ${a.nameAr}` })),
  ], [accounts]);

  const currencyOptions = useMemo(() => [
    { value: "", label: "— العملة الأساسية —" },
    ...currencies.map((c) => ({ value: c.code, label: `${c.code} — ${c.nameAr}` })),
  ], [currencies]);

  const branchOptions = useMemo(() => [
    { value: "", label: "— بدون فرع —" },
    ...branches.filter((b) => b.isActive).map((b) => ({ value: b.id, label: `${b.code} — ${b.nameAr}` })),
  ], [branches]);

  function startNew() { setErr(null); setTab("basic"); setEdit({ mode: "new", data: emptyData() }); }
  function startEdit(t: Tax) { setErr(null); setTab("basic"); setEdit({ mode: "edit", id: t.id, data: fromTax(t) }); }
  function cancel() { setEdit(null); setErr(null); }
  function setField<K extends keyof EditData>(k: K, v: EditData[K]) {
    if (edit) setEdit({ ...edit, data: { ...edit.data, [k]: v } });
  }

  async function save() {
    if (!edit) return;
    const d = edit.data;
    if (!d.code.trim()) { setTab("basic"); setErr("كود الضريبة مطلوب"); return; }
    if (!d.nameAr.trim()) { setTab("basic"); setErr("اسم الضريبة مطلوب"); return; }
    const rate = Number(d.rateValue);
    if (!Number.isFinite(rate) || rate < 0) { setTab("basic"); setErr("قيمة الضريبة غير صحيحة"); return; }
    if (d.rateType === "percent" && rate > 100) { setTab("basic"); setErr("النسبة لا تتجاوز 100%"); return; }
    if (d.accountId === "") { setTab("account"); setErr("اختر حساب الضريبة من شجرة الحسابات"); return; }
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
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setBusy(false); }
  }

  async function remove(t: Tax) {
    if (!confirm(`حذف الضريبة «${t.nameAr}»؟`)) return;
    try { await deleteTax(t.id); await refresh(); } catch (e: any) { alert(e?.message ?? "فشل الحذف"); }
  }
  async function makeDefault(t: Tax) {
    try { await setDefaultTax(t.id); await refresh(); } catch (e: any) { alert(e?.message ?? "فشل"); }
  }

  function rateLabel(t: Tax): string {
    return t.rateType === "percent" ? `${fmt(t.rateValue)}%` : `${fmt(t.rateValue)} (قيمة ثابتة)`;
  }
  function accountLabel(t: Tax): string {
    if (t.accountId == null) return "—";
    const a = accountById.get(t.accountId);
    return a ? `${a.code} — ${a.nameAr}` : `#${t.accountId}`;
  }

  return (
    <Page
      title="الضرائب"
      subtitle={`${rows.length} ضريبة — أضف ضرائب متعددة (مدخلات/مخرجات)، كل ضريبة بحسابها ونسبتها. الضريبة الافتراضية تتحكم في نسبة شاشة القيود اليومية.`}
      right={<button onClick={startNew} style={btnPrimary}>+ إضافة ضريبة</button>}
    >
      <Card>
        {rows.length === 0 ? <Empty text="لا توجد ضرائب — اضغط «إضافة ضريبة» للبدء" /> : (
          <Table>
            <thead><tr>
              <Th style={{ width: 110 }}>الكود</Th>
              <Th>الاسم</Th>
              <Th style={{ width: 130 }}>النسبة/القيمة</Th>
              <Th>الحساب</Th>
              <Th style={{ width: 90 }}>افتراضية</Th>
              <Th style={{ width: 90 }}>الحالة</Th>
              <Th style={{ width: 230 }}>إجراءات</Th>
            </tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <Td mono>{t.code}</Td>
                  <Td style={{ fontWeight: 600 }}>{t.nameAr}{t.nameEn ? <span style={{ color: "#94a3b8", fontWeight: 400 }}> · {t.nameEn}</span> : null}</Td>
                  <Td num>{rateLabel(t)}</Td>
                  <Td style={{ color: "#475569", fontSize: 13 }}>{accountLabel(t)}</Td>
                  <Td>
                    {t.isDefault
                      ? <span style={{ background: "#1d4ed820", color: "#1d4ed8", padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 700 }}>★ افتراضية</span>
                      : <span style={{ color: "#cbd5e1" }}>—</span>}
                  </Td>
                  <Td>
                    <span style={{ background: (t.isActive ? "#15803d" : "#b91c1c") + "20", color: t.isActive ? "#15803d" : "#b91c1c", padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
                      {t.isActive ? "نشطة" : "متوقفة"}
                    </span>
                  </Td>
                  <Td>
                    <button onClick={() => startEdit(t)} style={btnLink}>تعديل</button>
                    {!t.isDefault && <>{" · "}<button onClick={() => makeDefault(t)} style={btnLink}>تعيين كافتراضية</button></>}
                    {" · "}
                    <button onClick={() => remove(t)} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {edit && (
        <Modal title={edit.mode === "new" ? "إضافة ضريبة" : "تعديل ضريبة"} onCancel={cancel} wide>
          <div style={{ display: "flex", gap: 6, borderBottom: "1px solid #e2e8f0", marginBottom: 16 }}>
            {([["basic", "1 · أساسي"], ["account", "2 · الحساب"], ["direction", "3 · التوجيه"]] as [Tab, string][]).map(([k, label]) => (
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
                <Field label="كود الضريبة *"><input autoFocus value={edit.data.code} onChange={(e) => setField("code", e.target.value)} style={input} placeholder="مثال: VAT15" /></Field>
                <Field label="نوع الضريبة">
                  <SearchCombobox
                    value={edit.data.rateType}
                    onChange={(v) => setField("rateType", v as TaxRateType)}
                    options={[{ value: "percent", label: "نسبة مئوية %" }, { value: "value", label: "قيمة ثابتة" }]}
                    style={input}
                  />
                </Field>
              </Row>
              <Row>
                <Field label="الاسم بالعربية *"><input value={edit.data.nameAr} onChange={(e) => setField("nameAr", e.target.value)} style={input} placeholder="ضريبة القيمة المضافة" /></Field>
                <Field label="الاسم بالإنجليزية"><input value={edit.data.nameEn} onChange={(e) => setField("nameEn", e.target.value)} style={input} placeholder="VAT (اختياري)" /></Field>
              </Row>
              <Row>
                <Field label={edit.data.rateType === "percent" ? "النسبة (%)" : "القيمة الثابتة"}>
                  <input type="number" step="0.01" min={0} value={edit.data.rateValue} onChange={(e) => setField("rateValue", e.target.value)} style={input} placeholder={edit.data.rateType === "percent" ? "15" : "0.00"} />
                </Field>
                <Field label="العملة">
                  <SearchCombobox value={edit.data.currencyCode} onChange={(v) => setField("currencyCode", String(v))} options={currencyOptions} style={input} />
                </Field>
              </Row>
              <Row>
                <Field label="الفرع">
                  <SearchCombobox value={edit.data.branchId} onChange={(v) => setField("branchId", v === "" ? "" : Number(v))} options={branchOptions} style={input} />
                </Field>
                <Field label="الحالة">
                  <SearchCombobox value={edit.data.isActive ? "1" : "0"} onChange={(v) => setField("isActive", v === "1")} options={[{ value: "1", label: "نشطة" }, { value: "0", label: "متوقفة" }]} style={input} />
                </Field>
              </Row>
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, fontSize: 14, cursor: "pointer" }}>
                <input type="checkbox" checked={edit.data.isDefault} onChange={(e) => setField("isDefault", e.target.checked)} />
                <span>اجعلها الضريبة الافتراضية للنظام (نسبتها تتحكم في شاشة القيود اليومية وتُختار تلقائياً في الفواتير)</span>
              </label>
            </div>
          )}

          {tab === "account" && (
            <div>
              <Field label="حساب الضريبة (من شجرة الحسابات) *">
                <SearchCombobox value={edit.data.accountId} onChange={(v) => setField("accountId", v === "" ? "" : Number(v))} options={accountOptions} style={input} />
              </Field>
              <div style={{ fontSize: 13, color: "#64748b", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "10px 14px", marginTop: 8 }}>
                هذا الحساب الوحيد يُستخدم لكل اتجاهات الضريبة. لفصل ضريبة المدخلات عن المخرجات، أنشئ ضريبتين منفصلتين — كل واحدة بحسابها الخاص (مثلاً ضريبة مخرجات على حساب التزام، وضريبة مدخلات على حساب أصل).
              </div>
            </div>
          )}

          {tab === "direction" && (
            <div>
              <div style={{ fontSize: 13, color: "#64748b", marginBottom: 12 }}>
                حدّد في أي أنواع الفواتير تظهر هذه الضريبة، وطبيعتها (مدين/دائن) في القيد المحاسبي لكل نوع.
              </div>
              <DirectionRow label="فواتير المبيعات" enabled={edit.data.salesEnabled} nature={edit.data.salesNature}
                onEnabled={(v) => setField("salesEnabled", v)} onNature={(v) => setField("salesNature", v)} />
              <DirectionRow label="مرتجع المبيعات" enabled={edit.data.salesReturnEnabled} nature={edit.data.salesReturnNature}
                onEnabled={(v) => setField("salesReturnEnabled", v)} onNature={(v) => setField("salesReturnNature", v)} />
              <DirectionRow label="فواتير المشتريات" enabled={edit.data.purchaseEnabled} nature={edit.data.purchaseNature}
                onEnabled={(v) => setField("purchaseEnabled", v)} onNature={(v) => setField("purchaseNature", v)} />
              <DirectionRow label="مرتجع المشتريات" enabled={edit.data.purchaseReturnEnabled} nature={edit.data.purchaseReturnNature}
                onEnabled={(v) => setField("purchaseReturnEnabled", v)} onNature={(v) => setField("purchaseReturnNature", v)} />
            </div>
          )}

          <ErrorMsg text={err} />
          <Actions>
            <button onClick={cancel} disabled={busy} style={btnSecondary}>إلغاء</button>
            <button onClick={save} disabled={busy} style={btnPrimary}>{busy ? "..." : "حفظ"}</button>
          </Actions>
        </Modal>
      )}
    </Page>
  );
}

function DirectionRow({ label, enabled, nature, onEnabled, onNature }: {
  label: string; enabled: boolean; nature: TaxNature;
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
        options={NATURE_OPTS}
        disabled={!enabled}
        style={{ ...input, opacity: enabled ? 1 : 0.5 }}
      />
    </div>
  );
}
