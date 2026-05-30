import { useEffect, useState } from "react";
import { listBranches, createBranch, updateBranch, deleteBranch, type Branch } from "../lib/branches";
import { Page, Card, Table, Th, Td, Empty, input, btnPrimary, btnSecondary, btnLink, SearchCombobox } from "./_adminUi";

type EditData = { code: string; nameAr: string; nameEn: string; isActive: boolean };
type EditState =
  | { mode: "new"; data: EditData }
  | { mode: "edit"; id: number; data: EditData }
  | null;

export default function BranchesAdmin() {
  const [rows, setRows] = useState<Branch[]>([]);
  const [edit, setEdit] = useState<EditState>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() { setRows(await listBranches()); }
  useEffect(() => { void refresh(); }, []);

  function startNew() { setErr(null); setEdit({ mode: "new", data: { code: "", nameAr: "", nameEn: "", isActive: true } }); }
  function startEdit(b: Branch) {
    setErr(null);
    setEdit({ mode: "edit", id: b.id, data: { code: b.code, nameAr: b.nameAr, nameEn: b.nameEn ?? "", isActive: b.isActive } });
  }
  function cancel() { setEdit(null); setErr(null); }
  function setField<K extends keyof EditData>(k: K, v: EditData[K]) { if (edit) setEdit({ ...edit, data: { ...edit.data, [k]: v } }); }
  async function save() {
    if (!edit) return;
    const { code, nameAr, nameEn, isActive } = edit.data;
    if (!code.trim()) { setErr("كود الفرع مطلوب"); return; }
    if (!nameAr.trim()) { setErr("اسم الفرع مطلوب"); return; }
    setBusy(true); setErr(null);
    try {
      const payload = { code: code.trim(), nameAr: nameAr.trim(), nameEn: nameEn.trim() || null, isActive };
      if (edit.mode === "new") await createBranch(payload);
      else await updateBranch(edit.id, payload);
      setEdit(null); await refresh();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }
  async function remove(b: Branch) {
    if (!confirm(`حذف الفرع ${b.nameAr}؟`)) return;
    try { await deleteBranch(b.id); await refresh(); } catch (e: any) { alert(e?.message ?? "فشل"); }
  }

  return (
    <Page
      title="الفروع"
      subtitle={`${rows.length} فرع — تُستخدم الفروع لتصنيف القيود والفواتير وتصفية التقارير المالية.`}
      right={<button onClick={startNew} disabled={!!edit} style={{ ...btnPrimary, opacity: edit ? 0.5 : 1, cursor: edit ? "not-allowed" : "pointer" }}>+ إضافة فرع</button>}
    >
      <Card>
        {rows.length === 0 && !edit ? <Empty text="لا توجد فروع" /> : (
          <Table>
            <thead><tr>
              <Th style={{ width: 120 }}>الكود</Th><Th>الاسم</Th><Th>الاسم بالإنجليزية</Th>
              <Th style={{ width: 110 }}>الحالة</Th><Th style={{ width: 200 }}>إجراءات</Th>
            </tr></thead>
            <tbody>
              {edit?.mode === "new" && (
                <EditRow data={edit.data} setField={setField} onSave={save} onCancel={cancel} busy={busy} err={err} isNew />
              )}
              {rows.map((b) => (
                edit?.mode === "edit" && edit.id === b.id ? (
                  <EditRow key={b.id} data={edit.data} setField={setField} onSave={save} onCancel={cancel} busy={busy} err={err} />
                ) : (
                  <tr key={b.id} style={{ opacity: edit ? 0.6 : 1 }}>
                    <Td mono>{b.code}</Td>
                    <Td style={{ fontWeight: 600 }}>{b.nameAr}</Td>
                    <Td style={{ color: "#64748b" }}>{b.nameEn || "—"}</Td>
                    <Td>
                      <span style={{ background: (b.isActive ? "#15803d" : "#b91c1c") + "20", color: b.isActive ? "#15803d" : "#b91c1c", padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
                        {b.isActive ? "نشط" : "غير نشط"}
                      </span>
                    </Td>
                    <Td>
                      <button onClick={() => startEdit(b)} disabled={!!edit} style={btnLink}>تعديل</button>
                      {" · "}
                      <button onClick={() => remove(b)} disabled={!!edit} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
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

function EditRow({ data, setField, onSave, onCancel, busy, err, isNew }: {
  data: EditData; setField: <K extends keyof EditData>(k: K, v: EditData[K]) => void;
  onSave: () => void; onCancel: () => void; busy: boolean; err: string | null; isNew?: boolean;
}) {
  const ci: React.CSSProperties = { ...input, padding: "6px 8px", fontSize: 13 };
  return (
    <>
      <tr style={{ background: isNew ? "#f0fdf4" : "#eff6ff" }}>
        <Td><input autoFocus value={data.code} onChange={(e) => setField("code", e.target.value)} style={ci} placeholder="الكود *" /></Td>
        <Td><input value={data.nameAr} onChange={(e) => setField("nameAr", e.target.value)} style={ci} placeholder="الاسم *" /></Td>
        <Td><input value={data.nameEn} onChange={(e) => setField("nameEn", e.target.value)} style={ci} placeholder="الاسم بالإنجليزية (اختياري)" /></Td>
        <Td>
          <SearchCombobox
            value={data.isActive ? "1" : "0"}
            onChange={(v) => setField("isActive", v === "1")}
            style={ci}
            options={[{ value: "1", label: "نشط" }, { value: "0", label: "غير نشط" }]}
          />
        </Td>
        <Td>
          <button onClick={onSave} disabled={busy} style={{ ...btnPrimary, padding: "4px 10px", fontSize: 12 }}>{busy ? "..." : "حفظ"}</button>
          {" "}
          <button onClick={onCancel} disabled={busy} style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12 }}>إلغاء</button>
        </Td>
      </tr>
      {err && <tr><Td colSpan={5} style={{ background: "#fef2f2", color: "#991b1b", fontSize: 13 }}>⚠️ {err}</Td></tr>}
    </>
  );
}
