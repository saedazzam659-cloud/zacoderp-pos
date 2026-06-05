import { useEffect, useState } from "react";
import { listSalespersons, createSalesperson, updateSalesperson, deleteSalesperson, type Salesperson } from "../lib/salespersons";
import { Page, Card, Table, Th, Td, Empty, input, btnPrimary, btnSecondary, btnLink, SearchCombobox } from "./_adminUi";

type EditData = {
  code: string; nameAr: string; nameEn: string; phone: string;
  email: string; commissionPct: string; isActive: boolean; notes: string;
};
type EditState =
  | { mode: "new"; data: EditData }
  | { mode: "edit"; id: number; data: EditData }
  | null;

const blank: EditData = { code: "", nameAr: "", nameEn: "", phone: "", email: "", commissionPct: "", isActive: true, notes: "" };

export default function SalespersonsAdmin() {
  const [rows, setRows] = useState<Salesperson[]>([]);
  const [edit, setEdit] = useState<EditState>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() { setRows(await listSalespersons(true)); }
  useEffect(() => { void refresh(); }, []);

  function startNew() { setErr(null); setEdit({ mode: "new", data: { ...blank } }); }
  function startEdit(s: Salesperson) {
    setErr(null);
    setEdit({ mode: "edit", id: s.id, data: {
      code: s.code ?? "", nameAr: s.nameAr, nameEn: s.nameEn ?? "", phone: s.phone ?? "",
      email: s.email ?? "", commissionPct: s.commissionPct ? String(s.commissionPct) : "",
      isActive: s.isActive, notes: s.notes ?? "",
    } });
  }
  function cancel() { setEdit(null); setErr(null); }
  function setField<K extends keyof EditData>(k: K, v: EditData[K]) { if (edit) setEdit({ ...edit, data: { ...edit.data, [k]: v } }); }
  async function save() {
    if (!edit) return;
    const d = edit.data;
    if (!d.nameAr.trim()) { setErr("اسم المندوب مطلوب"); return; }
    const pct = d.commissionPct.trim() === "" ? 0 : Number(d.commissionPct);
    if (Number.isNaN(pct) || pct < 0 || pct > 100) { setErr("نسبة العمولة يجب أن تكون بين 0 و 100"); return; }
    setBusy(true); setErr(null);
    try {
      const payload = {
        code: d.code.trim() || null,
        nameAr: d.nameAr.trim(),
        nameEn: d.nameEn.trim() || null,
        phone: d.phone.trim() || null,
        email: d.email.trim() || null,
        commissionPct: pct,
        isActive: d.isActive,
        notes: d.notes.trim() || null,
      };
      if (edit.mode === "new") await createSalesperson(payload);
      else await updateSalesperson(edit.id, payload);
      setEdit(null); await refresh();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }
  async function remove(s: Salesperson) {
    if (!confirm(`حذف المندوب ${s.nameAr}؟`)) return;
    try { await deleteSalesperson(s.id); await refresh(); } catch (e: any) { alert(e?.message ?? "فشل"); }
  }

  return (
    <Page
      title="مندوبو المبيعات"
      subtitle={`${rows.length} مندوب — يُربط المندوب بفواتير المبيعات المكتبية مع نسبة عمولة اختيارية.`}
      right={<button onClick={startNew} disabled={!!edit} style={{ ...btnPrimary, opacity: edit ? 0.5 : 1, cursor: edit ? "not-allowed" : "pointer" }}>+ إضافة مندوب</button>}
    >
      <Card>
        {rows.length === 0 && !edit ? <Empty text="لا يوجد مندوبون" /> : (
          <Table>
            <thead><tr>
              <Th style={{ width: 110 }}>الكود</Th><Th>الاسم</Th><Th>الجوال</Th>
              <Th>البريد</Th><Th style={{ width: 110 }}>العمولة %</Th>
              <Th style={{ width: 100 }}>الحالة</Th><Th style={{ width: 180 }}>إجراءات</Th>
            </tr></thead>
            <tbody>
              {edit?.mode === "new" && (
                <EditRow data={edit.data} setField={setField} onSave={save} onCancel={cancel} busy={busy} err={err} isNew />
              )}
              {rows.map((s) => (
                edit?.mode === "edit" && edit.id === s.id ? (
                  <EditRow key={s.id} data={edit.data} setField={setField} onSave={save} onCancel={cancel} busy={busy} err={err} />
                ) : (
                  <tr key={s.id} style={{ opacity: edit ? 0.6 : 1 }}>
                    <Td mono>{s.code || "—"}</Td>
                    <Td style={{ fontWeight: 600 }}>{s.nameAr}{s.nameEn ? <span style={{ color: "#94a3b8", fontWeight: 400 }}> · {s.nameEn}</span> : null}</Td>
                    <Td style={{ color: "#64748b" }}>{s.phone || "—"}</Td>
                    <Td style={{ color: "#64748b" }}>{s.email || "—"}</Td>
                    <Td mono>{s.commissionPct ? `${s.commissionPct}%` : "—"}</Td>
                    <Td>
                      <span style={{ background: (s.isActive ? "#15803d" : "#b91c1c") + "20", color: s.isActive ? "#15803d" : "#b91c1c", padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
                        {s.isActive ? "نشط" : "غير نشط"}
                      </span>
                    </Td>
                    <Td>
                      <button onClick={() => startEdit(s)} disabled={!!edit} style={btnLink}>تعديل</button>
                      {" · "}
                      <button onClick={() => remove(s)} disabled={!!edit} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
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
        <Td><input autoFocus value={data.code} onChange={(e) => setField("code", e.target.value)} style={ci} placeholder="الكود" /></Td>
        <Td><input value={data.nameAr} onChange={(e) => setField("nameAr", e.target.value)} style={ci} placeholder="الاسم *" /></Td>
        <Td><input value={data.phone} onChange={(e) => setField("phone", e.target.value)} style={ci} placeholder="الجوال" /></Td>
        <Td><input value={data.email} onChange={(e) => setField("email", e.target.value)} style={ci} placeholder="البريد" /></Td>
        <Td><input value={data.commissionPct} onChange={(e) => setField("commissionPct", e.target.value)} style={{ ...ci, textAlign: "center" }} placeholder="0" inputMode="decimal" /></Td>
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
      <tr style={{ background: isNew ? "#f0fdf4" : "#eff6ff" }}>
        <Td colSpan={7}>
          <input value={data.nameEn} onChange={(e) => setField("nameEn", e.target.value)} style={{ ...ci, width: "32%", marginInlineEnd: 8 }} placeholder="الاسم بالإنجليزية (اختياري)" />
          <input value={data.notes} onChange={(e) => setField("notes", e.target.value)} style={{ ...ci, width: "60%" }} placeholder="ملاحظات (اختياري)" />
        </Td>
      </tr>
      {err && <tr><Td colSpan={7} style={{ background: "#fef2f2", color: "#991b1b", fontSize: 13 }}>⚠️ {err}</Td></tr>}
    </>
  );
}
