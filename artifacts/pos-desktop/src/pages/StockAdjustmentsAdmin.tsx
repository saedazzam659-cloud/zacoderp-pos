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
import { uiText, useUiLanguage } from "../lib/appSettings";

export default function StockAdjustmentsAdmin() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [rows, setRows] = useState<AdjustmentSummary[]>([]);
  const [showForm, setShowForm] = useState(false);

  async function refresh() { setRows(await listStockAdjustments()); }
  useEffect(() => { void refresh(); }, []);
  useDataRefresh(["stock", "journal"], () => { void refresh(); });

  return (
    <Page
      title={text("تسوية المخزون", "Stock adjustments")}
      subtitle={`${rows.length} ${text("تسوية", "adjustments")}`}
      right={
        <button onClick={() => setShowForm(true)} disabled={showForm}
          style={{ ...btnPrimary, opacity: showForm ? 0.5 : 1, cursor: showForm ? "not-allowed" : "pointer" }}>
          + {text("تسوية جديدة", "New adjustment")}
        </button>
      }
    >
      {showForm && (
        <Card style={{ marginBottom: 12 }}>
          <div style={{ padding: 16 }}>
            <AdjustmentForm onCancel={() => setShowForm(false)} onDone={() => { setShowForm(false); void refresh(); }} />
          </div>
        </Card>
      )}
      <Card>
        {rows.length === 0 && !showForm ? <Empty text={text("لا توجد تسويات بعد", "No adjustments yet")} /> : (
          <Table>
            <thead><tr>
              <Th>{text("الرقم", "Number")}</Th><Th>{text("التاريخ", "Date")}</Th><Th>{text("المخزن", "Warehouse")}</Th>
              <Th>{text("السبب", "Reason")}</Th><Th>{text("عدد البنود", "Lines")}</Th>
              <Th>{text("قيمة التسوية", "Adjustment value")}</Th><Th>{text("القيد", "Journal entry")}</Th>
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
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
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
    if (warehouseId === "") { setErr(text("اختر المخزن", "Select a warehouse.")); return; }
    const valid = lines.filter((l) => l.item_id > 0 && l.qty_diff !== 0);
    if (valid.length === 0) { setErr(text("أضف بنداً واحداً على الأقل بكمية ≠ 0", "Add at least one line with a non-zero quantity difference.")); return; }
    setBusy(true); setErr(null);
    try {
      await createStockAdjustment({
        adj_date: adjDate,
        warehouse_id: warehouseId,
        reason: reason || null,
        lines: valid.map(({ item_id, qty_diff, unit_cost }) => ({ item_id, qty_diff, unit_cost })),
      });
      onDone();
    } catch (e: any) { setErr(e?.message ?? text("فشل الحفظ", "Could not save adjustment.")); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>{text("تسوية مخزون جديدة", "New stock adjustment")}</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr", gap: 10 }}>
        <Field label={text("التاريخ", "Date")}><input type="date" value={adjDate} onChange={(e) => setAdjDate(e.target.value)} style={input} /></Field>
        <Field label={text("المخزن", "Warehouse")}>
          <SearchCombobox
            value={warehouseId}
            onChange={(v) => setWarehouseId(v === "" ? "" : Number(v))}
            style={input}
            options={[
              { value: "", label: text("— اختر —", "— Select —") },
              ...warehouses.map((w) => ({ value: w.id, label: w.name })),
            ]}
          />
        </Field>
        <Field label={text("السبب", "Reason")}><input value={reason} onChange={(e) => setReason(e.target.value)} style={input} placeholder={text("مثال: تالف / فقد / فروقات جرد", "e.g. damaged / lost / stocktake variance")} /></Field>
      </div>

      <div style={{ marginTop: 12, marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>{text("البنود", "Lines")}</strong>
        <button onClick={addLine} style={btnSecondary} type="button">+ {text("إضافة بند", "Add line")}</button>
      </div>

      <Table>
        <thead><tr>
          <Th>{text("الصنف", "Item")}</Th><Th style={{ width: 140 }}>{text("الفرق (+/-)", "Difference (+/-)")}</Th>
          <Th style={{ width: 140 }}>{text("تكلفة الوحدة", "Unit cost")}</Th><Th style={{ width: 140 }}>{text("القيمة", "Value")}</Th>
          <Th style={{ width: 80 }}></Th>
        </tr></thead>
        <tbody>
          {lines.length === 0 ? (
            <tr><Td colSpan={5}><div style={{ padding: 16, textAlign: "center", color: "#94a3b8" }}>{text("لا توجد بنود — اضغط \"إضافة بند\"", "No lines — select “Add line”")}</div></Td></tr>
          ) : lines.map((l) => (
            <tr key={l._key}>
              <Td>
                <SearchCombobox
                  value={l.item_id}
                  onChange={(v) => updateLine(l._key, { item_id: Number(v) })}
                  style={input}
                  options={[
                    { value: 0, label: text("— اختر صنف —", "— Select an item —") },
                    ...items.map((i) => ({ value: i.id, label: i.nameAr })),
                  ]}
                />
              </Td>
              <Td><input type="number" step="0.001" value={l.qty_diff} onChange={(e) => updateLine(l._key, { qty_diff: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td><input type="number" step="0.01" value={l.unit_cost} onChange={(e) => updateLine(l._key, { unit_cost: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td num>{fmt(Math.abs(l.qty_diff) * l.unit_cost)}</Td>
              <Td><button onClick={() => removeLine(l._key)} style={btnLink} type="button">{text("حذف", "Remove")}</button></Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <div style={{ marginTop: 8, padding: 8, background: "#f8fafc", borderRadius: 6, fontSize: 12, color: "#64748b" }}>
        ℹ️ {text("الفرق الموجب يضيف للمخزون (DR مخزون / CR فروقات ربح 1310). الفرق السالب ينقص (DR فروقات خسارة 5300 / CR مخزون).", "A positive difference adds stock (DR inventory / CR gain variance 1310). A negative difference reduces stock (DR loss variance 5300 / CR inventory).")}
      </div>

      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} style={btnSecondary} type="button">{text("إلغاء", "Cancel")}</button>
        <button onClick={save} disabled={busy} style={btnPrimary} type="button">{busy ? "..." : text("حفظ وترحيل", "Save and post")}</button>
      </Actions>
    </div>
  );
}
