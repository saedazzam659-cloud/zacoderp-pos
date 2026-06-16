// إعدادات حسابات نقاط البيع — POS GL account overrides + dynamic payment
// methods. Backs the device-local register JE (post_pos_invoice_je): the
// account overrides feed the Rust `pos_acct()` resolver, and the payment
// methods drive the cashier's "طريقة الدفع" buttons + the JE treasury/AR leg.

import { useEffect, useMemo, useState } from "react";
import {
  Page, Card, Table, Th, Td, Empty, ErrorMsg, Field,
  input, btnPrimary, btnSecondary, btnLink, btnDanger, SearchCombobox,
} from "./_adminUi";
import {
  listAccounts, type Account,
  listPosPaymentMethods, createPosPaymentMethod, updatePosPaymentMethod, deletePosPaymentMethod,
  type PosPaymentMethod, type PosPaymentMethodKind, type PosPaymentMethodInput,
  getPosAccountSettings, setPosAccountSetting,
  POS_ACCT_KEYS, POS_ACCT_LABELS, POS_ACCT_FALLBACK, type PosAcctKey,
} from "../lib/accounting";

const KIND_LABELS: Record<PosPaymentMethodKind, string> = {
  cash: "نقدية", bank: "بنك / بطاقة", credit: "آجل (على الحساب)", other: "أخرى",
};
const KIND_OPTS = (["cash", "bank", "credit", "other"] as const).map((k) => ({ value: k, label: KIND_LABELS[k] }));

type EditData = { nameAr: string; kind: PosPaymentMethodKind; accountId: number | null; isActive: boolean; sortOrder: number };
const blank: EditData = { nameAr: "", kind: "cash", accountId: null, isActive: true, sortOrder: 0 };

export default function PosAccountsSettings() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [methods, setMethods] = useState<PosPaymentMethod[]>([]);
  const [acct, setAcct] = useState<Record<PosAcctKey, number | null>>(
    () => Object.fromEntries(POS_ACCT_KEYS.map((k) => [k, null])) as Record<PosAcctKey, number | null>,
  );
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [savingAcct, setSavingAcct] = useState<PosAcctKey | null>(null);

  // payment-method editor
  const [editId, setEditId] = useState<number | "new" | null>(null);
  const [data, setData] = useState<EditData>(blank);
  const [busy, setBusy] = useState(false);
  const [rowErr, setRowErr] = useState<string | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const [accs, pms, settings] = await Promise.all([
        listAccounts(), listPosPaymentMethods(), getPosAccountSettings(),
      ]);
      setAccounts(accs);
      setMethods(pms);
      setAcct(settings);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  const acctOptions = useMemo(
    () => [
      { value: 0, label: "— بدون (استخدم الافتراضي) —" },
      ...accounts
        .filter((a) => a.isLeaf && a.isActive)
        .map((a) => ({ value: a.id, label: `${a.code} — ${a.nameAr}`, hint: a.code })),
    ],
    [accounts],
  );
  const acctById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  async function saveAcct(key: PosAcctKey, accountId: number | null) {
    setSavingAcct(key); setErr(null);
    setAcct((prev) => ({ ...prev, [key]: accountId }));
    try {
      await setPosAccountSetting(key, accountId);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      await load();
    } finally { setSavingAcct(null); }
  }

  function startNew() { setEditId("new"); setData(blank); setRowErr(null); }
  function startEdit(m: PosPaymentMethod) {
    setEditId(m.id);
    setData({ nameAr: m.nameAr, kind: m.kind, accountId: m.accountId, isActive: m.isActive, sortOrder: m.sortOrder });
    setRowErr(null);
  }
  function cancelEdit() { setEditId(null); setData(blank); setRowErr(null); }

  async function saveMethod() {
    if (!data.nameAr.trim()) { setRowErr("الاسم مطلوب"); return; }
    setBusy(true); setRowErr(null);
    // credit always books to receivables (1500) — no linked account needed.
    const payload: PosPaymentMethodInput = {
      nameAr: data.nameAr.trim(),
      kind: data.kind,
      accountId: data.kind === "credit" ? null : (data.accountId || null),
      isActive: data.isActive,
      sortOrder: Number(data.sortOrder) || 0,
    };
    try {
      if (editId === "new") await createPosPaymentMethod(payload);
      else if (typeof editId === "number") await updatePosPaymentMethod(editId, payload);
      cancelEdit();
      await load();
    } catch (e: any) {
      setRowErr(e?.message ?? String(e));
    } finally { setBusy(false); }
  }

  async function removeMethod(m: PosPaymentMethod) {
    if (!confirm(`حذف طريقة الدفع "${m.nameAr}"؟`)) return;
    setErr(null);
    try { await deletePosPaymentMethod(m.id); await load(); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
  }

  const ci: React.CSSProperties = { ...input, padding: "6px 8px", fontSize: 13 };

  return (
    <Page title="إعدادات حسابات نقاط البيع" subtitle="الحسابات وطرق الدفع المستخدمة في قيد فاتورة الكاشير">
      <ErrorMsg text={err} />

      <Card style={{ marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>الحسابات المحاسبية</h3>
        <p style={{ margin: "0 0 12px", color: "#64748b", fontSize: 13 }}>
          عند ترك أي حقل "بدون" يستخدم النظام الكود الافتراضي تلقائياً. هذه الحسابات تُستخدم في قيد المبيعات والمرتجعات على الجهاز.
        </p>
        {loading ? <Empty text="جارٍ التحميل…" /> : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12, maxWidth: 560 }}>
            {POS_ACCT_KEYS.map((k) => (
              <Field key={k} label={`${POS_ACCT_LABELS[k]} (افتراضي: ${POS_ACCT_FALLBACK[k]})`}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <SearchCombobox
                    value={acct[k] ?? 0}
                    onChange={(v) => { const n = Number(v); void saveAcct(k, n > 0 ? n : null); }}
                    options={acctOptions}
                    style={ci}
                  />
                  {savingAcct === k && <span style={{ color: "#64748b", fontSize: 12 }}>…</span>}
                  {acct[k] != null && !acctById.has(acct[k]!) && (
                    <span style={{ color: "#b45309", fontSize: 12 }}>⚠️ غير موجود</span>
                  )}
                </div>
              </Field>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>طرق الدفع</h3>
            <p style={{ margin: 0, color: "#64748b", fontSize: 13 }}>
              تظهر للكاشير كأزرار للدفع. النوع "آجل" يرحّل على حساب العملاء (1500) ويزيد رصيد العميل.
            </p>
          </div>
          {editId === null && (
            <button onClick={startNew} style={btnPrimary}>+ طريقة دفع</button>
          )}
        </div>

        {loading ? <Empty text="جارٍ التحميل…" /> : (
          <Table>
            <thead>
              <tr>
                <Th>الاسم</Th><Th>النوع</Th><Th>الحساب المرتبط</Th>
                <Th>الترتيب</Th><Th>الحالة</Th><Th>إجراءات</Th>
              </tr>
            </thead>
            <tbody>
              {editId === "new" && (
                <MethodEditRow
                  data={data} setData={setData} onSave={saveMethod} onCancel={cancelEdit}
                  busy={busy} err={rowErr} acctOptions={acctOptions} ci={ci} isNew
                />
              )}
              {methods.length === 0 && editId !== "new" && (
                <tr><Td colSpan={6}><Empty text="لا توجد طرق دفع — أضف واحدة." /></Td></tr>
              )}
              {methods.map((m) =>
                editId === m.id ? (
                  <MethodEditRow
                    key={m.id} data={data} setData={setData} onSave={saveMethod} onCancel={cancelEdit}
                    busy={busy} err={rowErr} acctOptions={acctOptions} ci={ci}
                  />
                ) : (
                  <tr key={m.id}>
                    <Td>{m.nameAr}</Td>
                    <Td>{KIND_LABELS[m.kind]}</Td>
                    <Td>{m.kind === "credit" ? "حساب العملاء (1500)" : (m.accountId ? (acctById.get(m.accountId) ? `${acctById.get(m.accountId)!.code} — ${acctById.get(m.accountId)!.nameAr}` : "⚠️ غير موجود") : "الصندوق الافتراضي")}</Td>
                    <Td num>{m.sortOrder}</Td>
                    <Td>{m.isActive ? <span style={{ color: "#16a34a" }}>مفعّلة</span> : <span style={{ color: "#94a3b8" }}>موقوفة</span>}</Td>
                    <Td>
                      <button onClick={() => startEdit(m)} style={btnLink}>تعديل</button>
                      {" · "}
                      <button onClick={() => removeMethod(m)} style={btnDanger}>حذف</button>
                    </Td>
                  </tr>
                ),
              )}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}

function MethodEditRow({
  data, setData, onSave, onCancel, busy, err, acctOptions, ci, isNew,
}: {
  data: EditData; setData: React.Dispatch<React.SetStateAction<EditData>>;
  onSave: () => void; onCancel: () => void; busy: boolean; err: string | null;
  acctOptions: { value: string | number; label: string; hint?: string }[];
  ci: React.CSSProperties; isNew?: boolean;
}) {
  return (
    <>
      <tr style={{ background: isNew ? "#f0fdf4" : "#eff6ff" }}>
        <Td><input autoFocus value={data.nameAr} onChange={(e) => setData((d) => ({ ...d, nameAr: e.target.value }))} style={ci} placeholder="اسم طريقة الدفع *" /></Td>
        <Td>
          <SearchCombobox
            value={data.kind}
            onChange={(v) => setData((d) => ({ ...d, kind: v as PosPaymentMethodKind }))}
            options={KIND_OPTS}
            style={ci}
          />
        </Td>
        <Td>
          {data.kind === "credit" ? (
            <span style={{ color: "#64748b", fontSize: 12 }}>حساب العملاء (1500)</span>
          ) : (
            <SearchCombobox
              value={data.accountId ?? 0}
              onChange={(v) => { const n = Number(v); setData((d) => ({ ...d, accountId: n > 0 ? n : null })); }}
              options={acctOptions}
              style={ci}
            />
          )}
        </Td>
        <Td><input type="number" value={data.sortOrder} onChange={(e) => setData((d) => ({ ...d, sortOrder: Number(e.target.value) || 0 }))} style={{ ...ci, width: 70 }} /></Td>
        <Td>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" checked={data.isActive} onChange={(e) => setData((d) => ({ ...d, isActive: e.target.checked }))} />
            مفعّلة
          </label>
        </Td>
        <Td>
          <button onClick={onSave} disabled={busy} style={{ ...btnPrimary, padding: "4px 10px", fontSize: 12 }}>{busy ? "..." : "حفظ"}</button>
          {" "}
          <button onClick={onCancel} disabled={busy} style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12 }}>إلغاء</button>
        </Td>
      </tr>
      {err && <tr><Td colSpan={6} style={{ background: "#fef2f2", color: "#991b1b", fontSize: 13 }}>⚠️ {err}</Td></tr>}
    </>
  );
}
