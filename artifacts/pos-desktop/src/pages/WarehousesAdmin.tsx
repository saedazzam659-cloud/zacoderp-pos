import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  listWarehouses, createWarehouse, updateWarehouse, deleteWarehouse,
  type Warehouse, type WarehouseInput,
} from "../lib/inventory";
import { listBranches, type Branch } from "../lib/branches";
import { listWarehouseGroups, type WarehouseGroup } from "../lib/warehouseGroups";
import { listAccounts, type Account } from "../lib/accounting";
import { useDataRefresh } from "../lib/dataBus";
import {
  Page, Card, Empty, SearchCombobox,
  input, btnPrimary, btnSecondary,
} from "./_adminUi";

const emptyInput: WarehouseInput = {
  code: "", name: "", nameEn: null, address: null,
  groupId: null, branchId: null, city: null, region: null,
  allowNegative: false, negativeLimit: null, accountId: null,
  is_default: false, is_active: true,
};

type EditState =
  | { mode: "new"; data: WarehouseInput }
  | { mode: "edit"; id: number; data: WarehouseInput }
  | null;

type TabKey = "basic" | "location" | "accounts";

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

// Auto-generate the next "WH-NNN" code from the existing rows so a new
// warehouse opens with a unique code prefilled (still editable), mirroring the
// web screen's auto-code behaviour.
function nextWarehouseCode(rows: Warehouse[]): string {
  let max = 0;
  for (const r of rows) {
    const m = /(\d+)\s*$/.exec(r.code ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `WH-${String(max + 1).padStart(3, "0")}`;
}

export default function WarehousesAdmin() {
  const [rows, setRows] = useState<Warehouse[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [groups, setGroups] = useState<WarehouseGroup[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [edit, setEdit] = useState<EditState>(null);
  const [tab, setTab] = useState<TabKey>("basic");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() { setRows(await listWarehouses()); }
  useDataRefresh(["warehouses"], refresh);
  useEffect(() => {
    void refresh();
    void (async () => {
      const [b, g, a] = await Promise.all([listBranches(), listWarehouseGroups(), listAccounts()]);
      setBranches(b); setGroups(g); setAccounts(a);
    })();
  }, []);

  // Dropdown option sets (built once per data refresh).
  const branchOptions = useMemo(
    () => [{ value: "", label: "— بدون فرع —" },
      ...branches.map((b) => ({ value: b.id, label: b.nameAr, hint: b.code }))],
    [branches],
  );
  const groupOptions = useMemo(
    () => [{ value: "", label: "— بدون مجموعة —" },
      ...groups.map((g) => ({ value: g.id, label: g.nameAr, hint: g.code }))],
    [groups],
  );
  // Inventory GL account = leaf asset accounts (web filters filterTypes=["asset"]).
  const accountOptions = useMemo(
    () => [{ value: "", label: "— بدون حساب —" },
      ...accounts
        .filter((a) => a.type === "asset" && a.isLeaf)
        .map((a) => ({ value: a.id, label: a.nameAr, hint: a.code }))],
    [accounts],
  );

  const branchName = (id: number | null) => branches.find((b) => b.id === id)?.nameAr ?? null;
  const groupName = (id: number | null) => groups.find((g) => g.id === id)?.nameAr ?? null;

  function startNew() {
    setErr(null); setTab("basic");
    setEdit({ mode: "new", data: { ...emptyInput, code: nextWarehouseCode(rows) } });
  }
  function startEdit(w: Warehouse) {
    setErr(null); setTab("basic");
    setEdit({
      mode: "edit",
      id: w.id,
      data: {
        code: w.code, name: w.name, nameEn: w.nameEn, address: w.address,
        groupId: w.groupId, branchId: w.branchId, city: w.city, region: w.region,
        allowNegative: w.allowNegative, negativeLimit: w.negativeLimit, accountId: w.accountId,
        is_default: w.is_default, is_active: w.is_active,
      },
    });
  }
  function cancel() { setEdit(null); setErr(null); }

  async function save() {
    if (!edit) return;
    const f = edit.data;
    if (!f.code.trim() || !f.name.trim()) { setErr("الكود والاسم بالعربية مطلوبان"); setTab("basic"); return; }
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
      subtitle="إدارة مخازن المنشأة — الكود، الأسماء، المجموعة، الفرع، الموقع وسياسة الرصيد السالب والحساب المحاسبي."
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
        <EditForm
          data={edit.data} setField={setField} onSave={save} onCancel={cancel}
          busy={busy} err={err} isNew tab={tab} setTab={setTab}
          branchOptions={branchOptions} groupOptions={groupOptions} accountOptions={accountOptions}
        />
      )}

      <Card>
        {rows.length === 0 && !edit ? <Empty text="لا توجد مخازن بعد — ابدأ بإضافة مخزن." /> : (
          <div style={{ display: "grid", gap: 10 }}>
            {rows.map((w) => (
              edit?.mode === "edit" && edit.id === w.id ? (
                <EditForm
                  key={w.id} data={edit.data} setField={setField} onSave={save} onCancel={cancel}
                  busy={busy} err={err} tab={tab} setTab={setTab}
                  branchOptions={branchOptions} groupOptions={groupOptions} accountOptions={accountOptions}
                />
              ) : (
                <div
                  key={w.id}
                  onDoubleClick={() => { if (!edit) startEdit(w); }}
                  title={edit ? undefined : "نقر مزدوج للتعديل"}
                  style={{
                    display: "flex", alignItems: "center", gap: 14,
                    padding: "12px 14px", borderRadius: 10,
                    border: "1px solid #e2e8f0", background: "#fff",
                    opacity: edit ? 0.55 : 1,
                    cursor: edit ? "default" : "pointer",
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
                      {w.nameEn?.trim() && (
                        <span style={{ fontSize: 12.5, color: "#94a3b8" }}>{w.nameEn}</span>
                      )}
                      {w.is_default && (
                        <span style={{ ...pill, background: "#fef3c7", color: "#92400e" }}>★ افتراضي</span>
                      )}
                      {w.allowNegative && (
                        <span style={{ ...pill, background: "#fef2f2", color: "#b91c1c" }}>رصيد سالب مسموح</span>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 5, flexWrap: "wrap" }}>
                      <span style={codeChip}>{w.code}</span>
                      {groupName(w.groupId) && (
                        <span style={{ fontSize: 13, color: "#64748b" }}>🗂 {groupName(w.groupId)}</span>
                      )}
                      {branchName(w.branchId) && (
                        <span style={{ fontSize: 13, color: "#64748b" }}>🏢 {branchName(w.branchId)}</span>
                      )}
                      <span style={{ fontSize: 13, color: "#64748b" }}>
                        {[w.city, w.region].filter(Boolean).join(" — ").trim()
                          ? `📍 ${[w.city, w.region].filter(Boolean).join(" — ")}`
                          : (w.address?.trim() ? `📍 ${w.address}` : "بدون موقع")}
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

const TABS: { key: TabKey; label: string }[] = [
  { key: "basic", label: "أساسي" },
  { key: "location", label: "الموقع والمخزون" },
  { key: "accounts", label: "المحاسبة" },
];

function EditForm({
  data, setField, onSave, onCancel, busy, err, isNew, tab, setTab,
  branchOptions, groupOptions, accountOptions,
}: {
  data: WarehouseInput;
  setField: <K extends keyof WarehouseInput>(k: K, v: WarehouseInput[K]) => void;
  onSave: () => void; onCancel: () => void;
  busy: boolean; err: string | null; isNew?: boolean;
  tab: TabKey; setTab: (t: TabKey) => void;
  branchOptions: { value: string | number; label: string; hint?: string }[];
  groupOptions: { value: string | number; label: string; hint?: string }[];
  accountOptions: { value: string | number; label: string; hint?: string }[];
}) {
  const field: CSSProperties = { ...input, padding: "9px 11px" };
  const lbl: CSSProperties = { fontSize: 12.5, fontWeight: 600, color: "#475569", marginBottom: 5, display: "block" };
  const check: CSSProperties = {
    display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, color: "#334155",
    padding: "9px 12px", border: "1px solid #cbd5e1", borderRadius: 8, background: "#fff", cursor: "pointer",
  };
  const grid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 };

  return (
    <div style={{
      marginBottom: 16, padding: 18, borderRadius: 12,
      border: `1px solid ${isNew ? "#bbf7d0" : "#bfdbfe"}`,
      background: isNew ? "#f0fdf4" : "#eff6ff",
    }}>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14, color: "#0f172a" }}>
        {isNew ? "إضافة مخزن جديد" : "تعديل المخزن"}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, borderBottom: "1px solid #e2e8f0" }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            style={{
              border: "none", background: "transparent", cursor: "pointer",
              fontFamily: "inherit", fontSize: 13.5, fontWeight: 700,
              padding: "8px 14px", marginBottom: -1,
              color: tab === t.key ? "#2563eb" : "#64748b",
              borderBottom: `2px solid ${tab === t.key ? "#2563eb" : "transparent"}`,
            }}
          >{t.label}</button>
        ))}
      </div>

      {tab === "basic" && (
        <>
          <div style={grid}>
            <div>
              <label style={lbl}>الكود *</label>
              <input autoFocus value={data.code} onChange={(e) => setField("code", e.target.value)} style={field} placeholder="مثال: WH-001" />
            </div>
            <div>
              <label style={lbl}>الاسم بالعربية *</label>
              <input value={data.name} onChange={(e) => setField("name", e.target.value)} style={field} placeholder="اسم المخزن" />
            </div>
            <div>
              <label style={lbl}>الاسم بالإنجليزية</label>
              <input value={data.nameEn ?? ""} onChange={(e) => setField("nameEn", e.target.value || null)} style={field} placeholder="Warehouse name" dir="ltr" />
            </div>
            <div>
              <label style={lbl}>المجموعة</label>
              <SearchCombobox
                value={data.groupId ?? ""}
                onChange={(v) => setField("groupId", v === "" ? null : Number(v))}
                options={groupOptions}
                placeholder="— بدون مجموعة —"
              />
            </div>
            <div>
              <label style={lbl}>الفرع</label>
              <SearchCombobox
                value={data.branchId ?? ""}
                onChange={(v) => setField("branchId", v === "" ? null : Number(v))}
                options={branchOptions}
                placeholder="— بدون فرع —"
              />
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
        </>
      )}

      {tab === "location" && (
        <>
          <div style={grid}>
            <div>
              <label style={lbl}>المدينة</label>
              <input value={data.city ?? ""} onChange={(e) => setField("city", e.target.value || null)} style={field} placeholder="المدينة" />
            </div>
            <div>
              <label style={lbl}>المنطقة</label>
              <input value={data.region ?? ""} onChange={(e) => setField("region", e.target.value || null)} style={field} placeholder="المنطقة" />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={lbl}>العنوان</label>
              <input value={data.address ?? ""} onChange={(e) => setField("address", e.target.value || null)} style={field} placeholder="عنوان المخزن (اختياري)" />
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <label style={{ ...check, display: "inline-flex" }}>
              <input type="checkbox" checked={!!data.allowNegative} onChange={(e) => setField("allowNegative", e.target.checked)} style={{ width: 16, height: 16 }} />
              السماح بالرصيد السالب
            </label>
          </div>
          {data.allowNegative && (
            <div style={{ ...grid, marginTop: 14 }}>
              <div>
                <label style={lbl}>حد الرصيد السالب (اختياري)</label>
                <input
                  type="number" step="0.01"
                  value={data.negativeLimit ?? ""}
                  onChange={(e) => setField("negativeLimit", e.target.value === "" ? null : Number(e.target.value))}
                  style={field}
                  placeholder="بدون حد"
                />
              </div>
            </div>
          )}
        </>
      )}

      {tab === "accounts" && (
        <div style={grid}>
          <div>
            <label style={lbl}>حساب المخزون (أصول)</label>
            <SearchCombobox
              value={data.accountId ?? ""}
              onChange={(v) => setField("accountId", v === "" ? null : Number(v))}
              options={accountOptions}
              placeholder="— بدون حساب —"
            />
          </div>
        </div>
      )}

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
