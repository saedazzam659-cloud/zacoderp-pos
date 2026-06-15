import { useEffect, useState } from "react";
import {
  listLettersOfCredit, getLetterOfCredit, createLetterOfCredit, updateLetterOfCredit,
  deleteLetterOfCredit, closeLetterOfCredit, reopenLetterOfCredit, recomputeLcUsage, postLcFunding,
  listLcExpenses, createLcExpense, updateLcExpense, deleteLcExpense,
  listSuppliers, listAccounts, listCashBoxes, listBanks, listCurrencies,
  type LetterOfCredit, type LetterOfCreditInput, type LcExpense, type LcExpenseInput,
  type Supplier, type Account, type CashBox, type Bank, type Currency,
} from "../lib/accounting";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty, Modal,
  input, btnPrimary, btnSecondary, btnLink, btnDanger, fmt, todayStr, SearchCombobox,
} from "./_adminUi";
import { useDimensions, branchPickerOptions, costCenterPickerOptions } from "./_reportFilters";

type Deps = {
  suppliers: Supplier[]; accounts: Account[];
  cashBoxes: CashBox[]; banks: Bank[]; currencies: Currency[];
};

const STATUS_LABEL: Record<string, { label: string; bg: string; fg: string }> = {
  open: { label: "مفتوح", bg: "#dbeafe", fg: "#1e40af" },
  partial: { label: "مستخدم جزئياً", bg: "#fef9c3", fg: "#854d0e" },
  closed: { label: "مقفل", bg: "#f1f5f9", fg: "#64748b" },
};

export default function LettersOfCreditAdmin() {
  const [rows, setRows] = useState<LetterOfCredit[]>([]);
  const [deps, setDeps] = useState<Deps | null>(null);
  const [editing, setEditing] = useState<null | { mode: "new" } | { mode: "edit"; row: LetterOfCredit }>(null);
  const [detailId, setDetailId] = useState<number | null>(null);

  async function refresh() { setRows(await listLettersOfCredit()); }
  useEffect(() => {
    void refresh();
    void (async () => {
      const [suppliers, accounts, cashBoxes, banks, currencies] = await Promise.all([
        listSuppliers(), listAccounts(), listCashBoxes(), listBanks(), listCurrencies(true),
      ]);
      setDeps({ suppliers, accounts, cashBoxes, banks, currencies });
    })();
  }, []);

  async function remove(r: LetterOfCredit) {
    if (!confirm(`حذف الاعتماد ${r.lcNumber}؟`)) return;
    try { await deleteLetterOfCredit(r.id); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل الحذف"); }
  }

  if (detailId != null && deps) {
    return (
      <LcDetail
        lcId={detailId}
        deps={deps}
        onBack={() => { setDetailId(null); void refresh(); }}
      />
    );
  }

  return (
    <Page
      title="الاعتمادات المستندية"
      subtitle="تسهيلات بنكية للشراء — يخصم منها قيمة البضاعة عند ربط فاتورة شراء بالاعتماد"
      right={
        <button onClick={() => setEditing({ mode: "new" })} disabled={!deps || !!editing}
          style={{ ...btnPrimary, opacity: (!deps || editing) ? 0.5 : 1, cursor: (!deps || editing) ? "not-allowed" : "pointer" }}>
          + اعتماد جديد
        </button>
      }
    >
      {editing && deps && (
        <Card style={{ marginBottom: 12, border: "2px solid #2563eb" }}>
          <div style={{ padding: 16 }}>
            <LcForm
              deps={deps}
              existing={editing.mode === "edit" ? editing.row : null}
              onCancel={() => setEditing(null)}
              onDone={() => { setEditing(null); void refresh(); }}
            />
          </div>
        </Card>
      )}

      <Card>
        {rows.length === 0 ? <Empty text="لا توجد اعتمادات مستندية" /> : (
          <Table>
            <thead><tr>
              <Th>الرقم</Th><Th>التاريخ</Th><Th>المورد</Th><Th>البنك</Th>
              <Th style={{ textAlign: "left" }}>القيمة</Th>
              <Th style={{ textAlign: "left" }}>المستخدم</Th>
              <Th style={{ textAlign: "left" }}>المتاح</Th>
              <Th style={{ width: 110 }}>الحالة</Th>
              <Th style={{ width: 220 }}>إجراءات</Th>
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const st = STATUS_LABEL[r.status] ?? STATUS_LABEL.open;
                const totalBase = r.totalAmount * r.exchangeRate;
                const available = Math.max(0, totalBase - r.usedAmount);
                return (
                  <tr key={r.id} style={{ opacity: editing ? 0.5 : 1 }}>
                    <Td mono>{r.lcNumber}</Td>
                    <Td>{r.lcDate}</Td>
                    <Td>{r.supplierName ?? "—"}</Td>
                    <Td>{r.bankName ?? "—"}</Td>
                    <Td num>{fmt(r.totalAmount)} {r.currencyCode}</Td>
                    <Td num style={{ color: "#854d0e" }}>{fmt(r.usedAmount)}</Td>
                    <Td num style={{ color: "#15803d", fontWeight: 600 }}>{fmt(available)}</Td>
                    <Td><span style={{ background: st.bg, color: st.fg, padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{st.label}</span></Td>
                    <Td>
                      <button onClick={() => setDetailId(r.id)} disabled={!!editing} style={btnLink}>تفاصيل</button>
                      {" · "}
                      <button onClick={() => setEditing({ mode: "edit", row: r })} disabled={!!editing || r.status === "closed"} style={btnLink}>تعديل</button>
                      {" · "}
                      <button onClick={() => remove(r)} disabled={!!editing} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}

function LcForm({ deps, existing, onCancel, onDone }: {
  deps: Deps; existing: LetterOfCredit | null;
  onCancel: () => void; onDone: () => void;
}) {
  const { branches, costCenters } = useDimensions();
  const [lcNumber, setLcNumber] = useState(existing?.lcNumber ?? "");
  const [lcDate, setLcDate] = useState(existing?.lcDate ?? todayStr());
  const [supplierId, setSupplierId] = useState<number | null>(existing?.supplierId ?? null);
  const [bankName, setBankName] = useState(existing?.bankName ?? "");
  const [currencyCode, setCurrencyCode] = useState(existing?.currencyCode ?? "SAR");
  const [exchangeRate, setExchangeRate] = useState<number>(existing?.exchangeRate ?? 1);
  const [totalAmount, setTotalAmount] = useState<number>(existing?.totalAmount ?? 0);
  const [settlementAccountId, setSettlementAccountId] = useState<number | null>(existing?.settlementAccountId ?? null);
  const [branchId, setBranchId] = useState<number | "">(existing?.branchId ?? "");
  const [costCenterId, setCostCenterId] = useState<number | "">(existing?.costCenterId ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const currencyOpts = deps.currencies.length > 0 ? deps.currencies.map((c) => c.code) : ["SAR"];
  const liabilityAccounts = deps.accounts.filter((a) => a.isLeaf && (a.type === "liability" || a.type === "asset"));

  async function save() {
    setBusy(true); setErr(null);
    try {
      if (!supplierId) throw new Error("اختر المورد");
      if (totalAmount < 0) throw new Error("قيمة الاعتماد غير صالحة");
      const payload: LetterOfCreditInput = {
        lcNumber: lcNumber.trim() || null, lcDate, supplierId,
        bankName: bankName.trim() || null,
        currencyCode, exchangeRate: exchangeRate > 0 ? exchangeRate : 1,
        totalAmount, settlementAccountId: settlementAccountId || null,
        notes: notes.trim() || null,
        branchId: branchId === "" ? null : branchId,
        costCenterId: costCenterId === "" ? null : costCenterId,
      };
      if (existing) await updateLetterOfCredit(existing.id, payload);
      else await createLetterOfCredit(payload);
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>{existing ? `تعديل الاعتماد ${existing.lcNumber}` : "اعتماد مستندي جديد"}</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        <Field label="رقم الاعتماد">
          <input value={lcNumber} onChange={(e) => setLcNumber(e.target.value)} disabled={!!existing} style={input} placeholder="يُولَّد تلقائياً إن تُرك فارغاً" />
        </Field>
        <Field label="التاريخ"><input type="date" value={lcDate} onChange={(e) => setLcDate(e.target.value)} style={input} /></Field>
        <Field label="البنك"><input value={bankName} onChange={(e) => setBankName(e.target.value)} style={input} placeholder="اسم البنك" /></Field>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="المورد">
          <SearchCombobox value={supplierId ?? ""} onChange={(v) => setSupplierId(Number(v) || null)} style={input}
            options={[{ value: "", label: "— اختر —" }, ...deps.suppliers.map((s) => ({ value: s.id, label: s.nameAr }))]} />
        </Field>
        <Field label="حساب التسوية (المقاصة)">
          <SearchCombobox value={settlementAccountId ?? ""} onChange={(v) => setSettlementAccountId(Number(v) || null)} style={input}
            options={[{ value: "", label: "— اختر —" }, ...liabilityAccounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.nameAr}` }))]} />
        </Field>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        <Field label="العملة">
          <select value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)} style={input}>
            {currencyOpts.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="سعر الصرف">
          <input type="number" step="0.0001" min={0} value={exchangeRate || ""} onChange={(e) => setExchangeRate(Number(e.target.value) || 1)} style={input} disabled={currencyCode === "SAR"} />
        </Field>
        <Field label="قيمة الاعتماد"><input type="number" step="0.01" min={0} value={totalAmount || ""} onChange={(e) => setTotalAmount(Number(e.target.value) || 0)} style={input} /></Field>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="الفرع">
          <SearchCombobox value={branchId} onChange={(v) => setBranchId(v === "" ? "" : Number(v))} options={branchPickerOptions(branches)} style={input} />
        </Field>
        <Field label="مركز التكلفة">
          <SearchCombobox value={costCenterId} onChange={(v) => setCostCenterId(v === "" ? "" : Number(v))} options={costCenterPickerOptions(costCenters)} style={input} />
        </Field>
      </div>
      <Field label="ملاحظات"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...input, minHeight: 50 }} /></Field>
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} type="button" style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy} type="button" style={btnPrimary}>{busy ? "..." : "حفظ"}</button>
      </Actions>
    </div>
  );
}

function LcDetail({ lcId, deps, onBack }: { lcId: number; deps: Deps; onBack: () => void }) {
  const [lc, setLc] = useState<LetterOfCredit | null>(null);
  const [tab, setTab] = useState<"info" | "expenses">("info");
  const [expenses, setExpenses] = useState<LcExpense[]>([]);
  const [funding, setFunding] = useState(false);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [l, ex] = await Promise.all([getLetterOfCredit(lcId), listLcExpenses(lcId)]);
    setLc(l); setExpenses(ex);
  }
  useEffect(() => { void refresh(); }, [lcId]);

  async function doClose() {
    if (!confirm("إقفال الاعتماد؟ لن يمكن ربطه بفواتير جديدة.")) return;
    setBusy(true);
    try { await closeLetterOfCredit(lcId); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل الإقفال"); }
    finally { setBusy(false); }
  }
  async function doReopen() {
    setBusy(true);
    try { await reopenLetterOfCredit(lcId); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل إعادة الفتح"); }
    finally { setBusy(false); }
  }
  async function doRecompute() {
    setBusy(true);
    try { await recomputeLcUsage(lcId); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل إعادة الحساب"); }
    finally { setBusy(false); }
  }

  if (!lc) return <Page title="الاعتماد المستندي"><Empty text="جارٍ التحميل..." /></Page>;

  const st = STATUS_LABEL[lc.status] ?? STATUS_LABEL.open;
  const totalBase = lc.totalAmount * lc.exchangeRate;
  const available = Math.max(0, totalBase - lc.usedAmount);
  const tabBtn = (key: "info" | "expenses", label: string) => (
    <button onClick={() => setTab(key)} style={{
      ...btnSecondary, borderBottom: tab === key ? "2px solid #2563eb" : "2px solid transparent",
      background: tab === key ? "#eff6ff" : "#fff", fontWeight: tab === key ? 700 : 400,
    }}>{label}</button>
  );

  return (
    <Page
      title={`اعتماد ${lc.lcNumber}`}
      subtitle={`${lc.supplierName ?? ""} — ${lc.bankName ?? "—"}`}
      right={
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onBack} style={btnSecondary}>← رجوع</button>
          {lc.status !== "closed"
            ? <button onClick={() => setFunding(true)} disabled={busy} style={{ ...btnPrimary, background: "#15803d" }}>تمويل الاعتماد</button>
            : null}
          {lc.status !== "closed"
            ? <button onClick={doClose} disabled={busy} style={btnDanger}>إقفال</button>
            : <button onClick={doReopen} disabled={busy} style={btnSecondary}>إعادة فتح</button>}
        </div>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 16 }}>
        <Stat label="الحالة"><span style={{ background: st.bg, color: st.fg, padding: "2px 10px", borderRadius: 999, fontSize: 13, fontWeight: 600 }}>{st.label}</span></Stat>
        <Stat label="القيمة">{fmt(lc.totalAmount)} {lc.currencyCode}</Stat>
        <Stat label="المستخدم (ر.س)"><span style={{ color: "#854d0e" }}>{fmt(lc.usedAmount)}</span></Stat>
        <Stat label="المتاح (ر.س)"><span style={{ color: "#15803d", fontWeight: 700 }}>{fmt(available)}</span></Stat>
      </div>

      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        {tabBtn("info", "البيانات")}
        {tabBtn("expenses", `المصروفات (${expenses.length})`)}
      </div>

      {tab === "info" && (
        <Card>
          <div style={{ padding: 20, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <InfoRow label="رقم الاعتماد" value={lc.lcNumber} mono />
            <InfoRow label="التاريخ" value={lc.lcDate} />
            <InfoRow label="المورد" value={lc.supplierName ?? "—"} />
            <InfoRow label="البنك" value={lc.bankName ?? "—"} />
            <InfoRow label="العملة" value={`${lc.currencyCode} (سعر الصرف ${fmt(lc.exchangeRate)})`} />
            <InfoRow label="القيمة بالعملة الأساس" value={`${fmt(totalBase)} ر.س`} />
            <InfoRow label="ملاحظات" value={lc.notes ?? "—"} />
          </div>
          <div style={{ padding: "0 20px 16px" }}>
            <button onClick={doRecompute} disabled={busy} style={btnSecondary}>إعادة حساب المستخدم من الفواتير</button>
          </div>
        </Card>
      )}

      {tab === "expenses" && (
        <LcExpensesTab lcId={lcId} expenses={expenses} accounts={deps.accounts} currencies={deps.currencies} onChange={refresh} />
      )}

      {funding && (
        <FundingDialog lcId={lcId} deps={deps} onClose={() => setFunding(false)} onDone={() => { setFunding(false); void refresh(); }} />
      )}
    </Page>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ fontSize: 12, color: "#64748b", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a", fontVariantNumeric: "tabular-nums" }}>{children}</div>
    </div>
  );
}
function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: "#64748b", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14, fontFamily: mono ? "ui-monospace, monospace" : undefined }}>{value}</div>
    </div>
  );
}

function LcExpensesTab({ lcId, expenses, accounts, currencies, onChange }: {
  lcId: number; expenses: LcExpense[]; accounts: Account[]; currencies: Currency[]; onChange: () => void;
}) {
  const [edit, setEdit] = useState<null | { mode: "new" } | { mode: "edit"; row: LcExpense }>(null);
  const total = expenses.reduce((s, e) => s + e.amount * e.exchangeRate, 0);

  async function remove(e: LcExpense) {
    if (!confirm("حذف المصروف؟")) return;
    try { await deleteLcExpense(e.id); onChange(); }
    catch (err: any) { alert(err?.message ?? "فشل الحذف"); }
  }

  return (
    <Card>
      <div style={{ padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #f1f5f9" }}>
        <div style={{ fontSize: 14 }}>إجمالي المصروفات: <strong style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(total)} ر.س</strong></div>
        <button onClick={() => setEdit({ mode: "new" })} disabled={!!edit} style={btnPrimary}>+ مصروف</button>
      </div>
      {edit && (
        <div style={{ padding: 16, background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
          <ExpenseForm
            lcId={lcId} accounts={accounts} currencies={currencies}
            existing={edit.mode === "edit" ? edit.row : null}
            onCancel={() => setEdit(null)}
            onDone={() => { setEdit(null); onChange(); }}
          />
        </div>
      )}
      {expenses.length === 0 ? <Empty text="لا توجد مصروفات" /> : (
        <Table>
          <thead><tr>
            <Th>النوع</Th><Th>الحساب</Th>
            <Th style={{ textAlign: "left" }}>المبلغ</Th>
            <Th>ملاحظات</Th><Th style={{ width: 140 }}>إجراءات</Th>
          </tr></thead>
          <tbody>
            {expenses.map((e) => {
              const acc = accounts.find((a) => a.id === e.accountId);
              return (
                <tr key={e.id}>
                  <Td>{e.expenseType}</Td>
                  <Td>{acc ? `${acc.code} — ${acc.nameAr}` : "—"}</Td>
                  <Td num>{fmt(e.amount)} {e.currencyCode}</Td>
                  <Td>{e.notes ?? "—"}</Td>
                  <Td>
                    <button onClick={() => setEdit({ mode: "edit", row: e })} disabled={!!edit} style={btnLink}>تعديل</button>
                    {" · "}
                    <button onClick={() => remove(e)} disabled={!!edit} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function ExpenseForm({ lcId, accounts, currencies, existing, onCancel, onDone }: {
  lcId: number; accounts: Account[]; currencies: Currency[];
  existing: LcExpense | null; onCancel: () => void; onDone: () => void;
}) {
  const [expenseType, setExpenseType] = useState(existing?.expenseType ?? "");
  const [accountId, setAccountId] = useState<number | null>(existing?.accountId ?? null);
  const [amount, setAmount] = useState<number>(existing?.amount ?? 0);
  const [currencyCode, setCurrencyCode] = useState(existing?.currencyCode ?? "SAR");
  const [exchangeRate, setExchangeRate] = useState<number>(existing?.exchangeRate ?? 1);
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const currencyOpts = currencies.length > 0 ? currencies.map((c) => c.code) : ["SAR"];
  const leafAccounts = accounts.filter((a) => a.isLeaf);

  async function save() {
    setBusy(true); setErr(null);
    try {
      if (!expenseType.trim()) throw new Error("نوع المصروف مطلوب");
      const payload: LcExpenseInput = {
        lcId, expenseType: expenseType.trim(), accountId: accountId || null,
        amount, currencyCode, exchangeRate: exchangeRate > 0 ? exchangeRate : 1,
        notes: notes.trim() || null,
      };
      if (existing) await updateLcExpense(existing.id, payload);
      else await createLcExpense(payload);
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        <Field label="نوع المصروف"><input value={expenseType} onChange={(e) => setExpenseType(e.target.value)} style={input} placeholder="شحن / جمارك / رسوم بنكية" autoFocus /></Field>
        <Field label="المبلغ"><input type="number" step="0.01" min={0} value={amount || ""} onChange={(e) => setAmount(Number(e.target.value) || 0)} style={input} /></Field>
        <Field label="الحساب">
          <SearchCombobox value={accountId ?? ""} onChange={(v) => setAccountId(Number(v) || null)} style={input}
            options={[{ value: "", label: "— بدون —" }, ...leafAccounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.nameAr}` }))]} />
        </Field>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        <Field label="العملة">
          <select value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)} style={input}>
            {currencyOpts.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="سعر الصرف">
          <input type="number" step="0.0001" min={0} value={exchangeRate || ""} onChange={(e) => setExchangeRate(Number(e.target.value) || 1)} style={input} disabled={currencyCode === "SAR"} />
        </Field>
        <Field label="ملاحظات"><input value={notes} onChange={(e) => setNotes(e.target.value)} style={input} /></Field>
      </div>
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} type="button" style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy} type="button" style={btnPrimary}>{busy ? "..." : "حفظ"}</button>
      </Actions>
    </div>
  );
}

function FundingDialog({ lcId, deps, onClose, onDone }: {
  lcId: number; deps: Deps; onClose: () => void; onDone: () => void;
}) {
  const { branches, costCenters } = useDimensions();
  const [date, setDate] = useState(todayStr());
  const [method, setMethod] = useState<"cash" | "bank">("cash");
  const [cashBoxId, setCashBoxId] = useState<number | null>(deps.cashBoxes[0]?.id ?? null);
  const [bankId, setBankId] = useState<number | null>(deps.banks[0]?.id ?? null);
  const [amount, setAmount] = useState<number>(0);
  const [branchId, setBranchId] = useState<number | "">("");
  const [costCenterId, setCostCenterId] = useState<number | "">("");
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); setErr(null);
    try {
      if (amount <= 0) throw new Error("أدخل مبلغاً موجباً");
      await postLcFunding({
        lcId, fundingDate: date, amount, paymentMethod: method,
        cashBoxId: method === "cash" ? cashBoxId : null,
        bankId: method === "bank" ? bankId : null,
        notes: notes.trim() || null,
        branchId: branchId === "" ? null : branchId,
        costCenterId: costCenterId === "" ? null : costCenterId,
      });
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل التمويل"); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="تمويل الاعتماد المستندي" onCancel={onClose}>
      <div style={{ fontSize: 13, color: "#64748b", marginBottom: 12 }}>
        يُرحَّل قيد: مدين حساب التسوية / دائن النقدية أو البنك.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="التاريخ"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
        <Field label="المبلغ"><input type="number" step="0.01" min={0} value={amount || ""} onChange={(e) => setAmount(Number(e.target.value) || 0)} style={input} autoFocus /></Field>
      </div>
      <Field label="طريقة الدفع">
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setMethod("cash")} type="button" style={method === "cash" ? btnPrimary : btnSecondary}>خزينة</button>
          <button onClick={() => setMethod("bank")} type="button" style={method === "bank" ? btnPrimary : btnSecondary}>بنك</button>
        </div>
      </Field>
      {method === "cash" ? (
        <Field label="الخزينة">
          <SearchCombobox value={cashBoxId ?? ""} onChange={(v) => setCashBoxId(Number(v) || null)} style={input}
            options={deps.cashBoxes.map((c) => ({ value: c.id, label: `${c.name} (${fmt(c.balance)} ${c.currencyCode})` }))} />
        </Field>
      ) : (
        <Field label="البنك">
          <SearchCombobox value={bankId ?? ""} onChange={(v) => setBankId(Number(v) || null)} style={input}
            options={deps.banks.map((b) => ({ value: b.id, label: `${b.name} (${fmt(b.balance)} ${b.currencyCode})` }))} />
        </Field>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="الفرع">
          <SearchCombobox value={branchId} onChange={(v) => setBranchId(v === "" ? "" : Number(v))} options={branchPickerOptions(branches)} style={input} />
        </Field>
        <Field label="مركز التكلفة">
          <SearchCombobox value={costCenterId} onChange={(v) => setCostCenterId(v === "" ? "" : Number(v))} options={costCenterPickerOptions(costCenters)} style={input} />
        </Field>
      </div>
      <Field label="البيان"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...input, minHeight: 50 }} /></Field>
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onClose} type="button" style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy} type="button" style={{ ...btnPrimary, background: "#15803d" }}>{busy ? "..." : "حفظ وترحيل"}</button>
      </Actions>
    </Modal>
  );
}
