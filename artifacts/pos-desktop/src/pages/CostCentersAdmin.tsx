import { useEffect, useMemo, useState } from "react";
import { listCostCenters, createCostCenter, updateCostCenter, deleteCostCenter, type CostCenter } from "../lib/costCenters";
import { Page, Card, Table, Th, Td, Empty, input, btnPrimary, btnSecondary, btnLink, SearchCombobox } from "./_adminUi";

type EditData = { code: string; nameAr: string; nameEn: string; parentId: number | null; isPosting: boolean; isActive: boolean };
type EditState =
  | { mode: "new"; data: EditData }
  | { mode: "edit"; id: number; data: EditData }
  | null;

function sortTree(rows: CostCenter[]): CostCenter[] {
  return [...rows].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

export default function CostCentersAdmin() {
  const [rows, setRows] = useState<CostCenter[]>([]);
  const [edit, setEdit] = useState<EditState>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() { setRows(await listCostCenters()); }
  useEffect(() => { void refresh(); }, []);

  const sorted = useMemo(() => sortTree(rows), [rows]);

  function startNew() { setErr(null); setEdit({ mode: "new", data: { code: "", nameAr: "", nameEn: "", parentId: null, isPosting: true, isActive: true } }); }
  function startEdit(c: CostCenter) {
    setErr(null);
    setEdit({ mode: "edit", id: c.id, data: { code: c.code, nameAr: c.nameAr, nameEn: c.nameEn ?? "", parentId: c.parentId, isPosting: c.isPosting, isActive: c.isActive } });
  }
  function cancel() { setEdit(null); setErr(null); }
  function setField<K extends keyof EditData>(k: K, v: EditData[K]) { if (edit) setEdit({ ...edit, data: { ...edit.data, [k]: v } }); }
  async function save() {
    if (!edit) return;
    const { code, nameAr, nameEn, parentId, isPosting, isActive } = edit.data;
    if (!code.trim()) { setErr("كود المركز مطلوب"); return; }
    if (!nameAr.trim()) { setErr("اسم المركز مطلوب"); return; }
    setBusy(true); setErr(null);
    try {
      const payload = { code: code.trim(), nameAr: nameAr.trim(), nameEn: nameEn.trim() || null, parentId, isPosting, isActive };
      if (edit.mode === "new") await createCostCenter(payload);
      else await updateCostCenter(edit.id, payload);
      setEdit(null); await refresh();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }
  async function remove(c: CostCenter) {
    if (!confirm(`حذف مركز التكلفة ${c.nameAr}؟`)) return;
    try { await deleteCostCenter(c.id); await refresh(); } catch (e: any) { alert(e?.message ?? "فشل"); }
  }

  const editingId = edit?.mode === "edit" ? edit.id : null;
  const parentOpts = useMemo(
    () => [
      { value: "", label: "— بدون (مركز رئيسي) —" },
      ...sorted.filter((c) => !editingId || c.id !== editingId).map((c) => ({ value: c.id, label: `${c.code} — ${c.nameAr}` })),
    ],
    [sorted, editingId],
  );

  return (
    <Page
      title="مراكز التكلفة"
      subtitle={`${rows.length} مركز — صنّف القيود والفواتير والسندات حسب مركز التكلفة ثم صفِّ التقارير المالية حسبه.`}
      right={<button onClick={startNew} disabled={!!edit} style={{ ...btnPrimary, opacity: edit ? 0.5 : 1, cursor: edit ? "not-allowed" : "pointer" }}>+ إضافة مركز</button>}
    >
      <Card>
        {sorted.length === 0 && !edit ? <Empty text="لا توجد مراكز تكلفة" /> : (
          <Table>
            <thead><tr>
              <Th style={{ width: 120 }}>الكود</Th><Th>الاسم</Th><Th>المركز الأب</Th>
              <Th style={{ width: 120 }}>النوع</Th><Th style={{ width: 100 }}>الحالة</Th><Th style={{ width: 200 }}>إجراءات</Th>
            </tr></thead>
            <tbody>
              {edit?.mode === "new" && (
                <EditRow data={edit.data} setField={setField} onSave={save} onCancel={cancel} busy={busy} err={err} parentOpts={parentOpts} isNew />
              )}
              {sorted.map((c) => {
                if (edit?.mode === "edit" && edit.id === c.id) {
                  return <EditRow key={c.id} data={edit.data} setField={setField} onSave={save} onCancel={cancel} busy={busy} err={err} parentOpts={parentOpts} />;
                }
                const parent = c.parentId ? rows.find((x) => x.id === c.parentId) : null;
                return (
                  <tr key={c.id} style={{ opacity: edit ? 0.6 : 1 }}>
                    <Td mono>{c.code}</Td>
                    <Td style={{ fontWeight: c.isPosting ? 400 : 700 }}>{c.nameAr}</Td>
                    <Td style={{ color: "#64748b" }}>{parent ? `${parent.code} - ${parent.nameAr}` : "—"}</Td>
                    <Td>
                      <span style={{ background: (c.isPosting ? "#1e40af" : "#7c3aed") + "20", color: c.isPosting ? "#1e40af" : "#7c3aed", padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
                        {c.isPosting ? "تشغيلي" : "تجميعي"}
                      </span>
                    </Td>
                    <Td>
                      <span style={{ background: (c.isActive ? "#15803d" : "#b91c1c") + "20", color: c.isActive ? "#15803d" : "#b91c1c", padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
                        {c.isActive ? "نشط" : "موقوف"}
                      </span>
                    </Td>
                    <Td>
                      <button onClick={() => startEdit(c)} disabled={!!edit} style={btnLink}>تعديل</button>
                      {" · "}
                      <button onClick={() => remove(c)} disabled={!!edit} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
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

function EditRow({ data, setField, onSave, onCancel, busy, err, parentOpts, isNew }: {
  data: EditData; setField: <K extends keyof EditData>(k: K, v: EditData[K]) => void;
  onSave: () => void; onCancel: () => void; busy: boolean; err: string | null;
  parentOpts: { value: string | number; label: string }[]; isNew?: boolean;
}) {
  const ci: React.CSSProperties = { ...input, padding: "6px 8px", fontSize: 13 };
  return (
    <>
      <tr style={{ background: isNew ? "#f0fdf4" : "#eff6ff" }}>
        <Td><input autoFocus value={data.code} onChange={(e) => setField("code", e.target.value)} style={ci} placeholder="الكود *" /></Td>
        <Td><input value={data.nameAr} onChange={(e) => setField("nameAr", e.target.value)} style={ci} placeholder="الاسم *" /></Td>
        <Td>
          <SearchCombobox
            value={data.parentId ?? ""}
            onChange={(v) => setField("parentId", v === "" ? null : Number(v))}
            style={ci}
            options={parentOpts}
          />
        </Td>
        <Td>
          <SearchCombobox
            value={data.isPosting ? "1" : "0"}
            onChange={(v) => setField("isPosting", v === "1")}
            style={ci}
            options={[{ value: "1", label: "تشغيلي (يقبل قيود)" }, { value: "0", label: "تجميعي (تجميع فقط)" }]}
          />
        </Td>
        <Td>
          <SearchCombobox
            value={data.isActive ? "1" : "0"}
            onChange={(v) => setField("isActive", v === "1")}
            style={ci}
            options={[{ value: "1", label: "نشط" }, { value: "0", label: "موقوف" }]}
          />
        </Td>
        <Td>
          <button onClick={onSave} disabled={busy} style={{ ...btnPrimary, padding: "4px 10px", fontSize: 12 }}>{busy ? "..." : "حفظ"}</button>
          {" "}
          <button onClick={onCancel} disabled={busy} style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12 }}>إلغاء</button>
        </Td>
      </tr>
      <tr style={{ background: isNew ? "#f0fdf4" : "#eff6ff" }}>
        <Td colSpan={6}>
          <input value={data.nameEn} onChange={(e) => setField("nameEn", e.target.value)} style={ci} placeholder="الاسم بالإنجليزية (اختياري)" />
        </Td>
      </tr>
      {err && <tr><Td colSpan={6} style={{ background: "#fef2f2", color: "#991b1b", fontSize: 13 }}>⚠️ {err}</Td></tr>}
    </>
  );
}
