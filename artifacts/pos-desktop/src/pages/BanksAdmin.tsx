import { useEffect, useMemo, useState } from "react";
import { listBanks, createBank, updateBank, deleteBank, listCurrencies, listAccounts, type Account, type Bank, type BankInput, type Currency } from "../lib/accounting";
import { listBranches, type Branch } from "../lib/branches";
import { Page, Card, Table, Th, Td, Empty, input, btnPrimary, btnSecondary, btnLink, fmtCurrency, SearchCombobox, errText } from "./_adminUi";
import { uiText, useUiLanguage } from "../lib/appSettings";
import { baseCurrencyCode } from "../lib/currency";

type EditData = Required<Pick<BankInput, "name" | "currencyCode">> & {
  code: string; nameEn: string; bankName: string; bankNameEn: string; accountNo: string;
  iban: string; swiftCode: string; accountId: number | null; branchIds: number[]; notes: string; isActive: boolean;
};
const blankData = (branchId?: number): EditData => ({
  code: "", name: "", nameEn: "", bankName: "", bankNameEn: "", accountNo: "", iban: "",
  swiftCode: "", currencyCode: baseCurrencyCode(), accountId: null, branchIds: branchId ? [branchId] : [], notes: "", isActive: true,
});

export default function BanksAdmin() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [rows, setRows] = useState<Bank[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [editId, setEditId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [data, setData] = useState<EditData>(blankData());
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    const [bk, cur, br, ac] = await Promise.all([listBanks(), listCurrencies(true), listBranches(), listAccounts()]);
    setRows(bk); setCurrencies(cur); setBranches(br); setAccounts(ac);
  }
  useEffect(() => { void refresh(); }, []);

  const editingBank = rows.find((b) => b.id === editId) ?? null;
  function startNew() {
    setErr(null); setEditId(null); setData(blankData(branches[0]?.id)); setFormOpen(true);
  }
  function startEdit(b: Bank) {
    setErr(null);
    setEditId(b.id);
    setData({
      code: b.code ?? "", name: b.name, nameEn: b.nameEn ?? "", bankName: b.bankName ?? "",
      bankNameEn: b.bankNameEn ?? "", accountNo: b.accountNo ?? "", iban: b.iban ?? "",
      swiftCode: b.swiftCode ?? "", currencyCode: b.currencyCode || baseCurrencyCode(),
      accountId: b.accountId ?? null,
      branchIds: b.branchIds ?? [], notes: b.notes ?? "", isActive: b.isActive !== false,
    });
    setFormOpen(true);
  }
  function cancel() { setFormOpen(false); setEditId(null); setErr(null); }
  function setField<K extends keyof EditData>(k: K, v: EditData[K]) { setData((current) => ({ ...current, [k]: v })); }
  async function save() {
    if (!data.name.trim()) { setErr(text("اسم الحساب بالعربية مطلوب", "Arabic account name is required.")); return; }
    if (!data.accountId) { setErr(text("اختر حسابًا محاسبيًا من شجرة الحسابات", "Choose a ledger account from the chart.")); return; }
    if (!data.branchIds.length) { setErr(text("اختر فرعًا واحدًا على الأقل", "Select at least one branch.")); return; }
    setBusy(true); setErr(null);
    try {
      const payload: BankInput = {
        name: data.name.trim(), nameEn: data.nameEn.trim() || null,
        bankName: data.bankName.trim() || null, bankNameEn: data.bankNameEn.trim() || null,
        accountNo: data.accountNo.trim() || null, code: data.code.trim() || null,
        iban: data.iban.trim().replace(/\s+/g, "").toUpperCase() || null,
        swiftCode: data.swiftCode.trim().toUpperCase() || null, currencyCode: data.currencyCode,
        accountId: data.accountId,
        branchIds: data.branchIds, notes: data.notes.trim() || null, isActive: data.isActive,
      };
      if (editId == null) await createBank(payload); else await updateBank(editId, payload);
      setFormOpen(false); setEditId(null); await refresh();
    } catch (e: any) { setErr(errText(e, text("تعذر حفظ بيانات البنك", "Could not save bank."))); }
    finally { setBusy(false); }
  }
  async function remove(b: Bank) {
    if (!confirm(text(`حذف البنك ${b.name}؟`, `Delete bank “${b.name}”?`))) return;
    try { await deleteBank(b.id); await refresh(); } catch (e: any) { alert(errText(e, text("تعذر حذف البنك", "Could not delete bank."))); }
  }

  const currencyOpts = currencies.length > 0
    ? currencies.map(c => ({ value: c.code, label: `${c.code} — ${language === "en" ? c.nameEn || c.code : c.nameAr}`, hint: c.symbol ?? undefined }))
    : [{ value: "SAR", label: text("SAR — ريال سعودي", "SAR — Saudi riyal") }];
  const accountOpts = useMemo(() => accounts
    .filter((account) => account.type === "asset" && account.isLeaf && (account.isActive || account.id === data.accountId))
    .map((account) => {
      const parent = accounts.find((candidate) => candidate.id === account.parentId);
      const name = language === "en" ? account.nameEn || account.nameAr : account.nameAr;
      const parentName = parent ? (language === "en" ? parent.nameEn || parent.nameAr : parent.nameAr) : "";
      return {
        value: account.id,
        label: `${"\u00a0\u00a0".repeat(Math.max(0, account.level - 2))}${account.code} — ${name}`,
        hint: `${parentName}${!account.isActive ? ` · ${text("غير نشط", "Inactive")}` : ""}`.trim(),
      };
    }), [accounts, data.accountId, language]);
  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((b) => [b.code, b.name, b.nameEn, b.bankName, b.bankNameEn, b.accountNo, b.iban, b.swiftCode]
      .some((v) => String(v ?? "").toLowerCase().includes(q)));
  }, [rows, search]);
  const activeCount = rows.filter((b) => b.isActive !== false).length;

  return (
    <div dir={language === "en" ? "ltr" : "rtl"}>
    <Page
      title={text("البنوك", "Banks")}
      subtitle={text("حسابات بنكية مرتبطة بالفروع والعملات والحسابات المحاسبية المحلية.", "Bank accounts linked to branches, currencies, and local ledger accounts.")}
      right={<button onClick={startNew} disabled={formOpen} style={{ ...btnPrimary, opacity: formOpen ? 0.5 : 1, cursor: formOpen ? "not-allowed" : "pointer" }}>+ {text("إضافة حساب بنكي", "Add bank account")}</button>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 10, marginBottom: 12 }}>
        <SummaryCard icon="🏦" label={text("إجمالي الحسابات", "Bank accounts")} value={rows.length} color="#2563eb" />
        <SummaryCard icon="🟢" label={text("حسابات نشطة", "Active accounts")} value={activeCount} color="#15803d" />
        <SummaryCard icon="💱" label={text("العملات المستخدمة", "Currencies")} value={new Set(rows.map((b) => b.currencyCode)).size} color="#7c3aed" />
      </div>
      {formOpen && (
        <Card style={{ marginBottom: 12, padding: 16, border: "1px solid #bfdbfe", boxShadow: "0 8px 24px #1e3a8a12" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
            <div>
              <h3 style={{ margin: 0, color: "#1e3a8a" }}>{editId == null ? text("حساب بنكي جديد", "New bank account") : text("تعديل الحساب البنكي", "Edit bank account")}</h3>
              <p style={{ margin: "4px 0 0", fontSize: 12, color: "#64748b" }}>{text("أدخل البيانات مرة واحدة ليختار المستخدم الحساب الصحيح بسهولة في السندات.", "Enter these details once so users can easily choose the right account on vouchers.")}</p>
            </div>
            <span style={{ padding: "5px 9px", borderRadius: 999, background: "#eff6ff", color: "#1d4ed8", fontSize: 11, fontWeight: 700 }}>
              {text("حساب فرعي محلي", "Local subaccount")}
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: "10px 12px" }}>
            <Labeled label={text("كود البنك", "Bank code")} hint={text("كود تعريفي للبنك فقط", "Identification code only")}>
              <input value={data.code} onChange={(e) => setField("code", e.target.value)} placeholder="BA-0001" style={input} />
            </Labeled>
            <Labeled label={text("اسم الحساب بالعربية *", "Arabic account name *")}><input autoFocus value={data.name} onChange={(e) => setField("name", e.target.value)} style={input} /></Labeled>
            <Labeled label={text("اسم الحساب بالإنجليزية", "English account name")}><input dir="ltr" value={data.nameEn} onChange={(e) => setField("nameEn", e.target.value)} style={input} /></Labeled>
            <Labeled label={text("اسم البنك بالعربية", "Bank name")}><input value={data.bankName} onChange={(e) => setField("bankName", e.target.value)} style={input} /></Labeled>
            <Labeled label={text("اسم البنك بالإنجليزية", "Bank name in English")}><input dir="ltr" value={data.bankNameEn} onChange={(e) => setField("bankNameEn", e.target.value)} style={input} /></Labeled>
            <Labeled label={text("رقم الحساب", "Account number")}><input dir="ltr" value={data.accountNo} onChange={(e) => setField("accountNo", e.target.value)} style={input} /></Labeled>
            <Labeled label="IBAN"><input dir="ltr" value={data.iban} onChange={(e) => setField("iban", e.target.value)} placeholder="EG..." style={{ ...input, fontFamily: "monospace" }} /></Labeled>
            <Labeled label="SWIFT"><input dir="ltr" value={data.swiftCode} onChange={(e) => setField("swiftCode", e.target.value)} style={{ ...input, fontFamily: "monospace" }} /></Labeled>
            <Labeled label={text("العملة", "Currency")}>
              <SearchCombobox value={data.currencyCode} onChange={(v) => setField("currencyCode", String(v))} options={currencyOpts} disabled={!!editingBank && Math.abs(editingBank.balance) > 0.001} style={input} />
            </Labeled>
            <Labeled label={text("الحساب المحاسبي *", "Ledger account *")} hint={accountOpts.length ? undefined : text("أضف حساب أصول تفصيليًا ونشطًا أولًا", "Add an active leaf asset account first")}>
              <SearchCombobox value={data.accountId} onChange={(v) => setField("accountId", Number(v) || null)} options={accountOpts}
                placeholder={text("اختر حسابًا من شجرة الحسابات", "Choose a chart account")}
                disabled={!!editingBank && Math.abs(editingBank.balance) > 0.001} style={input} />
            </Labeled>
            <Labeled label={text("الفروع المرتبطة *", "Linked branches *")}>
              <BranchChecks branches={branches} value={data.branchIds} onChange={(v) => setField("branchIds", v)} />
            </Labeled>
            <Labeled label={text("ملاحظات", "Notes")}><input value={data.notes} onChange={(e) => setField("notes", e.target.value)} style={input} /></Labeled>
            <label style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 20, fontSize: 13, fontWeight: 600, color: "#334155" }}>
              <input type="checkbox" checked={data.isActive} onChange={(e) => setField("isActive", e.target.checked)} />
              {text("حساب نشط ومتاح للاختيار", "Active and available for selection")}
            </label>
          </div>
          {editingBank && Math.abs(editingBank.balance) > 0.001 && (
            <div style={{ marginTop: 10, padding: "8px 11px", borderRadius: 8, background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: 12 }}>
              ⚠️ {text("لا يمكن تغيير العملة أو الحساب المحاسبي لحساب لديه رصيد؛ نفّذ تحويلًا أولًا.", "Currency and ledger account are locked while this account has a balance; transfer funds first.")}
            </div>
          )}
          {err && <div role="alert" style={{ marginTop: 10, padding: "8px 11px", borderRadius: 8, background: "#fef2f2", color: "#991b1b", fontSize: 13 }}>{err}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
            <button onClick={cancel} disabled={busy} style={btnSecondary}>{text("إلغاء", "Cancel")}</button>
            <button onClick={() => void save()} disabled={busy} style={btnPrimary}>{busy ? text("جارٍ الحفظ…", "Saving…") : text("حفظ الحساب", "Save account")}</button>
          </div>
        </Card>
      )}
      <Card style={{ overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid #e2e8f0" }}>
          <strong style={{ color: "#0f172a" }}>{text("الحسابات البنكية", "Bank accounts")} ({visibleRows.length})</strong>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={text("بحث بالاسم أو الكود أو IBAN…", "Search name, code, or IBAN…")} style={{ ...input, maxWidth: 330 }} />
        </div>
        {visibleRows.length === 0 ? <Empty text={search ? text("لا توجد نتائج مطابقة", "No matching results") : text("لا توجد بنوك", "No bank accounts yet")} /> : (
          <Table>
            <thead><tr>
              <Th>{text("الكود والحساب", "Code and account")}</Th><Th>{text("البنك", "Bank")}</Th>
              <Th>{text("رقم الحساب", "Account number")}</Th><Th>IBAN / SWIFT</Th><Th>{text("العملة", "Currency")}</Th>
              <Th>{text("الفروع", "Branches")}</Th><Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الرصيد", "Balance")}</Th>
              <Th>{text("الحالة", "Status")}</Th><Th>{text("إجراءات", "Actions")}</Th>
            </tr></thead>
            <tbody>{visibleRows.map((b) => (
              <tr key={b.id}>
                <Td><div style={{ fontWeight: 700 }}>{language === "en" ? b.nameEn || b.name : b.name}</div><div style={{ color: "#64748b", fontSize: 11, fontFamily: "monospace" }}>{b.code ?? "—"}</div></Td>
                <Td>{language === "en" ? b.bankNameEn || b.bankName || "—" : b.bankName || "—"}</Td>
                <Td mono>{b.accountNo || "—"}</Td>
                <Td mono><div>{b.iban || "—"}</div><div style={{ color: "#64748b", fontSize: 11 }}>{b.swiftCode || ""}</div></Td>
                <Td><span style={{ background: "#eff6ff", color: "#1e40af", padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 700 }}>{b.currencyCode || baseCurrencyCode()}</span></Td>
                <Td>{(b.branchIds ?? []).map((id) => branches.find((br) => br.id === id)?.nameAr).filter(Boolean).join("، ") || text("كل الفروع", "All branches")}</Td>
                <Td num style={{ fontWeight: 600 }}>{fmtCurrency(b.balance, b.currencyCode || baseCurrencyCode())}</Td>
                <Td><StatusPill active={b.isActive !== false} /></Td>
                <Td><button onClick={() => startEdit(b)} disabled={formOpen} style={btnLink}>{text("تعديل", "Edit")}</button>{" · "}
                  <button onClick={() => void remove(b)} disabled={formOpen} style={{ ...btnLink, color: "#dc2626" }}>{text("حذف", "Delete")}</button></Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
    </Page>
    </div>
  );
}

function Labeled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label style={{ display: "grid", gap: 5, color: "#475569", fontSize: 12, fontWeight: 700 }}>
    <span>{label}{hint && <small style={{ display: "block", marginTop: 2, color: "#94a3b8", fontWeight: 400 }}>{hint}</small>}</span>{children}
  </label>;
}
function BranchChecks({ branches, value, onChange }: { branches: Branch[]; value: number[]; onChange: (value: number[]) => void }) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  if (!branches.length) return <span style={{ color: "#b91c1c", fontSize: 12 }}>{text("لا توجد فروع مفعّلة", "No branches available")}</span>;
  return <div style={{ display: "flex", flexWrap: "wrap", gap: 5, minHeight: 36, alignItems: "center" }}>
    {branches.filter((b) => b.isActive !== false).map((branch) => {
      const checked = value.includes(branch.id);
      return <label key={branch.id} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 8px", borderRadius: 999, border: `1px solid ${checked ? "#93c5fd" : "#e2e8f0"}`, background: checked ? "#eff6ff" : "#fff", color: checked ? "#1d4ed8" : "#64748b", fontSize: 11, cursor: "pointer" }}>
        <input type="checkbox" checked={checked} onChange={() => onChange(checked ? value.filter((id) => id !== branch.id) : [...value, branch.id])} />{branch.nameAr}
      </label>;
    })}
  </div>;
}
function StatusPill({ active }: { active: boolean }) {
  const language = useUiLanguage();
  return <span style={{ padding: "3px 8px", borderRadius: 999, background: active ? "#dcfce7" : "#f1f5f9", color: active ? "#166534" : "#64748b", fontSize: 11, fontWeight: 700 }}>
    {active ? uiText("نشط", "Active", language) : uiText("متوقف", "Inactive", language)}
  </span>;
}
function SummaryCard({ icon, label, value, color }: { icon: string; label: string; value: number; color: string }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 11, padding: 13, borderRadius: 12, border: "1px solid #e2e8f0", background: "#fff" }}>
    <span style={{ width: 36, height: 36, display: "grid", placeItems: "center", borderRadius: 11, background: `${color}12`, color, fontSize: 18 }}>{icon}</span>
    <div><div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a" }}>{value}</div><div style={{ color: "#64748b", fontSize: 11 }}>{label}</div></div>
  </div>;
}
