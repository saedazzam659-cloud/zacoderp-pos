import { useEffect, useMemo, useState } from "react";
import {
  listAccounts, createAccount, updateAccount, deleteAccount,
  type Account, type AccountInput, type AccountType,
} from "../lib/accounting";
import {
  Page, Card, Table, Th, Td, Empty,
  input, btnPrimary, btnSecondary, btnLink, fmt, SearchCombobox,
} from "./_adminUi";

const TYPE_LABEL: Record<AccountType, string> = {
  asset: "أصول", liability: "خصوم", equity: "حقوق ملكية", revenue: "إيرادات", expense: "مصروفات",
};
const TYPE_COLOR: Record<AccountType, string> = {
  asset: "#1e40af", liability: "#9a3412", equity: "#7c3aed", revenue: "#15803d", expense: "#b91c1c",
};

const emptyInput: AccountInput = { code: "", nameAr: "", nameEn: null, type: "asset", parentId: null, isLeaf: true };

type EditState =
  | { mode: "new"; data: AccountInput }
  | { mode: "edit"; id: number; data: AccountInput }
  | null;

export default function ChartOfAccounts() {
  const [rows, setRows] = useState<Account[]>([]);
  const [edit, setEdit] = useState<EditState>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() { setRows(await listAccounts()); }
  useEffect(() => { void refresh(); }, []);

  const sorted = useMemo(() => [...rows].sort((a, b) => a.code.localeCompare(b.code)), [rows]);

  function startNew() { setErr(null); setEdit({ mode: "new", data: { ...emptyInput } }); }
  function startEdit(a: Account) {
    setErr(null);
    setEdit({ mode: "edit", id: a.id, data: {
      code: a.code, nameAr: a.nameAr, nameEn: a.nameEn,
      type: a.type, parentId: a.parentId, isLeaf: a.isLeaf,
    } });
  }
  function cancel() { setEdit(null); setErr(null); }
  function setField<K extends keyof AccountInput>(k: K, v: AccountInput[K]) {
    if (!edit) return; setEdit({ ...edit, data: { ...edit.data, [k]: v } });
  }
  async function save() {
    if (!edit) return;
    const f = edit.data;
    if (!f.code.trim() || !f.nameAr.trim()) { setErr("الكود والاسم مطلوبان"); return; }
    setBusy(true); setErr(null);
    try {
      if (edit.mode === "new") await createAccount(f);
      else await updateAccount(edit.id, f);
      setEdit(null); await refresh();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }
  async function remove(a: Account) {
    if (!confirm(`حذف الحساب ${a.code} - ${a.nameAr}؟`)) return;
    try { await deleteAccount(a.id); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل"); }
  }

  return (
    <Page
      title="شجرة الحسابات"
      subtitle={`${rows.length} حساب — الأكواد الافتراضية محفوظة، يمكنك إضافة فرعية`}
      right={<button onClick={startNew} disabled={!!edit} style={{ ...btnPrimary, opacity: edit ? 0.5 : 1, cursor: edit ? "not-allowed" : "pointer" }}>+ إضافة حساب</button>}
    >
      <Card>
        {sorted.length === 0 && !edit ? <Empty text="لا توجد حسابات" /> : (
          <Table>
            <thead><tr>
              <Th>الكود</Th><Th>الاسم</Th><Th>النوع</Th><Th>الحساب الأب</Th>
              <Th style={{ textAlign: "left" }}>الرصيد</Th><Th style={{ width: 220 }}>إجراءات</Th>
            </tr></thead>
            <tbody>
              {edit?.mode === "new" && (
                <EditRow data={edit.data} setField={setField} all={rows} editingId={null} onSave={save} onCancel={cancel} busy={busy} err={err} isNew />
              )}
              {sorted.map((a) => {
                if (edit?.mode === "edit" && edit.id === a.id) {
                  return <EditRow key={a.id} data={edit.data} setField={setField} all={rows} editingId={a.id} onSave={save} onCancel={cancel} busy={busy} err={err} balance={a.balance} />;
                }
                const depth = (a.code.match(/^(\d{1})/) ? a.code.length - 1 : 0);
                const parent = a.parentId ? rows.find((x) => x.id === a.parentId) : null;
                return (
                  <tr key={a.id} style={{ opacity: edit ? 0.6 : 1 }}>
                    <Td mono><span style={{ marginInlineStart: depth * 12 }}>{a.code}</span></Td>
                    <Td style={{ fontWeight: a.isLeaf ? 400 : 700 }}>{a.nameAr}</Td>
                    <Td><span style={{ background: TYPE_COLOR[a.type] + "20", color: TYPE_COLOR[a.type], padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{TYPE_LABEL[a.type]}</span></Td>
                    <Td style={{ color: "#64748b" }}>{parent ? `${parent.code} - ${parent.nameAr}` : "—"}</Td>
                    <Td num style={{ fontWeight: 600 }}>{fmt(a.balance)}</Td>
                    <Td>
                      <button onClick={() => startEdit(a)} disabled={!!edit} style={btnLink}>تعديل</button>
                      {" · "}
                      <button onClick={() => remove(a)} disabled={!!edit} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
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

function EditRow({ data, setField, all, editingId, onSave, onCancel, busy, err, isNew, balance }: {
  data: AccountInput;
  setField: <K extends keyof AccountInput>(k: K, v: AccountInput[K]) => void;
  all: Account[]; editingId: number | null;
  onSave: () => void; onCancel: () => void;
  busy: boolean; err: string | null; isNew?: boolean; balance?: number;
}) {
  const ci: React.CSSProperties = { ...input, padding: "6px 8px", fontSize: 13 };
  const parents = useMemo(
    () => all.filter((a) => a.type === data.type && !a.isLeaf && (!editingId || a.id !== editingId)),
    [all, data.type, editingId],
  );
  return (
    <>
      <tr style={{ background: isNew ? "#f0fdf4" : "#eff6ff" }}>
        <Td><input autoFocus value={data.code} onChange={(e) => setField("code", e.target.value)} style={ci} placeholder="الكود *" /></Td>
        <Td><input value={data.nameAr} onChange={(e) => setField("nameAr", e.target.value)} style={ci} placeholder="الاسم *" /></Td>
        <Td>
          <SearchCombobox
            value={data.type}
            onChange={(v) => setField("type", v as AccountType)}
            style={ci}
            options={Object.entries(TYPE_LABEL).map(([k, v]) => ({ value: k, label: v }))}
          />
        </Td>
        <Td>
          <SearchCombobox
            value={data.parentId ?? ""}
            onChange={(v) => setField("parentId", v === "" ? null : Number(v))}
            style={ci}
            options={[
              { value: "", label: "— بدون (حساب رئيسي) —" },
              ...parents.map((p) => ({ value: p.id, label: `${p.code} — ${p.nameAr}` })),
            ]}
          />
        </Td>
        <Td num>{balance !== undefined ? fmt(balance) : "—"}</Td>
        <Td>
          <button onClick={onSave} disabled={busy} style={{ ...btnPrimary, padding: "4px 10px", fontSize: 12 }}>{busy ? "..." : "حفظ"}</button>
          {" "}
          <button onClick={onCancel} disabled={busy} style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12 }}>إلغاء</button>
        </Td>
      </tr>
      <tr style={{ background: isNew ? "#f0fdf4" : "#eff6ff" }}>
        <Td colSpan={2}>
          <input value={data.nameEn ?? ""} onChange={(e) => setField("nameEn", e.target.value || null)} style={ci} placeholder="الاسم بالإنجليزية (اختياري)" />
        </Td>
        <Td colSpan={4}>
          <SearchCombobox
            value={data.isLeaf ? "1" : "0"}
            onChange={(v) => setField("isLeaf", v === "1")}
            style={ci}
            options={[
              { value: "1", label: "حساب فرعي (يقبل قيود)" },
              { value: "0", label: "حساب رئيسي (تجميع فقط)" },
            ]}
          />
        </Td>
      </tr>
      {err && <tr><Td colSpan={6} style={{ background: "#fef2f2", color: "#991b1b", fontSize: 13 }}>⚠️ {err}</Td></tr>}
    </>
  );
}
