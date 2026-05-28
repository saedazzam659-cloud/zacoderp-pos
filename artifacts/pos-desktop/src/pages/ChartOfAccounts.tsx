import { useEffect, useMemo, useState } from "react";
import {
  listAccounts, createAccount, updateAccount, deleteAccount,
  type Account, type AccountInput, type AccountType,
} from "../lib/accounting";
import {
  Page, Card, Table, Th, Td, Modal, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, btnLink, fmt, SearchCombobox,
} from "./_adminUi";

const TYPE_LABEL: Record<AccountType, string> = {
  asset: "أصول", liability: "خصوم", equity: "حقوق ملكية", revenue: "إيرادات", expense: "مصروفات",
};
const TYPE_COLOR: Record<AccountType, string> = {
  asset: "#1e40af", liability: "#9a3412", equity: "#7c3aed", revenue: "#15803d", expense: "#b91c1c",
};

const emptyInput: AccountInput = { code: "", nameAr: "", nameEn: null, type: "asset", parentId: null, isLeaf: true };

export default function ChartOfAccounts() {
  const [rows, setRows] = useState<Account[]>([]);
  const [edit, setEdit] = useState<null | { row: Account | null }>(null);

  async function refresh() { setRows(await listAccounts()); }
  useEffect(() => { void refresh(); }, []);

  // Sort by code for tree-like display (codes are hierarchical).
  const sorted = useMemo(() => [...rows].sort((a, b) => a.code.localeCompare(b.code)), [rows]);

  async function remove(a: Account) {
    if (!confirm(`حذف الحساب ${a.code} - ${a.nameAr}؟`)) return;
    try { await deleteAccount(a.id); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل"); }
  }

  return (
    <Page
      title="شجرة الحسابات"
      subtitle={`${rows.length} حساب — الأكواد الافتراضية محفوظة، يمكنك إضافة فرعية`}
      right={<button onClick={() => setEdit({ row: null })} style={btnPrimary}>+ إضافة حساب</button>}
    >
      <Card>
        {sorted.length === 0 ? <Empty text="لا توجد حسابات" /> : (
          <Table>
            <thead><tr>
              <Th>الكود</Th><Th>الاسم</Th><Th>النوع</Th><Th>الحساب الأب</Th>
              <Th style={{ textAlign: "left" }}>الرصيد</Th><Th style={{ width: 180 }}>إجراءات</Th>
            </tr></thead>
            <tbody>
              {sorted.map((a) => {
                const depth = (a.code.match(/^(\d{1})/) ? a.code.length - 1 : 0);
                const parent = a.parentId ? rows.find((x) => x.id === a.parentId) : null;
                return (
                  <tr key={a.id}>
                    <Td mono><span style={{ marginInlineStart: depth * 12 }}>{a.code}</span></Td>
                    <Td style={{ fontWeight: a.isLeaf ? 400 : 700 }}>{a.nameAr}</Td>
                    <Td><span style={{ background: TYPE_COLOR[a.type] + "20", color: TYPE_COLOR[a.type], padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{TYPE_LABEL[a.type]}</span></Td>
                    <Td style={{ color: "#64748b" }}>{parent ? `${parent.code} - ${parent.nameAr}` : "—"}</Td>
                    <Td num style={{ fontWeight: 600 }}>{fmt(a.balance)}</Td>
                    <Td>
                      <button onClick={() => setEdit({ row: a })} style={btnLink}>تعديل</button>
                      {" · "}
                      <button onClick={() => remove(a)} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      {edit && <AccountForm row={edit.row} all={rows} onCancel={() => setEdit(null)} onDone={() => { setEdit(null); void refresh(); }} />}
    </Page>
  );
}

function AccountForm({ row, all, onCancel, onDone }: { row: Account | null; all: Account[]; onCancel: () => void; onDone: () => void }) {
  const [f, setF] = useState<AccountInput>(row
    ? { code: row.code, nameAr: row.nameAr, nameEn: row.nameEn, type: row.type, parentId: row.parentId, isLeaf: row.isLeaf }
    : emptyInput);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Parent options: only non-leaf accounts of the same type.
  const parents = useMemo(() => all.filter((a) => a.type === f.type && !a.isLeaf && (!row || a.id !== row.id)), [all, f.type, row]);

  async function save() {
    setBusy(true); setErr(null);
    try {
      if (row) await updateAccount(row.id, f);
      else await createAccount(f);
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={row ? `تعديل ${row.code}` : "إضافة حساب"} onCancel={onCancel}>
      <Field label="الكود *"><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} style={input} autoFocus /></Field>
      <Field label="الاسم *"><input value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} style={input} /></Field>
      <Field label="النوع">
        <SearchCombobox
          value={f.type}
          onChange={(v) => setF({ ...f, type: v as AccountType, parentId: null })}
          style={input}
          options={Object.entries(TYPE_LABEL).map(([k, v]) => ({ value: k, label: v }))}
        />
      </Field>
      <Field label="الحساب الأب">
        <SearchCombobox
          value={f.parentId ?? ""}
          onChange={(v) => setF({ ...f, parentId: v === "" ? null : Number(v) })}
          style={input}
          options={[
            { value: "", label: "— بدون (حساب رئيسي) —" },
            ...parents.map((p) => ({ value: p.id, label: `${p.code} — ${p.nameAr}` })),
          ]}
        />
      </Field>
      <Field label="نوع الحساب">
        <SearchCombobox
          value={f.isLeaf ? "1" : "0"}
          onChange={(v) => setF({ ...f, isLeaf: v === "1" })}
          style={input}
          options={[
            { value: "1", label: "حساب فرعي (يقبل قيود)" },
            { value: "0", label: "حساب رئيسي (تجميع فقط)" },
          ]}
        />
      </Field>
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy || !f.code.trim() || !f.nameAr.trim()} style={btnPrimary}>{busy ? "..." : "حفظ"}</button>
      </Actions>
    </Modal>
  );
}
