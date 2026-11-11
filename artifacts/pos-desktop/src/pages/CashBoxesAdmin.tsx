import { useEffect, useMemo, useState } from "react";
import { listCashBoxes, createCashBox, updateCashBox, deleteCashBox, listCurrencies, type CashBox, type CashBoxInput, type Currency } from "../lib/accounting";
import { listBranches, type Branch } from "../lib/branches";
import { Page, Card, Table, Th, Td, Empty, input, btnPrimary, btnSecondary, btnLink, fmtCurrency, SearchCombobox, errText } from "./_adminUi";
import { uiText, useUiLanguage } from "../lib/appSettings";
import { baseCurrencyCode } from "../lib/currency";

type EditData = Required<Pick<CashBoxInput, "name" | "currencyCode">> & {
  code: string; nameEn: string; branchIds: number[]; notes: string; isActive: boolean;
};
const blankData = (branchId?: number): EditData => ({
  code: "", name: "", nameEn: "", currencyCode: baseCurrencyCode(),
  branchIds: branchId ? [branchId] : [], notes: "", isActive: true,
});

export default function CashBoxesAdmin() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [rows, setRows] = useState<CashBox[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [editId, setEditId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [data, setData] = useState<EditData>(blankData());
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    const [cb, cur, br] = await Promise.all([listCashBoxes(), listCurrencies(true), listBranches()]);
    setRows(cb); setCurrencies(cur); setBranches(br);
  }
  useEffect(() => { void refresh(); }, []);

  const editingCashBox = rows.find((b) => b.id === editId) ?? null;
  function startNew() { setErr(null); setEditId(null); setData(blankData(branches[0]?.id)); setFormOpen(true); }
  function startEdit(b: CashBox) {
    setErr(null);
    setEditId(b.id);
    setData({ code: b.code ?? "", name: b.name, nameEn: b.nameEn ?? "", currencyCode: b.currencyCode || baseCurrencyCode(), branchIds: b.branchIds ?? [], notes: b.notes ?? "", isActive: b.isActive !== false });
    setFormOpen(true);
  }
  function cancel() { setFormOpen(false); setEditId(null); setErr(null); }
  function setField<K extends keyof EditData>(k: K, v: EditData[K]) { setData((current) => ({ ...current, [k]: v })); }
  async function save() {
    if (!data.name.trim()) { setErr(text("اسم الخزينة بالعربية مطلوب", "Arabic cashbox name is required.")); return; }
    if (!data.branchIds.length) { setErr(text("اختر فرعًا واحدًا على الأقل", "Select at least one branch.")); return; }
    setBusy(true); setErr(null);
    try {
      const payload: CashBoxInput = { name: data.name.trim(), nameEn: data.nameEn.trim() || null, code: data.code.trim() || null, currencyCode: data.currencyCode, branchIds: data.branchIds, notes: data.notes.trim() || null, isActive: data.isActive };
      if (editId == null) await createCashBox(payload); else await updateCashBox(editId, payload);
      setFormOpen(false); setEditId(null); await refresh();
    } catch (e: any) { setErr(errText(e, text("تعذر حفظ بيانات الخزينة", "Could not save cashbox."))); }
    finally { setBusy(false); }
  }
  async function remove(b: CashBox) {
    if (!confirm(text(`حذف الخزينة ${b.name}؟`, `Delete cashbox “${b.name}”?`))) return;
    try { await deleteCashBox(b.id); await refresh(); } catch (e: any) { alert(errText(e, text("تعذر حذف الخزينة", "Could not delete cashbox."))); }
  }

  const currencyOpts = currencies.length > 0
    ? currencies.map(c => ({ value: c.code, label: `${c.code} — ${language === "en" ? c.nameEn || c.code : c.nameAr}`, hint: c.symbol ?? undefined }))
    : [{ value: "SAR", label: text("SAR — ريال سعودي", "SAR — Saudi riyal") }];
  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((b) => [b.code, b.name, b.nameEn, b.currencyCode, b.notes].some((v) => String(v ?? "").toLowerCase().includes(q)));
  }, [rows, search]);

  return (
    <div dir={language === "en" ? "ltr" : "rtl"}>
    <Page
      title={text("الخزن", "Cashboxes")}
      subtitle={text("إدارة الخزن مع فروعها وعملاتها وحساباتها المحاسبية المحلية.", "Manage cashboxes, their branches, currencies, and local ledger accounts.")}
      right={<button onClick={startNew} disabled={formOpen} style={{ ...btnPrimary, opacity: formOpen ? 0.5 : 1, cursor: formOpen ? "not-allowed" : "pointer" }}>+ {text("إضافة خزينة", "Add cashbox")}</button>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 10, marginBottom: 12 }}>
        <SummaryCard icon="💵" label={text("إجمالي الخزن", "Cashboxes")} value={rows.length} color="#15803d" />
        <SummaryCard icon="🟢" label={text("خزن نشطة", "Active cashboxes")} value={rows.filter((b) => b.isActive !== false).length} color="#0f766e" />
        <SummaryCard icon="💱" label={text("العملات المستخدمة", "Currencies")} value={new Set(rows.map((b) => b.currencyCode)).size} color="#7c3aed" />
      </div>
      {formOpen && (
        <Card style={{ marginBottom: 12, padding: 16, border: "1px solid #bbf7d0", boxShadow: "0 8px 24px #14532d12" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
            <div>
              <h3 style={{ margin: 0, color: "#166534" }}>{editId == null ? text("خزينة جديدة", "New cashbox") : text("تعديل الخزينة", "Edit cashbox")}</h3>
              <p style={{ margin: "4px 0 0", fontSize: 12, color: "#64748b" }}>{text("حدّد الفرع والعملة لتظهر الخزينة المناسبة في السند.", "Choose the branch and currency so users can select the right cashbox on vouchers.")}</p>
            </div>
            <span style={{ padding: "5px 9px", borderRadius: 999, background: "#f0fdf4", color: "#15803d", fontSize: 11, fontWeight: 700 }}>{text("حساب فرعي محلي", "Local subaccount")}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "10px 12px" }}>
            <Labeled label={text("كود الخزينة", "Cashbox code")} hint={text("يُنشأ تلقائيًا عند تركه فارغًا", "Generated automatically when blank")}><input value={data.code} onChange={(e) => setField("code", e.target.value)} placeholder="CB-0001" style={input} /></Labeled>
            <Labeled label={text("اسم الخزينة بالعربية *", "Arabic cashbox name *")}><input autoFocus value={data.name} onChange={(e) => setField("name", e.target.value)} style={input} /></Labeled>
            <Labeled label={text("اسم الخزينة بالإنجليزية", "English cashbox name")}><input dir="ltr" value={data.nameEn} onChange={(e) => setField("nameEn", e.target.value)} style={input} /></Labeled>
            <Labeled label={text("العملة", "Currency")}><SearchCombobox value={data.currencyCode} onChange={(v) => setField("currencyCode", String(v))} options={currencyOpts} disabled={!!editingCashBox && Math.abs(editingCashBox.balance) > 0.001} style={input} /></Labeled>
            <Labeled label={text("الفروع المرتبطة *", "Linked branches *")}><BranchChecks branches={branches} value={data.branchIds} onChange={(v) => setField("branchIds", v)} /></Labeled>
            <Labeled label={text("ملاحظات", "Notes")}><input value={data.notes} onChange={(e) => setField("notes", e.target.value)} style={input} /></Labeled>
            <label style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 20, fontSize: 13, fontWeight: 600, color: "#334155" }}>
              <input type="checkbox" checked={data.isActive} onChange={(e) => setField("isActive", e.target.checked)} />{text("خزينة نشطة ومتاحة للاختيار", "Active and available for selection")}
            </label>
          </div>
          {editingCashBox && Math.abs(editingCashBox.balance) > 0.001 && (
            <div style={{ marginTop: 10, padding: "8px 11px", borderRadius: 8, background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: 12 }}>
              ⚠️ {text("لا يمكن تغيير عملة خزينة لديها رصيد؛ نفّذ تحويلًا أولًا.", "Currency is locked while this cashbox has a balance; transfer funds first.")}
            </div>
          )}
          {err && <div role="alert" style={{ marginTop: 10, padding: "8px 11px", borderRadius: 8, background: "#fef2f2", color: "#991b1b", fontSize: 13 }}>{err}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
            <button onClick={cancel} disabled={busy} style={btnSecondary}>{text("إلغاء", "Cancel")}</button>
            <button onClick={() => void save()} disabled={busy} style={btnPrimary}>{busy ? text("جارٍ الحفظ…", "Saving…") : text("حفظ الخزينة", "Save cashbox")}</button>
          </div>
        </Card>
      )}
      <Card style={{ overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid #e2e8f0" }}>
          <strong style={{ color: "#0f172a" }}>{text("الخزن", "Cashboxes")} ({visibleRows.length})</strong>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={text("بحث بالاسم أو الكود…", "Search by name or code…")} style={{ ...input, maxWidth: 330 }} />
        </div>
        {visibleRows.length === 0 ? <Empty text={search ? text("لا توجد نتائج مطابقة", "No matching results") : text("لا توجد خزن", "No cashboxes yet")} /> : (
          <Table>
            <thead><tr><Th>{text("الكود واسم الخزينة", "Code and cashbox")}</Th><Th>{text("العملة", "Currency")}</Th><Th>{text("الفروع", "Branches")}</Th><Th>{text("ملاحظات", "Notes")}</Th><Th style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الرصيد", "Balance")}</Th><Th>{text("الحالة", "Status")}</Th><Th>{text("إجراءات", "Actions")}</Th></tr></thead>
            <tbody>{visibleRows.map((b) => (
              <tr key={b.id}>
                <Td><div style={{ fontWeight: 700 }}>{language === "en" ? b.nameEn || b.name : b.name}</div><div style={{ color: "#64748b", fontSize: 11, fontFamily: "monospace" }}>{b.code ?? "—"}</div></Td>
                <Td><span style={{ background: "#eff6ff", color: "#1e40af", padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 700 }}>{b.currencyCode || baseCurrencyCode()}</span></Td>
                <Td>{(b.branchIds ?? []).map((id) => branches.find((br) => br.id === id)?.nameAr).filter(Boolean).join("، ") || text("كل الفروع", "All branches")}</Td>
                <Td>{b.notes || "—"}</Td>
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
    {branches.filter((b) => b.isActive).map((branch) => {
      const checked = value.includes(branch.id);
      return <label key={branch.id} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 8px", borderRadius: 999, border: `1px solid ${checked ? "#86efac" : "#e2e8f0"}`, background: checked ? "#f0fdf4" : "#fff", color: checked ? "#15803d" : "#64748b", fontSize: 11, cursor: "pointer" }}>
        <input type="checkbox" checked={checked} onChange={() => onChange(checked ? value.filter((id) => id !== branch.id) : [...value, branch.id])} />{branch.nameAr}
      </label>;
    })}
  </div>;
}
function StatusPill({ active }: { active: boolean }) {
  const language = useUiLanguage();
  return <span style={{ padding: "3px 8px", borderRadius: 999, background: active ? "#dcfce7" : "#f1f5f9", color: active ? "#166534" : "#64748b", fontSize: 11, fontWeight: 700 }}>
    {active ? uiText("نشطة", "Active", language) : uiText("متوقفة", "Inactive", language)}
  </span>;
}
function SummaryCard({ icon, label, value, color }: { icon: string; label: string; value: number; color: string }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 11, padding: 13, borderRadius: 12, border: "1px solid #e2e8f0", background: "#fff" }}>
    <span style={{ width: 36, height: 36, display: "grid", placeItems: "center", borderRadius: 11, background: `${color}12`, color, fontSize: 18 }}>{icon}</span>
    <div><div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a" }}>{value}</div><div style={{ color: "#64748b", fontSize: 11 }}>{label}</div></div>
  </div>;
}
