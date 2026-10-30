import { useEffect, useState } from "react";
import {
  listUnits, createUnit, updateUnit, deleteUnit,
  type UnitRow, type UnitInput,
} from "../lib/units";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, btnLink, fmt,
} from "./_adminUi";
import { uiText, useUiLanguage } from "../lib/appSettings";

const emptyInput: UnitInput = {
  code: "", nameAr: "", nameEn: null, conversionFactor: 1, isActive: true,
};

type EditState =
  | { mode: "new"; data: UnitInput }
  | { mode: "edit"; id: number; data: UnitInput }
  | null;

export default function UnitsAdmin() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [rows, setRows] = useState<UnitRow[]>([]);
  const [edit, setEdit] = useState<EditState>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() { setRows(await listUnits()); }
  useEffect(() => { void refresh(); }, []);

  function startNew() { setErr(null); setEdit({ mode: "new", data: { ...emptyInput } }); }
  function startEdit(u: UnitRow) {
    setErr(null);
    setEdit({ mode: "edit", id: u.id, data: {
      code: u.code, nameAr: u.nameAr, nameEn: u.nameEn,
      conversionFactor: u.conversionFactor, isActive: u.isActive,
    } });
  }
  function cancel() { setEdit(null); setErr(null); }
  function setField<K extends keyof UnitInput>(k: K, v: UnitInput[K]) {
    if (!edit) return;
    setEdit({ ...edit, data: { ...edit.data, [k]: v } });
  }

  async function save() {
    if (!edit) return;
    const f = edit.data;
    if (!f.code.trim()) { setErr(text("الكود مطلوب", "Code is required.")); return; }
    if (!f.nameAr.trim()) { setErr(text("الاسم بالعربي مطلوب", "Arabic name is required.")); return; }
    if (!(f.conversionFactor > 0)) { setErr(text("معامل التحويل يجب أن يكون أكبر من صفر", "Conversion factor must be greater than zero.")); return; }
    setBusy(true); setErr(null);
    try {
      if (edit.mode === "new") await createUnit(f);
      else await updateUnit(edit.id, f);
      setEdit(null);
      await refresh();
    } catch (e: any) { setErr(e?.message ?? text("فشل الحفظ", "Could not save unit.")); }
    finally { setBusy(false); }
  }

  async function remove(u: UnitRow) {
    if (!confirm(`${text("حذف وحدة", "Delete unit")} ${u.nameAr}?`)) return;
    try { await deleteUnit(u.id); await refresh(); }
    catch (e: any) { alert(e?.message ?? text("فشل الحذف", "Could not delete unit.")); }
  }

  return (
    <Page
      title={text("وحدات القياس", "Units of measure")}
      subtitle={`${rows.length} ${text("وحدة — معامل التحويل بالنسبة للوحدة الأساسية", "units — conversion factor relative to the base unit")}`}
      right={
        <button onClick={startNew} disabled={!!edit}
          style={{ ...btnPrimary, opacity: edit ? 0.5 : 1, cursor: edit ? "not-allowed" : "pointer" }}>
          + {text("إضافة وحدة", "Add unit")}
        </button>
      }
    >
      {edit && (
        <Card style={{ marginBottom: 12 }}>
          <div style={{ padding: 16 }}>
            <h3 style={{ marginTop: 0 }}>{edit.mode === "new" ? text("وحدة جديدة", "New unit") : text("تعديل الوحدة", "Edit unit")}</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <Field label={text("الكود *", "Code *")}>
                <input value={edit.data.code} onChange={(e) => setField("code", e.target.value)} style={input} autoFocus placeholder={text("كود الوحدة", "Unit code")} />
              </Field>
              <Field label={text("الاسم بالعربي *", "Arabic name *")}>
                <input value={edit.data.nameAr} onChange={(e) => setField("nameAr", e.target.value)} style={input} placeholder={text("مثال: كرتونة", "e.g. carton")} />
              </Field>
              <Field label={text("الاسم بالإنجليزي", "English name")}>
                <input value={edit.data.nameEn ?? ""} onChange={(e) => setField("nameEn", e.target.value || null)} style={input} placeholder="Unit name" />
              </Field>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label={text("معامل التحويل (للوحدة الأساسية)", "Conversion factor (to base unit)")}>
                <input type="number" step="0.001" min={0} value={edit.data.conversionFactor}
                  onChange={(e) => setField("conversionFactor", Number(e.target.value) || 0)} style={input} placeholder="1" />
              </Field>
              <Field label={text("الحالة", "Status")}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 0", fontSize: 14 }}>
                  <input type="checkbox" checked={edit.data.isActive} onChange={(e) => setField("isActive", e.target.checked)} style={{ width: 18, height: 18 }} />
                  {text("وحدة نشطة", "Active unit")}
                </label>
              </Field>
            </div>
            <ErrorMsg text={err} />
            <Actions>
              <button onClick={cancel} type="button" disabled={busy} style={btnSecondary}>{text("إلغاء", "Cancel")}</button>
              <button onClick={save} type="button" disabled={busy} style={btnPrimary}>{busy ? "..." : text("حفظ", "Save")}</button>
            </Actions>
          </div>
        </Card>
      )}

      <Card>
        {rows.length === 0 ? <Empty text={text("لا توجد وحدات بعد", "No units yet")} /> : (
          <Table>
            <thead><tr>
              <Th>{text("الكود", "Code")}</Th><Th>{text("الاسم", "Name")}</Th>
              <Th style={{ textAlign: language === "en" ? "right" : "left", width: 150 }}>{text("معامل التحويل", "Conversion factor")}</Th>
              <Th style={{ width: 90 }}>{text("الحالة", "Status")}</Th>
              <Th style={{ width: 150 }}>{text("إجراءات", "Actions")}</Th>
            </tr></thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} style={{ opacity: edit ? 0.5 : 1 }}>
                  <Td mono>{u.code}</Td>
                  <Td>{u.nameAr}{u.nameEn && <span style={{ color: "#94a3b8", marginInlineStart: 8 }}>{u.nameEn}</span>}</Td>
                  <Td num>{fmt(u.conversionFactor)}</Td>
                  <Td>
                    <span style={{ background: u.isActive ? "#dcfce7" : "#f1f5f9", color: u.isActive ? "#15803d" : "#64748b", padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
                      {u.isActive ? text("نشط", "Active") : text("متوقف", "Inactive")}
                    </span>
                  </Td>
                  <Td>
                    <button onClick={() => startEdit(u)} disabled={!!edit} style={btnLink}>{text("تعديل", "Edit")}</button>
                    {" · "}
                    <button onClick={() => remove(u)} disabled={!!edit} style={{ ...btnLink, color: "#dc2626" }}>{text("حذف", "Delete")}</button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}
