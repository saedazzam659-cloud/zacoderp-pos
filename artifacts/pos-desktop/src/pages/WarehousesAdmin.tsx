import { useEffect, useState, type CSSProperties } from "react";
import {
  listWarehouses, createWarehouse, updateWarehouse, deleteWarehouse,
  type Warehouse, type WarehouseInput,
} from "../lib/inventory";
import {
  Page, Card, Empty,
  input, btnPrimary, btnSecondary,
} from "./_adminUi";

const emptyInput: WarehouseInput = { code: "", name: "", address: null, is_default: false, is_active: true };

type EditState =
  | { mode: "new"; data: WarehouseInput }
  | { mode: "edit"; id: number; data: WarehouseInput }
  | null;

// ─── Local presentational helpers (UI-only restyle) ──────────────────
const pill: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4,
  padding: "2px 9px", borderRadius: 999, fontSize: 12, fontWeight: 600, lineHeight: 1.7,
};
const codeChip: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5,
  background: "#f1f5f9", color: "#334155", padding: "3px 8px", borderRadius: 6, fontWeight: 600,
};
const iconBtn: CSSProperties = {
  border: "1px solid transparent", borderRadius: 7, cursor: "pointer",
  fontFamily: "inherit", fontSize: 13, fontWeight: 600, padding: "5px 12px", background: "transparent",
};

export default function WarehousesAdmin() {
  const [rows, setRows] = useState<Warehouse[]>([]);
  const [edit, setEdit] = useState<EditState>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() { setRows(await listWarehouses()); }
  useEffect(() => { void refresh(); }, []);

  function startNew() {
    setErr(null);
    setEdit({ mode: "new", data: { ...emptyInput } });
  }
  function startEdit(w: Warehouse) {
    setErr(null);
    setEdit({
      mode: "edit",
      id: w.id,
      data: { code: w.code, name: w.name, address: w.address, is_default: w.is_default, is_active: w.is_active },
    });
  }
  function cancel() { setEdit(null); setErr(null); }

  async function save() {
    if (!edit) return;
    const f = edit.data;
    if (!f.code.trim() || !f.name.trim()) { setErr("الكود والاسم مطلوبان"); return; }
    setBusy(true); setErr(null);
    try {
      if (edit.mode === "new") await createWarehouse(f);
      else await updateWarehouse(edit.id, f);
      setEdit(null);
      await refresh();
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setBusy(false); }
  }

  async function remove(w: Warehouse) {
    if (!confirm(`حذف المخزن "${w.name}"؟`)) return;
    try { await deleteWarehouse(w.id); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل الحذف"); }
  }

  function setField<K extends keyof WarehouseInput>(k: K, v: WarehouseInput[K]) {
    if (!edit) return;
    setEdit({ ...edit, data: { ...edit.data, [k]: v } });
  }

  const activeCount = rows.filter((w) => w.is_active).length;

  return (
    <Page
      title="المخازن"
      subtitle="إدارة مخازن المنشأة — الكود، الاسم، الحالة والمخزن الافتراضي."
      right={
        <button
          onClick={startNew}
          disabled={!!edit}
          style={{ ...btnPrimary, opacity: edit ? 0.5 : 1, cursor: edit ? "not-allowed" : "pointer" }}
        >+ إضافة مخزن</button>
      }
    >
      {/* Summary strip */}
      <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <StatCard label="إجمالي المخازن" value={rows.length} accent="#2563eb" />
        <StatCard label="نشط" value={activeCount} accent="#16a34a" />
        <StatCard label="موقوف" value={rows.length - activeCount} accent="#94a3b8" />
      </div>

      {edit?.mode === "new" && (
        <EditForm data={edit.data} setField={setField} onSave={save} onCancel={cancel} busy={busy} err={err} isNew />
      )}

      <Card>
        {rows.length === 0 && !edit ? <Empty text="لا توجد مخازن بعد — ابدأ بإضافة مخزن." /> : (
          <div style={{ display: "grid", gap: 10 }}>
            {rows.map((w) => (
              edit?.mode === "edit" && edit.id === w.id ? (
                <EditForm key={w.id} data={edit.data} setField={setField} onSave={save} onCancel={cancel} busy={busy} err={err} />
              ) : (
                <div
                  key={w.id}
                  style={{
                    display: "flex", alignItems: "center", gap: 14,
                    padding: "12px 14px", borderRadius: 10,
                    border: "1px solid #e2e8f0", background: "#fff",
                    opacity: edit ? 0.55 : 1,
                    transition: "border-color .15s, box-shadow .15s",
                  }}
                >
                  {/* Avatar */}
                  <div style={{
                    width: 40, height: 40, borderRadius: 10, flexShrink: 0,
                    display: "grid", placeItems: "center", fontSize: 19,
                    background: w.is_active ? "#eff6ff" : "#f1f5f9",
                  }}>🏬</div>

                  {/* Main */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 700, fontSize: 14.5, color: "#0f172a" }}>{w.name}</span>
                      {w.is_default && (
                        <span style={{ ...pill, background: "#fef3c7", color: "#92400e" }}>★ افتراضي</span>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 5, flexWrap: "wrap" }}>
                      <span style={codeChip}>{w.code}</span>
                      <span style={{ fontSize: 13, color: "#64748b" }}>
                        {w.address?.trim() ? `📍 ${w.address}` : "بدون عنوان"}
                      </span>
                    </div>
                  </div>

                  {/* Status */}
                  <span style={{
                    ...pill,
                    background: w.is_active ? "#dcfce7" : "#f1f5f9",
                    color: w.is_active ? "#166534" : "#64748b",
                  }}>
                    <span style={{
                      width: 7, height: 7, borderRadius: 999,
                      background: w.is_active ? "#22c55e" : "#cbd5e1",
                    }} />
                    {w.is_active ? "نشط" : "موقوف"}
                  </span>

                  {/* Actions */}
                  <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                    <button
                      onClick={() => startEdit(w)} disabled={!!edit}
                      style={{ ...iconBtn, color: "#2563eb" }}
                    >تعديل</button>
                    {!w.is_default && (
                      <button
                        onClick={() => remove(w)} disabled={!!edit}
                        style={{ ...iconBtn, color: "#dc2626" }}
                      >حذف</button>
                    )}
                  </div>
                </div>
              )
            ))}
          </div>
        )}
      </Card>
    </Page>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div style={{
      flex: "1 1 140px", minWidth: 120,
      padding: "14px 16px", borderRadius: 10,
      border: "1px solid #e2e8f0", background: "#fff",
      borderInlineStart: `4px solid ${accent}`,
    }}>
      <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: "#0f172a", lineHeight: 1 }}>{value}</div>
    </div>
  );
}

function EditForm({ data, setField, onSave, onCancel, busy, err, isNew }: {
  data: WarehouseInput;
  setField: <K extends keyof WarehouseInput>(k: K, v: WarehouseInput[K]) => void;
  onSave: () => void; onCancel: () => void;
  busy: boolean; err: string | null; isNew?: boolean;
}) {
  const field: CSSProperties = { ...input, padding: "9px 11px" };
  const lbl: CSSProperties = { fontSize: 12.5, fontWeight: 600, color: "#475569", marginBottom: 5, display: "block" };
  const check: CSSProperties = {
    display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, color: "#334155",
    padding: "9px 12px", border: "1px solid #cbd5e1", borderRadius: 8, background: "#fff", cursor: "pointer",
  };
  return (
    <div style={{
      marginBottom: 16, padding: 18, borderRadius: 12,
      border: `1px solid ${isNew ? "#bbf7d0" : "#bfdbfe"}`,
      background: isNew ? "#f0fdf4" : "#eff6ff",
    }}>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14, color: "#0f172a" }}>
        {isNew ? "إضافة مخزن جديد" : "تعديل المخزن"}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
        <div>
          <label style={lbl}>الكود *</label>
          <input autoFocus value={data.code} onChange={(e) => setField("code", e.target.value)} style={field} placeholder="مثال: WH-01" />
        </div>
        <div>
          <label style={lbl}>الاسم *</label>
          <input value={data.name} onChange={(e) => setField("name", e.target.value)} style={field} placeholder="اسم المخزن" />
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <label style={lbl}>العنوان</label>
          <input value={data.address ?? ""} onChange={(e) => setField("address", e.target.value || null)} style={field} placeholder="عنوان المخزن (اختياري)" />
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
        <label style={check}>
          <input type="checkbox" checked={!!data.is_default} onChange={(e) => setField("is_default", e.target.checked)} style={{ width: 16, height: 16 }} />
          مخزن افتراضي
        </label>
        <label style={check}>
          <input type="checkbox" checked={data.is_active !== false} onChange={(e) => setField("is_active", e.target.checked)} style={{ width: 16, height: 16 }} />
          نشط
        </label>
      </div>
      {err && (
        <div style={{ marginTop: 12, padding: "9px 12px", background: "#fef2f2", color: "#991b1b", fontSize: 13, borderRadius: 8, border: "1px solid #fecaca" }}>
          ⚠️ {err}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button onClick={onSave} disabled={busy} style={btnPrimary}>{busy ? "جارٍ الحفظ..." : "حفظ"}</button>
        <button onClick={onCancel} disabled={busy} style={btnSecondary}>إلغاء</button>
      </div>
    </div>
  );
}
