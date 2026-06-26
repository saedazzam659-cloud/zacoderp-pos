import { useEffect, useState } from "react";
import { useDataRefresh } from "../lib/dataBus";
import {
  listStockAdjustments, createStockAdjustment, listWarehouses,
  type AdjustmentSummary, type AdjustmentLineInput, type Warehouse,
} from "../lib/inventory";
import { listItems } from "../lib/items";
import type { LocalItem } from "../lib/items";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, btnLink, fmt, todayStr, SearchCombobox,
} from "./_adminUi";

export default function StockAdjustmentsAdmin() {
  const [rows, setRows] = useState<AdjustmentSummary[]>([]);
  const [showForm, setShowForm] = useState(false);

  async function refresh() { setRows(await listStockAdjustments()); }
  useEffect(() => { void refresh(); }, []);
  useDataRefresh(["stock", "journal"], () => { void refresh(); });

  return (
    <Page
      title="تسوية المخزون"
      subtitle={`${rows.length} تسوية`}
      right={
        <button onClick={() => setShowForm(true)} disabled={showForm}
          style={{ ...btnPrimary, opacity: showForm ? 0.5 : 1, cursor: showForm ? "not-allowed" : "pointer" }}>
          + تسوية جديدة
        </button>
      }
    >
      {showForm && (
        <Card style={{ marginBottom: 12, border: "2px solid #2563eb" }}>
          <div style={{ padding: 16 }}>
            <AdjustmentForm onCancel={() => setShowForm(false)} onDone={() => { setShowForm(false); void refresh(); }} />
          </div>
        </Card>
      )}
      <Card>
        {rows.length === 0 && !showForm ? <Empty text="لا توجد تسويات بعد" /> : (
          <Table>
            <thead><tr>
              <Th>الرقم</Th><Th>التاريخ</Th><Th>المخزن</Th>
              <Th>السبب</Th><Th>عدد البنود</Th>
              <Th>قيمة التسوية</Th><Th>القيد</Th>
            </tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <Td mono>{a.adj_no}</Td>
                  <Td mono>{a.adj_date}</Td>
                  <Td>{a.warehouse_name}</Td>
                  <Td>{a.reason ?? "—"}</Td>
                  <Td num>{a.lines_count}</Td>
                  <Td num style={{ fontWeight: 600 }}>{fmt(a.total_value)}</Td>
                  <Td mono>{a.je_id ? `JE-${a.je_id}` : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}

type LineRow = AdjustmentLineInput & { _key: number };

function AdjustmentForm({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [items, setItems] = useState<LocalItem[]>([]);
  const [adjDate, setAdjDate] = useState<string>(todayStr());
  const [warehouseId, setWarehouseId] = useState<number | "">("");
  const [reason, setReason] = useState<string>("");
  const [lines, setLines] = useState<LineRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const ws = await listWarehouses();
      setWarehouses(ws);
      const def = ws.find((w) => w.is_default) ?? ws[0];
      if (def) setWarehouseId(def.id);
      setItems(await listItems());
    })();
  }, []);

  function addLine() {
    setLines((p) => [...p, { _key: Date.now() + Math.random(), item_id: 0, qty_diff: 0, unit_cost: 0 }]);
  }
  function updateLine(k: number, patch: Partial<LineRow>) {
    setLines((p) => p.map((l) => l._key === k ? { ...l, ...patch } : l));
  }
  function removeLine(k: number) {
    setLines((p) => p.filter((l) => l._key !== k));
  }

  async function save() {
    if (warehouseId === "") { setErr("اختر المخزن"); return; }
    const valid = lines.filter((l) => l.item_id > 0 && l.qty_diff !== 0);
    if (valid.length === 0) { setErr("أضف بنداً واحداً على الأقل بكمية ≠ 0"); return; }
    setBusy(true); setErr(null);
    try {
      await createStockAdjustment({
        adj_date: adjDate,
        warehouse_id: warehouseId,
        reason: reason || null,
        lines: valid.map(({ item_id, qty_diff, unit_cost }) => ({ item_id, qty_diff, unit_cost })),
      });
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>تسوية مخزون جديدة</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr", gap: 10 }}>
        <Field label="التاريخ"><input type="date" value={adjDate} onChange={(e) => setAdjDate(e.target.value)} style={input} /></Field>
        <Field label="المخزن">
          <SearchCombobox
            value={warehouseId}
            onChange={(v) => setWarehouseId(v === "" ? "" : Number(v))}
            style={input}
            options={[
              { value: "", label: "— اختر —" },
              ...warehouses.map((w) => ({ value: w.id, label: w.name })),
            ]}
          />
        </Field>
        <Field label="السبب"><input value={reason} onChange={(e) => setReason(e.target.value)} style={input} placeholder="مثال: تالف / فقد / فروقات جرد" /></Field>
      </div>

      <div style={{ marginTop: 12, marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>البنود</strong>
        <button onClick={addLine} style={btnSecondary} type="button">+ إضافة بند</button>
      </div>

      <Table>
        <thead><tr>
          <Th>الصنف</Th><Th style={{ width: 140 }}>الفرق (+/-)</Th>
          <Th style={{ width: 140 }}>تكلفة الوحدة</Th><Th style={{ width: 140 }}>القيمة</Th>
          <Th style={{ width: 80 }}></Th>
        </tr></thead>
        <tbody>
          {lines.length === 0 ? (
            <tr><Td colSpan={5}><div style={{ padding: 16, textAlign: "center", color: "#94a3b8" }}>لا توجد بنود — اضغط "إضافة بند"</div></Td></tr>
          ) : lines.map((l) => (
            <tr key={l._key}>
              <Td>
                <SearchCombobox
                  value={l.item_id}
                  onChange={(v) => updateLine(l._key, { item_id: Number(v) })}
                  style={input}
                  options={[
                    { value: 0, label: "— اختر صنف —" },
                    ...items.map((i) => ({ value: i.id, label: i.nameAr })),
                  ]}
                />
              </Td>
              <Td><input type="number" step="0.001" value={l.qty_diff} onChange={(e) => updateLine(l._key, { qty_diff: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td><input type="number" step="0.01" value={l.unit_cost} onChange={(e) => updateLine(l._key, { unit_cost: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td num>{fmt(Math.abs(l.qty_diff) * l.unit_cost)}</Td>
              <Td><button onClick={() => removeLine(l._key)} style={btnLink} type="button">حذف</button></Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <div style={{ marginTop: 8, padding: 8, background: "#f8fafc", borderRadius: 6, fontSize: 12, color: "#64748b" }}>
        ℹ️ الفرق الموجب يضيف للمخزون (DR مخزون / CR فروقات ربح 1310). الفرق السالب ينقص (DR فروقات خسارة 5300 / CR مخزون).
      </div>

      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} style={btnSecondary} type="button">إلغاء</button>
        <button onClick={save} disabled={busy} style={btnPrimary} type="button">{busy ? "..." : "حفظ وترحيل"}</button>
      </Actions>
    </div>
  );
}
